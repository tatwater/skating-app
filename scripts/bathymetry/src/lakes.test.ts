import type { LineString } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  type ArchivedLake,
  contourVertices,
  maxDepthFt,
  measure,
  representativePoint,
  shapePoints,
  spanSelect,
  spatialClusters,
} from './lakes';

function soundingLake(
  points: { lng: number; lat: number; depthFt: number }[],
  lakeKey = 'k',
): ArchivedLake {
  return {
    sourceKey: 'me-dep-soundings',
    state: 'ME',
    agency: 'Maine DEP / IF&W',
    lane: 'soundings',
    lakeKey,
    lakeName: 'Test Pond',
    soundings: points.map((p) => ({ ...p, lakeKey, lakeName: 'Test Pond' })),
  };
}

function contourLake(
  lines: { depthFt: number; coordinates: number[][] }[],
  lakeKey = 'c',
): ArchivedLake {
  return {
    sourceKey: 'nh-granit-contours',
    state: 'NH',
    agency: 'NH GRANIT',
    lane: 'contours',
    lakeKey,
    lakeName: 'Test Lake',
    contours: lines.map((l) => ({
      depthFt: l.depthFt,
      lakeKey,
      lakeName: 'Test Lake',
      geometry: { type: 'LineString', coordinates: l.coordinates } as LineString,
    })),
  };
}

describe('representativePoint', () => {
  it('takes the deepest sounding — on water by definition, furthest from any shore', () => {
    const lake = soundingLake([
      { lng: -72.0, lat: 44.0, depthFt: 5 },
      { lng: -71.99, lat: 44.01, depthFt: 80 },
      { lng: -71.98, lat: 44.02, depthFt: 12 },
    ]);
    expect(representativePoint(lake)).toEqual({ lat: 44.01, lng: -71.99 });
  });

  it('takes a mid-ring vertex of the deepest contour, never an endpoint', () => {
    // An open contour's ends sit against the mask or the shore, which is where two surveys' shorelines
    // disagree — the one place a representative point is most likely to fall on land.
    const lake = contourLake([
      { depthFt: 10, coordinates: [[-72, 44]] },
      {
        depthFt: 60,
        coordinates: [
          [-72.0, 44.0],
          [-71.99, 44.01],
          [-71.98, 44.0],
        ],
      },
    ]);
    expect(representativePoint(lake)).toEqual({ lat: 44.01, lng: -71.99 });
  });

  it('returns undefined rather than a guess when there is nothing to point at', () => {
    expect(representativePoint({ ...soundingLake([]), soundings: [] })).toBeUndefined();
  });
});

describe('contourVertices', () => {
  it('flattens a MultiLineString into one vertex list', () => {
    const lake = contourLake([{ depthFt: 10, coordinates: [] }]);
    const contour = lake.contours?.[0];
    if (!contour) throw new Error('fixture');
    contour.geometry = {
      type: 'MultiLineString',
      coordinates: [
        [
          [-72, 44],
          [-71.9, 44.1],
        ],
        [[-71.8, 44.2]],
      ],
    };
    expect(contourVertices(contour)).toHaveLength(3);
  });
});

describe('maxDepthFt', () => {
  it('reads the deepest measurement from either lane', () => {
    expect(maxDepthFt(soundingLake([{ lng: -72, lat: 44, depthFt: 33 }]))).toBe(33);
    expect(maxDepthFt(contourLake([{ depthFt: 70, coordinates: [[-72, 44]] }]))).toBe(70);
  });
});

describe('shapePoints', () => {
  it('uses contour vertices when there are no soundings, so shape is measurable on both lanes', () => {
    const lake = contourLake([
      {
        depthFt: 10,
        coordinates: [
          [-72, 44],
          [-71.9, 44.1],
        ],
      },
    ]);
    expect(shapePoints(lake)).toEqual([
      { lng: -72, lat: 44 },
      { lng: -71.9, lat: 44.1 },
    ]);
  });
});

describe('measure', () => {
  it('assesses density on sounding lanes and skips it on contour lanes', () => {
    const grid: { lng: number; lat: number; depthFt: number }[] = [];
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 6; j += 1) {
        grid.push({ lng: -72 + i * 0.002, lat: 44 + j * 0.002, depthFt: 10 + i });
      }
    }
    expect(measure(soundingLake(grid)).density?.verdict).toBe('ok');
    // A contour lane is the agency's own survey — there is no fit of ours to gate.
    expect(
      measure(contourLake([{ depthFt: 20, coordinates: [[-72, 44]] }])).density,
    ).toBeUndefined();
  });

  it('reports an extent for a contour lane anyway, so both lanes sort on one scale', () => {
    const lake = contourLake([
      {
        depthFt: 20,
        coordinates: [
          [-72.0, 44.0],
          [-71.9, 44.05],
        ],
      },
    ]);
    expect(measure(lake).extentM).toBeGreaterThan(1000);
  });
});

describe('spatialClusters', () => {
  /** A blob of points around a centre, tight enough to be unambiguously one water body. */
  function blob(lng: number, lat: number, n = 40): { lng: number; lat: number }[] {
    return Array.from({ length: n }, (_, i) => ({
      lng: lng + (i % 8) * 0.0009,
      lat: lat + Math.floor(i / 8) * 0.0009,
    }));
  }

  it('is one body for a continuous cloud', () => {
    expect(spatialClusters(blob(-72, 44), 600)).toBe(1);
  });

  it('finds two bodies when a key holds two ponds miles apart', () => {
    // NH's `au_id` "Horseshoe Pond" holds two waters 50 km apart. One key resolves to one polygon, so
    // the other pond's contours are clipped away against a shoreline nowhere near them — which
    // rendered as a blank card and is how this was found.
    const two = [...blob(-72, 44), ...blob(-71.4, 44.3)];
    expect(spatialClusters(two, 600)).toBe(2);
  });

  it('keeps a genuinely long lake whole when the gap scales to its own extent', () => {
    // Champlain is 174 km and one lake. A fixed threshold that catches a scattered 379 km Maine key
    // would split it; a scale-free one does not, because Champlain is continuous at its own scale.
    const long: { lng: number; lat: number }[] = [];
    for (let i = 0; i < 400; i += 1) long.push({ lng: -73.3, lat: 43.6 + i * 0.0035 });
    const extentM = 1.4 * 111_320;
    expect(spatialClusters(long, Math.max(600, extentM * 0.08))).toBe(1);
  });

  it('errs toward merging rather than splitting', () => {
    // A false split drops a real lake; a false merge only leaves a bad join to be caught downstream.
    const nearlyTouching = [...blob(-72, 44), ...blob(-71.994, 44)];
    expect(spatialClusters(nearlyTouching, 600)).toBe(1);
  });

  it('handles the empty and degenerate cases', () => {
    expect(spatialClusters([], 600)).toBe(0);
    expect(spatialClusters([{ lng: -72, lat: 44 }], 600)).toBe(1);
    expect(spatialClusters(blob(-72, 44), 0)).toBe(1);
  });
});

describe('spanSelect', () => {
  const sized = (n: number) => ({ size: n, shape: 1 });

  it('spans the size range instead of returning the top or the head', () => {
    // The failure this exists to prevent: the corpus is dominated by small waters, so the first N are
    // farm ponds and the top N are the four largest lakes in the state. Neither shows the range.
    const items = Array.from({ length: 100 }, (_, i) => sized(i + 1));
    const picked = spanSelect(
      items,
      5,
      (x) => x.size,
      (x) => x.shape,
    );
    expect(picked).toHaveLength(5);
    const sizes = picked.map((p) => p.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes[0]).toBeLessThan(25);
    expect(sizes[4]).toBeGreaterThan(75);
  });

  it('prefers a shape unlike anything already picked, within each size bucket', () => {
    const items = [
      { size: 1, shape: 1.0 },
      { size: 2, shape: 1.0 },
      { size: 10, shape: 1.0 },
      { size: 11, shape: 4.0 },
    ];
    const picked = spanSelect(
      items,
      2,
      (x) => x.size,
      (x) => x.shape,
    );
    // First bucket has nothing to differ from, so it takes its head; the second must then reach for
    // the elongated one rather than the round one it already has.
    expect(picked.map((p) => p.shape)).toEqual([1.0, 4.0]);
  });

  it('returns everything, sorted, when asked for more than exists', () => {
    const items = [sized(5), sized(1)];
    expect(
      spanSelect(
        items,
        10,
        (x) => x.size,
        (x) => x.shape,
      ).map((x) => x.size),
    ).toEqual([1, 5]);
  });

  it('is empty for a zero count or an empty input', () => {
    expect(
      spanSelect(
        [sized(1)],
        0,
        (x) => x.size,
        (x) => x.shape,
      ),
    ).toEqual([]);
    expect(
      spanSelect(
        [],
        5,
        (x: { size: number }) => x.size,
        () => 1,
      ),
    ).toEqual([]);
  });

  it('is deterministic — the same input picks the same lakes every run', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ size: i, shape: (i % 7) + 1 }));
    const a = spanSelect(
      items,
      6,
      (x) => x.size,
      (x) => x.shape,
    );
    const b = spanSelect(
      items,
      6,
      (x) => x.size,
      (x) => x.shape,
    );
    expect(a).toEqual(b);
  });
});
