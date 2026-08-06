/**
 * Shared ETL types: the raw OSM feature shape `osmium export` emits, and the canonical
 * body record the transform produces (mirroring `waterBodies.importCanonical`).
 */

import type { BBox, LatLng, WaterBodyClass } from '@skating/core';
import type { Feature, Geometry, MultiPolygon, Polygon } from 'geojson';

/**
 * Properties of a water feature exported by `osmium export -a type,id` (see README): the OSM
 * tags flat (`natural`, `water`, `name`, …) plus the `@type`/`@id` attributes we key
 * `externalId` on. `@id` is numeric in osmium's output; we accept a string too, defensively.
 */
export type OsmWaterProperties = Record<string, unknown> & {
  '@type'?: string;
  '@id'?: number | string;
};

/**
 * A water feature from the convert stage. osmium normalizes every area to a `MultiPolygon`
 * (and we accept a `Polygon` too), but the geometry is typed as the full `Geometry` union so
 * the transform can *defensively* reject anything non-area at runtime — this is raw OSM.
 */
export type OsmWaterFeature = Feature<Geometry, OsmWaterProperties>;

/**
 * A canonical OSM body ready for `waterBodies.importCanonical`. Mirrors that mutation's
 * `canonicalBody` validator exactly — `source` is always `'osm'` this phase (rivers/NHD later).
 */
export interface CanonicalBody {
  source: 'osm';
  externalId: string;
  name: string;
  type: WaterBodyClass;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  centroid: LatLng;
  surfaceAreaSqM: number;
  /**
   * A point genuinely inside the water (N6c) — see `waterBodies.interiorPoint`. Absent only when
   * the geometry has no locatable interior, which is a body the transform is about to skip anyway.
   */
  interiorPoint?: LatLng;
  /**
   * Derived shape stats (N6c Workstream A), measured on the **pre-simplification** geometry per
   * D85. Each is independently optional: a degenerate ring costs one field, not the feature.
   */
  shorelineM?: number;
  longAxisM?: number;
  longAxisBearingDeg?: number;
  shortAxisM?: number;
  fetchProfileM?: number[];
}

/**
 * A depth carried opportunistically off an OSM `depth` / `maxdepth` tag (N6a rung 7), shaped for
 * `waterBodies.importDepths` — which keys on `source` + `externalId`, exactly what we have here.
 *
 * Kept **separate from `CanonicalBody`** rather than folded into it, because the two have different
 * ladders: `importCanonical` overwrites its field list every run (upstream OSM is authoritative for a
 * name and a shoreline), while a depth must go through the D68 ladder and lose to every better source.
 * Two streams, two mutations, one pass over the same input.
 */
export interface OsmDepthRecord {
  source: 'osm';
  externalId: string;
  meanDepthM?: number;
  meanDepthSource?: 'osm_tag';
  maxDepthM?: number;
  maxDepthSource?: 'osm_tag';
}
