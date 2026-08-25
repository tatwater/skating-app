import { describe, expect, it } from 'vitest';
import {
  identifyUrl,
  judgeReadings,
  MAX_RASTER_SPREAD_M,
  parseIdentify,
  type RasterReading,
} from './demIdentify';

/** An `identify` response, in the shape the live service returns it. */
const response = (
  rows: { value: string; name: string; demType: number | null; lowPS?: number }[],
) => ({
  properties: { Values: rows.map((r) => r.value) },
  catalogItems: {
    features: rows.map((r) => ({
      attributes: { Name: r.name, DEM_Type: r.demType, LowPS: r.lowPS ?? 1 },
    })),
  },
});

const reading = (elevationM: number | null, name = 'raster'): RasterReading => ({
  name,
  groundSampleM: 1,
  elevationM,
});

describe('parseIdentify', () => {
  it('pairs each value with the raster that produced it', () => {
    const parsed = parseIdentify(
      response([
        { value: '135.107', name: 'NY_Finger_Lakes', demType: 1 },
        { value: '135.107', name: 'n42w077', demType: 1, lowPS: 10.3 },
      ]),
    );
    expect(parsed).toEqual([
      { name: 'NY_Finger_Lakes', groundSampleM: 1, elevationM: 135.107 },
      { name: 'n42w077', groundSampleM: 10.3, elevationM: 135.107 },
    ]);
  });

  it('⚠ drops the overview pyramid, whose averages would outvote the real rasters', () => {
    // Measured at the Portland tidal polygon: the pyramid reads 17.7 / 20.7 / 21.9 / 35.1 there,
    // because it is averaging land in with the channel. Positive, plausible, and about the wrong
    // thing — include it and a tidal channel becomes a hillside by majority.
    const parsed = parseIdentify(
      response([
        { value: '20.65', name: 'Ov_i02_L05_R00000005_C00000001.tif', demType: null, lowPS: 1200 },
        { value: '-22.94', name: 'ME_SouthCoastal_2020_A20', demType: 1 },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('ME_SouthCoastal_2020_A20');
  });

  it('reads NoData as an absence rather than a number', () => {
    const parsed = parseIdentify(
      response([{ value: 'NoData', name: 'NY_Hudson_D22', demType: 1 }]),
    );
    expect(parsed[0]?.elevationM).toBeNull();
  });

  it('⚠ refuses the whole response when the parallel arrays disagree in length', () => {
    // The pairing is positional — there is no id on a value — so a mismatch means every number
    // could belong to the wrong raster. Half a right answer is not available here.
    const broken = {
      properties: { Values: ['1', '2', '3'] },
      catalogItems: { features: [{ attributes: { Name: 'a', DEM_Type: 1 } }] },
    };
    expect(parseIdentify(broken)).toEqual([]);
  });

  it('says nothing about a response it does not recognise', () => {
    expect(parseIdentify(null)).toEqual([]);
    expect(parseIdentify('<html>error</html>')).toEqual([]);
    expect(parseIdentify({})).toEqual([]);
  });

  it('asks for the catalogue, which is the entire point of this endpoint', () => {
    const url = identifyUrl(43.6, -70.3);
    expect(url).toContain('returnCatalogItems=true');
    expect(url).toContain(encodeURIComponent('"wkid":4326'));
  });
});

describe('judgeReadings — what the rasters together will say', () => {
  it('takes unanimity at its word', () => {
    // Seneca, live: three rasters, all 135.107, on a lake 188 m deep. Hydro-flattening means the
    // DEM holds the surface, and the agreement is what says so.
    const verdict = judgeReadings([reading(135.107), reading(135.107), reading(135.107)]);
    expect(verdict).toMatchObject({ ok: true, elevationM: 135.107, spreadM: 0, used: 3 });
  });

  it('allows the metre or so a real lake surface moves between flights', () => {
    // Champlain measured 29.6921 and 29.6928 — but rasters are flown years apart, and drawdown and
    // seasonal range are real differences between two correct readings.
    expect(judgeReadings([reading(29.7), reading(31.4)])).toMatchObject({ ok: true });
  });

  it('⚠ keeps a reading three rasters agree on when one old survey dissents', () => {
    // Found by the probe on 200 archived points, and it was the ONLY refusal: three rasters at
    // 86.40 and a 2012 survey at 81.64. The median was already right; a full-range test discarded
    // it anyway — a rule that gets stricter every time USGS adds another survey.
    const verdict = judgeReadings([
      reading(81.64, 'ME_SouthernArea_2012'),
      reading(86.4, 'n45w071'),
      reading(86.4, 'n45w071'),
      reading(86.4, 'ME_SouthCoastal_2020_A20'),
    ]);
    expect(verdict).toMatchObject({ ok: true, elevationM: 86.4 });
    expect(verdict.spreadM).toBeGreaterThan(MAX_RASTER_SPREAD_M);
  });

  it('⚠ refuses when no majority forms, which is a real absence of consensus', () => {
    expect(judgeReadings([reading(10), reading(40), reading(70), reading(100)])).toMatchObject({
      ok: false,
      reason: 'disputed',
    });
  });

  it('takes a lone raster at its word — one product cannot contradict itself', () => {
    expect(judgeReadings([reading(212.5)])).toMatchObject({ ok: true, elevationM: 212.5 });
  });

  it('⚠ refuses the Portland channel on its DEPTH, since its rasters do agree', () => {
    // −48.88 · −22.94 · −22.94 · −22.94: a majority forms at −22.94, so the spread rule passes it
    // and only the sign rule catches it. The two rules were never redundant.
    expect(
      judgeReadings([
        reading(-48.8821, 'ned19_me_south_2010'),
        reading(-22.94, 'ME_SouthCoastal_2020_A20'),
        reading(-22.94, 'n44w071'),
        reading(-22.94, 'n44w071'),
      ]),
    ).toMatchObject({ ok: false, reason: 'below-surface' });
  });

  it('⚠ refuses an agreed depth too — a consensus about a river bottom is still a river bottom', () => {
    // Albany, live: −10.622 and −10.242 from two independent rasters. Spread alone would pass this,
    // which is exactly why the sign rule exists as well. The dredged channel to Albany is
    // maintained at 32 ft ≈ 9.8 m.
    expect(judgeReadings([reading(-10.622), reading(-10.242)])).toMatchObject({
      ok: false,
      reason: 'below-surface',
    });
  });

  it('keeps the coastal ponds that legitimately sit under the datum', () => {
    // Bells Marsh reads −0.2 m and is a real 73-acre Maine marsh. NAVD 88 is a geodetic surface,
    // not local mean sea level, and 152 of the corpus's 153 sub-zero readings live in this band.
    expect(judgeReadings([reading(-0.2), reading(-0.2)])).toMatchObject({ ok: true });
    expect(judgeReadings([reading(-2.84)])).toMatchObject({ ok: true });
  });

  it('⚠ medians rather than trusting the finest raster, which is the one that voids over water', () => {
    // EPQS answers with the highest-resolution raster that has data — and over water the 1 m lidar
    // is precisely the one with no data, so "best available" selects *down* into a coarse product
    // that may have mapped the bottom. A median cannot be dragged by a single outlier.
    expect(judgeReadings([reading(150.1), reading(150.2), reading(150.3)])).toMatchObject({
      elevationM: 150.2,
    });
  });

  it('distinguishes a void with no fallback from a number worth refusing', () => {
    expect(judgeReadings([reading(null), reading(null)])).toMatchObject({
      ok: false,
      reason: 'no-data',
    });
  });
});
