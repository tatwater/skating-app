import fc from 'fast-check';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { haversineMeters, pointInPolygon } from './geometry';
import {
  DEFAULT_SAMPLE_SPACING_KM,
  MAX_SUGGESTED_SAMPLE_POINTS,
  suggestSamplePoints,
} from './samplePoints';

function rect(minLng: number, minLat: number, maxLng: number, maxLat: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

/** A Champlain-ish stand-in: ~1.5° of latitude (~165 km) by ~0.2° of longitude. */
const BIG_LAKE = rect(-73.4, 43.6, -73.2, 45.1);

describe('suggestSamplePoints', () => {
  it('suggests several points down a lake long enough to need them', () => {
    const { points, truncated, fellBackToCentroid } = suggestSamplePoints(BIG_LAKE);
    expect(points.length).toBeGreaterThan(1);
    expect(truncated).toBe(false);
    expect(fellBackToCentroid).toBe(false);
  });

  it('every suggested point lies on the water', () => {
    for (const point of suggestSamplePoints(BIG_LAKE).points) {
      expect(pointInPolygon(point, BIG_LAKE)).toBe(true);
    }
  });

  it('gives a small pond exactly one point, in the middle rather than at a corner', () => {
    const pond = rect(-72.5, 44.0, -72.49, 44.01);
    const { points } = suggestSamplePoints(pond);
    expect(points).toHaveLength(1);
    expect(points[0]?.lat).toBeCloseTo(44.005, 3);
    expect(points[0]?.lng).toBeCloseTo(-72.495, 3);
  });

  it('falls back to the representative point when no grid point lands on water', () => {
    // A lagoon smaller than one grid step: the single centred point falls in the hole, so the grid
    // yields nothing and the caller still needs a point to sample at.
    const ring: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73.4, 44.0],
          [-73.39, 44.0],
          [-73.39, 44.01],
          [-73.4, 44.01],
          [-73.4, 44.0],
        ],
        [
          [-73.398, 44.002],
          [-73.392, 44.002],
          [-73.392, 44.008],
          [-73.398, 44.008],
          [-73.398, 44.002],
        ],
      ],
    };
    const { points, fellBackToCentroid } = suggestSamplePoints(ring);
    expect(points).toHaveLength(1);
    expect(fellBackToCentroid).toBe(true);
    expect(pointInPolygon(points[0] as { lat: number; lng: number }, ring)).toBe(true);
  });

  it('handles a MultiPolygon by sampling each component that catches a grid line', () => {
    const twoLobes: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rect(-73.4, 44.0, -73.2, 44.2).coordinates,
        rect(-72.8, 44.0, -72.6, 44.2).coordinates,
      ],
    };
    const { points } = suggestSamplePoints(twoLobes, 5);
    expect(points.length).toBeGreaterThan(1);
    for (const point of points) expect(pointInPolygon(point, twoLobes)).toBe(true);
  });

  it('falls back rather than dividing by zero on a nonsense spacing', () => {
    for (const spacing of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { points, fellBackToCentroid } = suggestSamplePoints(BIG_LAKE, spacing);
      expect(points).toHaveLength(1);
      expect(fellBackToCentroid).toBe(true);
    }
  });

  it('caps an absurdly fine grid and says so, rather than truncating silently', () => {
    const { points, truncated } = suggestSamplePoints(BIG_LAKE, 0.1);
    expect(points).toHaveLength(MAX_SUGGESTED_SAMPLE_POINTS);
    expect(truncated).toBe(true);
  });

  /**
   * The guarantee runs one way on purpose: being coarser than requested costs nothing the weather
   * model can resolve, while being finer buys duplicate forecasts on a shared free tier. So no two
   * suggested points may be closer than the requested spacing.
   */
  it('property: no two suggested points are closer than the requested spacing', () => {
    fc.assert(
      fc.property(
        fc.record({
          lat: fc.double({ min: 41, max: 47, noNaN: true }),
          lng: fc.double({ min: -75, max: -69, noNaN: true }),
          h: fc.double({ min: 0.05, max: 1.5, noNaN: true }),
          w: fc.double({ min: 0.05, max: 1.5, noNaN: true }),
          spacingKm: fc.double({ min: 2, max: 25, noNaN: true }),
        }),
        ({ lat, lng, h, w, spacingKm }) => {
          const polygon = rect(lng, lat, lng + w, lat + h);
          const { points, fellBackToCentroid } = suggestSamplePoints(polygon, spacingKm);
          if (fellBackToCentroid) return;
          for (let i = 0; i < points.length; i++) {
            for (let j = i + 1; j < points.length; j++) {
              const a = points[i];
              const b = points[j];
              if (!a || !b) continue;
              // 1% slack for the difference between the haversine metre and the flat
              // metres-per-degree constant the grid steps in.
              expect(haversineMeters(a, b)).toBeGreaterThan(spacingKm * 1000 * 0.99);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: every suggested point is inside the polygon it was suggested for', () => {
    fc.assert(
      fc.property(
        fc.record({
          lat: fc.double({ min: 41, max: 47, noNaN: true }),
          lng: fc.double({ min: -75, max: -69, noNaN: true }),
          h: fc.double({ min: 0.05, max: 2, noNaN: true }),
          w: fc.double({ min: 0.05, max: 2, noNaN: true }),
        }),
        ({ lat, lng, h, w }) => {
          const polygon = rect(lng, lat, lng + w, lat + h);
          for (const point of suggestSamplePoints(polygon, DEFAULT_SAMPLE_SPACING_KM).points) {
            expect(pointInPolygon(point, polygon)).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
