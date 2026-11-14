/**
 * **The geometry facts jobs** (B01-3b): recompute a body's touching bodies and places when they are
 * stale, in an action — the honest home for work whose cost grows with an outline (a query or a
 * mutation has one second; the largest dev lake's touching test alone took more). Reads go through
 * small internal queries, the answer through one mutation that keeps it only for the outline it was
 * computed for. See `lib/bodyGeo.ts`.
 *
 * ## After deploy, in order
 *
 * 1. `bodyGeo:seedAll` — marks every library body stale, paged and resumable.
 * 2. `bodyGeo:computeAll` — recomputes every stale body, chaining itself until none is left. Until a
 *    body is computed, its reads say `null` ("not computed").
 */

import { allLevels, bboxIntersects, cellForPoint, pointInPolygon } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server';
import { placeSamplePoints } from './adminAreas';
import { nextAttemptState } from './lib/attempts';
import {
  coverTiles,
  markGeoStale,
  outlineStamp,
  paddedBox,
  simplifiedRing,
  TOUCH_CANDIDATES,
  touches,
  vertexCount,
} from './lib/bodyGeo';
import { ADMIN_AREA_LADDER } from './lib/cellIndex';
import { bodiesCoveringBox } from './waterBodies';

type Geom = Polygon | MultiPolygon;
type Box = { minLat: number; minLng: number; maxLat: number; maxLng: number };
const boxV = v.object({
  minLat: v.number(),
  minLng: v.number(),
  maxLat: v.number(),
  maxLng: v.number(),
});
const pointV = v.object({ lat: v.number(), lng: v.number() });

/** Above this many vertices a candidate's outline is not returned whole (only its samples count). */
const WHOLE_MAX_VERTICES = 20_000;
/** Candidate rows one tile's cover reads. */
const TILE_LIMIT = TOUCH_CANDIDATES + 1;
/** Admin-area candidate rows one cell may give, as `findContainingArea` reads them. */
const AREA_CELL_CAP = 64;

// ── The reads the action makes ───────────────────────────────────────────────────────────────

/** What the action needs of the body: its outline, box, stamp and place sample points. */
export const inputs = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.dedupStatus === 'merged') return null;
    return {
      stamp: outlineStamp(body),
      polygon: body.polygon,
      bbox: body.bbox,
      places: placeSamplePoints(body),
    };
  },
});

/**
 * One tile's candidates: the most prominent listed bodies whose cells cover it (the map's cover,
 * whole at every rung because the tile fits), each with its outline — or, past
 * {@link WHOLE_MAX_VERTICES}, without it — and whether the cover stopped short.
 */
export const candidates = internalQuery({
  args: { box: boxV },
  handler: async (ctx, { box }) => {
    const near = await bodiesCoveringBox(ctx, box, { limit: TILE_LIMIT });
    return {
      truncated: near.truncated,
      bodies: [...near.byId.values()].map((b) => {
        const geom = b.polygon as unknown as Geom;
        const whole = vertexCount(geom) <= WHOLE_MAX_VERTICES;
        return {
          id: b._id,
          name: b.name,
          prominence: b.displayScore ?? 0,
          bbox: b.bbox,
          whole,
          polygon: whole ? b.polygon : null,
          ring: simplifiedRing(geom),
        };
      }),
    };
  },
});

/**
 * The admin areas whose cells hold each point, by level — the action tests containment. Read the way
 * `findContainingArea` reads them (each rung's cell, capped), so the two agree on candidates.
 */
export const areaCandidates = internalQuery({
  args: { points: v.array(pointV) },
  handler: async (ctx, { points }) => {
    const areas = new Map<string, Doc<'adminAreas'>>();
    const perPoint: { town: string[]; county: string[] }[] = [];
    for (const point of points.slice(0, 16)) {
      const ids: { town: string[]; county: string[] } = { town: [], county: [] };
      for (const level of ['town', 'county'] as const) {
        for (const z of allLevels(ADMIN_AREA_LADDER)) {
          const cell = cellForPoint(point, z);
          const rows = await ctx.db
            .query('adminAreaCells')
            .withIndex('by_cell', (q) =>
              q.eq('z', cell.z).eq('x', cell.x).eq('y', cell.y).eq('level', level),
            )
            .take(AREA_CELL_CAP);
          for (const row of rows) {
            if (!areas.has(row.adminAreaId)) {
              const area = await ctx.db.get(row.adminAreaId);
              if (area) areas.set(row.adminAreaId, area);
            }
            if (areas.has(row.adminAreaId)) ids[level].push(row.adminAreaId);
          }
        }
      }
      perPoint.push(ids);
    }
    return {
      perPoint,
      areas: [...areas.values()].map((a) => ({
        id: a._id as string,
        name: a.name,
        state: a.state,
        bbox: a.bbox,
        polygon: a.polygon,
      })),
    };
  },
});

// ── The pure work the action does ────────────────────────────────────────────────────────────

/** The places the sample points fall in: towns (the interior point's first), counties, states. */
export function placesFrom(
  points: readonly { lat: number; lng: number }[],
  found: {
    perPoint: { town: string[]; county: string[] }[];
    areas: { id: string; name: string; state: string; bbox: Box; polygon: unknown }[];
  },
): { towns: string[]; counties: string[]; states: string[] } {
  const byId = new Map(found.areas.map((a) => [a.id, a]));
  const towns: string[] = [];
  const counties: string[] = [];
  const states = new Set<string>();
  points.forEach((point, i) => {
    for (const level of ['town', 'county'] as const) {
      // Counties are large and a body rarely spans two: read at the interior point only.
      if (level === 'county' && i > 0) continue;
      const ids = found.perPoint[i]?.[level] ?? [];
      const hit = ids
        .map((id) => byId.get(id))
        .find(
          (a) =>
            a !== undefined &&
            bboxIntersects(a.bbox, {
              minLat: point.lat,
              maxLat: point.lat,
              minLng: point.lng,
              maxLng: point.lng,
            }) &&
            pointInPolygon(point, a.polygon as Geom),
        );
      if (hit === undefined) continue;
      const list = level === 'town' ? towns : counties;
      if (!list.includes(hit.name)) list.push(hit.name);
      states.add(hit.state);
    }
  });
  return { towns, counties, states: [...states] };
}

// ── The write ────────────────────────────────────────────────────────────────────────────────

const neighborV = v.object({
  waterBodyId: v.id('waterBodies'),
  name: v.string(),
  ring: v.array(v.array(v.number())),
});

/**
 * Store a body's computed facts — only if the outline they were computed for is still its own (else
 * it stays stale for the next run). A body whose relation to this one moved (newly touching, or no
 * longer) is marked stale, so the relation is kept on both sides. A body gone or merged loses its
 * facts. Clears its attempts (progress).
 */
export const store = internalMutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    stamp: v.string(),
    neighbors: v.array(neighborV),
    neighborsCapped: v.boolean(),
    towns: v.array(v.string()),
    counties: v.array(v.string()),
    states: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', args.waterBodyId))
      .first();
    const body = await ctx.db.get(args.waterBodyId);
    if (!body || body.dedupStatus === 'merged') {
      if (row) {
        await markGeoStale(
          ctx,
          (row.neighbors ?? []).map((n) => n.waterBodyId),
          now,
        );
        await ctx.db.delete(row._id);
      }
      return { stored: false };
    }
    if (outlineStamp(body) !== args.stamp) return { stored: false };
    const before = new Set((row?.neighbors ?? []).map((n) => n.waterBodyId as string));
    const after = new Set(args.neighbors.map((n) => n.waterBodyId as string));
    const moved = [...before, ...after].filter((id) => before.has(id) !== after.has(id));
    const clear = nextAttemptState(row ?? {}, { kind: 'progress' }, now) ?? {};
    const fields = {
      staleAt: undefined,
      computedAt: now,
      stamp: args.stamp,
      neighbors: args.neighbors,
      neighborsCapped: args.neighborsCapped,
      towns: args.towns,
      counties: args.counties,
      states: args.states,
      ...clear,
    };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert('bodyGeoFacts', { waterBodyId: args.waterBodyId, ...fields });
    // A neighbor whose relation moved is recomputed — unless it is gone or merged away, which has
    // no facts to keep (marking it would leave a stale row no computation clears).
    const live: Id<'waterBodies'>[] = [];
    for (const id of moved as Id<'waterBodies'>[]) {
      const other = await ctx.db.get(id);
      if (other && other.dedupStatus !== 'merged') live.push(id);
    }
    await markGeoStale(ctx, live, now);
    return { stored: true };
  },
});

/** Record a failed computation (`lib/attempts.ts`): one more attempt, its class, parked at the last. */
export const recordFailure = internalMutation({
  args: { waterBodyId: v.id('waterBodies'), errorClass: v.string(), byDailyRetry: v.boolean() },
  handler: async (ctx, { waterBodyId, errorClass, byDailyRetry }) => {
    const row = await ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
      .first();
    if (!row) return;
    const next = nextAttemptState(
      row,
      { kind: 'failed', errorClass, ...(byDailyRetry ? { byDailyRetry } : {}) },
      Date.now(),
    );
    if (next) await ctx.db.patch(row._id, next);
  },
});

// ── The runs ─────────────────────────────────────────────────────────────────────────────────

/** Bodies due: unparked and stale, oldest first — or, for the daily retry, parked ones. */
export const due = internalQuery({
  args: { limit: v.number(), parked: v.boolean() },
  handler: async (ctx, { limit, parked }) => {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = parked
      ? await ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_parked', (q) => q.gt('parkedAt', 0))
          .take(n)
      : await ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_parked_stale', (q) => q.eq('parkedAt', undefined).gt('staleAt', 0))
          .take(n);
    return rows.map((r) => r.waterBodyId);
  },
});

/** Compute one body's facts in the action, start to finish. Throws on a failure the caller records. */
async function computeOne(ctx: ActionCtx, waterBodyId: Id<'waterBodies'>): Promise<void> {
  const input = await ctx.runQuery(internal.bodyGeo.inputs, { waterBodyId });
  if (input === null) {
    // Gone or merged: the store drops its facts.
    await ctx.runMutation(internal.bodyGeo.store, {
      waterBodyId,
      stamp: '',
      neighbors: [],
      neighborsCapped: false,
      towns: [],
      counties: [],
      states: [],
    });
    return;
  }
  const geom = input.polygon as unknown as Geom;
  const padded = paddedBox(input.bbox);
  const { tiles, truncated: tilesTruncated } = coverTiles(padded);
  const seen = new Map<string, Awaited<ReturnType<typeof runTile>>['bodies'][number]>();
  let coverTruncated = tilesTruncated;
  async function runTile(box: Box) {
    return ctx.runQuery(internal.bodyGeo.candidates, { box });
  }
  for (const tile of tiles) {
    const got = await runTile(tile);
    if (got.truncated) coverTruncated = true;
    for (const b of got.bodies) if (b.id !== waterBodyId) seen.set(b.id, b);
  }
  const ranked = [...seen.values()]
    .filter((b) => bboxIntersects(b.bbox, padded))
    .sort((a, b) => b.prominence - a.prominence);
  const tested = ranked.slice(0, TOUCH_CANDIDATES);
  const neighbors = tested
    .filter((b) =>
      touches(geom, (b.polygon ?? { type: 'Polygon', coordinates: [b.ring] }) as Geom, b.whole),
    )
    .map((b) => ({ waterBodyId: b.id, name: b.name, ring: b.ring }));
  const found = await ctx.runQuery(internal.bodyGeo.areaCandidates, { points: input.places });
  const places = placesFrom(input.places, found);
  await ctx.runMutation(internal.bodyGeo.store, {
    waterBodyId,
    stamp: input.stamp,
    neighbors,
    neighborsCapped: coverTruncated || ranked.length > TOUCH_CANDIDATES,
    ...places,
  });
}

/** An error's class for the attempts record — its kind only, never its message. */
export function errorClassOf(err: unknown): string {
  if (err instanceof ConvexError) return 'ConvexError';
  if (err instanceof Error) return /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
  return 'unknown';
}

/** Bodies one run takes, and how many at once. */
const RUN_BATCH = 60;
/** The most due bodies one pass looks through, past the ones this run already tried. */
const DUE_WINDOW = 200;
const CONCURRENCY = 6;
/** A run hands over before an action's limit. */
const RUN_MS = 4 * 60_000;

/**
 * **Recompute the due bodies**: up to {@link RUN_BATCH} a pass, {@link CONCURRENCY} at a time, each
 * isolated — a body that fails is recorded (`lib/attempts.ts`) and the rest go on; parked bodies wait
 * for the daily retry (`parked: true`), which walks them the same way. **A run tries each body at
 * most once**, so a failure counts one attempt per run, never three in a row; every pass tries at
 * least one body it hasn't, so a run always ends. With `chain`, a run past its time hands on to a
 * fresh one until none is due.
 *
 * `done` is `false` when the run stopped with bodies still due: its time ran out, its batch filled
 * (without `chain`), or every due body it can see ({@link DUE_WINDOW}) already failed in this run —
 * the next run (the cron's, or the day's) takes them, a fresh attempt each.
 */
export const computeDue = internalAction({
  args: { parked: v.optional(v.boolean()), chain: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { parked = false, chain = false },
  ): Promise<{ computed: number; failed: number; done: boolean }> => {
    const started = Date.now();
    let computed = 0;
    let failed = 0;
    const tried = new Set<string>();
    for (;;) {
      const ask = Math.min(DUE_WINDOW, RUN_BATCH + tried.size);
      const seen: Id<'waterBodies'>[] = await ctx.runQuery(internal.bodyGeo.due, {
        limit: ask,
        parked,
      });
      const ids = seen.filter((id) => !tried.has(id)).slice(0, RUN_BATCH);
      if (ids.length === 0) return { computed, failed, done: seen.length < ask };
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const slice = ids.slice(i, i + CONCURRENCY);
        for (const id of slice) tried.add(id);
        const results = await Promise.allSettled(slice.map((id) => computeOne(ctx, id)));
        for (const [j, r] of results.entries()) {
          if (r.status === 'fulfilled') {
            computed++;
          } else {
            failed++;
            await ctx.runMutation(internal.bodyGeo.recordFailure, {
              waterBodyId: slice[j] as Id<'waterBodies'>,
              errorClass: errorClassOf(r.reason),
              byDailyRetry: parked,
            });
          }
        }
      }
      if (Date.now() - started > RUN_MS) {
        if (chain) await ctx.scheduler.runAfter(0, internal.bodyGeo.computeDue, { parked, chain });
        return { computed, failed, done: false };
      }
      if (!chain && computed + failed >= RUN_BATCH) return { computed, failed, done: false };
    }
  },
});

/** Every stale body, chained until none is due — the backfill's second step. */
export const computeAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ started: true }> => {
    await ctx.scheduler.runAfter(0, internal.bodyGeo.computeDue, { chain: true });
    return { started: true };
  },
});

/** Library rows one seeding page reads (small rows, about a megabyte). */
const SEED_PAGE = 1_000;

/** Mark every library body stale, a page at a time, chaining itself — the backfill's first step. */
export const seedAll = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_scope_name', (q) => q.eq('scope', '*'))
      .paginate({ cursor: cursor ?? null, numItems: SEED_PAGE });
    await markGeoStale(
      ctx,
      page.page.map((r) => r.waterBodyId),
    );
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bodyGeo.seedAll, { cursor: page.continueCursor });
    }
    return { marked: page.page.length, isDone: page.isDone };
  },
});
