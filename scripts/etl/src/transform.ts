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
  fetchOrigin,
  lakeGeometryStats,
  MAX_PLAUSIBLE_DEPTH_M,
  type OsmTags,
  polygonBBox,
  representativePoint,
  surfaceAreaSqM,
  waterBodyTypeFromOsmTags,
} from '@skating/core';
import simplify from '@turf/simplify';
import type { MultiPolygon, Polygon } from 'geojson';
import type { CanonicalBody, OsmDepthRecord, OsmWaterFeature, OsmWaterProperties } from './types';

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

  // ── D85: measure the SOURCE geometry, here, before anything touches it ──────────────────────
  //
  // This line is the whole of D85 and it is one line, which is exactly why it is easy to move by
  // accident. `geom` is the full-resolution OSM ring; three lines down it becomes a ~5 m
  // Douglas-Peucker approximation (~7 m for Champlain, coarsened to fit the D48 array cap).
  // Perimeter is resolution-dependent — the coastline paradox — so measuring after `simplify()`
  // under-reports systematically, and worst on the big crenellated lakes where a shoreline figure
  // is most interesting. The stored polygon exists for drawing; these stats exist for describing.
  //
  // **Do not move this below `simplifyForStorage`.** The stats would still compute, still look
  // plausible, and be quietly short on precisely the bodies that matter most.
  const stats = lakeGeometryStats(geom);
  const interiorPoint = fetchOrigin(geom) ?? undefined;

  // Simplify, then derive bbox / centroid / area from the geometry we actually store.
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
    ...(interiorPoint ? { interiorPoint } : {}),
    ...stats,
  };
}

// ── OSM depth tags (N6a rung 7) ──────────────────────────────────────────────────────────────
//
// The roadmap filed this as "the ETL update carrying OSM `depth`/`maxdepth` tags where they exist",
// folded into N6a — and the N6a review found it had never been written, leaving `osm_tag` an enum value
// with no producer. It rides *this* pass rather than the depth ETL's, because the tags arrive with the
// OSM export and the depth pipeline never sees an OSM feature.

/** Feet → metres, for a tag that spells its unit. */
const M_PER_FOOT = 0.3048;

/**
 * Parse an OSM depth tag value to metres, or `undefined` if it isn't an unambiguous single depth.
 *
 * **Deliberately strict**, because this is the bottom rung and a wrong number here is worse than no
 * number: a bare value is metres (the OSM default unit), an explicit `m` / `ft` / `'` is converted, and
 * everything else — ranges (`2-3`), approximations (`~5`), comparisons (`>10`), unparseable junk — is
 * refused rather than guessed at. There is no unit *detection* here and there can't be: `10` might be a
 * chart in feet, which is precisely why this rung sits below every model in the ladder.
 */
export function parseOsmDepthMeters(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = String(raw).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(m|metre|metres|meter|meters|ft|feet|foot|')?$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2];
  const meters =
    unit === 'ft' || unit === 'feet' || unit === 'foot' || unit === "'"
      ? value * M_PER_FOOT
      : value;
  // Same backstop the operator field and the depth loader carry — a lake in our region is not 400 m deep.
  return meters > MAX_PLAUSIBLE_DEPTH_M ? undefined : meters;
}

/**
 * A depth record from one feature's tags, or `null` when it has none we can use.
 *
 * **`depth` maps to the *max*, never the mean, and that asymmetry is the safety-relevant call.** OSM's
 * `depth` is documented loosely — mappers use it for a typical, a mean and a maximum — so mapping it to
 * `meanDepthM` would put an unsupported claim in the field that *wins* the shallow classification
 * (`isShallowDepth` prefers a mean whenever one exists). Read as a max it enters through the generous
 * 7 m fallback instead, which is the direction that keeps a shallow lake classified shallow. Only the
 * explicit `depth:mean` — rare, and unambiguous when present — is trusted as a mean.
 */
export function depthFromOsmTags(
  props: OsmWaterProperties,
  externalId: string,
): OsmDepthRecord | null {
  const meanDepthM = parseOsmDepthMeters(props['depth:mean']);
  // `maxdepth` is the better claim; a bare `depth` fills in only when it's the one on offer.
  const maxDepthM = parseOsmDepthMeters(props.maxdepth) ?? parseOsmDepthMeters(props.depth);
  if (meanDepthM === undefined && maxDepthM === undefined) return null;
  if (meanDepthM !== undefined && maxDepthM !== undefined && meanDepthM > maxDepthM) {
    return null; // transposed or mismatched tags — the same refusal `setDepth` makes
  }
  return {
    source: 'osm',
    externalId,
    ...(meanDepthM !== undefined ? { meanDepthM, meanDepthSource: 'osm_tag' as const } : {}),
    ...(maxDepthM !== undefined ? { maxDepthM, maxDepthSource: 'osm_tag' as const } : {}),
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
  /** Bodies carrying a usable OSM depth tag (N6a rung 7). Expect a handful: inland coverage is ~nil. */
  depthsTagged: number;
}

/** A feature that threw during transform, kept for the run summary rather than aborting. */
export interface TransformError {
  externalId: string;
  message: string;
}

export interface TransformOutput {
  bodies: CanonicalBody[];
  /** Depths tagged on the bodies above — a separate stream for a separate mutation (N6a rung 7). */
  depths: OsmDepthRecord[];
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
  const depths: OsmDepthRecord[] = [];
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
      // Only for a body we're actually storing: a depth keyed to an `externalId` no row carries would
      // count as `unmatched` in the loader forever, which is noise, not a finding.
      const depth = depthFromOsmTags(feature.properties ?? {}, body.externalId);
      if (depth) depths.push(depth);
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
    depths,
    summary: {
      total,
      imported: bodies.length,
      droppedByType,
      skipped: errors.length,
      depthsTagged: depths.length,
    },
    errors,
  };
}
