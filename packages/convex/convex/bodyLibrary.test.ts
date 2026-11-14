/**
 * The Bodies library (B01-3): the stored row, its counts, the writes that keep it current, and the
 * reads over it — the list's pages, its summary and the preview.
 */

import { countKeysOf, tallyCounts } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { factsOfRow, queueLibraryRefresh, refreshBodyLibrary } from './lib/bodyLibrary';
import { recomputeBodySummary } from './lib/bodySummary';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const ACRE = 4046.8564224;
/** Mid-January of the 2026 season: its record (from 1 October) is open. */
const NOW = Date.UTC(2027, 0, 15, 12);
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-72 - half, 44 - half],
        [-72 + half, 44 - half],
        [-72 + half, 44 + half],
        [-72 - half, 44 + half],
        [-72 - half, 44 - half],
      ],
    ],
  };
}

let seq = 0;
async function seedUser(t: T, role: 'member' | 'moderator' | 'admin' = 'moderator') {
  const n = seq++;
  const subject = `lib-${role}-${n}`;
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `Pat ${n}`,
      username: `pat-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(
  t: T,
  over: Partial<Doc<'waterBodies'>> & { name: string },
): Promise<Id<'waterBodies'>> {
  return (await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      searchText: over.name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01),
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44.0, lng: -72.0 },
      states: ['VT'],
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      ...over,
    }),
  )) as Id<'waterBodies'>;
}

async function seedReport(
  t: T,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  over: { hidden?: boolean; observedFrom?: 'on_ice' | 'shore' | 'secondhand' } = {},
) {
  const author = await seedUser(t, 'member');
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId: author.id,
      waterBodyId,
      point: { lat: 44.0, lng: -72.0 },
      skateEndTime,
      reportTime: skateEndTime,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: over.hidden ? ('hidden' as const) : ('visible' as const),
      ...(over.observedFrom ? { observedFrom: over.observedFrom } : {}),
      hazardIdsCreated: [],
      createdAt: skateEndTime,
      updatedAt: skateEndTime,
    }),
  );
}

const backfill = async (t: T) => {
  let cursor: string | undefined;
  for (;;) {
    const page = await t.mutation(internal.bodyLibrary.backfill, {
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (page.isDone) return;
    cursor = page.continueCursor;
  }
};

const rowsOf = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id))
      .collect(),
  );

/** Every stored count equals the tally of the stored rows. */
async function expectCountsAreTheTally(t: T) {
  const { rows, counts } = await t.run(async (ctx) => ({
    rows: await ctx.db.query('bodyLibraryRows').collect(),
    counts: await ctx.db.query('bodyLibraryCounts').collect(),
  }));
  const byBody = new Map<string, typeof rows>();
  for (const r of rows) byBody.set(r.waterBodyId, [...(byBody.get(r.waterBodyId) ?? []), r]);
  const tally = tallyCounts(
    [...byBody.values()].map((rs) => {
      const all = rs.find((r) => r.scope === '*') as (typeof rs)[number];
      return { lane: all.lane, scopes: rs.map((r) => r.scope), keys: countKeysOf(factsOfRow(all)) };
    }),
  );
  const stored = new Map(counts.map((c) => [`${c.lane}\u0001${c.scope}\u0001${c.key}`, c.count]));
  expect(Object.fromEntries(stored)).toEqual(Object.fromEntries(tally));
}

const page = (n = 50) => ({ numItems: n, cursor: null });

describe('the stored row', () => {
  test('one row per scope, the facts the list shows, and counts that are the tally', async () => {
    const t = harness();
    const champlain = await seedBody(t, {
      name: 'Lake Champlain',
      nameClaims: [
        { source: 'gnis', value: 'Lake Champlain' },
        { source: 'osm', value: 'Lac Champlain' },
      ],
      states: ['VT', 'NY'],
      surfaceAreaSqM: 300_000 * ACRE,
      osmId: 'relation/123',
      curatedBoost: 0.5,
      maxDepthM: 120,
    });
    const pond = await seedBody(t, { name: 'Mud Pond', surfaceAreaSqM: 4 * ACRE });
    await seedBody(t, { name: 'Gone', dedupStatus: 'merged' });
    await backfill(t);

    const rows = await rowsOf(t, champlain);
    expect(rows.map((r) => r.scope).sort()).toEqual(['*', 'NY', 'VT']);
    const all = rows.find((r) => r.scope === '*') as Doc<'bodyLibraryRows'>;
    expect(all).toMatchObject({
      lane: 'active',
      standing: 'active',
      aliases: ['Lac Champlain'],
      size: '1000-up',
      outline: 'catalog',
      curated: true,
      reports: 0,
      everReported: false,
      completeOf: 10,
      changedDesc: -1,
    });
    expect(all.changedAt).toBeUndefined();
    expect(all.searchText).toContain('relation/123');
    expect(all.searchText).toContain(champlain);
    expect(all.missing).toContain('putIns');
    expect(all.missing).not.toContain('depth');
    expect((await rowsOf(t, pond))[1]?.size).toBe('under-10');
    await expectCountsAreTheTally(t);
  });

  test('an unknown area sorts last both ways', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await seedBody(t, { name: 'Big', surfaceAreaSqM: 500 * ACRE });
    await seedBody(t, { name: 'Small', surfaceAreaSqM: 5 * ACRE });
    await seedBody(t, { name: 'Unmeasured' });
    await backfill(t);
    for (const dir of ['asc', 'desc'] as const) {
      const res = await as.query(api.bodies.listPage, {
        lane: 'active',
        sort: { column: 'acres', dir },
        paginationOpts: page(),
      });
      expect(res.page.map((r) => r.name)).toEqual(
        dir === 'asc' ? ['Small', 'Big', 'Unmeasured'] : ['Big', 'Small', 'Unmeasured'],
      );
      expect(res.page[2]?.areaSqM).toBeNull();
    }
  });
});

describe('kept current at the writes', () => {
  test('a moderator setting a body dormant moves its row and its counts, and stamps Changed', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Long Pond' });
    await seedBody(t, { name: 'Other' });
    await backfill(t);
    await as.mutation(api.standing.setStanding, { waterBodyId: id, standing: 'dormant' });
    const [row] = (await rowsOf(t, id)).filter((r) => r.scope === '*');
    expect(row).toMatchObject({ lane: 'moderator', standing: 'moderator', changedAt: NOW });
    const summary = await as.query(api.bodies.listSummary, { lane: 'active' });
    expect(summary.laneCounts.active).toEqual({ count: 1, capped: false });
    expect(summary.laneCounts.moderator).toEqual({ count: 1, capped: false });
    expect(summary.laneCounts.changed).toEqual({ count: 1, capped: false });
    expect(summary.corpus).toEqual({ count: 2, capped: false });
    await expectCountsAreTheTally(t);

    const changed = await as.query(api.bodies.listPage, {
      lane: 'changed',
      paginationOpts: page(),
      now: NOW,
    });
    expect(changed.page.map((r) => r.name)).toEqual(['Long Pond']);
    const later = await as.query(api.bodies.listPage, {
      lane: 'changed',
      paginationOpts: page(),
      now: NOW + 8 * DAY,
    });
    // The caller's clock is held near the server's: eight days on reads as now.
    expect(later.page).toHaveLength(1);
  });

  test('a machine demotion refreshes without stamping Changed', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Quiet Pond' });
    await backfill(t);
    await t.run(async (ctx) => {
      const { demoteBody } = await import('./lib/standing');
      const body = (await ctx.db.get(id)) as Doc<'waterBodies'>;
      await demoteBody(ctx, body, { reason: 'inactive' });
    });
    const [row] = await rowsOf(t, id);
    expect(row?.lane).toBe('inactive');
    expect(row?.changedAt).toBeUndefined();
  });

  test('a report write counts this season, ever reported and the put-in it derives', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Busy Lake' });
    await backfill(t);
    await seedReport(t, id, NOW - DAY, { observedFrom: 'on_ice' });
    await seedReport(t, id, Date.UTC(2026, 8, 20)); // September: this season, before its record
    await seedReport(t, id, NOW - 2 * DAY, { hidden: true });
    await t.run((ctx) => recomputeBodySummary(ctx, id));
    const [row] = await rowsOf(t, id);
    expect(row).toMatchObject({ reports: 1, everReported: true, hasPutIns: true });
    expect(row?.missing).not.toContain('putIns');
    await expectCountsAreTheTally(t);
  });

  test('the sweeps opt out of the library refresh', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Swept' });
    await t.run((ctx) => recomputeBodySummary(ctx, id, NOW, undefined, false));
    expect(await rowsOf(t, id)).toHaveLength(0);
  });

  test('a merged or deleted body leaves the library through the queue', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Leaving', states: ['NH'] });
    const kept = await seedBody(t, { name: 'Kept' });
    await backfill(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(id);
      await queueLibraryRefresh(ctx, [id, id]);
    });
    expect((await t.query(internal.bodyLibrary.state, {})).queued).toBe(1);
    expect(await t.mutation(internal.bodyLibrary.drainQueue, {})).toEqual({
      refreshed: 1,
      more: false,
    });
    expect(await rowsOf(t, id)).toHaveLength(0);
    await t.run(async (ctx) => {
      await ctx.db.patch(kept, { dedupStatus: 'merged' });
      await refreshBodyLibrary(ctx, kept);
    });
    expect(await rowsOf(t, kept)).toHaveLength(0);
    expect((await t.query(internal.bodyLibrary.state, {})).corpus).toBe(0);
    await expectCountsAreTheTally(t);
  });

  test('a state the body stops touching loses its row; an area cleared is dropped', async () => {
    const t = harness();
    const id = await seedBody(t, {
      name: 'Border',
      states: ['VT', 'NY'],
      surfaceAreaSqM: ACRE * 50,
    });
    await backfill(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { states: ['VT'], surfaceAreaSqM: undefined });
      await refreshBodyLibrary(ctx, id);
    });
    const rows = await rowsOf(t, id);
    expect(rows.map((r) => r.scope).sort()).toEqual(['*', 'VT']);
    expect(rows[0]?.areaSqM).toBeUndefined();
    expect(rows[0]?.size).toBeUndefined();
    await expectCountsAreTheTally(t);
  });

  test('the season turning re-counts last season’s rows', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Old Season' });
    await seedReport(t, id, NOW - DAY);
    await backfill(t);
    expect((await rowsOf(t, id))[0]?.reports).toBe(1);
    vi.setSystemTime(Date.UTC(2027, 6, 2));
    const { as } = await seedUser(t);
    const before = await as.query(api.bodies.listPage, { lane: 'active', paginationOpts: page() });
    // Read-time: last season's count is not this season's.
    expect(before.page[0]?.reports).toBe(0);
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toEqual({ refreshed: 1 });
    expect((await rowsOf(t, id))[0]).toMatchObject({ reports: 0, reportsSeason: 2027 });
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toEqual({ refreshed: 0 });
  });

  test('the drift repair refreshes the oldest rows', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Drifted' });
    await backfill(t);
    await t.run((ctx) => ctx.db.patch(id, { curatedBoost: 1 }));
    vi.setSystemTime(NOW + DAY);
    expect(await t.mutation(internal.bodyLibrary.repairDrift, {})).toEqual({ refreshed: 1 });
    expect((await rowsOf(t, id))[0]).toMatchObject({ curated: true, refreshedAt: NOW + DAY });
  });

  test('an unchanged row is marked read at most daily, so the drift repair moves on', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Steady' });
    await backfill(t);
    vi.setSystemTime(NOW + DAY / 2);
    await t.mutation(internal.bodyLibrary.repairDrift, {});
    expect((await rowsOf(t, id))[0]?.refreshedAt).toBe(NOW);
    vi.setSystemTime(NOW + 2 * DAY);
    await t.mutation(internal.bodyLibrary.repairDrift, {});
    expect((await rowsOf(t, id))[0]?.refreshedAt).toBe(NOW + 2 * DAY);
  });

  test('Changed is backfilled from the audit log: a moderator on a bay counts, the machine does not', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const id = await seedBody(t, { name: 'Bayed' });
    const bay = await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: id,
        name: 'North Bay',
        searchText: 'North Bay',
        polygon: square(0.005),
        bbox: { minLat: 43.995, minLng: -72.005, maxLat: 44.005, maxLng: -71.995 },
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: 10 * ACRE,
        displayScore: 0,
        minVisibleZoom: 10,
        createdByUserId: mod.id,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await backfill(t);
    await t.run(async (ctx) => {
      for (const [actorId, at] of [
        [mod.id, NOW - 3 * DAY],
        [undefined, NOW - DAY],
      ] as const) {
        await ctx.db.insert('moderationActions', {
          ...(actorId ? { actorId } : {}),
          action: 'rename_sub_area',
          targetType: 'waterBodySubArea',
          targetId: bay,
          reason: 'r',
          createdAt: at,
        });
      }
    });
    expect(await t.mutation(internal.bodyLibrary.backfillChangedAt, {})).toMatchObject({
      stamped: 1,
      isDone: true,
    });
    expect((await rowsOf(t, id))[0]?.changedAt).toBe(NOW - 3 * DAY);
  });

  test('backfillAll walks the corpus', async () => {
    const t = harness();
    await seedBody(t, { name: 'A' });
    await seedBody(t, { name: 'B' });
    expect(await t.action(internal.bodyLibrary.backfillAll, {})).toEqual({
      refreshed: 2,
      done: true,
    });
  });
});

describe('the list', () => {
  async function corpus(t: T) {
    const ids = {
      champlain: await seedBody(t, {
        name: 'Lake Champlain',
        nameClaims: [{ source: 'osm', value: 'Lac Champlain' }],
        states: ['VT', 'NY'],
        surfaceAreaSqM: 300_000 * ACRE,
        type: 'lakePond',
      }),
      bay: await seedBody(t, { name: 'Shelburne Bay', type: 'bay', surfaceAreaSqM: 900 * ACRE }),
      pond: await seedBody(t, { name: 'Mud Pond', states: ['NH'], surfaceAreaSqM: 4 * ACRE }),
      removed: await seedBody(t, {
        name: 'Removed Pond',
        removedAt: NOW - DAY,
        removalReason: 'other',
      }),
      rejected: await seedBody(t, { name: 'Drawn Pond', source: 'user', reviewStatus: 'rejected' }),
    };
    await backfill(t);
    return ids;
  }

  test('pages a lane in the column’s order, scoped by state', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await corpus(t);
    const first = await as.query(api.bodies.listPage, {
      lane: 'active',
      sort: { column: 'name', dir: 'asc' },
      paginationOpts: page(2),
    });
    expect(first.page.map((r) => r.name)).toEqual(['Lake Champlain', 'Mud Pond']);
    expect(first.isDone).toBe(false);
    const second = await as.query(api.bodies.listPage, {
      lane: 'active',
      sort: { column: 'name', dir: 'asc' },
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r.name)).toEqual(['Shelburne Bay']);

    const ny = await as.query(api.bodies.listPage, {
      lane: 'all',
      state: 'ny',
      paginationOpts: page(),
    });
    expect(ny.page.map((r) => r.name)).toEqual(['Lake Champlain']);

    const removed = await as.query(api.bodies.listPage, {
      lane: 'removed',
      paginationOpts: page(),
    });
    expect(removed.page.map((r) => [r.name, r.standing])).toEqual([
      ['Drawn Pond', 'rejected'],
      ['Removed Pond', 'removed'],
    ]);
  });

  test('every column sorts, in each lane', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await corpus(t);
    for (const column of [
      'name',
      'class',
      'state',
      'acres',
      'complete',
      'asks',
      'reports',
      'changed',
    ] as const) {
      for (const lane of ['all', 'active'] as const) {
        const res = await as.query(api.bodies.listPage, {
          lane,
          sort: { column, dir: 'desc' },
          paginationOpts: page(),
        });
        expect(res.page.length).toBe(lane === 'all' ? 5 : 3);
      }
    }
    const byClass = await as.query(api.bodies.listPage, {
      lane: 'active',
      sort: { column: 'class', dir: 'asc' },
      paginationOpts: page(),
    });
    expect(byClass.page.map((r) => r.bodyClass)).toEqual(['bay', 'lakePond', 'lakePond']);
  });

  test('facets narrow inside the read, any option within one, all of them together', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await corpus(t);
    const big = await as.query(api.bodies.listPage, {
      lane: 'active',
      facets: { size: ['100-1000', '1000-up'] },
      paginationOpts: page(),
    });
    expect(big.page.map((r) => r.name).sort()).toEqual(['Lake Champlain', 'Shelburne Bay']);
    const both = await as.query(api.bodies.listPage, {
      lane: 'active',
      facets: {
        size: ['1000-up'],
        class: ['bay'],
        putins: ['none'],
        reports: ['never'],
        complete: ['under-8'],
        outline: ['catalog'],
        curation: ['curated', 'asks', 'intake', 'enrichment'],
      },
      paginationOpts: page(),
    });
    expect(both.page).toEqual([]);
    const ignored = await as.query(api.bodies.listPage, {
      lane: 'active',
      facets: { size: ['huge'] },
      paginationOpts: page(),
    });
    expect(ignored.page).toHaveLength(3);
    const season = await as.query(api.bodies.listPage, {
      lane: 'active',
      facets: { reports: ['season'], putins: ['some'] },
      paginationOpts: page(),
    });
    expect(season.page).toEqual([]);
  });

  test('a search finds a body by alias and by id, and names the alias it matched', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const { champlain } = await corpus(t);
    const byAlias = await as.query(api.bodies.listPage, {
      lane: 'active',
      q: 'lac',
      paginationOpts: page(),
    });
    expect(byAlias.page.map((r) => [r.name, r.matchedAlias])).toEqual([
      ['Lake Champlain', 'Lac Champlain'],
    ]);
    const byId = await as.query(api.bodies.listPage, {
      lane: 'all',
      q: champlain,
      paginationOpts: page(),
    });
    expect(byId.page.map((r) => r.id)).toEqual([champlain]);
    const changed = await as.query(api.bodies.listPage, {
      lane: 'changed',
      q: 'pond',
      paginationOpts: page(),
    });
    expect(changed.page).toEqual([]);
    const tooShort = await as.query(api.bodies.listPage, {
      lane: 'active',
      q: 'l',
      paginationOpts: page(),
    });
    expect(tooShort.page).toHaveLength(3);
  });

  test('the summary: lane counts, state tabs, totals and the facet counts it can answer', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await corpus(t);
    const s = await as.query(api.bodies.listSummary, { lane: 'active' });
    expect(s.laneCounts).toMatchObject({
      all: { count: 5 },
      active: { count: 3 },
      removed: { count: 2 },
      inactive: { count: 0 },
      changed: { count: 0 },
    });
    expect(s.states).toEqual(['VT', 'NH', 'NY']);
    expect(s.total).toEqual({ count: 3, capped: false });
    expect(s.facetCounts?.class).toMatchObject({ lakePond: 2, bay: 1, river: 0 });
    expect(s.facetCounts?.size).toMatchObject({ '1000-up': 1, '100-1000': 1, 'under-10': 1 });
    expect(s.serves.sort).toContain('reports');

    const one = await as.query(api.bodies.listSummary, {
      lane: 'active',
      facets: { size: ['1000-up', '100-1000'] },
    });
    expect(Object.keys(one.facetCounts ?? {})).toEqual(['size']);
    expect(one.total).toEqual({ count: 2, capped: false });

    const curation = await as.query(api.bodies.listSummary, {
      lane: 'active',
      facets: { curation: ['asks'] },
    });
    expect(curation.total).toBeNull();

    const two = await as.query(api.bodies.listSummary, {
      lane: 'active',
      state: 'VT',
      facets: { size: ['1000-up'], class: ['bay'] },
    });
    expect(two.facetCounts).toEqual({});
    expect(two.total).toBeNull();

    const searched = await as.query(api.bodies.listSummary, { lane: 'active', q: 'pond' });
    expect(searched.facetCounts).toBeNull();
    expect(searched.serves.sort).toEqual([]);

    const changed = await as.query(api.bodies.listSummary, { lane: 'changed' });
    expect(changed.total).toEqual({ count: 0, capped: false });
    expect(changed.serves.sort).toEqual(['changed']);
  });

  test('a member can read none of it', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'member');
    await expect(
      as.query(api.bodies.listPage, { lane: 'active', paginationOpts: page() }),
    ).rejects.toThrow();
    await expect(as.query(api.bodies.listSummary, { lane: 'active' })).rejects.toThrow();
  });
});

describe('the preview', () => {
  test('reports by vantage and all time, the asks, and completeness', async () => {
    const t = harness();
    const { as, id: modId } = await seedUser(t);
    const id = await seedBody(t, { name: 'Previewed' });
    await seedReport(t, id, NOW - DAY, { observedFrom: 'on_ice' });
    await seedReport(t, id, NOW - 2 * DAY);
    await seedReport(t, id, Date.UTC(2024, 0, 10), { observedFrom: 'shore' });
    await t.run(async (ctx) => {
      await ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        requesterId: modId,
        coord: { lat: 44, lng: -72 },
        waterBodyId: id,
        name: 'North Cove',
        createdAt: NOW - DAY,
      } as never);
      await ctx.db.insert('corpusPlaceNames', {
        name: 'The Narrows',
        askKey: 'narrows',
        aliases: [],
        messages: 3,
        skatedMessages: 1,
        states: ['VT'],
        waterBodyId: id,
        status: 'open',
        createdAt: NOW - 3 * DAY,
        updatedAt: NOW,
      });
    });
    await backfill(t);
    const p = await as.query(api.bodies.preview, { waterBodyId: id });
    expect(p?.season).toEqual({
      count: 2,
      recordOpen: true,
      byVantage: { on_ice: 1, shore: 0, secondhand: 0, unstated: 1 },
    });
    expect(p?.allTime).toEqual({ count: 3, capped: false, firstSeason: 2023 });
    expect(p?.asks.map((a) => a.kind)).toEqual(['request', 'placeName']);
    expect(p?.town).toBeNull();
    expect(p?.complete?.of).toBe(10);
    const [row] = await rowsOf(t, id);
    expect(row).toMatchObject({ asks: 2, asksWaiting: true });
  });

  test('an unknown body has no preview', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Brief' });
    await t.run((ctx) => ctx.db.delete(id));
    expect(await as.query(api.bodies.preview, { waterBodyId: id })).toBeNull();
  });
});

describe('which body an audited action belongs to', () => {
  test('every body-scoped target resolves, and the facts it moves are read', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const id = await seedBody(t, { name: 'Resolved', externalId: 'way/9' });
    const other = await seedBody(t, { name: 'Neighbor' });
    const ids = await t.run(async (ctx) => {
      const landmark = await ctx.db.insert('bodyLandmarks', {
        waterBodyId: id,
        name: 'Big Island',
        kind: 'island',
        point: { lat: 44, lng: -72 },
        source: 'moderator',
        externalIds: [],
        aliases: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const putIn = await ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44, lng: -72 },
        source: 'official',
        status: 'visible',
        createdAt: NOW,
      });
      const feature = await ctx.db.insert('bodyFeatures', {
        waterBodyId: id,
        type: 'spring_current',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [-72, 44] },
        bbox: { minLat: 44, minLng: -72, maxLat: 44, maxLng: -72 },
        addedByUserId: mod.id,
        active: true,
        createdAt: NOW,
      });
      const lot = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44, lng: -72 },
        source: 'official',
        status: 'visible',
        amenities: [],
        createdAt: NOW,
      });
      const hiddenLot = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44, lng: -72 },
        source: 'osm',
        status: 'hidden',
        amenities: [],
        createdAt: NOW,
      });
      for (const [parkingAreaId, waterBodyId, inferred] of [
        [hiddenLot, id, false],
        [lot, id, true],
        [lot, other, true],
      ] as const) {
        await ctx.db.insert('parkingAreaBodies', {
          parkingAreaId,
          waterBodyId,
          inferred,
          createdAt: NOW,
        });
      }
      const flag = await ctx.db.insert('contentFlags', {
        flaggerId: mod.id,
        targetType: 'waterbody',
        targetId: id,
        reason: 'spam',
        status: 'reviewing',
        createdAt: NOW,
      });
      const reportFlag = await ctx.db.insert('contentFlags', {
        flaggerId: mod.id,
        targetType: 'report',
        targetId: 'x',
        reason: 'spam',
        status: 'open',
        createdAt: NOW,
      });
      const name = await ctx.db.insert('corpusPlaceNames', {
        name: 'The Gut',
        askKey: 'gut',
        aliases: [],
        messages: 1,
        skatedMessages: 0,
        states: [],
        waterBodyId: id,
        status: 'open',
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert('bathymetryCoverage', { source: 'osm', externalId: 'way/9' });
      return { landmark, putIn, feature, lot, flag, reportFlag, name };
    });
    const { bodiesOfTarget } = await import('./lib/bodyLibrary');
    const resolve = (type: Parameters<typeof bodiesOfTarget>[1], target: string) =>
      t.run((ctx) => bodiesOfTarget(ctx, type, target));
    expect(await resolve('bodyLandmark', ids.landmark)).toEqual({ bodies: [id], changes: true });
    expect(await resolve('putIn', ids.putIn)).toEqual({ bodies: [id], changes: true });
    expect(await resolve('bodyFeature', ids.feature)).toEqual({ bodies: [id], changes: false });
    expect(await resolve('corpusPlaceName', ids.name)).toEqual({ bodies: [id], changes: false });
    expect(await resolve('contentFlag', ids.flag)).toEqual({ bodies: [id], changes: false });
    expect(await resolve('contentFlag', ids.reportFlag)).toEqual({ bodies: [], changes: false });
    expect((await resolve('parkingArea', ids.lot)).bodies.sort()).toEqual([id, other].sort());
    expect(await resolve('parkingArea', 'nope')).toEqual({ bodies: [], changes: false });
    expect(await resolve('waterBodySubArea', 'nope')).toEqual({ bodies: [], changes: true });
    expect(await resolve('report', 'x')).toEqual({ bodies: [], changes: false });

    await t.run((ctx) => refreshBodyLibrary(ctx, id));
    const [row] = (await rowsOf(t, id)).filter((r) => r.scope === '*');
    expect(row?.missing).not.toContain('landmarks');
    expect(row?.missing).not.toContain('lots');
    expect(row?.missing).not.toContain('bathymetry');
    expect(row?.missing).not.toContain('putIns');
    expect(row).toMatchObject({ asks: 2, asksWaiting: true, hasPutIns: true });
  });

  test('a body whose newest reports are all hidden is still ever reported by an older one', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Hidden Run' });
    await seedReport(t, id, NOW - 400 * DAY);
    await t.run(async (ctx) => {
      const { REPORT_SCAN } = await import('./lib/bodyLibrary');
      const [first] = await ctx.db.query('reports').collect();
      for (let i = 0; i < REPORT_SCAN; i++) {
        const { _id, _creationTime, ...doc } = first as Doc<'reports'>;
        await ctx.db.insert('reports', {
          ...doc,
          skateEndTime: NOW - i * 60_000,
          moderationStatus: 'hidden',
        });
      }
      await refreshBodyLibrary(ctx, id);
    });
    expect((await rowsOf(t, id))[0]).toMatchObject({ everReported: true, reports: 0 });
  });
});
