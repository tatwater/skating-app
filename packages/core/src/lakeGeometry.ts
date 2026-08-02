/**
 * Derived lake-shape statistics (N6c Workstream A) — shoreline length, the long/short axis, and
 * the directional wind-fetch profile. Pure, framework-free and dependency-free, so the ETL, a
 * Convex function and a test can all reach the same numbers.
 *
 * ## The one rule that governs this whole file (D85)
 *
 * **These are measured on the *source* geometry, never on the copy we store.** The stored polygon
 * is Douglas–Peucker-simplified to ~5 m (`SIMPLIFY_TOLERANCE_DEG` in the ETL transform), and Lake
 * Champlain is coarsened further to fit Convex's 8,192-element array cap. That tolerance exists to
 * make *drawing* cheap, and it corrupts *describing*: perimeter is resolution-dependent (the
 * coastline paradox), so measuring the simplified copy under-reports systematically and worst on
 * exactly the big crenellated lakes where the number is most interesting.
 *
 * So every function here is called from `scripts/etl`'s transform **immediately before
 * `simplify()` runs**, and the results are stored as scalars. The array cap constrains what we can
 * store as *geometry*; it has nothing to say about what we can measure in flight.
 *
 * ## Still water only (D4)
 *
 * Every function assumes a closed, still-water polygon. Rivers are deferred, and the axis and
 * fetch numbers would be actively meaningless on a reach: a river's "long axis" is an artefact of
 * where the mapper cut the segment, and its "fetch" is the width of the channel. If rivers ever
 * enter the corpus, they must be excluded here rather than quietly measured.
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';
import { haversineMeters, type LatLng, pointInPolygon } from './geometry';

/**
 * Compass bearings the fetch profile is sampled at — **16**, at 22.5° steps (D-answer to N6c open
 * question 1).
 *
 * The precision argument between 16 and 18 is a wash (11.25° vs 10° of worst-case angular error,
 * against a centroid-based figure whose real uncertainty is far larger). What decides it is that
 * 16 bearings *are the compass points* — N, NNE, NE, ENE, … — which is both how weather APIs
 * report wind direction and how skaters describe it. That makes bucket *k* a name rather than a
 * rounding decision, and it is why `COMPASS_POINTS_16` lives in this file rather than in the
 * caption's: the bucket definition and the label are the same fact.
 */
export const FETCH_BEARING_COUNT = 16;

/** Degrees between adjacent fetch bearings. 360 / 16 — a fraction, which no float minds. */
export const FETCH_BEARING_STEP_DEG = 360 / FETCH_BEARING_COUNT;

/** The 16 compass points, in bucket order from north, clockwise. Index *is* the fetch bucket. */
export const COMPASS_POINTS_16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

export type CompassPoint16 = (typeof COMPASS_POINTS_16)[number];

/** Normalize any bearing into `[0, 360)`. */
function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * The fetch bucket a wind direction falls in — nearest of the 16 compass points.
 *
 * **The argument is a *meteorological* wind direction: the bearing the wind blows *from*.** That is
 * what Open-Meteo and every other forecast source reports, and it is the convention
 * `fetchProfileMeters` is indexed by, so a caller can pass today's `windDirection` straight through
 * with no arithmetic. Getting this backwards would silently report the fetch on the *lee* side,
 * which reads as a plausible number and is exactly wrong.
 */
export function fetchBucketFor(windFromBearingDeg: number): number {
  return (
    Math.round(normalizeBearing(windFromBearingDeg) / FETCH_BEARING_STEP_DEG) % FETCH_BEARING_COUNT
  );
}

/** The 16-point compass name for a bearing (e.g. `315` → `'NW'`). */
export function compassPointFor(bearingDeg: number): CompassPoint16 {
  return COMPASS_POINTS_16[fetchBucketFor(bearingDeg)] as CompassPoint16;
}

/**
 * The label for an **undirected axis** — a compass point and its opposite, e.g. `'NNE–SSW'`.
 *
 * An axis has no head, so naming it with a single point ("this lake runs NNE") invites reading a
 * direction into a line. The paired form is how the dimension line reads in the caption and how
 * skaters describe a lake's lie.
 */
export function axisCompassLabel(bearingDeg: number): string {
  // **Fold to [0, 180) BEFORE bucketing**, so a bearing and its reciprocal produce the same bucket
  // by construction rather than by luck. Bucketing each separately means two independent
  // `Math.round` calls on two different floats, and a bearing sitting exactly on a sector boundary
  // can round one way while its reciprocal rounds the other: `101.24999999999993` and its opposite
  // disagreed, which fast-check found on seed 1780398957 after this had passed hundreds of runs.
  const folded = normalizeBearing(bearingDeg) % 180;
  const bucket = fetchBucketFor(folded) % FETCH_BEARING_COUNT;
  const opposite = (bucket + FETCH_BEARING_COUNT / 2) % FETCH_BEARING_COUNT;
  // Lead with the northerly end (N through E), so an axis reads "N–S" and "NNW–SSE" rather than
  // "S–N" and "SSE–NNW". Purely conventional — the axis is undirected either way — but a lake
  // described as running "S–N" reads like a bug, and `longAxisBearingDeg` is folded to [0, 180),
  // which lands roughly half of all lakes on the southern label.
  const [first, second] =
    bucket <= FETCH_BEARING_COUNT / 4 ? [bucket, opposite] : [opposite, bucket];
  return `${COMPASS_POINTS_16[first]}–${COMPASS_POINTS_16[second]}`;
}

// ── Rings and projection ─────────────────────────────────────────────────────────────────────

/** The component polygons of a geometry — one for a `Polygon`, N for a `MultiPolygon`. */
function components(geom: Polygon | MultiPolygon): Position[][][] {
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
}

/** Is every position in this ring a finite `[lng, lat]` pair? Raw OSM carries junk. */
function ringIsUsable(ring: Position[]): boolean {
  if (ring.length < 4) return false; // a closed triangle is the smallest real ring
  return ring.every(
    (p) => p.length >= 2 && Number.isFinite(p[0] as number) && Number.isFinite(p[1] as number),
  );
}

/**
 * Local metres east/north of `origin` (equirectangular / flat-earth around the origin).
 *
 * Mirrors `geometry.ts`'s private helper deliberately rather than importing it: this file's
 * consumers project *whole lake polygons* around a centroid, where the relevant accuracy question
 * is "does a 40 km chord across Champlain measure right" rather than "is a 300 m buffer tight".
 * Sub-1% at that scale, which is far inside the uncertainty of every number here.
 */
function toLocal([lng, lat]: readonly [number, number], origin: LatLng): [number, number] {
  const DEG = Math.PI / 180;
  const EARTH_RADIUS_M = 6_371_008.8;
  return [
    (lng - origin.lng) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG),
    (lat - origin.lat) * DEG * EARTH_RADIUS_M,
  ];
}

// ── A3 — Shoreline length ────────────────────────────────────────────────────────────────────

/**
 * Total shoreline length in metres — **every ring of every component**, outer rings and island
 * holes alike.
 *
 * **Islands count, and that is the conventional definition.** A lake's shoreline is all the water's
 * edge, which is also what HydroLAKES' `Shore_len` measures — so the free cross-check the depth
 * join gives us (D85) compares like with like. It does mean the number is *not* the length of a
 * lap: a lake with a big island has more shoreline than perimeter. The caption says "shoreline"
 * and never "lap" for exactly this reason.
 *
 * Measured geodesically per segment (`haversineMeters`) rather than in a local projection, because
 * a shoreline can span tens of kilometres and the projection error would accumulate along it.
 *
 * **Never present the result as authoritative.** Measured at source resolution it is a real
 * improvement over the simplified copy, but OSM's shoreline is a tracing by many hands at many
 * zooms from different imagery, and it will not equal a published survey figure. This is D3-adjacent
 * and worth saying twice, because a distance *looks* like a hard fact in a way a modelled depth
 * does not — which makes it more dangerous to present bare, not less.
 */
export function shorelineMeters(geom: Polygon | MultiPolygon): number {
  let total = 0;
  for (const rings of components(geom)) {
    for (const ring of rings) {
      if (!ringIsUsable(ring)) continue;
      for (let i = 0; i + 1 < ring.length; i++) {
        const [aLng, aLat] = ring[i] as [number, number];
        const [bLng, bLat] = ring[i + 1] as [number, number];
        total += haversineMeters({ lat: aLat, lng: aLng }, { lat: bLat, lng: bLng });
      }
    }
  }
  return total;
}

// ── A2 — Long axis, short axis, bearing ──────────────────────────────────────────────────────

/** A lake's dimension line: the two sides of its minimum-area bounding rectangle. */
export interface LakeAxes {
  /** The longer side of the minimum-area bounding rectangle, in metres. */
  longAxisM: number;
  /**
   * The long axis's bearing in `[0, 180)`, degrees clockwise from north. **Undirected** — an axis
   * has no head, so 20° and 200° are the same axis and both normalize to 20°.
   */
  longAxisBearingDeg: number;
  /** The shorter side of the same rectangle, in metres. */
  shortAxisM: number;
}

/**
 * Andrew's monotone chain convex hull over local-metre points. Returns the hull in
 * counter-clockwise order without the closing duplicate. Fewer than three distinct points yields
 * the input, which the caller treats as degenerate.
 */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (pts: [number, number][]): [number, number][] => {
    const chain: [number, number][] = [];
    for (const p of pts) {
      while (
        chain.length >= 2 &&
        cross(
          chain[chain.length - 2] as [number, number],
          chain[chain.length - 1] as [number, number],
          p,
        ) <= 0
      ) {
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop(); // the last point is the first of the other chain
    return chain;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  return [...lower, ...upper];
}

/**
 * The lake's long and short axis and the long axis's undirected bearing — yielding the familiar
 * *"about 5 × 1 miles"* dimension line.
 *
 * **Outer rings only, across every component.** An island does not extend a lake, so holes are
 * excluded from the hull; a MultiPolygon's overall extent spans all its parts, because that is
 * what a dimension line for the *body* means.
 *
 * ## This is the minimum-area bounding rectangle, and the N6c plan specified something else
 *
 * The plan said *"the hull diameter (longest chord between hull vertices), giving `longAxisM`…
 * The perpendicular hull width gives `shortAxisM`."* **That pair does not produce a dimension
 * line**, and the error is a factor of two, not a rounding artefact. For a rectangle `w × h` with
 * `h ≫ w` the hull diameter is the *diagonal*, and the hull's extent measured perpendicular to
 * that diagonal is `2wh/L ≈ 2w` — because the two extreme corners sit on opposite sides of the
 * diagonal. A 5 × 1 mile lake would have rendered as "5 × 2 miles", plausibly and wrongly.
 *
 * The minimum-area bounding rectangle is the standard fix and costs the same rotating-calipers
 * sweep: its side is always collinear with a hull edge, so one pass over the hull's edges finds
 * it. It returns `h × w` exactly for a rectangle and major × minor for an ellipse, which is what
 * the dimension line is supposed to mean.
 *
 * *(The minimum **width** over all directions — the textbook "width of a convex body" — is a third
 * measure and also wrong here: on a boomerang-shaped lake it reports the narrow waist, which
 * describes neither dimension a skater pictures.)*
 *
 * Returns `null` for geometry with no usable ring or a degenerate (collinear / zero-extent) hull —
 * the ETL skips the stat rather than storing a zero that would read as a measurement.
 *
 * *Value on its own is modest — we already show surface area. It earns its place because the fetch
 * profile needs the projection anyway and the dimension line falls out for free.*
 */
export function lakeAxes(geom: Polygon | MultiPolygon, origin?: LatLng): LakeAxes | null {
  const outerRings: Position[][] = [];
  for (const rings of components(geom)) {
    const outer = rings[0];
    if (outer && ringIsUsable(outer)) outerRings.push(outer);
  }
  if (outerRings.length === 0) return null;

  // Any consistent projection origin works — the axis is translation-invariant. Default to the
  // first vertex so the function is usable without a centroid in hand.
  const first = outerRings[0]?.[0] as [number, number];
  const anchor = origin ?? { lat: first[1], lng: first[0] };

  const points: [number, number][] = [];
  for (const ring of outerRings) {
    // Skip the closing duplicate; it adds a coincident hull point and nothing else.
    for (let i = 0; i + 1 < ring.length; i++) {
      points.push(toLocal(ring[i] as [number, number], anchor));
    }
  }
  const hull = convexHull(points);
  if (hull.length < 3) return null; // collinear or collapsed — no rectangle to fit

  // Rotating calipers: the minimum-area enclosing rectangle always has a side collinear with a
  // hull edge, so testing each edge's orientation is exhaustive rather than a search.
  let bestArea = Number.POSITIVE_INFINITY;
  let bestLong = 0;
  let bestShort = 0;
  let bestLongIsAlongEdge = true;
  let bestEdge: [number, number] = [0, 1];

  for (let i = 0; i < hull.length; i++) {
    const p = hull[i] as [number, number];
    const q = hull[(i + 1) % hull.length] as [number, number];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    const ux = ex / len; // along the edge
    const uy = ey / len;

    let uMin = Number.POSITIVE_INFINITY;
    let uMax = Number.NEGATIVE_INFINITY;
    let vMin = Number.POSITIVE_INFINITY;
    let vMax = Number.NEGATIVE_INFINITY;
    for (const r of hull) {
      const alongEdge = r[0] * ux + r[1] * uy;
      const acrossEdge = -r[0] * uy + r[1] * ux; // the edge normal
      if (alongEdge < uMin) uMin = alongEdge;
      if (alongEdge > uMax) uMax = alongEdge;
      if (acrossEdge < vMin) vMin = acrossEdge;
      if (acrossEdge > vMax) vMax = acrossEdge;
    }
    const along = uMax - uMin;
    const across = vMax - vMin;
    const rectArea = along * across;
    if (rectArea < bestArea) {
      bestArea = rectArea;
      bestLong = Math.max(along, across);
      bestShort = Math.min(along, across);
      bestLongIsAlongEdge = along >= across;
      bestEdge = [ux, uy];
    }
  }
  if (bestLong === 0) return null;

  // The long side's direction is the edge itself when the edge-aligned extent is the longer one,
  // and the edge normal otherwise.
  const [ux, uy] = bestEdge;
  const dx = bestLongIsAlongEdge ? ux : -uy; // east
  const dy = bestLongIsAlongEdge ? uy : ux; // north
  // Bearing clockwise from north, folded to [0, 180) because an axis is undirected.
  const bearing = normalizeBearing((Math.atan2(dx, dy) * 180) / Math.PI) % 180;

  return {
    longAxisM: bestLong,
    longAxisBearingDeg: bearing,
    shortAxisM: bestShort,
  };
}

// ── The fetch origin — why it is not `waterBodies.centroid` ──────────────────────────────────

/**
 * How many scanlines to try in each direction when locating an interior point. Fifteen is enough
 * to find the open middle of any lake shape we hold and cheap enough to run 116,070 times.
 */
const INTERIOR_SCANLINES = 15;

/** Every x where the horizontal line `y = at` crosses one of these rings, in local metres. */
function horizontalCrossings(localRings: [number, number][][], at: number): number[] {
  const xs: number[] = [];
  for (const ring of localRings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [px, py] = ring[i] as [number, number];
      const [qx, qy] = ring[i + 1] as [number, number];
      // Half-open test, so a vertex exactly on the line is counted once rather than twice.
      if (py <= at === qy <= at) continue;
      xs.push(px + ((at - py) / (qy - py)) * (qx - px));
    }
  }
  return xs.sort((a, b) => a - b);
}

/**
 * The midpoint and length of the longest **water** span along the line `y = at`.
 *
 * Even–odd parity over sorted crossings, which handles islands for free: a line crossing the outer
 * ring and an island yields four crossings, and only spans 0–1 and 2–3 are water.
 */
function longestSpanAt(
  localRings: [number, number][][],
  at: number,
): { mid: number; length: number } | null {
  const xs = horizontalCrossings(localRings, at);
  let best: { mid: number; length: number } | null = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const a = xs[i] as number;
    const b = xs[i + 1] as number;
    const length = b - a;
    if (!best || length > best.length) best = { mid: (a + b) / 2, length };
  }
  return best;
}

/**
 * A point genuinely **inside** the water, for casting fetch rays from.
 *
 * ## Why this exists: `waterBodies.centroid` is not a centroid
 *
 * The stored `centroid` comes from `representativePoint`, i.e. Turf's `pointOnFeature`, which
 * guarantees a point *on* the feature — the bbox centre when that lands inside the polygon, and a
 * point on the **boundary** when it doesn't. For a curved or narrow lake the bbox centre is on dry
 * land, so the stored point sits on the shoreline. Measured on the dev corpus: Lake Willoughby's
 * `centroid` **is ring vertex 199**.
 *
 * Nothing upstream catches this, because `pointInPolygon` counts a boundary point as inside. It
 * was harmless for every prior consumer — the field exists for display and distance (D48), where
 * a shoreline point is fine — and it is fatal here: a ray cast north from a point on the *west*
 * shore correctly finds no water, so seven of Willoughby's sixteen bearings came back **0.0**, and
 * eight of Champlain's. The N6c plan's *"cast a ray through the centroid"* cannot be taken
 * literally.
 *
 * ## What this returns instead
 *
 * The midpoint of the longest horizontal or vertical water span, sampled over
 * `INTERIOR_SCANLINES` lines in each direction. Deterministic, `O(n)` per line, and **always
 * strictly interior** — a span's midpoint lies between two boundary crossings by construction.
 * It also lands where the water is most open, which is the right bias for a figure describing
 * exposure.
 *
 * *(The textbook answer is the pole of inaccessibility — the centre of the largest inscribed
 * circle. It is a better point and it needs a dependency we don't have and a quadtree we'd have to
 * maintain; the difference between the two is far inside the uncertainty of a centroid-scale fetch
 * figure, which A4 already states is the dominant error here.)*
 *
 * **The largest component wins** on a MultiPolygon, not the one containing the stored centroid —
 * both because that centroid may sit on a boundary and because the main basin is the honest
 * subject of a whole-body statistic.
 *
 * Returns `null` for geometry with no usable ring or no interior at all.
 */
export function fetchOrigin(geom: Polygon | MultiPolygon): LatLng | null {
  // Pick the component with the largest bbox extent — a proxy for area that costs no geodesy.
  let chosen: Position[][] | null = null;
  let chosenExtent = -1;
  for (const rings of components(geom)) {
    const outer = rings[0];
    if (!outer || !ringIsUsable(outer)) continue;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of outer as [number, number][]) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    const extent = (maxLat - minLat) * (maxLng - minLng);
    if (extent > chosenExtent) {
      chosenExtent = extent;
      chosen = rings;
    }
  }
  if (!chosen) return null;

  const outer = chosen[0] as Position[];
  const anchor = anchorFor(outer);
  const localRings = chosen
    .filter(ringIsUsable)
    .map((ring) => (ring as [number, number][]).map((p) => toLocal(p, anchor)));
  const outerLocal = localRings[0] as [number, number][];

  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  for (const [x, y] of outerLocal) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
  }

  let best: { x: number; y: number; length: number } | null = null;

  // Horizontal spans.
  for (let i = 1; i <= INTERIOR_SCANLINES; i++) {
    const y = yMin + ((yMax - yMin) * i) / (INTERIOR_SCANLINES + 1);
    const span = longestSpanAt(localRings, y);
    if (span && (!best || span.length > best.length))
      best = { x: span.mid, y, length: span.length };
  }
  // Vertical spans — the same scan with the axes swapped, which catches an east–west lake whose
  // horizontal chords are all long but whose widest opening is across it.
  const swapped = localRings.map((ring) => ring.map(([x, y]) => [y, x] as [number, number]));
  for (let i = 1; i <= INTERIOR_SCANLINES; i++) {
    const x = xMin + ((xMax - xMin) * i) / (INTERIOR_SCANLINES + 1);
    const span = longestSpanAt(swapped, x);
    if (span && (!best || span.length > best.length))
      best = { x, y: span.mid, length: span.length };
  }
  if (!best) return null;

  const DEG = Math.PI / 180;
  const EARTH_RADIUS_M = 6_371_008.8;
  return {
    lat: anchor.lat + best.y / (EARTH_RADIUS_M * DEG),
    lng: anchor.lng + best.x / (EARTH_RADIUS_M * Math.cos(anchor.lat * DEG) * DEG),
  };
}

/** Projection anchor for a ring — its first vertex. Any consistent choice works. */
function anchorFor(ring: Position[]): LatLng {
  const [lng, lat] = ring[0] as [number, number];
  return { lat, lng };
}

// ── A4 — Directional fetch profile ───────────────────────────────────────────────────────────

/**
 * Distance from the ray origin to the **first** boundary crossing along `bearingDeg`, in local
 * metres, or `null` when the ray never crosses one.
 *
 * The first crossing is exactly the end of the contiguous over-water run containing the origin,
 * which is what makes islands and concave shorelines come out honestly with no special casing: an
 * island's ring is a boundary like any other, so a ray that meets one at 800 m reports 800 m.
 */
function firstBoundaryCrossing(
  rings: Position[][],
  anchor: LatLng,
  bearingDeg: number,
): number | null {
  const rad = (bearingDeg * Math.PI) / 180;
  const rx = Math.sin(rad); // east component of a north-clockwise bearing
  const ry = Math.cos(rad); // north component
  let nearest = Number.POSITIVE_INFINITY;

  for (const ring of rings) {
    if (!ringIsUsable(ring)) continue;
    for (let i = 0; i + 1 < ring.length; i++) {
      const p = toLocal(ring[i] as [number, number], anchor);
      const q = toLocal(ring[i + 1] as [number, number], anchor);
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      // Solve origin + t·r = p + u·e for t ≥ 0, u ∈ [0, 1].
      const denom = rx * ey - ry * ex;
      if (denom === 0) continue; // parallel: a grazing edge contributes no crossing
      const t = (p[0] * ey - p[1] * ex) / denom;
      const u = (p[0] * ry - p[1] * rx) / denom;
      if (t > 0 && u >= 0 && u <= 1 && t < nearest) nearest = t;
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
}

/**
 * The 16-bearing wind-fetch profile at the body's centroid, in metres — `fetchProfileM` on
 * `waterBodies`.
 *
 * **Wind fetch** is the distance wind travels over open water before reaching a point. It is one of
 * the main determinants of whether a lake sets smooth black ice or gets chopped and wind-slabbed,
 * and of where pressure ridges tend to form. Skaters already reason about it — *"the north end will
 * be rough today"* — and we hold every polygon needed to compute it.
 *
 * **Precomputed, never computed at read time.** Sixteen numbers per body is trivially small; the
 * drawer already has today's wind bearing from the Phase 10 weather fetch, so at read time it is a
 * `fetchBucketFor(windDirection)` lookup and zero geometry.
 *
 * **Indexed by the direction the wind blows *from*** (see `fetchBucketFor`), so
 * `profile[fetchBucketFor(windDir)]` is the answer with no arithmetic at the call site.
 *
 * ## Limitations, stated here so nobody "fixes" them later
 *
 * - It is a **single-point** profile, not per-point. Fetch genuinely varies across a large lake;
 *   this characterizes the whole body and the copy must not imply otherwise.
 * - **It is measured from `fetchOrigin`, not from `waterBodies.centroid`** — see that function for
 *   why the stored "centroid" is sometimes a point on the shoreline, and what that did to this
 *   profile before it was caught.
 * - The **contiguous run** rule stops at the first shore, island included. Summing water segments
 *   across an island would overstate exposure, which is the wrong direction to be wrong in.
 * - **MultiPolygon bodies use the largest component**, since fetch across open land to a detached
 *   basin is not fetch.
 * - **Sub-areas (N2) should eventually get their own profiles** — a named bay is exactly the scale
 *   at which per-point fetch starts to matter. Deferred; the field shape already supports it, since
 *   sub-areas carry their own geometry.
 * - **Rivers would produce nonsense** (D4) — see this file's header.
 *
 * Returns `null` for geometry with no usable interior (degenerate input the ETL skips). A bearing
 * whose ray finds no crossing at all — geometrically impossible from a strictly interior point, so
 * a sign of broken input — records **0** rather than a guess: understating exposure is the safe
 * direction, and a zero in a profile of non-zeros is visible in review.
 */
export function fetchProfileMeters(geom: Polygon | MultiPolygon, origin?: LatLng): number[] | null {
  // A caller-supplied origin is honoured only if it is genuinely in the water; otherwise (and by
  // default) we derive one. Passing `waterBodies.centroid` must not silently produce a shore-cast
  // profile, which is exactly the bug this guard exists for.
  const from = origin && isStrictlyInside(geom, origin) ? origin : fetchOrigin(geom);
  if (!from) return null;

  const rings = componentContaining(geom, from);
  if (!rings) return null;

  const profile: number[] = [];
  for (let k = 0; k < FETCH_BEARING_COUNT; k++) {
    const crossing = firstBoundaryCrossing(rings, from, k * FETCH_BEARING_STEP_DEG);
    profile.push(crossing ?? 0);
  }
  return profile;
}

/** The component whose rings enclose `point`, or `null`. */
function componentContaining(geom: Polygon | MultiPolygon, point: LatLng): Position[][] | null {
  for (const rings of components(geom)) {
    const outer = rings[0];
    if (!outer || !ringIsUsable(outer)) continue;
    if (pointInPolygon(point, { type: 'Polygon', coordinates: rings })) return rings;
  }
  return null;
}

/**
 * Is this point inside the water and **not on its edge**?
 *
 * `pointInPolygon` counts the boundary as inside, which is the right call for "is this report on
 * this lake" and the wrong one for "can I cast a ray from here". A metre of clearance is far below
 * any real shoreline feature and far above float noise.
 */
function isStrictlyInside(geom: Polygon | MultiPolygon, point: LatLng): boolean {
  const rings = componentContaining(geom, point);
  if (!rings) return false;
  for (const ring of rings) {
    if (!ringIsUsable(ring)) continue;
    for (let i = 0; i + 1 < ring.length; i++) {
      const p = toLocal(ring[i] as [number, number], point);
      const q = toLocal(ring[i + 1] as [number, number], point);
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const len2 = ex * ex + ey * ey;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-p[0] * ex - p[1] * ey) / len2));
      if (Math.hypot(p[0] + t * ex, p[1] + t * ey) < 1) return false;
    }
  }
  return true;
}

// ── The composed stat block the ETL stores ───────────────────────────────────────────────────

/** Every derived shape stat for one body. Each field is independently omittable. */
export interface LakeGeometryStats {
  shorelineM?: number;
  longAxisM?: number;
  longAxisBearingDeg?: number;
  shortAxisM?: number;
  fetchProfileM?: number[];
}

/**
 * Compute every N6c Workstream A shape stat for one body, from the **source** geometry (D85).
 *
 * Resilient by design: each stat is omitted rather than zeroed when its geometry is degenerate, so
 * one unusable ring costs one field instead of failing a feature — the same per-feature discipline
 * the ETL transform applies around it.
 */
export function lakeGeometryStats(
  geom: Polygon | MultiPolygon,
  centroid?: LatLng,
): LakeGeometryStats {
  const stats: LakeGeometryStats = {};

  const shoreline = shorelineMeters(geom);
  if (shoreline > 0) stats.shorelineM = shoreline;

  const axes = lakeAxes(geom, centroid);
  if (axes) {
    stats.longAxisM = axes.longAxisM;
    stats.longAxisBearingDeg = axes.longAxisBearingDeg;
    stats.shortAxisM = axes.shortAxisM;
  }

  // `centroid` is the projection anchor for the axes only. The fetch profile derives its own
  // origin, because the stored centroid may be a point on the shoreline — see `fetchOrigin`.
  const fetch = fetchProfileMeters(geom);
  if (fetch) stats.fetchProfileM = fetch;

  return stats;
}
