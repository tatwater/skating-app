import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  FOLIAGE_BORDERLINE_BELOW,
  FOLIAGE_MIN_VEG_PIXELS,
  FOLIAGE_TURNED_BELOW,
  type FoliageScore,
  foliagePixels,
  foliageVerdict,
  greenShare,
  isFoliageScored,
} from './foliage';

const px = (...triples: [number, number, number][]) => new Uint8Array(triples.flat());
const one = (r: number, g: number, b: number) => foliagePixels(px([r, g, b]));
const byte = fc.integer({ min: 0, max: 255 });
const pixel = fc.tuple(byte, byte, byte);

/** The measure as the analyst wrote it (numpy, floats), for the properties to hold the port to. */
function reference([r, g, b]: [number, number, number]): 'nodata' | 'other' | 'veg' | 'green' {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (!(mx > 8)) return 'nodata';
  const water = mx < 30 || b >= Math.max(r, g) || (mx < 55 && b >= r);
  const neutral = mx - mn < 12 || mn >= 175;
  if (water || neutral) return 'other';
  return (g - r) / Math.max(g + r, 1) > 0.02 ? 'green' : 'veg';
}

describe('foliagePixels: the classes', () => {
  test.each([
    ['nodata: every band at most 8', [8, 8, 8], { valid: 0, veg: 0, green: 0 }],
    ['valid once a band passes 8', [60, 9, 0], { valid: 1, veg: 1, green: 0 }],
    ['water: darker than 30', [29, 10, 0], { valid: 1, veg: 0, green: 0 }],
    ['water: blue the brightest', [40, 80, 80], { valid: 1, veg: 0, green: 0 }],
    ['water: dark with blue at least red', [40, 54, 40], { valid: 1, veg: 0, green: 0 }],
    ['not water at 55 with blue at red', [40, 55, 40], { valid: 1, veg: 1, green: 1 }],
    ['neutral: bands within 12', [100, 111, 100], { valid: 1, veg: 0, green: 0 }],
    ['colored at a spread of 12', [100, 112, 100], { valid: 1, veg: 1, green: 1 }],
    ['neutral: every band at least 175', [175, 230, 175], { valid: 1, veg: 0, green: 0 }],
    ['vegetation, green', [60, 100, 40], { valid: 1, veg: 1, green: 1 }],
    ['vegetation, turned (orange)', [180, 110, 40], { valid: 1, veg: 1, green: 0 }],
  ] as const)('%s', (_, [r, g, b], expected) => {
    expect(one(r, g, b)).toEqual(expected);
  });

  test('GRVI over 0.02 is green; exactly 0.02 is not', () => {
    // (51 − 49) / (51 + 49) = 0.02 exactly; 52 / 49 is just over.
    expect(one(49, 51, 20).green).toBe(0);
    expect(one(49, 52, 20).green).toBe(1);
  });

  test('a trailing partial triple is ignored; an empty image counts nothing', () => {
    expect(foliagePixels(new Uint8Array([60, 100, 40, 60]))).toEqual({
      valid: 1,
      veg: 1,
      green: 1,
    });
    expect(foliagePixels(new Uint8Array())).toEqual({ valid: 0, veg: 0, green: 0 });
  });
});

describe('foliagePixels, as properties', () => {
  test("classes every pixel exactly as the analyst's float formula does", () => {
    fc.assert(
      fc.property(pixel, (p) => {
        const s = foliagePixels(px(p));
        const want = reference(p);
        expect(s).toEqual({
          valid: want === 'nodata' ? 0 : 1,
          veg: want === 'veg' || want === 'green' ? 1 : 0,
          green: want === 'green' ? 1 : 0,
        });
      }),
      { numRuns: 20_000 },
    );
  });

  test('is a count: the order of the pixels never matters, and images add', () => {
    fc.assert(
      fc.property(
        fc.array(pixel, { maxLength: 60 }),
        fc.array(pixel, { maxLength: 60 }),
        (a, b) => {
          const whole = foliagePixels(px(...a, ...b));
          const sa = foliagePixels(px(...a));
          const sb = foliagePixels(px(...b));
          expect(whole).toEqual({
            valid: sa.valid + sb.valid,
            veg: sa.veg + sb.veg,
            green: sa.green + sb.green,
          });
          expect(foliagePixels(px(...b, ...a))).toEqual(whole);
        },
      ),
    );
  });

  test('green ≤ vegetation ≤ valid ≤ pixels', () => {
    fc.assert(
      fc.property(fc.array(pixel, { maxLength: 80 }), (a) => {
        const s = foliagePixels(px(...a));
        expect(s.green).toBeLessThanOrEqual(s.veg);
        expect(s.veg).toBeLessThanOrEqual(s.valid);
        expect(s.valid).toBeLessThanOrEqual(a.length);
      }),
    );
  });

  test('the black past a frame edge changes nothing but the pixel count', () => {
    fc.assert(
      fc.property(fc.array(pixel, { maxLength: 60 }), fc.nat(40), (a, pad) => {
        const edge = Array.from({ length: pad }, () => [0, 0, 0] as [number, number, number]);
        expect(foliagePixels(px(...edge, ...a, ...edge))).toEqual(foliagePixels(px(...a)));
      }),
    );
  });
});

const score = (valid: number, veg: number, green: number): FoliageScore => ({ valid, veg, green });

describe('greenShare and the verdict', () => {
  test('too little vegetation has no verdict: under 200 pixels, or under a quarter of the valid', () => {
    expect(greenShare(score(400, FOLIAGE_MIN_VEG_PIXELS - 1, 0))).toBeNull();
    expect(greenShare(score(400, FOLIAGE_MIN_VEG_PIXELS, 0))).toBe(0);
    expect(greenShare(score(1000, 249, 249))).toBeNull();
    expect(greenShare(score(1000, 250, 125))).toBe(0.5);
  });

  test.each([
    [599, 'turned'],
    [600, 'borderline'],
    [699, 'borderline'],
    [700, 'green'],
    [1000, 'green'],
  ] as const)('%d green of 1,000 is %s at 0.6', (green, verdict) => {
    expect(foliageVerdict(score(1000, 1000, green))).toBe(verdict);
  });

  test('unscored, or without enough vegetation, is never turned', () => {
    expect(foliageVerdict(null)).toBe('noVerdict');
    expect(foliageVerdict(undefined)).toBe('noVerdict');
    expect(foliageVerdict(score(1000, 100, 0))).toBe('noVerdict');
  });

  test('a threshold past the borderline band leaves no borderline', () => {
    expect(foliageVerdict(score(1000, 1000, 750), 0.8)).toBe('turned');
    expect(foliageVerdict(score(1000, 1000, 800), 0.8)).toBe('green');
  });

  test('the constants are the founder’s: 0.6, with 0.6–0.7 shown as borderline', () => {
    expect(FOLIAGE_TURNED_BELOW).toBe(0.6);
    expect(FOLIAGE_BORDERLINE_BELOW).toBe(0.7);
  });

  test('the verdict is monotone: more green never reads as more turned', () => {
    const rank = { turned: 0, borderline: 1, green: 2, noVerdict: 3 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 40_000 }), fc.nat(), fc.nat(), (veg, a, b) => {
        const lo = Math.min(a, b) % (veg + 1);
        const hi = Math.max(lo, Math.max(a, b) % (veg + 1));
        const v = (g: number) => rank[foliageVerdict(score(veg, veg, g))];
        expect(v(lo)).toBeLessThanOrEqual(v(hi));
      }),
    );
  });
});

describe('isFoliageScored', () => {
  test.each([
    ['2023-08-31', false],
    ['2023-09-01', true],
    ['2023-09-27', true],
    ['2023-10-02', true],
    ['2024-07-02', false],
  ])('%s: %s', (day, scored) => {
    expect(isFoliageScored(day)).toBe(scored);
  });
});
