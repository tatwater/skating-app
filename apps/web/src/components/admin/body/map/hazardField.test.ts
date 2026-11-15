import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FIELD_FRESHNESS_OPACITY,
  FIELD_OPACITY_FLOOR,
  fieldDots,
  fieldOpacity,
} from './hazardField';
import type { MapHazardField } from './mapDescriptors';

const FRESHNESS = ['fresh', 'aging', 'stale', 'known'] as const;
const field = fc.record({
  freshness: fc.constantFrom(...FRESHNESS),
  tone: fc.constantFrom('hazard' as const, 'healing' as const),
  provisional: fc.boolean(),
});

/** A small square footprint near Mascoma, `side` degrees on a side. */
const square = (lng: number, lat: number, side: number): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + side, lat],
      [lng + side, lat + side],
      [lng, lat + side],
      [lng, lat],
    ],
  ],
});

describe('a hazard’s dot field (D3: decay is confidence, never safety)', () => {
  it('never fades a hazard to nothing, however stale and however unconfirmed', () => {
    fc.assert(
      fc.property(field, (f: MapHazardField) => {
        const o = fieldOpacity(f);
        expect(o).toBeGreaterThanOrEqual(FIELD_OPACITY_FLOOR);
        expect(o).toBeGreaterThan(0.2);
        expect(o).toBeLessThanOrEqual(1);
      }),
    );
    expect(FIELD_OPACITY_FLOOR).toBeCloseTo(0.24, 5);
  });

  it('steps back with age and with no second witness, and never brightens for either', () => {
    const at = (freshness: MapHazardField['freshness'], provisional = false) =>
      fieldOpacity({ freshness, tone: 'hazard', provisional });
    expect(at('fresh')).toBeGreaterThan(at('aging'));
    expect(at('aging')).toBeGreaterThan(at('stale'));
    for (const f of ['fresh', 'aging', 'stale'] as const) {
      expect(at(f, true)).toBeLessThan(at(f));
    }
  });

  it('draws a known feature at full strength — it has no clock and no witness count', () => {
    expect(fieldOpacity({ freshness: 'known', tone: 'hazard', provisional: true })).toBe(1);
    expect(FIELD_FRESHNESS_OPACITY.known).toBe(1);
  });

  it('draws at least one dot for any footprint, every dot inside it, and a bounded number', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -72.2, max: -72.1, noNaN: true }),
        fc.double({ min: 43.6, max: 43.65, noNaN: true }),
        fc.double({ min: 1e-6, max: 0.05, noNaN: true }),
        (lng, lat, side) => {
          const dots = fieldDots(square(lng, lat, side));
          expect(dots.length).toBeGreaterThan(0);
          expect(dots.length).toBeLessThanOrEqual(400);
          for (const [x, y] of dots) {
            expect(x).toBeGreaterThanOrEqual(lng - 1e-9);
            expect(x).toBeLessThanOrEqual(lng + side + 1e-9);
            expect(y).toBeGreaterThanOrEqual(lat - 1e-9);
            expect(y).toBeLessThanOrEqual(lat + side + 1e-9);
          }
        },
      ),
    );
  });

  it('spreads about fourteen dots along a footprint’s longer side', () => {
    const dots = fieldDots(square(-72.15, 43.62, 0.005));
    const rows = new Set(dots.map(([, y]) => y.toFixed(7)));
    expect(rows.size).toBeGreaterThanOrEqual(12);
    expect(rows.size).toBeLessThanOrEqual(16);
  });
});
