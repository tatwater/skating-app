/**
 * The native hazard layer's palette (Phase 9) — the mobile mirror of web's `lib/hazardMap.ts`.
 *
 * Unlike the water-body layers (which are mirrored wholesale per platform), the hazard *transforms*
 * are not duplicated here: they live in `@skating/core/hazardLayer` and are imported by both apps.
 * These are the safety layers — a hazard is drawn as the same buffered footprint the proximity
 * evaluator measures against — so "what gets drawn" is decided once and can't drift between web and
 * mobile. Only the colours are per-app, because they come from the design tokens.
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
 * Hazard colours per basemap flavor, keyed to match `WATER_PALETTE` so the map component looks both
 * up the same way. Identical tokens to web — a hazard must not read differently depending on which
 * screen the skater happens to be holding.
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
