/**
 * Hazard geometry (D51) — the authoring primitive per type, its default size, and the footprint math
 * that feeds rendering, bbox indexing and proximity alerts.
 *
 * The D51 thesis: **most people cannot hand-draw an accurately shaped blob on a phone from what they
 * see on the ice**, so the drawing primitive matches the hazard's real-world shape — which happens to
 * also be what a human can produce accurately. Blobs get a point + adjustable radius; ridges and cracks
 * are genuinely linear, so they get a polyline with an uncertainty half-width.
 *
 * Every footprint here is deliberately **fuzzy** (D3): a hazard renders as a soft buffered halo with
 * advisory copy ("reported *around here*"), never a crisp surveyed boundary. Imprecision is the honest
 * message, not a bug — and `bufferMeters`/`radiusMeters` are what let us render it honestly rather than
 * drawing a zero-width line that implies survey precision we don't have.
 */

import buffer from '@turf/buffer'
import { feature, point } from '@turf/helpers'
import type { Feature, LineString, MultiPolygon, Point, Polygon } from 'geojson'
import {
  type BBox,
  distanceToPolygonMeters,
  haversineMeters,
  type LatLng,
  polygonBBox,
} from './geometry'
import type { HazardType } from './types'

/** The authoring primitive (D51). */
export type HazardGeometryKind = 'point_radius' | 'line' | 'polygon'

/** A hazard's spatial definition, as stored. */
export interface HazardShape {
  geometryKind: HazardGeometryKind
  geometry: Point | LineString | Polygon | MultiPolygon
  /** Set when `geometryKind === 'point_radius'`. */
  radiusMeters?: number
  /** Set for line/polygon — the uncertainty half-width. */
  bufferMeters?: number
}

/**
 * The primitive each type defaults to (D51).
 *
 * Only three types are linear, and they're linear in reality: a pressure ridge, an ice heave and a
 * working crack are all lines on the ice. Everything else is a blob, a hole or a zone, which a circle
 * describes at least as well as a hand-drawn shape would — and far more accurately in practice.
 */
export const HAZARD_DEFAULT_GEOMETRY_KIND: Record<HazardType, HazardGeometryKind> = {
  pressure_ridge: 'line',
  ice_heave: 'line',
  wet_crack: 'line',

  open_water: 'point_radius',
  thin_ice: 'point_radius',
  overflow_slush: 'point_radius',
  drain_hole: 'point_radius',
  wind_hole: 'point_radius',
  slush_hole: 'point_radius',
  thawed_rotten: 'point_radius',
  ridge_crossing: 'point_radius',
  drilled_hole: 'point_radius',
  shell_area: 'point_radius',
  spring_current: 'point_radius',
  gas_hole: 'point_radius',
  reef_hole: 'point_radius',
}

/**
 * Starting radius for point+radius hazards, in metres — tunable in Phase 7 (D49), adjustable by the
 * skater at capture time with steppers.
 *
 * Sized by what the thing physically is (research §2): an auger hole is a few metres, a thaw-rotten
 * *zone* or a thin-ice area is tens of metres. Starting near the truth matters more on mobile than
 * anywhere else, because on the ice the default is what most people will actually ship — the adjust
 * step is optional by design (two taps to a committable hazard).
 */
export const HAZARD_DEFAULT_RADIUS_M: Record<HazardType, number> = {
  // Small, man-made or point-source holes.
  drilled_hole: 5,
  drain_hole: 10,
  gas_hole: 10,
  wind_hole: 15,
  slush_hole: 15,
  // A crossing is a specific spot you aim for, so it wants to be tight — but not so tight it implies
  // survey precision about where the safe line is (D3).
  ridge_crossing: 15,
  // Natural features tied to a bathymetric feature.
  reef_hole: 25,
  spring_current: 30,
  // Areas and zones.
  open_water: 40,
  overflow_slush: 40,
  shell_area: 40,
  thin_ice: 50,
  // A thaw-rotten area is the largest default: it's a condition of the sheet, not a spot, and it is
  // the #1 fatality cause — under-drawing it is the dangerous direction of error.
  thawed_rotten: 60,

  // Linear types keep a default for the case where a skater opts into point+radius anyway.
  pressure_ridge: 25,
  ice_heave: 20,
  wet_crack: 10,
}

/**
 * Uncertainty half-width for linear hazards, in metres.
 *
 * A folded pressure ridge is loose plates 1–15 ft on *each* side with a deep puddle down the middle
 * (research §2) — several metres of genuine width plus GPS and eyeball error, so its band is wide. A
 * hairline tectonic crack is centimetres wide; its band is mostly just positional uncertainty. Drawing
 * both as the same zero-width polyline would be a lie in opposite directions.
 */
export const HAZARD_DEFAULT_BUFFER_M: Record<HazardType, number> = {
  pressure_ridge: 15,
  ice_heave: 12,
  wet_crack: 4,

  // Non-linear types only reach these if a skater opts into a polyline/polygon for them.
  open_water: 10,
  thin_ice: 10,
  overflow_slush: 10,
  drain_hole: 5,
  wind_hole: 5,
  slush_hole: 5,
  thawed_rotten: 15,
  ridge_crossing: 5,
  drilled_hole: 3,
  shell_area: 10,
  spring_current: 10,
  gas_hole: 5,
  reef_hole: 10,
}

/** The default shape a freshly-picked type starts with — what "two taps to a valid hazard" relies on. */
export function defaultShapeForType(type: HazardType, at: LatLng): HazardShape {
  const geometryKind = HAZARD_DEFAULT_GEOMETRY_KIND[type]
  // A line needs at least two vertices, which a single GPS fix can't supply — so a type that *defaults*
  // to a line still starts as a circle at the skater's position and upgrades once they add vertices.
  // This is what keeps the two-tap guarantee true for ridges too.
  return {
    geometryKind: geometryKind === 'line' ? 'point_radius' : geometryKind,
    geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    radiusMeters: HAZARD_DEFAULT_RADIUS_M[type],
  }
}

/**
 * The hazard's rendered/queried footprint: the raw geometry grown by its radius or uncertainty buffer.
 *
 * This one polygon is the single source of truth for the halo the map draws, the bbox we index, and the
 * distance the proximity alert measures — so what a skater *sees* and what the app *warns about* can
 * never drift apart.
 */
export function hazardFootprint(shape: HazardShape): Polygon | MultiPolygon {
  const grownBy = footprintBufferMeters(shape)
  if (grownBy <= 0 && shape.geometry.type !== 'Point') {
    return shape.geometry as Polygon | MultiPolygon
  }
  const grown = buffer(feature(shape.geometry), Math.max(grownBy, MIN_FOOTPRINT_M), {
    units: 'meters',
  }) as Feature<Polygon | MultiPolygon>
  return grown.geometry
}

/**
 * Never render or query a zero-area footprint. A degenerate hazard would be invisible on the map and
 * un-hittable by proximity — it would exist in the database and nowhere else.
 */
const MIN_FOOTPRINT_M = 1

function footprintBufferMeters(shape: HazardShape): number {
  if (shape.geometryKind === 'point_radius') return shape.radiusMeters ?? 0
  return shape.bufferMeters ?? 0
}

/** The bbox of a hazard's *footprint* (not its raw geometry) — what gets stored for prefiltering. */
export function hazardBbox(shape: HazardShape): BBox {
  return polygonBBox(hazardFootprint(shape))
}

/**
 * Distance in metres from a coordinate to the hazard's footprint edge; **0 when inside it**.
 *
 * Point+radius short-circuits to plain haversine minus the radius — exact, and it avoids buffering a
 * polygon on every GPS fix, which matters when this runs in a watcher loop on a cold phone.
 */
export function distanceToHazard(coord: LatLng, shape: HazardShape): number {
  if (shape.geometryKind === 'point_radius' && shape.geometry.type === 'Point') {
    const [lng = 0, lat = 0] = shape.geometry.coordinates
    const centre = haversineMeters(coord, { lat, lng })
    return Math.max(0, centre - (shape.radiusMeters ?? 0))
  }
  return distanceToPolygonMeters(coord, hazardFootprint(shape))
}

/** Build a `point_radius` shape (the default authoring primitive). */
export function pointRadiusShape(at: LatLng, radiusMeters: number): HazardShape {
  return {
    geometryKind: 'point_radius',
    geometry: point([at.lng, at.lat]).geometry,
    radiusMeters,
  }
}

/**
 * Build a `line` shape from captured vertices (the polyline primitive).
 *
 * Constructs the geometry literally rather than via Turf's `lineString`, which *throws* on fewer than
 * two positions. Vertices arrive one on-ice tap at a time, so a partially-drawn line is a completely
 * normal intermediate state — it must be representable and then rejected by `isValidHazardShape`, not
 * crash the capture screen mid-draw. Validation is the single gate.
 */
export function lineShape(vertices: readonly LatLng[], bufferMeters: number): HazardShape {
  return {
    geometryKind: 'line',
    geometry: { type: 'LineString', coordinates: vertices.map((v) => [v.lng, v.lat]) },
    bufferMeters,
  }
}

/**
 * Is this shape structurally valid to store? Guards the degenerate cases Turf throws on, so an
 * on-ice capture can never produce a row the renderer or the alert evaluator will crash reading.
 */
export function isValidHazardShape(shape: HazardShape): boolean {
  switch (shape.geometryKind) {
    case 'point_radius':
      return (
        shape.geometry.type === 'Point' &&
        typeof shape.radiusMeters === 'number' &&
        shape.radiusMeters > 0
      )
    case 'line': {
      if (shape.geometry.type !== 'LineString') return false
      const coords = shape.geometry.coordinates
      const first = coords[0]
      if (coords.length < 2 || !first) return false
      // Two vertices minimum, and they must actually differ — Turf's buffer throws on a zero-length
      // line rather than returning empty.
      return coords.some(([lng, lat]) => lng !== first[0] || lat !== first[1])
    }
    case 'polygon': {
      if (shape.geometry.type !== 'Polygon' && shape.geometry.type !== 'MultiPolygon') return false
      const ring =
        shape.geometry.type === 'Polygon'
          ? shape.geometry.coordinates[0]
          : shape.geometry.coordinates[0]?.[0]
      // A closed ring repeats its first position, so a triangle is 4 positions.
      return (ring?.length ?? 0) >= 4
    }
  }
}
