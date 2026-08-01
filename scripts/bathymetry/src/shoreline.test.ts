import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  areaSquareMeters,
  characteristicLengthM,
  densifyShoreline,
  perimeterMeters,
  ringsOf,
  shoreSpacingFor,
} from './shoreline';

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

describe('perimeterMeters', () => {
  it('sums every ring, islands included — an island has a shore too', () => {
    const withIsland: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.0, 44.0],
          [-71.99, 44.0],
          [-71.99, 44.01],
          [-72.0, 44.01],
          [-72.0, 44.0],
        ],
        [
          [-71.996, 44.004],
          [-71.994, 44.004],
          [-71.994, 44.006],
          [-71.996, 44.006],
          [-71.996, 44.004],
        ],
      ],
    };
    const outerOnly: Polygon = {
      type: 'Polygon',
      coordinates: [withIsland.coordinates[0] as number[][]],
    };
    expect(perimeterMeters(withIsland)).toBeGreaterThan(perimeterMeters(outerOnly));
  });

  it('is zero for a degenerate ring rather than NaN', () => {
    expect(perimeterMeters({ type: 'Polygon', coordinates: [[]] })).toBe(0);
  });
});

describe('shoreSpacingFor', () => {
  const base = { perimeterM: 12_875, cellSizeM: 14, maskRadiusM: 514 };

  it('budgets the shore against the SOUNDINGS, not against the lake size', () => {
    // Washington Pond: 105 soundings against a 12.9 km perimeter. Sampled at one grid cell the shore
    // filled 1,409 cells to the soundings' 105 — a surface fitted 93% to its own outline.
    const sparse = shoreSpacingFor({ ...base, soundingCells: 105 });
    const dense = shoreSpacingFor({ ...base, soundingCells: 20_000 });
    expect(sparse).toBeGreaterThan(dense);
    expect(base.perimeterM / sparse).toBeLessThan(400);
  });

  it('never spaces wider than the mask can bridge, which is the original objection', () => {
    // A shore coarser than the interpolation mask cuts its own contours in water the fit knows.
    const spacing = shoreSpacingFor({ ...base, perimeterM: 5_000_000, soundingCells: 1 });
    expect(spacing).toBeLessThanOrEqual(base.maskRadiusM / 2);
  });

  it('never spaces finer than a grid cell, where the extra points buy nothing', () => {
    // `blockmedian` collapses them anyway; they only cost time.
    const spacing = shoreSpacingFor({ ...base, perimeterM: 100, soundingCells: 500_000 });
    expect(spacing).toBeGreaterThanOrEqual(base.cellSizeM);
  });

  it('holds a floor on shore points so the contours still close', () => {
    // Below roughly 120 points the outline stops being a boundary condition and nothing nests.
    const spacing = shoreSpacingFor({ ...base, soundingCells: 2 });
    expect(base.perimeterM / spacing).toBeGreaterThanOrEqual(100);
  });

  it('survives a lake with no perimeter', () => {
    expect(shoreSpacingFor({ ...base, perimeterM: 0, soundingCells: 10 })).toBeGreaterThan(0);
  });
});

describe('areaSquareMeters', () => {
  it('measures a simple polygon', () => {
    // SQUARE is ~1 km on a side at 45N.
    const area = areaSquareMeters(SQUARE);
    expect(area).toBeGreaterThan(900_000);
    expect(area).toBeLessThan(1_200_000);
  });

  it('SUBTRACTS interior rings — a lake with islands is smaller than its outline', () => {
    // `ringsOf` flattens every ring, which is right for the shoreline constraint (an island's bank is
    // a depth-0 boundary too) and wrong here: using it would ADD the island instead of removing it.
    const outer = SQUARE.coordinates[0] as number[][];
    const withIsland: Polygon = {
      type: 'Polygon',
      coordinates: [
        outer,
        [
          [-72.0, 45.0],
          [-71.998, 45.0],
          [-71.998, 45.002],
          [-72.0, 45.002],
          [-72.0, 45.0],
        ],
      ],
    };
    expect(areaSquareMeters(withIsland)).toBeLessThan(areaSquareMeters(SQUARE));
  });

  it('never returns a negative area', () => {
    expect(areaSquareMeters({ type: 'Polygon', coordinates: [[]] })).toBe(0);
  });
});

describe('characteristicLengthM', () => {
  it('is the side of the equivalent square', () => {
    expect(characteristicLengthM(SQUARE)).toBeCloseTo(Math.sqrt(areaSquareMeters(SQUARE)), 6);
  });

  it('does not reward elongation the way a bbox diagonal does', () => {
    // The bias being fixed: a long thin lake was handed a denominator up to 4x larger than a round
    // lake of the same area, and therefore that much easier a pass on the density gate.
    const thin: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.0, 45.0],
          [-71.9, 45.0],
          [-71.9, 45.001],
          [-72.0, 45.001],
          [-72.0, 45.0],
        ],
      ],
    };
    const fat: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.0, 45.0],
          [-71.99, 45.0],
          [-71.99, 45.01],
          [-72.0, 45.01],
          [-72.0, 45.0],
        ],
      ],
    };
    // Same order of area, wildly different aspect — the characteristic lengths should be close.
    const ratio = characteristicLengthM(thin) / characteristicLengthM(fat);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(3);
  });
});
