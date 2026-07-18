/**
 * Shared admin-areas ETL types: the raw OSM boundary feature `osmium export` emits, and the
 * admin-area record the transform produces (mirroring `adminAreas.importCanonical`, minus `state`,
 * which the loader injects from the `--state` flag — the whole per-state extract is one state).
 */

import type { BBox, LatLng } from '@skating/core'
import type { Feature, Geometry, MultiPolygon, Polygon } from 'geojson'

/**
 * Properties of an administrative-boundary feature exported by `osmium export -a type,id`: the OSM
 * tags flat (`boundary`, `admin_level`, `name`, …) plus the `@type`/`@id` attributes we key
 * `externalId` on. `admin_level` is a string in OSM (`"4"`, `"6"`, `"8"`); we accept a number too.
 */
export type OsmBoundaryProperties = Record<string, unknown> & {
  '@type'?: string
  '@id'?: number | string
  boundary?: string
  admin_level?: string | number
  name?: string
}

/**
 * A boundary feature from the convert stage. osmium normalizes every area to a `MultiPolygon`
 * (we accept a `Polygon` too), but the geometry is typed as the full `Geometry` union so the
 * transform can defensively reject anything non-area at runtime — this is raw OSM.
 */
export type OsmBoundaryFeature = Feature<Geometry, OsmBoundaryProperties>

/** Our admin-boundary granularity (mirrors the Convex `ADMIN_AREA_LEVELS` enum). */
export type AdminAreaLevel = 'state' | 'county' | 'town'

/**
 * An admin-area record ready for `adminAreas.importCanonical` — **minus `state`**, which the loader
 * stamps from the `--state=XX` flag onto every row (each per-state extract is a single state).
 */
export interface AdminAreaRecord {
  externalId: string
  name: string
  level: AdminAreaLevel
  polygon: Polygon | MultiPolygon
  bbox: BBox
  centroid: LatLng
}
