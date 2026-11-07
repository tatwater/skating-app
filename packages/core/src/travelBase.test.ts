import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  driveOrigin,
  isTravelBaseActive,
  isValidTravelBaseUntil,
  TRAVEL_BASE_MAX_MS,
  viewerDriveTime,
} from './driveTime';

const HOME = { lat: 43.6, lng: -72.1 };
const AWAY = { lat: 44.5, lng: -73.2 };
const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

const instant = fc.integer({ min: 0, max: 4_000_000_000_000 });
const span = fc.integer({ min: -TRAVEL_BASE_MAX_MS * 2, max: TRAVEL_BASE_MAX_MS * 2 });

describe('the travel-base window (B03 §11, board 7.19)', () => {
  it('is half-open: in force strictly before `until`, home again at `until`', () => {
    fc.assert(
      fc.property(instant, span, (now, offset) => {
        const base = { coord: AWAY, until: now + offset };
        expect(isTravelBaseActive(base, now)).toBe(offset > 0);
        expect(driveOrigin({ homeCoord: HOME, travelBase: base }, now)).toEqual(
          offset > 0 ? AWAY : HOME,
        );
      }),
    );
  });

  it('a base can only be set for a future end inside the cap', () => {
    fc.assert(
      fc.property(instant, span, (now, offset) => {
        expect(isValidTravelBaseUntil(now + offset, now)).toBe(
          offset > 0 && offset <= TRAVEL_BASE_MAX_MS,
        );
      }),
    );
    expect(isValidTravelBaseUntil(Number.NaN, 0)).toBe(false);
    expect(isValidTravelBaseUntil(Number.POSITIVE_INFINITY, 0)).toBe(false);
  });

  it('a valid base is always in force the moment it is set, and never past the cap', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: 1, max: TRAVEL_BASE_MAX_MS }), (now, offset) => {
        const base = { coord: AWAY, until: now + offset };
        expect(isValidTravelBaseUntil(base.until, now)).toBe(true);
        expect(isTravelBaseActive(base, now)).toBe(true);
        expect(isTravelBaseActive(base, now + TRAVEL_BASE_MAX_MS)).toBe(false);
      }),
    );
  });

  it('no base, no home: no origin', () => {
    expect(driveOrigin({}, 0)).toBeUndefined();
    expect(isTravelBaseActive(undefined, 0)).toBe(false);
  });
});

describe('viewerDriveTime', () => {
  const bands = { band30: SQUARE, band60: SQUARE };

  it('no profile reads as no bands', () => {
    expect(viewerDriveTime(null, 0)).toEqual({ bands: {}, origin: undefined });
  });

  it('legacy bands with no stamped origin were drawn from home, and answer for it', () => {
    expect(
      viewerDriveTime({ homeCoord: HOME, cachedIsochrones: bands, outerRadiusMeters: 9 }, 0),
    ).toEqual({ bands: { band30: SQUARE, band60: SQUARE, outerRadiusMeters: 9 }, origin: HOME });
  });

  it('unstamped (legacy) polygons stand aside for a base too', () => {
    const profile = {
      homeCoord: HOME,
      travelBase: { coord: AWAY, until: 100 },
      cachedIsochrones: bands,
    };
    expect(viewerDriveTime(profile, 50)).toEqual({ bands: {}, origin: AWAY });
    expect(viewerDriveTime(profile, 100).bands.band30).toBe(SQUARE);
  });

  it('polygons drawn from home stop answering the moment a base is in force', () => {
    const profile = {
      homeCoord: HOME,
      travelBase: { coord: AWAY, until: 100 },
      cachedIsochrones: bands,
      cachedIsochronesOrigin: HOME,
      outerRadiusMeters: 9,
    };
    // The recompute hasn't landed: the 90 band moves with the origin, the polygons are held back.
    expect(viewerDriveTime(profile, 50)).toEqual({
      bands: { outerRadiusMeters: 9 },
      origin: AWAY,
    });
    // Past `until`, home's polygons fit again.
    expect(viewerDriveTime(profile, 100).bands.band30).toBe(SQUARE);
  });

  it('polygons drawn from the base answer while it is in force, and not after', () => {
    const profile = {
      homeCoord: HOME,
      travelBase: { coord: AWAY, until: 100 },
      cachedIsochrones: { band30: SQUARE },
      cachedIsochronesOrigin: AWAY,
    };
    expect(viewerDriveTime(profile, 50)).toEqual({ bands: { band30: SQUARE }, origin: AWAY });
    expect(viewerDriveTime(profile, 100)).toEqual({ bands: {}, origin: HOME });
  });

  it('whatever the clock, a polygon is only ever served for the origin it was drawn from', () => {
    const coord = fc.constantFrom(HOME, AWAY, { lat: 0, lng: 0 });
    fc.assert(
      fc.property(instant, span, coord, coord, (now, offset, base, drawnFrom) => {
        const profile = {
          homeCoord: HOME,
          travelBase: { coord: base, until: now + offset },
          cachedIsochrones: bands,
          cachedIsochronesOrigin: drawnFrom,
        };
        const { bands: out, origin } = viewerDriveTime(profile, now);
        if (out.band30 !== undefined) expect(origin).toEqual(drawnFrom);
      }),
    );
  });
});
