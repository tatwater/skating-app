import { describe, expect, it } from 'vitest';
import { crossedNotch, notchAtOffset, notchFraction, notchPositions } from './scrubberTrack';

describe('notchPositions', () => {
  it('spreads notches evenly across the track', () => {
    expect(notchPositions(4).map((n) => n.fraction)).toEqual([0.125, 0.375, 0.625, 0.875]);
  });

  it('⚠ insets by half a step, so the ends are as easy to hit as the middle', () => {
    // Edge-to-edge placement puts half the first notch outside the box and gives the two end notches
    // half the catchment of every other one, which makes the ends feel unreliable under a thumb.
    const [first] = notchPositions(10);
    const last = notchPositions(10).at(-1);
    expect(first?.fraction).toBeCloseTo(0.05, 6);
    expect(last?.fraction).toBeCloseTo(0.95, 6);
  });

  it('centres a lone notch, since there is no range for it to be at one end of', () => {
    expect(notchPositions(1)).toEqual([{ index: 0, fraction: 0.5 }]);
  });

  it('packs a dense season tighter rather than growing the track', () => {
    // A winter with more passes should look denser — that is honest about the sampling, and it is
    // what lets both ends stay visible, which is what makes a drag meaningful.
    const sparse = notchPositions(5);
    const dense = notchPositions(60);
    expect(dense).toHaveLength(60);
    expect(dense[1]!.fraction - dense[0]!.fraction).toBeLessThan(
      sparse[1]!.fraction - sparse[0]!.fraction,
    );
  });

  it('is empty for an empty season', () => {
    expect(notchPositions(0)).toEqual([]);
  });
});

describe('notchAtOffset', () => {
  it('gives every notch an equal slice of the track', () => {
    expect(notchAtOffset(10, 400, 4)).toBe(0);
    expect(notchAtOffset(110, 400, 4)).toBe(1);
    expect(notchAtOffset(210, 400, 4)).toBe(2);
    expect(notchAtOffset(390, 400, 4)).toBe(3);
  });

  it('⚠ clamps past the ends rather than returning nothing', () => {
    // A finger sliding off the left of the track is asking for the first frame, not for no frame.
    expect(notchAtOffset(-50, 400, 4)).toBe(0);
    expect(notchAtOffset(9999, 400, 4)).toBe(3);
  });

  it('returns null only when there is nothing to select', () => {
    expect(notchAtOffset(100, 400, 0)).toBeNull();
    expect(notchAtOffset(100, 0, 4)).toBeNull();
  });

  it('lands on the notch its own position implies', () => {
    // Round-trip: the fraction `notchPositions` reports must resolve back to the same index.
    const width = 320;
    for (const { index, fraction } of notchPositions(7)) {
      expect(notchAtOffset(fraction * width, width, 7)).toBe(index);
    }
  });
});

describe('notchFraction — where the thumb goes', () => {
  it('⚠ round-trips through notchAtOffset at every count a season can have', () => {
    // The thumb is drawn from this and the selection is read from `notchAtOffset`. Any drift between
    // the two is a handle that comes to rest beside the notch it just selected — visible, and exactly
    // the kind of half-pixel disagreement that survives review. So: every count, every index.
    const width = 411;
    for (const count of [1, 2, 3, 7, 12, 31, 60, 97]) {
      for (let index = 0; index < count; index++) {
        const fraction = notchFraction(index, count);
        expect(fraction).not.toBeNull();
        expect(notchAtOffset((fraction ?? 0) * width, width, count)).toBe(index);
      }
    }
  });

  it('agrees with notchPositions, which is built from it', () => {
    expect(notchPositions(4).map((n) => n.fraction)).toEqual([
      notchFraction(0, 4),
      notchFraction(1, 4),
      notchFraction(2, 4),
      notchFraction(3, 4),
    ]);
  });

  it('puts a lone notch in the centre, having no range to sit at one end of', () => {
    expect(notchFraction(0, 1)).toBe(0.5);
  });

  it('has no position for an index the track does not have — draw no thumb, not a thumb at zero', () => {
    // A stop list can shrink as manifests sharpen coverage, leaving a stale index behind.
    expect(notchFraction(9, 4)).toBeNull();
    expect(notchFraction(-1, 4)).toBeNull();
    expect(notchFraction(0, 0)).toBeNull();
  });
});

describe('crossedNotch', () => {
  it('fires on a change', () => {
    expect(crossedNotch(2, 3)).toBe(true);
  });

  it('does not fire while the finger stays in one notch', () => {
    expect(crossedNotch(3, 3)).toBe(false);
  });

  it('⚠ does not fire on the first sample of a gesture', () => {
    // `previous` is null before the finger has moved anywhere. Ticking there would buzz on touch-down
    // rather than on crossing, which is a different signal entirely.
    expect(crossedNotch(null, 3)).toBe(false);
  });

  it('does not fire when there is nothing under the finger', () => {
    expect(crossedNotch(3, null)).toBe(false);
  });
});
