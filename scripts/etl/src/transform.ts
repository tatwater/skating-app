/**
 * ETL transform (Phase 1) — the tested heart of the OSM water-body pipeline.
 *
 * Turns raw `osmium export` water features into canonical bodies for
 * `waterBodies.importCanonical`: classify OSM tags → our `type` (dropping non-still-water),
 * simplify to ~5 m fidelity (D48), then compute `bbox` / on-water `centroid` / surface area
 * from the *simplified* geometry (what actually gets stored). Pure and framework-free — the
 * geometry + classification live in `@skating/core`; this composes them and adds the
 * per-feature resilience the ETL needs (a degenerate polygon is skipped, never aborts a batch).
 */

import {
  type OsmTags,
  polygonBBox,
  representativePoint,
  surfaceAreaSqM,
  waterBodyTypeFromOsmTags,
} from '@skating/core';
import simplify from '@turf/simplify';
import type { MultiPolygon, Polygon } from 'geojson';
import type { CanonicalBody, OsmWaterFeature, OsmWaterProperties } from './types';

/**
 * Douglas–Peucker tolerance in degrees ≈ 5 m at Vermont's latitude (~0.00005° of latitude).
 * Applied uniformly to *every* body as the fidelity-first baseline (D48). A body is coarsened
 * past this only to satisfy a Convex hard limit — the 1 MiB/doc size and the 8192-element array
 * cap (see `simplifyForStorage` / `CONVEX_ARRAY_LIMIT`), which realistically only Lake Champlain
 * hits. Tunable: eyeball Champlain + a small pond on the map once it renders and adjust (open
 * item in the phase-1 plan).
 */
export const SIMPLIFY_TOLERANCE_DEG = 0.00005;

/**
 * Convex rejects any array longer than **8192 elements**. For a polygon that cap applies to
 * *every* level — the position count in a ring, the ring count in a polygon, and the polygon
 * count in a MultiPolygon — and `importCanonical` fails the whole loader batch if any body
 * breaches it. See `maxArrayLength` (the complete check) and `largestRingSize` (the reducible
 * dimension that adaptive coarsening drives).
 */
export const CONVEX_ARRAY_LIMIT = 8192;

/**
 * Coarsening target for a ring's coordinate array — a safety margin under `CONVEX_ARRAY_LIMIT`
 * to absorb day-to-day drift in the Geofabrik extract. A uniform 5 m pass leaves Lake
 * Champlain's outer ring at ~8,900 vertices (raw is ~19k); realistically it's the *only*
 * Vermont body over the limit, and it fits by ~7 m.
 */
export const MAX_RING_VERTICES = 8000;

/**
 * Step for the adaptive coarsening below (~1 m at Vermont's latitude). We nudge the tolerance
 * up by this much at a time — *not* by doubling — so a body that overflows the array limit by
 * a little is coarsened by only a little (fidelity-first, D48): Champlain settles at ~7 m
 * rather than the ~10 m a doubling step would jump to.
 */
const SIMPLIFY_STEP_DEG = 0.00001;

/**
 * Largest coordinate count across all rings — the dimension coarsening can actually reduce
 * (Douglas–Peucker thins vertices *within* a ring). Drives `simplifyForStorage`.
 */
export function largestRingSize(geom: Polygon | MultiPolygon): number {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  return rings.reduce((max, ring) => Math.max(max, ring.length), 0);
}

/**
 * The largest array Convex will see anywhere in this geometry: the polygon count, any ring
 * count, or any ring's position count. This is the *complete* array-limit check — coarsening
 * only fixes the position count, so a (pathological, never-seen-in-hydrography) body with
 * >8192 components or holes is caught here and skipped per-feature rather than failing a batch.
 */
export function maxArrayLength(geom: Polygon | MultiPolygon): number {
  const polygons = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let max = polygons.length; // MultiPolygon: number of components
  for (const rings of polygons) {
    max = Math.max(max, rings.length); // number of rings (outer + holes)
    for (const ring of rings) max = Math.max(max, ring.length); // positions in the ring
  }
  return max;
}

/**
 * The stable OSM id we key `externalId` on: `way/123` / `relation/456` — the standard OSM
 * feature identifier (as used by osm.org URLs, Nominatim, …), NOT osmium's internal area id
 * (the top-level GeoJSON `id`, e.g. `a9106880`, which is `osm_id * 2 (+1 for relations)`).
 * Returns `null` when the attributes are absent (feature not exported with `-a type,id`).
 */
export function externalIdFromProperties(
  props: OsmWaterProperties | null | undefined,
): string | null {
  if (!props) return null;
  const type = props['@type'];
  const id = props['@id'];
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  return `${type}/${id}`;
}

/**
 * Simplify to the ~5 m fidelity target (D48) without mutating the input. If a ring is still
 * over Convex's 8192-element array limit, coarsen *that body only* by nudging the tolerance up
 * one `SIMPLIFY_STEP_DEG` (~1 m) at a time until every ring fits under `MAX_RING_VERTICES` —
 * the least coarsening that fits, rather than a blunt doubling. Fidelity-first everywhere else;
 * this is the hard-limit escape hatch, realistically hit by Lake Champlain alone (settles ~7 m).
 */
function simplifyForStorage(geom: Polygon | MultiPolygon): Polygon | MultiPolygon {
  let tolerance = SIMPLIFY_TOLERANCE_DEG;
  let simplified = simplify(geom, { tolerance, highQuality: false, mutate: false });
  // Douglas–Peucker is monotonic in tolerance (a coarser pass never adds vertices), so stepping
  // up always converges on a fit; the guard is a backstop against a pathological non-shrinker.
  for (let step = 0; step < 10_000 && largestRingSize(simplified) > MAX_RING_VERTICES; step++) {
    tolerance += SIMPLIFY_STEP_DEG;
    simplified = simplify(geom, { tolerance, highQuality: false, mutate: false });
  }
  return simplified;
}

/**
 * Transform one OSM feature into a canonical body, or `null` to **skip by classification**
 * (rivers / streams / generic wetland / … — `waterBodyTypeFromOsmTags` returns `null`).
 *
 * **Throws** on data we can't turn into a storable body: a missing `@type`/`@id`, a non-area
 * geometry, a degenerate polygon `representativePoint` can't place a point on, or a geometry
 * that still breaches Convex's 8192-element array cap after coarsening. Batching raw OSM must
 * catch per feature (see `transformFeatures`) — raw data carries enough junk geometry that a
 * single throw must not kill the import (phase-1 plan / PR#1 review P2).
 */
export function featureToCanonicalBody(feature: OsmWaterFeature): CanonicalBody | null {
  const props: OsmWaterProperties = feature.properties ?? {};
  const type = waterBodyTypeFromOsmTags(props as OsmTags);
  if (type === null) return null;

  const externalId = externalIdFromProperties(props);
  if (externalId === null) {
    throw new Error('feature is missing @type/@id (export with `osmium export -a type,id`)');
  }

  const geom = feature.geometry;
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
    throw new Error(`unsupported geometry type "${geom.type}" (expected a polygon area)`);
  }

  // Simplify first, then derive bbox / centroid / area from the geometry we actually store.
  const polygon = simplifyForStorage(geom);
  // Coarsening thins ring positions but can't reduce component/hole counts; reject (→ skip)
  // anything still over the array cap so one bad body never fails a whole loader batch.
  const maxArray = maxArrayLength(polygon);
  if (maxArray > CONVEX_ARRAY_LIMIT) {
    throw new Error(
      `geometry array too large (${maxArray} > ${CONVEX_ARRAY_LIMIT}) after coarsening`,
    );
  }
  const centroid = representativePoint(polygon); // throws on a collapsed / degenerate ring
  return {
    source: 'osm',
    externalId,
    name: typeof props.name === 'string' ? props.name : '',
    type,
    polygon,
    bbox: polygonBBox(polygon),
    centroid,
    surfaceAreaSqM: surfaceAreaSqM(polygon),
  };
}

/** Per-feature outcome tally for the run summary. */
export interface TransformSummary {
  /** Features seen. */
  total: number;
  /** Bodies produced (imported). */
  imported: number;
  /** Skipped by classification — non-still-water we defer this phase (rivers, wetland, …). */
  droppedByType: number;
  /** Skipped because the feature threw (bad geometry / missing id) — see `errors`. */
  skipped: number;
}

/** A feature that threw during transform, kept for the run summary rather than aborting. */
export interface TransformError {
  externalId: string;
  message: string;
}

export interface TransformOutput {
  bodies: CanonicalBody[];
  summary: TransformSummary;
  errors: TransformError[];
}

/**
 * Transform a batch of features, isolating each failure (skip + tally) so one bad polygon
 * never aborts the import (phase-1 plan / PR#1 review P2). `droppedByType` is intentional
 * classification skips; `skipped` (with `errors`) is features that threw.
 */
export function transformFeatures(features: Iterable<OsmWaterFeature>): TransformOutput {
  const bodies: CanonicalBody[] = [];
  const errors: TransformError[] = [];
  let total = 0;
  let droppedByType = 0;

  for (const feature of features) {
    total++;
    try {
      const body = featureToCanonicalBody(feature);
      if (body === null) {
        droppedByType++;
        continue;
      }
      bodies.push(body);
    } catch (err) {
      errors.push({
        externalId:
          externalIdFromProperties(feature.properties) ?? String(feature.id ?? '(unknown)'),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    bodies,
    summary: { total, imported: bodies.length, droppedByType, skipped: errors.length },
    errors,
  };
}
