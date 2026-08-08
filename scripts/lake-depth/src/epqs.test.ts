/**
 * The 3DEP lane's pure half, against readings the live service actually returned (N7-2).
 *
 * Every fixture below is a real EPQS response body captured on 2026-08-08, not an invented one —
 * including the resolution quirk, which no amount of reading the docs would have predicted.
 */

import { describe, expect, it } from 'vitest';
import {
  COORDINATE_KEY_PLACES,
  coordinateKey,
  type EpqsOutcome,
  epqsUrl,
  parseEpqsResponse,
  resolutionMetres,
} from './epqs';

/** The live response for Paugus Bay's interior point — Winnipesaukee's surface, from 1 m LiDAR. */
const PAUGUS = {
  location: { x: -71.4661, y: 43.5586, spatialReference: { wkid: 4326, latestWkid: 4326 } },
  locationId: 0,
  value: '153.117904663',
  rasterId: 113_923,
  resolution: 1,
  attributes: { AcquisitionDate: '3/5/2016' },
};

const reading = (outcome: EpqsOutcome) => {
  if (!outcome.ok) throw new Error(`expected a reading, got ${outcome.reason}`);
  return outcome.reading;
};

describe('coordinateKey', () => {
  it('is stable across float formatting of the same place', () => {
    // The reason the archive rounds at all: `44.5` and the same number arrived at by arithmetic
    // are one place, and two keys would spend two requests to learn one number. Written as a sum
    // rather than as the drifted literal, which is both how it actually arises and the only form
    // that is not itself a lint error.
    expect(coordinateKey(44.5, -71.5)).toBe(coordinateKey(0.1 + 0.2 + 44.2, -71.5));
  });

  it('keeps a resolution finer than 3DEP itself, so two real points never collide', () => {
    // Five places is ~1.1 m at our latitude, against a 1 m posting. Rounding can never merge two
    // points the DEM would have distinguished.
    expect(COORDINATE_KEY_PLACES).toBe(5);
    expect(coordinateKey(44.50001, -71.5)).not.toBe(coordinateKey(44.50002, -71.5));
  });

  it('refuses a non-finite coordinate rather than keying on "NaN"', () => {
    // A `NaN,NaN` key would archive one entry and satisfy every later lookup for a broken point.
    expect(() => coordinateKey(Number.NaN, -71.5)).toThrow(/finite/);
  });
});

describe('epqsUrl', () => {
  it('sends x as longitude and y as latitude, which is the trap in this API', () => {
    const url = new URL(epqsUrl(43.5586, -71.4661));
    expect(url.searchParams.get('x')).toBe('-71.4661');
    expect(url.searchParams.get('y')).toBe('43.5586');
    expect(url.searchParams.get('units')).toBe('Meters');
    expect(url.searchParams.get('wkid')).toBe('4326');
  });

  it('asks for the acquisition date, which is what makes a stale raster visible', () => {
    expect(new URL(epqsUrl(44, -71)).searchParams.get('includeDate')).toBe('true');
  });
});

describe('parseEpqsResponse', () => {
  it('reads Paugus Bay at Winnipesaukee’s published surface', () => {
    // 153.1 m against a published 504 ft (153.6 m) — and `Melvin Bay`, a different point on the
    // same lake, returned the identical figure. That agreement is the lane's acceptance test.
    const got = reading(parseEpqsResponse(PAUGUS, 43.5586));
    expect(got.elevationM).toBeCloseTo(153.12, 2);
    expect(got.resolutionM).toBe(1);
    expect(got.rasterId).toBe(113_923);
    expect(got.acquisitionDate).toBe('3/5/2016');
  });

  it('refuses the no-data sentinel rather than storing -1,000,000 as an elevation', () => {
    const out = parseEpqsResponse({ ...PAUGUS, value: '-1000000' }, 43.5);
    expect(out).toMatchObject({ ok: false, reason: 'implausible' });
  });

  it('refuses a reading above the highest ground in the region', () => {
    // Mount Washington is 1,917 m and a lake surface sits far below any summit; the window exists
    // to catch a sentinel or a transposed coordinate, not to adjudicate a real reading.
    expect(parseEpqsResponse({ ...PAUGUS, value: '9000' }, 43.5)).toMatchObject({
      ok: false,
      reason: 'implausible',
    });
  });

  it('calls an HTML error page unparseable rather than crashing on it', () => {
    // A proxy or an outage returns a document, not JSON. It must be counted, not thrown.
    expect(parseEpqsResponse('<html>502 Bad Gateway</html>', 44)).toMatchObject({
      ok: false,
      reason: 'unparseable',
    });
    expect(parseEpqsResponse(null, 44)).toMatchObject({ ok: false, reason: 'unparseable' });
    // `JSON.stringify(undefined)` is itself `undefined`, so the sample-capture path has to survive
    // a body that cannot be stringified at all rather than throwing while reporting a failure.
    expect(parseEpqsResponse(undefined, 44)).toEqual({ ok: false, reason: 'unparseable', raw: '' });
    expect(parseEpqsResponse({ location: {} }, 44)).toMatchObject({
      ok: false,
      reason: 'unparseable',
    });
  });

  it('accepts a numeric value as well as the string form the service actually sends', () => {
    expect(reading(parseEpqsResponse({ value: 153.1 }, 43.5)).elevationM).toBe(153.1);
  });

  it('leaves the optional fields off rather than inventing them', () => {
    const got = reading(parseEpqsResponse({ value: '153.1' }, 43.5));
    expect(got.rasterId).toBeUndefined();
    expect(got.acquisitionDate).toBeUndefined();
    expect(got.resolutionM).toBeUndefined();
  });

  it('treats an empty acquisition date as absent', () => {
    const got = reading(
      parseEpqsResponse({ ...PAUGUS, attributes: { AcquisitionDate: '' } }, 43.5),
    );
    expect(got.acquisitionDate).toBeUndefined();
  });
});

describe('resolutionMetres — because 3DEP does not always answer in metres', () => {
  it('passes a metre figure through', () => {
    expect(resolutionMetres(1, 44)).toBe(1);
    expect(resolutionMetres(30, 44)).toBe(30);
  });

  it('converts the degree-expressed form the Frost Cove tile returned', () => {
    // Measured 2026-08-08: 44 of 45 probes returned `1`, and this one returned
    // 0.00003086419871794868 — not a 31-micrometre DEM, but 3.4 m as a fraction of a degree.
    // Storing both raw would silently break D104's "re-stamp the coarse ones" comparison.
    const metres = resolutionMetres(0.00003086419871794868, 44.99);
    expect(metres).toBeGreaterThan(2);
    expect(metres).toBeLessThan(5);
  });

  it('reads a string, which is how several numeric fields arrive here', () => {
    expect(resolutionMetres('10', 44)).toBe(10);
  });

  it('returns undefined for a missing or nonsensical value rather than guessing', () => {
    expect(resolutionMetres(undefined, 44)).toBeUndefined();
    expect(resolutionMetres(0, 44)).toBeUndefined();
    expect(resolutionMetres(-1, 44)).toBeUndefined();
    expect(resolutionMetres('nope', 44)).toBeUndefined();
    expect(resolutionMetres(null, 44)).toBeUndefined();
  });
});
