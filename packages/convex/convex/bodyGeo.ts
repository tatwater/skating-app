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

import {
  bboxIntersects,
  cellRangeCovering,
  countyKeyOfSubdivision,
  createReach,
  isUndefinedSubdivision,
} from '@skating/core';
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
import { nextAttemptState } from './lib/attempts';
import {
  coverTiles,
  hasTownEntries,
  markGeoStale,
  outlineStamp,
  PLACES_RULE,
  paddedBox,
  simplifiedRing,
  TOUCH_CANDIDATES,
  touches,
  vertexCount,
} from './lib/bodyGeo';
import { ADMIN_AREA_LADDER } from './lib/cellIndex';
import type { FailingJob } from './lib/enums';
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

/** Above this many vertices a candidate's outline is not returned whole (only its samples count). */
const WHOLE_MAX_VERTICES = 20_000;
/** Candidate rows one tile's cover reads. */
const TILE_LIMIT = TOUCH_CANDIDATES + 1;
/** Town rows one cell may give, as `findContainingArea` reads them — past it the read throws. */
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

/** Cell reads one candidates page makes at most — well inside a query's 4,096 calls. */
export const CANDIDATE_CELL_READS = 2_000;
/**
 * Town boundaries one page reads. A boundary's polygon is uncapped, so each is charged at a whole
 * document (1 MiB): the read budget's twelve MiB (`lib/readBudget`, `TX_BUDGET`) holds eleven. The
 * real rows run to 98 KB on dev, so a page is in fact about a megabyte.
 */
export const TOWN_PAGE = 11;
/** County rows one page reads — charged as {@link TOWN_PAGE}'s are. */
export const COUNTY_PAGE = 11;
/**
 * The candidates' box is the body's padded by this many degrees (about 40 m) — so a town whose edge
 * the shore runs along, a few meters off its box, is still tested.
 */
export const REACH_PAD_DEG = 0.0005;

const cursorV = v.object({ z: v.number(), i: v.number() });

/**
 * **Every town whose cells meet `box`**, a page at a time: the town rows of each ladder rung's cells
 * covering the box, from `from` (a rung and a cell's place in its range) for at most
 * {@link CANDIDATE_CELL_READS} cells, with where to go on (`next: null` at the end). A town is indexed
 * by its bounding box, so every town whose box meets the body's padded box is a candidate. A cell holding
 * more rows than {@link AREA_CELL_CAP} throws rather than answer short.
 */
export const townCandidates = internalQuery({
  args: { box: boxV, from: v.optional(cursorV) },
  handler: async (ctx, { box, from }) => {
    const ids = new Set<Id<'adminAreas'>>();
    let reads = 0;
    for (let z = from?.z ?? ADMIN_AREA_LADDER.minZ; z <= ADMIN_AREA_LADDER.maxZ; z++) {
      const range = cellRangeCovering(box, z);
      const width = range.maxX - range.minX + 1;
      for (let i = z === from?.z ? from.i : 0; i < range.count; i++) {
        if (reads >= CANDIDATE_CELL_READS) return { ids: [...ids], next: { z, i } };
        const x = range.minX + (i % width);
        const y = range.minY + Math.floor(i / width);
        const rows = await ctx.db
          .query('adminAreaCells')
          .withIndex('by_cell', (q) => q.eq('z', z).eq('x', x).eq('y', y).eq('level', 'town'))
          .take(AREA_CELL_CAP + 1);
        reads++;
        if (rows.length > AREA_CELL_CAP) {
          throw new ConvexError(`a town cell holds more than ${AREA_CELL_CAP} rows (z ${z})`);
        }
        for (const row of rows) ids.add(row.adminAreaId);
      }
    }
    return { ids: [...ids], next: null };
  },
});

/** One page of candidate towns, whole — at most {@link TOWN_PAGE}; a row gone or not a town is left out. */
export const townPage = internalQuery({
  args: { ids: v.array(v.id('adminAreas')) },
  handler: async (ctx, { ids }) => {
    if (ids.length > TOWN_PAGE) throw new ConvexError(`at most ${TOWN_PAGE} towns a page`);
    const out: {
      id: Id<'adminAreas'>;
      name: string;
      state: string;
      externalId: string;
      polygon: unknown;
    }[] = [];
    for (const id of ids) {
      const a = await ctx.db.get(id);
      if (a === null || a.level !== 'town') continue;
      out.push({
        id: a._id,
        name: a.name,
        state: a.state,
        externalId: a.externalId,
        polygon: a.polygon,
      });
    }
    return out;
  },
});

/** Counties by their boundary key (`tiger/<GEOID>`) — at most {@link COUNTY_PAGE}; one not loaded is left out. */
export const countyPage = internalQuery({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, { keys }) => {
    if (keys.length > COUNTY_PAGE) throw new ConvexError(`at most ${COUNTY_PAGE} counties a page`);
    const out: { key: string; name: string }[] = [];
    for (const key of keys) {
      const row = await ctx.db
        .query('adminAreas')
        .withIndex('by_external_id', (q) => q.eq('externalId', key))
        .first();
      if (row !== null && row.level === 'county') out.push({ key, name: row.name });
    }
    return out;
  },
});

// ── The pure work the action does ────────────────────────────────────────────────────────────

/** A town the rule placed the body in, as {@link townPage} returned it (its polygon no longer needed). */
export type ReachedTown = { id: Id<'adminAreas'>; name: string; state: string; externalId: string };

/**
 * **The places a body lies in, from the towns holding its shoreline** (D266, `@skating/core`'s
 * `createReach`) — one rule for its towns, counties and states. `reached` is the rule's answer in its
 * order (the town holding the most shore first). A "County subdivisions not defined" water unit is
 * not a town and is never listed as one, but its county and state count. Counties follow from each
 * town's GEOID (`countyNames` by county key), states from the towns. Empty lists for a body in no
 * loaded town — computed and in none, which the reads tell from "not computed".
 */
export function placesFrom(
  reached: readonly ReachedTown[],
  countyNames: ReadonlyMap<string, string>,
): {
  towns: string[];
  townStates: string[];
  townIds: Id<'adminAreas'>[];
  townEntries: { name: string; state: string; id: Id<'adminAreas'> }[];
  counties: string[];
  states: string[];
} {
  const towns: string[] = [];
  // Each town's state, in the same order (B01-3c): a border lake's towns are in two states.
  const townStates: string[] = [];
  const townIds: Id<'adminAreas'>[] = [];
  // Keyed on name and state (B01-3d): a border lake's Franklin, VT and Franklin, NH are two towns.
  // `towns` stays keyed on the name alone, as the pages written before read it.
  const townEntries: { name: string; state: string; id: Id<'adminAreas'> }[] = [];
  const counties: string[] = [];
  const states = new Set<string>();
  for (const area of reached) {
    states.add(area.state);
    const countyKey = countyKeyOfSubdivision(area.externalId);
    const county = countyKey === null ? undefined : countyNames.get(countyKey);
    if (county !== undefined && !counties.includes(county)) counties.push(county);
    if (isUndefinedSubdivision(area.externalId)) continue;
    if (!townEntries.some((e) => e.name === area.name && e.state === area.state)) {
      townEntries.push({ name: area.name, state: area.state, id: area.id });
    }
    if (!towns.includes(area.name)) {
      towns.push(area.name);
      townStates.push(area.state);
      townIds.push(area.id);
    }
  }
  return { towns, townStates, townIds, townEntries, counties, states: [...states].sort() };
}

/** Whether a candidates page's `next` is past where it started (a rung later, or a cell on). */
export function movedOn(
  from: { z: number; i: number } | undefined,
  next: { z: number; i: number },
): boolean {
  return from === undefined || next.z > from.z || (next.z === from.z && next.i > from.i);
}

/**
 * **Which loaded towns hold this body's shoreline**, read and tested a page at a time: the candidates
 * by cell (paged, each page must move on), the towns {@link TOWN_PAGE} at a time into one run of the
 * rule, then the counties of the towns it placed the body in. Nothing here holds more than one page of town
 * polygons at once.
 */
async function placesOf(
  ctx: ActionCtx,
  geom: Geom,
  bbox: Box,
): Promise<ReturnType<typeof placesFrom>> {
  const box = {
    minLat: bbox.minLat - REACH_PAD_DEG,
    maxLat: bbox.maxLat + REACH_PAD_DEG,
    minLng: bbox.minLng - REACH_PAD_DEG,
    maxLng: bbox.maxLng + REACH_PAD_DEG,
  };
  const ids: Id<'adminAreas'>[] = [];
  const seen = new Set<string>();
  let from: { z: number; i: number } | undefined;
  for (;;) {
    const page: { ids: Id<'adminAreas'>[]; next: { z: number; i: number } | null } =
      await ctx.runQuery(internal.bodyGeo.townCandidates, { box, ...(from ? { from } : {}) });
    for (const id of page.ids) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (page.next === null) break;
    // A page that hands back where it started would loop for ever: fail the body instead.
    if (!movedOn(from, page.next)) throw new Error('town candidates made no progress');
    from = page.next;
  }
  const run = createReach(geom);
  const byId = new Map<string, ReachedTown>();
  for (let k = 0; k < ids.length; k += TOWN_PAGE) {
    const rows = await ctx.runQuery(internal.bodyGeo.townPage, {
      ids: ids.slice(k, k + TOWN_PAGE),
    });
    run.add(rows.map((r) => ({ id: r.id, polygon: r.polygon as Geom })));
    for (const { polygon: _, ...town } of rows) byId.set(town.id, town);
  }
  const reached = run.result().ids.map((id) => byId.get(id) as ReachedTown);
  const keys = [
    ...new Set(
      reached
        .map((t) => countyKeyOfSubdivision(t.externalId))
        .filter((k): k is string => k !== null),
    ),
  ];
  const countyNames = new Map<string, string>();
  for (let k = 0; k < keys.length; k += COUNTY_PAGE) {
    for (const c of await ctx.runQuery(internal.bodyGeo.countyPage, {
      keys: keys.slice(k, k + COUNTY_PAGE),
    })) {
      countyNames.set(c.key, c.name);
    }
  }
  return placesFrom(reached, countyNames);
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
    /** Each town's boundary, in `towns`' order. */
    townIds: v.optional(v.array(v.id('adminAreas'))),
    /** The towns keyed on name and state, each with its boundary. */
    townEntries: v.optional(
      v.array(v.object({ name: v.string(), state: v.string(), id: v.id('adminAreas') })),
    ),
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
      // Gone: its links go, and every body holding its outline drops it on recompute. Its failures
      // go too — no walk visits a body with no facts row or library row again, so a drift check or
      // a missing-row probe that failed on it would otherwise be counted by Machinery forever.
      await writeLinks(ctx, args.waterBodyId, []);
      for (const job of ['bodyGeo', 'geoDrift', 'geoMissing'] as const) {
        await clearFailure(ctx, job, args.waterBodyId);
      }
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
      placesRule: PLACES_RULE,
      stamp: args.stamp,
      neighbors: args.neighbors,
      neighborsCapped: args.neighborsCapped,
      towns: args.towns,
      townStates: args.townStates ?? [],
      townIds: args.townIds ?? [],
      townEntries: args.townEntries ?? [],
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
  const places = await placesOf(ctx, geom, input.bbox);
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
  args: {
    cursor: v.optional(v.string()),
    /** A smaller page (at most {@link SEED_PAGE}) — for a test to reach the chain cheaply. */
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, pageSize }) => {
    const size =
      pageSize !== undefined && Number.isFinite(pageSize)
        ? Math.min(SEED_PAGE, Math.max(1, Math.floor(pageSize)))
        : SEED_PAGE;
    const page = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_scope_name', (q) => q.eq('scope', '*'))
      .paginate({ cursor: cursor ?? null, numItems: size });
    await markGeoStale(
      ctx,
      page.page.map((r) => r.waterBodyId),
    );
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bodyGeo.seedAll, {
        cursor: page.continueCursor,
        ...(pageSize !== undefined ? { pageSize: size } : {}),
      });
    }
    return { marked: page.page.length, isDone: page.isDone };
  },
});

// ── The drift repair ─────────────────────────────────────────────────────────────────────────

/** A walk's earlier failures one pass reads up front, to clear the items that now go through. */
const WALK_FAILURES_READ = 200;

/**
 * Clears a walk's item that went through, if it had been failing — from one read of the job's
 * failures up front rather than a read per item; past {@link WALK_FAILURES_READ} of them that read is
 * partial, so each item is then looked up on its own (a capped read never decides "not failing").
 */
async function failureClearer(
  ctx: MutationCtx,
  job: FailingJob,
): Promise<(key: string) => Promise<void>> {
  const rows = await ctx.db
    .query('jobFailures')
    .withIndex('by_job_key', (q) => q.eq('job', job))
    .take(WALK_FAILURES_READ + 1);
  if (rows.length > WALK_FAILURES_READ) return (key) => clearFailure(ctx, job, key);
  const failing = new Set(rows.map((f) => f.key));
  return async (key) => {
    if (failing.has(key)) await clearFailure(ctx, job, key);
  };
}
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
    // The rows failing before, so one that goes through clears its failure.
    const cleared = await failureClearer(ctx, 'geoDrift');
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
        await cleared(row.waterBodyId);
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
  // Places computed by an earlier rule (the sampled points before D266) are behind.
  if (row.placesRule !== PLACES_RULE) return true;
  // Computed before towns carried their states and boundaries (B01-3c) — or stored without them —
  // is behind, so the drift fills them in: the lists must run beside `towns`, one entry per town.
  const townCount = (row.towns ?? []).length;
  if (
    townCount > 0 &&
    ((row.townStates ?? []).length !== townCount ||
      (row.townIds ?? []).length !== townCount ||
      // Keyed on name and state (B01-3d): the readers' own rule.
      !hasTownEntries(row))
  ) {
    return true;
  }
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
    // The probes failing on an earlier walk: one that goes through now clears its failure (the
    // weekly walk is the retry, so it is also what says the retry worked).
    const cleared = await failureClearer(ctx, 'geoMissing');
    for (const r of page.page) {
      // One row that throws is recorded and passed; the page and the walk go on (B01-3c).
      try {
        const row = await ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', r.waterBodyId))
          .first();
        if (row === null) missing.push(r.waterBodyId);
        await cleared(r.waterBodyId);
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
