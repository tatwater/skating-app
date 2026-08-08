/**
 * How far the worst-covered water in a polygon is from the nearest measurement (D98, N7).
 *
 * ## The half of the referee that `containedFraction` cannot be
 *
 * D92 decides which catalogue draws a lake by asking our own 2.4 million soundings, and one metric
 * cannot answer it. `containedFraction` asks *"what share of the survey falls inside this outline"* —
 * which punishes a polygon that is **too small** and is completely blind to one that is too large. A
 * polygon covering the lake and the field next to it contains every sounding, scores 1.0, and wins.
 *
 * This asks the mirror question: **probe the polygon's own area, and measure how far each probe is
 * from the nearest sounding.** A polygon that over-draws the lake has probes out in the pasture with
 * no measurement anywhere near them, and its gap climbs. Together the two are bounded on both sides —
 * too small loses containment, too big loses coverage — and neither can be gamed by the other's
 * failure mode.
 *
 * ## Why the probe region is the body and not the sounding hull
 *
 * `assessDensity` in the bathymetry ETL probes the **convex hull of the soundings**, which is the
 * right region for the question it asks (*"is this survey dense enough to interpolate?"*) and exactly
 * the wrong one here. A hull is drawn *by* the soundings, so it can never contain a region far from
 * one — the measure would be blind to the failure it exists to detect. D98 is the note that the probe
 * region has to be the body; this is that measure, kept separate rather than folded into
 * `assessDensity`, because changing that function's probe region would silently move a shipped gate
 * (`MAX_GAP_RATIO = 0.22` was tuned against the hull denominator and would stop meaning what it
 * means).
 *
 * ## `sqrt(area)`, not the bounding-box diagonal
 *
 * The scale a gap is judged against must not reward elongation. Measured across 2,437 joined bodies,
 * the sounding-bbox diagonal runs 1.76× `sqrt(area)` at the 5th percentile and 3.36× at the 95th — so
 * a long thin lake got a denominator nearly twice a round lake's of the same area, and therefore
 * nearly twice as easy a pass. `sqrt(area)` is shape-neutral.
 *
 * **For the bake-off the ratio barely matters and the raw metres do.** Two candidate polygons are
 * scored against the *same* soundings, so the comparison needs no threshold at all — which is what
 * makes the bake-off free of D98's unresolved recalibration.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { haversineMeters, type LatLng, pointInPolygon, surfaceAreaSqM } from './geometry';

/** Probe grid resolution per axis, over the polygon's bounding box. */
const DEFAULT_GRID = 32;

/** The percentile of probe distances reported as *the* gap. */
const GAP_PERCENTILE = 0.95;

export interface ProbeCoverage {
  /** Probes that landed inside the polygon. `0` means the result is `null`, not zero-gap. */
  readonly probes: number;
  /** Distance from the worst-covered probe (p95) to its nearest measurement, in metres. */
  readonly gapM: number;
  /** Mean probe-to-measurement distance, in metres — reported alongside, never decided on. */
  readonly meanGapM: number;
  /** `sqrt(surfaceAreaSqM)`, the shape-neutral scale the gap is judged against. */
  readonly scaleM: number;
  /** `gapM / scaleM`. Dimensionless, comparable across lake sizes. */
  readonly ratio: number;
}

/**
 * A uniform-grid nearest-neighbour index over the measurements.
 *
 * **Needed, not premature.** The naive loop is probes × points, and the bake-off runs it twice per
 * lake over ~2,400 lakes: at a 32² grid and a few thousand soundings that is billions of haversines
 * and the script does not finish. Bucketing to a grid and expanding ring by ring makes each query
 * cost the handful of points actually nearby.
 *
 * Degrees, not metres, because the buckets only need to be *consistent* — the distances themselves
 * are still measured with `haversineMeters`. Longitude degrees shrink with latitude, so a cell is
 * wider than it is tall in metres; that costs a few extra candidates per query and no correctness,
 * because the ring expansion is bounded by the best distance found rather than by a cell count.
 */
class PointGrid {
  private readonly cells = new Map<string, LatLng[]>();
  private readonly size: number;

  constructor(points: readonly LatLng[], cellDeg: number) {
    this.size = cellDeg;
    for (const p of points) {
      const key = this.key(p.lng, p.lat);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(p);
      else this.cells.set(key, [p]);
    }
  }

  private key(lng: number, lat: number): string {
    return `${Math.floor(lng / this.size)}:${Math.floor(lat / this.size)}`;
  }

  /** Metres to the nearest measurement, or `Infinity` if the index is empty. */
  nearest(probe: LatLng): number {
    const cx = Math.floor(probe.lng / this.size);
    const cy = Math.floor(probe.lat / this.size);
    let best = Number.POSITIVE_INFINITY;
    // Expand ring by ring. Stop when the closest *possible* point in the next ring — which is at
    // least `ring - 1` cells away — cannot beat what we already have. Without that bound this
    // silently degrades to a full scan on a sparse lake.
    for (let ring = 0; ring < 64; ring++) {
      if (Number.isFinite(best)) {
        const floorDeg = (ring - 1) * this.size;
        // Degrees of latitude are ~111 km everywhere; using latitude alone is a conservative
        // (under-)estimate of the true metre distance, which is what a search bound must be.
        if (floorDeg * 111_320 > best) break;
      }
      let sawAny = false;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          // Only the shell of the ring; the interior was covered by a previous iteration.
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
          if (!bucket) continue;
          sawAny = true;
          for (const p of bucket) {
            const d = haversineMeters(probe, p);
            if (d < best) best = d;
          }
        }
      }
      // A ring that found nothing and has no chance of a bound is still worth expanding past, but
      // once we have *something* and the bound above holds, we are done.
      if (!sawAny && ring > 32 && !Number.isFinite(best)) break;
    }
    return best;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/**
 * Probe a polygon's own area and report how far its worst-covered water is from a measurement.
 *
 * Returns `null` when the question cannot be asked — no measurements, or a polygon so small or thin
 * that no grid probe lands inside it. **`null` is not a zero and not a failure**; a caller comparing
 * two candidates must treat it as "this metric abstained", because scoring an abstention as a win
 * would hand the verdict to whichever polygon was too skinny to probe.
 */
export function probeCoverage(
  polygon: Polygon | MultiPolygon,
  points: readonly LatLng[],
  options: { grid?: number; areaSqM?: number } = {},
): ProbeCoverage | null {
  if (points.length === 0) return null;
  const grid = Math.max(4, options.grid ?? DEFAULT_GRID);

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  const rings = polygon.type === 'Polygon' ? polygon.coordinates : polygon.coordinates.flat();
  for (const ring of rings) {
    for (const c of ring) {
      const lng = c[0] as number;
      const lat = c[1] as number;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng) || maxLng <= minLng || maxLat <= minLat) return null;

  // One cell per ~4 probe spacings: big enough that most queries resolve in the first ring or two,
  // small enough that a dense lake does not put every sounding in one bucket.
  const cellDeg = Math.max((maxLng - minLng) / grid, (maxLat - minLat) / grid, 1e-6) * 4;
  const index = new PointGrid(points, cellDeg);

  const distances: number[] = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const probe = {
        lng: minLng + ((maxLng - minLng) * (i + 0.5)) / grid,
        lat: minLat + ((maxLat - minLat) * (j + 0.5)) / grid,
      };
      if (!pointInPolygon(probe, polygon)) continue;
      const d = index.nearest(probe);
      if (Number.isFinite(d)) distances.push(d);
    }
  }
  if (distances.length === 0) return null;

  distances.sort((a, b) => a - b);
  const areaSqM = options.areaSqM ?? surfaceAreaSqM(polygon);
  const scaleM = Math.sqrt(Math.max(areaSqM, 1));
  const gapM = percentile(distances, GAP_PERCENTILE);
  const meanGapM = distances.reduce((s, d) => s + d, 0) / distances.length;

  return {
    probes: distances.length,
    gapM,
    meanGapM,
    scaleM,
    ratio: gapM / scaleM,
  };
}
