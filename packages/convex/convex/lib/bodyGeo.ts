/**
 * **A body's geometry facts, computed at the write** (B01-3b) — its touching bodies and the places
 * it lies in, stored in `bodyGeoFacts` so the console's reads never do geometry whose cost grows
 * with an outline.
 *
 * ## Why stored
 *
 * On dev, `consoleExtras` timed out on the largest lake: its one second of execution went to the
 * touching test — about 1,300 point-to-outline distance checks against a 14,000-vertex outline and
 * its twelve neighbors' (reproduced at 1.4 s). The neighbor lookup itself was cheap: its box covers
 * more level-13 cells than the scan allows, so the scan skipped the fine rungs (a bounded truncation,
 * never an unbounded fallback), and read 215 cells in under 0.1 s. The cost was the per-vertex work.
 *
 * ## How it stays current
 *
 * A body's facts are marked stale where any input of theirs changes (`lib/geoStale.ts` lists the
 * marks; the cell index marks a new body, and an outline or box write marks its own — since B01-3c a
 * standing, listing or prominence change marks nothing), where a neighbor's relation or stored
 * outline moves, and by a drift repair for whatever those miss. The
 * `bodyGeo` jobs
 * recompute stale bodies in an action, where the geometry has room, and store the answer through a
 * mutation that keeps it only if the outline it was computed for is still the body's. A body never
 * computed reads `null` ("not computed"), never an empty list.
 */

import {
  allLevels,
  cellRangeCovering,
  countyKeyOfSubdivision,
  distanceToPolygonMeters,
  isUndefinedSubdivision,
  stateOfSubdivision,
  townKindOf,
  townName,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { WATER_BODY_LADDER } from './cellIndex';
import { markGeoStale as markStale } from './geoStale';

/** Two outlines this close count as touching (the stored outlines are simplified to ~5 m). */
export const TOUCH_METERS = 30;
/** Outline points sampled each way in the touching test. */
export const TOUCH_SAMPLES = 48;
/** Neighbors tested: the most prominent whose boxes meet the body's padded box. */
export const TOUCH_CANDIDATES = 12;
/** Points a stored neighbor outline keeps — enough to draw at the console's scale. */
export const NEIGHBOR_RING_POINTS = 48;
/** The most cells at the finest rung one cover may read; past it the box is tiled. */
export const TILE_MAX_CELLS = 256;
/** The most tiles one body's cover takes; past it the neighbors read `capped`. */
export const MAX_TILES = 32;

type Geom = Polygon | MultiPolygon;
type Box = { minLat: number; minLng: number; maxLat: number; maxLng: number };

/** The outer rings of an outline. */
function outerRings(geom: Geom): number[][][] {
  if (geom.type === 'Polygon') return [geom.coordinates[0] ?? []];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0] ?? []);
  return [];
}

/** How many positions an outline holds, every ring counted. */
export function vertexCount(geom: Geom): number {
  const polys =
    geom.type === 'Polygon'
      ? [geom.coordinates]
      : geom.type === 'MultiPolygon'
        ? geom.coordinates
        : [];
  return polys.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
}

/** One scratch view for {@link coordinateHash}: a double's two 32-bit words. */
const HASH_VIEW = new DataView(new ArrayBuffer(8));

/**
 * A 32-bit FNV-1a hash over every coordinate of an outline, ring boundaries included — so a
 * shoreline redrawn at the same vertex count inside the same box still moves the stamp.
 */
function coordinateHash(coordinates: unknown): string {
  let h = 0x811c9dc5;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      h = Math.imul(h ^ (0x9e3779b9 + v.length), 0x01000193);
      for (const x of v) visit(x);
    } else if (typeof v === 'number') {
      HASH_VIEW.setFloat64(0, v);
      h = Math.imul(h ^ HASH_VIEW.getUint32(0), 0x01000193);
      h = Math.imul(h ^ HASH_VIEW.getUint32(4), 0x01000193);
    }
  };
  visit(coordinates);
  return (h >>> 0).toString(36);
}

/**
 * What an outline's facts were computed for: its size, its box and a hash of its coordinates. Moves
 * when the outline does — a reshape at the same vertex count inside the same box included, which a
 * size-and-box stamp alone missed (the holders of its outline were never fanned out to).
 */
export function outlineStamp(body: Pick<Doc<'waterBodies'>, 'polygon' | 'bbox'>): string {
  const b = body.bbox;
  const geom = body.polygon as unknown as Geom;
  return `${vertexCount(geom)}:${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}:${coordinateHash(geom.coordinates)}`;
}

/** {@link TOUCH_SAMPLES} points across a whole outline, every outer ring in one sequence. */
export function samplePoints(geom: Geom, count = TOUCH_SAMPLES): { lat: number; lng: number }[] {
  const points = outerRings(geom).flat();
  const step = Math.max(1, Math.floor(points.length / count));
  const out: { lat: number; lng: number }[] = [];
  for (let i = 0; i < points.length && out.length < count; i += step) {
    const p = points[i];
    if (p !== undefined && p.length >= 2) out.push({ lng: p[0] as number, lat: p[1] as number });
  }
  return out;
}

/** Whether any of `points` comes within {@link TOUCH_METERS} of `to`. */
export function anyNear(points: readonly { lat: number; lng: number }[], to: Geom): boolean {
  return points.some((p) => distanceToPolygonMeters(p, to) <= TOUCH_METERS);
}

/**
 * Whether two outlines come within {@link TOUCH_METERS}, sampled **both ways**: a large lake's ring
 * sampled {@link TOUCH_SAMPLES} times is kilometers between samples, so a pond beside it is found by
 * sampling the pond against the lake. `otherWhole` is false for an outline too large to test whole
 * (then only its samples are tested against `body`).
 */
export function touches(body: Geom, other: Geom, otherWhole: boolean): boolean {
  if (anyNear(samplePoints(other), body)) return true;
  return otherWhole && anyNear(samplePoints(body), other);
}

/** The largest outer ring of an outline, kept to at most `max` points and closed. */
export function simplifiedRing(geom: Geom, max = NEIGHBOR_RING_POINTS): [number, number][] {
  // The largest ring by area, not by vertex count: a town's detailed island would otherwise stand in
  // for its mainland (Greptile on #122).
  const ring = outerRings(geom).sort((a, b) => ringArea(b) - ringArea(a))[0] ?? [];
  const open = ring.length > 1 ? ring.slice(0, -1) : ring;
  const step = Math.max(1, open.length / max);
  const out: [number, number][] = [];
  for (let i = 0; i < open.length && out.length < max; i += step) {
    const p = open[Math.floor(i)];
    if (p !== undefined && p.length >= 2) out.push([p[0] as number, p[1] as number]);
  }
  const first = out[0];
  if (first !== undefined) out.push([first[0], first[1]]);
  return out;
}

/** A ring's planar area in square degrees (shoelace) — enough to tell its parts apart by size. */
function ringArea(ring: readonly number[][]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as number[];
    const b = ring[i + 1] as number[];
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return Math.abs(sum) / 2;
}

/** Degrees of latitude in {@link TOUCH_METERS}, for the box the candidates are read in. */
const PAD_DEG = TOUCH_METERS / 111_000;

/** A body's box padded by {@link TOUCH_METERS} (longitude padded wider, for the latitude). */
export function paddedBox(b: Box): Box {
  return {
    minLat: b.minLat - PAD_DEG,
    maxLat: b.maxLat + PAD_DEG,
    minLng: b.minLng - PAD_DEG * 1.5,
    maxLng: b.maxLng + PAD_DEG * 1.5,
  };
}

/**
 * **The box split into tiles the cover can read whole** — each covering at most
 * {@link TILE_MAX_CELLS} cells at the ladder's finest rung, so no rung is skipped and a small
 * neighbor indexed there is still found. Halved along its longer side until each fits, to at most
 * {@link MAX_TILES} tiles; `truncated` when that bound stops it (the caller reads `capped`).
 */
export function coverTiles(box: Box): { tiles: Box[]; truncated: boolean } {
  const finest = Math.max(...allLevels(WATER_BODY_LADDER));
  const fits = (b: Box) => cellRangeCovering(b, finest).count <= TILE_MAX_CELLS;
  let tiles = [box];
  while (tiles.some((t) => !fits(t))) {
    const next: Box[] = [];
    for (const t of tiles) {
      if (fits(t)) {
        next.push(t);
        continue;
      }
      const wide = t.maxLng - t.minLng >= t.maxLat - t.minLat;
      if (wide) {
        const mid = (t.minLng + t.maxLng) / 2;
        next.push({ ...t, maxLng: mid }, { ...t, minLng: mid });
      } else {
        const mid = (t.minLat + t.maxLat) / 2;
        next.push({ ...t, maxLat: mid }, { ...t, minLat: mid });
      }
    }
    if (next.length > MAX_TILES) return { tiles, truncated: true };
    tiles = next;
  }
  return { tiles, truncated: false };
}

// ── Stale marks ──────────────────────────────────────────────────────────────────────────────

export { markGeoStale } from './geoStale';

/**
 * **The places rule a facts row's towns, counties and states were computed by** — 2 is the body's
 * shoreline in the town layer (D266: 25 m in a town); a row without it holds the sampled answer from
 * before, which no read shows as the answer ({@link placesOf}).
 */
export const PLACES_RULE = 2;

/**
 * A computed row's places, or `null` when they were not computed by {@link PLACES_RULE} — never
 * computed, or computed by the sampled rule before it and not recomputed since (a parked body keeps
 * that row until its recompute goes through). Its touching bodies are read from the row as before.
 */
export function placesOf(geo: Doc<'bodyGeoFacts'> | null): Doc<'bodyGeoFacts'> | null {
  if (geo === null || geo.placesRule !== PLACES_RULE) return null;
  return withPinnedTowns(geo);
}

/**
 * The computed places with a moderator's pinned towns merged in (B01-3g) — after the computed ones,
 * never twice (keyed by boundary, B01-3l), their counties and states added. Kept apart in storage,
 * so a pin's write and a recompute each rebuild only their own half.
 */
function withPinnedTowns(geo: Doc<'bodyGeoFacts'>): Doc<'bodyGeoFacts'> {
  const pins = geo.pinnedTowns ?? [];
  if (pins.length === 0 && (geo.pinnedMissing ?? []).length === 0) return geo;
  // A "not defined" water unit (an undo may restore a pin on one) is never listed as a town — the
  // computed half's rule (`bodyGeo.placesFrom`) — but its county and state count.
  const listed = pins.filter((p) => !isUndefinedSubdivision(p.key));
  const townEntries = [...(geo.townEntries ?? [])];
  // Keyed by boundary, never by name (B01-3l): a pinned Plattsburgh town beside a computed
  // Plattsburgh city is two towns.
  for (const p of listed) {
    if (!townEntries.some((e) => e.id === p.id)) {
      townEntries.push({
        name: p.name,
        state: p.state,
        id: p.id,
        ...(p.kind !== undefined ? { kind: p.kind } : {}),
      });
    }
  }
  const towns = [...(geo.towns ?? [])];
  const townStates = [...(geo.townStates ?? [])];
  const townIds = [...(geo.townIds ?? [])];
  for (const p of listed) {
    if (towns.includes(p.name)) continue;
    towns.push(p.name);
    townStates.push(p.state);
    townIds.push(p.id);
  }
  const counties = [...(geo.counties ?? [])];
  for (const p of pins)
    if (p.county !== undefined && !counties.includes(p.county)) counties.push(p.county);
  // A pinned key whose town left the layer still names its state, as the body's own states do.
  const missingStates = (geo.pinnedMissing ?? [])
    .map(stateOfSubdivision)
    .filter((code): code is string => code !== null);
  const states = [
    ...new Set([...(geo.states ?? []), ...pins.map((p) => p.state), ...missingStates]),
  ].sort();
  return { ...geo, towns, townStates, townIds, townEntries, counties, states };
}

/** Subdivisions of one name in one state a kind check reads at most — real states hold two or three. */
export const NAMESAKES_READ = 8;

/**
 * Whether the loaded subdivisions of `state` named `name` carry more than one kind (B01-3l) — the one
 * rule for when a town's label shows its kind. Two of one kind (New York's two Clinton towns) gain
 * nothing from it: each is its own entry and both read "Clinton, NY" — where B01-3d folded them into
 * one (the county would tell them apart; owed). Plattsburgh city and town do. Reads at most
 * {@link NAMESAKES_READ} boundaries (each its polygon) on `by_level_state_name`.
 */
export async function kindsDiffer(ctx: QueryCtx, state: string, name: string): Promise<boolean> {
  const namesakes = await ctx.db
    .query('adminAreas')
    .withIndex('by_level_state_name', (q) =>
      q.eq('level', 'town').eq('state', state).eq('name', name),
    )
    .take(NAMESAKES_READ);
  const kinds = new Set(namesakes.map((a) => townKindOf(a.name, a.fullName) ?? ''));
  return namesakes.length > 1 && kinds.size > 1;
}

/**
 * **A moderator's pinned towns as the facts hold them** (B01-3g): each key's town row now — name,
 * state, boundary and county (from its GEOID) — and the keys no town row has now (`pinnedMissing`),
 * kept to be shown rather than dropped. At most eight keys: a town read each, each county read once
 * however many pinned towns share it, and — for a town whose full name gives a kind — its namesakes
 * once per name, at most {@link NAMESAKES_READ} (B01-3l; real states hold two or three). Boundary rows
 * carry their polygons, so every read counts against the writer's budget.
 */
export async function pinnedFactsFor(
  ctx: QueryCtx,
  keys: readonly string[],
): Promise<{
  pinnedTowns: NonNullable<Doc<'bodyGeoFacts'>['pinnedTowns']>;
  pinnedMissing: string[];
}> {
  const pinnedTowns: NonNullable<Doc<'bodyGeoFacts'>['pinnedTowns']> = [];
  const pinnedMissing: string[] = [];
  const countyNames = new Map<string, string | null>();
  const sharedNames = new Map<string, boolean>();
  for (const key of keys) {
    const town = await ctx.db
      .query('adminAreas')
      .withIndex('by_external_id', (q) => q.eq('externalId', key))
      .first();
    if (town === null || town.level !== 'town') {
      pinnedMissing.push(key);
      continue;
    }
    const countyKey = countyKeyOfSubdivision(key);
    if (countyKey !== null && !countyNames.has(countyKey)) {
      const row = await ctx.db
        .query('adminAreas')
        .withIndex('by_external_id', (q) => q.eq('externalId', countyKey))
        .first();
      countyNames.set(countyKey, row !== null && row.level === 'county' ? row.name : null);
    }
    const county = countyKey === null ? null : (countyNames.get(countyKey) ?? null);
    // Its kind when another subdivision of its state shares its name (B01-3l), as the computed
    // half's entries carry it — one label for a pinned town and a computed one. The namesakes are
    // read only when its full name gives a kind (none: nothing to show), and once per name.
    const candidate = townKindOf(town.name, town.fullName);
    let kind: string | undefined;
    if (candidate !== undefined) {
      const nameKey = JSON.stringify([town.state, town.name]);
      let shared = sharedNames.get(nameKey);
      if (shared === undefined) {
        shared = await kindsDiffer(ctx, town.state, town.name);
        sharedNames.set(nameKey, shared);
      }
      if (shared) kind = candidate;
    }
    pinnedTowns.push({
      key,
      name: town.name,
      state: town.state,
      id: town._id,
      ...(county !== null ? { county } : {}),
      ...(kind !== undefined ? { kind } : {}),
    });
  }
  return { pinnedTowns, pinnedMissing };
}

/**
 * Rebuild a body's pinned towns in its facts, in the writer's own transaction (the pin's write, its
 * undo, a merge) — so no reader sees the pins as they were. A body with no facts row yet is owed its
 * first computation, which builds them.
 */
export async function refreshPinnedFacts(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  keys: readonly string[],
): Promise<void> {
  const row = await ctx.db
    .query('bodyGeoFacts')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  // No facts row yet: owed its first computation, which builds the pinned half — queue it.
  if (row === null) {
    await markStale(ctx, [waterBodyId]);
    return;
  }
  await ctx.db.patch(row._id, await pinnedFactsFor(ctx, keys));
}

/** A body's stored geometry facts, or `null` when none were ever computed. */
export async function geoFactsOf(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'bodyGeoFacts'> | null> {
  const row = await ctx.db
    .query('bodyGeoFacts')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  return row !== null && row.computedAt !== undefined ? row : null;
}

/**
 * A body's towns with each one's state (B01-3c) — `state: null` on a row computed before towns
 * carried their states (the drift repair recomputes those); `null` when nothing was computed. One
 * rule for the preview, the frame and Places.
 */
export function townsWithStateOf(
  geo: Pick<Doc<'bodyGeoFacts'>, 'towns' | 'townStates' | 'townEntries'> | null,
): { name: string; state: string | null }[] | null {
  return townRowsOf(geo)?.map(({ name, state }) => ({ name, state })) ?? null;
}

/**
 * A body's towns as a list of names (B01-3l) — one per boundary, each as `townName` shows it
 * ("Plattsburgh (city)" when its state has two of that name). What every list of towns reads, in
 * place of the facts' name-keyed `towns`, which folded two same-named towns into one.
 */
export function townNamesOf(
  geo: Pick<Doc<'bodyGeoFacts'>, 'towns' | 'townStates' | 'townIds' | 'townEntries'> | null,
): string[] | null {
  const rows = townRowsOf(geo);
  if (rows === null) return null;
  // A list of names carries no state: a border lake's Franklin, VT and Franklin, NH would read the
  // same, so a name two states share in this list shows its state — and nothing else changes.
  const statesOf = new Map<string, Set<string | null>>();
  for (const { name, state } of rows) {
    statesOf.set(name, (statesOf.get(name) ?? new Set()).add(state));
  }
  return rows.map(({ name, state }) =>
    (statesOf.get(name)?.size ?? 0) > 1 && state !== null ? `${name}, ${state}` : name,
  );
}

/**
 * Whether the facts carry the towns keyed on name and state (B01-3d) — at least one entry per
 * distinct name. The one rule the readers and the drift repair share: a row without them is read by
 * the name-keyed lists and is behind.
 */
export function hasTownEntries(geo: Pick<Doc<'bodyGeoFacts'>, 'towns' | 'townEntries'>): boolean {
  return geo.townEntries !== undefined && geo.townEntries.length >= (geo.towns ?? []).length;
}

/**
 * A body's towns, each with its state and its boundary, in one order — one per boundary where the
 * entries are stored ({@link hasTownEntries}), each named by `townName`; else the name-keyed lists
 * before them (`null` state or boundary on a row computed before towns carried them). `null` when
 * nothing was computed.
 */
export function townRowsOf(
  geo: Pick<Doc<'bodyGeoFacts'>, 'towns' | 'townStates' | 'townIds' | 'townEntries'> | null,
): { name: string; state: string | null; id: Id<'adminAreas'> | null }[] | null {
  if (geo === null) return null;
  // Each entry by its boundary, named as `townName` shows it (B01-3l): its kind when carried.
  if (hasTownEntries(geo)) {
    return (geo.townEntries ?? []).map((e) => ({ name: townName(e), state: e.state, id: e.id }));
  }
  return (geo.towns ?? []).map((name, i) => ({
    name,
    state: geo.townStates?.[i] ?? null,
    id: geo.townIds?.[i] ?? null,
  }));
}
