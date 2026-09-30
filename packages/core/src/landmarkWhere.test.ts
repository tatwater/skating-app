import { describe, expect, it } from 'vitest';
import {
  LANDMARK_SNAP_M,
  landmarkNamedIn,
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

describe('landmarkNamedIn', () => {
  const shelburne = { name: 'Shelburne Point', aliases: [] };
  const town = { name: 'Shelburne', aliases: [] };
  const gut = { name: 'The Gut Passage', aliases: ['the gut passage'] };
  const rock = { name: 'Bird Poop Rock', aliases: ["the gulls' rock"] };

  it('finds the landmark a phrase names, the longest name winning', () => {
    expect(landmarkNamedIn('a wind hole off Shelburne Point', [town, shelburne])).toBe(shelburne);
    expect(landmarkNamedIn('skated to Shelburne and back', [town, shelburne])).toBe(town);
    expect(landmarkNamedIn('through the gut passage', [gut])).toBe(gut);
    expect(landmarkNamedIn("west of the gulls' rock", [rock])).toBe(rock);
  });

  it('names nothing for a part of a word, a generic word alone, a tie, or no match', () => {
    expect(landmarkNamedIn('the gut passageway', [gut])).toBeNull();
    const thePoint = { name: 'The Point', aliases: [] };
    expect(landmarkNamedIn('off Shelburne Point', [thePoint])).toBeNull();
    expect(landmarkNamedIn('a crack off the point', [thePoint])).toBe(thePoint);
    expect(landmarkNamedIn('Point', [thePoint])).toBe(thePoint);
    const theGut = { name: 'The Gut', aliases: [] };
    expect(landmarkNamedIn('open water through the gut', [theGut])).toBe(theGut);
    const longA = { name: 'Long Point', aliases: [] };
    const longB = { name: 'Long Point', aliases: [] };
    expect(landmarkNamedIn('off Long Point', [longA, longB])).toBeNull();
    expect(landmarkNamedIn('off Long Point', [longA])).toBe(longA);
    expect(landmarkNamedIn('north end', [gut, rock])).toBeNull();
    expect(landmarkNamedIn('', [gut])).toBeNull();
  });
});
