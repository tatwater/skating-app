/**
 * The People server's follow-up (B01 §5.7, B01-4b): what the list and person pages asked for, one rule
 * for the Overview and the lanes, the audit-reason cap (D261), the parked-lapse mirror, and the bounds.
 */
import { AUDIT_REASON_MAX, AUDIT_REASON_TOO_LONG } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { LAST_EDITOR_MESSAGE } from './lib/ledgerEditors';
import { LEDGER_NEUTRAL_REFUSAL } from './lib/peopleCan';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { ReadBudget } from './lib/readBudget';
import { readTenure } from './lib/staffTenure';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

async function seed(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
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
      createdAt: T0 - 30 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
  return t;
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

// ── D261: the audit-reason cap ──

describe('an audit reason is capped at the one place it enters the log (D261)', () => {
  test('2,000 characters pass; one more is refused with a plain message, whatever the writer', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    const until = T0 + 3 * DAY;
    const at = 'x'.repeat(AUDIT_REASON_MAX);
    await as(t, 'mod').mutation(api.moderation.suspendUser, {
      userId: skater,
      reason: at,
      suspendedUntil: until,
    });
    await expect(
      as(t, 'mod').mutation(api.moderation.banUser, { userId: skater, reason: `${at}y` }),
    ).rejects.toThrow(AUDIT_REASON_TOO_LONG);
    // The refused write left nothing behind: the suspension stands.
    expect((await t.run((ctx) => ctx.db.get(skater)))?.status).toBe('suspended');
    // A row from before the cap is left alone and still reads.
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action: 'ban',
        targetType: 'user',
        targetId: skater,
        reason: 'z'.repeat(AUDIT_REASON_MAX * 2),
        createdAt: T0 - DAY,
      }),
    );
    const history = await as(t, 'mod').query(api.people.history, { userId: skater });
    expect(history?.rows.some((r) => r.reason.length === AUDIT_REASON_MAX * 2)).toBe(true);
  });
});

// ── Ids at the edge ──

describe('a person read given something that is not a profile id says no such person', () => {
  test('a malformed id and another table’s id read as null, not a validator error', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const flagId = await t.run(async (ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: (await ctx.db.query('profiles').first())?._id as Id<'profiles'>,
        targetType: 'report',
        targetId: 'r',
        reason: 'spam',
        status: 'open',
        subjectUserId: null,
        createdAt: T0,
      }),
    );
    const a = as(t, 'adm');
    for (const userId of ['x', flagId, ` ${flagId} `]) {
      expect(await a.query(api.people.person, { userId })).toBeNull();
      expect(await a.query(api.people.history, { userId })).toBeNull();
      expect(await a.query(api.people.decisions, { userId })).toBeNull();
      expect(await a.query(api.people.staffStats, { userId })).toBeNull();
      expect(await a.query(api.people.staffSeason, { userId })).toBeNull();
      expect(await a.query(api.people.reportTrend, { userId })).toBeNull();
    }
  });
});

// ── Every person write returns its audit row ──

describe('every person write returns the audit row it wrote (the undo toast’s handle)', () => {
  test('discipline, roles and the ledger', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    const skater = await seed(t, 'skater');
    const other = await seed(t, 'other', { role: 'admin' });
    const a = as(t, 'adm');
    const writes = [
      () =>
        a.mutation(api.moderation.setPostingPermission, {
          userId: skater,
          permission: 'comments',
          allowed: false,
          reason: 'r',
        }),
      () =>
        a.mutation(api.moderation.setBountyPostLimit, { userId: skater, limit: 1, reason: 'r' }),
      () =>
        a.mutation(api.moderation.suspendUser, {
          userId: skater,
          reason: 'r',
          suspendedUntil: T0 + DAY,
        }),
      () => a.mutation(api.moderation.banUser, { userId: skater, reason: 'r' }),
      () => a.mutation(api.moderation.unbanUser, { userId: skater }),
      () => a.mutation(api.admin.grantRole, { userId: skater, role: 'moderator' }),
      () => a.mutation(api.admin.revokeRole, { userId: skater, reason: 'r' }),
      () => a.mutation(api.ledger.grantEditor, { userId: other }),
      () => a.mutation(api.ledger.revokeEditor, { userId: other, reason: 'r' }),
    ];
    for (const write of writes) {
      const out = await write();
      const row = await t.run((ctx) => ctx.db.get(out.actionId));
      expect(row?.targetId).toBe(out.userId);
      // It is the newest row on the person: exactly the one this write made.
      const newest = await t.run((ctx) =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', out.userId))
          .order('desc')
          .first(),
      );
      expect(newest?._id).toBe(out.actionId);
    }
  });
});

// ── `can`: the ledger sentence for holders only, and every give-back spelled out ──

describe('can', () => {
  test('the last-editor refusal names the holder only to holders; the write still says it', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    await seed(t, 'plain', { role: 'admin' });
    const holder = await seed(t, 'holder', { role: 'admin', canEditLedger: true });
    const forMod = await as(t, 'mod').query(api.people.person, { userId: holder });
    // Before, a moderator read `{ ok: false, why: LAST_EDITOR_MESSAGE }` here.
    expect(forMod?.can.suspend).toEqual({ ok: false, why: 'Only an admin can moderate an admin' });
    const forAdmin = await as(t, 'plain').query(api.people.person, { userId: holder });
    expect(forAdmin?.can.suspend).toEqual({ ok: false, why: LEDGER_NEUTRAL_REFUSAL });
    expect(forAdmin?.can.ban).toEqual({ ok: false, why: LEDGER_NEUTRAL_REFUSAL });
    expect(forAdmin?.can.role.moderator).toEqual({ ok: false, why: LEDGER_NEUTRAL_REFUSAL });
    // The holder themself reads it in full on their own page's refusals (self first, here), and
    // the write keeps its own words for anyone who presses it.
    await expect(
      as(t, 'plain').mutation(api.moderation.banUser, { userId: holder, reason: 'r' }),
    ).rejects.toThrow(LAST_EDITOR_MESSAGE);
  });

  test('every give-back and the bounty limit both ways, as the writes answer them', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater', {
      canPostComments: false,
      canFlag: false,
      status: 'suspended',
      suspendedUntil: T0 + DAY,
    });
    const can = (await as(t, 'mod').query(api.people.person, { userId: skater }))?.can;
    expect(can?.restore).toEqual({
      reports: { ok: true, needsReason: false },
      hazards: { ok: true, needsReason: false },
      comments: { ok: true, needsReason: false },
    });
    expect(can?.flaggingOn).toEqual({ ok: true, needsReason: false });
    expect(can?.bountyRaise).toEqual({ ok: true, needsReason: false });
    expect(can?.bountyLower).toEqual({ ok: true, needsReason: true });
    expect(can?.extend).toEqual({ ok: true, needsReason: true });
    // Each, pressed, goes through without a reason where none is asked.
    await as(t, 'mod').mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'comments',
      allowed: true,
    });
    await as(t, 'mod').mutation(api.moderation.setBountyPostLimit, { userId: skater, limit: 9 });
    // Not suspended: no suspension to extend.
    const active = await seed(t, 'active');
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: active }))?.can.extend,
    ).toMatchObject({ ok: false });
  });
});

// ── The person page's new fields ──

describe('people.person: when, the public profile, labels and appeals', () => {
  test('rights since, ledger since, the public profile, flag labels, appeal text for admins', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const adm = await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    const skater = await seed(t, 'skater', { profileVisibility: 'private' });
    vi.setSystemTime(T0 - 2 * DAY);
    await as(t, 'adm').mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'hazards',
      allowed: false,
      reason: 'r',
    });
    vi.setSystemTime(T0);
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Mascoma Lake',
        searchText: 'Mascoma Lake',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        dedupStatus: 'clean' as const,
        createdAt: T0,
      }),
    );
    await t.run(async (ctx) => {
      await rebuildBodyLibrary(ctx, body);
      const report = await ctx.db.insert('reports', {
        authorId: skater,
        waterBodyId: body,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      });
      await ctx.db.insert('contentFlags', {
        flaggerId: adm,
        targetType: 'report',
        targetId: report,
        reason: 'spam',
        status: 'open',
        subjectUserId: skater,
        createdAt: T0,
      });
      await ctx.db.insert('supportTickets', {
        userId: skater,
        clerkUserId: 'skater',
        category: 'account',
        status: 'open',
        body: 'Please lift it',
        createdAt: T0,
      });
    });
    const forAdm = await as(t, 'adm').query(api.people.person, { userId: skater });
    expect(forAdm?.rightsSince).toEqual({
      reports: null,
      hazards: T0 - 2 * DAY,
      comments: null,
      flagging: null,
    });
    expect(forAdm?.rightsSinceCapped).toBe(false);
    expect(forAdm?.publicProfile).toEqual({ opens: true, private: true, path: '/u/skater' });
    expect(forAdm?.open.flags[0]?.targetLabel).toBe('Mascoma Lake');
    expect(forAdm?.open.flagLabelsCapped).toBe(false);
    expect(forAdm?.open.appeals?.[0]?.body).toBe('Please lift it');
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: skater }))?.open.appeals,
    ).toBeNull();
    // The ledger's grant time, holders only.
    await as(t, 'adm').mutation(api.ledger.grantEditor, {
      userId: await seed(t, 'two', { role: 'admin' }),
    });
    const two = (await t.run((ctx) => ctx.db.query('profiles').collect())).find(
      (p) => p.username === 'two',
    )?._id as Id<'profiles'>;
    expect((await as(t, 'adm').query(api.people.person, { userId: two }))?.ledger?.since).toBe(T0);
    // A deleted account's profile doesn't open.
    const gone = await seed(t, 'gone', { status: 'deleted', deletedAt: T0 });
    expect(
      (await as(t, 'adm').query(api.people.person, { userId: gone }))?.publicProfile.opens,
    ).toBe(false);
  });

  test('the bounty season line: this season’s asks, or not recorded outside the gate’s record', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Pond',
        searchText: 'Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        dedupStatus: 'clean' as const,
        createdAt: T0,
      }),
    );
    await t.run(async (ctx) => {
      for (const decision of ['allowed', 'capped', 'capped', 'suppressed'] as const) {
        await ctx.db.insert('bountyGateEvents', {
          waterBodyId: body,
          requesterId: skater,
          decision,
          weatherReopened: false,
          createdAt: T0 - DAY,
        });
      }
      // Last season: not this season's.
      await ctx.db.insert('bountyGateEvents', {
        waterBodyId: body,
        requesterId: skater,
        decision: 'capped',
        weatherReopened: false,
        createdAt: Date.UTC(2026, 5, 1),
      });
    });
    const line = (await as(t, 'mod').query(api.people.person, { userId: skater }))?.bountySeason;
    expect(line).toEqual({
      since: Date.UTC(2026, 6, 1),
      asks: { count: 4, capped: false },
      overLimit: { count: 2, capped: false },
      hadRecentReport: { count: 1, capped: false },
    });
    // Late in the season, its start is past the gate's 180-day record: not recorded.
    vi.setSystemTime(Date.UTC(2027, 1, 1));
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: skater }))?.bountySeason,
    ).toBeNull();
  });
});

// ── The list page ──

describe('people.listPage: keys, ends, ages and the Staff lane', () => {
  test('Flagged rows carry their oldest open flag, the order they are listed in', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const early = await seed(t, 'early');
    const late = await seed(t, 'late');
    await t.run(async (ctx) => {
      for (const [who, at] of [
        [late, T0 - DAY],
        [early, T0 - 3 * DAY],
        [early, T0 - 2 * DAY],
      ] as const) {
        await ctx.db.insert('contentFlags', {
          flaggerId: filer,
          targetType: 'user',
          targetId: who,
          reason: 'spam',
          status: 'open',
          subjectUserId: who,
          createdAt: at,
        });
      }
    });
    const page = await as(t, 'mod').query(api.people.listPage, { lane: 'flagged' });
    expect(page.rows.map((r) => [r.userId, r.oldestOpenAt])).toEqual([
      [early, T0 - 3 * DAY],
      [late, T0 - DAY],
    ]);
    // A later page is keyed by the lane's order: the first person leaving moves nothing.
    const first = await as(t, 'mod').query(api.people.listPage, { lane: 'flagged', pageSize: 1 });
    await t.run(async (ctx) => {
      for (const f of await ctx.db.query('contentFlags').collect()) {
        if (f.targetId === early) await ctx.db.patch(f._id, { status: 'actioned' });
      }
    });
    const rest = await as(t, 'mod').query(api.people.listPage, {
      lane: 'flagged',
      cursor: first.continueCursor,
    });
    expect(rest.rows.map((r) => r.userId)).toEqual([late]);
  });

  test('a page read to its end cursor neither drops nor repeats a row when an earlier page grows', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    for (const name of ['b', 'd', 'f', 'h']) await seed(t, name);
    const first = await as(t, 'mod').query(api.people.listPage, { lane: 'everyone', pageSize: 2 });
    const second = await as(t, 'mod').query(api.people.listPage, {
      lane: 'everyone',
      pageSize: 2,
      cursor: first.continueCursor,
    });
    // Someone joins inside the second page's range: read to its end, it grows by them and drops no
    // one into the next page (read by count alone, `h` would fall off it).
    await seed(t, 'e');
    const again = await as(t, 'mod').query(api.people.listPage, {
      lane: 'everyone',
      pageSize: 2,
      cursor: first.continueCursor,
      endCursor: second.continueCursor,
    });
    expect(second.rows.map((r) => r.username)).toEqual(['f', 'h']);
    expect(again.rows.map((r) => r.username)).toEqual(['e', 'f', 'h']);
    expect(again.continueCursor).toBe(second.continueCursor);
  });

  test('Staff rows: last seen in the console (within the record), role since as the strip says, this week’s decisions', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const mod = await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    await as(t, 'adm').mutation(api.admin.grantRole, { userId: skater, role: 'moderator' });
    await as(t, 'adm').mutation(api.moderation.suspendUser, {
      userId: await seed(t, 's2'),
      reason: 'r',
      suspendedUntil: T0 + DAY,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('consolePresence', { userId: adm, seenAt: T0 - 60_000 });
      // Seen before the previous season began: past the record's retention, not recorded.
      await ctx.db.insert('consolePresence', { userId: mod, seenAt: Date.UTC(2024, 0, 1) });
    });
    const rows = (await as(t, 'adm').query(api.people.listPage, { lane: 'staff' })).rows;
    const byId = new Map(rows.map((r) => [r.userId, r.staff]));
    expect(byId.get(adm)?.lastSeenInConsoleAt).toBe(T0 - 60_000);
    expect(byId.get(mod)?.lastSeenInConsoleAt).toBeNull();
    const stats = await as(t, 'adm').query(api.people.staffStats, { userId: skater });
    expect(byId.get(skater)?.roleSince).toBe(stats?.roleSince?.at);
    expect(byId.get(skater)?.roleSince).toBe(T0);
    const admStats = await as(t, 'adm').query(api.people.staffStats, { userId: adm });
    expect(byId.get(adm)?.decisionsThisWeek).toEqual(admStats?.decisions.thisWeek);
    expect(byId.get(adm)?.decisionsThisWeek.count).toBe(2);
    // Other lanes don't carry the Staff columns.
    const everyone = await as(t, 'adm').query(api.people.listPage, { lane: 'everyone' });
    expect(everyone.rows.every((r) => r.staff === null && r.oldestOpenAt === null)).toBe(true);
  });

  test('a role undone twice: the row’s stamp and the strip agree on the original date', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    const grant = await as(t, 'adm').mutation(api.admin.grantRole, {
      userId: skater,
      role: 'moderator',
    });
    vi.setSystemTime(T0 + 1_000);
    await as(t, 'adm').mutation(api.undo.run, { actionId: grant.actionId, reason: 'oops' });
    const undo = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_undoes', (q) => q.eq('undoesActionId', grant.actionId))
        .first(),
    );
    vi.setSystemTime(T0 + 2_000);
    await as(t, 'adm').mutation(api.undo.run, {
      actionId: undo?._id as Id<'moderationActions'>,
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', skater))
        .first(),
    );
    const stats = await as(t, 'adm').query(api.people.staffStats, { userId: skater });
    expect(row?.roleSince).toBe(T0);
    expect(stats?.roleSince?.at).toBe(T0);
  });
});

describe('lib/staffTenure at its edges', () => {
  test('a read with no budget left says short; a stamp for someone with no row does nothing', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const read = await t.run((ctx) => readTenure(ctx, new ReadBudget(0), adm, 'admin', true));
    expect(read).toMatchObject({ roleShort: true, tenure: { staffSince: null, roleSince: null } });
    const rowless = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'rowless',
        displayName: 'rowless',
        username: 'rowless',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'moderator' as const,
        status: 'active' as const,
        createdAt: T0,
      }),
    );
    await t.mutation(internal.peopleJobs.stampOne, { userId: rowless });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', rowless))
          .first(),
      ),
    ).toBeNull();
  });

  test('a demotion to member clears the stamp', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    await as(t, 'adm').mutation(api.admin.grantRole, { userId: skater, role: 'moderator' });
    await as(t, 'adm').mutation(api.admin.revokeRole, { userId: skater, reason: 'r' });
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', skater))
        .first(),
    );
    expect(row?.tenureAt).toBeUndefined();
    expect(row?.roleSince).toBeUndefined();
  });
});

// ── staffStats: who undid, and the time bound ──

describe('people.staffStats', () => {
  test('undone by others names who, most first', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', { role: 'moderator' });
    const adm = await seed(t, 'adm', { role: 'admin' });
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const root = await ctx.db.insert('moderationActions', {
          actorId: matt,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `x${i}`,
          reason: 'r',
          undoTop: 1,
          undoTopActorId: adm,
          createdAt: T0 - 1_000 - i,
        });
        await ctx.db.insert('moderationActions', {
          actorId: adm,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `x${i}`,
          reason: 'r',
          undoesActionId: root,
          undoRoot: root,
          undoDepth: 1,
          createdAt: T0 - 500,
        });
      }
    });
    const s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.undoneByOthers).toMatchObject({
      count: 2,
      capped: false,
      by: [{ userId: adm, displayName: 'adm', count: 2 }],
      byMore: 0,
    });
  });

  test('a week past the time bound says capped rather than running long', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', { role: 'moderator' });
    await seed(t, 'adm', { role: 'admin' });
    await t.run(async (ctx) => {
      for (let i = 0; i < 420; i++) {
        const flag = await ctx.db.insert('contentFlags', {
          flaggerId: matt,
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'spam',
          status: 'actioned',
          subjectUserId: null,
          createdAt: T0 - DAY,
        });
        await ctx.db.insert('moderationActions', {
          actorId: matt,
          action: 'resolve_flag',
          targetType: 'contentFlag',
          targetId: flag,
          reason: 'r',
          createdAt: T0 - 1_000,
        });
      }
    });
    const s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.thisWeek).toEqual({ count: 420, capped: false });
    expect(s?.timeToDecide).toMatchObject({ medianMs: null, decided: 420, capped: true });
  });
});

// ── The parked-lapse mirror, counted by Machinery ──

describe('a parked lapse is a small row Machinery counts', () => {
  test('three failed resets park it in the mirror; a lift clears it', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater', { status: 'suspended', suspendedUntil: T0 - DAY });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await import('./lib/peopleRows');
    for (let i = 0; i < 3; i++) {
      vi.spyOn(rows, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
      await t.mutation(internal.peopleJobs.sweepLapsedSuspensions, {});
      vi.restoreAllMocks();
    }
    quiet.mockRestore();
    const health = await as(t, 'adm').query(api.recurringJobs.health, {});
    const lapses = health.jobs.find((j) => j.job === 'reset lapsed suspensions');
    expect(lapses).toMatchObject({ parked: 1, failing: 0 });
    await as(t, 'adm').mutation(api.moderation.unbanUser, { userId: skater });
    const after = await as(t, 'adm').query(api.recurringJobs.health, {});
    expect(after.jobs.find((j) => j.job === 'reset lapsed suspensions')).toMatchObject({
      parked: 0,
    });
    void adm;
  });
});

// ── The avatar URL cap ──

describe('an avatar URL past the cap is not stored', () => {
  test('the Clerk mirror keeps a normal URL and drops an over-long one', async () => {
    const t = await setup();
    const skater = await seed(t, 'skater');
    const sync = (profileImageUrl: string) =>
      t.mutation(internal.profiles.applyClerkMirrors, {
        clerkUserId: 'skater',
        profileImageUrl,
      } as never);
    await sync('https://img.example/a.png');
    expect((await t.run((ctx) => ctx.db.get(skater)))?.profileImageUrl).toBe(
      'https://img.example/a.png',
    );
    await sync(`https://img.example/${'a'.repeat(3_000)}`);
    expect((await t.run((ctx) => ctx.db.get(skater)))?.profileImageUrl).toBeUndefined();
  });
});
