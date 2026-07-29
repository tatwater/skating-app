import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  currentSeason,
  formatSeason,
  isInSeason,
  previousSeason,
  SEASON_START_MONTH,
  type Season,
  seasonEndMs,
  seasonOf,
  seasonStartMs,
  seasonsBetween,
} from './season';

/** Seasons the app could plausibly ever be asked about — wide enough to catch century wrap. */
const anySeason = fc.integer({ min: 1970, max: 2120 });
/** Epoch ms across the same span, which is what a `skateEndTime` ever holds. */
const anyInstant = fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2120, 0, 1) });

describe('seasonOf — the boundary is July 1, and it is the whole decision', () => {
  it('starts a season at July 1 and not a millisecond earlier', () => {
    expect(seasonOf(Date.UTC(2025, 5, 30, 23, 59, 59, 999))).toBe(2024);
    expect(seasonOf(Date.UTC(2025, 6, 1, 0, 0, 0, 0))).toBe(2025);
  });

  it('keeps a skating season whole across New Year', () => {
    // The reason the boundary is July at all: December and February are the same season.
    expect(seasonOf(Date.UTC(2025, 11, 20))).toBe(2025);
    expect(seasonOf(Date.UTC(2026, 1, 14))).toBe(2025);
    expect(seasonOf(Date.UTC(2026, 2, 31))).toBe(2025);
  });

  it('agrees with SEASON_START_MONTH rather than a hard-coded 7', () => {
    const justBefore = Date.UTC(2025, SEASON_START_MONTH - 1, 1) - 1;
    expect(seasonOf(justBefore)).toBe(2024);
  });

  it('is monotonic — later never lands in an earlier season', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (a, b) => {
        const [earlier, later] = a <= b ? [a, b] : [b, a];
        expect(seasonOf(earlier)).toBeLessThanOrEqual(seasonOf(later));
      }),
    );
  });
});

describe('the bounds tile the timeline', () => {
  it('round-trips: the start of a season is in that season', () => {
    fc.assert(
      fc.property(anySeason, (s: Season) => {
        expect(seasonOf(seasonStartMs(s))).toBe(s);
      }),
    );
  });

  it('puts the millisecond before a season in the previous one', () => {
    fc.assert(
      fc.property(anySeason, (s: Season) => {
        expect(seasonOf(seasonStartMs(s) - 1)).toBe(previousSeason(s));
      }),
    );
  });

  it('is half-open — the end of one season is the start of the next, with no gap', () => {
    fc.assert(
      fc.property(anySeason, (s: Season) => {
        expect(seasonEndMs(s)).toBe(seasonStartMs(s + 1));
        expect(seasonOf(seasonEndMs(s))).toBe(s + 1);
      }),
    );
  });

  it('agrees with isInSeason for every instant — one definition, not two', () => {
    fc.assert(
      fc.property(anyInstant, (ms) => {
        const s = seasonOf(ms);
        expect(isInSeason(ms, s)).toBe(true);
        expect(isInSeason(ms, s + 1)).toBe(false);
        expect(isInSeason(ms, s - 1)).toBe(false);
      }),
    );
  });

  it('spans a full year', () => {
    fc.assert(
      fc.property(anySeason, (s: Season) => {
        const days = (seasonEndMs(s) - seasonStartMs(s)) / 86_400_000;
        expect(days === 365 || days === 366).toBe(true);
      }),
    );
  });
});

describe('formatSeason', () => {
  it('labels a season by the two years it spans', () => {
    expect(formatSeason(2024)).toBe("'24/'25");
    expect(formatSeason(2025)).toBe("'25/'26");
  });

  it('pads across the century so 2000 does not read as ’0/’1', () => {
    expect(formatSeason(1999)).toBe("'99/'00");
    expect(formatSeason(2000)).toBe("'00/'01");
  });

  it('is distinct for distinct seasons within any century we will see', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1970, max: 2060 }), (s: Season) => {
        expect(formatSeason(s)).not.toBe(formatSeason(s + 1));
      }),
    );
  });
});

describe('currentSeason', () => {
  it('is just seasonOf(now) — the reset is the derived value changing, not an event', () => {
    fc.assert(
      fc.property(anyInstant, (now) => {
        expect(currentSeason(now)).toBe(seasonOf(now));
      }),
    );
  });
});

describe('seasonsBetween — the selector’s option list', () => {
  it('runs newest first', () => {
    const seasons = seasonsBetween(Date.UTC(2023, 0, 10), Date.UTC(2026, 1, 10));
    expect(seasons).toEqual([2025, 2024, 2023, 2022]);
  });

  it('returns exactly one season when both instants land in it', () => {
    expect(seasonsBetween(Date.UTC(2025, 11, 1), Date.UTC(2026, 2, 1))).toEqual([2025]);
  });

  it('never returns an empty list — a lake with one report still offers that season', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (a, b) => {
        const seasons = seasonsBetween(a, b);
        expect(seasons.length).toBeGreaterThan(0);
        expect(seasons[0]).toBe(seasonOf(Math.max(a, b)));
        expect(seasons[seasons.length - 1]).toBe(seasonOf(Math.min(a, b)));
      }),
    );
  });

  it('is order-insensitive in its arguments', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (a, b) => {
        expect(seasonsBetween(a, b)).toEqual(seasonsBetween(b, a));
      }),
    );
  });

  it('is contiguous — every season between the two ends is offered', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (a, b) => {
        const seasons = seasonsBetween(a, b);
        for (let i = 1; i < seasons.length; i++) {
          expect(seasons[i]).toBe(previousSeason(seasons[i - 1] as Season));
        }
      }),
    );
  });
});
