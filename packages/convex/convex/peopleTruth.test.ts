/**
 * Every lane tells the truth about the reads it depends on: hitting any upstream cap or gap — the
 * rows backfill, the open flag queue's cap, a flag without its subject, the support queue's cap, a
 * time-bound lane's count cap, a person a queue names with no row — shows in the lane's count
 * (`capped`, with its reason) and in its list (`partial`, with its reason). One test at cap + 1 each.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { APPEALS_CAP, LANE_COUNT_CAP } from './lib/peopleFigures';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
type T = ReturnType<typeof convexTest>;

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

function profile(subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return {
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
    createdAt: Date.now() - 30 * DAY,
    ...over,
  };
}

/** `n` people at once, each with a row unless `rows` is false. */
async function many(t: T, n: number, over: Partial<Doc<'profiles'>> = {}, rows = true) {
  return t.run(async (ctx) => {
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      const id = await ctx.db.insert('profiles', profile(`p${ids.length}-${Math.random()}`, over));
      if (rows) await refreshPersonRow(ctx, id);
      ids.push(id);
    }
    return ids;
  });
}

async function setup({ ready = true }: { ready?: boolean } = {}) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', profile('adm', { role: 'admin' }));
    await refreshPersonRow(ctx, id);
    if (ready) {
      await markReady(ctx, 'rows');
      await markReady(ctx, 'flagSubjects');
    }
  });
  return { t, adm: t.withIdentity({ subject: 'adm' }) };
}

async function lane(t: T, name: string) {
  const { lanes } = await t.withIdentity({ subject: 'adm' }).query(api.people.lanes, {});
  return lanes.find((l) => l.lane === name);
}

describe('each upstream cap or gap shows in the count and the list', () => {
  test('nothing missing: every lane whole, every list whole', async () => {
    const { adm } = await setup();
    for (const l of (await adm.query(api.people.lanes, {})).lanes) {
      expect(l.reasons, l.lane).toEqual([]);
      expect(l.pending, l.lane).toEqual([]);
      expect(l.count.capped, l.lane).toBe(false);
      const page = await adm.query(api.people.listPage, { lane: l.lane });
      expect(page, l.lane).toMatchObject({ partial: false, reasons: [], pending: [] });
    }
  });

  test('the rows backfill not finished: every lane and list says not ready, distinct from capped', async () => {
    const { adm } = await setup({ ready: false });
    for (const l of (await adm.query(api.people.lanes, {})).lanes) {
      expect(l.pending, l.lane).toContain('rows');
      expect(l.reasons, l.lane).toEqual([]);
      expect(l.count.capped).toBe(false);
      const page = await adm.query(api.people.listPage, { lane: l.lane });
      expect(page.pending, l.lane).toContain('rows');
      expect(page).toMatchObject({ partial: false, reasons: [] });
    }
  });

  test('the open flag queue past its cap: Flagged’s count and every list (each row’s open flags)', async () => {
    const { t, adm } = await setup();
    const [filer, subject] = await many(t, 2);
    await t.run(async (ctx) => {
      for (let i = 0; i <= LANE_COUNT_CAP; i++) {
        await ctx.db.insert('contentFlags', {
          flaggerId: filer as Id<'profiles'>,
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'spam',
          status: 'open',
          subjectUserId: subject as Id<'profiles'>,
          createdAt: Date.now(),
        });
      }
    });
    expect((await lane(t, 'flagged'))?.reasons).toEqual(['flags_capped']);
    expect((await lane(t, 'everyone'))?.reasons).toEqual([]);
    for (const name of ['flagged', 'everyone']) {
      const page = await adm.query(api.people.listPage, { lane: name });
      expect(page.reasons, name).toEqual(['flags_capped']);
    }
  });

  test('a content flag older than its subject stamp', async () => {
    const { t, adm } = await setup();
    const [filer] = await many(t, 1);
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer as Id<'profiles'>,
        targetType: 'report',
        targetId: 'r',
        reason: 'spam',
        status: 'open',
        createdAt: Date.now(),
      }),
    );
    expect(await lane(t, 'flagged')).toMatchObject({ reasons: [], pending: ['flagSubjects'] });
    expect((await lane(t, 'everyone'))?.pending).toEqual([]);
    const page = await adm.query(api.people.listPage, { lane: 'flagged' });
    expect(page).toMatchObject({ partial: false, reasons: [], pending: ['flagSubjects'] });
  });

  test('the appeals queue past its cap: Appeals open, count and list', async () => {
    const { t, adm } = await setup();
    const [skater] = await many(t, 1);
    await t.run(async (ctx) => {
      // The lane reads a status's account tickets only, to their cap and one past it.
      for (let i = 0; i <= APPEALS_CAP; i++) {
        await ctx.db.insert('supportTickets', {
          userId: skater as Id<'profiles'>,
          clerkUserId: 'x',
          category: 'account',
          status: 'open',
          body: 'b',
          createdAt: Date.now() + i,
        });
      }
    });
    const appeals = await lane(t, 'appeals');
    expect(appeals?.reasons).toEqual(['tickets_capped']);
    expect(appeals?.count.capped).toBe(true);
    const page = await adm.query(api.people.listPage, { lane: 'appeals' });
    expect(page).toMatchObject({ partial: true, reasons: ['tickets_capped'] });
  });

  test('Suspended and Newest past their count cap: the count says so, the list pages on', async () => {
    const { t, adm } = await setup();
    await many(t, LANE_COUNT_CAP + 1, {
      status: 'suspended',
      suspendedUntil: Date.now() + DAY,
      createdAt: Date.now(),
    });
    for (const name of ['suspended', 'newest']) {
      const l = await lane(t, name);
      expect(l?.reasons, name).toEqual(['count_capped']);
      expect(l?.count).toEqual({ count: LANE_COUNT_CAP, capped: true });
    }
    let seen = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: unknown[]; isDone: boolean; continueCursor: string; partial: boolean } =
        await adm.query(api.people.listPage, { lane: 'suspended', cursor, pageSize: 100 });
      expect(page.partial).toBe(false);
      seen += page.rows.length;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toBe(LANE_COUNT_CAP + 1);
  });

  test('a person a queue names with no row yet is reported missing from the list', async () => {
    const { t, adm } = await setup();
    const [filer] = await many(t, 1);
    const [rowless] = await many(t, 1, {}, false);
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer as Id<'profiles'>,
        targetType: 'user',
        targetId: rowless as Id<'profiles'>,
        reason: 'spam',
        status: 'open',
        createdAt: Date.now(),
      }),
    );
    const page = await adm.query(api.people.listPage, { lane: 'flagged' });
    expect(page.rows).toEqual([]);
    expect(page).toMatchObject({ partial: true, reasons: ['rows_missing'] });
    // Someone listable first, the rowless one after: every page says what the lane is missing.
    const [listable] = await many(t, 1);
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer as Id<'profiles'>,
        targetType: 'user',
        targetId: listable as Id<'profiles'>,
        reason: 'spam',
        status: 'open',
        createdAt: Date.now() - DAY,
      }),
    );
    const first = await adm.query(api.people.listPage, { lane: 'flagged', pageSize: 1 });
    expect(first.rows.map((r) => r.userId)).toEqual([listable]);
    expect(first).toMatchObject({ isDone: true, partial: true, reasons: ['rows_missing'] });
    // The count says the same: the one it can list, and why it is short.
    expect(await lane(t, 'flagged')).toMatchObject({
      count: { count: 1, capped: true },
      reasons: ['rows_missing'],
    });
  });
});
