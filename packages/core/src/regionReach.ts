/**
 * **Which loaded towns a body's outline reaches into** (D266) — the one rule behind region
 * membership, a body's town list, its counties and its states. The import asks it whether a body is
 * ours at all (in at least one loaded town); the geometry facts ask it for the towns a body lies in.
 * Both ask the same function, against the same layer: the TIGER county subdivisions (towns, and the
 * "not defined" water units between them), which tile each loaded state.
 *
 * ## The rule
 *
 * A body is in a town when its outline **reaches inside that town's boundary by more than the
 * margin** ({@link REGION_MARGIN_M}): some point of the outline lies inside the town and farther than
 * the margin from every one of the town's edges. A body that holds a whole town (an island town, a
 * water unit inside a big lake) is in it too. When no town is reached that deeply:
 *
 * - **outside** — some point of the outline lies outside every loaded town by more than the margin:
 *   the body is elsewhere and only grazes the line. It is in no town, so out of region.
 * - **near a line** — every point of the outline lies inside a town or within the margin of a line:
 *   a body smaller than the margin's own uncertainty. It is in every town it touches at all, so it
 *   is never left in none.
 *
 * ## Exact along every edge, not at sampled points
 *
 * For each outline edge, the stretches within the margin of a town edge are found as intervals — a
 * line meets a capsule (the points within `r` of a segment) in one interval, solved in closed form.
 * What is left of the edge lies farther than the margin from every town edge, so each leftover piece
 * is wholly inside the town or wholly outside it, and one point-in-polygon test settles it. An edge
 * crossing (a town line running across a pond) is a covered interval like any other; nothing depends
 * on a vertex landing in the right place.
 *
 * Distances are measured in a local equirectangular frame (meters), centered on the body's latitude
 * rounded to {@link FRAME_STEP_DEG}. Across the half-degree a frame serves the east-west scale drifts
 * under 0.5%, about 7 cm at the margin, and the frame step lets a long run share prepared towns.
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';

/**
 * **How far an outline must reach past a town line to count as inside it, in meters.**
 *
 * The town layer is TIGER/Line simplified to about 5 m; measured against the raw TIGER line, its
 * worst error is 7.2 m (New Hampshire's state line; p99 under 5 m in every state). A body's outline
 * carries its own ~5 m simplification (D48). The two together are about 12 m of honest uncertainty
 * about which side of a line a stretch of shore sits on, rounded up to 15 m — about twice the
 * boundary's worst. A body that reaches past a line by less than this may not cross it at all.
 */
export const REGION_MARGIN_M = 15;

/**
 * The margin a **touch** is measured at — one centimeter, not zero, so an edge crossing always has an
 * interval to sit in and floating-point never leaves a crossing uncovered.
 */
export const REACH_TOUCH_M = 0.01;

/** The latitude step the measuring frame snaps to (see the module note). */
export const FRAME_STEP_DEG = 0.5;

/** Meters per degree of latitude on the WGS84 mean sphere (as `haversineMeters` measures). */
const M_PER_DEG = 6_371_008.8 * (Math.PI / 180);

type Geom = Polygon | MultiPolygon;

/** A town (or any area) the rule tests against. */
export interface ReachArea {
  id: string;
  polygon: Geom;
}

/** Why the rule answered as it did — see the module note. */
export type ReachBasis = 'reach' | 'near-line' | 'outside';

export interface ReachResult {
  /** The areas the body is in, the one holding the most of its shore first; ties by id. */
  ids: string[];
  basis: ReachBasis;
}

/** One accumulating run of the rule over one body, fed its candidate areas a page at a time. */
export interface Reach {
  /** Test a page of candidate areas. Order-free; an id already tested is skipped. */
  add(areas: readonly ReachArea[]): void;
  /** The answer over every area added so far. */
  result(): ReachResult;
}

/** Areas prepared in one frame, kept across bodies — a long run shares them (see {@link createReach}). */
export type ReachCache = Map<string, PreparedArea>;

// ── Prepared geometry ────────────────────────────────────────────────────────────────────────

/** Rings in the frame, as flat `[x0, y0, x1, y1, …]`, closed, with repeated points dropped. */
interface Rings {
  rings: Float64Array[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A town in the frame: its rings, an edge grid for "what is near this segment", y-bands for PIP. */
export interface PreparedArea extends Rings {
  /** Edge endpoints, flat: `[x0, y0, x1, y1]` per edge. */
  edges: Float64Array;
  cell: number;
  grid: Map<number, number[]>;
  bands: Bands;
}

interface Bands {
  minY: number;
  height: number;
  rows: number[][];
  edges: Float64Array;
}

function frameFor(lat: number): { kx: number; ky: number; lat0: number } {
  const lat0 = Math.round(lat / FRAME_STEP_DEG) * FRAME_STEP_DEG;
  return { kx: M_PER_DEG * Math.cos((lat0 * Math.PI) / 180), ky: M_PER_DEG, lat0 };
}

function ringsOf(geom: Geom): Position[][] {
  return geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
}

function project(geom: Geom, kx: number, ky: number): Rings {
  const rings: Float64Array[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ring of ringsOf(geom)) {
    const out: number[] = [];
    for (const p of ring) {
      const x = (p[0] as number) * kx;
      const y = (p[1] as number) * ky;
      const n = out.length;
      if (n >= 2 && out[n - 2] === x && out[n - 1] === y) continue;
      out.push(x, y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // Closed, whatever the input said: an open ring still bounds the same area.
    if (out.length >= 2 && (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1])) {
      out.push(out[0] as number, out[1] as number);
    }
    // Fewer than three distinct points bound nothing.
    if (out.length >= 8) rings.push(Float64Array.from(out));
  }
  return { rings, minX, minY, maxX, maxY };
}

function edgesOf(r: Rings): Float64Array {
  let n = 0;
  for (const ring of r.rings) n += ring.length / 2 - 1;
  const edges = new Float64Array(n * 4);
  let k = 0;
  for (const ring of r.rings) {
    for (let i = 0; i + 3 < ring.length; i += 2) {
      edges[k++] = ring[i] as number;
      edges[k++] = ring[i + 1] as number;
      edges[k++] = ring[i + 2] as number;
      edges[k++] = ring[i + 3] as number;
    }
  }
  return edges;
}

const KEY_OFFSET = 1 << 19;
const cellKey = (ix: number, iy: number) => (ix + KEY_OFFSET) * (1 << 20) + (iy + KEY_OFFSET);

function bandsOf(r: Rings, edges: Float64Array): Bands {
  const count = edges.length / 4;
  const n = Math.max(1, Math.min(4096, Math.ceil(count / 8)));
  const height = Math.max((r.maxY - r.minY) / n, 1e-9);
  const rows: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < count; e++) {
    const y0 = edges[e * 4 + 1] as number;
    const y1 = edges[e * 4 + 3] as number;
    const lo = Math.max(0, Math.min(n - 1, Math.floor((Math.min(y0, y1) - r.minY) / height)));
    const hi = Math.max(0, Math.min(n - 1, Math.floor((Math.max(y0, y1) - r.minY) / height)));
    for (let b = lo; b <= hi; b++) (rows[b] as number[]).push(e);
  }
  return { minY: r.minY, height, rows, edges };
}

/** Even-odd containment over every ring (holes and parts alike) — for points off the boundary. */
function inside(b: Bands, x: number, y: number): boolean {
  const row = b.rows[Math.floor((y - b.minY) / b.height)];
  if (row === undefined) return false;
  let odd = false;
  const E = b.edges;
  for (const e of row) {
    const x0 = E[e * 4] as number;
    const y0 = E[e * 4 + 1] as number;
    const x1 = E[e * 4 + 2] as number;
    const y1 = E[e * 4 + 3] as number;
    if (y0 > y !== y1 > y && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) odd = !odd;
  }
  return odd;
}

/** Prepare a town in a frame: its edges, an edge grid sized to its edges, and its y-bands. */
export function prepareArea(polygon: Geom, kx: number, ky: number): PreparedArea {
  const r = project(polygon, kx, ky);
  const edges = edgesOf(r);
  const count = edges.length / 4;
  let total = 0;
  for (let e = 0; e < count; e++) {
    total += Math.hypot(
      (edges[e * 4 + 2] as number) - (edges[e * 4] as number),
      (edges[e * 4 + 3] as number) - (edges[e * 4 + 1] as number),
    );
  }
  // About two edges a cell: a near-edge lookup then reads a handful, however long the town's edges.
  const cell = Math.min(5_000, Math.max(50, count > 0 ? (2 * total) / count : 50));
  const grid = new Map<number, number[]>();
  for (let e = 0; e < count; e++) {
    const x0 = edges[e * 4] as number;
    const y0 = edges[e * 4 + 1] as number;
    const x1 = edges[e * 4 + 2] as number;
    const y1 = edges[e * 4 + 3] as number;
    const ix0 = Math.floor(Math.min(x0, x1) / cell);
    const ix1 = Math.floor(Math.max(x0, x1) / cell);
    const iy0 = Math.floor(Math.min(y0, y1) / cell);
    const iy1 = Math.floor(Math.max(y0, y1) / cell);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const k = cellKey(ix, iy);
        const list = grid.get(k);
        if (list) list.push(e);
        else grid.set(k, [e]);
      }
    }
  }
  return { ...r, edges, cell, grid, bands: bandsOf(r, edges) };
}

// ── The interval arithmetic ──────────────────────────────────────────────────────────────────

/**
 * Clip `t` so that `p + t·q` lies in `[lo, hi]`, narrowing `[t0, t1]` (Liang–Barsky's step). Returns
 * the narrowed pair, or `null` when nothing is left.
 */
function clip(
  p: number,
  q: number,
  lo: number,
  hi: number,
  t0: number,
  t1: number,
): [number, number] | null {
  if (Math.abs(q) < 1e-300) return p < lo || p > hi ? null : [t0, t1];
  let a = (lo - p) / q;
  let b = (hi - p) / q;
  if (a > b) [a, b] = [b, a];
  const s = Math.max(t0, a);
  const e = Math.min(t1, b);
  return s <= e ? [s, e] : null;
}

/**
 * The `t ∈ [0, 1]` where `a + t·d` lies within `r` of the segment `c → e` — one interval, since a
 * capsule is convex: the hull of the line's meeting with the two end disks and the side slab.
 * Returns `[lo, hi]`, or `null` when the edge never comes that close.
 */
export function capsuleInterval(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  r: number,
): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const dd = dx * dx + dy * dy;
  for (const [px, py] of [
    [cx, cy],
    [ex, ey],
  ] as const) {
    const fx = ax - px;
    const fy = ay - py;
    const b = dx * fx + dy * fy;
    const c = fx * fx + fy * fy - r * r;
    const disc = b * b - dd * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      lo = Math.min(lo, (-b - s) / dd);
      hi = Math.max(hi, (-b + s) / dd);
    }
  }
  const len = Math.hypot(ex - cx, ey - cy);
  if (len > 0) {
    const ux = (ex - cx) / len;
    const uy = (ey - cy) / len;
    const fx = ax - cx;
    const fy = ay - cy;
    const along = clip(
      fx * ux + fy * uy,
      dx * ux + dy * uy,
      0,
      len,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    const slab = along && clip(-fx * uy + fy * ux, -dx * uy + dy * ux, -r, r, along[0], along[1]);
    if (slab) {
      lo = Math.min(lo, slab[0]);
      hi = Math.max(hi, slab[1]);
    }
  }
  lo = Math.max(lo, 0);
  hi = Math.min(hi, 1);
  return lo <= hi ? [lo, hi] : null;
}

/** Shorter than this (as a share of an edge) a leftover piece is a rounding artifact, not shore. */
const PIECE_MIN = 1e-12;

/** `[0, 1]` less the union of `covered` (flat pairs), as flat pairs. */
function gapsOf(covered: number[]): number[] {
  if (covered.length === 0) return [0, 1];
  const pairs: [number, number][] = [];
  for (let i = 0; i < covered.length; i += 2) {
    pairs.push([covered[i] as number, covered[i + 1] as number]);
  }
  pairs.sort((p, q) => p[0] - q[0]);
  const out: number[] = [];
  let at = 0;
  for (const [s, e] of pairs) {
    if (s - at > PIECE_MIN) out.push(at, s);
    if (e > at) at = e;
  }
  if (1 - at > PIECE_MIN) out.push(at, 1);
  return out;
}

/** The overlap of two sorted, disjoint flat interval lists. */
function intersect(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i] as number, b[j] as number);
    const e = Math.min(a[i + 1] as number, b[j + 1] as number);
    if (e - s > PIECE_MIN) out.push(s, e);
    if ((a[i + 1] as number) < (b[j + 1] as number)) i += 2;
    else j += 2;
  }
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────

interface Verdict {
  /** Reached by more than the margin, or held whole. */
  deep: boolean;
  /** Touched at all (at {@link REACH_TOUCH_M}), or held whole. */
  touch: boolean;
  /** Meters of outline inside the area — the order the towns are listed in. */
  shore: number;
}

/** What one pass of the body's edges against one area found, at one margin. */
interface Pass {
  deep: boolean;
  near: boolean;
  shore: number;
}

/**
 * Start a run of the rule over one body. `marginM` defaults to {@link REGION_MARGIN_M}; `cache`
 * shares prepared areas across bodies in the same frame (a long batch run passes one map).
 */
export function createReach(
  body: Geom,
  opts: { marginM?: number; cache?: ReachCache } = {},
): Reach {
  const margin = Math.max(opts.marginM ?? REGION_MARGIN_M, REACH_TOUCH_M);
  const cache = opts.cache;
  let sumLat = 0;
  let nLat = 0;
  for (const ring of ringsOf(body)) {
    for (const p of ring) {
      sumLat += p[1] as number;
      nLat++;
    }
  }
  const frame = frameFor(nLat > 0 ? sumLat / nLat : 0);
  const shape = project(body, frame.kx, frame.ky);
  const edges = edgesOf(shape);
  const edgeCount = edges.length / 4;
  const bodyBands = bandsOf(shape, edges);
  /** Each edge's stretches still outside every area by more than the margin; `null` is all of it. */
  const remaining: (number[] | null)[] = new Array(edgeCount).fill(null);
  const verdicts = new Map<string, Verdict>();

  function prepared(area: ReachArea): PreparedArea {
    if (!cache) return prepareArea(area.polygon, frame.kx, frame.ky);
    const key = `${area.id}@${frame.lat0}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const made = prepareArea(area.polygon, frame.kx, frame.ky);
    cache.set(key, made);
    return made;
  }

  /** One pass of every edge near the area, at margin `r`; `track` narrows `remaining`. */
  function pass(a: PreparedArea, r: number, track: boolean): Pass {
    const out: Pass = { deep: false, near: false, shore: 0 };
    const seen = new Uint32Array(a.edges.length / 4);
    let stamp = 0;
    const E = a.edges;
    for (let i = 0; i < edgeCount; i++) {
      const ax = edges[i * 4] as number;
      const ay = edges[i * 4 + 1] as number;
      const bx = edges[i * 4 + 2] as number;
      const by = edges[i * 4 + 3] as number;
      const minX = Math.min(ax, bx) - r;
      const maxX = Math.max(ax, bx) + r;
      const minY = Math.min(ay, by) - r;
      const maxY = Math.max(ay, by) + r;
      if (maxX < a.minX || minX > a.maxX || maxY < a.minY || minY > a.maxY) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const covered: number[] = [];
      stamp++;
      const ix1 = Math.floor(maxX / a.cell);
      const iy1 = Math.floor(maxY / a.cell);
      for (let ix = Math.floor(minX / a.cell); ix <= ix1; ix++) {
        for (let iy = Math.floor(minY / a.cell); iy <= iy1; iy++) {
          const list = a.grid.get(cellKey(ix, iy));
          if (!list) continue;
          for (const e of list) {
            if (seen[e] === stamp) continue;
            seen[e] = stamp;
            const hit = capsuleInterval(
              ax,
              ay,
              dx,
              dy,
              E[e * 4] as number,
              E[e * 4 + 1] as number,
              E[e * 4 + 2] as number,
              E[e * 4 + 3] as number,
              r,
            );
            if (hit) covered.push(hit[0], hit[1]);
          }
        }
      }
      if (covered.length > 0) out.near = true;
      const gaps = gapsOf(covered);
      const outside: number[] = [];
      const len = Math.hypot(dx, dy);
      for (let g = 0; g < gaps.length; g += 2) {
        const s = gaps[g] as number;
        const e = gaps[g + 1] as number;
        const t = (s + e) / 2;
        if (inside(a.bands, ax + dx * t, ay + dy * t)) {
          out.deep = true;
          out.shore += (e - s) * len;
        } else {
          outside.push(s, e);
        }
      }
      if (track) remaining[i] = intersect(remaining[i] ?? [0, 1], outside);
    }
    return out;
  }

  return {
    add(areas) {
      for (const area of areas) {
        if (verdicts.has(area.id)) continue;
        const a = prepared(area);
        if (a.rings.length === 0) {
          verdicts.set(area.id, { deep: false, touch: false, shore: 0 });
          continue;
        }
        const far =
          a.maxX < shape.minX - margin ||
          a.minX > shape.maxX + margin ||
          a.maxY < shape.minY - margin ||
          a.minY > shape.maxY + margin;
        if (far || edgeCount === 0) {
          verdicts.set(area.id, { deep: false, touch: false, shore: 0 });
          continue;
        }
        const deep = pass(a, margin, true);
        const touch = pass(a, REACH_TOUCH_M, false);
        // Held whole: no edge of the town comes near the outline, and a point of it is in the body.
        const ring = a.rings[0] as Float64Array;
        const held = !touch.near && inside(bodyBands, ring[0] as number, ring[1] as number);
        verdicts.set(area.id, {
          deep: deep.deep || held,
          touch: touch.deep || held,
          shore: touch.shore,
        });
      }
    },
    result() {
      const ranked = (pick: (v: Verdict) => boolean) =>
        [...verdicts.entries()]
          .filter(([, v]) => pick(v))
          .sort((p, q) => q[1].shore - p[1].shore || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
          .map(([id]) => id);
      const reached = ranked((v) => v.deep);
      if (reached.length > 0) return { ids: reached, basis: 'reach' };
      const out = remaining.some((r) => r === null || r.length > 0);
      if (out) return { ids: [], basis: 'outside' };
      const touched = ranked((v) => v.touch);
      return touched.length > 0
        ? { ids: touched, basis: 'near-line' }
        : { ids: [], basis: 'outside' };
    },
  };
}

/** The rule over one body and every candidate at once — {@link createReach} with one page. */
export function areasReached(
  body: Geom,
  areas: readonly ReachArea[],
  opts: { marginM?: number; cache?: ReachCache } = {},
): ReachResult {
  const run = createReach(body, opts);
  run.add(areas);
  return run.result();
}

// ── The town layer's keys ────────────────────────────────────────────────────────────────────

/** A TIGER boundary's `externalId` (`tiger/<GEOID>`) → its GEOID, or `null` for any other key. */
function geoidOf(externalId: string): string | null {
  const m = /^tiger\/(\d+)$/.exec(externalId);
  return m ? (m[1] as string) : null;
}

/**
 * A county subdivision's county, as the county row's `externalId` — a subdivision's GEOID is its
 * state (2), county (3) and subdivision (5) codes, so its first five digits are its county's GEOID.
 * `null` for a key that is not a subdivision's.
 */
export function countyKeyOfSubdivision(externalId: string): string | null {
  const g = geoidOf(externalId);
  return g !== null && g.length === 10 ? `tiger/${g.slice(0, 5)}` : null;
}

/**
 * TIGER's **"County subdivisions not defined"** — the water units (Lake Ontario's, Massachusetts
 * Bay's) between towns, subdivision code `00000`. A body reaching into one is in region and in its
 * county and state, but it is not a town and never listed as one.
 */
export function isUndefinedSubdivision(externalId: string): boolean {
  const g = geoidOf(externalId);
  return g !== null && g.length === 10 && g.endsWith('00000');
}
