import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canOverwriteElevation,
  ELEVATION_SOURCES,
  isPlausibleElevationM,
  MAX_PLAUSIBLE_ELEVATION_M,
  MIN_PLAUSIBLE_ELEVATION_M,
} from './elevation';

describe('ELEVATION_SOURCES', () => {
  it('is one automated source plus the operator rung — not a ladder', () => {
    // Depth needed five rungs because measured bathymetry is scarce. A 90 m global DEM is not, so
    // a second automated source here would be ceremony. If this ever grows, the precedence rule
    // below has to grow with it.
    expect([...ELEVATION_SOURCES]).toEqual(['operator', 'dem_glo90']);
  });
});

describe('isPlausibleElevationM', () => {
  it('accepts real regional lake elevations', () => {
    for (const m of [0, 27, 126, 100, 357, 1000, 1500]) {
      expect(isPlausibleElevationM(m)).toBe(true);
    }
  });

  it('accepts a slightly negative reading for a near-sea-level coastal pond', () => {
    expect(isPlausibleElevationM(-2)).toBe(true);
  });

  it('rejects no-data sentinels and transposed coordinates', () => {
    expect(isPlausibleElevationM(-9999)).toBe(false);
    expect(isPlausibleElevationM(8848)).toBe(false);
    expect(isPlausibleElevationM(MIN_PLAUSIBLE_ELEVATION_M - 1)).toBe(false);
    expect(isPlausibleElevationM(MAX_PLAUSIBLE_ELEVATION_M + 1)).toBe(false);
  });

  it('rejects anything that is not a finite number', () => {
    for (const bad of [undefined, null, '350', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(isPlausibleElevationM(bad)).toBe(false);
    }
  });

  it('is exactly the closed interval it documents', () => {
    fc.assert(
      fc.property(fc.double({ min: -20000, max: 20000, noNaN: true }), (m) => {
        expect(isPlausibleElevationM(m)).toBe(
          m >= MIN_PLAUSIBLE_ELEVATION_M && m <= MAX_PLAUSIBLE_ELEVATION_M,
        );
      }),
    );
  });
});

describe('canOverwriteElevation', () => {
  it('never overwrites a moderator (the D68 precedence rule, carried across)', () => {
    expect(canOverwriteElevation('operator')).toBe(false);
  });

  it('overwrites its own prior reading and an empty field', () => {
    expect(canOverwriteElevation('dem_glo90')).toBe(true);
    expect(canOverwriteElevation(undefined)).toBe(true);
  });
});
