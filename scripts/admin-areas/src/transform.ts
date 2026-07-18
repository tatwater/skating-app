/**
 * Admin-areas ETL transform (Phase 5) — the tested heart of the OSM administrative-boundary pipeline.
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

import { type LatLng, polygonBBox, representativePoint } from '@skating/core'
import simplify from '@turf/simplify'
import type { MultiPolygon, Polygon } from 'geojson'
import type {
  AdminAreaLevel,
  AdminAreaRecord,
  OsmBoundaryFeature,
  OsmBoundaryProperties,
} from './types'

/** ~5 m at these latitudes (Douglas–Peucker tolerance in degrees) — the fidelity-first baseline. */
export const SIMPLIFY_TOLERANCE_DEG = 0.00005
/** Convex rejects any array over 8192 elements (applies to every polygon nesting level). */
export const CONVEX_ARRAY_LIMIT = 8192
/** Coarsening target for a ring's coordinate array — a safety margin under the array limit. */
export const MAX_RING_VERTICES = 8000
/** Adaptive-coarsening step (~1 m) — nudge, don't double, so an over-limit body coarsens the least. */
const SIMPLIFY_STEP_DEG = 0.00001

/**
 * Map an OSM `admin_level` to our coarse `level`. US convention: 4 = state, 6 = county, 7/8 =
 * town/city (New England towns tile at 8, some states use 7). Anything else (nation=2, neighborhood
 * =9/10, …) is skipped — we only resolve these three tiers. Accepts the string OSM emits or a number.
 */
export function levelFromAdminLevel(
  adminLevel: string | number | undefined,
): AdminAreaLevel | null {
  const n = typeof adminLevel === 'string' ? Number.parseInt(adminLevel, 10) : adminLevel
  if (n === 4) return 'state'
  if (n === 6) return 'county'
  if (n === 7 || n === 8) return 'town'
  return null
}

/**
 * The stable OSM id we key `externalId` on: `relation/456` / `way/123` (admin boundaries are almost
 * always relations). Returns `null` when the attributes are absent (feature not exported with
 * `-a type,id`).
 */
export function externalIdFromProperties(
  props: OsmBoundaryProperties | null | undefined,
): string | null {
  if (!props) return null
  const type = props['@type']
  const id = props['@id']
  if (typeof type !== 'string' || type.length === 0) return null
  if (typeof id !== 'number' && typeof id !== 'string') return null
  return `${type}/${id}`
}

/** Largest coordinate count across all rings — the dimension adaptive coarsening can reduce. */
export function largestRingSize(geom: Polygon | MultiPolygon): number {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat()
  return rings.reduce((max, ring) => Math.max(max, ring.length), 0)
}

/** The largest array Convex will see anywhere in this geometry (polygon/ring/position counts). */
export function maxArrayLength(geom: Polygon | MultiPolygon): number {
  const polygons = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  let max = polygons.length
  for (const rings of polygons) {
    max = Math.max(max, rings.length)
    for (const ring of rings) max = Math.max(max, ring.length)
  }
  return max
}

/**
 * Simplify to the ~5 m target without mutating the input. If a ring is still over Convex's array
 * limit, coarsen *that body only* by nudging the tolerance up one step (~1 m) at a time until every
 * ring fits under `MAX_RING_VERTICES` — the least coarsening that fits. State/county boundaries are
 * the dense ones here (a state outline can be tens of thousands of vertices raw).
 */
function simplifyForStorage(geom: Polygon | MultiPolygon): Polygon | MultiPolygon {
  let tolerance = SIMPLIFY_TOLERANCE_DEG
  let simplified = simplify(geom, { tolerance, highQuality: false, mutate: false })
  for (let step = 0; step < 10_000 && largestRingSize(simplified) > MAX_RING_VERTICES; step++) {
    tolerance += SIMPLIFY_STEP_DEG
    simplified = simplify(geom, { tolerance, highQuality: false, mutate: false })
  }
  return simplified
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
  const props: OsmBoundaryProperties = feature.properties ?? {}
  // Only administrative boundaries; ignore other boundary=* (postal, protected_area, …).
  if (props.boundary !== 'administrative') return null
  const level = levelFromAdminLevel(props.admin_level)
  if (level === null) return null

  const externalId = externalIdFromProperties(props)
  if (externalId === null) {
    throw new Error('feature is missing @type/@id (export with `osmium export -a type,id`)')
  }
  const name = typeof props.name === 'string' ? props.name.trim() : ''
  if (name === '') throw new Error('boundary has no name')

  const geom = feature.geometry
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
    throw new Error(`unsupported geometry type "${geom.type}" (expected a polygon area)`)
  }

  const polygon = simplifyForStorage(geom)
  const maxArray = maxArrayLength(polygon)
  if (maxArray > CONVEX_ARRAY_LIMIT) {
    throw new Error(
      `geometry array too large (${maxArray} > ${CONVEX_ARRAY_LIMIT}) after coarsening`,
    )
  }
  const centroid: LatLng = representativePoint(polygon) // throws on a collapsed / degenerate ring
  return { externalId, name, level, polygon, bbox: polygonBBox(polygon), centroid }
}

/** Per-feature outcome tally for the run summary. */
export interface TransformSummary {
  total: number
  imported: number
  /** Skipped by classification — a boundary we don't resolve (wrong admin_level / non-admin). */
  droppedByType: number
  /** Skipped because the feature threw (bad geometry / missing id / no name) — see `errors`. */
  skipped: number
}

export interface TransformError {
  externalId: string
  message: string
}

export interface TransformOutput {
  areas: AdminAreaRecord[]
  summary: TransformSummary
  errors: TransformError[]
}

/**
 * Transform a batch of features, isolating each failure (skip + tally) so one bad polygon never
 * aborts the import. `droppedByType` is intentional classification skips; `skipped` (with `errors`)
 * is features that threw.
 */
export function transformFeatures(features: Iterable<OsmBoundaryFeature>): TransformOutput {
  const areas: AdminAreaRecord[] = []
  const errors: TransformError[] = []
  let total = 0
  let droppedByType = 0

  for (const feature of features) {
    total++
    try {
      const area = featureToAdminArea(feature)
      if (area === null) {
        droppedByType++
        continue
      }
      areas.push(area)
    } catch (err) {
      errors.push({
        externalId:
          externalIdFromProperties(feature.properties) ?? String(feature.id ?? '(unknown)'),
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    areas,
    summary: { total, imported: areas.length, droppedByType, skipped: errors.length },
    errors,
  }
}
