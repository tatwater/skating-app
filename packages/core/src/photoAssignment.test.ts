import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  assignmentWindow,
  assignPhoto,
  onLake,
  onWater,
  PHOTO_PLACE_SHORE_SETBACK_M,
  PHOTO_WINDOW_MARGIN_MS,
  photosNearPoint,
  placeOnLake,
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

describe('onWater — the test that places a photo by itself', () => {
  // Crystal's box with its north-east quarter dry (a cove's far side, a hill of houses), and an
  // island near the south-west. Every point below is inside the box.
  const outline: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-72.15, 43.63],
        [-72.12, 43.63],
        [-72.12, 43.64],
        [-72.135, 43.64],
        [-72.135, 43.65],
        [-72.15, 43.65],
        [-72.15, 43.63],
      ],
      [
        [-72.146, 43.634],
        [-72.144, 43.634],
        [-72.144, 43.636],
        [-72.146, 43.636],
        [-72.146, 43.634],
      ],
    ],
  };

  it('places open water, and nothing the box holds that the water does not', () => {
    expect(onWater({ lat: 43.635, lng: -72.128 }, outline)).toBe(true);
    // The dry quarter: on the lake by the box (assignment), never placed.
    const dry = { lat: 43.645, lng: -72.125 };
    expect(onLake(dry, crystal)).toBe(true);
    expect(onWater(dry, outline)).toBe(false);
    // The island, and the water beside it.
    expect(onWater({ lat: 43.635, lng: -72.145 }, outline)).toBe(false);
    expect(onWater({ lat: 43.6363, lng: -72.145 }, outline)).toBe(false);
  });

  it(`keeps ${PHOTO_PLACE_SHORE_SETBACK_M} m off every shore`, () => {
    // ~33 m and ~67 m north of the south shore.
    expect(onWater({ lat: 43.6303, lng: -72.14 }, outline)).toBe(false);
    expect(onWater({ lat: 43.6306, lng: -72.14 }, outline)).toBe(true);
  });

  it('places nothing without an outline or a coordinate', () => {
    expect(onWater({ lat: 43.635, lng: -72.128 }, undefined)).toBe(false);
    expect(onWater({ lat: 43.635, lng: -72.128 }, null)).toBe(false);
    expect(onWater(undefined, outline)).toBe(false);
  });
});

describe('placeOnLake — where a phone photo sits when it is added', () => {
  const outline: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-72.15, 43.63],
        [-72.12, 43.63],
        [-72.12, 43.65],
        [-72.15, 43.65],
        [-72.15, 43.63],
      ],
    ],
  };
  const water = { lat: 43.64, lng: -72.135 };
  const shore = { lat: 43.6301, lng: -72.135 };
  const home = { lat: 43.7, lng: -72.3 };
  // A track from the launch (on the south shore) out onto the water, one fix per ten minutes.
  const track = [
    { lat: 43.6301, lng: -72.135, timestamp: T0 },
    { lat: 43.64, lng: -72.135, timestamp: T0 + H / 6 },
    { lat: 43.645, lng: -72.13, timestamp: T0 + H / 3 },
  ];

  it('places a photo by its own location on the water', () => {
    expect(placeOnLake({ coord: water }, outline, [])).toEqual({ coord: water, placeOnMap: true });
  });

  it('keeps a location off the water, unplaced', () => {
    expect(placeOnLake({ coord: home }, outline, [])).toEqual({ coord: home, placeOnMap: false });
  });

  it('places an unlocated photo where the track was, on the water', () => {
    const got = placeOnLake({ takenAtMs: T0 + H / 6 }, outline, track);
    expect(got.placeOnMap).toBe(true);
    expect(got.coord?.lat).toBeCloseTo(43.64, 6);
  });

  it('never places a photo at the launch a shutter before the first fix clamps to (D58)', () => {
    expect(placeOnLake({ takenAtMs: T0 - H }, outline, track)).toEqual({ placeOnMap: false });
    expect(onWater(shore, outline)).toBe(false);
  });

  it('prefers the track to a location off the water, and keeps the location when the track fails', () => {
    expect(placeOnLake({ coord: home, takenAtMs: T0 + H / 3 }, outline, track).placeOnMap).toBe(
      true,
    );
    expect(placeOnLake({ coord: home, takenAtMs: T0 - H }, outline, track)).toEqual({
      coord: home,
      placeOnMap: false,
    });
  });

  it('needs two fixes and an outline', () => {
    expect(placeOnLake({ takenAtMs: T0 }, outline, track.slice(0, 1))).toEqual({
      placeOnMap: false,
    });
    expect(placeOnLake({ coord: water }, undefined, track)).toEqual({
      coord: water,
      placeOnMap: false,
    });
  });
});
