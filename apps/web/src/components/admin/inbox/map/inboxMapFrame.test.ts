import { haversineMeters } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LngLat } from '../../body/map/mapDescriptors';
import {
  boxOf,
  frameBox,
  growBox,
  MIN_SPAN_M,
  metersBetween,
  midpoint,
  nearestVertices,
  outlineCoords,
} from './inboxMapFrame';

/** A point anywhere a body could be (clear of the poles, where a box stops meaning much). */
const point = fc
  .tuple(
    fc.double({ min: -179, max: 179, noNaN: true }),
    fc.double({ min: -70, max: 70, noNaN: true }),
  )
  .map((p): LngLat => p);

/** A cluster of points within ~20 km of each other: what one item's subject can span. */
const cluster = fc
  .tuple(
    point,
    fc.array(
      fc.tuple(
        fc.double({ min: -0.2, max: 0.2, noNaN: true }),
        fc.double({ min: -0.2, max: 0.2, noNaN: true }),
      ),
      { maxLength: 12 },
    ),
  )
  .map(([[lng, lat], offsets]): [LngLat, ...LngLat[]] => [
    [lng, lat],
    ...offsets.map(([dx, dy]): LngLat => [lng + dx, Math.max(-75, Math.min(75, lat + dy))]),
  ]);

const ns = (b: { minLat: number; maxLat: number; minLng: number }) =>
  haversineMeters({ lat: b.minLat, lng: b.minLng }, { lat: b.maxLat, lng: b.minLng });

describe('frameBox — the box an embed frames and fences on', () => {
  it('holds every point of the subject', () => {
    fc.assert(
      fc.property(cluster, (pts) => {
        const b = frameBox(pts);
        for (const [lng, lat] of pts) {
          expect(lng).toBeGreaterThanOrEqual(b.minLng);
          expect(lng).toBeLessThanOrEqual(b.maxLng);
          expect(lat).toBeGreaterThanOrEqual(b.minLat);
          expect(lat).toBeLessThanOrEqual(b.maxLat);
        }
      }),
    );
  });

  it('spans at least the minimum on both axes, east–west at its widest latitude', () => {
    fc.assert(
      fc.property(cluster, fc.double({ min: 50, max: 5000, noNaN: true }), (pts, min) => {
        const b = frameBox(pts, min);
        // North–south, along a meridian (a hair of tolerance for the mean degree vs the sphere).
        expect(ns(b)).toBeGreaterThanOrEqual(min * 0.995);
        // East–west, along the parallel nearest a pole: the box's narrowest.
        const worst = Math.abs(b.minLat) > Math.abs(b.maxLat) ? b.minLat : b.maxLat;
        const ew = (b.maxLng - b.minLng) * 111_320 * Math.cos((worst * Math.PI) / 180);
        expect(ew).toBeGreaterThanOrEqual(min * 0.995);
      }),
    );
  });

  it('grows about its own center and never moves a box already big enough', () => {
    fc.assert(
      fc.property(cluster, (pts) => {
        const raw = boxOf(pts);
        const b = frameBox(pts);
        if (raw === null) throw new Error('a cluster has points');
        expect((b.minLng + b.maxLng) / 2).toBeCloseTo((raw.minLng + raw.maxLng) / 2, 9);
        expect((b.minLat + b.maxLat) / 2).toBeCloseTo((raw.minLat + raw.maxLat) / 2, 9);
        // A box bigger than the minimum both ways is the subject's own box, exactly.
        // (Signed zeros compared as numbers: `-0` and `0` are one coordinate.)
        const zeroed = (b: typeof raw) =>
          [b.minLng, b.minLat, b.maxLng, b.maxLat].map((v) => v + 0);
        expect(zeroed(frameBox(pts, 0))).toEqual(zeroed(raw));
      }),
    );
  });

  it('frames a lone point at the minimum, centered on it', () => {
    const b = frameBox([[-72.15, 43.63]]);
    expect((b.minLng + b.maxLng) / 2).toBeCloseTo(-72.15, 12);
    expect(ns(b)).toBeGreaterThanOrEqual(MIN_SPAN_M * 0.995);
    expect(ns(b)).toBeLessThan(MIN_SPAN_M * 1.01);
  });
});

describe('growBox — room around a subject of a few points', () => {
  it('holds the box, keeps its center, and grows it to 1 + 2 × factor its size', () => {
    fc.assert(
      fc.property(cluster, fc.double({ min: 0, max: 3, noNaN: true }), (pts, f) => {
        const b = frameBox(pts);
        const g = growBox(b, f);
        expect(g.minLng).toBeLessThanOrEqual(b.minLng);
        expect(g.maxLng).toBeGreaterThanOrEqual(b.maxLng);
        expect(g.minLat).toBeLessThanOrEqual(b.minLat);
        expect(g.maxLat).toBeGreaterThanOrEqual(b.maxLat);
        expect((g.minLng + g.maxLng) / 2).toBeCloseTo((b.minLng + b.maxLng) / 2, 9);
        expect((g.minLat + g.maxLat) / 2).toBeCloseTo((b.minLat + b.maxLat) / 2, 9);
        expect(g.maxLat - g.minLat).toBeCloseTo((b.maxLat - b.minLat) * (1 + 2 * f), 9);
        expect(g.maxLng - g.minLng).toBeCloseTo((b.maxLng - b.minLng) * (1 + 2 * f), 9);
      }),
    );
  });
});

describe('boxOf', () => {
  it('is null for no points, and the extremes otherwise', () => {
    expect(boxOf([])).toBeNull();
    expect(
      boxOf([
        [1, 5],
        [-2, 3],
        [0, 9],
      ]),
    ).toEqual({ minLng: -2, maxLng: 1, minLat: 3, maxLat: 9 });
  });
});

describe('outlineCoords', () => {
  it('reads every ring of a polygon and of a multipolygon, holes included', () => {
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(outlineCoords({ type: 'Polygon', coordinates: [ring, ring] })).toHaveLength(8);
    expect(outlineCoords({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).toHaveLength(8);
    // A position missing a coordinate reads as zero, never as undefined.
    expect(outlineCoords({ type: 'Polygon', coordinates: [[[]]] })).toEqual([[0, 0]]);
  });
});

describe('nearestVertices — where a distance rule runs', () => {
  const poly = (pts: readonly LngLat[]): GeoJSON.Polygon => ({
    type: 'Polygon',
    coordinates: [pts.map((p) => [...p])],
  });

  it('picks the pair no other pair beats, one vertex from each', () => {
    fc.assert(
      fc.property(cluster, cluster, (a, far) => {
        // The second outline near the first, as a body and its neighbor are.
        const [o] = far;
        const b = far.map(
          ([lng, lat]): LngLat => [lng - o[0] + a[0][0] + 0.1, lat - o[1] + a[0][1]],
        );
        const pair = nearestVertices(poly(a), poly(b));
        if (pair === null) throw new Error('both have vertices');
        const [p, q] = pair;
        expect(a).toContainEqual(p);
        expect(b).toContainEqual(q);
        const best = metersBetween(p, q);
        // Measured great-circle against every pair: the flat comparison never misses one by more
        // than a part in ten thousand at this scale (~20 km, up to 75°).
        for (const x of a)
          for (const y of b) expect(best).toBeLessThanOrEqual(metersBetween(x, y) * 1.0001 + 1e-6);
      }),
    );
  });

  it('has no pair for an outline with no vertices', () => {
    expect(nearestVertices({ type: 'Polygon', coordinates: [] }, poly([[0, 0]]))).toBeNull();
  });
});

describe('metersBetween and midpoint', () => {
  it('is symmetric and zero at a point', () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        expect(metersBetween(a, b)).toBeCloseTo(metersBetween(b, a), 6);
        expect(metersBetween(a, a)).toBe(0);
      }),
    );
  });

  it('puts the midpoint halfway', () => {
    expect(midpoint([0, 0], [2, 4])).toEqual([1, 2]);
  });
});
