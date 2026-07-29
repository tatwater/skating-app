import fc from 'fast-check';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { LatLng } from './geometry';
import { HAZARD_MAX_VERTICES, isValidHazardShape, polygonShape } from './hazardGeometry';
import {
  deriveShoreBand,
  offersShoreBand,
  SHORE_BAND_MAX_TAP_DISTANCE_M,
  SHORE_BAND_TYPES,
} from './shoreBand';
import { HAZARD_TYPES } from './types';

const CENTRE: LatLng = { lat: 44.4759, lng: -73.2121 }; // Burlington, VT

/**
 * A closed ring of `n` vertices on a circle of `radiusDeg` around `centre`.
 *
 * A circle stands in for a shoreline well enough for the properties under test: the arithmetic here
 * is about walking a ring, not about the shape of any particular lake.
 */
function circleRing(n: number, radiusDeg: number, centre: LatLng = CENTRE): Position[] {
  const ring: Position[] = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [centre.lng + radiusDeg * Math.cos(a), centre.lat + radiusDeg * Math.sin(a)];
  });
  return [...ring, ring[0] as Position];
}

function ringPoint(ring: Position[], i: number): LatLng {
  const [lng = 0, lat = 0] = ring[i] as Position;
  return { lat, lng };
}

/** A lake with an island in it — two rings, which is where "refuse rather than guess" earns its keep. */
const OUTER = circleRing(64, 0.02);
const ISLAND = circleRing(16, 0.003);
const LAKE_WITH_ISLAND: Polygon = { type: 'Polygon', coordinates: [OUTER, ISLAND] };
const SIMPLE_LAKE: Polygon = { type: 'Polygon', coordinates: [OUTER] };

const EAST = circleRing(48, 0.01, { lat: 44.4759, lng: -73.15 });
const TWO_LOBES: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [[OUTER], [EAST]],
};

describe('deriveShoreBand', () => {
  it('turns two taps near the shore into a storable polygon', () => {
    const result = deriveShoreBand(SIMPLE_LAKE, ringPoint(OUTER, 4), ringPoint(OUTER, 10), {
      halfWidthMeters: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole point of Decision 3: what comes out is an ordinary polygon draft, and nothing
    // downstream can tell it was snapped.
    expect(isValidHazardShape(polygonShape(result.band.vertices, 10))).toBe(true);
    expect(result.band.arcLengthMeters).toBeGreaterThan(0);
  });

  it('takes the shorter way round by default', () => {
    // Vertices 4 and 10 of a 64-gon: six steps one way, fifty-eight the other.
    const result = deriveShoreBand(SIMPLE_LAKE, ringPoint(OUTER, 4), ringPoint(OUTER, 10), {
      halfWidthMeters: 10,
    });
    expect(result.ok && result.band.arc).toHaveLength(7);
  });

  it('takes the long way round when asked, and the two arcs partition the ring', () => {
    const opts = { halfWidthMeters: 10 };
    const short = deriveShoreBand(SIMPLE_LAKE, ringPoint(OUTER, 4), ringPoint(OUTER, 10), opts);
    const long = deriveShoreBand(SIMPLE_LAKE, ringPoint(OUTER, 4), ringPoint(OUTER, 10), {
      ...opts,
      theOtherWay: true,
    });
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    expect(long.band.theOtherWay).toBe(true);
    // Together the two arcs walk every vertex, and share exactly the two the skater tapped.
    expect(short.band.arc.length + long.band.arc.length).toBe(64 + 2);
    expect(long.band.arcLengthMeters).toBeGreaterThan(short.band.arcLengthMeters);
  });

  // The N2 clip-refusal spirit: there is no arc along "the boundary" between an island's shore and
  // the mainland's, only a shape we would have to invent.
  it('refuses two taps that land on different rings of one polygon', () => {
    const result = deriveShoreBand(LAKE_WITH_ISLAND, ringPoint(OUTER, 4), ringPoint(ISLAND, 2), {
      halfWidthMeters: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'different_rings' });
  });

  it('refuses two taps on different parts of a MultiPolygon, and accepts two on one part', () => {
    expect(
      deriveShoreBand(TWO_LOBES, ringPoint(OUTER, 4), ringPoint(EAST, 4), { halfWidthMeters: 10 }),
    ).toEqual({ ok: false, reason: 'different_rings' });
    expect(
      deriveShoreBand(TWO_LOBES, ringPoint(EAST, 2), ringPoint(EAST, 8), { halfWidthMeters: 10 })
        .ok,
    ).toBe(true);
  });

  it('happily snaps along an island’s own shore', () => {
    // Refusing *mixed* rings must not become refusing the inner ring — an island's shoreline is a
    // shoreline, and thin ice along it is exactly the hazard this affordance is for.
    const result = deriveShoreBand(LAKE_WITH_ISLAND, ringPoint(ISLAND, 1), ringPoint(ISLAND, 5), {
      halfWidthMeters: 10,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a tap that isn’t near any shore', () => {
    // Without the bound, a tap in the middle of the lake snaps silently to whichever shore happens
    // to be nearest and hands back a band nowhere near what was pointed at.
    const result = deriveShoreBand(SIMPLE_LAKE, CENTRE, ringPoint(OUTER, 4), {
      halfWidthMeters: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'tap_off_shore' });
  });

  it('accepts a sloppy tap within the tolerance', () => {
    const near = ringPoint(OUTER, 4);
    // ~0.001° of latitude is ~111 m — well inside the tolerance, well outside "precise".
    const sloppy = { lat: near.lat + 0.001, lng: near.lng };
    expect(SHORE_BAND_MAX_TAP_DISTANCE_M).toBeGreaterThan(111);
    expect(
      deriveShoreBand(SIMPLE_LAKE, sloppy, ringPoint(OUTER, 12), { halfWidthMeters: 10 }).ok,
    ).toBe(true);
  });

  it('refuses two taps that resolve to the same shoreline vertex', () => {
    const p = ringPoint(OUTER, 4);
    expect(deriveShoreBand(SIMPLE_LAKE, p, p, { halfWidthMeters: 10 })).toEqual({
      ok: false,
      reason: 'degenerate_arc',
    });
  });

  it('refuses a body with no usable boundary rather than throwing', () => {
    expect(
      deriveShoreBand({ type: 'Polygon', coordinates: [] }, CENTRE, CENTRE, {
        halfWidthMeters: 10,
      }),
    ).toEqual({ ok: false, reason: 'no_boundary' });
  });

  // The reason `simplifyPath` exists here: a real shoreline is arbitrarily detailed, and detail is
  // exactly what a fuzzy hazard footprint must not claim to have — nor pay the vertex cap for.
  it('simplifies a dense shoreline until the band fits under the vertex cap', () => {
    const dense: Polygon = { type: 'Polygon', coordinates: [circleRing(4000, 0.05)] };
    const ring = dense.coordinates[0] as Position[];
    const result = deriveShoreBand(dense, ringPoint(ring, 0), ringPoint(ring, 3000), {
      halfWidthMeters: 15,
      theOtherWay: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.band.arc.length).toBeGreaterThan(HAZARD_MAX_VERTICES);
    expect(result.band.vertices.length).toBeLessThan(HAZARD_MAX_VERTICES);
    expect(isValidHazardShape(polygonShape(result.band.vertices, 15))).toBe(true);
  });

  it('either refuses or produces a storable shape — never a throw, never an invalid one (property)', () => {
    const arbTap: fc.Arbitrary<LatLng> = fc.record({
      lat: fc.double({ min: CENTRE.lat - 0.03, max: CENTRE.lat + 0.03, noNaN: true }),
      lng: fc.double({ min: CENTRE.lng - 0.03, max: CENTRE.lng + 0.03, noNaN: true }),
    });
    fc.assert(
      fc.property(
        arbTap,
        arbTap,
        fc.constantFrom(2, 4, 8, 15, 25, 40, 60),
        fc.boolean(),
        (a, b, halfWidthMeters, theOtherWay) => {
          const result = deriveShoreBand(LAKE_WITH_ISLAND, a, b, {
            halfWidthMeters,
            theOtherWay,
          });
          if (!result.ok) return;
          expect(isValidHazardShape(polygonShape(result.band.vertices, halfWidthMeters))).toBe(
            true,
          );
        },
      ),
    );
  });
});

describe('SHORE_BAND_TYPES', () => {
  it('names only real hazard types', () => {
    // The correction this phase opened with: the plan named `thin_ice_shore` and `ice_edge`, which
    // are descriptions in research §4 and not values in the vocabulary.
    for (const type of SHORE_BAND_TYPES) {
      expect(HAZARD_TYPES as readonly string[]).toContain(type);
    }
  });

  it('offers the affordance to the shore-shaped types and nothing else', () => {
    expect(offersShoreBand('thin_ice')).toBe(true);
    expect(offersShoreBand('open_water')).toBe(true);
    // A ridge is linear, but it is not *shore*-shaped — snapping one to a shoreline would be
    // offering the wrong geometry, confidently.
    expect(offersShoreBand('pressure_ridge')).toBe(false);
    expect(offersShoreBand('drilled_hole')).toBe(false);
  });
});
