import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
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
