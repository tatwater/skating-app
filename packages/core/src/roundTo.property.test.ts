import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { roundTo } from './units';

/** Every finite double, the exponent-printed ones included (`1e-7`, `2.5e21`). */
const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
const places = fc.integer({ min: -20, max: 20 });

describe('roundTo over the full double range', () => {
  it('finite in, finite out — never NaN', () => {
    fc.assert(
      fc.property(finite, places, (x, d) => {
        expect(Number.isFinite(roundTo(x, d))).toBe(true);
      }),
      { numRuns: 5_000 },
    );
  });

  it('rounding is idempotent, and lands within half a place of the value', () => {
    fc.assert(
      fc.property(finite, fc.integer({ min: 0, max: 12 }), (x, d) => {
        const r = roundTo(x, d);
        expect(roundTo(r, d)).toBe(r);
        // Within half a unit of the last place (relative slack for the doubles' own precision).
        expect(Math.abs(r - x)).toBeLessThanOrEqual(0.5 * 10 ** -d + Math.abs(x) * 1e-15);
      }),
      { numRuns: 5_000 },
    );
  });

  it('a whole number to whole places is itself, however large', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e300, max: 1e300 }),
        (x) => {
          const whole = Math.trunc(x);
          expect(roundTo(whole, 0)).toBe(whole === 0 ? 0 : whole);
        },
      ),
    );
  });

  it('the exponent-printed values that were NaN', () => {
    expect(roundTo(1e-7, 2)).toBe(0);
    expect(roundTo(-1e-7, 2) === 0).toBe(true);
    expect(roundTo(1.5e-7, 7)).toBe(2e-7);
    expect(roundTo(2.5e21)).toBe(2.5e21);
    expect(roundTo(1.234e-5, 6)).toBe(0.000012);
    expect(roundTo(1e300, 10)).toBe(1e300);
  });
});
