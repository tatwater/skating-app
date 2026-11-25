/**
 * **The Corpus tasks' reads** (B01-6a, `corpusTasks.ts`): the lanes' exact counts, a lane's page
 * (each tab, the decided tab, the `endCursor` chain, the search and its bound) and one task's item
 * (by every ref, each lane's facts present and not recorded), on tasks filed through the real
 * writer (`lib/corpusTasks.ts`).
 *
 * `can` is S2's rule (`lib/corpusRules.ts`), and every case reads the real one but one: the case for
 * a body merged away or removed since its decision stands it in by a marker, because the real rule
 * answers a decided task by its lock before it looks at the body, and that case proves which body
 * the read hands it. The cases at the end check `can` against the real rule on every row and item.
 */

import { SQM_PER_ACRE } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { NO_SUCH_TAB, SEARCH_SCAN } from './corpusTasks';
import { DELETION_PENDING_MESSAGE } from './lib/auth';
import * as rules from './lib/corpusRules';
import { settleReason, syncBodyTasks, TASK_LEFT } from './lib/corpusTasks';
import { ATTACHED_CAP, NAMESAKES_CAP } from './lib/corpusTaskViews';
import schema from './schema';

const real = vi.hoisted(() => ({ corpusCan: null as unknown }));
vi.mock('./lib/corpusRules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/corpusRules')>();
  real.corpusCan = actual.corpusCan;
  return { ...actual, corpusCan: vi.fn(actual.corpusCan) };
});

/**
 * A marker in the rule's place, naming the task and the body's state, so a case can see which task
 * and body the read asked the rule about.
 */
const useMarker = () =>
  vi.mocked(rules.corpusCan).mockImplementation(async (_ctx, _viewer, task, body) => ({
    pickName: `asked about ${task._id} on ${body?.removedAt ? 'removed' : (body?.mergedIntoId ?? 'live')}`,
  }));

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.UTC(2026, 10, 24, 12);
const ac = (acres: number) => acres * SQM_PER_ACRE;

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72, 44],
      [-72, 44.01],
      [-71.99, 44.01],
      [-71.99, 44],
      [-72, 44],
    ],
  ],
};

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
  moderatorDecision: false,
};

async function person(t: T, name: string, role: 'member' | 'moderator' | 'admin' = 'moderator') {
  const subject = `clerk_${name.replace(/\W/g, '')}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: name,
      username: name.toLowerCase().replace(/\W/g, ''),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const NAME_CLAIMS = [
  { source: 'nhd' as const, value: 'The Basin', sources: ['nhd' as const, '3dhp' as const] },
  { source: 'osm' as const, value: 'Lake Auburn' },
];

/** A body with an intake reason, its library row, and its tasks filed by the real writer. */
async function lake(
  t: T,
  extra: Partial<Doc<'waterBodies'>> = {},
  opts: { library?: boolean; at?: number } = {},
): Promise<Id<'waterBodies'>> {
  return t.run(async (ctx) => {
    const fields = {
      name: 'The Basin',
      searchText: 'The Basin Lake Auburn',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: SQUARE,
      bbox: { minLat: 44, minLng: -72, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44.005, lng: -71.995 },
      surfaceAreaSqM: ac(2263),
      dedupStatus: 'clean' as const,
      createdAt: NOW,
      displayScore: 0.6,
      states: ['ME'],
      nameClaims: NAME_CLAIMS,
      reviewReasons: ['name-conflict' as const],
      reviewReason: 'name-conflict' as const,
      ...extra,
    };
    const id = await ctx.db.insert('waterBodies', fields);
    if (opts.library !== false) await libraryRow(ctx, id, fields.name, fields.osmId);
    await syncBodyTasks(ctx, id, { now: opts.at ?? NOW });
    return id;
  });
}

type Ctx = Parameters<Parameters<T['run']>[0]>[0];

async function libraryRow(ctx: Ctx, waterBodyId: Id<'waterBodies'>, name: string, osmId?: string) {
  await ctx.db.insert('bodyLibraryRows', {
    waterBodyId,
    scope: '*',
    lane: 'active',
    standing: 'active',
    name,
    nameKey: name.trim().toLocaleLowerCase('en-US'),
    aliases: [],
    searchText: [name, waterBodyId, osmId ?? ''].join('\n'),
    bodyClass: 'lakePond',
    classKey: 'lake or pond',
    states: ['ME'],
    statesKey: 'ME',
    areaAsc: 1,
    areaDesc: 1,
    outline: 'catalog',
    hasPutIns: false,
    completeHave: 0,
    completeOf: 8,
    missing: [],
    complete: 'under-8',
    asks: 0,
    asksCapped: false,
    asksWaiting: false,
    reports: 0,
    reportsCapped: false,
    reportsSeason: 2026,
    everReported: false,
    curated: false,
    intake: true,
    awaitingEnrichment: false,
    changedAsc: 1,
    changedDesc: -1,
    refreshedAt: NOW,
  });
}

const tasksOf = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('corpusTasks')
      .withIndex('by_body_status', (q) => q.eq('waterBodyId', id))
      .collect(),
  );

async function taskOf(t: T, id: Id<'waterBodies'>, status: Doc<'corpusTasks'>['status'] = 'open') {
  const task = (await tasksOf(t, id)).find((x) => x.status === status);
  if (!task) throw new Error(`no ${status} task`);
  return task;
}

/** Settle the body's open task in `lane` through the real writer, as `by` at `at`. */
async function decide(
  t: T,
  id: Id<'waterBodies'>,
  by: Id<'profiles'>,
  at: number,
  lane: Doc<'corpusTasks'>['lane'] = 'nameConflicts',
) {
  const task = (await tasksOf(t, id)).find((x) => x.status === 'open' && x.lane === lane);
  if (!task) throw new Error('no open task to decide');
  return t.run(async (ctx) => {
    const actionId = await ctx.db.insert('moderationActions', {
      actorId: by,
      action: 'settle_review_reason',
      targetType: 'waterbody',
      targetId: id,
      reason: 'Settled from its lane.',
      createdAt: at,
    });
    await settleReason(ctx, { task, decision: 'kept', actionId, actorId: by }, { now: at });
    return { taskId: task._id, actionId };
  });
}

const backfillDone = (t: T) =>
  t.run((ctx) =>
    ctx.db.insert('corpusTaskJobRuns', {
      job: 'backfill',
      phase: 'done',
      cursor: null,
      done: true,
      startedAt: NOW,
      updatedAt: NOW,
    }),
  );

/** Every lane read answered at once, for a before-and-after comparison. */
async function everything(as: Awaited<ReturnType<typeof person>>['as'], ids: Id<'waterBodies'>[]) {
  const out: unknown[] = [await as.query(api.corpusTasks.lanes, { now: NOW })];
  for (const lane of ['nameConflicts', 'classConflicts'] as const) {
    out.push(await as.query(api.corpusTasks.listPage, { lane, now: NOW }));
    out.push(await as.query(api.corpusTasks.listPage, { lane, tab: 'decided', now: NOW }));
    for (const id of ids)
      out.push(await as.query(api.corpusTasks.item, { ref: `body:${id}`, lane }));
  }
  return out;
}

beforeEach(() => {
  vi.mocked(rules.corpusCan)
    .mockReset()
    .mockImplementation(real.corpusCan as typeof rules.corpusCan);
});

// ── The gate ──────────────────────────────────────────────────────────────────────────────────────────

test('every read is gated corpus.read: a member is refused, a moderator reads', async () => {
  const t = harness();
  const member = await person(t, 'Member Example', 'member');
  const mod = await person(t, 'Casey Example');
  await expect(member.as.query(api.corpusTasks.lanes, { now: NOW })).rejects.toThrow();
  await expect(
    member.as.query(api.corpusTasks.listPage, { lane: 'nameConflicts', now: NOW }),
  ).rejects.toThrow();
  await expect(member.as.query(api.corpusTasks.item, { ref: 'x', now: NOW })).rejects.toThrow();
  await expect(t.query(api.corpusTasks.lanes, { now: NOW })).rejects.toThrow();
  expect((await mod.as.query(api.corpusTasks.lanes, { now: NOW })).pending).toBe(true);
});

// ── lanes ──────────────────────────────────────────────────────────────────────────────────────────────

describe('lanes', () => {
  test('counts exactly past fifty, per lane and per tab, and says pending until the backfill is done', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    // 55 name conflicts, 'The Basin' / 'Lake Auburn' (different); 3 one letter apart.
    for (let i = 0; i < 55; i++) await lake(t, {}, { library: false });
    for (let i = 0; i < 3; i++) {
      await lake(
        t,
        {
          name: 'Tuttle Pond',
          nameClaims: [
            { source: 'nhd', value: 'Tuttle Pond' },
            { source: 'osm', value: 'Turtle Pond' },
          ],
        },
        { library: false },
      );
    }
    // Class conflicts: 2 with claims (wetland and lake), 1 imported before its claims.
    const cls = {
      reviewReasons: ['class-conflict' as const],
      reviewReason: 'class-conflict' as const,
    };
    const claims = [
      { source: 'nhd' as const, value: 'wetland' as const },
      { source: 'osm' as const, value: 'lakePond' as const },
    ];
    await lake(t, { ...cls, classClaims: claims }, { library: false });
    await lake(t, { ...cls, classClaims: claims }, { library: false });
    await lake(t, cls, { library: false });

    const read = await mod.as.query(api.corpusTasks.lanes, { now: NOW });
    expect(read).toEqual({
      lanes: {
        nameConflicts: { open: 58, facets: { different: 55, oneLetter: 3, qualifier: 0 } },
        // `notRecorded` reads under All only: counted in `open`, never as a tab.
        classConflicts: { open: 3, facets: { wetlandOrLake: 2, otherPairs: 0 } },
      },
      pending: true,
    });
    await backfillDone(t);
    expect((await mod.as.query(api.corpusTasks.lanes, { now: NOW })).pending).toBe(false);

    // A decision moves the counts at once.
    const one = (await t.run((ctx) => ctx.db.query('waterBodies').first()))
      ?._id as Id<'waterBodies'>;
    await decide(t, one, mod.id, NOW + 1);
    expect((await mod.as.query(api.corpusTasks.lanes, { now: NOW })).lanes.nameConflicts.open).toBe(
      57,
    );
  });
});

describe('pending', () => {
  test('stays true while a backfill failure is owed, on every read, though the backfill run is done', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const id = await lake(t);
    await backfillDone(t);
    const pendings = async () => [
      (await mod.as.query(api.corpusTasks.lanes, { now: NOW })).pending,
      (await mod.as.query(api.corpusTasks.listPage, { lane: 'nameConflicts', now: NOW })).pending,
      (await mod.as.query(api.corpusTasks.item, { ref: `body:${id}`, now: NOW })).pending,
    ];
    expect(await pendings()).toEqual([false, false, false]);
    const failure = await t.run((ctx) =>
      ctx.db.insert('jobFailures', {
        job: 'corpusTaskBackfill',
        key: id,
        attempts: 3,
        errorClass: 'Error',
        firstFailedAt: NOW,
        lastFailedAt: NOW,
        parkedAt: NOW,
      }),
    );
    expect(await pendings()).toEqual([true, true, true]);
    await t.run((ctx) => ctx.db.delete(failure));
    expect(await pendings()).toEqual([false, false, false]);
  });
});

// ── listPage ───────────────────────────────────────────────────────────────────────────────────────────

describe('listPage', () => {
  test('ranks by prominence, pins a page to its endCursor, and a decision on page one moves nothing on page two', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(await lake(t, { name: `Pond ${i}`, displayScore: 1 - i / 10 }));
    const args = { lane: 'nameConflicts' as const, pageSize: 2, now: NOW };
    const one = await mod.as.query(api.corpusTasks.listPage, args);
    expect(one.rows.map((r) => r.body.name)).toEqual(['Pond 0', 'Pond 1']);
    expect(one.isDone).toBe(false);
    const two = await mod.as.query(api.corpusTasks.listPage, {
      ...args,
      cursor: one.continueCursor,
    });
    expect(two.rows.map((r) => r.body.name)).toEqual(['Pond 2', 'Pond 3']);

    await decide(t, ids[0] as Id<'waterBodies'>, mod.id, NOW + 1);
    const again = await mod.as.query(api.corpusTasks.listPage, {
      ...args,
      cursor: one.continueCursor,
      endCursor: two.continueCursor,
    });
    expect(again.rows.map((r) => r.body.name)).toEqual(['Pond 2', 'Pond 3']);
    // Page one, read fresh, has lost its decided row.
    const fresh = await mod.as.query(api.corpusTasks.listPage, args);
    expect(fresh.rows.map((r) => r.body.name)).toEqual(['Pond 1', 'Pond 2']);

    // A decision inside page two shrinks it in place: the pinned page never pulls Pond 4 up.
    await decide(t, ids[2] as Id<'waterBodies'>, mod.id, NOW + 2);
    const pinned = await mod.as.query(api.corpusTasks.listPage, {
      ...args,
      cursor: one.continueCursor,
      endCursor: two.continueCursor,
    });
    expect(pinned.rows.map((r) => r.body.name)).toEqual(['Pond 3']);
    expect(pinned.continueCursor).toBe(two.continueCursor);
  });

  test('each tab: All holds every open task (notRecorded too), a facet its own, notRecorded is no tab', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const cls = {
      reviewReasons: ['class-conflict' as const],
      reviewReason: 'class-conflict' as const,
    };
    await lake(t, {
      ...cls,
      name: 'Bog A',
      displayScore: 0.9,
      classClaims: [
        { source: 'nhd', value: 'wetland', token: 'nhd:fcode=46600', areaSqM: ac(7) },
        { source: 'osm', value: 'lakePond', token: 'osm:water=pond' },
      ],
    });
    await lake(t, {
      ...cls,
      name: 'Res B',
      displayScore: 0.8,
      classClaims: [
        { source: 'nhd', value: 'reservoir' },
        { source: 'osm', value: 'river' },
      ],
    });
    await lake(t, { ...cls, name: 'Old C', displayScore: 0.7 });
    const page = (tab?: string) =>
      mod.as.query(api.corpusTasks.listPage, {
        lane: 'classConflicts',
        ...(tab ? { tab } : {}),
        now: NOW,
      });

    const all = await page();
    expect(all.rows.map((r) => [r.body.name, r.facet])).toEqual([
      ['Bog A', 'wetlandOrLake'],
      ['Res B', 'otherPairs'],
      ['Old C', 'notRecorded'],
    ]);
    expect((await page('all')).rows).toHaveLength(3);
    expect((await page('wetlandOrLake')).rows.map((r) => r.body.name)).toEqual(['Bog A']);
    expect((await page('otherPairs')).rows.map((r) => r.body.name)).toEqual(['Res B']);
    await expect(page('notRecorded')).rejects.toThrow(NO_SUCH_TAB);
    await expect(page('different')).rejects.toThrow(NO_SUCH_TAB);

    // A row's class claims, as stored, or `null` when not recorded.
    const [bog, res, old] = all.rows;
    expect(bog?.lane === 'classConflicts' && bog.claims).toEqual([
      { source: 'nhd', cls: 'wetland', token: 'nhd:fcode=46600', acres: 7 },
      { source: 'osm', cls: 'lakePond', token: 'osm:water=pond', acres: null },
    ]);
    expect(res?.lane === 'classConflicts' && res.claims?.[0]?.token).toBeNull();
    expect(old?.lane === 'classConflicts' && old.claims).toBeNull();
  });

  test("a row's labels: the body as stored, its place, acres, the other name, can and decided", async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const id = await lake(t, { states: ['NH', 'VT'] });
    await lake(t, { name: 'Lake Auburn', displayScore: 0.1 });
    // The places computed by today's rule: the lead town and its state.
    await t.run(async (ctx) => {
      const { PLACES_RULE } = await import('./lib/bodyGeo');
      await ctx.db.insert('bodyGeoFacts', {
        waterBodyId: id,
        computedAt: NOW,
        placesRule: PLACES_RULE,
        towns: ['Auburn'],
        townStates: ['ME'],
      });
    });
    const page = await mod.as.query(api.corpusTasks.listPage, { lane: 'nameConflicts', now: NOW });
    const [row, other] = page.rows;
    const task = await taskOf(t, id);
    expect(row).toEqual({
      taskId: task._id,
      facet: 'different',
      filedAt: NOW,
      body: { id, name: 'The Basin', place: 'Auburn, ME', cls: 'lakePond', acres: 2263 },
      // The real rule: a moderator may pick or keep an open task's name.
      can: { pickName: null, keepName: null },
      decided: null,
      lane: 'nameConflicts',
      shown: 'The Basin',
      other: 'Lake Auburn',
    });
    // No places computed: the body's states. The other name is the best-ranked one that differs.
    expect(other?.body.place).toBe('ME');
    expect(other?.lane === 'nameConflicts' && other.other).toBe('The Basin');

    const by = await person(t, 'Riley Example');
    await decide(t, id, by.id, NOW + 5);
    const decided = await mod.as.query(api.corpusTasks.listPage, {
      lane: 'nameConflicts',
      tab: 'decided',
      now: NOW,
    });
    expect(decided.rows[0]?.decided).toEqual({
      at: NOW + 5,
      by: { userId: by.id, displayName: 'Riley Example' },
      decision: 'kept',
      actionId: expect.any(String),
      byMe: false,
    });
    // The lock, as the real rule says it: both verbs refused with the decider's sentence.
    const lock = decided.rows[0]?.can;
    expect(lock?.pickName).toMatch(/^Decided by Riley Example/);
    expect(lock?.keepName).toBe(lock?.pickName);
    expect(
      (
        await by.as.query(api.corpusTasks.listPage, {
          lane: 'nameConflicts',
          tab: 'decided',
          now: NOW,
        })
      ).rows[0]?.decided?.byMe,
    ).toBe(true);
  });

  test('decided: newest first, never an open or a left task, and a task whose body is gone is not drawn', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const a = await lake(t, { name: 'A' });
    const b = await lake(t, { name: 'B' });
    const c = await lake(t, { name: 'C' });
    const d = await lake(t, { name: 'D' });
    await decide(t, a, mod.id, NOW + 1);
    await decide(t, b, mod.id, NOW + 3);
    await decide(t, c, mod.id, NOW + 2);
    // D's question goes away with no decision: it leaves.
    await t.run(async (ctx) => {
      await ctx.db.patch(d, { reviewReasons: undefined, reviewReason: undefined });
      await syncBodyTasks(ctx, d, { now: NOW + 4 });
    });
    expect((await taskOf(t, d, 'left')).leftBecause).toBe('notAsserted');
    const read = () =>
      mod.as.query(api.corpusTasks.listPage, { lane: 'nameConflicts', tab: 'decided', now: NOW });
    expect((await read()).rows.map((r) => r.body.name)).toEqual(['B', 'C', 'A']);
    expect(
      (await mod.as.query(api.corpusTasks.listPage, { lane: 'nameConflicts', now: NOW })).rows,
    ).toEqual([]);
    // C deleted outright after its decision: its row is not drawn.
    await t.run((ctx) => ctx.db.delete(c));
    expect((await read()).rows.map((r) => r.body.name)).toEqual(['B', 'A']);
  });

  test('q finds the body by name, by our id and by its catalog id, within the lane and tab', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const basin = await lake(t, { osmId: 'way/150404999', externalId: 'way/150404999' });
    const other = await lake(t, { name: 'Sabattus Pond', displayScore: 0.2 });
    // A body that matches but holds no task.
    await lake(t, {
      name: 'Basin Brook Reservoir',
      reviewReasons: undefined,
      reviewReason: undefined,
    });
    const find = (q: string, tab?: string) =>
      mod.as.query(api.corpusTasks.listPage, {
        lane: 'nameConflicts',
        q,
        ...(tab ? { tab } : {}),
        now: NOW,
      });
    for (const q of ['Basin', basin as string, 'way/150404999']) {
      const page = await find(q);
      expect(
        page.rows.map((r) => r.body.id),
        q,
      ).toEqual([basin]);
      expect(page.isDone).toBe(true);
      expect(page.scanBudgetSpent).toBe(false);
    }
    expect((await find('Sabattus')).rows.map((r) => r.body.id)).toEqual([other]);
    // Within the tab: the decided tab holds no open task.
    expect((await find('Basin', 'decided')).rows).toEqual([]);
    await decide(t, basin, mod.id, NOW + 1);
    expect((await find('Basin', 'decided')).rows.map((r) => r.body.id)).toEqual([basin]);
    expect((await find('Basin')).rows).toEqual([]);
    // Another lane's tasks are never a match.
    expect(
      (
        await mod.as.query(api.corpusTasks.listPage, {
          lane: 'classConflicts',
          q: 'Sabattus',
          now: NOW,
        })
      ).rows,
    ).toEqual([]);
    // Under two characters is no search: the lane's page.
    expect((await find('S')).rows).toHaveLength(1);
    // A search is one page: a later page reads nothing.
    expect(
      (
        await mod.as.query(api.corpusTasks.listPage, {
          lane: 'nameConflicts',
          q: 'Sabattus',
          cursor: 'past',
          now: NOW,
        })
      ).rows,
    ).toEqual([]);
  });

  test('q is bounded: past the page or the scan it says scanBudgetSpent', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    for (let i = 0; i < 3; i++) await lake(t, { name: `Echo Pond ${i}` });
    const page = await mod.as.query(api.corpusTasks.listPage, {
      lane: 'nameConflicts',
      q: 'Echo',
      pageSize: 2,
      now: NOW,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.scanBudgetSpent).toBe(true);

    // More library matches than the scan reads: the one task past them isn't reached.
    await t.run(async (ctx) => {
      for (let i = 0; i <= SEARCH_SCAN; i++) {
        const id = await ctx.db.insert('waterBodies', {
          name: `Zulu Lake ${i}`,
          searchText: `Zulu Lake ${i}`,
          type: 'lakePond',
          source: 'osm',
          polygon: SQUARE,
          bbox: { minLat: 44, minLng: -72, maxLat: 44.01, maxLng: -71.99 },
          centroid: { lat: 44.005, lng: -71.995 },
          dedupStatus: 'clean',
          createdAt: NOW,
        });
        await libraryRow(ctx, id, `Zulu Lake ${i}`);
      }
    });
    const spent = await mod.as.query(api.corpusTasks.listPage, {
      lane: 'nameConflicts',
      q: 'Zulu',
      now: NOW,
    });
    expect(spent.rows).toEqual([]);
    expect(spent.scanBudgetSpent).toBe(true);
  });
});

// ── item ────────────────────────────────────────────────────────────────────────────────────────────────

describe('item', () => {
  test('by task id and by body: with and without lane; No such task; a left task; pending', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const id = await lake(t, {
      reviewReasons: ['class-conflict', 'name-conflict'],
      reviewReason: 'class-conflict',
    });
    const tasks = await tasksOf(t, id);
    const names = tasks.find((x) => x.lane === 'nameConflicts') as Doc<'corpusTasks'>;
    const classes = tasks.find((x) => x.lane === 'classConflicts') as Doc<'corpusTasks'>;
    const read = (ref: string, lane?: 'nameConflicts' | 'classConflicts') =>
      mod.as.query(api.corpusTasks.item, { ref, ...(lane ? { lane } : {}), now: NOW });

    expect((await read(names._id)).item?.taskId).toBe(names._id);
    expect((await read(` ${classes._id} `)).item?.taskId).toBe(classes._id);
    expect((await read(`body:${id}`, 'classConflicts')).item?.taskId).toBe(classes._id);
    expect((await read(`body:${id}`, 'nameConflicts')).item?.lane).toBe('nameConflicts');
    // No lane: the body's task in lane order.
    expect((await read(`body:${id}`)).item?.lane).toBe('nameConflicts');
    for (const ref of ['nonsense', 'body:nonsense', `flag:${id}`, '']) {
      expect(await read(ref)).toEqual({ item: null, pending: true });
    }
    await backfillDone(t);
    expect((await read('nonsense')).pending).toBe(false);

    // The class question leaves (the campaign dropped it): by id and by body, no such task.
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { reviewReasons: ['name-conflict'], reviewReason: 'name-conflict' });
      await syncBodyTasks(ctx, id, { now: NOW + 1 });
    });
    expect((await read(classes._id)).item).toBeNull();
    expect((await read(`body:${id}`, 'classConflicts')).item).toBeNull();
  });

  test('body: resolves to the latest decision once nothing is open, so the lock opens', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const id = await lake(t);
    const { taskId, actionId } = await decide(t, id, mod.id, NOW + 9);
    const { item } = await mod.as.query(api.corpusTasks.item, {
      ref: `body:${id}`,
      lane: 'nameConflicts',
    });
    expect(item?.taskId).toBe(taskId);
    expect(item?.decided).toEqual({
      at: NOW + 9,
      by: { userId: mod.id, displayName: 'Casey Example' },
      decision: 'kept',
      actionId,
      byMe: true,
    });
  });

  test('a body merged away or removed since its decision still reads, and can is asked with it', async () => {
    useMarker();
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const survivor = await lake(t, {
      name: 'Lake Auburn',
      reviewReasons: undefined,
      reviewReason: undefined,
    });
    const merged = await lake(t);
    const removed = await lake(t, { name: 'Gone Pond' });
    const m = await decide(t, merged, mod.id, NOW + 1);
    const r = await decide(t, removed, mod.id, NOW + 2);
    await t.run(async (ctx) => {
      await ctx.db.patch(merged, { mergedIntoId: survivor, dedupStatus: 'merged' });
      await ctx.db.patch(removed, { removedAt: NOW + 3 });
    });
    const one = (await mod.as.query(api.corpusTasks.item, { ref: m.taskId })).item;
    expect(one?.body.id).toBe(merged);
    expect(one?.can).toEqual({ pickName: `asked about ${m.taskId} on ${survivor}` });
    const two = (await mod.as.query(api.corpusTasks.item, { ref: r.taskId })).item;
    expect(two?.body.name).toBe('Gone Pond');
    expect(two?.can).toEqual({ pickName: `asked about ${r.taskId} on removed` });
    // Deleted outright: nothing to draw.
    await t.run((ctx) => ctx.db.delete(removed));
    expect((await mod.as.query(api.corpusTasks.item, { ref: r.taskId })).item).toBeNull();
  });

  test("the Names item: each claim's catalogs, recorded or not, rank words, namesakes, the split", async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const id = await lake(t, {
      nameClaims: [
        // A moderator's own claim on a catalog's spelling: the catalog's claim is the evidence.
        { source: 'user', value: 'The Basin' },
        { source: 'osm', value: 'Lake Auburn' },
        { source: 'nhd', value: 'The Basin', sources: ['nhd', '3dhp'] },
        { source: 'user', value: 'Auburn Water' },
      ],
    });
    // 51 other bodies named 'Lake Auburn' in the library, one named 'The Basin'.
    await t.run(async (ctx) => {
      for (let i = 0; i <= NAMESAKES_CAP + 1; i++) await libraryRow(ctx, id, 'placeholder');
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('bodyLibraryRows').collect();
      const others = rows.filter((row) => row.name === 'placeholder');
      for (const [i, row] of others.entries()) {
        const otherId = await ctx.db.insert('waterBodies', {
          name: 'Lake Auburn',
          searchText: 'Lake Auburn',
          type: 'lakePond',
          source: 'osm',
          polygon: SQUARE,
          bbox: { minLat: 44, minLng: -72, maxLat: 44.01, maxLng: -71.99 },
          centroid: { lat: 44.005, lng: -71.995 },
          dedupStatus: 'clean',
          createdAt: NOW,
        });
        const name = i === 0 ? 'The Basin' : 'Lake Auburn';
        await ctx.db.patch(row._id, { waterBodyId: otherId, name, nameKey: name.toLowerCase() });
      }
    });
    const { item } = await mod.as.query(api.corpusTasks.item, {
      ref: `body:${id}`,
      lane: 'nameConflicts',
    });
    if (item?.lane !== 'nameConflicts') throw new Error('expected the Names item');
    expect(item.split).toBe('different');
    expect(item.names).toEqual([
      {
        value: 'The Basin',
        sources: ['nhd', '3dhp'],
        sourcesRecorded: true,
        rankWords: "Second: the gazetteer's name, as NHD publishes it",
        shown: true,
        suggested: false,
        namesakes: { count: 1, capped: false },
      },
      {
        value: 'Auburn Water',
        sources: ['user'],
        sourcesRecorded: false,
        rankWords: "Above every catalog: a moderator's choice",
        shown: false,
        suggested: false,
        namesakes: { count: 0, capped: false },
      },
      {
        value: 'Lake Auburn',
        sources: ['osm'],
        sourcesRecorded: false,
        rankWords: "Last: a mapper's free text",
        shown: false,
        suggested: false,
        namesakes: { count: NAMESAKES_CAP, capped: true },
      },
    ]);
  });

  test('the Classes item: the ladder, the catalogs and depth, recorded and not', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const cls = {
      reviewReasons: ['class-conflict' as const],
      reviewReason: 'class-conflict' as const,
    };
    const recorded = await lake(t, {
      ...cls,
      name: '',
      surfaceAreaSqM: ac(7),
      maxDepthM: 4,
      maxDepthSource: 'state_agency',
      classClaims: [
        { source: 'nhd', value: 'wetland', token: 'nhd:fcode=46600', areaSqM: ac(7) },
        { source: 'osm', value: 'lakePond', token: 'osm:water=pond' },
        { source: '3dhp', value: 'lakePond' },
      ],
    });
    const old = await lake(t, { ...cls, meanDepthM: 2, meanDepthSource: 'lagos_us' });
    const bare = await lake(t, { ...cls, type: 'unclassified' });
    const read = async (id: Id<'waterBodies'>) => {
      const { item } = await mod.as.query(api.corpusTasks.item, {
        ref: `body:${id}`,
        lane: 'classConflicts',
      });
      if (item?.lane !== 'classConflicts') throw new Error('expected the Classes item');
      return item;
    };

    const a = await read(recorded);
    expect(a.facet).toBe('wetlandOrLake');
    expect(
      a.ladder.map((r) => [r.cls, r.now, r.suggested, r.byCatalog, r.consequence.kind]),
    ).toEqual([
      ['lakePond', true, false, { osm: 'osm:water=pond' }, 'stays'],
      ['wetland', false, false, { nhd: 'nhd:fcode=46600' }, 'leaves'],
      ['reservoir', false, false, {}, 'stays'],
      ['river', false, false, {}, 'stays'],
      ['bay', false, false, {}, 'waitsForParent'],
    ]);
    expect(a.ladder[1]?.consequence.words).toBe(
      'Refused by the size rules next campaign, as unnamed wetland under 50 ac',
    );
    expect(a.claims).toEqual([
      { source: 'nhd', cls: 'wetland', token: 'nhd:fcode=46600', acres: 7 },
      { source: 'osm', cls: 'lakePond', token: 'osm:water=pond', acres: null },
      { source: '3dhp', cls: 'lakePond', token: null, acres: null },
    ]);
    expect(a.depth).toEqual({ meters: 4, source: 'state_agency', measure: 'max' });

    // Imported before its claims: the ladder still draws, the catalogs read not recorded.
    const b = await read(old);
    expect(b.facet).toBe('notRecorded');
    expect(b.claims).toBeNull();
    expect(b.ladder).toHaveLength(5);
    expect(b.ladder.every((r) => Object.keys(r.byCatalog).length === 0)).toBe(true);
    expect(b.depth).toEqual({ meters: 2, source: 'lagos_us', measure: 'mean' });

    // An unclassified body draws its own rung; no depth on file is null.
    const c = await read(bare);
    expect(c.ladder.map((r) => r.cls)).toEqual([
      'lakePond',
      'wetland',
      'reservoir',
      'river',
      'bay',
      'unclassified',
    ]);
    expect(c.ladder.at(-1)?.now).toBe(true);
    expect(c.depth).toBeNull();
  });

  test('raisedBy from the campaign run; raisedAgain after an evidence change; attached; neighbors', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const id = await lake(t, { lastCampaignId: 'n7-4-20261012' });
    const bare = await lake(t, { name: 'Bare Pond', lastCampaignId: 'no-run-row' });
    const read = async (ref: string) => (await mod.as.query(api.corpusTasks.item, { ref })).item;

    // No run on file, no geometry facts, nothing attached.
    const none = await read(`body:${bare}`);
    expect(none?.raisedBy).toBeNull();
    expect(none?.raisedAgain).toBeNull();
    expect(none?.neighbors).toBeNull();
    expect(none?.attached).toEqual({ reports: 0, landmarks: 0, asks: 0, capped: false });

    await t.run(async (ctx) => {
      for (const startedAt of [NOW - 2000, NOW - 1000]) {
        await ctx.db.insert('importRuns', {
          kind: 'canonical_water',
          label: 'canonical water',
          campaignId: 'n7-4-20261012',
          deployment: 'test',
          isProd: false,
          status: 'succeeded',
          startedAt,
          counts: [],
          stages: [],
          failures: [],
          failuresTotal: 0,
        });
      }
      const author = await ctx.db.query('profiles').first();
      for (let i = 0; i <= ATTACHED_CAP; i++) {
        await ctx.db.insert('reports', {
          authorId: author?._id as Id<'profiles'>,
          waterBodyId: id,
          point: { lat: 44.005, lng: -71.995 },
          skateEndTime: NOW - i,
          reportTime: NOW - i,
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: NOW - i,
          updatedAt: NOW - i,
        } as never);
      }
      for (const removedAt of [undefined, NOW]) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: id,
          name: 'The Narrows',
          kind: 'point',
          point: { lat: 44.005, lng: -71.995 },
          source: 'moderator',
          externalIds: [],
          aliases: [],
          createdAt: NOW,
          updatedAt: NOW,
          ...(removedAt ? { removedAt } : {}),
        });
      }
      const ring = [
        [-72, 44],
        [-72, 44.01],
        [-72, 44],
      ];
      await ctx.db.insert('bodyGeoFacts', {
        waterBodyId: id,
        computedAt: NOW,
        neighbors: ['Taylor Pond', 'Gulf Island Pond', 'Lake Auburn', 'Fourth Pond'].map(
          (name) => ({
            waterBodyId: bare,
            name,
            ring,
          }),
        ),
      });
    });

    // Settled, then asked again by a campaign whose evidence changed: a new open task.
    const first = await decide(t, id, mod.id, NOW + 10);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        reviewReasons: ['name-conflict'],
        reviewReason: 'name-conflict',
        nameClaims: [...NAME_CLAIMS, { source: 'gnis', value: 'Basin Pond' }],
      });
      await syncBodyTasks(ctx, id, { now: NOW + 20 });
    });
    const again = await read(`body:${id}`);
    expect(again?.taskId).not.toBe(first.taskId);
    expect(again?.decided).toBeNull();
    expect(again?.raisedAgain).toEqual({
      previous: {
        at: NOW + 10,
        by: { userId: mod.id, displayName: 'Casey Example' },
        decision: 'kept',
        actionId: first.actionId,
        byMe: true,
      },
    });
    // The decided one is itself no raising again.
    expect((await read(first.taskId))?.raisedAgain).toBeNull();
    expect(again?.raisedBy).toEqual({ campaignId: 'n7-4-20261012', at: NOW - 1000 });
    expect(again?.attached).toEqual({ reports: ATTACHED_CAP, landmarks: 1, asks: 0, capped: true });
    expect(again?.neighbors?.map((n) => n.name)).toEqual([
      'Taylor Pond',
      'Gulf Island Pond',
      'Lake Auburn',
    ]);
  });
});

// ── Contested as water is not 6a's (D306) ──────────────────────────────────────────────────────────────────────────

test('a class-dissent reason or stored classRefusals changes nothing these reads return', async () => {
  const t = harness();
  const mod = await person(t, 'Casey Example');
  const cls = {
    reviewReasons: ['class-conflict' as const],
    reviewReason: 'class-conflict' as const,
  };
  const conflict = await lake(t, {
    ...cls,
    classClaims: [
      { source: 'nhd', value: 'wetland' },
      { source: 'osm', value: 'lakePond' },
    ],
  });
  const names = await lake(t, { name: 'Lake Auburn', displayScore: 0.2 });
  const before = await everything(mod.as, [conflict, names]);

  await t.run(async (ctx) => {
    const refusals = [{ source: 'osm' as const, token: 'osm:natural=water', areaSqM: ac(7) }];
    await ctx.db.patch(conflict, {
      reviewReasons: ['class-dissent', 'class-conflict'],
      reviewReason: 'class-dissent',
      classRefusals: refusals,
    });
    await syncBodyTasks(ctx, conflict, { now: NOW + 1 });
    await ctx.db.patch(names, { classRefusals: refusals });
  });
  // A body with a dissent alone: no task, no count, no item.
  const dissent = await lake(t, {
    name: 'Dissent Pond',
    reviewReasons: ['class-dissent'],
    reviewReason: 'class-dissent',
  });
  expect(await tasksOf(t, dissent)).toEqual([]);

  expect(await everything(mod.as, [conflict, names])).toEqual(before);
  for (const lane of ['nameConflicts', 'classConflicts'] as const) {
    expect(
      (await mod.as.query(api.corpusTasks.item, { ref: `body:${dissent}`, lane })).item,
    ).toBeNull();
  }
});

// ── can, against the real rule ─────────────────────────────────────────────────────────────────────────

describe('can on every row and item equals corpusCan', () => {
  test('for a moderator, an admin and one leaving, on an open task, a decided one, and a body merged away or removed', async () => {
    const t = harness();
    const mod = await person(t, 'Casey Example');
    const admin = await person(t, 'Avery Example', 'admin');
    // Still reads the lanes, but every write would refuse: the rule must be asked as this viewer.
    const leaving = await person(t, 'Jordan Example');
    await t.run((ctx) => ctx.db.patch(leaving.id, { deletionRequestedAt: NOW }));
    const survivor = await lake(t, {
      name: 'Lake Auburn',
      reviewReasons: undefined,
      reviewReason: undefined,
    });
    const open = await lake(t, { name: 'Open Pond' });
    const decided = await lake(t, { name: 'Decided Pond' });
    const merged = await lake(t, { name: 'Merged Pond' });
    const removed = await lake(t, { name: 'Removed Pond' });
    const cls = await lake(t, {
      name: 'Class Pond',
      reviewReasons: ['class-conflict'],
      reviewReason: 'class-conflict',
    });
    await decide(t, decided, admin.id, NOW + 1);
    await t.run(async (ctx) => {
      await ctx.db.patch(merged, { mergedIntoId: survivor, dedupStatus: 'merged' });
      await ctx.db.patch(removed, { removedAt: NOW + 2 });
    });
    const expected = (viewerId: Id<'profiles'>, task: Doc<'corpusTasks'>) =>
      t.run(async (ctx) => {
        const viewer = (await ctx.db.get(viewerId)) as Doc<'profiles'>;
        return rules.corpusCan(ctx, viewer, task, await ctx.db.get(task.waterBodyId));
      });
    for (const who of [mod, admin, leaving]) {
      for (const id of [open, decided, merged, removed, cls]) {
        const task = (await tasksOf(t, id))[0] as Doc<'corpusTasks'>;
        const { item } = await who.as.query(api.corpusTasks.item, { ref: task._id });
        expect(item?.can).toEqual(await expected(who.id, task));
      }
      for (const lane of ['nameConflicts', 'classConflicts'] as const) {
        for (const tab of [undefined, 'decided']) {
          const page = await who.as.query(api.corpusTasks.listPage, {
            lane,
            ...(tab ? { tab } : {}),
          });
          for (const row of page.rows) {
            const task = (await t.run((ctx) => ctx.db.get(row.taskId))) as Doc<'corpusTasks'>;
            expect(row.can).toEqual(await expected(who.id, task));
          }
        }
      }
    }
    // Not a match on nulls alone: the rule's distinct answers all reach the reads.
    const can = async (id: Id<'waterBodies'>) =>
      (await admin.as.query(api.corpusTasks.item, { ref: `body:${id}` })).item?.can;
    expect(await can(open)).toEqual({ pickName: null, keepName: null });
    expect(await can(cls)).toEqual({ setClass: null, keepClass: null });
    expect((await can(decided))?.pickName).toMatch(/^Decided by Avery Example/);
    expect(await can(merged)).toEqual({ pickName: TASK_LEFT.merged, keepName: TASK_LEFT.merged });
    expect(await can(removed)).toEqual({
      pickName: TASK_LEFT.removed,
      keepName: TASK_LEFT.removed,
    });
    const leavingCan = (await leaving.as.query(api.corpusTasks.item, { ref: `body:${open}` })).item
      ?.can;
    expect(leavingCan).toEqual({
      pickName: DELETION_PENDING_MESSAGE,
      keepName: DELETION_PENDING_MESSAGE,
    });
  });
});
