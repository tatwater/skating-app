import { describe, expect, it } from 'vitest';

import { metersPerPixel, scaleStop } from './map-controls';

describe('metersPerPixel', () => {
  it('is Web Mercator at 512 px tiles: ~78 km a pixel at the equator, zoom 0', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78_271.5, 0);
  });

  it('halves with each zoom step and shrinks with the cosine of latitude', () => {
    expect(metersPerPixel(43.63, 14)).toBeCloseTo(metersPerPixel(43.63, 13) / 2, 9);
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) / 2, 6);
    expect(metersPerPixel(43.63, 13, 256)).toBeCloseTo(2 * metersPerPixel(43.63, 13), 9);
  });
});

describe('scaleStop', () => {
  /** A sweep of meters-per-pixel across eight decades and of bar budgets. */
  const MPPS = Array.from({ length: 400 }, (_, i) => 10 ** (-1 + (i / 400) * 8));
  const BUDGETS = [40, 64, 96, 128, 200];

  it('always picks 1, 2 or 5 × 10ⁿ meters, never under 1 m', () => {
    for (const mpp of MPPS)
      for (const max of BUDGETS) {
        const { meters } = scaleStop(mpp, max);
        expect(meters).toBeGreaterThanOrEqual(1);
        const lead = meters / 10 ** Math.floor(Math.log10(meters) + 1e-9);
        expect([1, 2, 5]).toContain(Math.round(lead * 1e6) / 1e6);
      }
  });

  it('fits its budget, and is the longest round distance that does', () => {
    for (const mpp of MPPS)
      for (const max of BUDGETS) {
        const { meters, px } = scaleStop(mpp, max);
        expect(px).toBeCloseTo(meters / mpp, 9);
        if (max * mpp < 1) continue; // closer than a meter fits: the 1 m floor may overrun
        expect(px).toBeLessThanOrEqual(max + 1e-9);
        // The next round step up (×2 or ×2.5) would not fit.
        const next = String(meters)[0] === '2' ? meters * 2.5 : meters * 2;
        expect(next / mpp).toBeGreaterThan(max);
      }
  });

  it('labels meters under a kilometer, kilometers from one up', () => {
    expect(scaleStop(9, 96).label).toBe('500 M');
    expect(scaleStop(26, 96).label).toBe('2 KM');
    expect(scaleStop(0.6, 96).label).toBe('50 M');
    expect(scaleStop(0.001, 96).label).toBe('1 M');
  });
});
