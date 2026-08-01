import { describe, expect, it } from 'vitest';
import {
  compressedCloud,
  GRID_CELLS,
  gridPlan,
  localBounds,
  metresPerLngDegree,
  spanDegrees,
} from './grid';
import { compressAlong, expandAlong, principalFrame, toLocal } from './thalweg';

/** Parse a GMT `-R` back into numbers, so assertions read as geometry rather than as string diffs. */
function parseRegion(region: string): [number, number, number, number] {
  const parts = region.slice(2).split('/').map(Number);
  return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] as number];
}

describe('localBounds', () => {
  it('brackets the cloud', () => {
    const b = localBounds([
      { along: -10, across: 3 },
      { along: 40, across: -7 },
      { along: 5, across: 1 },
    ]);
    expect(b).toEqual({ minAlong: -10, maxAlong: 40, minAcross: -7, maxAcross: 3 });
  });
});

describe('spanDegrees', () => {
  it('takes the wider of the two axes', () => {
    expect(
      spanDegrees([
        { lng: -72, lat: 44 },
        { lng: -71.9, lat: 44.5 },
      ]),
    ).toBeCloseTo(0.5, 10);
  });

  it('is zero for an empty cloud rather than infinite', () => {
    expect(spanDegrees([])).toBe(0);
  });
});

describe('gridPlan', () => {
  const cloud = [
    { along: -1000, across: -200 },
    { along: 1000, across: 200 },
  ];

  it('expands the real region by exactly the ratio, on both ends of the along axis only', () => {
    // The bug this exists to catch: applying the factor to one end, or to the wrong axis, stretches
    // every lake in the corpus by 2–4× in a way that looks entirely plausible in a thumbnail.
    const plan = gridPlan(cloud, 4);
    const [solveLo, solveHi, solveDown, solveUp] = parseRegion(plan.region);
    const [realLo, realHi, realDown, realUp] = parseRegion(plan.realRegion);

    expect(realLo).toBeCloseTo(solveLo * 4, 6);
    expect(realHi).toBeCloseTo(solveHi * 4, 6);
    // The across axis was never compressed, so it must come back untouched.
    expect(realDown).toBe(solveDown);
    expect(realUp).toBe(solveUp);
  });

  it('leaves the region alone at ratio 1', () => {
    const plan = gridPlan(cloud, 1);
    expect(parseRegion(plan.realRegion)).toEqual(parseRegion(plan.region));
  });

  it('snaps both axes to a whole number of cells, which is what GMT actually requires', () => {
    // `blockmedian` refuses a region that is not (NX + eps) * x_inc, and a padded bbox almost never
    // is — the pad is a fraction of the LONG side, so the short axis lands mid-cell. Two of
    // twenty-five real lakes failed here after twenty-three drew correctly.
    for (const shape of [
      [
        { along: -1000, across: -200 },
        { along: 1000, across: 200 },
      ],
      [
        { along: -37.3, across: -1119.7 },
        { along: 4211.9, across: 903.1 },
      ],
      [
        { along: 0, across: 0 },
        { along: 1, across: 1 },
      ],
    ]) {
      for (const ratio of [1, 2.5, 4]) {
        const plan = gridPlan(shape, ratio);
        const inc = Number(plan.increment.slice(2));
        const [lo, hi, down, up] = parseRegion(plan.region);
        const nx = (hi - lo) / inc;
        const ny = (up - down) / inc;
        expect(Math.abs(nx - Math.round(nx))).toBeLessThan(1e-4);
        expect(Math.abs(ny - Math.round(ny))).toBeLessThan(1e-4);
      }
    }
  });

  it('snaps outward, never cropping a measurement out of the solve', () => {
    const plan = gridPlan(cloud, 1);
    const [lo, hi, down, up] = parseRegion(plan.region);
    expect(lo).toBeLessThanOrEqual(-1000);
    expect(hi).toBeGreaterThanOrEqual(1000);
    expect(down).toBeLessThanOrEqual(-200);
    expect(up).toBeGreaterThanOrEqual(200);
  });

  it('pads the region so the cloud is strictly inside it', () => {
    const [lo, hi, down, up] = parseRegion(gridPlan(cloud, 1).region);
    expect(lo).toBeLessThan(-1000);
    expect(hi).toBeGreaterThan(1000);
    expect(down).toBeLessThan(-200);
    expect(up).toBeGreaterThan(200);
  });

  it('makes a square cell in the COMPRESSED frame, which is what reaches the solver', () => {
    const plan = gridPlan(cloud, 4);
    const increment = Number(plan.increment.slice(2));
    // Long side is 2000 compressed units; 500 cells across it.
    expect(increment).toBeCloseTo(2000 / GRID_CELLS, 6);
  });

  it('carries the ratio into the filter width but not into the increment', () => {
    // The filter runs AFTER grdedit, so it measures real metres; the increment runs before, so it
    // measures compressed ones. Miss this and the Gaussian is 4x too narrow along the axis — which
    // does not fail, it just stops removing the artifact it exists to remove.
    const isotropic = gridPlan(cloud, 1);
    const anisotropic = gridPlan(cloud, 4);
    expect(anisotropic.filterWidthM).toBeCloseTo(isotropic.filterWidthM * 4, 6);
    expect(anisotropic.increment).toBe(isotropic.increment);
  });

  it('sizes the mask in compressed units, from the gate ratio', () => {
    const plan = gridPlan(cloud, 1, { maxGapRatio: 0.1 });
    expect(plan.maskRadius).toBeCloseTo(2000 * 0.1, 6);
  });

  it('honours the tunables it is given', () => {
    const plan = gridPlan(cloud, 1, { gridCells: 100, smoothCells: 5 });
    expect(Number(plan.increment.slice(2))).toBeCloseTo(2000 / 100, 6);
    expect(plan.filterWidthM).toBeCloseTo((2000 / 100) * 5, 6);
  });

  it('keeps the shoreline spacing at roughly one real cell', () => {
    // A 20 km lake: 500 cells across it puts a shoreline constraint every 40 m.
    const big = [
      { along: -10_000, across: -2_000 },
      { along: 10_000, across: 2_000 },
    ];
    expect(gridPlan(big, 1).shoreSpacingM).toBeCloseTo(20_000 / GRID_CELLS, 6);
  });

  it('floors the shoreline spacing at 5 m, so a small pond is not over-constrained', () => {
    // Below the floor a 2 km lake asks for 4 m and a farm pond for centimetres, which would put more
    // zero-depth constraints around the bank than the survey has readings in the water.
    expect(2000 / GRID_CELLS).toBeLessThan(5);
    expect(gridPlan(cloud, 1).shoreSpacingM).toBe(5);
    const tiny = [
      { along: -1, across: -1 },
      { along: 1, across: 1 },
    ];
    expect(gridPlan(tiny, 1).shoreSpacingM).toBe(5);
  });
});

describe('compressedCloud', () => {
  const points = [
    { lng: -72.0, lat: 44.0, depthFt: 30 },
    { lng: -71.98, lat: 44.02, depthFt: 50 },
    { lng: -71.96, lat: 44.04, depthFt: 20 },
  ];

  it('pins every shoreline vertex at zero and keeps every sounding depth', () => {
    const frame = principalFrame(points);
    const cloud = compressedCloud(points, [{ lng: -72.01, lat: 43.99 }], frame, 2);
    expect(cloud).toHaveLength(4);
    expect(cloud.slice(0, 3).map((c) => c.depthFt)).toEqual([30, 50, 20]);
    expect(cloud[3]?.depthFt).toBe(0);
  });

  it('round-trips through the inverse compression back to the original coordinate', () => {
    // The transform that, mismatched, stretches the whole corpus by a factor nobody would spot.
    const frame = principalFrame(points);
    const ratio = 3;
    const cloud = compressedCloud(points, [], frame, ratio);
    for (const [i, compressed] of cloud.entries()) {
      const original = toLocal(points[i] as { lng: number; lat: number }, frame);
      const back = expandAlong(compressed, ratio);
      expect(back.along).toBeCloseTo(original.along, 6);
      expect(back.across).toBeCloseTo(original.across, 6);
    }
  });

  it('compresses along the axis and leaves across untouched', () => {
    const frame = principalFrame(points);
    const local = toLocal(points[1] as { lng: number; lat: number }, frame);
    const compressed = compressAlong(local, 4);
    expect(compressed.along).toBeCloseTo(local.along / 4, 9);
    expect(compressed.across).toBe(local.across);
  });
});

describe('metresPerLngDegree', () => {
  it('shrinks with latitude', () => {
    expect(metresPerLngDegree(0)).toBeCloseTo(111_320, 0);
    expect(metresPerLngDegree(44)).toBeLessThan(metresPerLngDegree(0));
    // ~0.72 of a degree of latitude at our region's centre — the factor whose omission squashed every
    // lake horizontally by 28%.
    expect(metresPerLngDegree(44) / 111_320).toBeCloseTo(0.719, 2);
  });
});
