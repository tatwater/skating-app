import { describe, expect, it } from 'vitest';
import {
  BASE_INTERVAL_FT,
  chooseInterval,
  contourLevels,
  MAX_BANDS,
  thinPublishedLevels,
} from './interval';

const PLENTY = 100_000;

describe('contourLevels', () => {
  it('walks the interval up to but not past the deepest reading', () => {
    expect(contourLevels(36, 5)).toEqual([5, 10, 15, 20, 25, 30, 35]);
  });

  it('excludes zero — the shoreline is the polygon, not a contour', () => {
    // Drawing it would double-stroke every lake edge in the contour palette, at exactly the place D82
    // says a contour must lose to anything competing with it.
    expect(contourLevels(20, 5)).not.toContain(0);
  });

  it('excludes a level exactly at the maximum, which is a ring around one reading', () => {
    expect(contourLevels(20, 5)).toEqual([5, 10, 15]);
  });

  it('is empty for a lake with no measured depth', () => {
    expect(contourLevels(0, 5)).toEqual([]);
    expect(contourLevels(-3, 5)).toEqual([]);
    expect(contourLevels(30, 0)).toEqual([]);
  });
});

describe('chooseInterval', () => {
  it('puts every well-measured lake on the same 5 ft ladder', () => {
    // The founder's call: a fixed interval, so ring COUNT reads as depth across lakes rather than
    // every lake being normalised to a dozen bands.
    for (const depth of [17, 23, 29, 36, 42, 48, 59]) {
      expect(chooseInterval(depth, PLENTY).intervalFt).toBe(BASE_INTERVAL_FT);
    }
  });

  it('gives a shallow pond few rings and a deep lake many — which is the point', () => {
    expect(chooseInterval(17, PLENTY).levels).toEqual([5, 10, 15]);
    expect(chooseInterval(59, PLENTY).levels).toHaveLength(11);
  });

  it('fixes the case that started this: 36 ft on 105 soundings is 7 rings, not 17', () => {
    // Washington Pond. The old depth-only rule chose a 2 ft interval and drew 17 levels through 105
    // measurements, where Maine IF&W's own chart of the same lake uses 5 ft and 10 ft.
    const choice = chooseInterval(36, 105);
    expect(choice.intervalFt).toBe(5);
    expect(choice.levels).toHaveLength(7);
  });

  it('coarsens for depth rather than drawing 79 rings on Champlain', () => {
    const choice = chooseInterval(399, PLENTY);
    expect(choice.levels.length).toBeLessThanOrEqual(MAX_BANDS);
    expect(choice.coarsenedBy).toBe('depth');
    // Still a whole multiple of the base, so its rings nest with every other lake's.
    expect(choice.intervalFt % BASE_INTERVAL_FT).toBe(0);
  });

  it('coarsens for thin data, and says that is why', () => {
    // Horserace Ponds: 48 ft, but its readings collapse to ~24 independent cells. Nine rings would be
    // nine claims about a basin measured two dozen times.
    const choice = chooseInterval(48, 24);
    expect(choice.intervalFt).toBeGreaterThan(BASE_INTERVAL_FT);
    expect(choice.coarsenedBy).toBe('data support');
    expect(choice.levels.length).toBeLessThanOrEqual(Math.floor(24 / 5));
  });

  it('never goes finer than the base, however much data there is', () => {
    // The failure being fixed was too many lines on too little data. No lake earns a denser picture
    // than the standard, so the ladder only ever steps up.
    for (const depth of [4, 9, 17, 42, 399]) {
      expect(chooseInterval(depth, PLENTY).intervalFt).toBeGreaterThanOrEqual(BASE_INTERVAL_FT);
    }
  });

  it('always lands on a whole multiple of the base, so two lakes’ rings nest', () => {
    for (const depth of [17, 48, 120, 399, 900]) {
      for (const samples of [10, 24, 105, PLENTY]) {
        expect(chooseInterval(depth, samples).intervalFt % BASE_INTERVAL_FT).toBe(0);
      }
    }
  });

  it('marks nothing as coarsened when it sits on the base', () => {
    expect(chooseInterval(36, PLENTY).coarsenedBy).toBeUndefined();
  });

  it('assumes plenty of data when it is not told otherwise', () => {
    expect(chooseInterval(36).intervalFt).toBe(BASE_INTERVAL_FT);
  });

  it('degrades to the coarsest rung rather than nothing when no step fits', () => {
    // A very deep lake with almost no readings. Whether it should be drawn at all is the density
    // gate's decision, not this function's.
    const choice = chooseInterval(400, 3);
    expect(choice.levels.length).toBeGreaterThan(0);
    expect(choice.coarsenedBy).toBe('data support');
  });

  it('returns no levels for a lake with no measured depth', () => {
    expect(chooseInterval(0, PLENTY).levels).toEqual([]);
  });
});

describe('thinPublishedLevels', () => {
  it('leaves a source coarser than the ladder completely alone', () => {
    // NH publishes at 10 ft. The 5 ft and 15 ft rungs find nothing within tolerance, so its own
    // levels come back untouched — we never ADD a line the state did not survey.
    const nh = [10, 20, 30, 40, 50, 60];
    expect(thinPublishedLevels(nh, 5)).toEqual(nh);
  });

  it('thins a source finer than the ladder — the founder’s "drop every other"', () => {
    // MassGIS runs 2/3/4/5 ft in the shallows and 5 ft steps below.
    expect(thinPublishedLevels([2, 3, 4, 5, 10, 15, 20], 5)).toEqual([5, 10, 15, 20]);
  });

  it('only ever returns levels the agency actually published', () => {
    const published = [3, 7, 11, 19, 26, 31];
    for (const level of thinPublishedLevels(published, 5)) {
      expect(published).toContain(level);
    }
  });

  it('snaps each rung to the nearest published level within half a rung', () => {
    // 4 is within 1 of the 5 ft rung; 12 is within 2 of the 10 ft rung; 30 serves the 30 rung exactly.
    expect(thinPublishedLevels([4, 12, 30], 5)).toEqual([4, 12, 30]);
  });

  it('collapses a cluster tight against one rung to a single representative', () => {
    expect(thinPublishedLevels([9, 10, 11, 20], 5)).toEqual([10, 20]);
  });

  it('always keeps the deepest published level, whichever rung it falls near', () => {
    // Found on the real corpus: a lake published at 2/4/6/8/10/12 thinned to 4/10 and lost its 12 ft
    // ring — the innermost one, the only line that says where the deep water is. That is the
    // "understating depth by omission" D82 refused, arriving by a different route.
    expect(thinPublishedLevels([2, 4, 6, 8, 10, 12], 5)).toContain(12);
    expect(thinPublishedLevels([2, 4, 6], 5)).toContain(6);
    expect(thinPublishedLevels([2, 4, 6, 8, 10, 12, 14], 5)).toContain(14);
  });

  it('never returns a level deeper than the deepest published one', () => {
    for (const levels of [[2, 4, 6], [1, 2, 3, 4, 5, 10, 15], [10, 20, 30], [7]]) {
      const kept = thinPublishedLevels(levels, 5);
      expect(Math.max(...kept)).toBeLessThanOrEqual(Math.max(...levels));
    }
  });

  it('handles the empty and degenerate cases', () => {
    expect(thinPublishedLevels([], 5)).toEqual([]);
    expect(thinPublishedLevels([0, -4], 5)).toEqual([]);
    expect(thinPublishedLevels([5, 10], 0)).toEqual([5, 10]);
  });

  it('deduplicates, because a source repeats a level once per line feature', () => {
    expect(thinPublishedLevels([10, 10, 10, 20, 20], 5)).toEqual([10, 20]);
  });
});
