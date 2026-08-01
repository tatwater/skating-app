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
 * It is also the one place we may legitimately *add* data we did not measure — because we are not
 * inventing a depth. The waterline of a lake is at the surface by definition; that is what makes it a
 * waterline. Everything else in this phase refuses to supply values nobody surveyed, and this is the
 * exception that proves the rule rather than a hole in it.
 */

import { haversineMeters } from '@skating/core';
import type { MultiPolygon, Polygon, Position } from 'geojson';

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

/**
 * Thin a shoreline so it cannot out-vote the soundings.
 *
 * A dense shore against a sparse survey is its own failure mode: with a few thousand zero-depth
 * constraints ringing 46 real readings, the fit is dominated by the boundary and every lake converges
 * on the same shallow dish regardless of what the survey found. The shore should shape the *edge* of
 * the surface, not author its interior.
 *
 * Capping the shoreline at a multiple of the sounding count keeps the constraint proportionate — the
 * shore still closes the rings, and the measurements still decide the shape.
 */
export function capShoreline<T>(points: readonly T[], soundingCount: number, ratio = 2): T[] {
  const limit = Math.max(4, Math.round(soundingCount * ratio));
  if (points.length <= limit) return [...points];
  const step = points.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const point = points[Math.floor(i * step)];
    // Compared against `undefined` rather than tested for truthiness: a generic `T` may legitimately
    // be `0`, `''` or `false`, and `if (point)` silently drops those. Caught by a test whose fixture
    // was an index array, where it quietly ate element zero.
    if (point !== undefined) out.push(point);
  }
  return out;
}
