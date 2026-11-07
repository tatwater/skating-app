/**
 * Filled depth bands from the drawn isobaths — the arithmetic (B03 §2).
 *
 * MapLibre cannot fill between lines, so the skater map's depth switch needs polygons: the area
 * between successive contours, banded to the seven-band ramp (`DEPTH_BAND_EDGES_FT` in core). This
 * module is the part of that chain that can be wrong in a way that still looks right — which contour
 * a band edge lands on, the grid the bands are traced from, which closed rings are pits and which are
 * shoals, and which slivers are noise. The GMT/GDAL glue that composes it is `bandChain.ts`.
 *
 * ## Why the bands are traced from a surface rather than stitched from the lines
 *
 * 79% of the surveyed lane's lines are **open**: the agency's shallow isobath runs outside OSM's
 * shoreline and the clip cuts it into pieces (Mascoma's 10 ft line arrives as 20 of them). Stitching
 * polygons from open lines means deciding, per piece, which side is deep — a guess that fails
 * silently on a cove. Instead each lake gets a **harmonic** surface (`surface -T1`) through every
 * contour vertex at its depth and the shoreline at 0, and the bands are that surface's isobands at the
 * boundary levels. A harmonic surface has no maxima or minima away from its data, so it cannot invent
 * an isoline: a band edge appears only between data that straddles its level, and the edges it draws
 * at a contour's level run along that contour (to within a grid cell).
 *
 * The one place a harmonic surface cannot decide is a closed ring with nothing inside it — the
 * interior is flat at the ring's own depth. Whether it is a pit (deeper inside) or a shoal (shallower)
 * is read from the surface just outside the ring, and the interior is seeded accordingly before the
 * second solve (`ringSeedDirection`).
 */

import { DEPTH_BAND_EDGES_FT, depthBandIndex } from '@skating/core';
import type { Position } from 'geojson';

/** A point in a lake's local metric frame, meters east (`x`) and north (`y`) of its origin. */
export interface XY {
  x: number;
  y: number;
}

/** A local-frame ring, closed (first point repeated last). */
export type Ring = XY[];

/** One band on one lake: where it sits on the ramp and the contours that bound it. */
export interface BandSpec {
  bandIndex: number;
  minDepthFt: number;
  /** Absent on the deepest band — nothing measured bounds it from below. */
  maxDepthFt?: number;
}

export interface BandPlan {
  /** The contour levels band edges land on, ascending. Every one is a level the lake has a line at. */
  boundaries: number[];
  /** One more than `boundaries`: the shore band, then one band per boundary. */
  bands: BandSpec[];
}

/**
 * Which contours become band edges, and what each band is.
 *
 * **An edge lands on the shallowest contour at or below the ramp's edge — never on one we invent.**
 * The ramp edges (5, 10, 20, 30, 45, 70 ft) are finer than many lakes' contours: NH publishes every
 * 10 ft, so Mascoma has no 5 ft or 45 ft line. Interpolating one would draw a depth no sounder
 * measured (the D83 rule the line layer already keeps), so the edge moves to the next contour that
 * exists — 5 → 10, 45 → 50 — and a ramp band with no contour of its own is simply absent on that lake.
 * `minDepthFt`/`maxDepthFt` say where each band's edges really are, so a client can label
 * "0–10 ft" rather than the ramp's "0–5 ft".
 *
 * `bandIndex` is the ramp band of the lower edge, so a band is never colored deeper than its
 * shallowest water.
 */
export function bandPlan(
  levels: readonly number[],
  edges: readonly number[] = DEPTH_BAND_EDGES_FT,
): BandPlan {
  const sorted = [...new Set(levels.filter((l) => Number.isFinite(l) && l > 0))].sort(
    (a, b) => a - b,
  );
  const boundaries: number[] = [];
  for (const edge of edges.slice(1)) {
    const level = sorted.find((l) => l >= edge);
    if (level !== undefined && !boundaries.includes(level)) boundaries.push(level);
  }
  const lowers = [0, ...boundaries];
  const bands = lowers.map((min, i) => {
    const max = boundaries[i];
    const spec: BandSpec = { bandIndex: depthBandIndex(min), minDepthFt: min };
    if (max !== undefined) spec.maxDepthFt = max;
    return spec;
  });
  return { boundaries, bands };
}

/**
 * The levels handed to `gdal_contour -p`: the boundaries, with a sentinel below the shore and one past
 * any depth in the corpus. `-p` traces only the intervals *between* its levels, so without the
 * sentinels the shore band and the deepest band would silently not exist.
 */
export function isobandLevels(plan: BandPlan): number[] {
  return [-1, ...plan.boundaries, 100_000];
}

/**
 * Which band a traced isoband belongs to, from the lower bound GDAL stamped on it.
 *
 * `gdal_contour -p` labels each interval with its lower level, except the shallowest, whose lower
 * bound is the grid minimum. Matching with a tolerance because the level round-trips through a
 * float attribute.
 */
export function bandForLowerBound(amin: number, plan: BandPlan): BandSpec | undefined {
  const first = plan.boundaries[0];
  if (first === undefined || amin < first - 1e-6) return plan.bands[0];
  const index = plan.boundaries.findIndex((b) => Math.abs(b - amin) < 1e-6);
  return index === -1 ? undefined : plan.bands[index + 1];
}

// ---------------------------------------------------------------------------------------------------
// The local frame
// ---------------------------------------------------------------------------------------------------

const M_PER_DEG_LAT = 111_320;

/** An equirectangular frame about a lake's own center: metric enough for one lake, exactly invertible. */
export interface LocalFrame {
  lng0: number;
  lat0: number;
  mPerLng: number;
}

export function frameFor(positions: readonly Position[]): LocalFrame {
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of positions) {
    const [lng, lat] = p as [number, number];
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLng)) throw new Error('frameFor needs at least one position');
  const lng0 = (minLng + maxLng) / 2;
  const lat0 = (minLat + maxLat) / 2;
  return { lng0, lat0, mPerLng: M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180) };
}

export function toXY(p: Position, f: LocalFrame): XY {
  return {
    x: ((p[0] as number) - f.lng0) * f.mPerLng,
    y: ((p[1] as number) - f.lat0) * M_PER_DEG_LAT,
  };
}

export function toLngLat(p: XY, f: LocalFrame): Position {
  return [f.lng0 + p.x / f.mPerLng, f.lat0 + p.y / M_PER_DEG_LAT];
}

// ---------------------------------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------------------------------

/**
 * Ground resolution to aim for. Finer than the line layer's 25 m solve grid on purpose: here the
 * surface only has to put a band edge back on a line that already exists, and a band edge that wanders
 * a cell off the contour drawn over it is visible at z14 (~9 m/px).
 */
export const BAND_TARGET_CELL_M = 5;
export const BAND_MIN_CELLS = 200;
/** The ceiling binds above ~5 km; Champlain lands near 170 m a cell, coarse but still its own lines. */
export const BAND_MAX_CELLS = 1000;
/** Cells of margin around the lake, so the shoreline is never on the grid's own edge. */
export const BAND_PAD_CELLS = 3;

export interface BandGrid {
  cellM: number;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** A grid over these bounds, snapped to whole cells, with a margin. */
export function bandGrid(bounds: {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}): BandGrid {
  const extent = Math.max(bounds.xmax - bounds.xmin, bounds.ymax - bounds.ymin);
  if (!(extent > 0)) throw new Error('bandGrid needs bounds with a positive extent');
  const cells = Math.min(
    BAND_MAX_CELLS,
    Math.max(BAND_MIN_CELLS, Math.round(extent / BAND_TARGET_CELL_M)),
  );
  const cellM = extent / cells;
  const pad = BAND_PAD_CELLS * cellM;
  return {
    cellM,
    xmin: Math.floor((bounds.xmin - pad) / cellM) * cellM,
    xmax: Math.ceil((bounds.xmax + pad) / cellM) * cellM,
    ymin: Math.floor((bounds.ymin - pad) / cellM) * cellM,
    ymax: Math.ceil((bounds.ymax + pad) / cellM) * cellM,
  };
}

export function boundsOf(points: readonly XY[]): {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
} {
  let xmin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  return { xmin, xmax, ymin, ymax };
}

/** GMT's `-R` and `-I` for a grid. */
export function gmtRegion(grid: BandGrid): { region: string; increment: string } {
  return {
    region: `-R${grid.xmin}/${grid.xmax}/${grid.ymin}/${grid.ymax}`,
    increment: `-I${grid.cellM}`,
  };
}

/**
 * Resample a polyline so no two consecutive points are more than `spacing` apart.
 *
 * A contour's vertices are as uneven as a shoreline's — a straight run can go hundreds of meters
 * between two — and the surface only knows the line where it has a point.
 */
export function densify(line: readonly XY[], spacing: number): XY[] {
  if (!(spacing > 0)) throw new Error(`spacing must be positive, got ${spacing}`);
  const out: XY[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const a = line[i] as XY;
    out.push(a);
    const b = line[i + 1];
    if (!b) break;
    const steps = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / spacing);
    for (let s = 1; s <= steps; s += 1) {
      const t = s / (steps + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** A line with fewer than two distinct vertices, or no length, carries no isobath. Dropped and logged. */
export function isDegenerateLine(line: readonly XY[]): boolean {
  if (line.length < 2) return true;
  const first = line[0] as XY;
  return line.every((p) => Math.hypot(p.x - first.x, p.y - first.y) < 1e-6);
}

/** First vertex repeated last, with at least three distinct vertices between. */
export function isClosedRing(line: readonly XY[]): boolean {
  if (line.length < 4) return false;
  const a = line[0] as XY;
  const b = line[line.length - 1] as XY;
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/** Shoelace, positive when counter-clockwise. */
export function signedArea(ring: readonly XY[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i] as XY;
    const b = ring[i + 1] as XY;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Even-odd point-in-ring. */
export function pointInRing(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i] as XY;
    const b = ring[j] as XY;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToRing(p: XY, ring: readonly XY[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const d = distanceToSegment(p, ring[i] as XY, ring[i + 1] as XY);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// Pits and shoals
// ---------------------------------------------------------------------------------------------------

/**
 * Points just outside a closed ring, one per segment midpoint, `offset` meters out.
 *
 * The surface there says which way the ring faces: deeper water outside means the ring encloses a
 * shoal, shallower water outside means a pit.
 */
export function outsideProbes(ring: readonly XY[], offset: number): XY[] {
  // Outward is to the right of travel on a counter-clockwise ring.
  const sign = signedArea(ring) >= 0 ? 1 : -1;
  const out: XY[] = [];
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i] as XY;
    const b = ring[i + 1] as XY;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const nx = ((b.y - a.y) / len) * sign;
    const ny = (-(b.x - a.x) / len) * sign;
    out.push({ x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset });
  }
  return out;
}

/**
 * Which way to seed an empty ring's interior, from the surface sampled just outside it.
 *
 * `+1`: the outside is mostly shallower than the ring, so the ring is a pit — seed deeper. `-1`: the
 * outside is mostly deeper, so it is a shoal — seed shallower. `0` when the probes do not say (all
 * NaN, or a tie), and the ring is left flat: a coin-flip seed would invent a pit or a shoal.
 */
export function ringSeedDirection(levelFt: number, outside: readonly number[]): -1 | 0 | 1 {
  let shallower = 0;
  let deeper = 0;
  for (const v of outside) {
    if (!Number.isFinite(v)) continue;
    if (v < levelFt - 1e-3) shallower += 1;
    else if (v > levelFt + 1e-3) deeper += 1;
  }
  if (shallower === deeper) return 0;
  return shallower > deeper ? 1 : -1;
}

/**
 * Seed points inside a ring, on a lattice of `spacing`, kept at least `clearance` from the ring itself.
 *
 * The clearance keeps the band edge on the contour: a seed hard against the line would pull the
 * isoband off it. A ring too small to hold a seed at that clearance gets its pole — the interior
 * lattice point farthest from the line — so a small pit is not left flat just for being small; a ring
 * smaller than one lattice step falls back to its vertex average, when that is inside.
 */
export function seedLattice(ring: readonly XY[], spacing: number, clearance: number): XY[] {
  if (!(spacing > 0)) throw new Error(`spacing must be positive, got ${spacing}`);
  const b = boundsOf(ring);
  const seeds: XY[] = [];
  let pole: { p: XY; d: number } | undefined;
  for (let x = b.xmin + spacing / 2; x < b.xmax; x += spacing) {
    for (let y = b.ymin + spacing / 2; y < b.ymax; y += spacing) {
      const p = { x, y };
      if (!pointInRing(p, ring)) continue;
      const d = distanceToRing(p, ring);
      if (!pole || d > pole.d) pole = { p, d };
      if (d >= clearance) seeds.push(p);
    }
  }
  if (seeds.length > 0) return seeds;
  if (pole) return [pole.p];
  const n = Math.max(1, ring.length - 1);
  const mean = ring.slice(0, n).reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n }), {
    x: 0,
    y: 0,
  });
  return pointInRing(mean, ring) ? [mean] : [];
}

/** The seed depth for an empty ring: half a foot past its level, which no boundary sits within. */
export function seedDepth(levelFt: number, direction: -1 | 1): number {
  return Math.max(0, levelFt + direction * 0.5);
}

// ---------------------------------------------------------------------------------------------------
// Specks
// ---------------------------------------------------------------------------------------------------

/**
 * Drop rings smaller than `minArea` — exterior and interior alike.
 *
 * A traced isoband carries single-cell islands where the surface grazes a level, and they are grid
 * noise rather than bathymetry. **Holes go with them**, and that is what keeps the bands tiling the
 * lake: `gdal_contour -p` traces adjacent bands from one marching-squares pass, so a speck of band A is
 * exactly a hole of the same size in band B. Dropping only the speck would leave a gap; dropping both
 * hands the area to the band around it.
 */
export function dropSpecks(
  polygons: readonly Ring[][],
  minArea: number,
): { polygons: Ring[][]; dropped: number } {
  let dropped = 0;
  const kept: Ring[][] = [];
  for (const rings of polygons) {
    const [outer, ...holes] = rings;
    if (!outer || outer.length < 4 || Math.abs(signedArea(outer)) < minArea) {
      dropped += rings.length;
      continue;
    }
    const keptHoles = holes.filter((h) => h.length >= 4 && Math.abs(signedArea(h)) >= minArea);
    dropped += holes.length - keptHoles.length;
    kept.push([outer, ...keptHoles]);
  }
  return { polygons: kept, dropped };
}
