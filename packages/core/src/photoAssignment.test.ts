import { describe, expect, it } from 'vitest';
import {
  assignmentWindow,
  assignPhoto,
  onLake,
  PHOTO_WINDOW_MARGIN_MS,
  photosNearPoint,
} from './photoAssignment';

const H = 3600_000;
const T0 = Date.UTC(2026, 0, 10, 19);
const crystal = { minLat: 43.63, maxLat: 43.65, minLng: -72.15, maxLng: -72.12 };
const mascoma = { minLat: 43.66, maxLat: 43.7, minLng: -72.2, maxLng: -72.12 };

describe('assignPhoto', () => {
  const reports = [
    { reportId: 'm', startMs: T0 - 4.5 * H, endMs: T0 - 3.5 * H, bbox: mascoma },
    { reportId: 'c', startMs: T0 - 2 * H, endMs: T0, bbox: crystal },
  ];

  it('goes by time first: inside a window, with the margin, the nearest end on a tie', () => {
    expect(assignPhoto({ takenAtMs: T0 - H }, reports)).toEqual({ reportId: 'c', by: 'time' });
    expect(assignPhoto({ takenAtMs: T0 + PHOTO_WINDOW_MARGIN_MS }, reports)).toEqual({
      reportId: 'c',
      by: 'time',
    });
    expect(assignPhoto({ takenAtMs: T0 - 3.5 * H }, reports)).toEqual({
      reportId: 'm',
      by: 'time',
    });
    // Two visits to one lake, windows overlapping: the nearer end wins.
    const twice = [
      { reportId: 'a', endMs: T0 - H },
      { reportId: 'b', endMs: T0 },
    ];
    expect(assignPhoto({ takenAtMs: T0 - 1.2 * H }, twice)?.reportId).toBe('a');
    expect(assignPhoto({ takenAtMs: T0 - 0.4 * H }, twice)?.reportId).toBe('b');
  });

  it('falls back to location when the time says nothing, and to the pool when neither does', () => {
    const lunch = T0 - 2.75 * H; // between the two windows
    expect(assignPhoto({ takenAtMs: lunch }, reports)).toBeNull();
    expect(assignPhoto({ takenAtMs: lunch, coord: { lat: 43.64, lng: -72.13 } }, reports)).toEqual({
      reportId: 'c',
      by: 'location',
    });
    expect(assignPhoto({ coord: { lat: 43.68, lng: -72.15 } }, reports)).toEqual({
      reportId: 'm',
      by: 'location',
    });
    expect(assignPhoto({ coord: { lat: 44.5, lng: -73 } }, reports)).toBeNull();
    expect(assignPhoto({}, reports)).toBeNull();
  });

  it('never assigns by time to a Report with no end', () => {
    expect(assignPhoto({ takenAtMs: T0 }, [{ reportId: 'x' }])).toBeNull();
  });
});

describe('the window and the lake', () => {
  it('reaches two hours back without a start', () => {
    expect(assignmentWindow(undefined, T0)).toEqual([
      T0 - 2 * H - PHOTO_WINDOW_MARGIN_MS,
      T0 + PHOTO_WINDOW_MARGIN_MS,
    ]);
    expect(assignmentWindow(T0 - H, T0)).toEqual([
      T0 - H - PHOTO_WINDOW_MARGIN_MS,
      T0 + PHOTO_WINDOW_MARGIN_MS,
    ]);
  });
  it('counts the margin off the box as on the lake, and nothing beyond it', () => {
    expect(onLake({ lat: 43.64, lng: -72.13 }, crystal)).toBe(true);
    // ~150 m north of the box
    expect(onLake({ lat: 43.6513, lng: -72.13 }, crystal)).toBe(true);
    // ~1 km north
    expect(onLake({ lat: 43.66, lng: -72.13 }, crystal)).toBe(false);
    expect(onLake(undefined, crystal)).toBe(false);
    expect(onLake({ lat: 43.64, lng: -72.13 }, undefined)).toBe(false);
  });
  it('suggests the photos near a pin, nearest first', () => {
    const pin = { lat: 43.64, lng: -72.13 };
    const photos = [
      { id: 'far', coord: { lat: 43.7, lng: -72.13 } },
      { id: 'near', coord: { lat: 43.6405, lng: -72.13 } },
      { id: 'nearer', coord: { lat: 43.6401, lng: -72.13 } },
      { id: 'none' },
    ];
    expect(photosNearPoint(photos, pin).map((p) => p.id)).toEqual(['nearer', 'near']);
  });
});
