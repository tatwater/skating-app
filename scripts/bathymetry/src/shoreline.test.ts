import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { densifyShoreline, ringsOf } from './shoreline';

/** A ~1 km square at 45°N, closed. */
const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-70, 45],
      [-69.987, 45],
      [-69.987, 45.009],
      [-70, 45.009],
      [-70, 45],
    ],
  ],
};

const WITH_ISLAND: Polygon = {
  type: 'Polygon',
  coordinates: [
    SQUARE.coordinates[0] as number[][],
    [
      [-69.995, 45.003],
      [-69.993, 45.003],
      [-69.993, 45.005],
      [-69.995, 45.005],
      [-69.995, 45.003],
    ],
  ],
};

describe('ringsOf', () => {
  it('returns the exterior ring of a simple polygon', () => {
    expect(ringsOf(SQUARE)).toHaveLength(1);
  });

  it('includes interior rings — an island has a shore too', () => {
    expect(ringsOf(WITH_ISLAND)).toHaveLength(2);
  });

  it('flattens a multipolygon across all its parts', () => {
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [SQUARE.coordinates, WITH_ISLAND.coordinates],
    };
    expect(ringsOf(multi)).toHaveLength(3);
  });
});

describe('densifyShoreline', () => {
  it('puts every point at depth zero', () => {
    for (const p of densifyShoreline(SQUARE, 100)) expect(p.depthFt).toBe(0);
  });

  it('adds points along a long segment rather than leaving it unconstrained', () => {
    // The square's sides are ~1 km. At 100 m spacing a raw-vertex shoreline would give 4 points and
    // leave the fit free to run deep right up to the beach along every side.
    const coarse = densifyShoreline(SQUARE, 100_000).length;
    const fine = densifyShoreline(SQUARE, 100).length;
    expect(coarse).toBe(4);
    expect(fine).toBeGreaterThan(30);
  });

  it('never duplicates a source vertex when densifying', () => {
    // Each segment contributes its start plus its interior points; the end belongs to the next
    // segment. A duplicated vertex is a doubled constraint at exactly the corners a spline rings at.
    const points = densifyShoreline(SQUARE, 100);
    const keys = points.map((p) => `${p.lng.toFixed(9)},${p.lat.toFixed(9)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respects the requested spacing', () => {
    const points = densifyShoreline(SQUARE, 200);
    const spacings: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      // Compare within a side only; the wrap between sides is a corner, not a spacing.
      if (a.lng !== b.lng && a.lat !== b.lat) continue;
      spacings.push(Math.hypot((b.lng - a.lng) * 78_800, (b.lat - a.lat) * 111_320));
    }
    for (const s of spacings) expect(s).toBeLessThanOrEqual(210);
  });

  it('constrains an island, so the fit cannot put a basin under dry land', () => {
    const without = densifyShoreline(SQUARE, 100).length;
    const withIsland = densifyShoreline(WITH_ISLAND, 100).length;
    expect(withIsland).toBeGreaterThan(without);
  });

  it('refuses a non-positive spacing rather than looping forever', () => {
    expect(() => densifyShoreline(SQUARE, 0)).toThrow(/positive/);
    expect(() => densifyShoreline(SQUARE, -5)).toThrow(/positive/);
  });
});
