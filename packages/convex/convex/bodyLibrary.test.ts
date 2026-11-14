/**
 * The Bodies library (B01-3): the stored row, its counts, the writes that keep it current, and the
 * reads over it — the list's pages, its summary and the preview.
 */

import { countKeysOf, tallyCounts } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { cleanFacets, listQueryOf, scopeOf, searchOf } from './bodies';
import { parkedRows, queueCatalogRefs, RESOLVE_BATCH } from './bodyLibrary';
import {
  drainLibraryQueue,
  errorClassOf,
  factsOfRow,
  MAX_REFRESH_ATTEMPTS,
  noteAuditedAction,
  queueLibraryRefresh,
  REPORT_SCAN,
  refreshBodyLibrary,
} from './lib/bodyLibrary';
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

async function seedBodyIn(
  ctx: Parameters<Parameters<T['run']>[0]>[0],
  name: string,
): Promise<Id<'waterBodies'>> {
  return ctx.db.insert('waterBodies', {
    name,
    searchText: name,
    type: 'lakePond',
    source: 'osm',
    polygon: square(0.01),
    bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
    centroid: { lat: 44.0, lng: -72.0 },
    states: [],
    dedupStatus: 'clean',
    createdAt: Date.now(),
  });
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

const queuedOf = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('bodyLibraryQueue')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id))
      .first(),
  );

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

type RunCtx = Parameters<Parameters<T['run']>[0]>[0];

/** The same transaction, its metrics reading every budget spent. */
function starved(ctx: RunCtx): RunCtx {
  const spent = { used: 0, remaining: 0 };
  const low = {
    bytesRead: spent,
    bytesWritten: spent,
    databaseQueries: spent,
    documentsRead: spent,
    documentsWritten: spent,
    functionsScheduled: spent,
    scheduledFunctionArgsBytes: spent,
  };
  return { ...ctx, meta: { ...ctx.meta, getTransactionMetrics: async () => low } } as RunCtx;
}

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
      failed: 0,
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

  test('a contour coverage replacement queues the bodies whose coverage moved, by a job of its own', async () => {
    const t = harness();
    const ids = {
      kept: await seedBody(t, { name: 'Kept', externalId: 'way/1' }),
      dropped: await seedBody(t, { name: 'Dropped', externalId: 'way/2' }),
      added: await seedBody(t, { name: 'Added', externalId: 'way/3' }),
      otherCatalog: await seedBody(t, { name: 'Other', source: 'nhd', externalId: '77' }),
    };
    await t.run(async (ctx) => {
      await ctx.db.insert('bathymetryCoverage', { source: 'osm', externalId: 'way/1' });
      await ctx.db.insert('bathymetryCoverage', { source: 'osm', externalId: 'way/2' });
      await ctx.db.insert('bathymetryCoverage', { source: 'nhd', externalId: '77' });
    });
    await t.mutation(internal.waterBodies.importContourCoverage, {
      source: 'osm',
      externalIds: ['way/1', 'way/3'],
      clearFirst: true,
    });
    // No body read in the import itself: the moved refs ride to the resolver.
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    const job = scheduled.find((s) => s.name === 'bodyLibrary:queueByExternalId');
    expect(job).toBeDefined();
    const [args] = (job as (typeof scheduled)[number]).args as [
      { refs: { source: 'osm' | 'nhd'; externalId: string }[] },
    ];
    const refs = args.refs;
    expect(refs).toEqual([
      { source: 'osm', externalId: 'way/3' },
      { source: 'osm', externalId: 'way/2' },
      { source: 'nhd', externalId: '77' },
    ]);
    expect(
      await t.mutation(internal.bodyLibrary.queueByExternalId, {
        refs: [...refs, { source: 'osm', externalId: 'way/404' }],
      }),
    ).toEqual({ queued: 3, deferred: 0 });
    for (const id of [ids.added, ids.dropped, ids.otherCatalog]) {
      expect(await queuedOf(t, id)).not.toBeNull();
    }
    expect(await queuedOf(t, ids.kept)).toBeNull();
  });

  test('the coverage resolver reads what a transaction affords and hands the rest on', async () => {
    const t = harness();
    const a = await seedBody(t, { name: 'A', externalId: 'way/a' });
    const refs = [
      { source: 'osm' as const, externalId: 'way/a' },
      { source: 'osm' as const, externalId: 'way/b' },
    ];
    // Spent after the first read: the first is always taken, so a run never stalls.
    const left = await t.run(async (ctx) => (await queueCatalogRefs(starved(ctx), refs)).rest);
    expect(left).toEqual([refs[1]]);
    expect(await queuedOf(t, a)).not.toBeNull();
    // A long list is taken a batch at a time, the rest scheduled.
    const many = Array.from({ length: RESOLVE_BATCH + 1 }, (_, i) => ({
      source: 'osm' as const,
      externalId: `way/n${i}`,
    }));
    expect(await t.mutation(internal.bodyLibrary.queueByExternalId, { refs: many })).toEqual({
      queued: 0,
      deferred: 1,
    });
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
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toEqual({
      refreshed: 1,
      failed: 0,
      closed: 0,
    });
    expect((await rowsOf(t, id))[0]).toMatchObject({ reports: 0, reportsSeason: 2027 });
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toEqual({
      refreshed: 0,
      failed: 0,
      closed: 0,
    });
  });

  test('the drift repair refreshes the oldest rows', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Drifted' });
    await backfill(t);
    await t.run((ctx) => ctx.db.patch(id, { curatedBoost: 1 }));
    vi.setSystemTime(NOW + DAY);
    expect(await t.mutation(internal.bodyLibrary.repairDrift, {})).toEqual({
      refreshed: 1,
      skipped: 0,
      failed: 0,
    });
    expect((await rowsOf(t, id))[0]).toMatchObject({ curated: true, refreshedAt: NOW + DAY });
  });

  test('an unchanged row is marked read at most daily, so the drift repair moves on', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Steady' });
    await backfill(t);
    vi.setSystemTime(NOW + DAY / 2);
    // Younger than a day: not re-read, so the repair doesn't spend each tick on the same bodies.
    expect(await t.mutation(internal.bodyLibrary.repairDrift, {})).toEqual({
      refreshed: 0,
      skipped: 0,
      failed: 0,
    });
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
        // The same bay again: read once a page, the latest stamp still wins.
        [mod.id, NOW - 4 * DAY],
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
    // A lot's audit row is not a change to its bodies: passed over before any read.
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'remove',
        targetType: 'parkingArea',
        targetId: 'not-a-lot',
        reason: 'r',
        createdAt: NOW - DAY,
      }),
    );
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

  test('a narrow facet whose first matches sit past the first scan window keeps loading to them', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const template = await t.run(async (ctx) => {
      const id = await seedBodyIn(ctx, 'Template');
      await refreshBodyLibrary(ctx, id);
      const row = await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id).eq('scope', '*'))
        .first();
      const { _id, _creationTime, ...fields } = row as Doc<'bodyLibraryRows'>;
      await ctx.db.delete(_id);
      return fields;
    });
    // 2,100 rows before the first bay in name order: past one page's 2,000-row scan.
    await t.run(async (ctx) => {
      for (let i = 0; i < 2_100; i++) {
        const key = `a ${String(i).padStart(5, '0')}`;
        await ctx.db.insert('bodyLibraryRows', { ...template, name: key, nameKey: key });
      }
      for (const name of ['z bay 1', 'z bay 2', 'z bay 3']) {
        await ctx.db.insert('bodyLibraryRows', {
          ...template,
          name,
          nameKey: name,
          bodyClass: 'bay',
        });
      }
    });
    const first = await as.query(api.bodies.listPage, {
      lane: 'active',
      sort: { column: 'name', dir: 'asc' },
      facets: { class: ['bay'] },
      paginationOpts: page(50),
    });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    expect(first.scanBudgetSpent).toBe(true);
    const found: string[] = [];
    let cursor: string | null = first.continueCursor;
    for (let i = 0; i < 5 && cursor !== null; i++) {
      const next: typeof first = await as.query(api.bodies.listPage, {
        lane: 'active',
        sort: { column: 'name', dir: 'asc' },
        facets: { class: ['bay'] },
        paginationOpts: { numItems: 50, cursor },
      });
      found.push(...next.page.map((r) => r.name));
      cursor = next.isDone ? null : next.continueCursor;
      if (next.isDone) expect(next.scanBudgetSpent).toBe(false);
    }
    expect(found).toEqual(['z bay 1', 'z bay 2', 'z bay 3']);
  });

  test('a figure the read stopped short on says it is a floor', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const busy = await seedBody(t, { name: 'Busy' });
    await t.run(async (ctx) => {
      const author = await ctx.db.insert('profiles', {
        clerkUserId: 'floor-author',
        displayName: 'a',
        username: 'floor-a',
        dateOfBirth: Date.UTC(1990, 0, 1),
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: NOTIF_PREFS,
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: NOW,
      });
      for (let i = 0; i < REPORT_SCAN; i++) {
        const at = NOW - (i + 1) * 60_000;
        await ctx.db.insert('reports', {
          authorId: author,
          waterBodyId: busy,
          point: { lat: 44, lng: -72 },
          skateEndTime: at,
          reportTime: at,
          source: 'native',
          iceTypes: [{ type: 'black_ice' }],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: at,
          updatedAt: at,
        });
      }
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert('corpusPlaceNames', {
          name: `Name ${i}`,
          askKey: `name-${i}`,
          aliases: [],
          messages: 1,
          skatedMessages: 0,
          states: [],
          waterBodyId: busy,
          status: 'open',
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      void mod;
    });
    const quiet = await seedBody(t, { name: 'Quiet' });
    await backfill(t);
    const res = await as.query(api.bodies.listPage, { lane: 'active', paginationOpts: page() });
    const byId = new Map(res.page.map((r) => [r.id, r]));
    expect(byId.get(busy)).toMatchObject({
      reports: REPORT_SCAN,
      reportsCapped: true,
      asks: 100,
      asksCapped: true,
    });
    expect(byId.get(quiet)).toMatchObject({ reportsCapped: false, asksCapped: false });
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

  test('a repeated facet option counts once', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await corpus(t);
    const s = await as.query(api.bodies.listSummary, {
      lane: 'active',
      facets: { size: ['1000-up', '1000-up'] },
    });
    expect(s.total).toEqual({ count: 1, capped: false });
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
      capped: false,
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

  test('a read that stops inside the season’s record says its season count is a floor', async () => {
    const t = harness();
    const { as, id: author } = await seedUser(t);
    const id = await seedBody(t, { name: 'Crowded' });
    // 1,001 reports this season, the oldest past the read's 1,000.
    await t.run(async (ctx) => {
      for (let i = 0; i <= 1_000; i++) {
        const at = NOW - DAY - i * 60_000;
        await ctx.db.insert('reports', {
          authorId: author,
          waterBodyId: id,
          point: { lat: 44.0, lng: -72.0 },
          skateEndTime: at,
          reportTime: at,
          source: 'native' as const,
          iceTypes: [{ type: 'black_ice' as const }],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible' as const,
          hazardIdsCreated: [],
          createdAt: at,
          updatedAt: at,
        });
      }
    });
    const p = await as.query(api.bodies.preview, { waterBodyId: id });
    expect(p?.season).toMatchObject({ count: 1_000, capped: true });
    expect(p?.allTime).toMatchObject({ count: 1_000, capped: true, firstSeason: null });
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

  test('a transaction refreshes a few bodies inline; a bulk writer’s rest are stamped and queued', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const { INLINE_AUDIT_REFRESHES } = await import('./lib/bodyLibrary');
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < INLINE_AUDIT_REFRESHES + 2; i++) {
      ids.push(await seedBody(t, { name: `Pond ${i}` }));
    }
    await backfill(t);
    await t.run(async (ctx) => {
      const { writeAudit } = await import('./lib/audit');
      for (const id of ids) {
        await ctx.db.patch(id, { curatedBoost: 1 });
        await writeAudit(ctx, {
          actorId: mod.id,
          action: 'set_curated_boost',
          targetType: 'waterbody',
          targetId: id,
          reason: 'r',
          createdAt: NOW,
        });
      }
    });
    const starRow = async (id: Id<'waterBodies'>) =>
      (await rowsOf(t, id)).find((r) => r.scope === '*');
    for (const [i, id] of ids.entries()) {
      // Every body is stamped Changed in the transaction; only the first few are re-read in it.
      expect(await starRow(id)).toMatchObject({
        changedAt: NOW,
        curated: i < INLINE_AUDIT_REFRESHES,
      });
    }
    expect((await t.query(internal.bodyLibrary.state, {})).queued).toBe(2);
    await t.mutation(internal.bodyLibrary.drainQueue, {});
    for (const id of ids)
      expect(await starRow(id)).toMatchObject({ changedAt: NOW, curated: true });
    await expectCountsAreTheTally(t);
  });

  test('placing a corpus name with a new landmark takes it off the body’s asks', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const id = await seedBody(t, { name: 'Named Lake' });
    const nameId = await t.run((ctx) =>
      ctx.db.insert('corpusPlaceNames', {
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
      }),
    );
    await backfill(t);
    expect((await rowsOf(t, id))[0]?.asks).toBe(1);
    await mod.as.mutation(api.landmarks.create, {
      waterBodyId: id,
      name: 'The Gut',
      kind: 'island',
      point: { lat: 44, lng: -72 },
      corpusNameId: nameId,
    });
    expect((await rowsOf(t, id))[0]).toMatchObject({ asks: 0, asksWaiting: false });
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

describe('a body whose refresh throws', () => {
  /** A body whose put-ins can't be derived: its outline is a point, and a report asks for a cluster. */
  async function poison(t: T, name: string) {
    const id = await seedBody(t, {
      name,
      polygon: { type: 'Point', coordinates: [-72, 44] } as never,
    });
    await seedReport(t, id, NOW - DAY);
    return id;
  }

  test('throws on its own, and the probe is what the tests below lean on', async () => {
    const t = harness();
    const id = await poison(t, 'Probe');
    await expect(
      t.mutation(internal.bodyLibrary.refreshOne, { waterBodyId: id }),
    ).rejects.toThrow();
  });

  const queueRow = (t: T, id: Id<'waterBodies'>) =>
    t.run((ctx) =>
      ctx.db
        .query('bodyLibraryQueue')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .first(),
    );

  test('does not stop the bodies behind it in the same drain, and goes to the back', async () => {
    const t = harness();
    const bad = await poison(t, 'Bad');
    const good = [await seedBody(t, { name: 'Good A' }), await seedBody(t, { name: 'Good B' })];
    await t.run((ctx) => queueLibraryRefresh(ctx, [bad, ...good], NOW - DAY));
    expect(await t.mutation(internal.bodyLibrary.drainQueue, {})).toEqual({
      refreshed: 2,
      failed: 1,
      more: false,
    });
    for (const id of good) expect(await rowsOf(t, id)).toHaveLength(2);
    expect(await rowsOf(t, bad)).toHaveLength(0);
    expect(await queueRow(t, bad)).toMatchObject({
      attempts: 1,
      // The class the nested call caught, carried across it — not the plain `Error` it arrives as.
      lastErrorClass: 'TypeError',
      queuedAt: NOW,
    });
    expect((await queueRow(t, bad))?.parkedAt).toBeUndefined();
    await expectCountsAreTheTally(t);
  });

  test('fails once per transaction however often a writer refreshes it', async () => {
    const t = harness();
    const bad = await poison(t, 'Twice');
    await t.run(async (ctx) => {
      // An audit row's refresh and the writer's refresh after it: one attempt, not two.
      expect(await refreshBodyLibrary(ctx, bad)).toBe(false);
      expect(await refreshBodyLibrary(ctx, bad)).toBe(false);
    });
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 1 });
    await t.run((ctx) => refreshBodyLibrary(ctx, bad));
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 2 });
  });

  test('a backfill page and the season turning count the body that failed', async () => {
    const t = harness();
    const bad = await poison(t, 'Soured Page');
    const good = await seedBody(t, { name: 'Sound Page' });
    await seedReport(t, good, NOW - DAY);
    expect(await t.mutation(internal.bodyLibrary.backfill, {})).toMatchObject({
      refreshed: 1,
      failed: 1,
      isDone: true,
    });
    // The poisoned body with last season's count on its rows, and parked: the turn passes it.
    await t.run(async (ctx) => {
      const id = await seedBodyIn(ctx, 'Parked Last Season');
      await refreshBodyLibrary(ctx, id);
      for (const row of await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .collect()) {
        await ctx.db.patch(row._id, { reports: 1, reportsSeason: 2026 });
      }
      await ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: id,
        queuedAt: NOW,
        attempts: 3,
        parkedAt: NOW,
      });
    });
    vi.setSystemTime(Date.UTC(2027, 6, 2));
    // The good body is re-counted; the parked one's rows close on the new season.
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toEqual({
      refreshed: 1,
      failed: 0,
      closed: 1,
    });
    expect((await rowsOf(t, good))[0]).toMatchObject({ reports: 0, reportsSeason: 2027 });
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 1 });
  });

  test('parks after the last attempt, is skipped and counted, and shows in the parked read', async () => {
    const t = harness();
    const bad = await poison(t, 'Stubborn');
    await t.run((ctx) => queueLibraryRefresh(ctx, [bad]));
    for (let i = 0; i < MAX_REFRESH_ATTEMPTS; i++) {
      expect(await t.mutation(internal.bodyLibrary.drainQueue, {})).toMatchObject({ failed: 1 });
    }
    expect((await queueRow(t, bad))?.parkedAt).toBe(NOW);
    expect(await t.mutation(internal.bodyLibrary.drainQueue, {})).toEqual({
      refreshed: 0,
      failed: 0,
      more: false,
    });
    expect(await t.query(internal.bodyLibrary.state, {})).toMatchObject({
      queued: 0,
      parked: 1,
      parkedCapped: false,
    });
    const admin = await seedUser(t, 'admin');
    const read = await admin.as.query(api.bodyLibrary.parked, {});
    expect(read).toEqual({
      count: 1,
      capped: false,
      rows: [
        {
          waterBodyId: bad,
          name: 'Stubborn',
          attempts: MAX_REFRESH_ATTEMPTS,
          lastErrorClass: 'TypeError',
          parkedAt: NOW,
        },
      ],
    });
    const mod = await seedUser(t);
    await expect(mod.as.query(api.bodyLibrary.parked, {})).rejects.toThrow();
    // Released by hand, it waits in the queue again with its attempts reset; a limit that is no
    // whole number still releases at least one.
    expect(await t.mutation(internal.bodyLibrary.retryParked, { limit: 0.5 })).toEqual({
      released: 1,
    });
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 0 });
    expect((await queueRow(t, bad))?.parkedAt).toBeUndefined();
    await expectCountsAreTheTally(t);
  });

  test('a moderator’s write on it still lands; once mended, its next audited write un-parks it', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const bad = await poison(t, 'Mended');
    await seedBody(t, { name: 'Bystander' });
    await backfill(t);
    // The backfill page went on past it; the bystander has its rows.
    expect((await t.query(internal.bodyLibrary.state, {})).corpus).toBe(1);
    await t.run((ctx) =>
      ctx.db
        .query('bodyLibraryQueue')
        .withIndex('by_body', (q) => q.eq('waterBodyId', bad))
        .first()
        .then((row) => row && ctx.db.patch(row._id, { parkedAt: NOW, attempts: 3 })),
    );
    await as.mutation(api.standing.setStanding, { waterBodyId: bad, standing: 'dormant' });
    expect((await t.run((ctx) => ctx.db.get(bad)))?.dormant?.reason).toBe('moderator');
    expect((await queueRow(t, bad))?.parkedAt).toBe(NOW);
    await t.run((ctx) => ctx.db.patch(bad, { polygon: square(0.01) }));
    await as.mutation(api.standing.setStanding, { waterBodyId: bad, standing: 'active' });
    expect(await queueRow(t, bad)).toBeNull();
    expect((await rowsOf(t, bad)).map((r) => r.lane)).toEqual(['active', 'active']);
    await expectCountsAreTheTally(t);
  });

  test('the drift repair passes a failing or parked body and moves on', async () => {
    const t = harness();
    const bad = await seedBody(t, { name: 'Soured' });
    const parked = await seedBody(t, { name: 'Parked' });
    await backfill(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(bad, { polygon: { type: 'Point', coordinates: [-72, 44] } as never });
      await ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: parked,
        queuedAt: NOW,
        attempts: 3,
        parkedAt: NOW,
      });
    });
    await seedReport(t, bad, NOW - DAY);
    vi.setSystemTime(NOW + 2 * DAY);
    expect(await t.mutation(internal.bodyLibrary.repairDrift, {})).toEqual({
      refreshed: 0,
      skipped: 1,
      failed: 1,
    });
    for (const id of [bad, parked]) {
      expect((await rowsOf(t, id))[0]?.refreshedAt).toBe(NOW + 2 * DAY);
    }
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 1 });
    // A parked body with rows is named from its library row.
    const admin = await seedUser(t, 'admin');
    const read = await admin.as.query(api.bodyLibrary.parked, {});
    expect(read.rows.map((r) => r.name)).toEqual(['Parked']);
    await expectCountsAreTheTally(t);
  });

  test('a run short of budget for another full refresh stops, and what it didn’t reach waits', async () => {
    const t = harness();
    const ids = [await seedBody(t, { name: 'Wait A' }), await seedBody(t, { name: 'Wait B' })];
    const spent = { used: 0, remaining: 0 };
    const low = {
      bytesRead: spent,
      bytesWritten: spent,
      databaseQueries: spent,
      documentsRead: spent,
      documentsWritten: spent,
      functionsScheduled: spent,
      scheduledFunctionArgsBytes: spent,
    };
    await t.run(async (ctx) => {
      await queueLibraryRefresh(ctx, ids);
      const starved = { ...ctx, meta: { ...ctx.meta, getTransactionMetrics: async () => low } };
      expect(await drainLibraryQueue(starved as typeof ctx, 10)).toEqual({
        refreshed: 0,
        failed: 0,
        more: true,
      });
      // A moderator's refresh in a spent transaction is queued, never attempted half-funded.
      expect(await refreshBodyLibrary(starved as typeof ctx, ids[0] as Id<'waterBodies'>)).toBe(
        false,
      );
    });
    expect((await t.query(internal.bodyLibrary.state, {})).queued).toBe(2);
    for (const id of ids) expect((await queueRow(t, id))?.attempts).toBeUndefined();
    expect(await t.mutation(internal.bodyLibrary.drainQueue, {})).toMatchObject({ refreshed: 2 });
  });

  test('a Changed owed by a body with no rows yet rides on its queue entry until the drain lands it', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const bad = await poison(t, 'Unrowed');
    await as.mutation(api.standing.setStanding, { waterBodyId: bad, standing: 'dormant' });
    expect(await rowsOf(t, bad)).toHaveLength(0);
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 1, changedAt: NOW });
    await t.run((ctx) => ctx.db.patch(bad, { polygon: square(0.01) }));
    expect(await t.mutation(internal.bodyLibrary.drainQueue, {})).toMatchObject({ refreshed: 1 });
    expect((await rowsOf(t, bad))[0]).toMatchObject({ changedAt: NOW, lane: 'moderator' });
  });

  test('an audited write past the inline cap releases a parked body to the queue', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const others: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 4; i++) others.push(await seedBody(t, { name: `Other ${i}` }));
    const bad = await seedBody(t, { name: 'Held' });
    await t.run(async (ctx) => {
      await ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: bad,
        queuedAt: NOW - DAY,
        attempts: 3,
        parkedAt: NOW - DAY,
      });
      for (const id of [...others, bad]) {
        await noteAuditedAction(ctx, {
          actorId: mod.id,
          targetType: 'waterbody',
          targetId: id,
          createdAt: NOW,
        });
      }
    });
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 0, queuedAt: NOW, changedAt: NOW });
    expect((await queueRow(t, bad))?.parkedAt).toBeUndefined();
  });

  test('an audited write in a transaction too spent to refresh still releases a parked body', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const held = await seedBody(t, { name: 'Held Inline' });
    await t.run(async (ctx) => {
      await ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: held,
        queuedAt: NOW - DAY,
        attempts: 3,
        parkedAt: NOW - DAY,
      });
      await noteAuditedAction(starved(ctx), {
        actorId: mod.id,
        targetType: 'waterbody',
        targetId: held,
        createdAt: NOW,
      });
    });
    expect(await queueRow(t, held)).toMatchObject({ attempts: 0, queuedAt: NOW, changedAt: NOW });
    expect((await queueRow(t, held))?.parkedAt).toBeUndefined();
  });

  test('a body that failed in this transaction stays parked when a spent writer meets it again', async () => {
    const t = harness();
    const bad = await poison(t, 'Twice');
    await t.run(async (ctx) => {
      await ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: bad,
        queuedAt: NOW - DAY,
        attempts: 3,
        parkedAt: NOW - DAY,
      });
      expect(await refreshBodyLibrary(ctx, bad, { unpark: true })).toBe(false);
      expect(await refreshBodyLibrary(ctx, bad, { unpark: true })).toBe(false);
    });
    expect(await queueRow(t, bad)).toMatchObject({ attempts: 4, parkedAt: NOW - DAY });
  });

  test('the parked read names a body with no row only while it can afford the body', async () => {
    const t = harness();
    const bad = await poison(t, 'Heavy');
    await t.run((ctx) =>
      ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: bad,
        queuedAt: NOW,
        attempts: 3,
        parkedAt: NOW,
      }),
    );
    const names = await t.run(async (ctx) => ({
      funded: (await parkedRows(ctx)).rows.map((r) => r.name),
      spent: (await parkedRows(starved(ctx))).rows.map((r) => r.name),
    }));
    expect(names).toEqual({ funded: ['Heavy'], spent: [null] });
  });

  test('the season turn closes a parked body’s rows on the new season, the counts moving with them', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Parked Last Winter' });
    await seedReport(t, id, NOW - DAY);
    await backfill(t);
    await t.run((ctx) =>
      ctx.db.insert('bodyLibraryQueue', {
        waterBodyId: id,
        queuedAt: NOW,
        attempts: 3,
        parkedAt: NOW,
      }),
    );
    vi.setSystemTime(Date.UTC(2027, 6, 2));
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toEqual({
      refreshed: 0,
      failed: 0,
      closed: 1,
    });
    for (const row of await rowsOf(t, id)) {
      expect(row).toMatchObject({ reports: 0, reportsCapped: false, reportsSeason: 2027 });
    }
    expect(await t.mutation(internal.bodyLibrary.turnSeason, {})).toMatchObject({ closed: 0 });
    await expectCountsAreTheTally(t);
  });

  test('a Changed left on the queue is written by whatever path refreshes the body next', async () => {
    const t = harness();
    const id = await seedBody(t, { name: 'Owed' });
    await t.run((ctx) => queueLibraryRefresh(ctx, [id], NOW, { changedAt: NOW - DAY }));
    // A report write refreshes it, not the drain: the owed stamp still lands, then the entry goes.
    await t.run((ctx) => recomputeBodySummary(ctx, id));
    expect((await rowsOf(t, id))[0]?.changedAt).toBe(NOW - DAY);
    expect(await queueRow(t, id)).toBeNull();
  });

  test('names an error by its class, never its message', () => {
    expect(errorClassOf(new ConvexError('a lake called Secret'))).toBe('ConvexError');
    expect(errorClassOf(new ConvexError({ refreshFailed: 'RangeError' }))).toBe('RangeError');
    expect(errorClassOf(new ConvexError({ refreshFailed: 'a lake called Secret' }))).toBe('Error');
    expect(errorClassOf(new ConvexError({ refreshFailed: 7 }))).toBe('Error');
    expect(errorClassOf(new TypeError('x'))).toBe('TypeError');
    const odd = new Error('y');
    odd.name = 'has spaces and words';
    expect(errorClassOf(odd)).toBe('Error');
    expect(errorClassOf('a string')).toBe('unknown');
  });
});

describe('Changed is never lost', () => {
  const queueEntry = (t: T, id: Id<'waterBodies'>) =>
    t.run((ctx) =>
      ctx.db
        .query('bodyLibraryQueue')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .first(),
    );

  test('the audit-log backfill stamps a body with no rows on its queue entry', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const id = await seedBody(t, { name: 'Rowless' });
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: id,
        reason: 'r',
        createdAt: NOW - DAY,
      }),
    );
    await t.mutation(internal.bodyLibrary.backfillChangedAt, {});
    expect(await rowsOf(t, id)).toHaveLength(0);
    expect((await queueEntry(t, id))?.changedAt).toBe(NOW - DAY);
    await t.mutation(internal.bodyLibrary.drainQueue, {});
    expect((await rowsOf(t, id))[0]?.changedAt).toBe(NOW - DAY);
  });

  test('a rowless body the backfill stamps joins the queue from now, behind what already waits', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const waiting = await seedBody(t, { name: 'Waiting' });
    const rowless = await seedBody(t, { name: 'Long Ago' });
    await t.run((ctx) => queueLibraryRefresh(ctx, [waiting], NOW - 60_000));
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: rowless,
        reason: 'r',
        createdAt: NOW - 90 * DAY,
      }),
    );
    await t.mutation(internal.bodyLibrary.backfillChangedAt, {});
    expect(await queueEntry(t, rowless)).toMatchObject({
      queuedAt: NOW,
      changedAt: NOW - 90 * DAY,
    });
    // The oldest-first drain takes the body that was already waiting first.
    await t.run((ctx) => drainLibraryQueue(ctx, 1));
    expect(await queueEntry(t, waiting)).toBeNull();
    expect(await queueEntry(t, rowless)).not.toBeNull();
  });

  test('a failure, a parking and a release each keep the owed Changed', async () => {
    const t = harness();
    const id = await seedBody(t, {
      name: 'Owing',
      polygon: { type: 'Point', coordinates: [-72, 44] } as never,
    });
    await seedReport(t, id, NOW - DAY);
    await t.run((ctx) => queueLibraryRefresh(ctx, [id], NOW, { changedAt: NOW - 2 * DAY }));
    for (let i = 0; i < MAX_REFRESH_ATTEMPTS; i++)
      await t.mutation(internal.bodyLibrary.drainQueue, {});
    expect(await queueEntry(t, id)).toMatchObject({ parkedAt: NOW, changedAt: NOW - 2 * DAY });
    await t.mutation(internal.bodyLibrary.retryParked, {});
    expect(await queueEntry(t, id)).toMatchObject({ attempts: 0, changedAt: NOW - 2 * DAY });
    await t.run((ctx) => ctx.db.patch(id, { polygon: square(0.01) }));
    await t.mutation(internal.bodyLibrary.drainQueue, {});
    expect((await rowsOf(t, id))[0]?.changedAt).toBe(NOW - 2 * DAY);
    expect(await queueEntry(t, id)).toBeNull();
  });

  test('(property) across any interleaving of audited writes, report writes, backfill pages and drains, Changed is never earlier than the latest moderator action', async () => {
    const op = fc.constantFrom(
      'audit',
      'auditStarved',
      'report',
      'backfill',
      'drain',
      'poison',
      'mend',
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
        const t = harness();
        const mod = await seedUser(t);
        const id = await seedBody(t, { name: 'Interleaved' });
        await seedReport(t, id, NOW - DAY);
        let latest: number | undefined;
        let clock = NOW;
        for (const kind of ops) {
          clock += 60_000;
          vi.setSystemTime(clock);
          switch (kind) {
            case 'audit':
            case 'auditStarved':
              latest = clock;
              await t.run((ctx) =>
                noteAuditedAction(kind === 'audit' ? ctx : starved(ctx), {
                  actorId: mod.id,
                  targetType: 'waterbody',
                  targetId: id,
                  createdAt: clock,
                }),
              );
              break;
            case 'report':
              await t.run((ctx) => recomputeBodySummary(ctx, id));
              break;
            case 'backfill':
              await t.mutation(internal.bodyLibrary.backfill, {});
              break;
            case 'drain':
              await t.mutation(internal.bodyLibrary.drainQueue, {});
              break;
            case 'poison':
              await t.run((ctx) =>
                ctx.db.patch(id, { polygon: { type: 'Point', coordinates: [-72, 44] } as never }),
              );
              break;
            case 'mend':
              await t.run((ctx) => ctx.db.patch(id, { polygon: square(0.01) }));
              break;
          }
          if (latest === undefined) continue;
          const rows = await rowsOf(t, id);
          if (rows.length > 0) {
            for (const r of rows) expect(r.changedAt ?? -1).toBeGreaterThanOrEqual(latest);
          } else {
            expect((await queueEntry(t, id))?.changedAt ?? -1).toBeGreaterThanOrEqual(latest);
          }
        }
      }),
      { numRuns: 25 },
    );
  });
});

describe('the list’s arguments, normalized once at the edge', () => {
  test('facets: repeated, unknown, empty and oversized input each come to one canonical selection', () => {
    expect(cleanFacets({ size: ['1000-up', '10-100', '1000-up'] })).toEqual({
      size: ['10-100', '1000-up'],
    });
    expect(cleanFacets({ size: ['huge'], class: [] })).toEqual({});
    expect(cleanFacets({ class: ['Bay', 'bay'] })).toEqual({ class: ['bay'] });
    const flood = [...Array.from({ length: 40 }, () => 'nope'), 'bay'];
    // Read from the first 32 raw entries only: an option past them is not reached.
    expect(cleanFacets({ class: flood })).toEqual({});
    expect(cleanFacets(undefined)).toEqual({});
  });
  test('state: any case, else All; search: trimmed, bounded, none under two characters', () => {
    expect(scopeOf(' vt ')).toBe('VT');
    expect(scopeOf('Vermont')).toBe('*');
    expect(scopeOf('')).toBe('*');
    expect(scopeOf(undefined)).toBe('*');
    expect(searchOf('  lake  ')).toBe('lake');
    expect(searchOf(' l ')).toBe('');
    expect(searchOf('x'.repeat(500))).toHaveLength(100);
  });
  test('the page and its counts read one query', () => {
    const q = listQueryOf({
      state: 'nh',
      q: '  pond ',
      facets: { size: ['under-10', 'under-10'] },
    });
    expect(q).toMatchObject({ scope: 'NH', q: 'pond', selection: { size: ['under-10'] } });
    expect(Number.isFinite(listQueryOf({ now: Number.NaN }).now)).toBe(true);
  });
  test('an oversized first page is held to the library’s most', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    await seedBody(t, { name: 'One' });
    await backfill(t);
    const res = await as.query(api.bodies.listPage, {
      lane: 'active',
      paginationOpts: { numItems: 1e9, cursor: null },
    });
    expect(res.page).toHaveLength(1);
  });

  test('(property) with at most one facet applied, the summary’s total is the rows the pages yield', async () => {
    const body = fc.record({
      type: fc.constantFrom('lakePond', 'bay', 'reservoir'),
      acres: fc.option(fc.constantFrom(4, 40, 400, 4_000), { nil: undefined }),
      states: fc.subarray(['VT', 'NH']),
      boosted: fc.boolean(),
    });
    const facetPick = fc.oneof(
      fc.constant({}),
      fc
        .tuple(
          fc.constantFrom('class', 'size', 'outline', 'putins', 'reports', 'complete'),
          fc.array(
            fc.constantFrom(
              'lakePond',
              'bay',
              'under-10',
              '1000-up',
              'catalog',
              'none',
              'never',
              'under-8',
              'junk',
            ),
            { maxLength: 6 },
          ),
        )
        .map(([facet, options]) => ({ [facet]: options })),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(body, { maxLength: 7 }),
        facetPick,
        fc.constantFrom(undefined, 'vt', 'NH'),
        async (bodies, facets, state) => {
          const t = harness();
          const { as } = await seedUser(t);
          let n = 0;
          for (const b of bodies) {
            await seedBody(t, {
              name: `Body ${n++}`,
              type: b.type as 'lakePond',
              states: b.states,
              ...(b.acres !== undefined ? { surfaceAreaSqM: b.acres * ACRE } : {}),
              ...(b.boosted ? { curatedBoost: 0.2 } : {}),
            });
          }
          await backfill(t);
          const args = { lane: 'active' as const, facets, ...(state ? { state } : {}) };
          const summary = await as.query(api.bodies.listSummary, args);
          let rows = 0;
          let cursor: string | null = null;
          for (let i = 0; i < 20; i++) {
            const res: { page: unknown[]; isDone: boolean; continueCursor: string } =
              await as.query(api.bodies.listPage, {
                ...args,
                paginationOpts: { numItems: 3, cursor },
              });
            rows += res.page.length;
            if (res.isDone) break;
            cursor = res.continueCursor;
          }
          expect(summary.total).toEqual({ count: rows, capped: false });
        },
      ),
      { numRuns: 15 },
    );
  });
});
