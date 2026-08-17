import { describe, expect, test } from 'vitest';
import {
  describeDailyWindow,
  describePostedAccess,
  describePostedAccessNow,
  formatMinuteOfDay,
  isWithinDateRange,
  MAX_DAYLIGHT_OFFSET_MINUTES,
  MAX_POSTED_NOTE_LENGTH,
  type PostedAccess,
  type PostedAccessAt,
  postedAccessError,
  postedAccessStateAt,
} from './postedAccess';

const ET = 'America/New_York';
/** Tomhannock Reservoir, Rensselaer County NY — the rule this feature was built from. */
const TOMHANNOCK = { lat: 42.8462, lon: -73.5501 };

function at(iso: string): PostedAccessAt {
  return { nowMs: Date.parse(iso), lat: TOMHANNOCK.lat, lon: TOMHANNOCK.lon, timeZone: ET };
}

/** *"Permitted January 1 - March 15, daylight hours only."* + the City of Troy permit. */
const TOMHANNOCK_RULE: PostedAccess = {
  dateRange: { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 },
  dailyWindow: { kind: 'daylight', offsetMinutes: 0 },
  permitRequired: true,
  note: 'NYSDEC; access permit from the City of Troy',
};

describe('isWithinDateRange', () => {
  const janToMarch = { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 };

  test('includes both endpoints', () => {
    expect(isWithinDateRange(janToMarch, Date.parse('2026-01-01T12:00:00Z'), ET)).toBe(true);
    expect(isWithinDateRange(janToMarch, Date.parse('2026-03-15T12:00:00Z'), ET)).toBe(true);
  });

  test('excludes the days either side', () => {
    expect(isWithinDateRange(janToMarch, Date.parse('2025-12-31T12:00:00Z'), ET)).toBe(false);
    expect(isWithinDateRange(janToMarch, Date.parse('2026-03-16T12:00:00Z'), ET)).toBe(false);
  });

  /** The common shape for an ice season, and the one a naive `start <= d && d <= end` gets backwards. */
  test('a range that wraps the new year is the union of two spans', () => {
    const decToMarch = { startMonth: 12, startDay: 15, endMonth: 3, endDay: 15 };
    expect(isWithinDateRange(decToMarch, Date.parse('2025-12-20T12:00:00Z'), ET)).toBe(true);
    expect(isWithinDateRange(decToMarch, Date.parse('2026-01-20T12:00:00Z'), ET)).toBe(true);
    expect(isWithinDateRange(decToMarch, Date.parse('2026-03-15T12:00:00Z'), ET)).toBe(true);
    expect(isWithinDateRange(decToMarch, Date.parse('2026-07-04T12:00:00Z'), ET)).toBe(false);
    expect(isWithinDateRange(decToMarch, Date.parse('2025-12-14T12:00:00Z'), ET)).toBe(false);
  });

  /** The calendar is read in the lake's zone: 00:30 ET on Jan 1 is already Jan 1, not Dec 31. */
  test('the day boundary is the lake’s, not UTC’s', () => {
    // 2026-01-01T02:00Z is 2025-12-31 21:00 ET — still out of range.
    expect(isWithinDateRange(janToMarch, Date.parse('2026-01-01T02:00:00Z'), ET)).toBe(false);
    // 2026-01-01T06:00Z is 2026-01-01 01:00 ET — in range.
    expect(isWithinDateRange(janToMarch, Date.parse('2026-01-01T06:00:00Z'), ET)).toBe(true);
  });
});

describe('postedAccessError', () => {
  test('accepts the Tomhannock rule', () => {
    expect(postedAccessError(TOMHANNOCK_RULE)).toBeNull();
  });

  test('accepts each half on its own', () => {
    expect(postedAccessError({ dailyWindow: { kind: 'daylight', offsetMinutes: 30 } })).toBeNull();
    expect(
      postedAccessError({ dateRange: { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 } }),
    ).toBeNull();
    expect(postedAccessError({ permitRequired: true })).toBeNull();
  });

  test('refuses a rule that asserts nothing', () => {
    expect(postedAccessError({})).toMatch(/needs a date range/);
    expect(postedAccessError({ note: '   ' })).toMatch(/needs a date range/);
  });

  test('refuses an impossible date', () => {
    expect(
      postedAccessError({ dateRange: { startMonth: 2, startDay: 30, endMonth: 3, endDay: 15 } }),
    ).toMatch(/February has no day 30/);
    expect(
      postedAccessError({ dateRange: { startMonth: 13, startDay: 1, endMonth: 3, endDay: 15 } }),
    ).toMatch(/between 1 and 12/);
  });

  test('allows February 29 so a leap-day rule round-trips', () => {
    expect(
      postedAccessError({ dateRange: { startMonth: 1, startDay: 1, endMonth: 2, endDay: 29 } }),
    ).toBeNull();
  });

  test('refuses an offset that is obviously in the wrong unit', () => {
    expect(
      postedAccessError({
        dailyWindow: { kind: 'daylight', offsetMinutes: MAX_DAYLIGHT_OFFSET_MINUTES + 1 },
      }),
    ).toMatch(/wrong unit/);
    expect(postedAccessError({ dailyWindow: { kind: 'daylight', offsetMinutes: -30 } })).toMatch(
      /whole number of minutes/,
    );
  });

  test('refuses a clock window that is not a time of day, or has no width', () => {
    expect(
      postedAccessError({ dailyWindow: { kind: 'clock', openMinute: 360, closeMinute: 1440 } }),
    ).toMatch(/time of day/);
    expect(
      postedAccessError({ dailyWindow: { kind: 'clock', openMinute: 360, closeMinute: 360 } }),
    ).toMatch(/same/);
  });

  test('refuses a note long enough to be a paragraph', () => {
    expect(postedAccessError({ note: 'x'.repeat(MAX_POSTED_NOTE_LENGTH + 1) })).toMatch(
      /keep it under/,
    );
  });
});

describe('describePostedAccess', () => {
  test('renders the Tomhannock rule the way the sign reads', () => {
    expect(describePostedAccess(TOMHANNOCK_RULE)).toBe(
      'January 1 – March 15 · sunrise to sunset · permit required',
    );
  });

  /** All three real-world shapes the research turned up. */
  test('renders each posted shape', () => {
    expect(describeDailyWindow({ kind: 'daylight', offsetMinutes: 0 })).toBe('sunrise to sunset');
    expect(describeDailyWindow({ kind: 'daylight', offsetMinutes: 30 })).toBe(
      'a half hour before sunrise to a half hour after sunset',
    );
    expect(describeDailyWindow({ kind: 'daylight', offsetMinutes: 60 })).toBe(
      'an hour before sunrise to an hour after sunset',
    );
    expect(describeDailyWindow({ kind: 'daylight', offsetMinutes: 20 })).toBe(
      '20 minutes before sunrise to 20 minutes after sunset',
    );
    expect(describeDailyWindow({ kind: 'clock', openMinute: 360, closeMinute: 1200 })).toBe(
      '6:00 AM to 8:00 PM',
    );
  });

  test('renders a date range with no daily hours, and hours with no range', () => {
    expect(
      describePostedAccess({
        dateRange: { startMonth: 12, startDay: 15, endMonth: 3, endDay: 15 },
      }),
    ).toBe('December 15 – March 15');
    expect(describePostedAccess({ dailyWindow: { kind: 'daylight', offsetMinutes: 0 } })).toBe(
      'sunrise to sunset',
    );
  });

  test('returns null when there is nothing renderable, so no heading is drawn', () => {
    expect(describePostedAccess({})).toBeNull();
    expect(describePostedAccess({ note: 'Posted at the launch' })).toBeNull();
  });

  test('formatMinuteOfDay handles both meridiem boundaries', () => {
    expect(formatMinuteOfDay(0)).toBe('12:00 AM');
    expect(formatMinuteOfDay(720)).toBe('12:00 PM');
    expect(formatMinuteOfDay(1439)).toBe('11:59 PM');
  });
});

describe('postedAccessStateAt', () => {
  test('open in the middle of a January afternoon', () => {
    // 2026-01-15 13:00 ET — well inside sunrise 07:26 / sunset 16:39.
    const state = postedAccessStateAt(TOMHANNOCK_RULE, at('2026-01-15T18:00:00Z'));
    expect(state.open).toBe(true);
    expect(state.reason).toBeNull();
    expect(describePostedAccessNow(state, ET)).toMatch(/^Open now · until \d+:\d\d PM$/);
  });

  test('shut before sunrise, and the next opening is this morning', () => {
    // 2026-01-15 06:00 ET — before sunrise.
    const state = postedAccessStateAt(TOMHANNOCK_RULE, at('2026-01-15T11:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.reason).toBe('before_open');
    expect(describePostedAccessNow(state, ET)).toMatch(/^Closed now · opens \d+:\d\d AM$/);
  });

  test('shut after sunset, and the next opening is tomorrow morning', () => {
    // 2026-01-15 20:00 ET — after sunset.
    const state = postedAccessStateAt(TOMHANNOCK_RULE, at('2026-01-16T01:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.reason).toBe('after_close');
    // Tomorrow's sunrise, not today's — so it must be in the future.
    expect(state.nextChangeMs).toBeGreaterThan(Date.parse('2026-01-16T01:00:00Z'));
    expect(describePostedAccessNow(state, ET)).toMatch(/^Closed now · opens \d+:\d\d AM$/);
  });

  test('out of season answers with a date, not a time', () => {
    const state = postedAccessStateAt(TOMHANNOCK_RULE, at('2025-10-05T18:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.reason).toBe('out_of_range');
    expect(describePostedAccessNow(state, ET)).toBe('Closed now · opens January 1');
  });

  test('the out-of-season opening is the next occurrence, not a past one', () => {
    // Late March 2026: the window just closed, so the next opening is January 2027.
    const state = postedAccessStateAt(TOMHANNOCK_RULE, at('2026-03-20T18:00:00Z'));
    expect(state.reason).toBe('out_of_range');
    const opensAt = new Date(state.nextChangeMs as number).toISOString();
    expect(opensAt.startsWith('2027-01-01')).toBe(true);
  });

  test('a date range with no daily hours is open all day inside it', () => {
    const rule: PostedAccess = {
      dateRange: { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 },
    };
    expect(postedAccessStateAt(rule, at('2026-01-15T07:00:00Z')).open).toBe(true);
    expect(postedAccessStateAt(rule, at('2026-06-15T07:00:00Z')).open).toBe(false);
  });

  test('a permit-only rule never reports closed', () => {
    const state = postedAccessStateAt({ permitRequired: true }, at('2026-01-15T07:00:00Z'));
    expect(state.open).toBe(true);
    expect(describePostedAccessNow(state, ET)).toBeNull();
  });

  describe('clock windows', () => {
    const lot: PostedAccess = {
      dailyWindow: { kind: 'clock', openMinute: 360, closeMinute: 1200 },
    };

    test('open inside 6:00 AM – 8:00 PM and shut either side', () => {
      expect(postedAccessStateAt(lot, at('2026-01-15T17:00:00Z')).open).toBe(true); // 12:00 ET
      expect(postedAccessStateAt(lot, at('2026-01-15T10:00:00Z')).open).toBe(false); // 05:00 ET
      expect(postedAccessStateAt(lot, at('2026-01-16T02:00:00Z')).open).toBe(false); // 21:00 ET
    });

    test('the opening boundary is inclusive and the closing boundary exclusive', () => {
      expect(postedAccessStateAt(lot, at('2026-01-15T11:00:00Z')).open).toBe(true); // 06:00 ET
      expect(postedAccessStateAt(lot, at('2026-01-16T01:00:00Z')).open).toBe(false); // 20:00 ET
    });

    /**
     * A lot open 6:00 AM – 2:00 AM. At 1 AM the span containing you *started on the previous local
     * day*, so a state machine that only ever looks at today reports closed all night.
     */
    test('a window that crosses midnight is open on the far side of it', () => {
      const lateLot: PostedAccess = {
        dailyWindow: { kind: 'clock', openMinute: 360, closeMinute: 120 },
      };
      expect(postedAccessStateAt(lateLot, at('2026-01-15T06:00:00Z')).open).toBe(true); // 01:00 ET
      expect(postedAccessStateAt(lateLot, at('2026-01-15T08:00:00Z')).open).toBe(false); // 03:00 ET
      expect(postedAccessStateAt(lateLot, at('2026-01-15T12:00:00Z')).open).toBe(true); // 07:00 ET
    });

    test('a clock window needs no coordinates', () => {
      const nowhere = { nowMs: Date.parse('2026-01-15T17:00:00Z'), lat: 0, lon: 0, timeZone: ET };
      expect(postedAccessStateAt(lot, nowhere).open).toBe(true);
    });
  });

  /**
   * Never report "closed" from a calculation that could not be done. A polar day yields no sunrise,
   * and this surface annotates rather than suppresses — a false *open* costs a reader nothing, while a
   * false *closed* is the app inventing a restriction nobody posted.
   */
  test('a daylight window with no sunrise reports open, not closed', () => {
    const svalbard = {
      nowMs: Date.parse('2025-12-21T12:00:00Z'),
      lat: 78.22,
      lon: 15.65,
      timeZone: 'UTC',
    };
    const state = postedAccessStateAt(
      { dailyWindow: { kind: 'daylight', offsetMinutes: 0 } },
      svalbard,
    );
    expect(state.open).toBe(true);
    expect(state.reason).toBeNull();
  });

  test('the offset widens the window at both ends', () => {
    // 2026-01-15, sunrise 07:26 ET. At 07:00 a bare rule is shut and a half-hour rule is open.
    const bare = postedAccessStateAt(
      { dailyWindow: { kind: 'daylight', offsetMinutes: 0 } },
      at('2026-01-15T12:00:00Z'),
    );
    const offset = postedAccessStateAt(
      { dailyWindow: { kind: 'daylight', offsetMinutes: 30 } },
      at('2026-01-15T12:00:00Z'),
    );
    expect(bare.open).toBe(false);
    expect(offset.open).toBe(true);
  });
});
