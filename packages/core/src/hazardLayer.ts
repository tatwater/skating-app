/**
 * How hazards are turned into map data (Phase 9) — the GeoJSON transforms and the freshness→style
 * mapping, shared by web and mobile.
 *
 * This lives in `core` rather than in each app's map lib (the convention the water-body layers
 * follow) for one reason: these are the *safety* layers. A hazard renders as its buffered
 * **footprint** — the geometry grown by its radius or uncertainty band, computed by the same
 * `hazardFootprint` the server uses for its bbox and the proximity evaluator uses for distance — so
 * what a skater sees and what the app measures against their GPS are provably the same shape. Two
 * parallel implementations of that could drift, and the drift would be invisible until it mattered.
 *
 * Colours stay per-app (they come from the design tokens), but *what gets drawn* and *how confidence
 * maps to opacity* are decided exactly once, here.
 *
 * A footprint is also deliberately soft-edged. A hazard is "reported *around here*", never a surveyed
 * boundary, so imprecision is rendered as the honest message rather than hidden behind a crisp pin.
 */

import type { HazardFreshness } from './hazardDecay';
import { draftToShape, draftVertices, type HazardDraft } from './hazardDraft';
import { type HazardShape, hazardFootprint } from './hazardGeometry';
import { type HazardType, isPassageMarker } from './types';

/**
 * A hazard as a map consumes it.
 *
 * `geometry` is typed as the broad `GeoJSON.Geometry` the Convex `geoJson` validator produces, not
 * the narrow `Point | LineString | Polygon | MultiPolygon` the footprint math accepts. Narrowing
 * happens in `safeFootprint`, so a row carrying an unexpected geometry type is *dropped from the
 * layer* rather than being a compile-time impossibility we cast away and then crash on at runtime.
 */
export interface MappableHazard {
  _id: string;
  type: HazardType;
  geometryKind: HazardShape['geometryKind'];
  geometry: GeoJSON.Geometry;
  radiusMeters?: number;
  bufferMeters?: number;
  /**
   * The footprint clipped to the water body, when create stored one (Phase 9.5). Drawn directly when
   * present so the halo can't spill over land or a neighbouring lake — and it's the *same* polygon the
   * proximity/directional distance measures against, so what's drawn and what's warned about stay one
   * shape. Broad `GeoJSON.Geometry` like `geometry`: a row carrying an unexpected type is dropped in
   * render, not a compile-time impossibility we cast away and crash on.
   */
  clippedFootprint?: GeoJSON.Geometry;
  freshness: HazardFreshness;
  provisional: boolean;
  healingState?: 'none' | 'healing_unsafe' | 'disputed';
}

/** A persistent known feature (D53) — no freshness, because it never decays. */
export interface MappableBodyFeature {
  _id: string;
  type: string;
  /** Present on rows written after the line/polygon fix; inferred from `radiusMeters` when absent. */
  geometryKind?: HazardShape['geometryKind'];
  geometry: GeoJSON.Geometry;
  radiusMeters?: number;
  bufferMeters?: number;
}

/** The four colours a hazard layer needs. Supplied per app from its own design tokens. */
export interface HazardPalette {
  danger: string;
  healing: string;
  passage: string;
  feature: string;
}

/** The geometry types the footprint math can actually buffer. */
const FOOTPRINTABLE = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon']);

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
      // A stored body-clip is drawn as-is (it's already a footprint polygon); otherwise buffer the raw
      // shape. Either way the map draws exactly what the distance math measures against.
      const footprint = clippedPolygon(h.clippedFootprint) ?? safeFootprint(h);
      if (!footprint) return [];
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
            // A suggested crossing somebody has reported closed (D64). Carried onto the feature so
            // the map can mark it without a second query; one vote short of retiring the marker, so
            // it is a caution on the pin rather than the pin's removal.
            disputed: h.healingState === 'disputed',
          },
        },
      ];
    }),
  };
}

/** Known body features → footprints for the always-on `body-features` source (D53). */
export function bodyFeaturesToFeatureCollection(
  features: readonly MappableBodyFeature[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.flatMap((f) => {
      const footprint = safeFootprint({
        // Use the feature's stored primitive so a promoted line (a `recurring_pressure_ridge`) renders
        // as its buffered band, not a hairline. Fall back to the old radius-based inference only for
        // legacy rows that predate the `geometryKind` column.
        geometryKind: f.geometryKind ?? (f.radiusMeters !== undefined ? 'point_radius' : 'polygon'),
        geometry: f.geometry,
        radiusMeters: f.radiusMeters,
        bufferMeters: f.bufferMeters,
      });
      if (!footprint) return [];
      return [
        {
          type: 'Feature' as const,
          geometry: footprint,
          properties: { bodyFeatureId: f._id, featureType: f.type },
        },
      ];
    }),
  };
}

/**
 * Above this many corners, a draft's vertex dots stop being drawn.
 *
 * The dots are feedback for placements a **person made one at a time** — that is the only thing they
 * are for. A snapped shore band (N5b) arrives as a ring nobody tapped: a buffered, simplified
 * shoreline arc, routinely 130–150 corners and capped at `HAZARD_MAX_VERTICES` (500). Drawing a dot
 * on each one covers the band it is supposed to be clarifying, on the smallest screen, for the skater
 * standing on the ice.
 *
 * Nothing is lost by suppressing them: a draft with this many corners is long past storable, so its
 * **footprint** is already on the map, and the footprint is the honest preview — it is the shape that
 * would be saved. The limit is deliberately far above any hand-tapped ring (two dozen taps with
 * gloves on is not a thing that happens) so the affordance the dots exist for is untouched.
 */
export const DRAFT_VERTEX_DOT_LIMIT = 24;

/**
 * The hazard being authored → the draft source.
 *
 * Two kinds of feature come out, because a polyline is drawn one placement at a time and the
 * half-drawn states have to be visible:
 *
 * - a **footprint** polygon, but only once `draftToShape` says the draft is storable — so the preview
 *   is the buffered band that would actually be saved, at the same width, computed by the same math.
 *   A one-vertex line has no honest footprint, so it doesn't get a fake one.
 * - a **vertex** point per placement, up to `DRAFT_VERTEX_DOT_LIMIT`. Without these, the first tap on
 *   a line would land with no feedback at all and the second would appear to come from nowhere.
 *
 * `passage` rides along so a `ridge_crossing` draft previews in its own positive-but-cautious green
 * rather than danger red — you should not watch yourself draw a warning while marking a way across.
 */
export function hazardDraftToFeatureCollection(
  draft: HazardDraft | null,
  type: HazardType | null,
): GeoJSON.FeatureCollection {
  if (!draft) return { type: 'FeatureCollection', features: [] };
  const passage = type !== null && isPassageMarker(type);
  const shape = draftToShape(draft);
  const footprint = shape
    ? [
        {
          type: 'Feature' as const,
          geometry: hazardFootprint(shape),
          properties: { role: 'footprint', passage, healing: false },
        },
      ]
    : [];
  const vertices = draftVertices(draft);
  return {
    type: 'FeatureCollection',
    features: [
      ...footprint,
      ...(vertices.length > DRAFT_VERTEX_DOT_LIMIT ? [] : vertices).map((v) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [v.lng, v.lat] },
        properties: { role: 'vertex', passage, healing: false },
      })),
    ],
  };
}

/**
 * Buffer a shape into its footprint, dropping it if the geometry is unusable.
 *
 * Turf throws on degenerate input (a zero-length line, an empty ring). A bad row must not take the
 * whole hazard layer down with it — losing one pin is bad, losing *every* pin on the lake because one
 * is malformed is a safety failure. So a throw skips that feature and the rest still render.
 */
function safeFootprint(shape: {
  geometryKind: HazardShape['geometryKind'];
  geometry: GeoJSON.Geometry;
  radiusMeters?: number;
  bufferMeters?: number;
}): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (!FOOTPRINTABLE.has(shape.geometry.type)) return null;
  try {
    return hazardFootprint(shape as HazardShape);
  } catch {
    return null;
  }
}

/**
 * Narrow a stored clipped footprint to the areal geometry the layer can draw. Only Polygon/MultiPolygon
 * are ever stored, but the field is broad, so a row carrying anything else is dropped to the unclipped
 * path rather than fed to the renderer as a non-fillable geometry.
 */
function clippedPolygon(
  clipped: GeoJSON.Geometry | undefined,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (clipped && (clipped.type === 'Polygon' || clipped.type === 'MultiPolygon')) return clipped;
  return null;
}

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
};

/** Provisional (unconfirmed) hazards render softer — they're one person's unverified report (D54). */
export const PROVISIONAL_OPACITY_SCALE = 0.6;

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
  ];
}

/**
 * The MapLibre colour expression: passage markers and healing pins read distinctly from danger.
 *
 * Order matters — `passage` is checked first, so a `ridge_crossing` can never fall through to the
 * danger colour. Painting a warning over the safest way across a ridge would be actively wrong.
 */
export function hazardColorExpression(palette: HazardPalette): unknown[] {
  return [
    'case',
    ['get', 'passage'],
    palette.passage,
    ['get', 'healing'],
    palette.healing,
    palette.danger,
  ];
}
