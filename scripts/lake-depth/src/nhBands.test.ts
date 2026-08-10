import { describe, expect, it } from 'vitest';

import {
  MAX_PLAUSIBLE_NH_DEPTH_FT,
  meanDepthFt,
  NH_BANDS_FIELDS,
  type NhBandRow,
  nhBandsQueryUrl,
  nhLakeDepth,
  nhLakeDepths,
  parseNhBandFeature,
} from './nhBands';

function band(over: Partial<NhBandRow> & Pick<NhBandRow, 'depthMinFt' | 'depthMaxFt' | 'acres'>) {
  return {
    auId: 'MELAK600030403-02',
    lakeName: 'HORN POND',
    lat: 43.561,
    lng: -70.957,
    ...over,
  } as NhBandRow;
}

/** Horn Pond, verbatim from the service on 2026-08-09. Three bands, 226.1 acres. */
const HORN_POND: NhBandRow[] = [
  band({ depthMinFt: 0, depthMaxFt: 10, acres: 111.19289283, lat: 43.56295, lng: -70.96159 }),
  band({ depthMinFt: 10, depthMaxFt: 20, acres: 63.9379306, lat: 43.56148, lng: -70.9593 }),
  band({ depthMinFt: 20, depthMaxFt: 30, acres: 50.96942014, lat: 43.56074, lng: -70.95686 }),
];

/** Beaver Pond — two lobes off the 10 ft contour, one of which bottoms out at 15. */
const BEAVER_POND: NhBandRow[] = [
  band({ auId: 'NHIMP600030702-01', depthMinFt: 0, depthMaxFt: 10, acres: 35.15 }),
  band({ auId: 'NHIMP600030702-01', depthMinFt: 10, depthMaxFt: 15, acres: 0.81 }),
  band({ auId: 'NHIMP600030702-01', depthMinFt: 10, depthMaxFt: 20, acres: 9.26 }),
  band({ auId: 'NHIMP600030702-01', depthMinFt: 20, depthMaxFt: 25, acres: 0.42 }),
  band({ auId: 'NHIMP600030702-01', depthMinFt: 20, depthMaxFt: 30, acres: 5.09 }),
  band({ auId: 'NHIMP600030702-01', depthMinFt: 30, depthMaxFt: 40, acres: 7.23 }),
  band({
    auId: 'NHIMP600030702-01',
    depthMinFt: 40,
    depthMaxFt: 47,
    acres: 1.46,
    lat: 43.1,
    lng: -71.5,
  }),
];

describe('meanDepthFt — the frustum rule, not band midpoints', () => {
  it('reproduces a cone’s true mean of maxDepth / 3', () => {
    // The whole reason this is not `Σ area × (d1 + d2) / 2`. For a cone of max depth 30 with
    // contours every 10 ft, the band areas are 0.556 / 0.333 / 0.111 of the surface, the true mean
    // is exactly 10, the midpoint estimate is 10.56, and the frustum is 9.997.
    const cone: NhBandRow[] = [
      band({ depthMinFt: 0, depthMaxFt: 10, acres: 0.5556 }),
      band({ depthMinFt: 10, depthMaxFt: 20, acres: 0.3333 }),
      band({ depthMinFt: 20, depthMaxFt: 30, acres: 0.1111 }),
    ];
    expect(meanDepthFt(cone)).toBeCloseTo(10, 1);

    const midpoint =
      cone.reduce((s, b) => s + b.acres * ((b.depthMinFt + b.depthMaxFt) / 2), 0) /
      cone.reduce((s, b) => s + b.acres, 0);
    expect(midpoint).toBeGreaterThan(10.5); // the estimate this rule was chosen over
  });

  it('integrates Horn Pond to a mean shallower than the midpoint estimate', () => {
    expect(meanDepthFt(HORN_POND)).toBeCloseTo(11.73, 1);
  });

  it('keeps two lobes off one contour in a single curve', () => {
    // Beaver Pond publishes `10–15` and `10–20`. Keying the levels on the SHALLOW edge is what
    // stops a 15 ft contour the survey never drew from appearing in the curve.
    const mean = meanDepthFt(BEAVER_POND);
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(47);
    expect(mean).toBeCloseTo(12.76, 1);
  });

  it('returns zero rather than dividing by an empty lake', () => {
    expect(meanDepthFt([])).toBe(0);
    expect(meanDepthFt([band({ depthMinFt: 0, depthMaxFt: 10, acres: 0 })])).toBe(0);
  });
});

describe('nhLakeDepth', () => {
  it('gives Horn Pond a real max, a mean, an area and an on-water point', () => {
    const out = nhLakeDepth('MELAK600030403-02', HORN_POND);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lake.maxDepthFt).toBe(30);
    expect(out.lake.meanDepthFt).toBeCloseTo(11.73, 1);
    // Σ of the published band areas — Horn Pond's own surface area, which is what makes this
    // usable as the join's area corroboration as well as the mean's denominator.
    expect(out.lake.areaAcres).toBeCloseTo(226.1, 0);
    // The DEEPEST band's centroid. Every shallower band is an annulus whose centroid can land in
    // its own hole; the innermost one has no hole.
    expect(out.lake.lat).toBeCloseTo(43.56074, 4);
    expect(out.lake.bandCount).toBe(3);
  });

  it('takes the innermost polygon’s own depthmax, not the deepest round contour', () => {
    // Beaver Pond's deepest band is `40–47`: the deepest reading in the basin, where the contour
    // lines layer would only ever have said 40. This is why NH's max stops being a lower bound.
    const out = nhLakeDepth('NHIMP600030702-01', BEAVER_POND);
    if (!out.ok) throw new Error('expected a lake');
    expect(out.lake.maxDepthFt).toBe(47);
    expect(out.lake.lat).toBeCloseTo(43.1, 4);
  });

  it('refuses a lake the layer lists but nobody sounded', () => {
    // Jones Pond: one `0–0` row with `bathy_int = 0`. Read naively it is a lake with a maximum
    // depth of zero metres, which renders as a measurement.
    expect(
      nhLakeDepth('NHIMP600030402-01', [
        band({
          auId: 'NHIMP600030402-01',
          depthMinFt: 0,
          depthMaxFt: 0,
          acres: 3.12,
          intervalFt: 0,
        }),
      ]),
    ).toEqual({ ok: false, reason: 'no-bathymetry' });
  });

  it('refuses a lake whose bands carry no area', () => {
    expect(nhLakeDepth('x', [band({ depthMinFt: 0, depthMaxFt: 10, acres: 0 })])).toEqual({
      ok: false,
      reason: 'no-area',
    });
  });

  it('refuses a depth past the backstop', () => {
    expect(
      nhLakeDepth('x', [
        band({ depthMinFt: 0, depthMaxFt: MAX_PLAUSIBLE_NH_DEPTH_FT + 1, acres: 10 }),
      ]),
    ).toEqual({ ok: false, reason: 'inverted' });
  });

  it('never reports a mean deeper than the max', () => {
    for (const bands of [HORN_POND, BEAVER_POND]) {
      const out = nhLakeDepth(bands[0]?.auId ?? 'x', bands);
      if (!out.ok) throw new Error('expected a lake');
      expect(out.lake.meanDepthFt).toBeLessThan(out.lake.maxDepthFt);
    }
  });
});

describe('nhLakeDepths', () => {
  it('groups by assessment unit and names every refusal', () => {
    const result = nhLakeDepths([
      ...HORN_POND,
      ...BEAVER_POND,
      band({ auId: 'NHIMP600030402-01', depthMinFt: 0, depthMaxFt: 0, acres: 3.12 }),
    ]);
    expect(result.lakes.map((l) => l.auId).sort()).toEqual([
      'MELAK600030403-02',
      'NHIMP600030702-01',
    ]);
    expect(result.skipped['no-bathymetry']).toBe(1);
    expect(result.skippedKeys).toEqual([{ auId: 'NHIMP600030402-01', reason: 'no-bathymetry' }]);
  });

  it('keeps the Maine-filed assessment units, because the join is spatial', () => {
    // Great East Lake and Horn Pond straddle the border and are filed `MELAK…` in a New Hampshire
    // dataset. Which agency filed a lake decides nothing about where it is.
    const result = nhLakeDepths(HORN_POND);
    expect(result.lakes[0]?.auId.startsWith('ME')).toBe(true);
  });
});

describe('the query and the row parser', () => {
  it('asks for centroids rather than rings', () => {
    const url = new URL(nhBandsQueryUrl(0));
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('returnCentroid')).toBe('true');
    expect(url.searchParams.get('outSR')).toBe('4326');
    expect(url.searchParams.get('outFields')).toBe(NH_BANDS_FIELDS.join(','));
  });

  it('reads a real feature', () => {
    const row = parseNhBandFeature({
      attributes: {
        au_id: 'NHLAK700020110-02-09',
        lake: 'WINNIPESAUKEE',
        depthmin: 100,
        depthmax: 120,
        acres: 120.42954308,
        bathy_int: 20,
      },
      centroid: { x: -71.3, y: 43.6 },
    });
    expect(row).toMatchObject({
      auId: 'NHLAK700020110-02-09',
      lakeName: 'WINNIPESAUKEE',
      depthMinFt: 100,
      depthMaxFt: 120,
      lat: 43.6,
      lng: -71.3,
      intervalFt: 20,
    });
  });

  it('refuses a feature with no centroid, which has nothing to be matched against', () => {
    expect(
      parseNhBandFeature({
        attributes: { au_id: 'x', depthmin: 0, depthmax: 10, acres: 5 },
        centroid: null,
      }),
    ).toBeUndefined();
  });

  it('refuses the "No AUID" sentinel, which would otherwise group like a real key', () => {
    // One row carries it today (JONES BROOK POND, unsounded), so nothing has gone wrong yet — but
    // `auId` IS the grouping key, so a second would merge two ponds into one depth curve. Same
    // shape as GNIS's null island and NHD's `gnis_id = -1`.
    for (const sentinel of ['No AUID', 'no auid', 'NO AU_ID']) {
      expect(
        parseNhBandFeature({
          attributes: { au_id: sentinel, depthmin: 0, depthmax: 10, acres: 5 },
          centroid: { x: -71, y: 43 },
        }),
      ).toBeUndefined();
    }
  });

  it('refuses a feature with no assessment unit, which has no lake to belong to', () => {
    expect(
      parseNhBandFeature({
        attributes: { au_id: '  ', depthmin: 0, depthmax: 10, acres: 5 },
        centroid: { x: -71, y: 43 },
      }),
    ).toBeUndefined();
  });
});
