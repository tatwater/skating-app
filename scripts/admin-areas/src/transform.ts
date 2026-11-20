/**
 * Admin-areas ETL transform (Phase 05) — the tested heart of the OSM administrative-boundary pipeline.
 *
 * Turns raw `osmium export` boundary features into admin-area records for
 * `adminAreas.importCanonical`: classify `admin_level` → our `level` (state/county/town, dropping
 * anything else), simplify to ~5 m fidelity, then compute `bbox` / on-boundary `centroid` from the
 * *simplified* geometry (what actually gets stored). Pure and framework-free — the geometry lives in
 * `@skating/core`; this composes it and adds the per-feature resilience the ETL needs (a degenerate
 * polygon is skipped, never aborts a batch). Mirrors the water ETL (`scripts/etl`).
 *
 * `state` is **not** produced here — the loader stamps it from `--state=XX` onto every row, since
 * each per-state extract is one state (unlike water bodies, admin boundaries don't span states).
 */

import { type LatLng, osmExternalId, polygonBBox, representativePoint } from '@skating/core';
import {
  CONVEX_ARRAY_LIMIT,
  maxArrayLength,
  simplifyForStorage,
} from '@skating/core/polygonStorage';
import type {
  AdminAreaLevel,
  AdminAreaRecord,
  OsmBoundaryFeature,
  OsmBoundaryProperties,
} from './types';

/**
 * Map an OSM `admin_level` to our coarse `level`. US convention: 4 = state, 6 = county, 7/8 =
 * town/city (New England towns tile at 8, some states use 7). Anything else (nation=2, neighborhood
 * =9/10, …) is skipped — we only resolve these three tiers. Accepts the string OSM emits or a number.
 */
export function levelFromAdminLevel(
  adminLevel: string | number | undefined,
): AdminAreaLevel | null {
  const n = typeof adminLevel === 'string' ? Number.parseInt(adminLevel, 10) : adminLevel;
  if (n === 4) return 'state';
  if (n === 6) return 'county';
  if (n === 7 || n === 8) return 'town';
  return null;
}

/**
 * Transform one OSM boundary feature into an admin-area record, or `null` to **skip by
 * classification** (an `admin_level` we don't resolve, or a non-boundary feature).
 *
 * **Throws** on data we can't turn into a storable record: a missing `@type`/`@id`, a non-area
 * geometry, a degenerate polygon `representativePoint` can't place a point on, or a geometry still
 * over Convex's array cap after coarsening. `transformFeatures` catches per feature so raw-OSM junk
 * never kills the batch.
 */
export function featureToAdminArea(feature: OsmBoundaryFeature): AdminAreaRecord | null {
  const props: OsmBoundaryProperties = feature.properties ?? {};
  // Only administrative boundaries; ignore other boundary=* (postal, protected_area, …).
  if (props.boundary !== 'administrative') return null;
  const level = levelFromAdminLevel(props.admin_level);
  if (level === null) return null;

  const externalId = osmExternalId(props);
  if (externalId === null) {
    throw new Error('feature is missing @type/@id (export with `osmium export -a type,id`)');
  }
  const name = typeof props.name === 'string' ? props.name.trim() : '';
  if (name === '') throw new Error('boundary has no name');

  const geom = feature.geometry;
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
    throw new Error(`unsupported geometry type "${geom.type}" (expected a polygon area)`);
  }

  const polygon = simplifyForStorage(geom);
  const maxArray = maxArrayLength(polygon);
  if (maxArray > CONVEX_ARRAY_LIMIT) {
    throw new Error(
      `geometry array too large (${maxArray} > ${CONVEX_ARRAY_LIMIT}) after coarsening`,
    );
  }
  const centroid: LatLng = representativePoint(polygon); // throws on a collapsed / degenerate ring
  const fullName = typeof props.full_name === 'string' ? props.full_name.trim() : '';
  return {
    externalId,
    name,
    ...(fullName !== '' ? { fullName } : {}),
    level,
    polygon,
    bbox: polygonBBox(polygon),
    centroid,
  };
}

/** Per-feature outcome tally for the run summary. */
export interface TransformSummary {
  total: number;
  imported: number;
  /** Skipped by classification — a boundary we don't resolve (wrong admin_level / non-admin). */
  droppedByType: number;
  /** Skipped because the feature threw (bad geometry / missing id / no name) — see `errors`. */
  skipped: number;
}

export interface TransformError {
  externalId: string;
  message: string;
}

export interface TransformOutput {
  areas: AdminAreaRecord[];
  summary: TransformSummary;
  errors: TransformError[];
}

/**
 * Transform a batch of features, isolating each failure (skip + tally) so one bad polygon never
 * aborts the import. `droppedByType` is intentional classification skips; `skipped` (with `errors`)
 * is features that threw.
 */
export function transformFeatures(features: Iterable<OsmBoundaryFeature>): TransformOutput {
  const areas: AdminAreaRecord[] = [];
  const errors: TransformError[] = [];
  let total = 0;
  let droppedByType = 0;

  for (const feature of features) {
    total++;
    try {
      const area = featureToAdminArea(feature);
      if (area === null) {
        droppedByType++;
        continue;
      }
      areas.push(area);
    } catch (err) {
      errors.push({
        externalId: osmExternalId(feature.properties) ?? String(feature.id ?? '(unknown)'),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    areas,
    summary: { total, imported: areas.length, droppedByType, skipped: errors.length },
    errors,
  };
}
