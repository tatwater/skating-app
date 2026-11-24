import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  KNOW_BEFORE_YOU_GO_EARLY_MS,
  knowBeforeYouGoDue,
  watchSeasonTitle,
} from './knowBeforeYouGoSeason';

// Pinned instants (D243): the watch opened 2027-11-20 14:00 UTC.
const OPENED = Date.UTC(2027, 10, 20, 14);
const watch = { openedAt: OPENED };
const DAY = 24 * 60 * 60 * 1000;

const instant = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) });

describe('knowBeforeYouGoDue', () => {
  it('asks someone who has never answered, whatever the watch says', () => {
    expect(knowBeforeYouGoDue(undefined, null)).toBe('never');
    expect(knowBeforeYouGoDue(undefined, watch)).toBe('never');
  });

  it('asks nobody who has answered before any season opens', () => {
    expect(knowBeforeYouGoDue(OPENED - 400 * DAY, null)).toBeNull();
  });

  it('counts answers given on or after the opening minus 30 days, to the millisecond', () => {
    expect(KNOW_BEFORE_YOU_GO_EARLY_MS).toBe(30 * DAY);
    expect(knowBeforeYouGoDue(OPENED - 30 * DAY, watch)).toBeNull();
    expect(knowBeforeYouGoDue(OPENED - 30 * DAY - 1, watch)).toBe('season');
    expect(knowBeforeYouGoDue(OPENED, watch)).toBeNull();
    expect(knowBeforeYouGoDue(OPENED + 90 * DAY, watch)).toBeNull();
  });

  it('asks again someone who last answered last winter', () => {
    expect(knowBeforeYouGoDue(OPENED - 300 * DAY, watch)).toBe('season');
  });

  it('is null for every answered skater once no watch exists', () => {
    fc.assert(fc.property(instant, (lastAt) => knowBeforeYouGoDue(lastAt, null) === null));
  });

  it('is never null for someone who has never answered', () => {
    fc.assert(
      fc.property(fc.option(instant.map((openedAt) => ({ openedAt }))), (w) => {
        return knowBeforeYouGoDue(undefined, w) === 'never';
      }),
    );
  });

  it('is monotone in lastAt: answering later never makes the questions due', () => {
    fc.assert(
      fc.property(instant, instant, instant, (a, b, openedAt) => {
        const [early, late] = a <= b ? [a, b] : [b, a];
        const w = { openedAt };
        if (knowBeforeYouGoDue(early, w) === null) {
          return knowBeforeYouGoDue(late, w) === null;
        }
        return true;
      }),
    );
  });

  it('has its edge exactly at openedAt − 30 days for any opening', () => {
    fc.assert(
      fc.property(instant, (openedAt) => {
        const w = { openedAt };
        const edge = openedAt - KNOW_BEFORE_YOU_GO_EARLY_MS;
        return knowBeforeYouGoDue(edge, w) === null && knowBeforeYouGoDue(edge - 1, w) === 'season';
      }),
    );
  });
});

describe('watchSeasonTitle', () => {
  it('names a watch season as the card draws it', () => {
    expect(watchSeasonTitle('winter-2027-28')).toBe('Winter 2027–28');
    expect(watchSeasonTitle('winter-2099-00')).toBe('Winter 2099–00');
  });

  it('refuses anything that is not a season key', () => {
    expect(() => watchSeasonTitle('winter-2027-29')).toThrow();
    expect(() => watchSeasonTitle('2027')).toThrow();
  });
});
