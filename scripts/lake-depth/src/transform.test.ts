import { describe, expect, it } from 'vitest';
import {
  findColumn,
  hydroLakesRung,
  mergeLagosRows,
  parseGlobathy,
  parseLagosDepth,
  parseNumber,
  splitCsvLine,
  transformDepths,
} from './transform';
import type { HydroLakesFeature, LagosDepthRow } from './types';

/** A square HydroLAKES polygon around (44, -72). */
function hydroFeature(
  props: Record<string, unknown>,
  half = 0.02,
  center = { lat: 44, lng: -72 },
): HydroLakesFeature {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [center.lng - half, center.lat - half],
          [center.lng + half, center.lat - half],
          [center.lng + half, center.lat + half],
          [center.lng - half, center.lat + half],
          [center.lng - half, center.lat - half],
        ],
      ],
    },
  };
}

describe('CSV parsing', () => {
  it('splits plain, quoted and comma-containing fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2']);
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('matches headers case- and separator-insensitively', () => {
    const header = ['Hylak_ID', 'lake area ha', 'Dmax'];
    expect(findColumn(header, ['hylakid'])).toBe(0);
    expect(findColumn(header, ['lake_area_ha'])).toBe(1);
    expect(findColumn(header, ['nope'])).toBe(-1);
  });

  it('treats blanks and sentinel nulls as absent, not zero', () => {
    // The distinction that matters: a 0 stored as "no measurement" would make a real lake read shallow.
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('NA')).toBeUndefined();
    expect(parseNumber('null')).toBeUndefined();
    expect(parseNumber('-9999')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber(' 3.5 ')).toBe(3.5);
    expect(parseNumber(undefined)).toBeUndefined();
  });
});

describe('parseGlobathy', () => {
  it('reads Hylak_id → Dmax and drops unusable rows', () => {
    const rows = parseGlobathy(['Hylak_id,Dmax_use', '1,12.5', '2,', '3,0', '4,8'].join('\n'));
    expect(rows).toEqual([
      { hylakId: '1', maxDepthM: 12.5 },
      { hylakId: '4', maxDepthM: 8 },
    ]);
  });

  it('throws a named error when the depth column is missing', () => {
    // The failure this replaces: reading zero depths out of a 1.4M-row file and reporting success.
    expect(() => parseGlobathy('Hylak_id,something_else\n1,2')).toThrow(/no column matching/);
  });
});

describe('parseLagosDepth', () => {
  const header =
    'lagoslakeid,lake_lat_decdeg,lake_lon_decdeg,lake_waterarea_ha,lake_maxdepth_m,lake_meandepth_m';

  it('reads coordinates, converts hectares to m², and keeps both depths optional', () => {
    const rows = parseLagosDepth([header, '5,44.1,-72.2,50,18,6', '6,44.3,-72.4,,9,'].join('\n'));
    expect(rows[0]).toEqual({
      lagoslakeid: '5',
      lat: 44.1,
      lng: -72.2,
      areaSqM: 500_000,
      maxDepthM: 18,
      meanDepthM: 6,
    });
    // The common case by a factor of ~3: a max with no mean.
    expect(rows[1]).toMatchObject({ maxDepthM: 9, meanDepthM: undefined, areaSqM: undefined });
  });

  it('drops rows with no id or no coordinates', () => {
    expect(parseLagosDepth([header, ',44,-72,10,5,2', '7,,,10,5,2'].join('\n'))).toEqual([]);
  });

  it('loads a version with no area column at all', () => {
    const rows = parseLagosDepth(
      ['lagoslakeid,lake_lat_decdeg,lake_lon_decdeg,lake_maxdepth_m', '8,44,-72,11'].join('\n'),
    );
    expect(rows[0]?.maxDepthM).toBe(11);
    expect(rows[0]?.areaSqM).toBeUndefined();
  });

  it('throws when neither depth column is present', () => {
    expect(() => parseLagosDepth('lagoslakeid,lake_lat_decdeg,lake_lon_decdeg\n1,44,-72')).toThrow(
      /neither a max- nor a mean-depth column/,
    );
  });
});

describe('hydroLakesRung (Vol_src earns HydroLAKES two rungs)', () => {
  it('treats a reported volume as measured-ish and everything else as modelled', () => {
    expect(hydroLakesRung(1)).toBe('hydrolakes_reported');
    expect(hydroLakesRung(2)).toBe('hydrolakes_reported');
    expect(hydroLakesRung(3)).toBe('hydrolakes_modeled');
    // Conservative on anything unexpected: claiming an unsubstantiated measurement is the error to avoid.
    expect(hydroLakesRung(undefined)).toBe('hydrolakes_modeled');
    expect(hydroLakesRung(99)).toBe('hydrolakes_modeled');
  });
});

describe('transformDepths', () => {
  it('folds HydroLAKES + GLOBathy into one record with two provenances', () => {
    const { records, summary } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 42, Depth_avg: 5.5, Vol_src: 3, Lake_area: 2.5 })],
      globathy: [{ hylakId: '42', maxDepthM: 19 }],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      key: 'hylak/42',
      meanDepthM: 5.5,
      meanDepthSource: 'hydrolakes_modeled',
      maxDepthM: 19,
      maxDepthSource: 'globathy',
      areaSqM: 2_500_000, // km² → m²
    });
    // The representative point has to be inside the polygon or the server-side join can't match it.
    expect(records[0]?.point.lat).toBeCloseTo(44, 1);
    expect(summary.emitted).toBe(1);
  });

  it('falls back to a geodesic area when the source reports none', () => {
    const { records } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 1, Depth_avg: 4 })],
    });
    // ~0.04° square at 44°N — order 107 m², enough to prove it computed rather than dropped it.
    expect(records[0]?.areaSqM).toBeGreaterThan(1e6);
  });

  it('promotes a reported-volume HydroLAKES depth to the better rung', () => {
    const { records } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 7, Depth_avg: 9, Vol_src: 1 })],
    });
    expect(records[0]?.meanDepthSource).toBe('hydrolakes_reported');
  });

  it('keeps LAGOS-US as its own record, for the server-side ladder to reconcile', () => {
    // Deliberately NOT merged here: merging would mean re-implementing the ladder in a second place.
    const { records } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 42, Depth_avg: 5.5 })],
      lagos: [{ lagoslakeid: '99', lat: 44, lng: -72, meanDepthM: 4, areaSqM: 2_400_000 }],
    });
    expect(records.map((r) => r.key)).toEqual(['hylak/42', 'lagos/99']);
    expect(records[1]?.meanDepthSource).toBe('lagos_us');
  });

  it('names a GLOBathy row whose lake is outside the clipped HydroLAKES extract', () => {
    const { records, errors, summary } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 1, Depth_avg: 3 })],
      globathy: [
        { hylakId: '1', maxDepthM: 8 },
        { hylakId: '2', maxDepthM: 40 },
      ],
    });
    expect(records).toHaveLength(1);
    expect(summary.skipped).toBe(1);
    expect(errors[0]).toMatchObject({ key: 'globathy/2' });
    expect(errors[0]?.message).toMatch(/no HydroLAKES polygon/);
  });

  it('skips a HydroLAKES lake with no depth from either source, and says so', () => {
    const { records, errors } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 3, Lake_area: 1 })],
    });
    expect(records).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/no depth from either/);
  });

  it('skips non-area geometry and missing ids with named errors', () => {
    const { records, errors } = transformDepths({
      hydroLakes: [
        {
          type: 'Feature',
          properties: { Hylak_id: 5, Depth_avg: 3 },
          geometry: { type: 'Point', coordinates: [-72, 44] },
        },
        hydroFeature({ Depth_avg: 3 }),
      ],
    });
    expect(records).toHaveLength(0);
    expect(errors.map((e) => e.message)).toEqual(['not a Polygon/MultiPolygon', 'no Hylak_id']);
  });

  it('drops a non-positive depth rather than storing it as a shallow lake', () => {
    const { records } = transformDepths({
      lagos: [{ lagoslakeid: '1', lat: 44, lng: -72, meanDepthM: 0, maxDepthM: 12 }],
    });
    expect(records[0]?.meanDepthM).toBeUndefined();
    expect(records[0]?.meanDepthSource).toBeUndefined();
    expect(records[0]?.maxDepthM).toBe(12);
  });

  it('never emits a depth without a source, or a source without a depth', () => {
    const { records } = transformDepths({
      hydroLakes: [hydroFeature({ Hylak_id: 1, Depth_avg: 4 })],
      globathy: [{ hylakId: '1', maxDepthM: 20 }],
      lagos: [{ lagoslakeid: '2', lat: 44, lng: -72, maxDepthM: 6 }],
    });
    for (const r of records) {
      expect(r.meanDepthM === undefined).toBe(r.meanDepthSource === undefined);
      expect(r.maxDepthM === undefined).toBe(r.maxDepthSource === undefined);
    }
  });

  it('handles an empty input without throwing', () => {
    const { records, summary } = transformDepths({});
    expect(records).toEqual([]);
    expect(summary).toMatchObject({ emitted: 0, skipped: 0 });
  });
});

/**
 * LAGOS-US is *compiled* from ~65 sources, so one lake can carry several records. Emitting them all
 * "worked" — same body, same rung — but `winsLadder` accepts an equal rank, so the stored value was
 * whichever row the file listed last. Arbitrary and invisible, which is the combination worth a test.
 */
describe('mergeLagosRows (many records, one lake)', () => {
  const row = (over: Partial<LagosDepthRow> = {}): LagosDepthRow => ({
    lagoslakeid: '1',
    lat: 44,
    lng: -72,
    ...over,
  });

  it('leaves a single-record lake exactly as it was', () => {
    const { lakes, merged, contested } = mergeLagosRows([row({ meanDepthM: 4, maxDepthM: 9 })]);
    expect(lakes).toHaveLength(1);
    expect(lakes[0]).toMatchObject({ meanDepthM: 4, maxDepthM: 9, rowCount: 1, contested: false });
    expect(merged).toBe(0);
    expect(contested).toBe(0);
  });

  it('takes the DEEPEST max — an extremum is the union of what surveys found', () => {
    const { lakes, merged } = mergeLagosRows([
      row({ maxDepthM: 5 }),
      row({ maxDepthM: 9 }),
      row({ maxDepthM: 7 }),
    ]);
    expect(lakes[0]?.maxDepthM).toBe(9);
    expect(merged).toBe(2);
  });

  it('takes the MEDIAN mean — and never an average nobody reported', () => {
    const { lakes } = mergeLagosRows([
      row({ meanDepthM: 2 }),
      row({ meanDepthM: 3 }),
      row({ meanDepthM: 40 }), // one bad record must not drag the answer
    ]);
    expect(lakes[0]?.meanDepthM).toBe(3);
  });

  it('flags records that disagree across the shallow threshold', () => {
    // The merge still picks a number, but here the pick decided a *safety classification* rather than
    // a display detail, so it gets counted and named instead of silently resolved.
    const { lakes, contested } = mergeLagosRows([row({ meanDepthM: 2 }), row({ meanDepthM: 6 })]);
    expect(contested).toBe(1);
    expect(lakes[0]?.contested).toBe(true);
    expect(lakes[0]?.means).toEqual([2, 6]);
  });

  it('does not flag agreement, however far apart the numbers are', () => {
    const { contested } = mergeLagosRows([row({ meanDepthM: 12 }), row({ meanDepthM: 60 })]);
    expect(contested).toBe(0); // both say "not shallow"; the disagreement changes nothing we do
  });

  it('falls back to the max threshold only when no record has a mean', () => {
    expect(mergeLagosRows([row({ maxDepthM: 5 }), row({ maxDepthM: 20 })]).contested).toBe(1);
    // With a mean present the mean decides, so a straddling max is not the contested case.
    expect(
      mergeLagosRows([row({ meanDepthM: 1, maxDepthM: 5 }), row({ meanDepthM: 2, maxDepthM: 20 })])
        .contested,
    ).toBe(0);
  });

  it('drops unusable readings before merging, and keeps the lake if anything survives', () => {
    const { lakes } = mergeLagosRows([
      row({ meanDepthM: 0, maxDepthM: -1 }),
      row({ meanDepthM: 3 }),
    ]);
    expect(lakes[0]).toMatchObject({ meanDepthM: 3, maxDepthM: undefined });
  });

  it('keeps lakes apart by id, and takes location/area from the row that has them', () => {
    const { lakes } = mergeLagosRows([
      row({ lagoslakeid: 'a', meanDepthM: 2 }),
      row({ lagoslakeid: 'b', lat: 45, lng: -71, areaSqM: 5e5, meanDepthM: 8 }),
    ]);
    expect(lakes).toHaveLength(2);
    expect(lakes[1]).toMatchObject({ lat: 45, lng: -71, areaSqM: 5e5 });
  });

  it('reports the merge in the transform summary and names the contested lake', () => {
    const { records, summary, errors } = transformDepths({
      lagos: [
        { lagoslakeid: '7', lat: 44, lng: -72, meanDepthM: 2 },
        { lagoslakeid: '7', lat: 44, lng: -72, meanDepthM: 6 },
      ],
    });
    expect(records).toHaveLength(1); // one lake, one record — not two racing rows
    expect(summary).toMatchObject({ lagosRead: 2, lagosMerged: 1, lagosContested: 1 });
    expect(errors[0]?.key).toBe('lagos/7');
    expect(errors[0]?.message).toContain('disagree across a shallow threshold');
  });
});
