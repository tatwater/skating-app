/**
 * A landmark's catalog ids are bounded by their total length, never by their count (B01-3j): the one
 * rule (`landmarkIdsToKeep`) every writer of them uses. Pinned seeds plus one random run.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  landmarkIdsToKeep,
  MAX_EXTERNAL_ID_CHARS,
  MAX_LANDMARK_EXTERNAL_ID_CHARS,
} from './textCaps';

const way = (n: number) => `osm:way/${String(n).padStart(10, '0')}`;
/** An id as long as the measured waterways' average: Monument Brook's 142 come to about 3,550. */
const measured = (n: number) => `osm:way/${String(n).padStart(17, '0')}`;
const total = (ids: readonly string[]) => ids.reduce((sum, id) => sum + id.length, 0);
/** Repeats folded at their last place — written out here, not by the rule under test. */
const lastPlaces = (list: readonly string[]) => {
  const last = new Map(list.map((id, i) => [id, i]));
  return list.filter((id, i) => last.get(id) === i);
};

describe('landmarkIdsToKeep', () => {
  it('the waterways measured on dev fit with at least four times the room', () => {
    const counts = [142, 120, 64, 56, 54, 53, 47, 46, 44, 44, 42, 40, 40, 38, 37, 36, 34, 34];
    for (const count of counts) {
      const ids = Array.from({ length: count }, (_, i) => measured(i));
      expect(landmarkIdsToKeep(ids)).toEqual({ kept: ids, dropped: 0 });
      expect(total(ids) * 4).toBeLessThanOrEqual(MAX_LANDMARK_EXTERNAL_ID_CHARS);
    }
  });

  it('past the total, the newest that fit are kept and the oldest dropped', () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => way(i));
    const { kept, dropped } = landmarkIdsToKeep(ids);
    expect(total(kept)).toBeLessThanOrEqual(MAX_LANDMARK_EXTERNAL_ID_CHARS);
    expect(kept).toEqual(ids.slice(dropped));
    expect(dropped).toBeGreaterThan(0);
    expect(total([...kept, ids[dropped - 1] as string])).toBeGreaterThan(
      MAX_LANDMARK_EXTERNAL_ID_CHARS,
    );
  });

  it('a repeat takes its newest place: a still-used id outranks one that left the catalogs', () => {
    // Stored [used, left]; this run's catalogs say [used, added]; two of the four fit.
    const half = MAX_LANDMARK_EXTERNAL_ID_CHARS / 2;
    const used = 'u'.repeat(half);
    const left = 'l'.repeat(half);
    const added = 'a'.repeat(half);
    expect(landmarkIdsToKeep([used, left, used, added])).toEqual({
      kept: [used, added],
      dropped: 1,
    });
  });

  it('a row past the total keeps the same ids run after run', () => {
    const catalog = Array.from({ length: 200 }, (_, i) => `osm:way/${String(i).padStart(92, '0')}`);
    const first = landmarkIdsToKeep(catalog);
    expect(first.dropped).toBeGreaterThan(0);
    // The next load folds the stored ids before the catalogs' list, as `idsOf` does.
    const again = landmarkIdsToKeep([...first.kept, ...catalog]);
    expect(again.kept).toEqual(first.kept);
  });

  const ids = fc.array(
    fc.oneof(
      fc.integer({ min: 0, max: 400 }).map(way),
      fc.string({ minLength: 1, maxLength: MAX_EXTERNAL_ID_CHARS }),
    ),
    { maxLength: 600 },
  );
  const property = fc.property(ids, (list) => {
    const distinct = lastPlaces(list);
    const { kept, dropped } = landmarkIdsToKeep(list);
    // The stored total never passes the cap.
    expect(total(kept)).toBeLessThanOrEqual(MAX_LANDMARK_EXTERNAL_ID_CHARS);
    // Only the oldest go, and only when the whole list is over; nothing within it is lost.
    expect(kept).toEqual(distinct.slice(dropped));
    if (total(distinct) <= MAX_LANDMARK_EXTERNAL_ID_CHARS) expect(dropped).toBe(0);
    else
      expect(total([distinct[dropped - 1] as string, ...kept])).toBeGreaterThan(
        MAX_LANDMARK_EXTERNAL_ID_CHARS,
      );
  });
  for (const seed of [1, 42, 20_261_115]) {
    it(`never over the cap, only the oldest dropped, nothing within it lost (seed ${seed})`, () => {
      fc.assert(property, { seed, numRuns: 150 });
    });
  }
  it('never over the cap, only the oldest dropped, nothing within it lost (a random seed)', () => {
    fc.assert(property, { numRuns: 150 });
  });
});
