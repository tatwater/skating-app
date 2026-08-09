import { describe, expect, it } from 'vitest';
import {
  agencyDepthFor,
  agencyDepths,
  depthsBySource,
  MAX_PLAUSIBLE_AGENCY_DEPTH_M,
  SUPERSEDED_DEPTH_SOURCES,
} from './lakeDepths';
import type { ArchivedLake } from './lakes';

const FEET_PER_METRE = 3.28084;

function sounded(over: Partial<ArchivedLake> = {}): ArchivedLake {
  return {
    sourceKey: 'me-dep-soundings',
    state: 'ME',
    agency: 'Maine DEP / IF&W',
    lane: 'soundings',
    lakeKey: '5271',
    lakeName: 'Sebago Lake',
    soundings: [
      { lng: -70.56, lat: 43.85, depthFt: 12, lakeKey: '5271', lakeName: 'Sebago Lake' },
      { lng: -70.58, lat: 43.87, depthFt: 316, lakeKey: '5271', lakeName: 'Sebago Lake' },
      { lng: -70.6, lat: 43.9, depthFt: 40, lakeKey: '5271', lakeName: 'Sebago Lake' },
    ],
    ...over,
  };
}

/**
 * A contour-lane lake. **MassGIS, not NH GRANIT** — NH's contour lines are in
 * `SUPERSEDED_DEPTH_SOURCES` because its band polygons own that state's depth, so using it here
 * would test the exclusion rather than the contour rules. See `nhContoured` below.
 */
function contoured(over: Partial<ArchivedLake> = {}): ArchivedLake {
  return {
    sourceKey: 'ma-massgis-contours',
    state: 'MA',
    agency: 'MassGIS / MassWildlife',
    lane: 'contours',
    lakeKey: 'MA-1',
    lakeName: 'QUABBIN RESERVOIR',
    contours: [
      {
        depthFt: 20,
        lakeKey: 'x',
        lakeName: 'WINNIPESAUKEE',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-71.3, 43.6],
            [-71.29, 43.61],
            [-71.28, 43.62],
          ],
        },
      },
      {
        depthFt: 180,
        lakeKey: 'x',
        lakeName: 'WINNIPESAUKEE',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-71.31, 43.63],
            [-71.305, 43.635],
            [-71.3, 43.64],
          ],
        },
      },
    ],
    ...over,
  };
}

describe('agencyDepthFor', () => {
  it('takes the deepest sounding and lands the point on it', () => {
    const out = agencyDepthFor(sounded());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.record.key).toBe('me-dep-soundings/5271');
    expect(out.detail.record.maxDepthM).toBeCloseTo(316 / FEET_PER_METRE, 3);
    expect(out.detail.record.maxDepthSource).toBe('state_agency');
    // The deepest sounding is the furthest point from any shore, so it is the one most likely to
    // fall inside an outline a different survey drew.
    expect(out.detail.record.point).toEqual({ lat: 43.87, lng: -70.58 });
    expect(out.detail.record.name).toBe('Sebago Lake');
    expect(out.detail.sampleCount).toBe(3);
    expect(out.detail.understatesMax).toBe(false);
  });

  it('takes the deepest CONTOUR and says the number understates', () => {
    // The deepest published isobath is a floor on the real maximum: the basin inside that line is
    // deeper by an unknown amount, roughly the contour interval. Stored anyway — it is the agency's
    // own measurement — but a consumer must be able to tell the two lanes apart without re-deriving.
    const out = agencyDepthFor(contoured());
    if (!out.ok) throw new Error('expected a depth');
    expect(out.detail.record.maxDepthM).toBeCloseTo(180 / FEET_PER_METRE, 3);
    expect(out.detail.understatesMax).toBe(true);
    // A mid-vertex of the deepest contour, never an endpoint — the ends sit against the shore, which
    // is exactly where two surveys' shorelines disagree.
    expect(out.detail.record.point).toEqual({ lat: 43.635, lng: -71.305 });
  });

  it('refuses a survey that is only shoreline zeros', () => {
    // Champlain's archive is 84,565 shoreline zeros against 20,345 real soundings. A lake whose
    // whole survey is the closing ring would otherwise report "0 m", which reads as a measurement
    // rather than as an absence.
    const out = agencyDepthFor(
      sounded({
        soundings: [
          { lng: -73.3, lat: 44.5, depthFt: 0, lakeKey: 'champlain', lakeName: 'Champlain' },
          { lng: -73.31, lat: 44.51, depthFt: 0, lakeKey: 'champlain', lakeName: 'Champlain' },
        ],
      }),
    );
    expect(out).toEqual({ ok: false, reason: 'no-positive-depth' });
  });

  it('refuses a lake with no records at all', () => {
    expect(agencyDepthFor(sounded({ soundings: [] }))).toEqual({
      ok: false,
      reason: 'no-positive-depth',
    });
  });

  it('refuses a reading past the backstop, which means a units error', () => {
    // A depth published in centimetres, or a sentinel read as a depth. Champlain's 122 m is the
    // deepest water any of these sources covers, so anything past 250 m is not a lake.
    const metres = MAX_PLAUSIBLE_AGENCY_DEPTH_M + 10;
    const out = agencyDepthFor(
      sounded({
        soundings: [
          {
            lng: -70.5,
            lat: 43.8,
            depthFt: metres * FEET_PER_METRE,
            lakeKey: '1',
            lakeName: 'x',
          },
        ],
      }),
    );
    expect(out).toEqual({ ok: false, reason: 'implausible' });
  });

  it('accepts Champlain at 122 m, which is the real ceiling', () => {
    const out = agencyDepthFor(
      sounded({
        soundings: [
          { lng: -73.3, lat: 44.5, depthFt: 400, lakeKey: 'champlain', lakeName: 'Champlain' },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.record.maxDepthM).toBeCloseTo(121.9, 1);
  });

  it('refuses a lake whose deepest contour has no usable vertex', () => {
    const out = agencyDepthFor(
      contoured({
        contours: [
          {
            depthFt: 30,
            lakeKey: 'x',
            lakeName: 'x',
            geometry: { type: 'LineString', coordinates: [] },
          },
        ],
      }),
    );
    expect(out).toEqual({ ok: false, reason: 'no-point' });
  });

  it('omits the name rather than emitting an empty one', () => {
    const out = agencyDepthFor(sounded({ lakeName: '' }));
    if (!out.ok) throw new Error('expected a depth');
    expect(out.detail.record).not.toHaveProperty('name');
  });
});

describe('agencyDepths', () => {
  it('counts and names every refusal rather than filtering silently', () => {
    const result = agencyDepths([
      sounded(),
      sounded({ lakeKey: 'empty', soundings: [] }),
      contoured(),
    ]);
    expect(result.depths).toHaveLength(2);
    expect(result.skipped['no-positive-depth']).toBe(1);
    expect(result.skippedKeys).toEqual([
      { key: 'me-dep-soundings/empty', reason: 'no-positive-depth' },
    ]);
  });

  it('starts every refusal counter at zero, so an absent reason reads as zero not as missing', () => {
    const result = agencyDepths([]);
    expect(result.skipped).toEqual({
      'no-positive-depth': 0,
      'no-point': 0,
      implausible: 0,
      superseded: 0,
    });
  });
});

/** NH's contour lines specifically — the one source whose depth another lane owns. */
const nhContoured = () =>
  contoured({ sourceKey: 'nh-granit-contours', state: 'NH', agency: 'NH GRANIT' });

describe('SUPERSEDED_DEPTH_SOURCES', () => {
  it('refuses NH’s contour lines, because the band polygons own that state’s depth', () => {
    // Layer 0 and layer 1 of the same service. The bands give a real maximum (Beaver Pond's
    // innermost is `40–47`) and an integrated mean; the lines give the deepest round isobath and
    // nothing else. Two producers writing one rung for one lake is an ambiguity the ladder cannot
    // break — whichever loaded second would win.
    expect(SUPERSEDED_DEPTH_SOURCES.has('nh-granit-contours')).toBe(true);
    expect(agencyDepthFor(nhContoured())).toEqual({ ok: false, reason: 'superseded' });
  });

  it('refuses it BEFORE measuring, so no discarded depth reaches the log', () => {
    // A superseded source is not a lake that failed; it is a lake somebody else answers for.
    const result = agencyDepths([nhContoured(), sounded()]);
    expect(result.depths.map((d) => d.sourceKey)).toEqual(['me-dep-soundings']);
    expect(result.skipped.superseded).toBe(1);
    expect(result.skipped['no-positive-depth']).toBe(0);
    expect(result.skippedKeys[0]).toMatchObject({ reason: 'superseded' });
  });

  it('leaves every other contour lane alone — this governs depth, not the render', () => {
    // MassGIS publishes lines only and has no band layer, so its deepest contour is the best
    // maximum available for Massachusetts and must still be produced.
    const out = agencyDepthFor(contoured());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.understatesMax).toBe(true);
  });
});

describe('depthsBySource', () => {
  it('tallies per source, deepest first by lake count', () => {
    const result = agencyDepths([sounded(), sounded({ lakeKey: '2' }), contoured()]);
    expect(depthsBySource(result.depths)).toEqual([
      { sourceKey: 'me-dep-soundings', state: 'ME', lakes: 2, deepestM: 316 / FEET_PER_METRE },
      { sourceKey: 'ma-massgis-contours', state: 'MA', lakes: 1, deepestM: 180 / FEET_PER_METRE },
    ]);
  });
});
