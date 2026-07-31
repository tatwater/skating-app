import fc from 'fast-check';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  type BBox,
  type BodyCandidate,
  bboxIntersects,
  bufferedLineOverlap,
  destinationPoint,
  distanceToPolygonMeters,
  expandBBox,
  haversineMeters,
  type LatLng,
  nearestBodyForPoint,
  pointInPolygon,
  pointNearPolygon,
  polygonBBox,
  polygonDistanceMeters,
  polygonIoU,
  polygonUnion,
  representativePoint,
  ringSelfIntersects,
  simplifyPath,
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

/**
 * The consensus footprint (N5c / D80) — overlapping duplicates drawn as one outline rather than as
 * stacked halos. Two properties carry the safety argument: the union covers every member (so
 * collapsing pins can only ever warn about *more* ice), and a clipper failure returns `null` so the
 * caller draws the members individually rather than losing one.
 */
describe('polygonUnion (N5c consensus rendering)', () => {
  const A = rect({ minLng: 0, minLat: 0, maxLng: 2, maxLat: 2 });
  const B = rect({ minLng: 1, minLat: 1, maxLng: 3, maxLat: 3 });

  it('returns nothing to draw for an empty list', () => {
    expect(polygonUnion([])).toBeNull();
  });

  it('hands a lone polygon straight back — a cluster of one is not a merge', () => {
    expect(polygonUnion([A])).toBe(A);
  });

  it('covers every member, which is what makes a merge safe to automate', () => {
    const merged = polygonUnion([A, B]);
    expect(merged).not.toBeNull();
    // Corners of both inputs, including the two that only one of them reaches.
    for (const corner of [
      { lat: 0.1, lng: 0.1 },
      { lat: 2.9, lng: 2.9 },
      { lat: 1.5, lng: 1.5 },
    ]) {
      expect(pointInPolygon(corner, merged as Polygon | MultiPolygon)).toBe(true);
    }
  });

  it('produces one shape where the members overlap, not a stack of parts', () => {
    // A fill layer blends each part separately, so a MultiPolygon of the members would darken where
    // they agree and seam where they meet — reading as several hazards at the moment we say there is
    // one.
    expect(polygonUnion([A, B])?.type).toBe('Polygon');
  });

  it('keeps disjoint members as separate parts rather than inventing ice between them', () => {
    const far = rect({ minLng: 10, minLat: 10, maxLng: 11, maxLat: 11 });
    const merged = polygonUnion([A, far]);
    expect(merged?.type).toBe('MultiPolygon');
    expect(pointInPolygon({ lat: 5, lng: 5 }, merged as MultiPolygon)).toBe(false);
  });

  it('fails open on a degenerate member instead of throwing', () => {
    // `null` is a signal to draw the members individually — more outlines, never fewer. Silently
    // dropping a hazard because a polygon operation went wrong is the one outcome D3 forbids.
    const degenerate = { type: 'Polygon', coordinates: [] } as unknown as Polygon;
    expect(() => polygonUnion([A, degenerate])).not.toThrow();
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

describe('destinationPoint (Phase 9.5 directional projection)', () => {
  const origin: LatLng = { lat: 44.4759, lng: -73.2121 };

  it('heads due north for bearing 0 (latitude up, longitude unchanged)', () => {
    const p = destinationPoint(origin, 0, 1000);
    expect(p.lat).toBeGreaterThan(origin.lat);
    expect(p.lng).toBeCloseTo(origin.lng, 9);
  });

  it('heads due east for bearing 90 (longitude up, latitude unchanged)', () => {
    const p = destinationPoint(origin, 90, 1000);
    expect(p.lng).toBeGreaterThan(origin.lng);
    expect(p.lat).toBeCloseTo(origin.lat, 9);
  });

  it('round-trips against haversine to sub-1% at the sub-km scale it serves (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 359 }),
        fc.integer({ min: 10, max: 1500 }),
        (bearing, metres) => {
          const measured = haversineMeters(origin, destinationPoint(origin, bearing, metres));
          expect(Math.abs(measured - metres) / metres).toBeLessThan(0.01);
        },
      ),
    );
  });

  it('is the inverse of the projection: opposite bearings return to the origin', () => {
    const out = destinationPoint(origin, 42, 800);
    const back = destinationPoint(out, 42 + 180, 800);
    expect(haversineMeters(origin, back)).toBeLessThan(5);
  });
});

describe('ringSelfIntersects', () => {
  /** A closed ring from distinct `[lng, lat]` corners. */
  function ring(...corners: [number, number][]): [number, number][] {
    const first = corners[0] as [number, number];
    return [...corners, first];
  }

  it('accepts a simple convex ring', () => {
    expect(ringSelfIntersects(ring([0, 0], [1, 0], [1, 1], [0, 1]))).toBe(false);
  });

  it('accepts a concave ring — a hazard zone is rarely convex', () => {
    // An L, whose reflex corner is the whole point: refusing concave shapes would refuse the
    // shore-hugging zones this primitive exists for.
    expect(ringSelfIntersects(ring([0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]))).toBe(false);
  });

  it('catches a bowtie', () => {
    // The classic four-tap mistake: corners entered in the wrong order cross the ring over itself.
    expect(ringSelfIntersects(ring([0, 0], [1, 1], [1, 0], [0, 1]))).toBe(true);
  });

  it('catches a ring that doubles back along its own edge', () => {
    // Collinear overlap encloses no area where it happens, which is the same lie as a crossing.
    expect(ringSelfIntersects(ring([0, 0], [2, 0], [1, 0], [1, 1]))).toBe(true);
  });

  it('does not mistake the shared endpoints of adjacent segments for a crossing', () => {
    // Every ring has n shared vertices by construction, including the one that closes it — a naive
    // all-pairs test reports every ring as self-intersecting.
    expect(ringSelfIntersects(ring([0, 0], [1, 0], [1, 1]))).toBe(false);
  });

  it('is false for degenerate rings rather than throwing', () => {
    expect(ringSelfIntersects([])).toBe(false);
    expect(
      ringSelfIntersects([
        [0, 0],
        [0, 0],
      ]),
    ).toBe(false);
  });

  it('never reports a convex ring as self-intersecting, at any size (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 40 }),
        fc.double({ min: 0.01, max: 5, noNaN: true }),
        (n, r) => {
          // Points on a circle in angular order are convex, hence simple, for any n.
          const corners = Array.from({ length: n }, (_, i): [number, number] => {
            const a = (2 * Math.PI * i) / n;
            return [r * Math.cos(a), r * Math.sin(a)];
          });
          expect(ringSelfIntersects(ring(...corners))).toBe(false);
        },
      ),
    );
  });
});

describe('simplifyPath', () => {
  /** A due-east path of `n` points spaced ~`stepDeg` apart, with an optional bulge at the middle. */
  function path(n: number, bulgeDeg = 0): LatLng[] {
    return Array.from({ length: n }, (_, i) => ({
      lat: 44.5 + (i === Math.floor(n / 2) ? bulgeDeg : 0),
      lng: -73.2 + i * 0.001,
    }));
  }

  it('collapses a straight run to its endpoints', () => {
    expect(simplifyPath(path(20), 10)).toEqual([path(20)[0], path(20)[19]]);
  });

  it('keeps a deviation larger than the tolerance', () => {
    // ~0.005° of latitude is ~550 m; a 100 m tolerance must not throw that away.
    const simplified = simplifyPath(path(21, 0.005), 100);
    expect(simplified.map((p) => p.lat)).toContain(44.505);
    expect(simplified.length).toBeLessThan(21);
  });

  it('drops a deviation smaller than the tolerance', () => {
    // ~0.00005° is ~5.5 m — finer than a hazard band's own uncertainty, so keeping it would be
    // storing precision the footprint doesn't have.
    expect(simplifyPath(path(21, 0.00005), 100)).toHaveLength(2);
  });

  it('is a pass-through for short paths and non-positive tolerances', () => {
    expect(simplifyPath(path(2), 100)).toEqual(path(2));
    expect(simplifyPath(path(20), 0)).toEqual(path(20));
  });

  it('always keeps both endpoints and never grows the path (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            lat: fc.double({ min: 44.4, max: 44.6, noNaN: true }),
            lng: fc.double({ min: -73.3, max: -73.1, noNaN: true }),
          }),
          { minLength: 2, maxLength: 60 },
        ),
        fc.double({ min: 1, max: 500, noNaN: true }),
        (points, tolerance) => {
          const simplified = simplifyPath(points, tolerance);
          expect(simplified.length).toBeGreaterThanOrEqual(2);
          expect(simplified.length).toBeLessThanOrEqual(points.length);
          expect(simplified[0]).toEqual(points[0]);
          expect(simplified[simplified.length - 1]).toEqual(points[points.length - 1]);
        },
      ),
    );
  });
});

describe('polygonDistanceMeters (N5c hazard clustering)', () => {
  const M_PER_DEG = 6_371_008.8 * (Math.PI / 180);
  const box = rect({ minLat: -0.0005, minLng: -0.0005, maxLat: 0.0005, maxLng: 0.0005 });

  it('is 0 for polygons that overlap', () => {
    const overlapping = rect({ minLat: 0, minLng: 0, maxLat: 0.001, maxLng: 0.001 });
    expect(polygonDistanceMeters(box, overlapping)).toBe(0);
  });

  it('is 0 when one polygon wholly contains the other', () => {
    const outer = rect({ minLat: -0.01, minLng: -0.01, maxLat: 0.01, maxLng: 0.01 });
    expect(polygonDistanceMeters(box, outer)).toBe(0);
    expect(polygonDistanceMeters(outer, box)).toBe(0);
  });

  it('measures the gap between edges, not between centroids', () => {
    // A box of the same size, 0.0005° of clear water to the east of this one's east edge.
    const east = rect({ minLat: -0.0005, minLng: 0.001, maxLat: 0.0005, maxLng: 0.002 });
    // Centroids are 0.00125° apart (~139 m); the gap is 0.0005° (~55.6 m). The gap is the answer.
    expect(polygonDistanceMeters(box, east)).toBeCloseTo(0.0005 * M_PER_DEG, -1);
  });

  it('is symmetric', () => {
    const east = rect({ minLat: -0.0005, minLng: 0.001, maxLat: 0.0005, maxLng: 0.002 });
    expect(polygonDistanceMeters(box, east)).toBeCloseTo(polygonDistanceMeters(east, box), 6);
  });

  it('reports 0 for crossing polygons with no vertex inside the other', () => {
    // A "+": two thin bars whose ends stick out past each other, so no corner of either lies within
    // the other, yet they plainly overlap. This is the case a vertex-only test gets wrong, and it is
    // the shape two crossing pressure ridges actually make.
    const horizontal = rect({ minLat: -0.0001, minLng: -0.001, maxLat: 0.0001, maxLng: 0.001 });
    const vertical = rect({ minLat: -0.001, minLng: -0.0001, maxLat: 0.001, maxLng: 0.0001 });
    expect(polygonDistanceMeters(horizontal, vertical)).toBe(0);
  });
});

describe('expandBBox', () => {
  it('grows a box by the requested distance on every side', () => {
    const grown = expandBBox({ minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 }, 100);
    // At the equator, 100 m north and 100 m east are the same number of degrees.
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: grown.maxLat, lng: 0 })).toBeCloseTo(100, 0);
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: grown.maxLng })).toBeCloseTo(100, 0);
  });

  it('never grows narrower than the true distance anywhere along the box (property)', () => {
    // The prefilter's whole contract: a point within `meters` of the box must land inside the grown
    // box. Erring wide costs one exact test; erring tight silently drops a real match.
    fc.assert(
      fc.property(
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: 1, max: 2000, noNaN: true }),
        fc.integer({ min: 0, max: 359 }),
        (lat, lng, meters, bearing) => {
          const box = { minLat: lat, minLng: lng, maxLat: lat + 0.01, maxLng: lng + 0.01 };
          const grown = expandBBox(box, meters);
          // Step out from each corner in an arbitrary direction, by just under the pad.
          for (const corner of [
            { lat: box.minLat, lng: box.minLng },
            { lat: box.maxLat, lng: box.maxLng },
          ]) {
            const out = destinationPoint(corner, bearing, meters * 0.99);
            expect(out.lat).toBeGreaterThanOrEqual(grown.minLat);
            expect(out.lat).toBeLessThanOrEqual(grown.maxLat);
            expect(out.lng).toBeGreaterThanOrEqual(grown.minLng);
            expect(out.lng).toBeLessThanOrEqual(grown.maxLng);
          }
        },
      ),
    );
  });
});
