/**
 * Hue separation — "can these two colours be mistaken for each other?"
 *
 * Sibling to `contrast.ts` and the same kind of thing: colour math that exists so a *rule* about the
 * palette can be held by a test rather than by a comment. Contrast holds legibility (D34); this holds
 * **distinguishability**, which is what [D82](../../../plans/01-decisions.md) needs when it says the
 * bathymetric contour ramp must not resemble the hazard palette. A blue-to-navy depth ramp a skater
 * could read as a severity scale would reintroduce, through colour, a claim we declined to make in
 * words — and the only way that stays true through a token change is if something measures it.
 *
 * Deliberately hue-only. Lightness is free to vary (the contour ramp varies in nothing else), so
 * comparing full colours would answer a different and less useful question.
 */

import { hexToRgb } from './contrast';

/**
 * The hue of a hex colour in degrees `[0, 360)`, or `undefined` when it has none.
 *
 * **Grey has no hue, and saying "0" for it would be a lie that reads as "red".** A neutral line
 * cannot be confused with the danger colour, but an achromatic colour reported as 0° sits exactly on
 * top of red and would fail a separation check it should pass. So the absence is modelled rather than
 * flattened, and `hueDistance` is where that absence gets its meaning.
 */
export function hueOf(hex: string): number | undefined {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return undefined;

  let sextant: number;
  if (max === r) sextant = ((g - b) / delta) % 6;
  else if (max === g) sextant = (b - r) / delta + 2;
  else sextant = (r - g) / delta + 4;
  return (sextant * 60 + 360) % 360;
}

/** The furthest apart two hues can be on the wheel. */
export const MAX_HUE_DISTANCE = 180;

/**
 * Shortest distance between two colours' hues, in degrees `[0, 180]`.
 *
 * **An achromatic colour scores the maximum**, because the question this answers is whether one
 * colour can be mistaken for the other, and a grey cannot be mistaken for a red. Returning 0 there —
 * which is what treating "no hue" as "hue 0" does — would fail a palette that is in fact perfectly
 * safe, and it would fail it in a way whose cause is entirely invisible at the call site.
 */
export function hueDistance(a: string, b: string): number {
  const hueA = hueOf(a);
  const hueB = hueOf(b);
  if (hueA === undefined || hueB === undefined) return MAX_HUE_DISTANCE;
  const raw = Math.abs(hueA - hueB) % 360;
  return raw > MAX_HUE_DISTANCE ? 360 - raw : raw;
}
