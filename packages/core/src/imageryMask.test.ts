import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { pointInPolygon, surfaceAreaSqM } from './geometry';
import {
  AERIAL_MASK_METERS,
  outerRingsOnly,
  revealShape,
  SENTINEL_MASK_METERS,
} from './imageryMask';

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

/** The same pond with an island in it — the case the first render decided. */
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
        approachPaths: [[parking, { lat: 44.455, lng: -73.21 }, { lat: 44.455, lng: -73.2 }]],
      },
      10,
    );
    expect(water).not.toBeNull();
    expect(withWalk).not.toBeNull();
    // The lot is off the water's own reveal and inside the one that includes the walk.
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

  it('covers an island rather than buffering around it', () => {
    // Holes are stripped before the buffer runs, so the reveal is solid across the whole lake.
    const shape = revealShape({ polygon: POND_WITH_ISLAND }, 20);
    expect(pointInPolygon({ lat: 44.455, lng: -73.195 }, shape as Polygon | MultiPolygon)).toBe(
      true,
    );
  });

  it('returns null rather than an empty shape when there is nothing to reveal', () => {
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    expect(revealShape({ polygon: empty }, 10)).toBeNull();
  });

  it("the Sentinel tier's buffers are wider, because 10 m pixels swallow the aerial ones", () => {
    expect(SENTINEL_MASK_METERS.solid).toBeGreaterThan(AERIAL_MASK_METERS.solid);
    expect(SENTINEL_MASK_METERS.feather).toBeGreaterThan(AERIAL_MASK_METERS.feather);
    const aerial = revealShape({ polygon: POND }, AERIAL_MASK_METERS.solid);
    const sentinel = revealShape({ polygon: POND }, SENTINEL_MASK_METERS.solid);
    expect(surfaceAreaSqM(sentinel as Polygon)).toBeGreaterThan(surfaceAreaSqM(aerial as Polygon));
  });
});

describe('outerRingsOnly', () => {
  it('drops holes and keeps one ring per polygon', () => {
    expect(outerRingsOnly(POND_WITH_ISLAND)).toHaveLength(1);
    expect(outerRingsOnly(POND_WITH_ISLAND)[0]).toEqual(POND.coordinates[0]);
  });

  it('keeps one ring per polygon of a multipolygon', () => {
    const two: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [POND.coordinates as number[][][], POND_WITH_ISLAND.coordinates as number[][][]],
    };
    expect(outerRingsOnly(two)).toHaveLength(2);
  });

  it('survives a polygon with no rings at all', () => {
    expect(outerRingsOnly({ type: 'Polygon', coordinates: [] })).toHaveLength(0);
  });
});
