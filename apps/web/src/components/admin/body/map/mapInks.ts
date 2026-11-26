import { nativeThemes } from '@skating/design/native';
import type { CSSProperties } from 'react';
import type { BodyMapMode } from './bodyMapPalette';

/**
 * **The map's inks over the summer aerial** (founder, 2026-11-26): a photograph is dark ground
 * whatever the theme, so while the summer aerial is on, everything the map draws on itself takes
 * the dark map's colors in both themes — light on dark.
 *
 * - **What follows the inks:** the MapLibre half (the shore and outlines, bay lines and every scene
 *   line, the hazard fields, a tool's drafting lines) through {@link mapInkMode}; and what the
 *   browser draws on the map (the graticule and its labels, the scene's labels, dimension lines,
 *   a still's drawing) through {@link mapInkStyle}. The photograph
 *   has one paint, for light inks (`AERIAL_PAINT`).
 * - **What keeps the page's theme:** chrome on its own plate — the layer rack, the key along the
 *   foot, the zoom pair, an embed's legend plate and caption, the marks, the hover plate, a tool's
 *   mode bar, *Try again*, and the credit and the scale, each on a plate over the photograph.
 * - **From the switch, not from the photograph's arrival.** While it is on, a ground of the dark
 *   map's earth lies under the console's layers (`useBodyMapCanvas`), so while a cell is loading,
 *   or didn't come, the light inks land on dark ground — never on the light theme's basemap — and
 *   they don't flip as cells come and go. The basemap stays the page's, so the switch repaints in
 *   place and never re-creates the map.
 */

/** The mode the map draws its own inks in: the page's, or the dark map's over the summer aerial. */
export function mapInkMode(mode: BodyMapMode, aerialOn: boolean): BodyMapMode {
  return aerialOn ? 'dark' : mode;
}

/**
 * The dark map's color tokens as CSS variables, for an ink the browser draws: the generated
 * `tokens.css` resolves its maps on `:root` alone, so a scope re-declares each token on the element
 * (Tailwind's color utilities read the variables inline, so `text-fg2` follows). `--map-ground`
 * is the pane's own alias of the earth, resolved at the pane, so it is re-declared too.
 */
const DARK_INKS: CSSProperties = {
  ...Object.fromEntries(
    Object.entries(nativeThemes.admin.dark.color).map(([name, value]) => [`--${name}`, value]),
  ),
  '--map-ground': nativeThemes.admin.dark.color['map-earth'],
  colorScheme: 'dark',
} as CSSProperties;

/**
 * The style an ink the browser draws on the map takes: the dark map's tokens over the summer aerial
 * (the same rule as {@link mapInkMode}); nothing otherwise, so the page's own tokens stand.
 */
export function mapInkStyle(aerialOn: boolean): CSSProperties | undefined {
  return aerialOn ? DARK_INKS : undefined;
}
