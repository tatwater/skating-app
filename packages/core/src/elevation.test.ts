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
  it('is the operator rung plus the DEMs — and it is still not a ladder', () => {
    // **This test failed when 3DEP was added, which is the point of it.** Its previous premise was
    // "one automated source", and its own comment said that if the list ever grew, the precedence
    // rule had to grow with it. It grew and the rule did not have to: `canOverwriteElevation` turns
    // on `operator` alone, so a newer DEM simply replaces an older one. That is what makes the swap
    // safe, and what makes measuring the datum shift first (D101) mandatory rather than polite.
    //
    // `dem_glo90` survives the switch deliberately — 5,692 rows were written with it, and a source
    // that stops existing the moment it is replaced makes every row it wrote unattributable.
    expect([...ELEVATION_SOURCES]).toEqual(['operator', 'dem_3dep', 'dem_glo90']);
  });

  it('lets either DEM be overwritten, and neither overwrite a moderator', () => {
    // The whole precedence rule, stated once. Order in the array above is documentation; this is
    // the behaviour.
    expect(canOverwriteElevation('dem_glo90')).toBe(true);
    expect(canOverwriteElevation('dem_3dep')).toBe(true);
    expect(canOverwriteElevation(undefined)).toBe(true);
    expect(canOverwriteElevation('operator')).toBe(false);
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
