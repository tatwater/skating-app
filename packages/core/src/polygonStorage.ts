import simplify from '@turf/simplify';
import type { MultiPolygon, Polygon } from 'geojson';

/** Convex limits every array independently: polygon components, rings, and positions. */
export const CONVEX_ARRAY_LIMIT = 8192;
/** Leave room under the hard limit when adaptive coarsening is needed. */
export const MAX_RING_VERTICES = 8000;
/** Fidelity-first Douglas–Peucker baseline, roughly 5 m of latitude (D48). */
const SIMPLIFY_TOLERANCE_DEG = 0.00005;
const SIMPLIFY_STEP_DEG = 0.00001;

/** Largest position count in any ring, the dimension coarsening can reduce. */
export function largestRingSize(geometry: Polygon | MultiPolygon): number {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  return rings.reduce((largest, ring) => Math.max(largest, ring.length), 0);
}

/** Largest component, ring, or position array in the geometry. */
export function maxArrayLength(geometry: Polygon | MultiPolygon): number {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let largest = polygons.length;
  for (const rings of polygons) {
    largest = Math.max(largest, rings.length);
    for (const ring of rings) largest = Math.max(largest, ring.length);
  }
  return largest;
}

/**
 * Coarsen only when needed, in ~1 m steps, always starting from the original geometry. The
 * caller still checks the hard array limit: simplification cannot remove excess rings or
 * components, and the iteration cap guards against pathological input.
 */
export function simplifyForStorage(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  let tolerance = SIMPLIFY_TOLERANCE_DEG;
  let simplified = simplify(geometry, { tolerance, highQuality: false, mutate: false });
  for (let step = 0; step < 10_000 && largestRingSize(simplified) > MAX_RING_VERTICES; step++) {
    tolerance += SIMPLIFY_STEP_DEG;
    simplified = simplify(geometry, { tolerance, highQuality: false, mutate: false });
  }
  return simplified;
}
