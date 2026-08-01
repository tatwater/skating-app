/**
 * The density gate (N6b §Maine step 2) — does this lake have enough soundings to interpolate?
 *
 * This is the integrity of the whole sounding lane. Vermont and Maine publish measured points, not
 * isobaths, so **we** fit the surface — and an interpolator will happily draw smooth, confident,
 * beautiful contours through three readings. The gate is what stops the layer degrading into
 * invented basin shape on exactly the lakes with the least data, and it is why the same pipeline can
 * be honest about Vermont (37,000 soundings per lake) and Maine (a median of 48).
 *
 * ## The plan's proposed metric doesn't work, and the data says so
 *
 * §Maine suggests *"a maximum **nearest-neighbour** gap relative to lake extent."* For transect data
 * — which is what both a sonar log and a digitised depth map are — nearest-neighbour measures the
 * spacing of readings **along** a boat's track, and says nothing about the distance **between**
 * tracks. Measured across real Maine lakes, the true coverage gap runs **8–12× larger** than
 * nearest-neighbour implies. One example from the archive: a lake with a 81 m median
 * nearest-neighbour distance whose worst-covered water is **981 m** from any sounding, on a basin
 * 4.4 km across.
 *
 * So the gate asks the question that actually matters for interpolation:
 *
 * > **Standing anywhere in the surveyed area, how far is the nearest real measurement?**
 *
 * ## Why the hull, and not a bounding box
 *
 * Probing a bbox measures dry land, which makes every lake look badly covered in proportion to how
 * little it resembles a rectangle. Probing only near existing soundings is worse, and subtly so: it
 * **truncates the very distribution it is measuring** — cap probes at 0.25 × extent and no lake can
 * ever score worse than 0.25. (That mistake was made, and caught, while sizing this gate.)
 *
 * The convex hull of the soundings is the honest middle: it is roughly the water the survey covered,
 * it costs nothing to compute, and it does not bound the answer. A concave bay the survey skipped is
 * counted as a gap, which is correct — we would be interpolating across it.
 */

import { haversineMeters, type LatLng } from '@skating/core';

/** The minimum a lake needs before the spatial test is even meaningful. */
export const MIN_SOUNDINGS = 12;

/**
 * How far the worst-covered water may be from a measurement, as a fraction of the lake's extent.
 *
 * **0.12, set by looking (founder call, 2026-08-01).** Twelve real Maine lakes were rendered in three
 * bands — ~7–8%, ~9–10%, ~11–12% — specifically to avoid choosing from one or two lucky examples.
 * The result overturned the premise of the question: **visual quality does not track this ratio.**
 * The worst map in the grid was Long Lake at **10%**, which has 304 soundings — more than any other
 * sample — while Quantabacook at 11% and Foley at 12% both read cleanly. Nothing in the comparison
 * argued for stricter, so the gate sits where coverage is defensible rather than where quality was
 * assumed to live.
 *
 * What that leaves: the real quality problem is contour *crowding and angularity*, which is a
 * rendering concern and is fixed at the smoothing stage, not by refusing lakes.
 *
 * Tunable, and deliberately exposed rather than inlined. D82 is what makes a generous setting cheap —
 * contours make no claim, so a lake with none costs the skater nothing, and equally a lake with
 * imperfect ones is not asserting anything false.
 */
export const MAX_GAP_RATIO = 0.12;

/** How finely to probe. 24×24 over the bbox is plenty to find a hole and cheap enough for 1,528 lakes. */
const PROBE_GRID = 24;

/** Cap the soundings used for distance probing. Vermont's densest lake has 136,856; 400 answers the same question. */
const MAX_PROBE_SOUNDINGS = 400;

export interface DensityInput {
  lakeKey: string;
  points: readonly { lng: number; lat: number }[];
}

export type DensityVerdict =
  | 'ok'
  /** Fewer readings than the spatial test can say anything about. */
  | 'too-few-points'
  /** Enough readings, but they leave too much of the basin unmeasured. */
  | 'too-sparse'
  /** No spatial extent — every sounding at one spot, or a single point. */
  | 'degenerate';

export interface DensityAssessment {
  lakeKey: string;
  pointCount: number;
  /** The bbox diagonal, in metres. The lake's characteristic size. */
  extentM: number;
  /** p95 distance from a probe inside the surveyed hull to the nearest sounding, in metres. */
  coverageGapM: number;
  /** `coverageGapM / extentM` — scale-free, so a pond and Champlain are judged on the same terms. */
  gapRatio: number;
  verdict: DensityVerdict;
  /** Human-readable, for the drop log. Every rejected lake is named, per the no-silent-caps rule. */
  reason?: string;
}

/**
 * Convex hull by Andrew's monotone chain. Returns the hull in counter-clockwise order.
 *
 * Operates on raw lng/lat rather than a projection: over one lake the distortion is far below what a
 * hull is being used for here (deciding which probe points are roughly inside the surveyed water).
 */
export function convexHull(
  points: readonly { lng: number; lat: number }[],
): { lng: number; lat: number }[] {
  const unique = [...new Map(points.map((p) => [`${p.lng},${p.lat}`, p])).values()];
  if (unique.length < 3) return unique;

  const sorted = unique.sort((a, b) => (a.lng === b.lng ? a.lat - b.lat : a.lng - b.lng));
  const cross = (
    o: { lng: number; lat: number },
    a: { lng: number; lat: number },
    b: { lng: number; lat: number },
  ): number => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);

  const build = (source: readonly { lng: number; lat: number }[]) => {
    const half: { lng: number; lat: number }[] = [];
    for (const point of source) {
      while (half.length >= 2) {
        const a = half[half.length - 2];
        const b = half[half.length - 1];
        if (a && b && cross(a, b, point) <= 0) half.pop();
        else break;
      }
      half.push(point);
    }
    half.pop();
    return half;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

/** Ray-casting point-in-polygon over a flat ring of lng/lat. */
function inHull(point: LatLng, hull: readonly { lng: number; lat: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i, i += 1) {
    const a = hull[i];
    const b = hull[j];
    if (!a || !b) continue;
    const intersects =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Evenly thin a list to at most `limit` entries, preserving spatial spread. */
function thin<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.floor(i * step)];
    // `!== undefined`, not truthiness — a falsy element of a generic list is still an element.
    if (item !== undefined) out.push(item);
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

/**
 * Assess one lake.
 *
 * The p95 rather than the max is deliberate: a hull is a slight over-estimate of the surveyed water,
 * so its extreme corners are exactly where a probe is most likely to be sitting on land the survey
 * never intended to cover. The max would be dominated by that artifact; p95 measures the basin.
 */
export function assessDensity(
  input: DensityInput,
  options: { maxGapRatio?: number; minPoints?: number } = {},
): DensityAssessment {
  const maxGapRatio = options.maxGapRatio ?? MAX_GAP_RATIO;
  const minPoints = options.minPoints ?? MIN_SOUNDINGS;
  const points = input.points;

  const base = { lakeKey: input.lakeKey, pointCount: points.length };

  if (points.length < minPoints) {
    return {
      ...base,
      extentM: 0,
      coverageGapM: 0,
      gapRatio: Number.POSITIVE_INFINITY,
      verdict: 'too-few-points',
      reason: `${points.length} soundings, below the ${minPoints} needed to judge coverage`,
    };
  }

  // Looped rather than `Math.min(...lngs)`: spreading an array into a call blows the stack somewhere
  // around 10⁵ arguments, and Vermont's densest lake carries 136,856 soundings. It threw on the first
  // real run — the tests, built on grids of a few hundred points, could never have reached it.
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const extentM = haversineMeters({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng });

  if (extentM <= 0) {
    return {
      ...base,
      extentM: 0,
      coverageGapM: 0,
      gapRatio: Number.POSITIVE_INFINITY,
      verdict: 'degenerate',
      reason: 'every sounding at the same location — no spatial extent to interpolate over',
    };
  }

  const hull = convexHull(points);
  const probeSoundings = thin(points, MAX_PROBE_SOUNDINGS);
  const distances: number[] = [];

  for (let i = 0; i < PROBE_GRID; i += 1) {
    for (let j = 0; j < PROBE_GRID; j += 1) {
      const probe = {
        lng: minLng + ((maxLng - minLng) * i) / (PROBE_GRID - 1),
        lat: minLat + ((maxLat - minLat) * j) / (PROBE_GRID - 1),
      };
      if (!inHull(probe, hull)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const sounding of probeSoundings) {
        const d = haversineMeters(probe, sounding);
        if (d < nearest) nearest = d;
      }
      if (Number.isFinite(nearest)) distances.push(nearest);
    }
  }

  if (distances.length === 0) {
    // A hull too thin to contain any grid probe — a single transect line with no width. There is no
    // surface to fit here, only a profile.
    return {
      ...base,
      extentM,
      coverageGapM: 0,
      gapRatio: Number.POSITIVE_INFINITY,
      verdict: 'degenerate',
      reason: 'soundings form a line, not an area — no basin to interpolate',
    };
  }

  distances.sort((a, b) => a - b);
  const coverageGapM = percentile(distances, 0.95);
  const gapRatio = coverageGapM / extentM;

  if (gapRatio > maxGapRatio) {
    return {
      ...base,
      extentM,
      coverageGapM,
      gapRatio,
      verdict: 'too-sparse',
      reason:
        `worst-covered water is ${Math.round(coverageGapM)} m from a sounding on a ` +
        `${Math.round(extentM)} m lake (${(gapRatio * 100).toFixed(0)}% > ${(maxGapRatio * 100).toFixed(0)}%)`,
    };
  }

  return { ...base, extentM, coverageGapM, gapRatio, verdict: 'ok' };
}

/**
 * How much of a fitted surface is our own shoreline rather than the state's measurements.
 *
 * **The second gate, and it asks a different question from the first.** `MAX_GAP_RATIO` asks *"how far
 * is the nearest measurement"*; this asks *"how much of the fit is measurement at all"* — and on the
 * sparse lanes the second question is the one that decides whether the lane is honest. Measured on
 * 2026-08-01, Maine's lakes were 84–96% shoreline and Vermont's 2–8%, and a surface fitted mostly to
 * distance-from-shore is approximately a distance transform, which is the GLOBathy failure this phase
 * opens by refusing.
 *
 * Counted in **occupied grid cells**, never in raw points, because `blockmedian` reduces the input to
 * one value per cell before the spline sees anything. A transect of 1,387 readings collapsing into 24
 * cells carries 24 measurements' worth of information, and counting the 1,387 would hide exactly the
 * lakes this exists to find.
 */
export function shoreShare(soundingCells: number, shorelineCells: number): number {
  const total = soundingCells + shorelineCells;
  if (!(total > 0)) return 1;
  return shorelineCells / total;
}

/**
 * The most of a fit that may be our own outline before we decline to draw it.
 *
 * **Set from the post-rebalance distribution** (see `shoreSpacingFor`) rather than from the numbers
 * that prompted it — rebalancing the shoreline budget moved every lake, so a threshold chosen against
 * the old figures would have been measuring a problem that no longer existed.
 *
 * Generous on purpose, for the same reason `MAX_GAP_RATIO` is: D82 means a lake with no contours costs
 * the skater nothing, so the gate can sit where the claim stops being defensible rather than where the
 * picture stops being pretty.
 */
export const MAX_SHORE_SHARE = 0.75;

/** Summarise a run for the drop log — counts by verdict, and every dropped lake named. */
export function summariseDensity(assessments: readonly DensityAssessment[]): {
  kept: DensityAssessment[];
  dropped: DensityAssessment[];
  byVerdict: Record<DensityVerdict, number>;
} {
  const byVerdict: Record<DensityVerdict, number> = {
    ok: 0,
    'too-few-points': 0,
    'too-sparse': 0,
    degenerate: 0,
  };
  for (const a of assessments) byVerdict[a.verdict] += 1;
  return {
    kept: assessments.filter((a) => a.verdict === 'ok'),
    dropped: assessments.filter((a) => a.verdict !== 'ok'),
    byVerdict,
  };
}
