import { hexToRgb } from '@skating/design';
import { describe, expect, it } from 'vitest';
import { CONTOUR_PALETTE } from './contourMap';
import { HAZARD_PALETTE } from './hazardMap';

/** Hue in degrees, from a hex. Enough to say "this is a cyan and that is a red". */
function hue(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return (h * 60 + 360) % 360;
}

/** Shortest distance between two hues on the colour wheel. */
function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

describe('CONTOUR_PALETTE', () => {
  const themes = ['white', 'dark'] as const;

  it('is defined for both themes', () => {
    for (const theme of themes) {
      expect(CONTOUR_PALETTE[theme].shallow).toMatch(/^#[0-9a-f]{6}$/i);
      expect(CONTOUR_PALETTE[theme].deep).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('varies only in lightness — one hue, never a multi-hue severity ramp', () => {
    // D82's one styling rule with real weight. A green→yellow→red depth scale would be far more
    // legible, and that is exactly the problem: the most readable version of this layer is the one
    // that most looks like a severity scale, which reintroduces through colour the claim we declined
    // to make in words.
    for (const theme of themes) {
      const { shallow, deep } = CONTOUR_PALETTE[theme];
      expect(hueDistance(shallow, deep)).toBeLessThan(40);
    }
  });

  it('cannot be mistaken for any hazard colour', () => {
    // The hazard palette is danger/warning/success — red, amber, green. A contour must not land on
    // that scale at either end of its ramp, in either theme.
    for (const theme of themes) {
      const contour = CONTOUR_PALETTE[theme];
      const hazards = HAZARD_PALETTE[theme];
      for (const line of [contour.shallow, contour.deep]) {
        for (const role of ['danger', 'healing', 'passage'] as const) {
          expect(hueDistance(line, hazards[role])).toBeGreaterThan(45);
        }
      }
    }
  });

  it('flips ramp direction with the basemap, so the deepest line is always the prominent one', () => {
    // Lightness encodes PROMINENCE, not depth, and the basemap decides which way that runs. A dark
    // line is prominent on a pale basemap and invisible on a dark one; a layer that ignores this
    // disappears in one of the two themes.
    const light = (hex: string) => hexToRgb(hex).reduce((a, b) => a + b, 0);
    expect(light(CONTOUR_PALETTE.white.deep)).toBeLessThan(light(CONTOUR_PALETTE.white.shallow));
    expect(light(CONTOUR_PALETTE.dark.deep)).toBeGreaterThan(light(CONTOUR_PALETTE.dark.shallow));
  });
});
