/**
 * Pure helpers for the hazard map layer (Phase 9). Kept out of the imperative MapLibre component so
 * the GeoJSON transforms and the freshness→style mapping are unit-testable without WebGL.
 *
 * **Hazards render as buffered footprints, not markers (D3/D51).** Every hazard is drawn as its
 * *footprint* polygon — the geometry grown by its radius or uncertainty buffer — computed by the same
 * `hazardFootprint` the server uses for its bbox and the proximity evaluator uses for distance. That
 * matters for more than tidiness: what a skater sees on the map and what the app measures against
 * their GPS are then provably the same shape.
 *
 * A footprint is also deliberately soft-edged. A hazard is "reported *around here*", never a surveyed
 * boundary, so imprecision is rendered as the honest message rather than hidden behind a crisp pin.
 */

import {
  draftToShape,
  draftVertices,
  type HazardDraft,
  type HazardFreshness,
  type HazardShape,
  type HazardType,
  hazardFootprint,
  isPassageMarker,
} from '@skating/core'
import { themes } from '@skating/design'

/**
 * A hazard as the map consumes it.
 *
 * `geometry` is typed as the broad `GeoJSON.Geometry` the Convex `geoJson` validator produces, not
 * the narrow `Point | LineString | Polygon | MultiPolygon` the footprint math accepts. Narrowing
 * happens in `safeFootprint`, so a row carrying an unexpected geometry type is *dropped from the
 * layer* rather than being a compile-time impossibility we cast away and then crash on at runtime.
 */
export interface MappableHazard {
  _id: string
  type: HazardType
  geometryKind: HazardShape['geometryKind']
  geometry: GeoJSON.Geometry
  radiusMeters?: number
  bufferMeters?: number
  freshness: HazardFreshness
  provisional: boolean
  healingState?: 'none' | 'healing_unsafe'
}

/** A persistent known feature (D53) — no freshness, because it never decays. */
export interface MappableBodyFeature {
  _id: string
  type: string
  geometry: GeoJSON.Geometry
  radiusMeters?: number
}

/** The geometry types the footprint math can actually buffer. */
const FOOTPRINTABLE = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon'])

/**
 * Hazards → a `FeatureCollection` of footprint polygons for the `hazards` source.
 *
 * Properties carried into the style: `freshness` and `provisional` drive opacity, `passage` flips
 * `ridge_crossing` to its distinct positive-but-cautious treatment, and `healing` marks a pin whose
 * latest verdict was "healing but unsafe".
 */
export function hazardsToFeatureCollection(
  hazards: readonly MappableHazard[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hazards.flatMap((h) => {
      const footprint = safeFootprint(h)
      if (!footprint) return []
      return [
        {
          type: 'Feature' as const,
          geometry: footprint,
          properties: {
            hazardId: h._id,
            hazardType: h.type,
            freshness: h.freshness,
            provisional: h.provisional,
            passage: isPassageMarker(h.type),
            healing: h.healingState === 'healing_unsafe',
          },
        },
      ]
    }),
  }
}

/** Known body features → footprints for the always-on `body-features` source (D53). */
export function bodyFeaturesToFeatureCollection(
  features: readonly MappableBodyFeature[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.flatMap((f) => {
      const footprint = safeFootprint({
        geometryKind: f.radiusMeters !== undefined ? 'point_radius' : 'polygon',
        geometry: f.geometry,
        radiusMeters: f.radiusMeters,
      })
      if (!footprint) return []
      return [
        {
          type: 'Feature' as const,
          geometry: footprint,
          properties: { bodyFeatureId: f._id, featureType: f.type },
        },
      ]
    }),
  }
}

/**
 * Buffer a shape into its footprint, dropping it if the geometry is unusable.
 *
 * Turf throws on degenerate input (a zero-length line, an empty ring). A bad row must not take the
 * whole hazard layer down with it — losing one pin is bad, losing *every* pin on the lake because one
 * is malformed is a safety failure. So a throw skips that feature and the rest still render.
 */
function safeFootprint(shape: {
  geometryKind: HazardShape['geometryKind']
  geometry: GeoJSON.Geometry
  radiusMeters?: number
  bufferMeters?: number
}): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (!FOOTPRINTABLE.has(shape.geometry.type)) return null
  try {
    return hazardFootprint(shape as HazardShape)
  } catch {
    return null
  }
}

/**
 * Hazard fill/outline per theme. Routed through the design tokens rather than the ad-hoc hex the
 * other map layers use, because these are the app's danger colors and they have to keep meeting the
 * contrast bar in both themes — a hazard you can't see in glare is a hazard that isn't there (D34).
 */
export const HAZARD_PALETTE = {
  white: {
    danger: themes.light.danger,
    healing: themes.light.warning,
    passage: themes.light.success,
    feature: themes.light.foregroundMuted,
  },
  dark: {
    danger: themes.dark.danger,
    healing: themes.dark.warning,
    passage: themes.dark.success,
    feature: themes.dark.foregroundMuted,
  },
} as const

/**
 * Fill opacity by freshness — the visual half of "decay is confidence, not safety" (D3).
 *
 * A stale hazard fades but **never disappears and never goes below a floor you can still see**. The
 * fade says "nobody has checked recently", not "this is probably gone", so the floor is deliberately
 * high enough to remain legible on a bright screen outdoors.
 */
export const FRESHNESS_FILL_OPACITY: Record<HazardFreshness, number> = {
  fresh: 0.45,
  aging: 0.3,
  stale: 0.18,
}

/** Provisional (unconfirmed) hazards render softer — they're one person's unverified report (D54). */
export const PROVISIONAL_OPACITY_SCALE = 0.6

/**
 * The hazard being authored → the draft source.
 *
 * Two kinds of feature come out, because a polyline is drawn one click at a time and the half-drawn
 * states have to be visible:
 *
 * - a **footprint** polygon, but only once `draftToShape` says the draft is storable — so the preview
 *   is the buffered band that would actually be saved, at the same width, computed by the same math.
 *   A one-vertex line has no honest footprint, so it doesn't get a fake one.
 * - a **vertex** point per click, always. Without these, the first click on a line would land with no
 *   feedback at all and the second would appear to come from nowhere.
 *
 * `passage` rides along so a `ridge_crossing` draft previews in its own positive-but-cautious green
 * rather than danger red — you should not watch yourself draw a warning while marking a way across.
 */
export function hazardDraftToFeatureCollection(
  draft: HazardDraft | null,
  type: HazardType | null,
): GeoJSON.FeatureCollection {
  if (!draft) return { type: 'FeatureCollection', features: [] }
  const passage = type !== null && isPassageMarker(type)
  const shape = draftToShape(draft)
  const footprint = shape
    ? [
        {
          type: 'Feature' as const,
          geometry: hazardFootprint(shape),
          properties: { role: 'footprint', passage, healing: false },
        },
      ]
    : []
  return {
    type: 'FeatureCollection',
    features: [
      ...footprint,
      ...draftVertices(draft).map((v) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [v.lng, v.lat] },
        properties: { role: 'vertex', passage, healing: false },
      })),
    ],
  }
}

/** The MapLibre data-driven expression for hazard fill opacity. */
export function hazardFillOpacityExpression(): unknown[] {
  return [
    '*',
    [
      'match',
      ['get', 'freshness'],
      'fresh',
      FRESHNESS_FILL_OPACITY.fresh,
      'aging',
      FRESHNESS_FILL_OPACITY.aging,
      FRESHNESS_FILL_OPACITY.stale,
    ],
    ['case', ['get', 'provisional'], PROVISIONAL_OPACITY_SCALE, 1],
  ]
}

/** The MapLibre color expression: passage markers and healing pins read distinctly from danger. */
export function hazardColorExpression(
  palette: (typeof HAZARD_PALETTE)[keyof typeof HAZARD_PALETTE],
) {
  return [
    'case',
    ['get', 'passage'],
    palette.passage,
    ['get', 'healing'],
    palette.healing,
    palette.danger,
  ]
}
