import { describe, expect, it } from 'vitest';
import { chooseInterval, contourLevels, NICE_INTERVALS_FT, TARGET_CONTOUR_COUNT } from './interval';

describe('chooseInterval', () => {
  it('always returns an interval a person recognises', () => {
    for (const depth of [3, 12, 40, 87, 150, 400, 1000]) {
      expect(NICE_INTERVALS_FT).toContain(chooseInterval(depth));
    }
  });

  it('lands near the target band count across three orders of depth', () => {
    // The whole point: a 12 ft pond and a 400 ft lake should both read as a basin, not as two lines
    // or as ninety.
    for (const depth of [12, 40, 120, 400]) {
      const count = contourLevels(depth, chooseInterval(depth)).length;
      expect(count).toBeGreaterThanOrEqual(4);
      expect(count).toBeLessThanOrEqual(TARGET_CONTOUR_COUNT * 2);
    }
  });

  it('gives a deep lake a coarse interval rather than eighty lines', () => {
    // Champlain is ~400 ft. A linear nearest-candidate comparison picks 5 ft here, because the large
    // candidates always *look* further from the ideal on a linear scale. Log space is what fixes it.
    expect(chooseInterval(400)).toBeGreaterThanOrEqual(25);
  });

  it('gives a shallow pond a fine interval rather than one line', () => {
    expect(chooseInterval(14)).toBeLessThanOrEqual(2);
  });

  it('falls back to the finest interval on a nonsense depth instead of throwing', () => {
    expect(chooseInterval(0)).toBe(2);
    expect(chooseInterval(-5)).toBe(2);
    expect(chooseInterval(Number.NaN)).toBe(2);
  });
});

describe('contourLevels', () => {
  it('steps by the interval', () => {
    expect(contourLevels(52, 10)).toEqual([10, 20, 30, 40, 50]);
  });

  it('never emits zero — the shoreline is the polygon we already draw', () => {
    // Including it would double-stroke every lake edge in the contour palette, at the one place D82
    // says the contour has to lose against anything competing for legibility.
    expect(contourLevels(30, 5)).not.toContain(0);
    expect(contourLevels(30, 5)[0]).toBe(5);
  });

  it('stops short of the deepest sounding', () => {
    // A contour exactly at the maximum is a ring around one reading — a picture of where the boat
    // passed, not of the basin.
    expect(contourLevels(50, 10)).not.toContain(50);
    expect(contourLevels(50, 10).at(-1)).toBe(40);
  });

  it('returns nothing when the lake is shallower than one interval', () => {
    expect(contourLevels(4, 5)).toEqual([]);
  });

  it('returns nothing rather than looping forever on a bad interval', () => {
    expect(contourLevels(50, 0)).toEqual([]);
    expect(contourLevels(50, -5)).toEqual([]);
    expect(contourLevels(Number.NaN, 5)).toEqual([]);
  });
});
