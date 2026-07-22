/**
 * The web hazard layer's palette (Phase 9).
 *
 * Everything else — the GeoJSON transforms, the freshness→opacity mapping, the MapLibre expressions
 * — lives in `@skating/core/hazardLayer`, shared with mobile. These are the app's *safety* layers, so
 * "what gets drawn" is decided exactly once rather than mirrored per platform the way the water-body
 * layers are; only the colours are per-app, because they come from each app's design tokens.
 *
 * Re-exported here so the map component keeps importing its layer helpers from one place.
 */

import type { HazardPalette } from '@skating/core';
import { themes } from '@skating/design';

export {
  bodyFeaturesToFeatureCollection,
  FRESHNESS_FILL_OPACITY,
  hazardColorExpression,
  hazardDraftToFeatureCollection,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
  type MappableBodyFeature,
  type MappableHazard,
  PROVISIONAL_OPACITY_SCALE,
} from '@skating/core';

/**
 * Hazard fill/outline per theme. Routed through the design tokens rather than the ad-hoc hex the
 * other map layers use, because these are the app's danger colors and they have to keep meeting the
 * contrast bar in both themes — a hazard you can't see in glare is a hazard that isn't there (D34).
 */
export const HAZARD_PALETTE: Record<'white' | 'dark', HazardPalette> = {
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
};
