import { describe, expect, it } from 'vitest';
import {
  AERIAL_MASK_METERS,
  buildImageryMask,
  FEATHER_STEPS,
  featherRings,
  imageryMaskLayerId,
  inverseMask,
  MASK_FILL_OPACITY,
  revealShape,
  SENTINEL_MASK_METERS,
} from './imageryMask';
import { pointInPolygon, surfaceAreaSqM } from './geometry';
import type { MultiPolygon, Polygon } from 'geojson';

/** A ~1 km square pond near Burlington, big enough that metre-scale buffers are visible in it. */
const POND: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.2, 44.45],
      [-73.19, 44.45],
      [-73.19, 44.46],
      [-73.2, 44.46],
      [-73.2, 44.45],
    ],
  ],
};

/** The same pond with an island in it — the case that decides whether holes survive inversion. */
const POND_WITH_ISLAND: Polygon = {
  type: 'Polygon',
  coordinates: [
    POND.coordinates[0] as number[][],
    [
      [-73.196, 44.454],
      [-73.194, 44.454],
      [-73.194, 44.456],
      [-73.196, 44.456],
      [-73.196, 44.454],
    ],
  ],
};

describe('revealShape', () => {
  it('grows the water by the solid buffer', () => {
    const grown = revealShape({ polygon: POND }, 50);
    expect(grown).not.toBeNull();
    expect(surfaceAreaSqM(grown as Polygon | MultiPolygon)).toBeGreaterThan(surfaceAreaSqM(POND));
  });

  it('reaches a mile-away trailhead, because the approach is part of the way in', () => {
    // ~1.4 km west of the pond — outside any sane buffer of the water alone (the D72 amendment's case).
    const parking = { lat: 44.455, lng: -73.218 };
    const water = revealShape({ polygon: POND }, 10);
    const withWalk = revealShape(
      {
        polygon: POND,
        parkingCoords: [parking],
        approachPaths: [
          [
            parking,
            { lat: 44.455, lng: -73.21 },
            { lat: 44.455, lng: -73.2 },
          ],
        ],
      },
      10,
    );
    expect(water).not.toBeNull();
    expect(withWalk).not.toBeNull();
    // The lot is off the water's own mask and inside the one that includes the walk.
    expect(pointInPolygon(parking, water as Polygon | MultiPolygon)).toBe(false);
    expect(pointInPolygon(parking, withWalk as Polygon | MultiPolygon)).toBe(true);
  });

  it('covers the whole length of the approach, not just its ends', () => {
    const parking = { lat: 44.455, lng: -73.218 };
    const midpoint = { lat: 44.455, lng: -73.209 };
    const shape = revealShape(
      {
        polygon: POND,
        approachPaths: [[parking, { lat: 44.455, lng: -73.209 }, { lat: 44.455, lng: -73.2 }]],
      },
      10,
    );
    expect(pointInPolygon(midpoint, shape as Polygon | MultiPolygon)).toBe(true);
  });

  it('ignores a one-point approach — that is a marker that lost its other end', () => {
    const stray = { lat: 44.4, lng: -73.3 };
    const shape = revealShape({ polygon: POND, approachPaths: [[stray]] }, 10);
    expect(pointInPolygon(stray, shape as Polygon | MultiPolygon)).toBe(false);
  });

  it('returns null rather than an empty shape when there is nothing to reveal', () => {
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    expect(revealShape({ polygon: empty }, 10)).toBeNull();
  });
});

describe('inverseMask', () => {
  it('covers the far field and leaves a hole where the shape is', () => {
    const mask = inverseMask(POND);
    // Kansas is masked; the middle of the pond is not.
    expect(pointInPolygon({ lat: 38.5, lng: -98.3 }, mask)).toBe(true);
    expect(pointInPolygon({ lat: 44.455, lng: -73.195 }, mask)).toBe(false);
  });

  it("paints over the shape's own islands", () => {
    const mask = inverseMask(POND_WITH_ISLAND);
    // An island inside a lake is not the lake; the photograph has to stop at the water.
    expect(pointInPolygon({ lat: 44.455, lng: -73.195 }, mask)).toBe(true);
    // ...while open water beside it still shows through.
    expect(pointInPolygon({ lat: 44.4515, lng: -73.1975 }, mask)).toBe(false);
  });

  it('keeps every ring of a multipolygon', () => {
    const two: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [POND.coordinates as number[][][], POND_WITH_ISLAND.coordinates as number[][][]],
    };
    const mask = inverseMask(two);
    // World ring + 1 + 2.
    expect(mask.coordinates).toHaveLength(4);
  });
});

describe('featherRings', () => {
  it('is ordered outermost first, so stacking them ramps the alpha inward', () => {
    const rings = featherRings(POND, 100, 4);
    expect(rings.length).toBeGreaterThan(1);
    const holeArea = (index: number) => {
      const ring = rings[index]?.geometry.coordinates[1];
      return ring ? Math.abs(ring.length) : 0;
    };
    // Not a size assertion — just that every ring carries a hole to reveal through.
    for (let i = 0; i < rings.length; i++) expect(holeArea(i)).toBeGreaterThan(0);
    // The first mask's hole must contain the last one's: outermost buffer, biggest hole.
    const outer = rings[0] as { geometry: Polygon };
    const inner = rings[rings.length - 1] as { geometry: Polygon };
    const justOutside = { lat: 44.4605, lng: -73.195 };
    expect(pointInPolygon(justOutside, outer.geometry)).toBe(false);
    expect(pointInPolygon(justOutside, inner.geometry)).toBe(true);
  });

  it('composes to a fully opaque far field regardless of step count', () => {
    for (const steps of [1, 3, 6, 12]) {
      const rings = featherRings(POND, 80, steps);
      const cumulative = rings.reduce((covered, r) => covered + (1 - covered) * r.opacity, 0);
      expect(cumulative).toBeCloseTo(MASK_FILL_OPACITY, 6);
    }
  });

  it('never paints a fully opaque fill — labels would punch through it', () => {
    for (const ring of featherRings(POND, 80)) {
      expect(ring.opacity).toBeLessThan(1);
      expect(ring.opacity).toBeGreaterThan(0);
    }
  });

  it('degrades a zero feather to a single hard-edged mask', () => {
    const rings = featherRings(POND, 0);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.opacity).toBe(MASK_FILL_OPACITY);
  });

  it('returns nothing when asked for no steps, rather than a mask that reveals everything', () => {
    expect(featherRings(POND, 50, 0)).toHaveLength(0);
  });
});

describe('buildImageryMask', () => {
  it('defaults to the aerial tier and yields a shape plus its rings', () => {
    const built = buildImageryMask({ polygon: POND });
    expect(built).not.toBeNull();
    expect(built?.rings.length).toBe(FEATHER_STEPS + 1);
  });

  it("the Sentinel tier's buffers are wider, because 10 m pixels swallow the aerial ones", () => {
    // A 10 m buffer is one pixel at Sentinel's ground sample: a feather built from it is a hard edge.
    expect(SENTINEL_MASK_METERS.solid).toBeGreaterThan(AERIAL_MASK_METERS.solid);
    expect(SENTINEL_MASK_METERS.feather).toBeGreaterThan(AERIAL_MASK_METERS.feather);
    const aerial = buildImageryMask({ polygon: POND }, AERIAL_MASK_METERS);
    const sentinel = buildImageryMask({ polygon: POND }, SENTINEL_MASK_METERS);
    expect(surfaceAreaSqM(sentinel?.shape as Polygon)).toBeGreaterThan(
      surfaceAreaSqM(aerial?.shape as Polygon),
    );
  });

  it('fails closed — an unbuildable shape reveals nothing', () => {
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    expect(buildImageryMask({ polygon: empty })).toBeNull();
  });
});

describe('imageryMaskLayerId', () => {
  it('is stable and unique per ring', () => {
    const ids = new Set([0, 1, 2, 3].map(imageryMaskLayerId));
    expect(ids.size).toBe(4);
    expect(imageryMaskLayerId(0)).toBe('imagery-mask-0');
  });
});
