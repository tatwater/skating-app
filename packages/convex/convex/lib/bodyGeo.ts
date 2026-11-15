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
 * marks; the cell index is the choke point for creations, moved boxes and listing changes), where a
 * neighbor's relation or stored outline moves, and by a drift repair for whatever those miss. The
 * `bodyGeo` jobs
 * recompute stale bodies in an action, where the geometry has room, and store the answer through a
 * mutation that keeps it only if the outline it was computed for is still the body's. A body never
 * computed reads `null` ("not computed"), never an empty list.
 */

import { allLevels, cellRangeCovering, distanceToPolygonMeters } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { WATER_BODY_LADDER } from './cellIndex';

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

/** What an outline's facts were computed for: its size and its box. Moves when the outline does. */
export function outlineStamp(body: Pick<Doc<'waterBodies'>, 'polygon' | 'bbox'>): string {
  const b = body.bbox;
  return `${vertexCount(body.polygon as unknown as Geom)}:${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`;
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
  const ring = outerRings(geom).sort((a, b) => b.length - a.length)[0] ?? [];
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
