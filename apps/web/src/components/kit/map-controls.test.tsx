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
  const FT = 0.3048;
  const MI = 1609.344;
  /** Every stop the bar may land on, shortest first: 1, 2, 5 × 10ⁿ feet to 500, then miles. */
  const LADDER = [
    ...[1, 10, 100].flatMap((d) => [1, 2, 5].map((s) => s * d * FT)),
    ...[0.1, 1, 10, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000].flatMap((d) =>
      [1, 2, 5].map((s) => s * d * MI),
    ),
  ];
  const onLadder = (m: number) => LADDER.some((l) => Math.abs(l - m) < 1e-6 * l);

  it('shows the app’s units (stored metric, shown imperial): round feet, then round miles', () => {
    for (const mpp of MPPS)
      for (const max of BUDGETS) {
        const { meters, unit } = scaleStop(mpp, max);
        expect(onLadder(meters)).toBe(true);
        // Feet up to 500, miles from a tenth: never a meter, never a kilometer.
        expect(unit).toBe(meters < 0.1 * MI - 1e-6 ? 'ft' : 'mi');
      }
  });

  it('fits its budget, and is the longest stop on the ladder that does', () => {
    for (const mpp of MPPS)
      for (const max of BUDGETS) {
        const { meters, px } = scaleStop(mpp, max);
        expect(px).toBeCloseTo(meters / mpp, 9);
        if (max * mpp < FT) continue; // closer than a foot fits: the 1 ft floor may overrun
        expect(px).toBeLessThanOrEqual(max + 1e-9);
        const next = LADDER.find((l) => l > meters * (1 + 1e-9));
        if (next !== undefined) expect(next / mpp).toBeGreaterThan(max);
      }
  });

  it('stops at a foot, and lands on the board-sized stops', () => {
    expect(scaleStop(0.0001, 96).meters).toBeCloseTo(FT, 9);
    // 96 px at ~9.6 m a pixel (the Caspian board's 500 M) is half a mile.
    expect(scaleStop(9.6, 96)).toMatchObject({ unit: 'mi' });
    expect(scaleStop(9.6, 96).meters).toBeCloseTo(0.5 * MI, 6);
    // 96 px at 0.6 m a pixel is 189 ft: the bar shows 100.
    expect(scaleStop(0.6, 96).meters).toBeCloseTo(100 * FT, 9);
  });
});

describe('MapScaleBar', () => {
  const MI = 1609.344;
  it('labels the stop with the caller’s formatter, and names it in words', async () => {
    const { render } = await import('@testing-library/react');
    const { MapScaleBar } = await import('./map-controls');
    const seen: number[] = [];
    const format = (m: number) => {
      seen.push(m);
      return '0.5 mi';
    };
    const { container } = render(<MapScaleBar metersPerPixel={9.6} format={format} />);
    expect(seen[0]).toBeCloseTo(0.5 * MI, 6);
    expect(container.querySelector('[data-slot="map-scale-label"]')?.textContent).toBe('0.5 mi');
    expect(container.querySelector('[data-slot="map-scale"]')).toHaveAttribute(
      'aria-label',
      'Scale: 0.5 miles',
    );
    const ft = render(<MapScaleBar metersPerPixel={0.6} format={() => '100 ft'} />);
    expect(ft.container.querySelector('[data-slot="map-scale"]')).toHaveAttribute(
      'aria-label',
      'Scale: 100 feet',
    );
  });
});
