import type { Feature, MultiLineString, Point } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  CHAMPLAIN_LAKE_KEY,
  contourInterval,
  depthsForLake,
  groupByLake,
  normalizeChamplainSoundings,
  normalizeMaContours,
  normalizeMeSoundings,
  normalizeNhContours,
  normalizeVtSoundingLine,
  vtSoundingColumns,
} from './normalize';

const LINE: MultiLineString = {
  type: 'MultiLineString',
  coordinates: [
    [
      [-72.264, 42.899],
      [-72.263, 42.898],
    ],
  ],
};

function point(lng: number, lat: number): Point {
  return { type: 'Point', coordinates: [lng, lat] };
}

describe('normalizeNhContours', () => {
  // Property bags copied from the real archived page-00000.
  const feature = (props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    geometry: LINE,
    properties: {
      fid: 1,
      lake: 'Wilson Pond',
      au_id: 'NHLAK802010303-10',
      depth: 2.00000006,
      meters: 2511.23967719,
      length: 8238.95884091,
      ...props,
    },
  });

  it('recovers the surveyed depth from a value round-tripped through metres', () => {
    // NH's `depth` holds 2.00000006 where the survey said 2 — a ft→m→ft round trip with mismatched
    // constants. Left alone it makes a naive DISTINCT return 116 values where ~60 exist.
    expect(normalizeNhContours([feature({})]).records[0]?.depthFt).toBe(2);
    expect(normalizeNhContours([feature({ depth: 14.00000045 })]).records[0]?.depthFt).toBe(14);
  });

  it('never reads `meters` as a depth — it is the line length', () => {
    // 8238.96 / 3.28084 = 2511.24, so `meters` pairs with `length`, not with `depth`. This doc's own
    // source table and this ETL's first registry note both made that mistake; only arithmetic on real
    // values catches it, so it is pinned.
    const record = normalizeNhContours([feature({})]).records[0];
    expect(record?.depthFt).toBe(2);
    expect(record?.depthFt).not.toBeCloseTo(2511.24);
  });

  it('drops the shoreline rather than double-stroking the polygon we already draw', () => {
    const result = normalizeNhContours([feature({ depth: 0 })]);
    expect(result.records).toHaveLength(0);
    expect(result.skipped['shoreline (depth <= 0)']).toBe(1);
  });

  it('keys on the NHDES assessment-unit id, falling back to the name', () => {
    expect(normalizeNhContours([feature({})]).records[0]?.lakeKey).toBe('NHLAK802010303-10');
    expect(normalizeNhContours([feature({ au_id: '' })]).records[0]?.lakeKey).toBe('Wilson Pond');
  });

  it('counts every drop by a named reason instead of filtering silently', () => {
    const result = normalizeNhContours([
      feature({ depth: null }),
      feature({ au_id: '', lake: '' }),
      { type: 'Feature', geometry: point(0, 0), properties: { depth: 5, au_id: 'x' } },
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.skipped).toEqual({
      'no depth value': 1,
      'no lake identifier': 1,
      'unexpected geometry (Point)': 1,
    });
  });
});

describe('normalizeMaContours', () => {
  const feature = (props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    geometry: LINE,
    properties: { DEPTH: 15, SHORE: 0, NAME: 'Upper Spectacle Pond', PALIS_ID: 31044.0, ...props },
  });

  it('normalizes a contour', () => {
    const record = normalizeMaContours([feature({})]).records[0];
    expect(record).toMatchObject({
      depthFt: 15,
      lakeKey: '31044',
      lakeName: 'Upper Spectacle Pond',
    });
  });

  it('keys PALIS_ID as an integer, so 31044 and 31044.0 are one lake', () => {
    const a = normalizeMaContours([feature({ PALIS_ID: 31044 })]).records[0]?.lakeKey;
    const b = normalizeMaContours([feature({ PALIS_ID: 31044.0 })]).records[0]?.lakeKey;
    expect(a).toBe(b);
    expect(a).toBe('31044');
  });

  it('drops the shoreline by BOTH its flag and its depth', () => {
    // MassGIS marks the shoreline two ways (SHORE = 1 at DEPTH = 0). A source that flags a thing
    // twice will eventually flag it once, so neither test is allowed to be the only one.
    expect(
      normalizeMaContours([feature({ SHORE: 1, DEPTH: 20 })]).skipped['shoreline (SHORE = 1)'],
    ).toBe(1);
    expect(
      normalizeMaContours([feature({ SHORE: 0, DEPTH: 0 })]).skipped['shoreline (depth <= 0)'],
    ).toBe(1);
  });
});

describe('normalizeChamplainSoundings', () => {
  const feature = (depth: unknown): Feature => ({
    type: 'Feature',
    geometry: point(-73.356, 44.998),
    properties: { OBJECTID: 1, DEPTH_FT: depth },
  });

  it('flips the sign — the source signs depth as a negative elevation', () => {
    const record = normalizeChamplainSoundings([feature(-10)]).records[0];
    expect(record?.depthFt).toBe(10);
    expect(record?.lakeKey).toBe(CHAMPLAIN_LAKE_KEY);
  });

  it('drops the 2010 shoreline ring, which is a boundary constraint rather than a sounding', () => {
    const result = normalizeChamplainSoundings([feature(0), feature(-1)]);
    expect(result.records).toHaveLength(1);
    expect(result.skipped['shoreline or above surface (depth <= 0)']).toBe(1);
  });

  it('rejects a non-point geometry', () => {
    const result = normalizeChamplainSoundings([
      { type: 'Feature', geometry: LINE, properties: { DEPTH_FT: -5 } },
    ]);
    expect(result.skipped['not a point']).toBe(1);
  });
});

describe('normalizeMeSoundings', () => {
  const feature = (props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    geometry: point(-69.5, 45.1),
    properties: { DEPTHM: 3.0303, DEPTHF: 9.94192913, MIDAS: 982, FMSRC: 'depthmap', ...props },
  });

  it("undoes Maine's 3.3 ft/m conversion error instead of trusting DEPTHF", () => {
    // The published DEPTHF (9.94) is systematically 0.58% shallow because DEPTHM was built with a
    // 3.3 constant and then converted back with 3.28084. DEPTHM * 3.3 recovers the surveyed 10 ft.
    expect(normalizeMeSoundings([feature({})]).records[0]?.depthFt).toBe(10);
    expect(normalizeMeSoundings([feature({ DEPTHM: 23.63636 })]).records[0]?.depthFt).toBe(78);
    expect(normalizeMeSoundings([feature({ DEPTHM: 10.90909 })]).records[0]?.depthFt).toBe(36);
  });

  it('converts the GPS rows normally — only the digitised rows carry the bad constant', () => {
    // A depth-sounder track is a genuine metre reading; applying the 3.3 fudge to it would introduce
    // the very error we are undoing elsewhere.
    const record = normalizeMeSoundings([feature({ FMSRC: 'gpscarrier', DEPTHM: 10 })]).records[0];
    expect(record?.depthFt).toBe(32.81);
    expect(record?.method).toBe('gpscarrier');
  });

  it('carries the sub-source, because the layer is two datasets in one schema', () => {
    expect(normalizeMeSoundings([feature({})]).records[0]?.method).toBe('depthmap');
  });

  it('keys on MIDAS, so the per-lake split needs no spatial work', () => {
    expect(normalizeMeSoundings([feature({ MIDAS: 1634 })]).records[0]?.lakeKey).toBe('1634');
  });

  it('refuses a sounding with no MIDAS rather than guessing its lake spatially', () => {
    const result = normalizeMeSoundings([feature({ MIDAS: 0 }), feature({ MIDAS: null })]);
    expect(result.records).toHaveLength(0);
    expect(result.skipped['no MIDAS lake id']).toBe(2);
  });

  it('rejects a non-point geometry and a missing depth by name', () => {
    const result = normalizeMeSoundings([
      { type: 'Feature', geometry: LINE, properties: { DEPTHM: 3, MIDAS: 1 } },
      feature({ DEPTHM: undefined }),
    ]);
    expect(result.skipped).toEqual({ 'not a point': 1, 'no depth value': 1 });
  });

  it('drops a zero-depth sounding', () => {
    expect(
      normalizeMeSoundings([feature({ DEPTHM: 0 })]).skipped[
        'shoreline or above surface (depth <= 0)'
      ],
    ).toBe(1);
  });

  it('leaves `method` unset when the source names none', () => {
    expect(normalizeMeSoundings([feature({ FMSRC: '  ' })]).records[0]?.method).toBeUndefined();
  });
});

describe('reading values the services actually emit', () => {
  it('accepts a string-typed number, which some ArcGIS builds return', () => {
    const result = normalizeMaContours([
      {
        type: 'Feature',
        geometry: LINE,
        properties: { DEPTH: '15', SHORE: '0', NAME: 'Pond', PALIS_ID: '31044' },
      },
    ]);
    expect(result.records[0]).toMatchObject({ depthFt: 15, lakeKey: '31044' });
  });

  it('rejects a non-numeric string rather than storing NaN as a depth', () => {
    const result = normalizeMaContours([
      { type: 'Feature', geometry: LINE, properties: { DEPTH: 'deep', NAME: 'Pond' } },
    ]);
    expect(result.skipped['no depth value']).toBe(1);
  });

  it('rejects a non-finite coordinate', () => {
    const result = normalizeChamplainSoundings([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number.NaN, 44] },
        properties: { DEPTH_FT: -5 },
      },
    ]);
    expect(result.skipped['not a point']).toBe(1);
  });

  it('falls back to NAME when MassGIS omits PALIS_ID', () => {
    const result = normalizeMaContours([
      { type: 'Feature', geometry: LINE, properties: { DEPTH: 10, NAME: 'Laurel Lake' } },
    ]);
    expect(result.records[0]?.lakeKey).toBe('Laurel Lake');
  });

  it('drops a MassGIS row carrying neither an id nor a name', () => {
    const result = normalizeMaContours([
      { type: 'Feature', geometry: LINE, properties: { DEPTH: 10 } },
    ]);
    expect(result.skipped['no lake identifier']).toBe(1);
  });

  it('handles a feature with no properties at all', () => {
    expect(
      normalizeNhContours([{ type: 'Feature', geometry: LINE, properties: null }]).skipped[
        'no depth value'
      ],
    ).toBe(1);
  });

  it('accepts a plain LineString as well as a MultiLineString', () => {
    const result = normalizeNhContours([
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-72, 42],
            [-72.1, 42.1],
          ],
        },
        properties: { depth: 5, au_id: 'x' },
      },
    ]);
    expect(result.records[0]?.geometry.type).toBe('LineString');
  });
});

describe('vtSoundingColumns', () => {
  it('locates the four columns from the real header', () => {
    expect(vtSoundingColumns('Longitude,Latitude,DepthInFeet,LakeName')).toEqual({
      lng: 0,
      lat: 1,
      depth: 2,
      name: 3,
    });
  });

  it('survives a reorder, which is the failure a fixed index would not survive', () => {
    // The file was republished under its 2020 filename (last-modified moved to 2026-06-01), so a
    // column swap is live risk: it keeps parsing and silently reads latitude as depth.
    expect(vtSoundingColumns('LakeName,DepthInFeet,Latitude,Longitude')).toEqual({
      lng: 3,
      lat: 2,
      depth: 1,
      name: 0,
    });
  });

  it('throws naming the headers it actually found, rather than reading zero soundings', () => {
    expect(() => vtSoundingColumns('lon,lat,depth_m,lake')).toThrow(
      /Found: lon, lat, depth_m, lake/,
    );
  });
});

describe('normalizeVtSoundingLine', () => {
  const columns = { lng: 0, lat: 1, depth: 2, name: 3 };

  it('flips the sign and keys the lake case-insensitively', () => {
    const result = normalizeVtSoundingLine('-71.6468,44.6637,-2.9121,MAIDSTONE', columns);
    expect(result).toEqual({
      lng: -71.6468,
      lat: 44.6637,
      depthFt: 2.91,
      lakeKey: 'MAIDSTONE',
      lakeName: 'MAIDSTONE',
    });
  });

  it('drops the near-surface rows the sonar log starts and ends with', () => {
    expect(normalizeVtSoundingLine('-71.6,44.6,-0,MAIDSTONE', columns)).toEqual({
      skipReason: 'shoreline or above surface (depth <= 0)',
    });
  });

  it('names why a row was dropped rather than returning null', () => {
    expect(normalizeVtSoundingLine('x,44.6,-3,MAIDSTONE', columns)).toEqual({
      skipReason: 'unparseable coordinate',
    });
    expect(normalizeVtSoundingLine('-71.6,44.6,-3,', columns)).toEqual({
      skipReason: 'no lake name',
    });
  });
});

describe('groupByLake', () => {
  it('groups and preserves order within a lake', () => {
    const groups = groupByLake([
      { lakeKey: 'a', depthFt: 1 },
      { lakeKey: 'b', depthFt: 2 },
      { lakeKey: 'a', depthFt: 3 },
    ]);
    expect(groups.get('a')?.map((r) => r.depthFt)).toEqual([1, 3]);
    expect(groups.get('b')).toHaveLength(1);
  });
});

describe('depthsForLake / contourInterval', () => {
  it('returns the distinct depths a lake actually carries, sorted', () => {
    expect(depthsForLake([{ depthFt: 10 }, { depthFt: 5 }, { depthFt: 10 }])).toEqual([5, 10]);
  });

  it('reports an interval only when the spacing is genuinely uniform', () => {
    expect(contourInterval([5, 10, 15, 20])).toBe(5);
    expect(contourInterval([2, 4, 6])).toBe(2);
  });

  it('declines to name an interval for a set that does not have one', () => {
    // MassGIS mixes 2/3/4/5 ft in the shallows with 5 ft steps below. "5 ft contours" would be the
    // first interpretive claim this feature made, and D82 says it makes none.
    expect(contourInterval([2, 3, 4, 5, 10, 15])).toBeUndefined();
    expect(contourInterval([10])).toBeUndefined();
    expect(contourInterval([])).toBeUndefined();
  });

  it('declines rather than dividing by zero on a duplicated depth', () => {
    expect(contourInterval([5, 5, 10])).toBeUndefined();
  });
});
