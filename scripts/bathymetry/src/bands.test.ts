import { DEPTH_BAND_EDGES_FT } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  BAND_MAX_CELLS,
  BAND_MIN_CELLS,
  BAND_PAD_CELLS,
  bandForLowerBound,
  bandGrid,
  bandPlan,
  boundsOf,
  densify,
  distanceToRing,
  dropSpecks,
  frameFor,
  gmtRegion,
  isClosedRing,
  isDegenerateLine,
  isobandLevels,
  outsideProbes,
  pointInRing,
  type Ring,
  ringSeedDirection,
  seedDepth,
  seedLattice,
  signedArea,
  toLngLat,
  toXY,
  type XY,
} from './bands';

/** A closed axis-aligned square, counter-clockwise. */
function square(x0: number, y0: number, size: number): Ring {
  return [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
    { x: x0, y: y0 },
  ];
}

describe('bandPlan', () => {
  it('lands each ramp edge on the shallowest contour at or below it (Mascoma, NH 10 ft lines)', () => {
    const plan = bandPlan([10, 20, 30, 40, 50, 60, 70]);
    // 5 → 10 and 10 → 10 collapse; 45 → 50. No line is invented at 5 or 45 ft.
    expect(plan.boundaries).toEqual([10, 20, 30, 50, 70]);
    expect(plan.bands).toEqual([
      { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 },
      { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 },
      { bandIndex: 3, minDepthFt: 20, maxDepthFt: 30 },
      { bandIndex: 4, minDepthFt: 30, maxDepthFt: 50 },
      { bandIndex: 5, minDepthFt: 50, maxDepthFt: 70 },
      { bandIndex: 6, minDepthFt: 70 },
    ]);
  });

  it('uses every ramp edge on a lake contoured on the 5 ft ladder', () => {
    const levels = Array.from({ length: 20 }, (_, i) => (i + 1) * 5);
    const plan = bandPlan(levels);
    expect(plan.boundaries).toEqual([...DEPTH_BAND_EDGES_FT.slice(1)]);
    expect(plan.bands.map((b) => b.bandIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('stops at the deepest contour, leaving the deepest band open-ended', () => {
    const plan = bandPlan([5, 10, 15, 20, 25]);
    expect(plan.boundaries).toEqual([5, 10, 20]);
    expect(plan.bands.at(-1)).toEqual({ bandIndex: 3, minDepthFt: 20 });
  });

  it('gives a lake with nothing past 5 ft no boundaries at all', () => {
    expect(bandPlan([2, 3, 4]).boundaries).toEqual([]);
    expect(bandPlan([]).bands).toEqual([{ bandIndex: 0, minDepthFt: 0 }]);
  });

  it('ignores order, duplicates and depths that are not depths', () => {
    expect(bandPlan([30, 10, Number.NaN, 10, -5, 0, 20]).boundaries).toEqual([10, 20, 30]);
  });

  it('never colors a band deeper than its shallowest water', () => {
    for (const levels of [
      [7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77],
      [12, 24, 36, 48, 60, 72],
    ]) {
      for (const band of bandPlan(levels).bands) {
        expect(DEPTH_BAND_EDGES_FT[band.bandIndex]).toBeLessThanOrEqual(band.minDepthFt);
      }
    }
  });
});

describe('isobandLevels / bandForLowerBound', () => {
  const plan = bandPlan([10, 20, 30]);

  it('puts a sentinel either side, so the shore and deepest bands are traced', () => {
    const levels = isobandLevels(plan);
    expect(levels[0]).toBeLessThan(0);
    expect(levels.slice(1, -1)).toEqual([10, 20, 30]);
    expect(levels.at(-1)).toBeGreaterThan(10_000);
  });

  it('maps a traced interval back to its band by its lower bound', () => {
    expect(bandForLowerBound(-1, plan)).toEqual(plan.bands[0]);
    expect(bandForLowerBound(10, plan)).toEqual(plan.bands[1]);
    expect(bandForLowerBound(30.0000000001, plan)).toEqual(plan.bands[3]);
    expect(bandForLowerBound(15, plan)).toBeUndefined();
  });

  it('hands everything to the shore band on a plan with no boundaries', () => {
    const empty = bandPlan([]);
    expect(bandForLowerBound(-1, empty)).toEqual(empty.bands[0]);
  });
});

describe('the local frame', () => {
  it('round-trips lng/lat exactly', () => {
    const frame = frameFor([
      [-72.2, 43.6],
      [-72.1, 43.7],
    ]);
    const p = [-72.13, 43.66];
    const back = toLngLat(toXY(p, frame), frame);
    expect(back[0]).toBeCloseTo(p[0] as number, 10);
    expect(back[1]).toBeCloseTo(p[1] as number, 10);
  });

  it('is metric: a degree of latitude is ~111 km, a degree of longitude shrinks with latitude', () => {
    const frame = frameFor([[-72, 43.65]]);
    expect(toXY([-72, 44.65], frame).y).toBeCloseTo(111_320, 0);
    const east = toXY([-71, 43.65], frame).x;
    expect(east).toBeGreaterThan(80_000);
    expect(east).toBeLessThan(81_000);
  });

  it('refuses an empty set rather than centering on NaN', () => {
    expect(() => frameFor([])).toThrow();
  });
});

describe('bandGrid', () => {
  it('aims for 5 m cells on a mid-sized lake, padded and snapped to whole cells', () => {
    const grid = bandGrid({ xmin: 0, xmax: 2000, ymin: 0, ymax: 1000 });
    expect(grid.cellM).toBe(5);
    expect(grid.xmin).toBe(-BAND_PAD_CELLS * 5);
    expect(grid.ymax).toBe(1000 + BAND_PAD_CELLS * 5);
    expect(gmtRegion(grid)).toEqual({ region: '-R-15/2015/-15/1015', increment: '-I5' });
  });

  it('floors the cell count on a pond and caps it on a big lake', () => {
    expect(500 / bandGrid({ xmin: 0, xmax: 500, ymin: 0, ymax: 10 }).cellM).toBeCloseTo(
      BAND_MIN_CELLS,
    );
    expect(100_000 / bandGrid({ xmin: 0, xmax: 10, ymin: 0, ymax: 100_000 }).cellM).toBeCloseTo(
      BAND_MAX_CELLS,
    );
  });

  it('refuses a zero-extent lake', () => {
    expect(() => bandGrid({ xmin: 1, xmax: 1, ymin: 1, ymax: 1 })).toThrow();
  });

  it('bounds a point set', () => {
    expect(
      boundsOf([
        { x: 3, y: -1 },
        { x: -2, y: 4 },
      ]),
    ).toEqual({ xmin: -2, xmax: 3, ymin: -1, ymax: 4 });
  });
});

describe('line geometry', () => {
  it('densifies so no gap exceeds the spacing, keeping the original vertices', () => {
    const out = densify(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 1 },
      ],
      3,
    );
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out.at(-1)).toEqual({ x: 10, y: 1 });
    for (let i = 1; i < out.length; i += 1) {
      const a = out[i - 1] as XY;
      const b = out[i] as XY;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(3);
    }
    expect(() => densify([], 0)).toThrow();
  });

  it('calls a line with no length degenerate', () => {
    expect(isDegenerateLine([])).toBe(true);
    expect(isDegenerateLine([{ x: 1, y: 1 }])).toBe(true);
    expect(
      isDegenerateLine([
        { x: 1, y: 1 },
        { x: 1, y: 1 },
      ]),
    ).toBe(true);
    expect(
      isDegenerateLine([
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ]),
    ).toBe(false);
  });

  it('knows a closed ring from an open line', () => {
    expect(isClosedRing(square(0, 0, 1))).toBe(true);
    expect(isClosedRing(square(0, 0, 1).slice(0, 4))).toBe(false);
    expect(
      isClosedRing([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ]),
    ).toBe(false);
  });

  it('measures signed area, positive counter-clockwise', () => {
    expect(signedArea(square(0, 0, 2))).toBe(4);
    expect(signedArea([...square(0, 0, 2)].reverse())).toBe(-4);
  });

  it('tests containment and distance against a ring', () => {
    const ring = square(0, 0, 10);
    expect(pointInRing({ x: 5, y: 5 }, ring)).toBe(true);
    expect(pointInRing({ x: 15, y: 5 }, ring)).toBe(false);
    expect(distanceToRing({ x: 5, y: 2 }, ring)).toBe(2);
    expect(distanceToRing({ x: 13, y: 14 }, ring)).toBe(5);
  });
});

describe('pits and shoals', () => {
  it('probes outward whichever way the ring winds', () => {
    for (const ring of [square(0, 0, 10), [...square(0, 0, 10)].reverse()]) {
      const probes = outsideProbes(ring, 1);
      expect(probes).toHaveLength(4);
      for (const p of probes) expect(pointInRing(p, ring)).toBe(false);
      expect(probes.every((p) => Math.abs(distanceToRing(p, ring) - 1) < 1e-9)).toBe(true);
    }
  });

  it('skips a zero-length segment rather than probing NaN', () => {
    const ring = [{ x: 0, y: 0 }, { x: 0, y: 0 }, ...square(0, 0, 10).slice(1)];
    expect(outsideProbes(ring, 1).every((p) => Number.isFinite(p.x))).toBe(true);
  });

  it('reads a pit from shallower water outside, a shoal from deeper', () => {
    expect(ringSeedDirection(20, [14, 15, 19, 21])).toBe(1);
    expect(ringSeedDirection(10, [12, 15, 11, 9])).toBe(-1);
  });

  it('declines to guess on a tie, all-NaN probes, or a surface flat at the level', () => {
    expect(ringSeedDirection(20, [19, 21])).toBe(0);
    expect(ringSeedDirection(20, [Number.NaN, Number.NaN])).toBe(0);
    expect(ringSeedDirection(20, [20, 20.0001])).toBe(0);
  });

  it('seeds half a foot past the level, never above the surface', () => {
    expect(seedDepth(20, 1)).toBe(20.5);
    expect(seedDepth(20, -1)).toBe(19.5);
    expect(seedDepth(0.2, -1)).toBe(0);
  });

  it('keeps seeds clear of the line on a ring with room', () => {
    const ring = square(0, 0, 100);
    const seeds = seedLattice(ring, 10, 15);
    expect(seeds.length).toBeGreaterThan(20);
    for (const s of seeds) {
      expect(pointInRing(s, ring)).toBe(true);
      expect(distanceToRing(s, ring)).toBeGreaterThanOrEqual(15);
    }
  });

  it('falls back to the pole on a ring too small for the clearance', () => {
    const seeds = seedLattice(square(0, 0, 20), 10, 50);
    expect(seeds).toHaveLength(1);
    expect(distanceToRing(seeds[0] as XY, square(0, 0, 20))).toBe(5);
  });

  it('falls back to the vertex average on a ring smaller than one lattice step', () => {
    expect(seedLattice(square(0, 0, 2), 10, 5)).toEqual([{ x: 1, y: 1 }]);
    expect(() => seedLattice(square(0, 0, 2), 0, 5)).toThrow();
  });

  it('seeds nothing when even the vertex average is outside the ring', () => {
    // A thin "C": its vertex average sits in the mouth, off the ring.
    const c: Ring = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 0.2 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 2.8 },
      { x: 3, y: 2.8 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
      { x: 0, y: 0 },
    ];
    expect(seedLattice(c, 10, 5)).toEqual([]);
  });
});

describe('dropSpecks', () => {
  it('drops a speck and the matching hole together, so the bands still tile', () => {
    const big: Ring[] = [square(0, 0, 100), square(40, 40, 1)];
    const speck: Ring[] = [square(40, 40, 1)];
    const { polygons, dropped } = dropSpecks([big, speck], 2);
    expect(dropped).toBe(2);
    expect(polygons).toEqual([[square(0, 0, 100)]]);
  });

  it('keeps holes and polygons above the threshold, and drops malformed rings', () => {
    const lake: Ring[] = [square(0, 0, 100), square(10, 10, 10)];
    const { polygons, dropped } = dropSpecks([lake, [square(0, 0, 1).slice(0, 3)], []], 2);
    expect(polygons).toEqual([lake]);
    expect(dropped).toBe(1);
  });
});
