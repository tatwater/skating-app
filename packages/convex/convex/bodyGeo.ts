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
  type MutationCtx,
  type QueryCtx,
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
import {
  clearFailure,
  mirrorFailure,
  recordFailure as recordJobFailure,
} from './lib/recurringWork';
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

/**
 * What the action needs of the body: its outline, box, stamp and place sample points — and its stale
 * mark as it stands now, so the store can tell a mark that arrives while the body is computed.
 */
export const inputs = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.dedupStatus === 'merged') return null;
    const facts = await ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
      .first();
    return {
      stamp: outlineStamp(body),
      staleAt: facts?.staleAt ?? null,
      areasAt: await latestAreasMark(ctx),
      polygon: body.polygon,
      bbox: body.bbox,
      places: placeSamplePoints(body),
    };
  },
});

/**
 * One tile's candidates: the most prominent listed bodies whose cells cover it (the map's cover,
 * whole at every rung because the tile fits), each with its outline — or, past
 * {@link WHOLE_MAX_VERTICES}, without it — and whether the cover stopped short. `skip` names bodies
 * the caller already holds (the body itself, and the candidates earlier tiles returned): they still
 * count against the tile's limit, but their outlines are not shipped again.
 */
export const candidates = internalQuery({
  args: { box: boxV, skip: v.optional(v.array(v.id('waterBodies'))) },
  handler: async (ctx, { box, skip }) => {
    const near = await bodiesCoveringBox(ctx, box, { limit: TILE_LIMIT });
    const known = new Set<string>(skip ?? []);
    return {
      truncated: near.truncated,
      bodies: [...near.byId.values()]
        .filter((b) => !known.has(b._id))
        .map((b) => {
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
            stamp: outlineStamp(b),
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

/**
 * **The places a body lies in** — the one rule (it replaced `adminAreas.townsForBody`): towns (the
 * interior point's first), counties (at the interior point only) and states, read at
 * `placeSamplePoints`. **Sampled, not a polygon overlay**: a town the shore only grazes between two
 * samples can be missed, and a body is never placed in a town it doesn't touch. Empty lists when no
 * boundary holds any point — computed and in none, which the reads tell from "not computed".
 */
export function placesFrom(
  points: readonly { lat: number; lng: number }[],
  found: {
    perPoint: { town: string[]; county: string[] }[];
    areas: { id: string; name: string; state: string; bbox: Box; polygon: unknown }[];
  },
): { towns: string[]; townStates: string[]; counties: string[]; states: string[] } {
  const byId = new Map(found.areas.map((a) => [a.id, a]));
  const towns: string[] = [];
  // Each town's state, in the same order (B01-3c): a border lake's towns are in two states.
  const townStates: string[] = [];
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
      if (!list.includes(hit.name)) {
        list.push(hit.name);
        if (level === 'town') townStates.push(hit.state);
      }
      states.add(hit.state);
    }
  });
  return { towns, townStates, counties, states: [...states] };
}

// ── The write ────────────────────────────────────────────────────────────────────────────────

const neighborV = v.object({
  waterBodyId: v.id('waterBodies'),
  name: v.string(),
  ring: v.array(v.array(v.number())),
  stamp: v.string(),
});

/** The newest places-layer mark (`geoInputMarks`), or 0 when the layer never changed since. */
export async function latestAreasMark(ctx: QueryCtx): Promise<number> {
  const mark = await ctx.db
    .query('geoInputMarks')
    .withIndex('by_input_at', (q) => q.eq('input', 'adminAreas'))
    .order('desc')
    .first();
  return mark?.at ?? 0;
}

/** Holders {@link markHolders} marks inline; past this many, a chained job marks them all. */
export const FANOUT_INLINE = 25;
/** Holders one {@link fanOut} page marks. */
const FANOUT_PAGE = 200;
/** The most links one body holds — twelve neighbors, with room. */
const LINKS_PER_BODY = 32;

/**
 * **Mark every body that holds a copy of this one's outline** (`bodyGeoLinks.by_neighbor`) — called
 * when its outline's stamp changed, or it is gone. Up to {@link FANOUT_INLINE} inline; past that, a
 * chained job pages them all, so a lake held by hundreds of ponds never fans out unbounded in one
 * mutation. Terminates: a holder's recompute fans out only if *its own* stamp changed.
 */
async function markHolders(ctx: MutationCtx, neighborId: Id<'waterBodies'>, now: number) {
  const holders = await ctx.db
    .query('bodyGeoLinks')
    .withIndex('by_neighbor', (q) => q.eq('neighborId', neighborId))
    .take(FANOUT_INLINE + 1);
  if (holders.length > FANOUT_INLINE) {
    await ctx.scheduler.runAfter(0, internal.bodyGeo.fanOut, { neighborId });
    return;
  }
  await markGeoStale(
    ctx,
    holders.map((l) => l.waterBodyId),
    now,
  );
}

/** One page of a fan-out too wide to mark inline, chaining to the end. */
export const fanOut = internalMutation({
  args: { neighborId: v.id('waterBodies'), cursor: v.optional(v.string()) },
  handler: async (ctx, { neighborId, cursor }) => {
    const page = await ctx.db
      .query('bodyGeoLinks')
      .withIndex('by_neighbor', (q) => q.eq('neighborId', neighborId))
      .paginate({ cursor: cursor ?? null, numItems: FANOUT_PAGE });
    await markGeoStale(
      ctx,
      page.page.map((l) => l.waterBodyId),
    );
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bodyGeo.fanOut, {
        neighborId,
        cursor: page.continueCursor,
      });
    }
    return { marked: page.page.length, isDone: page.isDone };
  },
});

/** Replace a body's links with the neighbors it now holds (at most twelve). */
async function writeLinks(
  ctx: MutationCtx,
  holder: Id<'waterBodies'>,
  neighbors: readonly { waterBodyId: Id<'waterBodies'>; stamp: string }[],
) {
  const old = await ctx.db
    .query('bodyGeoLinks')
    .withIndex('by_holder', (q) => q.eq('waterBodyId', holder))
    .take(LINKS_PER_BODY);
  const want = new Map(neighbors.map((n) => [n.waterBodyId as string, n.stamp]));
  for (const link of old) {
    if (want.get(link.neighborId) === link.neighborStamp) want.delete(link.neighborId);
    else await ctx.db.delete(link._id);
  }
  for (const [neighborId, neighborStamp] of want) {
    await ctx.db.insert('bodyGeoLinks', {
      waterBodyId: holder,
      neighborId: neighborId as Id<'waterBodies'>,
      neighborStamp,
    });
  }
}

/**
 * Store a body's computed facts — only if the outline they were computed for is still its own (else
 * it stays stale for the next run). A body whose relation to this one moved (newly touching, or no
 * longer) is marked stale, so the relation is kept on both sides. A mark that arrived after the inputs
 * were read (`staleAt` moved past the one they saw) keeps the body stale: the answer is stored and the
 * next run recomputes it. A body gone or merged loses its facts. Clears its attempts (progress).
 */
export const store = internalMutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    stamp: v.string(),
    /** The stale mark the inputs were read under (`inputs.staleAt`); `null` when there was none. */
    staleAt: v.union(v.number(), v.null()),
    neighbors: v.array(neighborV),
    neighborsCapped: v.boolean(),
    towns: v.array(v.string()),
    /** Each town's state, in `towns`' order. */
    townStates: v.optional(v.array(v.string())),
    counties: v.array(v.string()),
    states: v.array(v.string()),
    /** The places-layer mark the places were computed under (`inputs.areasAt`). */
    areasAt: v.number(),
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
      // Gone: its links go, and every body holding its outline drops it on recompute.
      await writeLinks(ctx, args.waterBodyId, []);
      await clearFailure(ctx, 'bodyGeo', args.waterBodyId);
      await markHolders(ctx, args.waterBodyId, now);
      return { stored: false };
    }
    if (outlineStamp(body) !== args.stamp) return { stored: false };
    const before = new Set((row?.neighbors ?? []).map((n) => n.waterBodyId as string));
    const after = new Set(args.neighbors.map((n) => n.waterBodyId as string));
    const moved = [...before, ...after].filter((id) => before.has(id) !== after.has(id));
    const clear = nextAttemptState(row ?? {}, { kind: 'progress' }, now) ?? {};
    if (row?.attempts !== undefined || row?.parkedAt !== undefined) {
      await clearFailure(ctx, 'bodyGeo', args.waterBodyId);
    }
    // Marked again while this was computed: an outline or a neighbor's relation moved since the
    // inputs were read, so this answer may already be behind — kept stale for the next run.
    const markedSince =
      row?.staleAt !== undefined && (args.staleAt === null || row.staleAt > args.staleAt)
        ? row.staleAt
        : undefined;
    const fields = {
      staleAt: markedSince,
      computedAt: now,
      checkedAt: now,
      areasAt: args.areasAt,
      stamp: args.stamp,
      neighbors: args.neighbors,
      neighborsCapped: args.neighborsCapped,
      towns: args.towns,
      townStates: args.townStates ?? [],
      counties: args.counties,
      states: args.states,
      ...clear,
    };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert('bodyGeoFacts', { waterBodyId: args.waterBodyId, ...fields });
    await writeLinks(ctx, args.waterBodyId, args.neighbors);
    // Its outline changed since its last answer: every body that holds a copy of it is behind. Only
    // this body's own stamp moving fans out, so a holder's recompute (its stamp unchanged) ends there.
    if (row?.stamp !== undefined && row.stamp !== args.stamp) {
      await markHolders(ctx, args.waterBodyId, now);
    }
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
    const now = Date.now();
    const next = nextAttemptState(
      row,
      { kind: 'failed', errorClass, ...(byDailyRetry ? { byDailyRetry } : {}) },
      now,
    );
    if (next) {
      await ctx.db.patch(row._id, next);
      // Mirrored for Machinery's health read, which counts small rows only (B01-3c, D258).
      await mirrorFailure(ctx, 'bodyGeo', waterBodyId, next, now);
    }
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

/** One candidate as {@link candidates} returns it. */
type Candidate = {
  id: Id<'waterBodies'>;
  name: string;
  prominence: number;
  bbox: Box;
  whole: boolean;
  polygon: unknown;
  ring: [number, number][];
  stamp: string;
};

/** Compute one body's facts in the action, start to finish. Throws on a failure the caller records. */
async function computeOne(ctx: ActionCtx, waterBodyId: Id<'waterBodies'>): Promise<void> {
  const input = await ctx.runQuery(internal.bodyGeo.inputs, { waterBodyId });
  if (input === null) {
    // Gone or merged: the store drops its facts.
    await ctx.runMutation(internal.bodyGeo.store, {
      waterBodyId,
      stamp: '',
      staleAt: null,
      neighbors: [],
      neighborsCapped: false,
      towns: [],
      counties: [],
      states: [],
      areasAt: 0,
    });
    return;
  }
  const geom = input.polygon as unknown as Geom;
  const padded = paddedBox(input.bbox);
  const { tiles, truncated: tilesTruncated } = coverTiles(padded);
  const seen = new Map<Id<'waterBodies'>, Candidate>();
  let coverTruncated = tilesTruncated;
  async function runTile(box: Box): Promise<{ truncated: boolean; bodies: Candidate[] }> {
    // The body and the candidates already held still count against the tile's limit, but their
    // outlines are not read back again: a giant is a candidate in every one of its tiles.
    return ctx.runQuery(internal.bodyGeo.candidates, {
      box,
      skip: [waterBodyId, ...seen.keys()],
    });
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
    .map((b) => ({ waterBodyId: b.id, name: b.name, ring: b.ring, stamp: b.stamp }));
  const found = await ctx.runQuery(internal.bodyGeo.areaCandidates, { points: input.places });
  const places = placesFrom(input.places, found);
  await ctx.runMutation(internal.bodyGeo.store, {
    waterBodyId,
    stamp: input.stamp,
    staleAt: input.staleAt,
    neighbors,
    neighborsCapped: coverTruncated || ranked.length > TOUCH_CANDIDATES,
    ...places,
    areasAt: input.areasAt,
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
 * (without `chain`, and never for the daily retry, which walks every parked body while its time
 * lasts), or every due body it can see ({@link DUE_WINDOW}) already failed in this run — the next run
 * (the cron's, or the day's) takes them, a fresh attempt each.
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
      // The cron's run stops at a batch; the daily retry walks every parked body while its time lasts
      // (one it fails is re-stamped to the back, so each pass's due list starts with untried ones).
      if (!chain && !parked && computed + failed >= RUN_BATCH) {
        return { computed, failed, done: false };
      }
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

/**
 * Library rows one seeding page reads. Each marks a facts row, read and rewritten whole — up to twelve
 * neighbors' rings, ~16 KB — so a page of re-seeded bodies stays a few megabytes inside a mutation's
 * 16 MiB read and write budgets.
 */
export const SEED_PAGE = 250;

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

// ── The drift repair ─────────────────────────────────────────────────────────────────────────

/** Earlier drift failures one tick reads, to clear the rows that now go through. */
const DRIFT_FAILURES_READ = 200;
/** Facts rows one drift tick checks at most. */
export const DRIFT_BATCH = 40;
/** Read budget a drift tick keeps back: each check reads a body, up to its 1 MiB outline. */
const DRIFT_BYTES_RESERVE = 2 * 1024 * 1024;
/** Library rows one missing-row page reads (small documents; one index probe each). */
export const MISSING_PAGE = 500;

/**
 * **The self-healing net** for a write the marks missed: the computed rows checked longest ago, each
 * against what it was computed from — the body (gone or merged, or its outline's stamp moved), the
 * places layer (a mark newer than `areasAt`), and each outline it holds a copy of (a neighbor's
 * current answer was cut from a different outline than the held ring). A row that is behind is marked
 * stale; every row checked is stamped `checkedAt`, so the tick walks the whole table and starts over.
 * Bounded by {@link DRIFT_BATCH} and the read budget; a row it can't afford is left for the next tick.
 */
export const repairDrift = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const areasAt = await latestAreasMark(ctx);
    // The whole index, deliberately with no lower bound: a row never checked (`checkedAt` absent
    // sorts first) is either owed its first computation (skipped below, then stamped) or was computed
    // before the links and marks existed — behind by construction (`isBehind`).
    const rows = await ctx.db.query('bodyGeoFacts').withIndex('by_checked').take(DRIFT_BATCH);
    // The rows failing before, so one that goes through clears its failure without a read per row.
    const failedKeys = new Set(
      (
        await ctx.db
          .query('jobFailures')
          .withIndex('by_job_key', (q) => q.eq('job', 'geoDrift'))
          .take(DRIFT_FAILURES_READ)
      ).map((f) => f.key),
    );
    let checked = 0;
    let marked = 0;
    let failed = 0;
    for (const row of rows) {
      const m = await ctx.meta.getTransactionMetrics();
      if (m.bytesRead.remaining < DRIFT_BYTES_RESERVE) break;
      checked++;
      // One row that throws never stops the tick (B01-3c): it is recorded, marked for recompute (the
      // conservative answer to "is it behind?"), and stamped so the next tick moves past it.
      let behind: boolean;
      try {
        behind = row.staleAt === undefined && (await isBehind(ctx, row, areasAt));
        if (failedKeys.has(row.waterBodyId)) await clearFailure(ctx, 'geoDrift', row.waterBodyId);
      } catch (err) {
        await recordJobFailure(ctx, 'geoDrift', row.waterBodyId, errorClassOf(err), now, {
          park: false,
        });
        failed++;
        behind = true;
      }
      if (behind) {
        await markGeoStale(ctx, [row.waterBodyId], now);
        marked++;
      }
      await ctx.db.patch(row._id, { checkedAt: now });
    }
    return { checked, marked, failed };
  },
});

/** Whether a computed row no longer matches its inputs (see {@link repairDrift}). */
async function isBehind(
  ctx: QueryCtx,
  row: Doc<'bodyGeoFacts'>,
  areasAt: number,
): Promise<boolean> {
  // Computed before every store stamped `checkedAt`: no links, no held stamps, no places mark.
  if (row.checkedAt === undefined) return true;
  const body = await ctx.db.get(row.waterBodyId);
  if (!body || body.dedupStatus === 'merged') return true;
  if (outlineStamp(body) !== row.stamp) return true;
  if ((row.areasAt ?? 0) < areasAt) return true;
  // Computed before towns carried their states (B01-3c): behind, so the drift fills them in.
  if ((row.towns ?? []).length > 0 && row.townStates === undefined) return true;
  const links = await ctx.db
    .query('bodyGeoLinks')
    .withIndex('by_holder', (q) => q.eq('waterBodyId', row.waterBodyId))
    .take(LINKS_PER_BODY);
  for (const link of links) {
    const held = await ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', link.neighborId))
      .first();
    if (held === null) return true;
    if (held.parkedAt !== undefined) {
      // A parked neighbor never lands an answer, so it never fans out: judge the held copy against
      // its outline as it stands — when the read budget still has room for one more outline.
      const m = await ctx.meta.getTransactionMetrics();
      if (m.bytesRead.remaining < DRIFT_BYTES_RESERVE) continue;
      const neighbor = await ctx.db.get(link.neighborId);
      if (!neighbor || outlineStamp(neighbor) !== link.neighborStamp) return true;
      continue;
    }
    // The neighbor's own answer says which outline it is now; one still owed a recompute is judged
    // when it lands (its store fans out if its stamp moved).
    if (
      held.staleAt === undefined &&
      held.stamp !== undefined &&
      held.stamp !== link.neighborStamp
    ) {
      return true;
    }
  }
  return false;
}

/**
 * **Bodies with no facts row at all** — a creation path the cell index's mark didn't see. One page of
 * the body-wide library rows, each probed for its facts row and marked when it has none, chaining to
 * the end; the weekly cron starts it.
 */
export const repairMissing = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_scope_name', (q) => q.eq('scope', '*'))
      .paginate({ cursor: cursor ?? null, numItems: MISSING_PAGE });
    const missing: Id<'waterBodies'>[] = [];
    let failed = 0;
    const now = Date.now();
    for (const r of page.page) {
      // One row that throws is recorded and passed; the page and the walk go on (B01-3c).
      try {
        const row = await ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', r.waterBodyId))
          .first();
        if (row === null) missing.push(r.waterBodyId);
      } catch (err) {
        await recordJobFailure(ctx, 'geoMissing', r.waterBodyId, errorClassOf(err), now, {
          park: false,
        });
        failed++;
      }
    }
    await markGeoStale(ctx, missing, now);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bodyGeo.repairMissing, {
        cursor: page.continueCursor,
      });
    }
    return { marked: missing.length, failed, isDone: page.isDone };
  },
});
