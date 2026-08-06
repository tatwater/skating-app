import { MAX_OPEN_BOUNTIES_PER_DAY } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { AUTO_FLAG_COOLDOWN_MS, fileOrBumpAutoFlag, shouldAlertAt } from './lib/autoFlag';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** Schema-typed harness — an unparameterized `convexTest` return loses the table index types. */
function harness() {
  return convexTest(schema, modules);
}

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
}

/** Call the helper inside a mutation context, the way its real callers do. */
function file(
  t: ReturnType<typeof convexTest>,
  args: {
    targetId: string;
    flaggerId: Id<'profiles'>;
    now?: number;
  },
) {
  return t.run((ctx) =>
    fileOrBumpAutoFlag(ctx, {
      targetType: 'user',
      targetId: args.targetId,
      reason: 'unsafe_false_report',
      flaggerId: args.flaggerId,
      ...(args.now !== undefined ? { now: args.now } : {}),
    }),
  );
}

function flagsFor(t: ReturnType<typeof harness>, targetId: string) {
  return t.run((ctx) =>
    ctx.db
      .query('contentFlags')
      .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', targetId))
      .collect(),
  );
}

describe('fileOrBumpAutoFlag', () => {
  test('the first occurrence files one row at count 1', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');

    const result = await file(t, { targetId: target, flaggerId: flagger });
    expect(result.filed).toBe(true);
    expect(result.occurrences).toBe(1);
    expect(await flagsFor(t, target)).toHaveLength(1);
  });

  test('a recurrence bumps the open row instead of filing another', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');

    await file(t, { targetId: target, flaggerId: flagger });
    const second = await file(t, { targetId: target, flaggerId: flagger });
    const third = await file(t, { targetId: target, flaggerId: flagger });

    expect(second.filed).toBe(false);
    expect(third.occurrences).toBe(3);
    // The whole point: a contributor parked above the threshold produces ONE queue row, not one per
    // settle. That stream of identical rows was hiding the number a moderator actually needs.
    const rows = await flagsFor(t, target);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
    expect(rows[0]?.lastOccurrenceAt).toBeDefined();
  });

  test('a flag under review is still the open row — reviewing is not resolved', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');
    const first = await file(t, { targetId: target, flaggerId: flagger });
    await t.run((ctx) => ctx.db.patch(first.flagId, { status: 'reviewing' }));

    const again = await file(t, { targetId: target, flaggerId: flagger });
    expect(again.filed).toBe(false);
    expect(await flagsFor(t, target)).toHaveLength(1);
  });

  /**
   * The invariant this mechanism exists to protect. `by_status_resolved_at` serves a day-sliced
   * resolution chart on the stated premise that terminal rows accumulate forever — flipping one back
   * to `open` would retroactively change a past day's count.
   */
  test('a recurrence after a resolution files a NEW row and never touches the terminal one', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');
    const moderator = await seedUser(t, 'mod');

    const first = await file(t, { targetId: target, flaggerId: flagger, now: 1_000_000 });
    await file(t, { targetId: target, flaggerId: flagger, now: 1_000_001 });
    const resolvedAt = 2_000_000;
    await t.run((ctx) =>
      ctx.db.patch(first.flagId, {
        status: 'dismissed',
        resolvedAt,
        resolvedByUserId: moderator,
      }),
    );

    const recurrence = await file(t, {
      targetId: target,
      flaggerId: flagger,
      now: resolvedAt + 1000,
    });

    expect(recurrence.filed).toBe(true);
    expect(recurrence.flagId).not.toBe(first.flagId);
    // The count follows the problem across the resolution — "3rd occurrence, last dismissed" is the
    // moderator's actual input to the D57 lever.
    expect(recurrence.occurrences).toBe(3);
    expect(recurrence.supersededFlagId).toBe(first.flagId);

    const rows = await flagsFor(t, target);
    const terminal = rows.find((r) => r._id === first.flagId) as Doc<'contentFlags'>;
    expect(terminal.status).toBe('dismissed');
    expect(terminal.resolvedAt).toBe(resolvedAt);
    // Untouched, exactly: the 7b rollup's past days keep meaning what they said.
    expect(terminal.occurrences).toBe(2);
  });

  test('past the cooldown the count restarts — a corrected course is not carried forward', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');
    const moderator = await seedUser(t, 'mod');

    const first = await file(t, { targetId: target, flaggerId: flagger, now: 1_000_000 });
    await t.run((ctx) =>
      ctx.db.patch(first.flagId, {
        status: 'actioned',
        resolvedAt: 1_000_000,
        resolvedByUserId: moderator,
      }),
    );

    const later = await file(t, {
      targetId: target,
      flaggerId: flagger,
      now: 1_000_000 + AUTO_FLAG_COOLDOWN_MS + 1,
    });
    expect(later.filed).toBe(true);
    expect(later.occurrences).toBe(1);
    expect(later.supersededFlagId).toBeUndefined();
  });

  test('finds the open row on a much-flagged target, not the oldest hundred', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');

    // The open row is filed FIRST, then buried under more resolved rows than the scan cap. `by_target`
    // runs ascending, so a scan that didn't ask for `desc` would keep the oldest hundred, never see
    // the row it is supposed to bump, and file a duplicate open flag at `occurrences: 1` — resetting
    // the count on exactly the chronic target bundling exists for.
    await file(t, { targetId: target, flaggerId: flagger });
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert('contentFlags', {
          flaggerId: flagger,
          targetType: 'user' as const,
          targetId: target,
          reason: 'unsafe_false_report' as const,
          status: 'dismissed' as const,
          createdAt: Date.now(),
          resolvedAt: Date.now(),
        });
      }
    });

    const next = await file(t, { targetId: target, flaggerId: flagger });
    expect(next.filed).toBe(false);
    expect(next.occurrences).toBe(2);
    const open = (await flagsFor(t, target)).filter((f) => f.status === 'open');
    expect(open).toHaveLength(1);
  });

  test('a re-observation that is not a new occurrence leaves the open row untouched', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');

    await file(t, { targetId: target, flaggerId: flagger, now: 1_000 });
    const again = await t.run((ctx) =>
      fileOrBumpAutoFlag(ctx, {
        targetType: 'user',
        targetId: target,
        reason: 'unsafe_false_report',
        flaggerId: flagger,
        now: 9_999,
        countsAsOccurrence: false,
      }),
    );

    expect(again.filed).toBe(false);
    expect(again.occurrences).toBe(1);
    expect(again.alert).toBe(false);
    const rows = await flagsFor(t, target);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(1);
    // Not even `lastOccurrenceAt` moves: a re-observation is not an event.
    expect(rows[0]?.lastOccurrenceAt).toBe(1_000);
  });

  test('a state-shaped caller still FILES when nothing is tracking the problem yet', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');

    const result = await t.run((ctx) =>
      fileOrBumpAutoFlag(ctx, {
        targetType: 'user',
        targetId: target,
        reason: 'unsafe_false_report',
        flaggerId: flagger,
        countsAsOccurrence: false,
      }),
    );
    // `countsAsOccurrence: false` suppresses the *bump*, never the flag itself — otherwise the first
    // crossing that happened to arrive as a re-observation would go unrecorded entirely.
    expect(result.filed).toBe(true);
    expect(result.occurrences).toBe(1);
    expect(await flagsFor(t, target)).toHaveLength(1);
  });

  test('a different reason on the same target is a different problem', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    const flagger = await seedUser(t, 'flagger');
    await file(t, { targetId: target, flaggerId: flagger });
    await t.run((ctx) =>
      fileOrBumpAutoFlag(ctx, {
        targetType: 'user',
        targetId: target,
        reason: 'spam',
        flaggerId: flagger,
      }),
    );
    expect(await flagsFor(t, target)).toHaveLength(2);
  });
});

describe('shouldAlertAt', () => {
  test('fires on the first and then at widening intervals', () => {
    // Bundling exists to stop the founder being emailed on every recurrence. Silence forever is the
    // opposite failure, so the alert reappears as a count climbs.
    expect(shouldAlertAt(1)).toBe(true);
    expect(shouldAlertAt(2)).toBe(false);
    expect(shouldAlertAt(3)).toBe(true);
    expect(shouldAlertAt(4)).toBe(false);
    expect(shouldAlertAt(10)).toBe(true);
    expect(shouldAlertAt(11)).toBe(false);
    expect(shouldAlertAt(20)).toBe(true);
  });
});

/**
 * `activeBountyPostLimit` (N2) — D57's deferred bounty lever. A number rather than a boolean,
 * because bounties are requests rather than content: the proportionate answer to someone spamming
 * them is fewer, not none.
 */
describe('activeBountyPostLimit', () => {
  async function seedLake(t: ReturnType<typeof harness>) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Champlain',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [-73.5, 44],
              [-72.5, 44],
              [-72.5, 45],
              [-73.5, 45],
              [-73.5, 44],
            ],
          ],
        },
        bbox: { minLat: 44, minLng: -73.5, maxLat: 45, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73 },
        surfaceAreaSqM: 8.7e9,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
  }

  test('a per-user limit overrides the global cap downward', async () => {
    const t = harness();
    const lake = await seedLake(t);
    const requester = await seedUser(t, 'requester');
    await t.run((ctx) => ctx.db.patch(requester, { activeBountyPostLimit: 1 }));
    const as = t.withIdentity({ subject: 'requester' });

    await as.action(api.bounties.create, { waterBodyId: lake });
    // The global cap is 3; this user's is 1, and the message says *their* number.
    await expect(as.action(api.bounties.create, { waterBodyId: lake })).rejects.toThrow(
      /already have 1 open bounty/i,
    );
  });

  test('zero blocks bounty posting outright, and says so rather than reading as a bug', async () => {
    const t = harness();
    const lake = await seedLake(t);
    const requester = await seedUser(t, 'requester');
    await t.run((ctx) => ctx.db.patch(requester, { activeBountyPostLimit: 0 }));

    await expect(
      t.withIdentity({ subject: 'requester' }).action(api.bounties.create, { waterBodyId: lake }),
    ).rejects.toThrow(/cannot post bounties/i);
  });

  test('the gate event records the applied limit, so the cap chart can tell the two apart', async () => {
    const t = harness();
    const lake = await seedLake(t);
    const requester = await seedUser(t, 'requester');
    await t.run((ctx) => ctx.db.patch(requester, { activeBountyPostLimit: 1 }));
    const as = t.withIdentity({ subject: 'requester' });
    await as.action(api.bounties.create, { waterBodyId: lake });
    await expect(as.action(api.bounties.create, { waterBodyId: lake })).rejects.toThrow();

    const events = await t.run((ctx) => ctx.db.query('bountyGateEvents').collect());
    const capped = events.find((e) => e.decision === 'capped');
    // Without this, a handful of restricted users would read as evidence that the *global* cap is
    // too tight — the one conclusion the chart must not support by accident.
    expect(capped?.appliedLimit).toBe(1);
    expect(events.find((e) => e.decision === 'allowed')?.appliedLimit).toBe(1);
  });

  test('clearing the limit restores the global cap', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    await t.run((ctx) => ctx.db.patch(requester, { activeBountyPostLimit: 1 }));
    await t.run((ctx) => ctx.db.patch(requester, { activeBountyPostLimit: undefined }));
    const mine = await t
      .withIdentity({ subject: 'requester' })
      .query(api.bounties.myBountyLimit, {});
    expect(mine?.limit).toBe(MAX_OPEN_BOUNTIES_PER_DAY);
    expect(mine?.restricted).toBe(false);
  });

  test('the form-facing query reports the limit that applies to this person', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    await t.run((ctx) => ctx.db.patch(requester, { activeBountyPostLimit: 2 }));
    const mine = await t
      .withIdentity({ subject: 'requester' })
      .query(api.bounties.myBountyLimit, {});
    expect(mine).toMatchObject({ limit: 2, used: 0, restricted: true });
  });

  test('only a moderator can set it, and a reason is required', async () => {
    const t = harness();
    const target = await seedUser(t, 'target');
    await seedUser(t, 'member');
    const mod = await seedUser(t, 'mod');
    await t.run((ctx) => ctx.db.patch(mod, { role: 'moderator' as const }));

    await expect(
      t
        .withIdentity({ subject: 'member' })
        .mutation(api.moderation.setBountyPostLimit, { userId: target, limit: 1, reason: 'spam' }),
    ).rejects.toThrow(/moderator/i);
    await expect(
      t
        .withIdentity({ subject: 'mod' })
        .mutation(api.moderation.setBountyPostLimit, { userId: target, limit: 1, reason: '  ' }),
    ).rejects.toThrow(/reason/i);
    await expect(
      t
        .withIdentity({ subject: 'mod' })
        .mutation(api.moderation.setBountyPostLimit, { userId: target, limit: -1, reason: 'spam' }),
    ).rejects.toThrow(/whole number/i);

    await t
      .withIdentity({ subject: 'mod' })
      .mutation(api.moderation.setBountyPostLimit, { userId: target, limit: 1, reason: 'spam' });
    expect((await t.run((ctx) => ctx.db.get(target)))?.activeBountyPostLimit).toBe(1);

    // Reuses the existing audit vocabulary, so the moderation log stays one story.
    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', target as string))
        .collect(),
    );
    expect(audits.map((a) => a.action)).toContain('set_posting_permission');
  });
});
