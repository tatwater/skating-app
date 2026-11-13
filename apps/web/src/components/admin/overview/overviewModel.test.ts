import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BOARD_NOON } from '@/test/boardNow';

import {
  clockSeconds,
  countText,
  countTone,
  DAY,
  dayMonth,
  feedWhen,
  liveMarkState,
  overviewHeads,
  QUIET_FACTOR,
  shortAge,
  sumCounts,
} from './overviewModel';

const HOUR = 3_600_000;
const MIN = 60_000;
/** Local wall time `daysAgo` before the board's Saturday. */
const at = (daysAgo: number, h: number, m = 0) => {
  const d = new Date(BOARD_NOON);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

describe('counts', () => {
  it('says a capped count as a floor', () => {
    expect(countText({ count: 283, capped: false })).toBe('283');
    expect(countText({ count: 1204, capped: false })).toBe('1,204');
    expect(countText({ count: 200, capped: true })).toBe('200+');
  });

  it('adds counts, capped if any part was, skipping lanes the viewer cannot see', () => {
    expect(sumCounts([{ count: 2, capped: false }, null, { count: 3, capped: false }])).toEqual({
      count: 5,
      capped: false,
    });
    expect(
      sumCounts([
        { count: 2, capped: false },
        { count: 200, capped: true },
      ]),
    ).toEqual({
      count: 202,
      capped: true,
    });
    expect(sumCounts([])).toEqual({ count: 0, capped: false });
  });

  it('steps zero back, and keeps a capped zero lit (it is not zero)', () => {
    expect(countTone({ count: 0, capped: false }, 'bad')).toBe('dim');
    expect(countTone({ count: 1, capped: false }, 'bad')).toBe('bad');
    expect(countTone({ count: 3, capped: false })).toBe('default');
    expect(countTone({ count: 0, capped: true }, 'warn')).toBe('warn');
  });
});

describe('shortAge', () => {
  it('reads minutes, hours, a day and a half, then whole days rounded down', () => {
    expect(shortAge(0)).toBe('0 min');
    expect(shortAge(41 * MIN)).toBe('41 min');
    expect(shortAge(5 * HOUR + 59 * MIN)).toBe('5 h');
    expect(shortAge(1.5 * DAY)).toBe('1.5 d');
    expect(shortAge(1.99 * DAY)).toBe('1.9 d');
    expect(shortAge(4 * DAY + 23 * HOUR)).toBe('4 d');
  });

  it('never reads negative or NaN, whatever the clock skew', () => {
    expect(shortAge(-5 * MIN)).toBe('0 min');
    expect(shortAge(Number.NaN)).toBe('0 min');
    expect(shortAge(Number.POSITIVE_INFINITY)).toBe('0 min');
    // Any age a clock can produce: a century either side of now.
    fc.assert(
      fc.property(fc.double({ min: -100 * 365 * DAY, max: 100 * 365 * DAY }), (ms) => {
        expect(shortAge(ms)).toMatch(/^\d+(\.\d)? (min|h|d)$/u);
      }),
    );
  });

  it('never reads younger for an older item', () => {
    const value = (s: string) => {
      const [n, unit] = s.split(' ');
      const scale = unit === 'min' ? MIN : unit === 'h' ? HOUR : DAY;
      return Number(n) * scale;
    };
    fc.assert(
      fc.property(fc.nat(400 * DAY), fc.nat(400 * DAY), (a, b) => {
        const [young, old] = a <= b ? [a, b] : [b, a];
        expect(value(shortAge(old))).toBeGreaterThanOrEqual(value(shortAge(young)));
      }),
    );
  });
});

describe('clock words', () => {
  it('writes the time today, the weekday this week, the date before that', () => {
    expect(feedWhen(at(0, 11, 41), BOARD_NOON)).toBe('11:41');
    expect(feedWhen(at(0, 0, 0), BOARD_NOON)).toBe('00:00');
    expect(feedWhen(at(1, 22, 14), BOARD_NOON)).toBe('Fri 22:14');
    expect(feedWhen(at(6, 9, 5), BOARD_NOON)).toBe('Sun 09:05');
    expect(feedWhen(at(7, 9, 5), BOARD_NOON)).toBe('9 Jan');
  });

  it('turns over at the viewer’s midnight, not 24 hours on', () => {
    // 23:59 yesterday is yesterday even though it is only twelve hours ago.
    expect(feedWhen(at(1, 23, 59), BOARD_NOON)).toBe('Fri 23:59');
  });

  it('writes a date and a time to the second', () => {
    expect(dayMonth(new Date(2026, 9, 3).getTime())).toBe('3 Oct');
    expect(clockSeconds(at(0, 11, 59) + 31_000)).toBe('11:59:31');
  });
});

describe('overviewHeads', () => {
  const n = (count: number, capped = false) => ({ count, capped });

  it('draws one state per badge, and drops a zero and an empty group', () => {
    expect(overviewHeads({ inbox: n(19), refits: n(2), stalled: 1, failed: 2 })).toEqual([
      { kicker: 'Needs a person', tone: 'warn', badges: ['19 in the inbox', '2 re-fits'] },
      { kicker: 'Needs a hand', tone: 'bad', badges: ['1 stalled', '2 failed'] },
    ]);
    expect(overviewHeads({ inbox: n(0), refits: n(1), stalled: 0, failed: 0 })).toEqual([
      { kicker: 'Needs a person', tone: 'warn', badges: ['1 re-fit'] },
    ]);
    expect(overviewHeads({ inbox: n(0), refits: n(0), stalled: 0, failed: 0 })).toEqual([]);
    expect(
      overviewHeads({ inbox: n(200, true), refits: n(0), stalled: 0, failed: 3 })[0]?.badges,
    ).toEqual(['200+ in the inbox']);
  });

  it('says a capped re-fit count is a floor, as the inbox’s is', () => {
    expect(
      overviewHeads({ inbox: n(0), refits: n(200, true), stalled: 0, failed: 0 })[0]?.badges,
    ).toEqual(['200+ re-fits']);
  });
});

describe('liveMarkState', () => {
  const expectedMs = 30_000;

  it('is live inside the window, checking while a request is in flight, off past three intervals', () => {
    expect(liveMarkState({ now: 100_000, lastCheckedAt: 99_000, expectedMs })).toBe('live');
    expect(liveMarkState({ now: 100_000, lastCheckedAt: 99_000, expectedMs, inFlight: true })).toBe(
      'checking',
    );
    expect(liveMarkState({ now: 100_000, lastCheckedAt: 100_000 - 90_000, expectedMs })).toBe(
      'live',
    );
    expect(liveMarkState({ now: 100_000, lastCheckedAt: 100_000 - 90_001, expectedMs })).toBe(
      'off',
    );
  });

  it('checks before it has ever heard, and is never live then', () => {
    expect(liveMarkState({ now: 1, lastCheckedAt: null, expectedMs })).toBe('checking');
  });

  it('is off exactly when the silence passes three intervals, in flight or not', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 9 }),
        fc.integer({ min: 0, max: 10 ** 7 }),
        fc.integer({ min: 1, max: 10 ** 6 }),
        fc.boolean(),
        (lastCheckedAt, silence, expected, inFlight) => {
          const state = liveMarkState({
            now: lastCheckedAt + silence,
            lastCheckedAt,
            expectedMs: expected,
            inFlight,
          });
          expect(state === 'off').toBe(silence > QUIET_FACTOR * expected);
          if (state !== 'off') expect(state).toBe(inFlight ? 'checking' : 'live');
        },
      ),
    );
  });

  it('once quiet, stays quiet as time passes until it hears again', () => {
    fc.assert(
      fc.property(fc.nat(10 ** 6), fc.nat(10 ** 6), (silence, more) => {
        const before = liveMarkState({ now: silence, lastCheckedAt: 0, expectedMs });
        const after = liveMarkState({ now: silence + more, lastCheckedAt: 0, expectedMs });
        if (before === 'off') expect(after).toBe('off');
      }),
    );
  });
});
