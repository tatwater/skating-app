/**
 * **A decision that closes many members of one item recounts it once** (B01-5, PR #170): a decision's
 * every closer — the sibling drain, a takedown's flags across lanes, a ruling's reports, an undo that
 * reopens them — runs as one Inbox batch, so an item at the member bound is decided within Convex's
 * per-transaction limits, and its counts come out exact.
 */

import { requestNameKeyFor } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { FLAG_CLOSE_COST, FLAG_REOPEN_COST, FLAGS_READ } from './lib/inboxFlags';
import {
  AXES,
  CLOSER_RESERVE,
  fileMember,
  flagSource,
  MAX_MEMBERS,
  MEMBER_BOUND,
  RECONCILE_COST,
  refreshCost,
  requestSource,
  type TxCost,
} from './lib/inboxItems';
import { inboxDrift } from './lib/inboxRepair';
import { OWN_FILING_REFUSAL } from './lib/inboxRules';
import { QUEUE_CAP, siblingCost } from './lib/requestDecisions';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

const PREFS = {
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
const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

async function people(t: T, n: number, prefix = 'p') {
  return t.run(async (ctx) => {
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert('profiles', {
          clerkUserId: `${prefix}${i}`,
          displayName: `${prefix}${i} Test-Person`,
          username: `${prefix}${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: 1,
        }),
      );
    }
    return ids;
  });
}

async function staff(t: T, subject: string, role: 'moderator' | 'admin' = 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: 1,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function lake(t: T, externalId = 'osm/A') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond',
        polygon: SQUARE,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('waterBodies').collect();
    return rows.find((b) => b.externalId === externalId)?._id as Id<'waterBodies'>;
  });
}

/**
 * Convex's per-transaction limits (docs: Limits → Transactions), held as a test seam: convex-test
 * enforces them only on a nested call given them, so every decision and drain page here runs as one.
 */
const CONVEX_LIMITS = {
  bytesRead: 16 * 1024 * 1024,
  documentsRead: 32_000,
  databaseQueries: 4_096,
  documentsWritten: 16_000,
};

/** A function run under {@link CONVEX_LIMITS}, as `subject` when given. */
async function limited(
  t: T,
  // biome-ignore lint/suspicious/noExplicitAny: any public or internal mutation reference
  fn: any,
  args: Record<string, unknown>,
  subject?: string,
): Promise<unknown> {
  const as = subject ? t.withIdentity({ subject }) : t;
  return as.run((ctx) =>
    (
      ctx as unknown as { runMutation: (f: unknown, a: unknown, o: unknown) => Promise<unknown> }
    ).runMutation(fn, args, { transactionLimits: LIMITS.now }),
  );
}

/** The limits every limited call runs under: Convex's, or a tighter set a test puts in force. */
const LIMITS = { now: CONVEX_LIMITS };

/** Run `body` with every limited call (the decision, each later page) under `limits`. */
async function under<R>(limits: Partial<typeof CONVEX_LIMITS>, body: () => Promise<R>): Promise<R> {
  LIMITS.now = { ...CONVEX_LIMITS, ...limits };
  try {
    return await body();
  } finally {
    LIMITS.now = CONVEX_LIMITS;
  }
}

/** Every scheduled drain page run to the end, by hand (each page schedules the next). */
async function drain(t: T) {
  const seen = new Set<string>();
  for (let pages = 0; pages < 400; pages++) {
    const next = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).find(
      (s) =>
        !seen.has(s._id) && (s.name.includes('closeSiblings') || s.name.includes('closeFlagsRest')),
    );
    if (!next) return pages;
    seen.add(next._id);
    await limited(
      t,
      next.name.includes('closeSiblings')
        ? internal.corpusRequests.closeSiblings
        : internal.inboxWrites.closeFlagsRest,
      next.args[0] as never,
    );
  }
  throw new Error('the drain did not end');
}

/** The stored Inbox: per item, its status, count, and its open and closed members. */
async function itemsNow(t: T) {
  return t.run(async (ctx) => {
    const items = await ctx.db.query('inboxItems').collect();
    const members = await ctx.db.query('inboxItemMembers').collect();
    const counts = await ctx.db.query('inboxCounts').collect();
    return {
      items: items.map((i) => ({
        key: i.key,
        status: i.status,
        memberCount: i.memberCount,
        open: members.filter((m) => m.itemId === i._id && m.status === 'open').length,
        closed: members.filter((m) => m.itemId === i._id && m.status === 'closed').length,
      })),
      members,
      counts: Object.fromEntries(counts.filter((c) => c.count !== 0).map((c) => [c.key, c.count])),
      drift: (await Promise.all(items.map(async (i) => (await inboxDrift(ctx, i)).length))).reduce(
        (a, b) => a + b,
        0,
      ),
    };
  });
}

/** `n` open bay asks for one bay on `lakeId`, each filed into the one item its question is. */
async function bayAsks(
  t: T,
  lakeId: Id<'waterBodies'>,
  askers: Id<'profiles'>[],
  opts: { name?: string; file?: (i: number) => boolean } = {},
) {
  const name = opts.name ?? 'North Bay';
  const ids: Id<'waterBodyRequests'>[] = [];
  for (let start = 0; start < askers.length; start += 50) {
    ids.push(
      ...(await t.run(async (ctx) => {
        const out: Id<'waterBodyRequests'>[] = [];
        for (let i = start; i < Math.min(start + 50, askers.length); i++) {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: askers[i] as Id<'profiles'>,
            coord: { lat: 0.5, lng: 0.5 },
            waterBodyId: lakeId,
            name,
            nameKey: requestNameKeyFor('name_bay', name),
            createdAt: NOW - 1000 + i,
          });
          if (opts.file?.(i) ?? true) await fileMember(ctx, requestSource(id));
          out.push(id);
        }
        return out;
      })),
    );
  }
  return ids;
}

/** `n` open flags on one target, from `flaggers[i]`, each filed into its lane's item. */
async function flagsOn(
  t: T,
  target: { targetType: Doc<'contentFlags'>['targetType']; targetId: string },
  flaggers: Id<'profiles'>[],
  reason: (i: number) => Doc<'contentFlags'>['reason'],
  subjectUserId?: Id<'profiles'>,
) {
  const ids: Id<'contentFlags'>[] = [];
  for (let start = 0; start < flaggers.length; start += 50) {
    ids.push(
      ...(await t.run(async (ctx) => {
        const out: Id<'contentFlags'>[] = [];
        for (let i = start; i < Math.min(start + 50, flaggers.length); i++) {
          const id = await ctx.db.insert('contentFlags', {
            flaggerId: flaggers[i] as Id<'profiles'>,
            ...target,
            reason: reason(i),
            status: 'open',
            origin: 'user',
            ...(subjectUserId ? { subjectUserId } : {}),
            createdAt: NOW - 1000 + i,
          });
          await fileMember(ctx, flagSource(id));
          out.push(id);
        }
        return out;
      })),
    );
  }
  return ids;
}

async function aReport(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: NOW - 3_600_000,
      reportTime: NOW - 3_600_000,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 3_600_000,
    }),
  );
}

// ── What a decision costs, per member — measured small, held to the real bound ─────────────────

/**
 * A call in a transaction of its own, and what it read (documents, index ranges). Run under limits
 * no decision reaches, so one transaction holds all of it: this measures cost, the tight-limit tests
 * below prove the paging.
 */
async function measured(
  t: T,
  // biome-ignore lint/suspicious/noExplicitAny: any public or internal mutation reference
  fn: any,
  args: Record<string, unknown>,
  subject: string,
): Promise<{ out: unknown; documentsRead: number; databaseQueries: number }> {
  return t.withIdentity({ subject }).run(async (ctx) => {
    const before = await ctx.meta.getTransactionMetrics();
    const out = await (
      ctx as unknown as { runMutation: (f: unknown, a: unknown, o: unknown) => Promise<unknown> }
    ).runMutation(fn, args, {
      transactionLimits: {
        bytesRead: 1 << 30,
        documentsRead: 10_000_000,
        databaseQueries: 1_000_000,
        documentsWritten: 1_000_000,
      },
    });
    const after = await ctx.meta.getTransactionMetrics();
    return {
      out,
      documentsRead: before.documentsRead.remaining - after.documentsRead.remaining,
      databaseQueries: before.databaseQueries.remaining - after.databaseQueries.remaining,
    };
  });
}

/** What each source past the first `small` cost, between two decisions of `small` and `large`. */
const marginal = (
  small: { documentsRead: number; databaseQueries: number },
  large: { documentsRead: number; databaseQueries: number },
  sources: number,
) => ({
  documentsRead: (large.documentsRead - small.documentsRead) / sources,
  databaseQueries: (large.databaseQueries - small.databaseQueries) / sources,
});

const SMALL = 10;
const LARGE = 30;

describe('a decision costs per member, not per member squared — measured small, held to the real bound', () => {
  test('arithmetic at the real bound: each closer fits a source and its refreshes; an undo of every flag fits; the shape before batching did not', () => {
    const fits = (cost: TxCost) => AXES.every((k) => cost[k] <= CONVEX_LIMITS[k]);
    const sum = (...costs: TxCost[]) =>
      Object.fromEntries(AXES.map((k) => [k, costs.reduce((n, c) => n + c[k], 0)])) as TxCost;
    const times = (cost: TxCost, n: number) =>
      Object.fromEntries(AXES.map((k) => [k, cost[k] * n])) as TxCost;
    const refresh = refreshCost(MAX_MEMBERS);
    // A fresh transaction always holds one source and its item's refresh at the real bound, so a
    // page always advances — for a bay or admit sibling, a landmark sibling, a flag.
    const bay = { kind: 'name_bay', name: 'North Bay' } as Doc<'waterBodyRequests'>;
    const place = { kind: 'name_landmark', name: 'Long Point' } as Doc<'waterBodyRequests'>;
    for (const perSource of [siblingCost(bay), siblingCost(place)]) {
      expect(fits(sum(perSource, RECONCILE_COST, refresh, CLOSER_RESERVE))).toBe(true);
    }
    expect(fits(sum(FLAG_CLOSE_COST, RECONCILE_COST, refresh, CLOSER_RESERVE))).toBe(true);
    // A whole sibling page of one item at the real bound, recounted once, fits on rows and ranges.
    const page = sum(times(sum(siblingCost(bay), RECONCILE_COST), QUEUE_CAP), refresh);
    expect(page.documentsRead).toBeLessThanOrEqual(CONVEX_LIMITS.documentsRead);
    expect(page.databaseQueries).toBeLessThanOrEqual(CONVEX_LIMITS.databaseQueries);
    // An undo reopens up to FLAGS_READ flags in one transaction (it isn't paged): they fit.
    const undo = sum(times(FLAG_REOPEN_COST, FLAGS_READ), refresh, CLOSER_RESERVE);
    expect(undo.documentsRead).toBeLessThanOrEqual(CONVEX_LIMITS.documentsRead);
    expect(undo.databaseQueries).toBeLessThanOrEqual(CONVEX_LIMITS.databaseQueries);
    // Why the batch: a recount per source, over a primary and one page of a 500-ask item.
    let recounts = 0;
    for (let k = 1; k <= QUEUE_CAP + 1; k++) recounts += MAX_MEMBERS - k;
    expect(recounts).toBeGreaterThan(CONVEX_LIMITS.documentsRead);
  });

  test('a decline’s drain: each further sibling costs no more than the drain budgets for it', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, LARGE);
    await staff(t, 'admin');
    const few = await bayAsks(t, lakeId, askers.slice(0, SMALL), { name: 'Cove' });
    const many = await bayAsks(t, lakeId, askers, { name: 'North Bay' });
    await settle();
    const decline = (requestId: Id<'waterBodyRequests'> | undefined) =>
      measured(t, api.corpusRequests.decline, { requestId, note: 'No' }, 'admin');
    const each = marginal(await decline(few[0]), await decline(many[0]), LARGE - SMALL);
    const row = await t.run((ctx) => ctx.db.get(many[1] as Id<'waterBodyRequests'>));
    const budget = sum2(siblingCost(row as Doc<'waterBodyRequests'>), RECONCILE_COST);
    expect(each.documentsRead).toBeLessThanOrEqual(budget.documentsRead);
    expect(each.databaseQueries).toBeLessThanOrEqual(budget.databaseQueries);
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.memberCount, i.closed]).sort()).toEqual([
      ['decided', SMALL, SMALL],
      ['decided', LARGE, LARGE],
    ]);
    expect(after.drift).toBe(0);
  });

  test('a ruling and its undo: each further report costs no more than the closer and the reopen budget', async () => {
    const t = harness();
    const first = await lake(t, 'osm/A');
    const second = await lake(t, 'osm/B');
    const flaggers = await people(t, LARGE);
    await staff(t, 'admin');
    await flagsOn(
      t,
      { targetType: 'waterbody', targetId: first },
      flaggers.slice(0, SMALL),
      () => 'no_public_access',
    );
    await flagsOn(
      t,
      { targetType: 'waterbody', targetId: second },
      flaggers,
      () => 'no_public_access',
    );
    const itemOn = (body: Id<'waterBodies'>) =>
      t.run(
        async (ctx) =>
          (await ctx.db.query('inboxItems').collect()).find((i) => i.waterBodyId === body)?._id,
      );
    const rule = async (body: Id<'waterBodies'>) =>
      measured(
        t,
        api.inboxWrites.ruleAccess,
        { itemId: await itemOn(body), verdict: 'none', reason: 'Posted' },
        'admin',
      );
    const ruledFew = await rule(first);
    const ruledMany = await rule(second);
    const closing = marginal(ruledFew, ruledMany, LARGE - SMALL);
    const closeBudget = sum2(FLAG_CLOSE_COST, RECONCILE_COST);
    expect(closing.documentsRead).toBeLessThanOrEqual(closeBudget.documentsRead);
    expect(closing.databaseQueries).toBeLessThanOrEqual(closeBudget.databaseQueries);
    const undo = (r: { out: unknown }) =>
      measured(
        t,
        api.undo.run,
        { actionId: (r.out as { actionId: string }).actionId, reason: 'Undone' },
        'admin',
      );
    const reopening = marginal(await undo(ruledFew), await undo(ruledMany), LARGE - SMALL);
    expect(reopening.documentsRead).toBeLessThanOrEqual(FLAG_REOPEN_COST.documentsRead);
    expect(reopening.databaseQueries).toBeLessThanOrEqual(FLAG_REOPEN_COST.databaseQueries);
    const back = await itemsNow(t);
    expect(back.items.map((i) => [i.status, i.open]).sort()).toEqual([
      ['open', SMALL],
      ['open', LARGE],
    ]);
    expect(back.drift).toBe(0);
  });

  test('a takedown of a report: each further flag costs no more than the closer budgets — its hold moved once', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, LARGE);
    await staff(t, 'admin');
    const reports = [
      await aReport(t, author as Id<'profiles'>, lakeId),
      await aReport(t, author as Id<'profiles'>, lakeId),
    ];
    await flagsOn(
      t,
      { targetType: 'report', targetId: reports[0] as string },
      flaggers.slice(0, SMALL),
      () => 'spam',
      author,
    );
    await flagsOn(
      t,
      { targetType: 'report', targetId: reports[1] as string },
      flaggers,
      () => 'spam',
      author,
    );
    const takeDown = async (n: number) => {
      const itemId = await t.run(
        async (ctx) =>
          (await ctx.db.query('inboxItems').collect()).find((i) => i.memberCount === n)?._id,
      );
      return measured(
        t,
        api.inboxWrites.takeDown,
        { itemId, status: 'hidden', reason: 'Fabricated' },
        'admin',
      );
    };
    const each = marginal(await takeDown(SMALL), await takeDown(LARGE), LARGE - SMALL);
    const budget = sum2(FLAG_CLOSE_COST, RECONCILE_COST);
    expect(each.documentsRead).toBeLessThanOrEqual(budget.documentsRead);
    expect(each.databaseQueries).toBeLessThanOrEqual(budget.databaseQueries);
    expect((await itemsNow(t)).items.map((i) => [i.status, i.closed]).sort()).toEqual([
      ['decided', SMALL],
      ['decided', LARGE],
    ]);
  });
});

const sum2 = (a: TxCost, b: TxCost): TxCost =>
  Object.fromEntries(AXES.map((k) => [k, a[k] + b[k]])) as TxCost;

// ── Decide, then undo, whether or not the backfill had filed the sources ─────────────────────────

type Filing = 'none' | 'some' | 'all';

/** Raw open sources, filed by the state: `none` files only what the write needs to name its item. */
async function rawFlags(
  t: T,
  target: { targetType: Doc<'contentFlags'>['targetType']; targetId: string },
  flaggers: Id<'profiles'>[],
  reasons: Doc<'contentFlags'>['reason'][],
  filed: (i: number) => boolean,
  subjectUserId?: Id<'profiles'>,
) {
  return t.run(async (ctx) => {
    const ids: Id<'contentFlags'>[] = [];
    for (const [i, reason] of reasons.entries()) {
      const id = await ctx.db.insert('contentFlags', {
        flaggerId: flaggers[i] as Id<'profiles'>,
        ...target,
        reason,
        status: 'open',
        origin: 'user',
        ...(subjectUserId ? { subjectUserId } : {}),
        createdAt: NOW - 1000 + i,
      });
      if (filed(i)) await fileMember(ctx, flagSource(id));
      ids.push(id);
    }
    return ids;
  });
}

const filedBy = (state: Filing, need: number[]) => (i: number) =>
  need.includes(i) || state === 'all' || (state === 'some' && i % 2 === 1);

/** The audit row a write left on `targetId` with `action`, newest first. */
async function rowOn(t: T, targetId: string, action: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query('moderationActions')
      .withIndex('by_target')
      .order('desc')
      .collect();
    return rows.find((r) => r.targetId === targetId && r.action === action)
      ?._id as Id<'moderationActions'>;
  });
}

/**
 * After the undo: every source the decision closed is open again with one open member, no key has two
 * open items, every item is what its members say, and the counts are their sum.
 */
async function expectBack(t: T, sources: { table: string; id: string }[]) {
  const now = await itemsNow(t);
  const rows = await t.run(async (ctx) =>
    Promise.all(sources.map((s) => ctx.db.get(s.id as Id<'contentFlags'>))),
  );
  for (const row of rows) {
    const r = row as { status?: string; reviewStatus?: string } | null;
    expect(r?.reviewStatus ?? r?.status).toMatch(/^(open|pending)$/);
  }
  for (const s of sources) {
    const mine = now.members.filter((m) => m.sourceId === s.id);
    expect(
      mine.map((m) => m.status),
      `${s.table} ${s.id}`,
    ).toEqual(['open']);
  }
  const openKeys = now.items.filter((i) => i.status === 'open').map((i) => i.key);
  expect(new Set(openKeys).size).toBe(openKeys.length);
  expect(now.items.filter((i) => i.status === 'decided' && i.closed > 0)).toEqual([]);
  expect(now.drift).toBe(0);
}

const STATES: Filing[] = ['none', 'some', 'all'];

/**
 * A moment for the wall clock to pass the rows just written: convex-test hands out `_creationTime`
 * ahead of it under a burst of inserts, and a decision drains only the asks that existed by its `now`.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('a decision records every source it closes, filed or not; its undo puts each back', () => {
  test.each(STATES)('a decline and its sibling drain — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, 4);
    await staff(t, 'admin');
    const asks = await bayAsks(t, lakeId, askers, { file: filedBy(state, []) });
    await settle();
    await limited(t, api.corpusRequests.decline, { requestId: asks[0], note: 'no' }, 'admin');
    await drain(t);
    const decided = await itemsNow(t);
    expect(decided.members.filter((m) => m.status === 'closed')).toHaveLength(4);
    const row = await rowOn(t, asks[0] as string, 'decline_request');
    await limited(t, api.undo.run, { actionId: row, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      asks.map((id) => ({ table: 'waterBodyRequests', id })),
    );
  });

  test.each(STATES)('a takedown across two lanes — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 4);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await rawFlags(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      ['spam', 'spam', 'unsafe_false_report', 'unsafe_false_report'],
      filedBy(state, [0]),
      author,
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const done = (await limited(
      t,
      api.inboxWrites.takeDown,
      { itemId, status: 'hidden', reason: 'Fabricated' },
      'admin',
    )) as { actionId: Id<'moderationActions'> };
    await drain(t);
    expect((await itemsNow(t)).members.filter((m) => m.status === 'closed')).toHaveLength(4);
    await limited(t, api.undo.run, { actionId: done.actionId, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      flags.map((id) => ({ table: 'contentFlags', id })),
    );
  });

  test.each(STATES)('a ruling on a body’s access reports — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const flaggers = await people(t, 4);
    await staff(t, 'admin');
    const flags = await rawFlags(
      t,
      { targetType: 'waterbody', targetId: lakeId },
      flaggers,
      ['no_public_access', 'no_public_access', 'no_public_access', 'no_public_access'],
      filedBy(state, [0]),
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const ruled = (await limited(
      t,
      api.inboxWrites.ruleAccess,
      { itemId, verdict: 'none', reason: 'Posted' },
      'admin',
    )) as { actionId: Id<'moderationActions'> };
    await drain(t);
    expect((await itemsNow(t)).members.filter((m) => m.status === 'closed')).toHaveLength(4);
    await limited(t, api.undo.run, { actionId: ruled.actionId, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      flags.map((id) => ({ table: 'contentFlags', id })),
    );
  });

  test.each(STATES)('a dismissal of an item’s flags — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 3);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await rawFlags(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      ['spam', 'spam', 'spam'],
      filedBy(state, [0]),
      author,
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const done = (await limited(t, api.inboxWrites.dismissFlags, { itemId }, 'admin')) as {
      actionId: Id<'moderationActions'>;
    };
    await drain(t);
    // A dismissal closes this item's flags: those filed into it (the rest wait for the backfill).
    const closed = (await itemsNow(t)).members.filter((m) => m.status === 'closed');
    await limited(t, api.undo.run, { actionId: done.actionId, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      closed.map((m) => ({ table: 'contentFlags', id: m.sourceId })),
    );
    void flags;
  });

  test.each(['none', 'all'] as const)('a single flag’s resolution — filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 1);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const [flag] = await rawFlags(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      ['spam'],
      () => state === 'all',
      author,
    );
    await limited(
      t,
      api.moderation.resolveFlag,
      { flagId: flag, resolution: 'dismissed', reason: 'fine' },
      'admin',
    );
    const row = await rowOn(t, flag as string, 'dismiss_flag');
    await limited(t, api.undo.run, { actionId: row, reason: 'Undone' }, 'admin');
    await expectBack(t, [{ table: 'contentFlags', id: flag as string }]);
  });

  test.each(['none', 'all'] as const)('a drawn body’s approval — filed: %s', async (state) => {
    const t = harness();
    const [drawer] = await people(t, 1, 'drawer');
    await staff(t, 'admin');
    const body = await t.run(async (ctx) => {
      const id = (await ctx.db.insert('waterBodies', {
        name: 'Drawn',
        searchText: 'Drawn',
        type: 'lakePond',
        source: 'user',
        dedupStatus: 'clean',
        reviewStatus: 'pending',
        createdByUserId: drawer,
        polygon: SQUARE,
        centroid: { lat: 0.5, lng: 0.5 },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        createdAt: NOW - 1000,
      } as never)) as Id<'waterBodies'>;
      if (state === 'all') {
        const { bodySource } = await import('./lib/inboxItems');
        await fileMember(ctx, bodySource(id));
      }
      return id;
    });
    await limited(t, api.waterBodies.approve, { waterBodyId: body }, 'admin');
    const row = await rowOn(t, body as string, 'approve_waterbody');
    await limited(t, api.undo.run, { actionId: row, reason: 'Undone' }, 'admin');
    await expectBack(t, [{ table: 'waterBodies', id: body as string }]);
  });
});

/**
 * The seams in force together: a member bound of 60 (a refresh's cost in proportion) and Convex's
 * document limit cut in the same proportion, so a page runs out of room before its siblings or flags
 * do — more than one page, the room check deciding each.
 */
const TIGHT_BOUND = 60;
const TIGHT = { documentsRead: 700 };
async function atBound<R>(body: () => Promise<R>): Promise<R> {
  MEMBER_BOUND.members = TIGHT_BOUND;
  try {
    return await body();
  } finally {
    MEMBER_BOUND.members = MAX_MEMBERS;
  }
}

describe('a closer sized by the transaction it is in (the limits as a seam)', () => {
  test('a tight transaction cuts the drain into more pages, and it still closes every ask exactly', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, 60);
    await staff(t, 'admin');
    const asks = await bayAsks(t, lakeId, askers);
    await settle();
    const pages = await atBound(() =>
      under(TIGHT, async () => {
        await limited(t, api.corpusRequests.decline, { requestId: asks[0], note: 'no' }, 'admin');
        return drain(t);
      }),
    );
    // More than one page — and few: each item recounted once a page, not once a sibling (a recount per
    // sibling spends a page's room on recounts, five pages here where batched pages take two).
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThanOrEqual(3);
    const after = await itemsNow(t);
    expect(after.items).toEqual([
      expect.objectContaining({ status: 'decided', memberCount: 60, closed: 60 }),
    ]);
    expect(after.counts).toEqual({ decided: 1 });
    expect(after.drift).toBe(0);
  });

  test('a tight transaction pages a takedown’s flags, and every one closes under its row', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 60);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    await flagsOn(t, { targetType: 'report', targetId: reportId }, flaggers, () => 'spam', author);
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const pages = await atBound(() =>
      under(TIGHT, async () => {
        await limited(
          t,
          api.inboxWrites.takeDown,
          { itemId, status: 'hidden', reason: 'Fabricated' },
          'admin',
        );
        return drain(t);
      }),
    );
    expect(pages).toBeGreaterThan(0);
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.memberCount, i.closed])).toEqual([
      ['decided', 60, 60],
    ]);
    expect(after.drift).toBe(0);
    const stamped = await t.run(async (ctx) =>
      (await ctx.db.query('inboxItemMembers').collect()).map((m) => m.closedByActionId),
    );
    expect(new Set(stamped).size).toBe(1);
  });

  test('a takedown undone while its later pages wait: they stop, and nothing closes after the undo', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 60);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await flagsOn(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      () => 'spam',
      author,
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    await atBound(() =>
      under(TIGHT, async () => {
        const done = (await limited(
          t,
          api.inboxWrites.takeDown,
          { itemId, status: 'hidden', reason: 'Fabricated' },
          'admin',
        )) as { actionId: Id<'moderationActions'> };
        // Some flags are still open: the undo lands before their page runs.
        await limited(t, api.undo.run, { actionId: done.actionId, reason: 'Undone' }, 'admin');
        await drain(t);
      }),
    );
    const statuses = await t.run(async (ctx) =>
      Promise.all(flags.map(async (id) => (await ctx.db.get(id))?.status)),
    );
    expect(new Set(statuses)).toEqual(new Set(['open']));
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.open])).toEqual([['open', 60]]);
    expect(after.drift).toBe(0);
  });
});

// ── D289 over every source a decision closes ───────────────────────────────────────────────────

/** "Northwest Bay", drawn with the alias "NW Bay", on `lakeId`. */
async function aliasedBayOn(t: T, lakeId: Id<'waterBodies'>, by: Id<'profiles'>) {
  await t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId: lakeId,
      name: 'Northwest Bay',
      aliases: ['NW Bay'],
      searchText: 'Northwest Bay NW Bay',
      polygon: SQUARE,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      surfaceAreaSqM: 40_000,
      displayScore: 1,
      minVisibleZoom: 10,
      createdByUserId: by,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

const statusesOf = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('waterBodyRequests').collect()).map((r) => [r.name, r.status]),
  );

describe('no staffer decides an ask they filed, in any item the decision reaches (D289)', () => {
  test('an approval whose bay’s alias reaches the approver’s own ask in another item is refused whole', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [skater] = await people(t, 1, 'skater');
    const mod = await staff(t, 'mod', 'moderator');
    const other = await staff(t, 'other', 'moderator');
    await aliasedBayOn(t, lakeId, other.id);
    const at = { kind: 'name_bay' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: lakeId };
    const theirs = await t
      .withIdentity({ subject: 'skater0' })
      .mutation(api.corpusRequests.create, { ...at, name: 'Northwest Bay' });
    await mod.as.mutation(api.corpusRequests.create, { ...at, name: 'NW Bay' });
    await settle();
    // Two keys, two items: the moderator's ask isn't a member of the one they'd approve.
    expect((await itemsNow(t)).items).toHaveLength(2);
    // The drawer says so before the write does — and the decline (its own key only) is theirs to make.
    const view = await mod.as.query(api.inbox.item, { ref: `request:${theirs}` });
    expect(view.item?.can.approve).toBe(OWN_FILING_REFUSAL);
    expect(view.item?.can.decline).toBeNull();
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: theirs }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    expect(await statusesOf(t)).toEqual([
      ['Northwest Bay', 'open'],
      ['NW Bay', 'open'],
    ]);
    // A colleague's approval closes both, as one answer.
    await other.as.mutation(api.corpusRequests.approve, { requestId: theirs });
    expect(await statusesOf(t)).toEqual([
      ['Northwest Bay', 'approved'],
      ['NW Bay', 'approved'],
    ]);
    void skater;
  });

  test('a script’s ask is exempt alone: its app-filed sibling by the approver refuses the approval', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const mod = await staff(t, 'mod', 'moderator');
    const other = await staff(t, 'other', 'moderator');
    await aliasedBayOn(t, lakeId, other.id);
    const seeded = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        origin: 'seed',
        requesterId: other.id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: lakeId,
        name: 'Northwest Bay',
        nameKey: requestNameKeyFor('name_bay', 'Northwest Bay'),
        createdAt: NOW - 1000,
      }),
    );
    await mod.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: { lat: 0.5, lng: 0.5 },
      waterBodyId: lakeId,
      name: 'NW Bay',
    });
    await settle();
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: seeded }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    // The seed's own staff requester still decides it when no app-filed sibling is theirs.
    await other.as.mutation(api.corpusRequests.approve, { requestId: seeded });
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['approved', 'approved']);
  });

  test('an own ask the backfill hasn’t filed yet is seen by the write’s own scan', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, 1);
    const mod = await staff(t, 'mod', 'moderator');
    const [theirs] = await bayAsks(t, lakeId, askers);
    // The moderator's ask for the same bay, written raw: no member, so no item knows it is theirs.
    await bayAsks(t, lakeId, [mod.id], { file: () => false });
    await settle();
    await expect(
      mod.as.mutation(api.corpusRequests.decline, {
        requestId: theirs as Id<'waterBodyRequests'>,
        note: 'No',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['open', 'open']);
  });

  test('the undo of an approval that closed the undoer’s own ask in another item: neither offered nor run', async () => {
    const t = harness();
    const lakeId = await lake(t);
    await people(t, 1, 'skater');
    const sib = await staff(t, 'sib', 'moderator');
    const actor = await staff(t, 'actor', 'moderator');
    await aliasedBayOn(t, lakeId, actor.id);
    const at = { kind: 'name_bay' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: lakeId };
    const theirs = await t
      .withIdentity({ subject: 'skater0' })
      .mutation(api.corpusRequests.create, { ...at, name: 'Northwest Bay' });
    await sib.as.mutation(api.corpusRequests.create, { ...at, name: 'NW Bay' });
    await settle();
    await actor.as.mutation(api.corpusRequests.approve, { requestId: theirs });
    const row = await rowOn(t, theirs as string, 'approve_request');
    const offer = await t.run(async (ctx) => {
      const { undoState } = await import('./lib/undo');
      const viewer = (await ctx.db.get(sib.id)) as Doc<'profiles'>;
      return undoState(ctx, viewer, (await ctx.db.get(row)) as Doc<'moderationActions'>, 'one');
    });
    expect(offer.state).not.toBe('available');
    await expect(
      sib.as.mutation(api.undo.run, { actionId: row, reason: 'Undone' }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    // The approver undoes it: both reopen.
    await actor.as.mutation(api.undo.run, { actionId: row, reason: 'Undone' });
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['open', 'open']);
  });

  test('a landmark’s approval reaching the approver’s ask by an alias, in another item, is refused', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const mod = await staff(t, 'mod', 'moderator');
    const other = await staff(t, 'other', 'moderator');
    await people(t, 1, 'skater');
    await t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId: lakeId,
        name: 'Long Point',
        kind: 'point',
        point: { lat: 0.5, lng: 0.5 },
        source: 'moderator',
        externalIds: [],
        aliases: ['Gull Point'],
        createdAt: NOW,
        updatedAt: NOW,
      } as never),
    );
    const [skater] = await t.run(async (ctx) =>
      (await ctx.db.query('profiles').collect()).filter((p) => p.clerkUserId === 'skater0'),
    );
    // Landmark asks are filed from reports (`fileLandmarkProposals`); written here as it writes them.
    const landmarkAsk = (requesterId: Id<'profiles'>, name: string) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert('waterBodyRequests', {
          kind: 'name_landmark',
          status: 'open',
          requesterId,
          coord: { lat: 0.5, lng: 0.5 },
          waterBodyId: lakeId,
          name,
          nameKey: requestNameKeyFor('name_landmark', name),
          createdAt: NOW - 1000,
        });
        await fileMember(ctx, requestSource(id));
        return id;
      });
    const theirs = await landmarkAsk(skater?._id as Id<'profiles'>, 'Long Point');
    await landmarkAsk(mod.id, 'Gull Point');
    await settle();
    expect((await itemsNow(t)).items).toHaveLength(2);
    // The drawer draws the approval as the moderator's own to leave; the decline reaches only its place.
    const view = await mod.as.query(api.inbox.item, { ref: `request:${theirs}` });
    expect(view.item?.can.approve).toBe(OWN_FILING_REFUSAL);
    expect(view.item?.can.decline).toBeNull();
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: theirs }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    await other.as.mutation(api.corpusRequests.approve, { requestId: theirs });
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['approved', 'approved']);
  });
});

// ── An Access item's newest words ─────────────────────────────────────────────────────────────

describe('an Access item shows its newest reports', () => {
  test('the row’s note is the newest report’s, past the oldest five; the drawer lists from the newest end', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const flaggers = await people(t, 60);
    const admin = await staff(t, 'admin');
    await t.run(async (ctx) => {
      for (const [i, flaggerId] of flaggers.entries()) {
        const id = await ctx.db.insert('contentFlags', {
          flaggerId,
          targetType: 'waterbody',
          targetId: lakeId,
          reason: 'no_public_access',
          status: 'open',
          origin: 'user',
          // The newest says the gate is locked now; the oldest note is long out of date; the newest
          // but one says nothing, so the note is the newest that says something.
          ...(i === 58 ? { note: 'Gate locked since Friday' } : {}),
          ...(i === 4 ? { note: 'Open through the farm road' } : {}),
          createdAt: NOW - 100_000 + i * 1000,
        });
        await fileMember(ctx, flagSource(id));
      }
    });
    const page = await admin.as.query(api.inbox.listPage, { lane: 'accessReports' });
    const row = page.rows[0];
    if (row?.kind !== 'access') throw new Error('no access row');
    expect(row.latestNote).toBe('Gate locked since Friday');
    const view = await admin.as.query(api.inbox.item, { ref: row.itemId });
    if (view.item?.kind !== 'access') throw new Error('no access item');
    // Newest first, and the newest is there though the item holds more than the drawer reads.
    expect(view.item.reports[0]?.note).toBeNull();
    expect(view.item.reports.map((r) => r.note)).toContain('Gate locked since Friday');
    expect(view.item.reports).toHaveLength(50);
  });
});
