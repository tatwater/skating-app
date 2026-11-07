import type { MultiPolygon, Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  BAND_LIMITS,
  type BandCheck,
  bandVerdict,
  type CheckedBand,
  checkBands,
  IndexedArea,
  orderingErrors,
  rangeHolds,
  sampleVertices,
} from './bandCheck';

/** A closed square ring in lng/lat, `size` degrees on a side, counter-clockwise. */
function sq(lng: number, lat: number, size: number): Position[] {
  return [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ];
}

const LNG = -72;
const LAT = 43.6;

/**
 * An island lake: a 0.01° square of water with a small island in its shallows, a 10 ft contour
 * around the middle and a 20 ft one around the deepest part.
 *
 *   lake      [0, 0.01]²   minus island [0.001, 0.002]²
 *   ≥ 10 ft   [0.003, 0.007]²
 *   ≥ 20 ft   [0.004, 0.006]²
 */
const lake: Polygon = {
  type: 'Polygon',
  coordinates: [sq(LNG, LAT, 0.01), sq(LNG + 0.001, LAT + 0.001, 0.001)],
};
const ten = sq(LNG + 0.003, LAT + 0.003, 0.004);
const twenty = sq(LNG + 0.004, LAT + 0.004, 0.002);
const lines = [
  { depthFt: 10, coordinates: ten },
  { depthFt: 20, coordinates: twenty },
];

function multi(...polygons: Position[][][]): MultiPolygon {
  return { type: 'MultiPolygon', coordinates: polygons };
}

const goodBands: CheckedBand[] = [
  {
    spec: { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 },
    // The shore band holds the island as a hole of its own — the island is not water.
    geometry: multi([sq(LNG, LAT, 0.01), sq(LNG + 0.001, LAT + 0.001, 0.001), ten]),
  },
  { spec: { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 }, geometry: multi([ten, twenty]) },
  { spec: { bandIndex: 3, minDepthFt: 20 }, geometry: multi([twenty]) },
];

function failuresOf(bands: CheckedBand[], withLines = lines): string[] {
  return bandVerdict(checkBands({ lake, bands, lines: withLines }));
}

describe('IndexedArea', () => {
  it('subtracts holes and unions parts', () => {
    const area = new IndexedArea(lake);
    expect(area.contains([LNG + 0.005, LAT + 0.005])).toBe(true);
    expect(area.contains([LNG + 0.0015, LAT + 0.0015])).toBe(false); // on the island
    expect(area.contains([LNG + 0.02, LAT + 0.005])).toBe(false);
    const two = new IndexedArea(multi([sq(0, 0, 1)], [sq(5, 5, 1)]));
    expect(two.contains([5.5, 5.5])).toBe(true);
    expect(two.contains([3, 3])).toBe(false);
    expect(two.bounds()).toEqual({ xmin: 0, xmax: 6, ymin: 0, ymax: 6 });
  });

  it('agrees with a brute-force even-odd test on a ring with many vertices', () => {
    const ring: Position[] = [];
    for (let i = 0; i <= 720; i += 1) {
      const t = (i / 720) * 2 * Math.PI;
      const r = 1 + 0.3 * Math.sin(7 * t);
      ring.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    ring[720] = ring[0] as Position;
    const area = new IndexedArea({ type: 'Polygon', coordinates: [ring] });
    for (let x = -1.4; x <= 1.4; x += 0.07) {
      for (let y = -1.4; y <= 1.4; y += 0.07) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
          const [ax, ay] = ring[i] as [number, number];
          const [bx, by] = ring[j] as [number, number];
          if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
        }
        expect(area.contains([x, y])).toBe(inside);
      }
    }
  });
});

describe('checkBands on an island lake', () => {
  it('passes bands that tile the water, in depth order, agreeing with their lines', () => {
    const check = checkBands({ lake, bands: goodBands, lines });
    expect(check.inside).toBeGreaterThan(3000);
    expect(check.coveredOnce).toBe(check.inside);
    expect(check.overlapped).toBe(0);
    expect(check.spilled).toBe(0);
    expect(check.areaRatio).toBeCloseTo(1, 6);
    expect(check.lineVertices).toBe(10);
    expect(check.lineAgree).toBe(10);
    expect(check.ordering).toEqual([]);
    expect(bandVerdict(check)).toEqual([]);
  });

  it('fails a shore band that paints over the island', () => {
    const [shore, ...rest] = goodBands;
    const noHole: CheckedBand = {
      spec: (shore as CheckedBand).spec,
      geometry: multi([sq(LNG, LAT, 0.01), ten]),
    };
    expect(failuresOf([noHole, ...rest]).join(' ')).toMatch(/band area/);
  });

  it("excuses a bay's water that lies outside its parent's survey, and only that", () => {
    // A bay outline reaching 0.002° east of the parent lake: the parent's bands cannot cover it.
    const bay: Polygon = { type: 'Polygon', coordinates: [sq(LNG + 0.005, LAT, 0.007)] };
    const clippedToBay = goodBands.map((b) => ({ ...b }));
    const check = checkBands({ lake: bay, bands: clippedToBay, lines: [], survey: lake });
    expect(check.unsurveyed).toBeGreaterThan(0);
    expect(check.uncovered).toBe(0);
    // Without the survey outline, the same bay reads as a band set with a hole in it.
    const unexcused = checkBands({ lake: bay, bands: clippedToBay, lines: [] });
    expect(unexcused.unsurveyed).toBe(0);
    expect(unexcused.uncovered).toBe(check.unsurveyed);
  });

  it('fails a missing band as a hole in the lake', () => {
    const failures = failuresOf([goodBands[0] as CheckedBand, goodBands[2] as CheckedBand]);
    expect(failures.join(' ')).toMatch(/exactly once/);
  });

  it('fails two bands claiming the same water', () => {
    const overlapping: CheckedBand = {
      spec: { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 },
      geometry: multi([ten]),
    };
    const failures = failuresOf([
      goodBands[0] as CheckedBand,
      overlapping,
      goodBands[2] as CheckedBand,
    ]);
    expect(failures.join(' ')).toMatch(/in two bands/);
  });

  it('fails a band that spills onto the island', () => {
    // The lattice spans the lake's bounding box, so dry land inside it — an island — is what spill
    // catches; a band reaching past the box is the area ratio's to catch (below).
    const spill: CheckedBand = {
      spec: { bandIndex: 3, minDepthFt: 20 },
      geometry: multi([twenty], [sq(LNG + 0.001, LAT + 0.001, 0.001)]),
    };
    const failures = failuresOf([goodBands[0] as CheckedBand, goodBands[1] as CheckedBand, spill]);
    expect(failures.join(' ')).toMatch(/dry lattice/);
  });

  it('fails a band reaching off the lake entirely, by area', () => {
    const far: CheckedBand = {
      spec: { bandIndex: 3, minDepthFt: 20 },
      geometry: multi([twenty], [sq(LNG + 0.02, LAT, 0.01)]),
    };
    const failures = failuresOf([goodBands[0] as CheckedBand, goodBands[1] as CheckedBand, far]);
    expect(failures.join(' ')).toMatch(/band area/);
  });

  it('fails a lake whose depths are inverted, which tiling alone cannot see', () => {
    // Same polygons, depth labels swapped end for end: the shore ring stamped deep and the basin
    // stamped shallow. The bands still tile the lake perfectly.
    const inverted: CheckedBand[] = [
      { spec: { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 }, geometry: multi([twenty]) },
      { spec: { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 }, geometry: multi([ten, twenty]) },
      {
        spec: { bandIndex: 3, minDepthFt: 20 },
        geometry: multi([sq(LNG, LAT, 0.01), sq(LNG + 0.001, LAT + 0.001, 0.001), ten]),
      },
    ];
    const denseLines = lines.map((l) => ({
      ...l,
      // Densified so the agreement figure is judged, not waved through as noise.
      coordinates: l.coordinates.flatMap((p, i, all) => {
        const q = all[i + 1];
        if (!q) return [p];
        return Array.from({ length: 10 }, (_, k) => [
          (p[0] as number) + (((q[0] as number) - (p[0] as number)) * k) / 10,
          (p[1] as number) + (((q[1] as number) - (p[1] as number)) * k) / 10,
        ]);
      }),
    }));
    // The 10 ft line borders both the shore and middle bands either way, so only the 20 ft line's
    // vertices can tell — and it now sits between the "0–10" and "10–20" bands, outside 20 ft.
    const failures = failuresOf(inverted, denseLines);
    expect(failures.join(' ')).toMatch(/own depth's band/);
  });
});

describe('orderingErrors', () => {
  it('names every way bands can be out of order', () => {
    const band = (bandIndex: number, minDepthFt: number, maxDepthFt?: number): CheckedBand => ({
      spec:
        maxDepthFt === undefined
          ? { bandIndex, minDepthFt }
          : { bandIndex, minDepthFt, maxDepthFt },
      geometry: multi(),
    });
    expect(orderingErrors(goodBands)).toEqual([]);
    expect(orderingErrors([band(0, 0, 10), band(0, 0, 10)]).join(' ')).toMatch(/two features/);
    expect(orderingErrors([band(1, 0, 10)]).join(' ')).toMatch(/stamped index/);
    expect(orderingErrors([band(2, 10, 10)]).join(' ')).toMatch(/empty or inverted/);
    expect(orderingErrors([band(2, 10, 20), band(0, 0, 10)]).join(' ')).toMatch(/ascending/);
    expect(orderingErrors([band(2, 10), band(3, 20)]).join(' ')).toMatch(/not last/);
    expect(orderingErrors([band(2, 10, 30), band(3, 20)]).join(' ')).toMatch(/overlaps the next/);
    expect(orderingErrors([band(3, 20, 30), band(2, 25)]).join(' ')).toMatch(/index falls/);
  });
});

describe('the helpers', () => {
  it('holds a depth inclusively at both edges, and opens the deepest band', () => {
    expect(rangeHolds({ bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 }, 10)).toBe(true);
    expect(rangeHolds({ bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 }, 20)).toBe(true);
    expect(rangeHolds({ bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 }, 21)).toBe(false);
    expect(rangeHolds({ bandIndex: 6, minDepthFt: 70 }, 400)).toBe(true);
  });

  it('samples at most `cap` vertices a depth, from every line at that depth', () => {
    const many = Array.from({ length: 1000 }, (_, i) => [i, 0]);
    const sampled = sampleVertices(
      [
        { depthFt: 10, coordinates: many },
        { depthFt: 20, coordinates: [[0, 0]] },
      ],
      100,
    );
    expect(sampled.filter((s) => s.depthFt === 10)).toHaveLength(100);
    expect(sampled.filter((s) => s.depthFt === 20)).toHaveLength(1);
  });
});

describe('bandVerdict', () => {
  const clean: BandCheck = {
    inside: 1000,
    coveredOnce: 1000,
    uncovered: 0,
    unsurveyed: 0,
    overlapped: 0,
    outside: 500,
    spilled: 0,
    areaRatio: 1,
    lineVertices: 100,
    lineAgree: 100,
    ordering: [],
  };

  it('publishes a clean check and tolerates edge noise inside the limits', () => {
    expect(bandVerdict(clean)).toEqual([]);
    expect(
      bandVerdict({
        ...clean,
        coveredOnce: 975,
        uncovered: 22,
        overlapped: 3,
        lineAgree: 91,
        areaRatio: 0.98,
      }),
    ).toEqual([]);
  });

  it('does not judge line agreement on too few vertices to mean anything', () => {
    expect(
      bandVerdict({ ...clean, lineVertices: BAND_LIMITS.minLineVertices - 1, lineAgree: 0 }),
    ).toEqual([]);
  });

  it('judges coverage over the surveyed water only', () => {
    expect(bandVerdict({ ...clean, coveredOnce: 900, unsurveyed: 100 })).toEqual([]);
    expect(bandVerdict({ ...clean, coveredOnce: 800, uncovered: 100, unsurveyed: 100 })[0]).toMatch(
      /exactly once/,
    );
  });

  it('does not divide by zero on a lake the lattice missed', () => {
    expect(
      bandVerdict({
        ...clean,
        inside: 0,
        coveredOnce: 0,
        outside: 0,
        lineVertices: 0,
        lineAgree: 0,
      }),
    ).toEqual([]);
  });

  it('names an area mismatch either way', () => {
    expect(bandVerdict({ ...clean, areaRatio: 1.05 })[0]).toMatch(/105\.0%/);
    expect(bandVerdict({ ...clean, areaRatio: 0.5 })[0]).toMatch(/50\.0%/);
  });

  it('carries the ordering errors through', () => {
    expect(bandVerdict({ ...clean, ordering: ['x'] })).toEqual(['x']);
  });
});
