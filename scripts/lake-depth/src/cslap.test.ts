import { describe, expect, it } from 'vitest';

import {
  CSLAP_FIELDS,
  CSLAP_PAGE_SIZE,
  cslapFeatures,
  cslapQueryUrl,
  MAX_PLAUSIBLE_CSLAP_MEAN_DEPTH_M,
  parseCslapRow,
} from './cslap';

/** Lake Moraine, exactly as the service returned it on 2026-08-09. */
const MORAINE = {
  CSLAP_Number: '18',
  Lake_Name: 'Lake Moraine',
  Elevation__meters_: '369',
  Area__hectares_: 101,
  Mean_Depth__meters_: 5.5,
  County: 'Madison',
  Town: 'Hamilton',
  Latitude: 42.85575841,
  Longitude: -75.51734423,
  Last_Year_Sampled: '2024',
  Sampling_Years: '1986-2024',
};

describe('parseCslapRow', () => {
  it('reads a real row whole', () => {
    const out = parseCslapRow(MORAINE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lake).toMatchObject({
      cslapNumber: '18',
      name: 'Lake Moraine',
      meanDepthM: 5.5,
      surfaceAreaHa: 101,
      county: 'Madison',
      lastYearSampled: '2024',
    });
    expect(out.lake.lat).toBeCloseTo(42.8558, 3);
    expect(out.lake.lng).toBeCloseTo(-75.5173, 3);
  });

  it('takes the WGS84 attributes, not the Web Mercator geometry', () => {
    // The service returns `geometry: {x: -8406552, y: 5290042}` for this same lake. Reading that
    // instead would put Lake Moraine several thousand kilometres into the Atlantic, and the point
    // is the join key — so this is the one column pair that must never be confused.
    const out = parseCslapRow(MORAINE);
    if (!out.ok) throw new Error('expected a lake');
    expect(Math.abs(out.lake.lat)).toBeLessThan(90);
    expect(Math.abs(out.lake.lng)).toBeLessThan(180);
  });

  it('refuses the 16 rows of 294 that publish no depth', () => {
    expect(parseCslapRow({ ...MORAINE, Mean_Depth__meters_: null })).toEqual({
      ok: false,
      reason: 'no-depth',
    });
    expect(parseCslapRow({ ...MORAINE, Mean_Depth__meters_: '' })).toEqual({
      ok: false,
      reason: 'no-depth',
    });
    // Zero is a published number and still not a depth. Reading it as one would put a "0 m" lake in
    // front of a skater, which is the one reading worse than none.
    expect(parseCslapRow({ ...MORAINE, Mean_Depth__meters_: 0 })).toEqual({
      ok: false,
      reason: 'no-depth',
    });
  });

  it('accepts Seneca Lake, which is the deepest real value in the file', () => {
    // 88.6 m is the published mean of Seneca Lake and is the maximum over all 278 rows. A backstop
    // that refused it would be refusing the source's own data.
    const out = parseCslapRow({ ...MORAINE, Lake_Name: 'Seneca Lake', Mean_Depth__meters_: 88.6 });
    expect(out.ok).toBe(true);
    expect(MAX_PLAUSIBLE_CSLAP_MEAN_DEPTH_M).toBeGreaterThan(88.6);
  });

  it('refuses a depth past the backstop, which means a units error rather than a lake', () => {
    expect(parseCslapRow({ ...MORAINE, Mean_Depth__meters_: 5.5 * 1000 })).toEqual({
      ok: false,
      reason: 'implausible',
    });
  });

  it('refuses a coordinate outside New York, because that means the columns were read across', () => {
    // Latitude and longitude swapped: the classic failure, and it lands in the Indian Ocean rather
    // than erroring, so nothing but a bounds check catches it.
    expect(parseCslapRow({ ...MORAINE, Latitude: -75.51, Longitude: 42.85 })).toEqual({
      ok: false,
      reason: 'no-coordinate',
    });
    expect(parseCslapRow({ ...MORAINE, Latitude: null })).toEqual({
      ok: false,
      reason: 'no-coordinate',
    });
  });

  it('refuses a row with no lake number or no name', () => {
    expect(parseCslapRow({ ...MORAINE, CSLAP_Number: null }).ok).toBe(false);
    expect(parseCslapRow({ ...MORAINE, Lake_Name: '  ' }).ok).toBe(false);
  });

  it('treats a zero or absent area as absent rather than as zero acres', () => {
    const out = parseCslapRow({ ...MORAINE, Area__hectares_: 0 });
    if (!out.ok) throw new Error('expected a lake');
    expect(out.lake.surfaceAreaHa).toBeUndefined();
  });
});

describe('cslapQueryUrl', () => {
  it('asks for named fields and no geometry', () => {
    const url = new URL(cslapQueryUrl(0));
    expect(url.searchParams.get('outFields')).toBe(CSLAP_FIELDS.join(','));
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('f')).toBe('json');
    // Without an order the offset does not define a stable page, and `resultOffset` silently
    // re-serves rows. The snapshot counts duplicates for the same reason.
    expect(url.searchParams.get('orderByFields')).toBe('ObjectId');
  });

  it('pages by offset', () => {
    const url = new URL(cslapQueryUrl(CSLAP_PAGE_SIZE));
    expect(url.searchParams.get('resultOffset')).toBe(String(CSLAP_PAGE_SIZE));
    expect(url.searchParams.get('resultRecordCount')).toBe(String(CSLAP_PAGE_SIZE));
  });
});

describe('cslapFeatures', () => {
  it('returns the features array', () => {
    expect(cslapFeatures('{"features":[{"attributes":{"a":1}}]}')).toHaveLength(1);
    expect(cslapFeatures('{"features":[]}')).toEqual([]);
  });

  it('names an ArcGIS error rather than reading zero rows out of it', () => {
    // ArcGIS answers a bad query with HTTP 200 and an `error` object. Treating that as "no lakes
    // today" is how a lane silently stops covering a state.
    expect(() =>
      cslapFeatures('{"error":{"message":"Invalid field: Mean_Depth","details":["bad field"]}}'),
    ).toThrow(/Invalid field: Mean_Depth.*bad field/s);
  });

  it('names a non-JSON body, which is what an outage looks like here', () => {
    expect(() => cslapFeatures('<html>502 Bad Gateway</html>')).toThrow(/did not return JSON/);
  });

  it('refuses a response with no features array at all', () => {
    expect(() => cslapFeatures('{"count":294}')).toThrow(/no `features` array/);
  });
});
