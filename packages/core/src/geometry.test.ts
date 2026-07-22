import fc from 'fast-check';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  type BBox,
  type BodyCandidate,
  bboxIntersects,
  bufferedLineOverlap,
  distanceToPolygonMeters,
  haversineMeters,
  type LatLng,
  nearestBodyForPoint,
  pointInPolygon,
  pointNearPolygon,
  polygonBBox,
  polygonIoU,
  representativePoint,
  surfaceAreaSqM,
} from './geometry';

// --- Test helpers (analytic ground truth) ---

/** An axis-aligned rectangle as a GeoJSON Polygon (`[lng, lat]` order). */
function rect(b: BBox): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [b.minLng, b.minLat],
        [b.maxLng, b.minLat],
        [b.maxLng, b.maxLat],
        [b.minLng, b.maxLat],
        [b.minLng, b.minLat],
      ],
    ],
  };
}

/** Planar IoU of two boxes — valid ground truth for the small, near-equator boxes below,
 *  where geodesic area ≈ planar area and the scaling factor cancels in the ratio. */
function analyticRectIoU(a: BBox, b: BBox): number {
  const ix = Math.max(0, Math.min(a.maxLng, b.maxLng) - Math.max(a.minLng, b.minLng));
  const iy = Math.max(0, Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat));
  const inter = ix * iy;
  const areaA = (a.maxLng - a.minLng) * (a.maxLat - a.minLat);
  const areaB = (b.maxLng - b.minLng) * (b.maxLat - b.minLat);
  const union = areaA + areaB - inter;
  return union === 0 ? 0 : inter / union;
}

/** A small box near the equator, so geodesic ≈ planar for analytic comparison. */
const arbBox: fc.Arbitrary<BBox> = fc
  .record({
    minLat: fc.double({ min: -2, max: 2, noNaN: true }),
    minLng: fc.double({ min: -2, max: 2, noNaN: true }),
    w: fc.double({ min: 0.2, max: 1.5, noNaN: true }),
    h: fc.double({ min: 0.2, max: 1.5, noNaN: true }),
  })
  .map(({ minLat, minLng, w, h }) => ({ minLat, minLng, maxLat: minLat + h, maxLng: minLng + w }));

describe('bboxIntersects', () => {
  const A: BBox = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };

  it('detects overlap, disjointness, and edge-touching', () => {
    expect(bboxIntersects(A, { minLat: 0.5, minLng: 0.5, maxLat: 2, maxLng: 2 })).toBe(true);
    expect(bboxIntersects(A, { minLat: 2, minLng: 2, maxLat: 3, maxLng: 3 })).toBe(false);
    // Shares the edge x=1 — inclusive, so this counts as intersecting.
    expect(bboxIntersects(A, { minLat: 0, minLng: 1, maxLat: 1, maxLng: 2 })).toBe(true);
    // Fully contained.
    expect(bboxIntersects(A, { minLat: 0.2, minLng: 0.2, maxLat: 0.8, maxLng: 0.8 })).toBe(true);
    // Overlaps in lng but not lat.
    expect(bboxIntersects(A, { minLat: 5, minLng: 0, maxLat: 6, maxLng: 1 })).toBe(false);
  });

  it('is reflexive and symmetric (property)', () => {
    fc.assert(
      fc.property(arbBox, arbBox, (a, b) => {
        expect(bboxIntersects(a, a)).toBe(true);
        expect(bboxIntersects(a, b)).toBe(bboxIntersects(b, a));
      }),
    );
  });

  it('agrees with polygon overlap: IoU>0 ⇒ intersect, ¬intersect ⇒ IoU=0 (property)', () => {
    fc.assert(
      fc.property(arbBox, arbBox, (a, b) => {
        const iou = polygonIoU(rect(a), rect(b));
        if (iou > 0) expect(bboxIntersects(a, b)).toBe(true);
        if (!bboxIntersects(a, b)) expect(iou).toBe(0);
      }),
    );
  });
});

describe('polygonBBox', () => {
  it('computes the bbox of a polygon, multipolygon, and line', () => {
    expect(polygonBBox(rect({ minLat: 1, minLng: -3, maxLat: 4, maxLng: 2 }))).toEqual({
      minLat: 1,
      minLng: -3,
      maxLat: 4,
      maxLng: 2,
    });

    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [rect({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }).coordinates],
    };
    expect(polygonBBox(mp)).toEqual({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 });

    const line: LineString = {
      type: 'LineString',
      coordinates: [
        [-5, 10],
        [5, -10],
        [0, 0],
      ],
    };
    expect(polygonBBox(line)).toEqual({ minLat: -10, minLng: -5, maxLat: 10, maxLng: 5 });
  });

  it('round-trips through rect() for any box (property)', () => {
    fc.assert(
      fc.property(arbBox, (b) => {
        const got = polygonBBox(rect(b));
        expect(got.minLat).toBeCloseTo(b.minLat, 9);
        expect(got.minLng).toBeCloseTo(b.minLng, 9);
        expect(got.maxLat).toBeCloseTo(b.maxLat, 9);
        expect(got.maxLng).toBeCloseTo(b.maxLng, 9);
      }),
    );
  });
});

describe('pointInPolygon', () => {
  const square = rect({ minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 });

  it('classifies clear inside/outside points', () => {
    expect(pointInPolygon({ lat: 1, lng: 1 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 5, lng: 5 }, square)).toBe(false);
  });

  it('matches point-in-rect for non-boundary points (property)', () => {
    fc.assert(
      fc.property(
        arbBox,
        fc.double({ min: -4, max: 4, noNaN: true }),
        fc.double({ min: -4, max: 4, noNaN: true }),
        (box, lat, lng) => {
          const margin = 1e-6;
          const clearlyInside =
            lng > box.minLng + margin &&
            lng < box.maxLng - margin &&
            lat > box.minLat + margin &&
            lat < box.maxLat - margin;
          const clearlyOutside =
            lng < box.minLng - margin ||
            lng > box.maxLng + margin ||
            lat < box.minLat - margin ||
            lat > box.maxLat + margin;
          const point: LatLng = { lat, lng };
          // Skip the ambiguous boundary sliver where turf's convention could go either way.
          if (clearlyInside) expect(pointInPolygon(point, rect(box))).toBe(true);
          else if (clearlyOutside) expect(pointInPolygon(point, rect(box))).toBe(false);
        },
      ),
    );
  });
});

describe('polygonIoU', () => {
  const A = rect({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 });

  it('is 1 for identical, 0 for disjoint, and matches the known overlap', () => {
    expect(polygonIoU(A, A)).toBeCloseTo(1, 6);
    expect(polygonIoU(A, rect({ minLat: 5, minLng: 5, maxLat: 6, maxLng: 6 }))).toBe(0);
    // A∩B = 0.5×0.5 = 0.25; A∪B = 1 + 1 − 0.25 = 1.75; IoU = 0.142857…
    expect(polygonIoU(A, rect({ minLat: 0.5, minLng: 0.5, maxLat: 1.5, maxLng: 1.5 }))).toBeCloseTo(
      0.25 / 1.75,
      4,
    );
  });

  it('matches analytic rectangle IoU and stays in [0,1], symmetric (property)', () => {
    fc.assert(
      fc.property(arbBox, arbBox, (a, b) => {
        const iou = polygonIoU(rect(a), rect(b));
        expect(iou).toBeGreaterThanOrEqual(0);
        expect(iou).toBeLessThanOrEqual(1 + 1e-9);
        expect(iou).toBeCloseTo(analyticRectIoU(a, b), 2);
        expect(iou).toBeCloseTo(polygonIoU(rect(b), rect(a)), 9);
      }),
    );
  });
});

describe('representativePoint (on-water point, D48)', () => {
  it('lands inside a simple polygon', () => {
    const square = rect({ minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 });
    expect(pointInPolygon(representativePoint(square), square)).toBe(true);
  });

  it('lands ON the water for a concave (U-shaped) lake whose area centroid is off-water', () => {
    // A U opening upward. Its area centroid sits at ~(lng 1.5, lat 1.29) — inside the notch,
    // i.e. on dry land — which is exactly the crescent/horseshoe failure a raw centroid hits.
    const uShape: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [2.2, 3],
          [2.2, 0.8],
          [0.8, 0.8],
          [0.8, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    };
    // The naive area centroid is off-water…
    expect(pointInPolygon({ lat: 1.29, lng: 1.5 }, uShape)).toBe(false);
    // …but the representative point is guaranteed on the surface.
    expect(pointInPolygon(representativePoint(uShape), uShape)).toBe(true);
  });

  it('lands on one of the parts of a MultiPolygon', () => {
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rect({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }).coordinates,
        rect({ minLat: 10, minLng: 10, maxLat: 11, maxLng: 11 }).coordinates,
      ],
    };
    expect(pointInPolygon(representativePoint(mp), mp)).toBe(true);
  });

  it('always returns a point on the surface, for any box (property)', () => {
    fc.assert(
      fc.property(arbBox, (b) => {
        const poly = rect(b);
        expect(pointInPolygon(representativePoint(poly), poly)).toBe(true);
      }),
    );
  });
});

describe('surfaceAreaSqM', () => {
  it('is positive and scales with the polygon (a ~1° box near the equator ≈ 1.2e10 m²)', () => {
    const oneDeg = surfaceAreaSqM(rect({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }));
    expect(oneDeg).toBeGreaterThan(1.2e10);
    expect(oneDeg).toBeLessThan(1.25e10);
    // Doubling the width roughly doubles the area.
    const twoDegWide = surfaceAreaSqM(rect({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 2 }));
    expect(twoDegWide).toBeCloseTo(2 * oneDeg, -8);
  });
});

describe('bufferedLineOverlap (rivers, D36)', () => {
  const line = (coords: [number, number][]): LineString => ({
    type: 'LineString',
    coordinates: coords,
  });
  const northSouth = line([
    [0, 0],
    [0, 0.05],
  ]);

  it('is ~1 for identical lines and 0 for far-apart lines', () => {
    expect(bufferedLineOverlap(northSouth, northSouth, 100)).toBeCloseTo(1, 3);
    const faraway = line([
      [10, 10],
      [10, 10.05],
    ]);
    expect(bufferedLineOverlap(northSouth, faraway, 100)).toBe(0);
  });

  it('is symmetric and in [0,1] (property)', () => {
    const arbLine = fc
      .record({
        lat: fc.double({ min: -1, max: 1, noNaN: true }),
        lng: fc.double({ min: -1, max: 1, noNaN: true }),
        len: fc.double({ min: 0.01, max: 0.1, noNaN: true }),
      })
      .map(({ lat, lng, len }) =>
        line([
          [lng, lat],
          [lng, lat + len],
        ]),
      );

    // Each case runs two geodesic buffers + an IoU twice (a,b and b,a) — heavy enough that the
    // default 100 runs was borderline against Vitest's 5s timeout and flaked on loaded CI runners.
    // 40 runs still samples the space well; the explicit timeout adds margin. (Rivers, D36/D40.)
    fc.assert(
      fc.property(arbLine, arbLine, (a, b) => {
        const overlap = bufferedLineOverlap(a, b, 200);
        expect(overlap).toBeGreaterThanOrEqual(0);
        expect(overlap).toBeLessThanOrEqual(1 + 1e-9);
        expect(overlap).toBeCloseTo(bufferedLineOverlap(b, a, 200), 6);
      }),
      { numRuns: 40 },
    );
  }, 20_000);
});

describe('distanceToPolygonMeters (offline auto-select / Phase 9 proximity)', () => {
  // ~111 m square centred on the equator, so a degree of lat or lng ≈ the same metres and the
  // local equirectangular projection is easy to reason about analytically.
  const M_PER_DEG = 6_371_008.8 * (Math.PI / 180); // ≈ 111,194.9 m per degree at the equator
  const box = rect({ minLat: -0.0005, minLng: -0.0005, maxLat: 0.0005, maxLng: 0.0005 });

  it('is 0 for a point inside the polygon', () => {
    expect(distanceToPolygonMeters({ lat: 0, lng: 0 }, box)).toBe(0);
  });

  it('measures the perpendicular distance to the nearest edge', () => {
    // 0.0005° east of the east edge (which sits at lng 0.0005).
    const d = distanceToPolygonMeters({ lat: 0, lng: 0.001 }, box);
    expect(d).toBeCloseTo(0.0005 * M_PER_DEG, -1); // ≈ 55.6 m, within a metre
  });

  it('measures the distance to the nearest corner for a diagonally-outside point', () => {
    const d = distanceToPolygonMeters({ lat: 0.001, lng: 0.001 }, box);
    expect(d).toBeCloseTo(Math.SQRT2 * 0.0005 * M_PER_DEG, -1); // ≈ 78.6 m to the NE corner
  });

  it('handles a MultiPolygon (nearest across all parts)', () => {
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        box.coordinates,
        rect({ minLat: 10, minLng: 10, maxLat: 10.001, maxLng: 10.001 }).coordinates,
      ],
    };
    // Just east of the near part — the far part must not win.
    expect(distanceToPolygonMeters({ lat: 0, lng: 0.001 }, mp)).toBeCloseTo(0.0005 * M_PER_DEG, -1);
  });

  it('is non-negative, 0 iff inside, and consistent with pointNearPolygon (property)', () => {
    fc.assert(
      fc.property(
        arbBox,
        fc.double({ min: -4, max: 4, noNaN: true }),
        fc.double({ min: -4, max: 4, noNaN: true }),
        fc.double({ min: 1, max: 5000, noNaN: true }),
        (b, lat, lng, buffer) => {
          const poly = rect(b);
          const point: LatLng = { lat, lng };
          const d = distanceToPolygonMeters(point, poly);
          expect(d).toBeGreaterThanOrEqual(0);
          if (pointInPolygon(point, poly)) expect(d).toBe(0);
          expect(pointNearPolygon(point, poly, buffer)).toBe(d <= buffer);
        },
      ),
    );
  });
});

describe('nearestBodyForPoint (shared point→lake resolver)', () => {
  const near = rect({ minLat: -0.0005, minLng: -0.0005, maxLat: 0.0005, maxLng: 0.0005 });
  const far = rect({ minLat: 10, minLng: 10, maxLat: 10.001, maxLng: 10.001 });
  const candidates: BodyCandidate<string>[] = [
    { ref: 'near', polygon: near, surfaceAreaSqM: surfaceAreaSqM(near) },
    { ref: 'far', polygon: far, surfaceAreaSqM: surfaceAreaSqM(far) },
  ];

  it('returns the body the point sits inside', () => {
    expect(nearestBodyForPoint({ lat: 0, lng: 0 }, candidates, 300)).toBe('near');
  });

  it('resolves a point in the approach/parking buffer to the nearby lake', () => {
    // ~55 m east of `near`, far outside it but well within a 300 m parking buffer.
    expect(nearestBodyForPoint({ lat: 0, lng: 0.001 }, candidates, 300)).toBe('near');
  });

  it('returns null when nothing is within the buffer', () => {
    // Same ~55 m point, but a 10 m buffer excludes it.
    expect(nearestBodyForPoint({ lat: 0, lng: 0.001 }, candidates, 10)).toBeNull();
  });

  it('tie-breaks overlapping matches by smaller area (the most-specific lake wins)', () => {
    const big = rect({ minLat: -0.001, minLng: -0.001, maxLat: 0.001, maxLng: 0.001 });
    const small = rect({ minLat: -0.0003, minLng: -0.0003, maxLat: 0.0003, maxLng: 0.0003 });
    const nested: BodyCandidate<string>[] = [
      { ref: 'big', polygon: big, surfaceAreaSqM: surfaceAreaSqM(big) },
      { ref: 'small', polygon: small, surfaceAreaSqM: surfaceAreaSqM(small) },
    ];
    // (0,0) is inside both (distance 0 each) → the smaller-area body wins.
    expect(nearestBodyForPoint({ lat: 0, lng: 0 }, nested, 300)).toBe('small');
  });
});

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters({ lat: 44, lng: -72 }, { lat: 44, lng: -72 })).toBe(0);
  });

  it('measures ~111 km for one degree of latitude', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('shrinks a degree of longitude by cos(latitude)', () => {
    // At 60°N a degree of longitude spans ~half the ground distance it does at the equator.
    const equator = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const high = haversineMeters({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    expect(high / equator).toBeCloseTo(0.5, 2);
  });

  it('is symmetric', () => {
    const a = { lat: 42.1, lng: -71.2 };
    const b = { lat: 43.9, lng: -73.4 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});
