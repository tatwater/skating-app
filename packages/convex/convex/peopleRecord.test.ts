/**
 * A person's record on the People page: History (the union of what was done to them and to their
 * content, ledger rows for holders only), a staffer's Decisions and strip, and the reports trend.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { writeAudit } from './lib/audit';
import { markReady, READY_FLAG_SUBJECTS, READY_ROWS, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
/** A Saturday in the season: 14 November 2026, noon UTC. */
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
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
      createdAt: Date.now() - 400 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, READY_ROWS);
    await markReady(ctx, READY_FLAG_SUBJECTS);
  });
  const bodyId = await t.run((ctx) =>
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
      createdAt: Date.now(),
    }),
  );
  return { t, bodyId };
}

function report(
  t: T,
  authorId: Id<'profiles'>,
  bodyId: Id<'waterBodies'>,
  over: Partial<Doc<'reports'>> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId: bodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: Date.now(),
      reportTime: Date.now(),
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

describe('people.history', () => {
  test('what was done to them, to their content and its reversal, and decisions on flags about them', async () => {
    const { t, bodyId } = await setup();
    await seed(t, 'matt', { role: 'moderator' });
    await seed(t, 'sarah', { role: 'moderator' });
    await seed(t, 'filer');
    const rob = await seed(t, 'rob');
    const r1 = await report(t, rob, bodyId);
    const matt = as(t, 'matt');
    await matt.mutation(api.moderation.setPostingPermission, {
      userId: rob,
      permission: 'comments',
      allowed: false,
      reason: 'name-calling',
    });
    vi.advanceTimersByTime(60_000);
    await matt.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: r1,
      status: 'hidden',
      reason: 'unsafe claim',
    });
    vi.advanceTimersByTime(60_000);
    await as(t, 'sarah').mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: r1,
      status: 'visible',
      reason: 'it was fine',
    });
    vi.advanceTimersByTime(60_000);
    const flagId = await as(t, 'filer').mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: r1,
      reason: 'spam',
    });
    await matt.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'dismissed',
      reason: 'no',
    });
    const h = await matt.query(api.people.history, { userId: rob });
    expect(h?.rows.map((r) => r.action)).toEqual([
      'dismiss_flag',
      'restore',
      'hide',
      'set_posting_permission',
    ]);
    expect(h?.capped).toBe(false);
    expect(h?.createdAt).toBe(T0 - 400 * DAY);
    expect(h?.rows[1]?.actor?.username).toBe('sarah');
    expect(h?.rows.every((r) => typeof r.id === 'string' && r.undo !== undefined)).toBe(true);
    // A short read says it is capped, and keeps only what is newer than what it couldn't read.
    const short = await matt.query(api.people.history, { userId: rob, limit: 1 });
    expect(short?.rows.map((r) => r.action)).toEqual(['dismiss_flag']);
    expect(short?.capped).toBe(true);
  });

  test('ledger rows reach a holder only — in History and in Decisions', async () => {
    const { t } = await setup();
    await seed(t, 'holder', { role: 'admin', canEditLedger: true });
    await seed(t, 'plain', { role: 'admin' });
    const sarah = await seed(t, 'sarah', { role: 'admin' });
    await as(t, 'holder').mutation(api.ledger.grantEditor, { userId: sarah });
    const seen = await as(t, 'holder').query(api.people.history, { userId: sarah });
    expect(seen?.rows.map((r) => r.action)).toEqual(['grant_ledger_editor']);
    const hidden = await as(t, 'plain').query(api.people.history, { userId: sarah });
    expect(hidden?.rows).toEqual([]);
    const holderId = (await t.run((ctx) => ctx.db.query('profiles').collect())).find(
      (p) => p.username === 'holder',
    )?._id as Id<'profiles'>;
    expect(
      (await as(t, 'holder').query(api.people.decisions, { userId: holderId })).rows.map(
        (r) => r.action,
      ),
    ).toEqual(['grant_ledger_editor']);
    expect((await as(t, 'plain').query(api.people.decisions, { userId: holderId })).rows).toEqual(
      [],
    );
    const stats = await as(t, 'plain').query(api.people.staffStats, { userId: holderId });
    expect(stats?.decisions.thisWeek.count).toBe(0);
  });
});

describe('people.staffStats and people.decisions', () => {
  test('decisions leave out their own skater actions; undone by others; time to decide; overturned; staff since', async () => {
    const { t, bodyId } = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const matt = await seed(t, 'matt', { role: 'member' });
    await seed(t, 'filer');
    const skater = await seed(t, 'skater');
    // Made a moderator: the grant row is "staff since".
    await as(t, 'adm').mutation(api.admin.grantRole, { userId: matt, role: 'moderator' });
    const sinceAt = Date.now();
    vi.advanceTimersByTime(DAY);
    // A flag filed an hour before Matt dismisses it.
    const r1 = await report(t, skater, bodyId);
    const flagId = await as(t, 'filer').mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: r1,
      reason: 'spam',
    });
    vi.advanceTimersByTime(60 * 60_000);
    await as(t, 'matt').mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'dismissed',
      reason: 'ok',
    });
    // A hide the admin restores: overturned by someone else.
    await as(t, 'matt').mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: r1,
      status: 'hidden',
      reason: 'claim',
    });
    await as(t, 'adm').mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: r1,
      status: 'visible',
      reason: 'fine',
    });
    // A restriction the admin undoes.
    await as(t, 'matt').mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'hazards',
      allowed: false,
      reason: 'pins',
    });
    const restriction = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).find(
      (r) => r.action === 'set_posting_permission',
    );
    await as(t, 'adm').mutation(api.undo.run, {
      actionId: restriction?._id as Id<'moderationActions'>,
    });
    // Matt's own skater action: not a decision.
    await t.run((ctx) =>
      writeAudit(ctx, {
        actorId: matt,
        action: 'author_delete',
        targetType: 'report',
        targetId: 'own',
        reason: 'mine',
      }),
    );

    const s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.thisWeek).toEqual({ count: 3, capped: false });
    expect(s?.decisions.undoneByOthers).toEqual({ count: 1, capped: false });
    expect(s?.timeToDecide).toEqual({ medianMs: 60 * 60_000, decided: 1, capped: false });
    expect(s?.overturned).toEqual({ count: 2, capped: false });
    expect(s?.staffSince).toEqual({ at: sinceAt, role: 'moderator' });
    expect(s?.roleSince).toEqual({ at: sinceAt, role: 'moderator' });
    expect(s?.weeks).toHaveLength(9);
    expect(s?.weeks[8]?.count).toBe(3);
    expect(s?.season).toMatchObject({ season: 2026, opensOn: '2026-10-01', empty: false });
    const d = await as(t, 'adm').query(api.people.decisions, { userId: matt });
    expect(d.rows.map((r) => r.action)).not.toContain('author_delete');
    expect(d.rows).toHaveLength(3);
    // Not staff: no strip. The first admin, with no grant row: not recorded.
    expect(await as(t, 'adm').query(api.people.staffStats, { userId: skater })).toBeNull();
    const admId = (await t.run((ctx) => ctx.db.query('profiles').collect())).find(
      (p) => p.username === 'adm',
    )?._id as Id<'profiles'>;
    const first = await as(t, 'adm').query(api.people.staffStats, { userId: admId });
    expect(first?.staffSince).toBeNull();
    expect(first?.roleSince).toBeNull();
  });

  test('between 1 July and 1 October the season is honestly empty', async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 15, 12));
    const { t } = await setup();
    const mod = await seed(t, 'mod', { role: 'moderator' });
    const s = await as(t, 'mod').query(api.people.staffStats, { userId: mod });
    expect(s?.overturned).toBeNull();
    expect(s?.season).toMatchObject({ season: 2026, opensOn: '2026-10-01', empty: true });
    // A past season, chosen.
    const past = await as(t, 'mod').query(api.people.staffStats, { userId: mod, season: 2025 });
    expect(past?.overturned).toEqual({ count: 0, capped: false });
  });
});

describe('people.reportTrend', () => {
  test('kept, hidden and edited; months before the account are absent; an author’s deletion is neither', async () => {
    const { t, bodyId } = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const rob = await seed(t, 'rob', { createdAt: Date.UTC(2026, 8, 20) });
    await report(t, rob, bodyId, { skateEndTime: Date.UTC(2026, 9, 3) });
    await report(t, rob, bodyId, { skateEndTime: Date.UTC(2026, 10, 2), editedAt: 1 });
    await report(t, rob, bodyId, {
      skateEndTime: Date.UTC(2026, 10, 9),
      moderationStatus: 'hidden',
    });
    await report(t, rob, bodyId, {
      skateEndTime: Date.UTC(2026, 10, 10),
      moderationStatus: 'removed',
      authorDeletedAt: 1,
    });
    const r = await as(t, 'mod').query(api.people.reportTrend, { userId: rob });
    expect(r?.months).toEqual([
      { month: '2026-09', kept: 0, hidden: 0 },
      { month: '2026-10', kept: 1, hidden: 0 },
      { month: '2026-11', kept: 1, hidden: 1 },
    ]);
    expect(r?.total).toEqual({ count: 3, capped: false });
    expect(r?.hidden).toEqual({ count: 1, capped: false });
    expect(r?.edited).toEqual({ count: 1, capped: false });
    expect(r?.monthsCapped).toBe(false);
    const short = await as(t, 'mod').query(api.people.reportTrend, { userId: rob, months: 1 });
    expect(short?.months.map((m) => m.month)).toEqual(['2026-11']);
  });
});

describe('time to decide on rows from before they recorded the filing', () => {
  test('a flag decision reads its flag; a drawn body’s, unknown, makes the median not recorded', async () => {
    const { t } = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const mod = await seed(t, 'mod', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const flagId = await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer,
        targetType: 'user',
        targetId: filer,
        reason: 'spam',
        status: 'dismissed',
        createdAt: Date.now() - 30 * 60_000,
      }),
    );
    await t.run((ctx) =>
      writeAudit(ctx, {
        actorId: mod,
        action: 'dismiss_flag',
        targetType: 'contentFlag',
        targetId: flagId,
        reason: 'no',
      }),
    );
    const s = await as(t, 'adm').query(api.people.staffStats, { userId: mod });
    expect(s?.timeToDecide).toEqual({ medianMs: 30 * 60_000, decided: 1, capped: false });
    await t.run((ctx) =>
      writeAudit(ctx, {
        actorId: mod,
        action: 'approve_waterbody',
        targetType: 'waterbody',
        targetId: 'old',
        reason: 'ok',
      }),
    );
    const after = await as(t, 'adm').query(api.people.staffStats, { userId: mod });
    expect(after?.timeToDecide).toEqual({ medianMs: null, decided: 2, capped: false });
  });

  test('an admin reads a person’s open appeals; a moderator gets none of them', async () => {
    const { t } = await setup();
    await seed(t, 'adm', { role: 'admin' });
    await seed(t, 'mod', { role: 'moderator' });
    const rob = await seed(t, 'rob');
    await t.run(async (ctx) => {
      await ctx.db.insert('supportTickets', {
        userId: rob,
        clerkUserId: 'rob',
        category: 'account',
        status: 'open',
        body: 'Appeal',
        createdAt: Date.now(),
      });
      await ctx.db.insert('supportTickets', {
        userId: rob,
        clerkUserId: 'rob',
        category: 'bug',
        status: 'open',
        body: 'Map',
        createdAt: Date.now(),
      });
    });
    const a = await as(t, 'adm').query(api.people.person, { userId: rob });
    expect(a?.open.appeals).toHaveLength(1);
    expect((await as(t, 'mod').query(api.people.person, { userId: rob }))?.open.appeals).toBeNull();
  });
});

describe('a decision undone and then redone stands', () => {
  test('undone by others counts only an undo that still stands', async () => {
    const { t } = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const matt = await seed(t, 'matt', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    await as(t, 'matt').mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'hazards',
      allowed: false,
      reason: 'pins',
    });
    const newest = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', skater))
            .order('desc')
            .take(1),
        )
      )[0]?._id as Id<'moderationActions'>;
    await as(t, 'adm').mutation(api.undo.run, { actionId: await newest() });
    let s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.undoneByOthers.count).toBe(1);
    expect(s?.overturned?.count).toBe(1);
    await as(t, 'adm').mutation(api.undo.run, { actionId: await newest(), reason: 'r' });
    s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.undoneByOthers.count).toBe(0);
    expect(s?.overturned?.count).toBe(0);
  });
});
