import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../contrast';
import {
  composite,
  contrastOklch,
  deltaE,
  hexToOklch,
  inGamut,
  type Oklch,
  rgbToOklch,
  roundOklch,
  solveAlphaForContrast,
  solveForContrast,
  toCssOklch,
  toGamut,
  toHex,
  toNativeColor,
  toRgb,
  withAlpha,
} from './oklch';

const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, '0')}`);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const hue = fc.double({ min: 0, max: 359.99, noNaN: true });
/** Any in-gamut OKLCH color, by way of a random sRGB one. */
const color = hex.map(hexToOklch);

const BLACK: Oklch = { l: 0, c: 0, h: 0 };
const WHITE: Oklch = { l: 1, c: 0, h: 0 };

describe('hexToOklch', () => {
  it('parses 3-, 6- and 8-digit hex', () => {
    expect(hexToOklch('#fff')).toEqual({ l: 1, c: 0, h: 0 });
    expect(hexToOklch('#000000')).toEqual({ l: 0, c: 0, h: 0 });
    expect(hexToOklch('#ffffff80')).toEqual({ l: 1, c: 0, h: 0, alpha: 0.502 });
  });

  it('rejects anything else', () => {
    expect(() => hexToOklch('fff')).toThrow(/Not a hex color/);
    expect(() => hexToOklch('#ggg')).toThrow(/Not a hex color/);
    expect(() => hexToOklch('#12345')).toThrow(/Not a hex color/);
  });

  it('round-trips any sRGB hex within a byte, imperceptibly (property)', () => {
    fc.assert(
      fc.property(hex, (h) => {
        const back = toHex(hexToOklch(h));
        const a = Number.parseInt(h.slice(1), 16);
        const b = Number.parseInt(back.slice(1), 16);
        for (const shift of [16, 8, 0]) {
          expect(Math.abs(((a >> shift) & 0xff) - ((b >> shift) & 0xff))).toBeLessThanOrEqual(1);
        }
        expect(deltaE(hexToOklch(h), hexToOklch(back))).toBeLessThan(0.5);
      }),
    );
  });
});

describe('roundOklch', () => {
  it('zeroes the hue of an achromatic color and normalizes negative hues', () => {
    expect(roundOklch({ l: 0.5, c: 0.00001, h: 123 })).toEqual({ l: 0.5, c: 0, h: 0 });
    expect(roundOklch({ l: 0.5, c: 0.1, h: -10 })).toEqual({ l: 0.5, c: 0.1, h: 350 });
  });

  it('drops an alpha of 1 and keeps a lower one', () => {
    expect(roundOklch({ l: 0.5, c: 0, h: 0, alpha: 1 })).toEqual({ l: 0.5, c: 0, h: 0 });
    expect(roundOklch({ l: 0.5, c: 0, h: 0, alpha: 0.123456 }).alpha).toBe(0.1235);
  });
});

describe('formatting', () => {
  it('writes CSS oklch(), with an alpha only when translucent', () => {
    expect(toCssOklch({ l: 0.6066, c: 0, h: 0 })).toBe('oklch(0.6066 0 0)');
    expect(toCssOklch({ l: 0.8012, c: 0.1334, h: 215.49, alpha: 0.1 })).toBe(
      'oklch(0.8012 0.1334 215.49 / 0.1)',
    );
  });

  it('writes React Native colors as hex or rgba(), never oklch()', () => {
    expect(toNativeColor(hexToOklch('#2fd3f4'))).toBe('#2fd3f4');
    expect(toNativeColor(withAlpha(hexToOklch('#2fd3f4'), 0.1))).toBe('rgba(47, 211, 244, 0.1)');
    fc.assert(
      fc.property(color, unit, (c, a) => {
        expect(toNativeColor(withAlpha(c, a))).toMatch(
          /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/,
        );
      }),
    );
  });

  it('withAlpha drops an alpha of 1', () => {
    expect(withAlpha({ l: 0.5, c: 0, h: 0, alpha: 0.5 }, 1)).toEqual({ l: 0.5, c: 0, h: 0 });
  });
});

describe('gamut', () => {
  it('reduces chroma until a color fits sRGB, keeping lightness and hue', () => {
    const wild: Oklch = { l: 0.7, c: 0.4, h: 150 };
    expect(inGamut(wild)).toBe(false);
    const fitted = toGamut(wild);
    expect(inGamut(fitted)).toBe(true);
    expect(fitted.l).toBe(0.7);
    expect(fitted.h).toBe(150);
    expect(fitted.c).toBeLessThan(0.4);
  });

  it('always lands in gamut (property)', () => {
    fc.assert(
      fc.property(unit, fc.double({ min: 0, max: 0.4, noNaN: true }), hue, (l, c, h) => {
        expect(inGamut(toGamut({ l, c, h }))).toBe(true);
      }),
    );
  });
});

describe('contrast from OKLCH', () => {
  it('agrees with the hex-based WCAG math (property)', () => {
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        expect(contrastOklch(hexToOklch(a), hexToOklch(b))).toBeCloseTo(contrastRatio(a, b), 1);
      }),
    );
  });

  it('is 21:1 for black on white, 1:1 for a color on itself', () => {
    expect(contrastOklch(BLACK, WHITE)).toBeCloseTo(21, 5);
    fc.assert(
      fc.property(color, (c) => {
        expect(contrastOklch(c, c)).toBeCloseTo(1, 10);
      }),
    );
  });

  it('measures a translucent ink as it renders over the ground', () => {
    // White at 0% is the ground itself; at 100% it is white.
    expect(contrastOklch(withAlpha(WHITE, 0), BLACK)).toBeCloseTo(1, 10);
    expect(contrastOklch(withAlpha(WHITE, 1), BLACK)).toBeCloseTo(21, 5);
  });

  it('composites in gamma sRGB, like a browser', () => {
    const half = composite(withAlpha(WHITE, 0.5), BLACK);
    expect(half.r).toBeCloseTo(0.5, 10);
    expect(half.alpha).toBe(1);
    expect(toRgb(rgbToOklch(half)).r).toBeCloseTo(0.5, 3);
  });
});

describe('solveForContrast', () => {
  it('finds a color at least as far from the ground as asked, and not much further (property)', () => {
    fc.assert(
      fc.property(color, fc.double({ min: 1.05, max: 15, noNaN: true }), (ink, target) => {
        const solved = solveForContrast(ink, WHITE, target, 'darker');
        const got = contrastOklch(solved, WHITE);
        expect(got).toBeGreaterThanOrEqual(target - 1e-9);
        expect(got).toBeLessThan(target * 1.05);
        expect(inGamut(solved)).toBe(true);
      }),
    );
  });

  it('keeps the hue of a chromatic color', () => {
    const ice = hexToOklch('#2fd3f4');
    expect(solveForContrast(ice, WHITE, 4.5, 'darker').h).toBe(ice.h);
  });

  it('works on the light side too', () => {
    const solved = solveForContrast({ l: 0.5, c: 0, h: 0 }, BLACK, 7, 'lighter');
    expect(contrastOklch(solved, BLACK)).toBeGreaterThanOrEqual(7);
    expect(solved.l).toBeGreaterThan(0.5);
  });

  it('returns the extreme when the target is out of reach', () => {
    expect(solveForContrast({ l: 0.5, c: 0, h: 0 }, { l: 0.5, c: 0, h: 0 }, 30, 'darker').l).toBe(
      0,
    );
  });
});

describe('solveAlphaForContrast', () => {
  it('finds the alpha that stands the overlay off the field by the target (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1.01, max: 15, noNaN: true }), (target) => {
        const alpha = solveAlphaForContrast(BLACK, WHITE, target);
        const got = contrastOklch(withAlpha(BLACK, alpha), WHITE);
        expect(got).toBeGreaterThanOrEqual(target - 1e-9);
        expect(alpha).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('is 1 when even the solid base falls short', () => {
    expect(solveAlphaForContrast({ l: 0.9, c: 0, h: 0 }, WHITE, 5)).toBe(1);
  });
});
