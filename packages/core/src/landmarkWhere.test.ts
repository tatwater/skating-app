import { describe, expect, it } from 'vitest';
import {
  LANDMARK_SNAP_M,
  landmarkPoint,
  landmarksForSheet,
  nearestLandmark,
  pointFromTap,
  type SheetLandmark,
  searchLandmarks,
} from './landmarkWhere';

function lm(name: string, extra: Partial<SheetLandmark> = {}): SheetLandmark {
  return {
    _id: `id-${name}`,
    name,
    kind: 'island',
    point: { lat: 44.5, lng: -73.3 },
    aliases: [],
    prominence: 2,
    ...extra,
  };
}

const apple = lm('Apple Island', { prominence: 9, point: { lat: 44.6, lng: -73.3 } });
const gull = lm('Gull Rock', {
  prominence: 2,
  point: { lat: 44.5, lng: -73.3 },
  subAreaId: 'bay1',
});
const cedar = lm('Cedar Island', {
  prominence: 2,
  point: { lat: 44.7, lng: -73.3 },
  aliases: ['Cedar Is'],
});

describe('landmarksForSheet', () => {
  it('ranks by prominence, then nearness to the put-in, then name, and says how many more', () => {
    expect(landmarksForSheet([gull, cedar, apple], { limit: 2 })).toEqual({
      chips: [apple, cedar],
      more: 1,
    });
    // Near the south: Gull outranks the equally prominent Cedar.
    expect(
      landmarksForSheet([cedar, gull, apple], { near: { lat: 44.49, lng: -73.3 } }).chips.map(
        (l) => l.name,
      ),
    ).toEqual(['Apple Island', 'Gull Rock', 'Cedar Island']);
  });

  it('scopes to the chosen bay', () => {
    expect(landmarksForSheet([gull, cedar, apple], { subAreaId: 'bay1' })).toEqual({
      chips: [gull],
      more: 0,
    });
  });
});

describe('searchLandmarks', () => {
  it('finds by any spelling, most prominent first, and nothing for an empty query', () => {
    expect(searchLandmarks([gull, cedar, apple], 'is').map((l) => l.name)).toEqual([
      'Apple Island',
      'Cedar Island',
    ]);
    expect(searchLandmarks([cedar], 'cedar is')).toEqual([cedar]);
    expect(searchLandmarks([cedar], '  ')).toEqual([]);
  });
});

describe('a tap on the lake', () => {
  it('takes the name of a landmark within the snap, and keeps where it landed', () => {
    const tap = { lat: 44.5005, lng: -73.3 };
    expect(nearestLandmark(tap, [apple, gull])).toBe(gull);
    expect(pointFromTap(tap, [apple, gull], 75)).toEqual({
      coord: tap,
      radiusMeters: 75,
      name: 'Gull Rock',
      landmarkId: 'id-Gull Rock',
    });
  });

  it('stays an unnamed tap beyond the snap', () => {
    const far = { lat: 44.55, lng: -73.3 };
    expect(nearestLandmark(far, [apple, gull])).toBeNull();
    expect(pointFromTap(far, [apple, gull], 75)).toEqual({ coord: far, radiusMeters: 75 });
    expect(LANDMARK_SNAP_M).toBeGreaterThan(75);
  });

  it('a chosen landmark is its own point, name and id', () => {
    expect(landmarkPoint(apple, 150)).toEqual({
      coord: apple.point,
      radiusMeters: 150,
      name: 'Apple Island',
      landmarkId: 'id-Apple Island',
    });
  });
});
