/**
 * The shoreline as a depth-zero boundary constraint (N6b).
 *
 * This is the piece §Maine step 3 specified and the first build skipped, and skipping it is why the
 * early samples looked wrong in a way that was structural rather than cosmetic:
 *
 * > *"Interpolate per lake, clipped to our polygon, with the shoreline as a depth-0 boundary
 * > constraint — that constraint is what keeps the fit from running deep at the shore, and it is the
 * > one place the distance-transform intuition is legitimately useful."*
 *
 * **A bathymetric map is a set of nested closed rings.** The shoreline is the outermost, at depth 0,
 * and every deeper contour sits inside the one above it. Soundings alone cannot produce that: they
 * sit in the middle of the lake, so the fitted surface has no anchor pulling depth toward zero at the
 * edge. The contours then wander off to the mask boundary instead of closing, and nothing nests
 * because there is no outer ring to nest inside. Adding the shore is what turns a field of squiggles
 * into a basin.
 *
 * **How densely to sample it is a real decision, and the first two answers were both wrong.**
 *
 * The first cut capped the shore at 2× the sounding count, on the theory that thousands of zero-depth
 * constraints would out-vote a few dozen readings. That was withdrawn because `blockmedian` reduces
 * the input to one value per grid cell before the spline sees it, so a dense shore fills cells rather
 * than stacking them — and because a *too*-thin shore leaves mid-arm water further from any constraint
 * than the interpolation mask allows, which cuts contours in water the fit actually knows.
 *
 * **That reasoning was half right, and measuring it on 2026-08-01 showed which half.** `blockmedian`
 * stops the shore *stacking* within a cell; it does nothing about the shore *occupying far more cells*
 * than the data does. Sampled at one grid cell regardless of survey effort, the shore's cell count is
 * set by lake size while the soundings' is set by how much sonar ran — and on Maine's lanes those
 * differ by more than an order of magnitude:
 *
 * | | sounding cells | shoreline cells | shore share |
 * | --- | --- | --- | --- |
 * | Washington Pond (ME) | 105 | 1,409 | **93%** |
 * | Lake Morey (VT) | 68,139 | 1,389 | 2% |
 *
 * A surface fitted 93% to distance-from-shoreline is approximately a distance transform, which is the
 * **GLOBathy failure this phase opens by refusing**, reached by a different road. So the shore is now
 * sampled against a budget tied to the measurements — see `shoreSpacingFor`, which keeps the original
 * objection intact by never letting the spacing exceed what the mask can bridge.
 *
 * It is also the one place we may legitimately *add* data we did not measure — because we are not
 * inventing a depth. The waterline of a lake is at the surface by definition; that is what makes it a
 * waterline. Everything else in this phase refuses to supply values nobody surveyed, and this is the
 * exception that proves the rule rather than a hole in it.
 */

import { haversineMeters } from '@skating/core';
import type { MultiPolygon, Polygon, Position } from 'geojson';

/**
 * The fewest shoreline points worth placing, however sparse the survey.
 *
 * The shore is not only a vote in the fit — it is what makes the contours *close*, which is the whole
 * reason §Maine step 3 exists. Below roughly this many points a lake's outline stops being a boundary
 * condition and becomes a scatter of zeros, and nothing nests.
 */
export const MIN_SHORE_POINTS = 120;

/** Total perimeter of every ring, interior ones included. Islands have shores too. */
export function perimeterMeters(geometry: Polygon | MultiPolygon): number {
  let total = 0;
  for (const ring of ringsOf(geometry)) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      if (!a || !b) continue;
      const [aLng, aLat] = a;
      const [bLng, bLat] = b;
      if (
        typeof aLng !== 'number' ||
        typeof aLat !== 'number' ||
        typeof bLng !== 'number' ||
        typeof bLat !== 'number'
      ) {
        continue;
      }
      total += haversineMeters({ lat: aLat, lng: aLng }, { lat: bLat, lng: bLng });
    }
  }
  return total;
}

/**
 * How far apart to place shoreline constraints, given how much the survey actually measured.
 *
 * **The budget is the sounding count**, so the shore gets roughly as many independent constraints as
 * the state took measurements, rather than as many as the lake is large. That is what stops a
 * 105-sounding pond being fitted 93% to its own outline.
 *
 * Two clamps, and both matter more than the budget does:
 *
 * - **Never coarser than half the mask radius.** This is the original objection, preserved: the
 *   interpolation mask refuses to draw water further than `MAX_GAP_RATIO` from a constraint, so a
 *   shore sampled more coarsely than that would cut its own contours in water the fit knows. Half,
 *   not equal, because the gap between two shore points is bridged from both ends.
 * - **Never finer than a grid cell.** Below that the extra points land in cells that are already
 *   occupied, so they cost time and buy nothing — `blockmedian` collapses them anyway.
 */
export function shoreSpacingFor(options: {
  perimeterM: number;
  soundingCells: number;
  cellSizeM: number;
  maskRadiusM: number;
}): number {
  const { perimeterM, soundingCells, cellSizeM, maskRadiusM } = options;
  if (!(perimeterM > 0)) return Math.max(cellSizeM, 1);
  const budget = Math.max(MIN_SHORE_POINTS, soundingCells);
  const ideal = perimeterM / budget;
  const coarsest = Math.max(cellSizeM, maskRadiusM / 2);
  return Math.min(coarsest, Math.max(cellSizeM, ideal));
}

/** A shoreline vertex, ready to join the sounding set. */
export interface ShorelinePoint {
  lng: number;
  lat: number;
  depthFt: 0;
}

/** Every exterior and interior ring of a polygon or multipolygon. Islands count — they have shores too. */
export function ringsOf(geometry: Polygon | MultiPolygon): Position[][] {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  return geometry.coordinates.flat();
}

/**
 * Resample a lake's shoreline to points no more than `spacingM` apart, each at depth 0.
 *
 * **Resampled rather than taken as-is**, and the distinction matters in both directions. OSM
 * shorelines are wildly uneven: a straight stretch may run hundreds of metres between two vertices
 * while a rocky point carries a vertex every two metres. Using the raw vertices would under-constrain
 * the straight stretches — leaving the fit free to run deep right up to the beach — and pile thousands
 * of redundant constraints onto the headlands, which is where a spline is most likely to ring.
 *
 * Interior rings (islands) are included, because an island is a place the depth is zero and a fit that
 * doesn't know that will happily put a basin under it.
 */
export function densifyShoreline(
  geometry: Polygon | MultiPolygon,
  spacingM: number,
): ShorelinePoint[] {
  if (!(spacingM > 0)) throw new Error(`spacingM must be positive, got ${spacingM}`);
  const out: ShorelinePoint[] = [];

  for (const ring of ringsOf(geometry)) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      if (!a || !b) continue;
      const [aLng, aLat] = a;
      const [bLng, bLat] = b;
      if (
        typeof aLng !== 'number' ||
        typeof aLat !== 'number' ||
        typeof bLng !== 'number' ||
        typeof bLat !== 'number'
      ) {
        continue;
      }

      out.push({ lng: aLng, lat: aLat, depthFt: 0 });

      const segment = haversineMeters({ lat: aLat, lng: aLng }, { lat: bLat, lng: bLng });
      // Interpolate along the segment when the source vertices are further apart than the spacing.
      // Only the *interior* points are added here; each segment's start is pushed above and its end
      // is the next segment's start, so no vertex is duplicated.
      const steps = Math.floor(segment / spacingM);
      for (let s = 1; s <= steps; s += 1) {
        const t = s / (steps + 1);
        out.push({ lng: aLng + (bLng - aLng) * t, lat: aLat + (bLat - aLat) * t, depthFt: 0 });
      }
    }
  }
  return out;
}
