/**
 * The native contour layer's palette (N6b) — the mobile mirror of web's `lib/contourMap.ts`.
 *
 * Everything else — the D81 filter, the depth ramp, the zoom floor, the drawer credit — lives in
 * `@skating/core/contourLayer`, shared with mobile. Same split as the hazard layers: *what gets
 * drawn* is decided once, and only the colours are per-app, because they come from the design tokens.
 *
 * ## The one styling rule that carries real weight
 *
 * > **D82** — *"The contour palette must not resemble the hazard palette, which is the one styling
 * > rule that carries real weight here: a blue-to-navy depth ramp that a skater could mistake for a
 * > severity scale would reintroduce, through colour, exactly the claim we just declined to make in
 * > words."*
 *
 * So the ramp is drawn from **`ice`** — the brand hue — and varies only in lightness. The hazard
 * palette is `danger` (red), `warning` (amber) and `success` (green); a cyan line cannot be read as a
 * point on that scale. Deliberately *not* a multi-hue ramp, however much more legible a
 * green→yellow→red depth scale would be: legibility is not the constraint being optimised here, and
 * the most readable version of this layer is the one that most looks like a severity scale.
 *
 * ## Why the ramp direction flips between themes
 *
 * Lightness encodes **prominence**, not depth, and the basemap decides which direction that runs. On
 * the pale basemap a dark line is the prominent one, so deep water is dark; on the dark basemap a
 * dark line is invisible, so deep water is bright. In both, the deepest contour is the one that
 * stands out most — which is the reading a skater would take anyway, and the alternative is a layer
 * that disappears in one of the two themes.
 */

import type { ContourPalette } from '@skating/core';
import { ice } from '@skating/design';

export {
  CONTOUR_FADE_MS,
  CONTOUR_LAYER_ID,
  CONTOUR_MIN_ZOOM,
  CONTOUR_OPACITY,
  CONTOUR_SOURCE_ID,
  CONTOUR_SOURCE_LAYER,
  type ContourFeatureProperties,
  type ContourPalette,
  contourColorExpression,
  contourCredit,
  contourFilter,
  contourWidthExpression,
  formatContourCredit,
} from '@skating/core';

/**
 * Depth ramp per theme, within the brand hue.
 *
 * Not routed through the semantic theme roles (`primary`, `danger`, …) the way the hazard palette is,
 * because these lines are not semantic — they carry no meaning to map to a role. They are furniture,
 * and taking the raw scale says that more honestly than borrowing `primary` would.
 */
export const CONTOUR_PALETTE: Record<'white' | 'dark', ContourPalette> = {
  white: {
    shallow: ice[300],
    deep: ice[900],
  },
  dark: {
    shallow: ice[800],
    deep: ice[300],
  },
};
