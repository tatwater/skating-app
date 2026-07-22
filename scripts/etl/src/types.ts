/**
 * Shared ETL types: the raw OSM feature shape `osmium export` emits, and the canonical
 * body record the transform produces (mirroring `waterBodies.importCanonical`).
 */

import type { BBox, LatLng, WaterBodyType } from '@skating/core';
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
  type: WaterBodyType;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  centroid: LatLng;
  surfaceAreaSqM: number;
}
