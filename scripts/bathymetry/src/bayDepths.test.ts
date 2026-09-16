import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { bayDepthFor, bayDepths, type ExportedBay } from './bayDepths';
import type { ArchivedLake } from './lakes';

const FEET_PER_METRE = 3.28084;

function rect(minLng: number, minLat: number, maxLng: number, maxLat: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

/** A bay on the west side of a stand-in lake. */
const BAY: ExportedBay = {
  subAreaId: 'bay1',
  subAreaKey: 'sa_1',
  waterBodyId: 'lake1',
  name: 'West Bay',
  polygon: rect(-73.5, 44.2, -73.3, 44.6),
};

function sounded(points: [number, number, number][]): ArchivedLake {
  return {
    sourceKey: 'vt-vcgi-champlain-soundings',
    state: 'VT',
    agency: 'VCGI',
    lane: 'soundings',
    lakeKey: 'champlain',
    lakeName: 'Lake Champlain',
    soundings: points.map(([lng, lat, depthFt]) => ({
      lng,
      lat,
      depthFt,
      lakeKey: 'champlain',
      lakeName: 'Lake Champlain',
    })),
  };
}

function contoured(lines: { depthFt: number; coords: [number, number][] }[]): ArchivedLake {
  return {
    sourceKey: 'nh-granit-contours',
    state: 'NH',
    agency: 'NH GRANIT',
    lane: 'contours',
    lakeKey: 'winni',
    lakeName: 'Lake Winnipesaukee',
    contours: lines.map((l) => ({
      depthFt: l.depthFt,
      lakeKey: 'winni',
      lakeName: 'Lake Winnipesaukee',
      geometry: { type: 'LineString', coordinates: l.coords },
    })),
  };
}

describe('bayDepthFor', () => {
  it('takes the deepest sounding INSIDE the outline, never the lake’s', () => {
    // 400 ft mid-lake, 60 ft and 40 ft in the bay, a shoreline zero in the bay.
    const lake = sounded([
      [-73.0, 44.5, 400],
      [-73.4, 44.4, 60],
      [-73.45, 44.3, 40],
      [-73.5, 44.3, 0],
    ]);
    const out = bayDepthFor(lake, BAY);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.depth.maxDepthM).toBeCloseTo(60 / FEET_PER_METRE, 6);
    expect(out.depth.understatesMax).toBe(false);
    expect(out.depth.sampleCount).toBe(3);
  });

  it('a contour with a vertex inside the bay is a floor, flagged as one', () => {
    const lake = contoured([
      {
        depthFt: 120,
        coords: [
          [-73.0, 44.5],
          [-72.9, 44.5],
        ],
      }, // mid-lake only
      {
        depthFt: 30,
        coords: [
          [-73.6, 44.4],
          [-73.45, 44.4],
          [-73.0, 44.4],
        ],
      }, // crosses the bay
      {
        depthFt: 20,
        coords: [
          [-73.45, 44.3],
          [-73.4, 44.3],
        ],
      }, // wholly inside
    ]);
    const out = bayDepthFor(lake, BAY);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.depth.maxDepthM).toBeCloseTo(30 / FEET_PER_METRE, 6);
    expect(out.depth.understatesMax).toBe(true);
  });

  it('names its refusals: nothing inside, only shoreline zeros, an implausible reading', () => {
    expect(bayDepthFor(sounded([[-73.0, 44.5, 400]]), BAY)).toEqual({
      ok: false,
      reason: 'nothing-inside',
    });
    expect(bayDepthFor(sounded([[-73.4, 44.4, 0]]), BAY)).toEqual({
      ok: false,
      reason: 'no-positive-depth',
    });
    expect(bayDepthFor(sounded([[-73.4, 44.4, 9_999]]), BAY)).toEqual({
      ok: false,
      reason: 'implausible',
    });
  });
});

describe('bayDepths', () => {
  it('counts an uncovered parent rather than inventing a depth, and takes the deeper of two lakes', () => {
    const other: ExportedBay = {
      ...BAY,
      subAreaId: 'bay2',
      subAreaKey: 'sa_2',
      waterBodyId: 'lake9',
    };
    const byParent = new Map([
      [
        'lake1',
        [
          sounded([[-73.4, 44.4, 60]]),
          contoured([
            {
              depthFt: 80,
              coords: [
                [-73.4, 44.4],
                [-73.35, 44.4],
              ],
            },
          ]),
        ],
      ],
    ]);
    const out = bayDepths([BAY, other], byParent);
    expect(out.uncovered).toBe(1);
    expect(out.depths).toHaveLength(1);
    expect(out.depths[0]?.maxDepthM).toBeCloseTo(80 / FEET_PER_METRE, 6);
    expect(out.depths[0]?.understatesMax).toBe(true);
  });
});
