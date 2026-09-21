import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { haversineMeters } from './geometry';
import type { PassedTrackPoint } from './passedHazards';
import {
  PHOTO_WINDOW_PAD_MS,
  photosInWindow,
  photoWindow,
  placePhoto,
  sameDayWindow,
} from './photoWindow';
import { zonedParts } from './zonedTime';

const START = Date.UTC(2026, 0, 10, 15, 0);
const END = Date.UTC(2026, 0, 10, 17, 0);
const ACTIVITY = { startMs: START, endMs: END };

describe('windows', () => {
  it('pads the activity on both sides by default', () => {
    expect(photoWindow(ACTIVITY)).toEqual({
      startMs: START - PHOTO_WINDOW_PAD_MS,
      endMs: END + PHOTO_WINDOW_PAD_MS,
    });
    expect(photoWindow(ACTIVITY, 0)).toEqual(ACTIVITY);
  });

  it('the same-day window is the local day of the activity end', () => {
    const w = sameDayWindow(ACTIVITY, 'America/New_York');
    const start = zonedParts(w.startMs, 'America/New_York');
    const end = zonedParts(w.endMs - 1, 'America/New_York');
    expect([start.hour, start.minute]).toEqual([0, 0]);
    expect([end.hour, end.minute]).toEqual([23, 59]);
    expect(start.day).toBe(10);
    expect(end.day).toBe(10);
    expect(w.endMs - w.startMs).toBe(24 * 3_600_000);
  });

  it('selects dated photos in the window, oldest first; undated never match', () => {
    const photos = [
      { id: 'late', takenAtMs: END + 10 },
      { id: 'mid', takenAtMs: START + 60_000 },
      { id: 'early', takenAtMs: START },
      { id: 'undated' },
      { id: 'before', takenAtMs: START - 1 },
    ];
    expect(photosInWindow(photos, ACTIVITY).map((p) => p.id)).toEqual(['early', 'mid']);
  });
});

const TRACK: PassedTrackPoint[] = [
  { lat: 44.0, lng: -73.0, timestamp: START },
  { lat: 44.01, lng: -73.0, timestamp: START + 600_000 },
  { lat: 44.01, lng: -73.02, timestamp: START + 1_200_000 },
];

describe('placePhoto', () => {
  it('prefers the EXIF coordinate', () => {
    expect(placePhoto({ id: 'p', coord: { lat: 1, lng: 2 }, takenAtMs: START }, TRACK)).toEqual({
      coord: { lat: 1, lng: 2 },
      source: 'exif',
    });
  });

  it('interpolates along the track at the taken time', () => {
    const placed = placePhoto({ id: 'p', takenAtMs: START + 300_000 }, TRACK);
    expect(placed?.source).toBe('path');
    expect(placed?.coord.lat).toBeCloseTo(44.005, 9);
    expect(placed?.coord.lng).toBeCloseTo(-73.0, 9);
    expect(placed?.gapMeters).toBeCloseTo(
      haversineMeters({ lat: 44.005, lng: -73 }, TRACK[0] as PassedTrackPoint),
      3,
    );
  });

  it('clamps to the track ends outside its time span', () => {
    expect(placePhoto({ id: 'p', takenAtMs: START - 1 }, TRACK)?.coord).toEqual({
      lat: 44.0,
      lng: -73.0,
    });
    expect(placePhoto({ id: 'p', takenAtMs: START + 9_999_999 }, TRACK)?.coord).toEqual({
      lat: 44.01,
      lng: -73.02,
    });
  });

  it('returns null with nothing to go on', () => {
    expect(placePhoto({ id: 'p' }, TRACK)).toBeNull();
    expect(placePhoto({ id: 'p', takenAtMs: START }, [])).toBeNull();
  });

  it('a path placement always lies between the two bracketing fixes (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: START, max: START + 1_200_000 }), (t) => {
        const placed = placePhoto({ id: 'p', takenAtMs: t }, TRACK);
        expect(placed?.source).toBe('path');
        const { lat, lng } = placed?.coord as { lat: number; lng: number };
        expect(lat).toBeGreaterThanOrEqual(44.0);
        expect(lat).toBeLessThanOrEqual(44.01);
        expect(lng).toBeGreaterThanOrEqual(-73.02);
        expect(lng).toBeLessThanOrEqual(-73.0);
      }),
    );
  });
});
