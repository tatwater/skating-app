import { describe, expect, test } from 'vitest';
import { sunTimes } from './solar';

/**
 * Reference values are the **US Naval Observatory**'s, via its `rstt/oneday` API.
 *
 * The first draft of this test used sunrise-sunset.org and passed at a ±2 min tolerance, which is how
 * the discrepancy got noticed: that service disagrees with USNO by about two minutes at this latitude,
 * and a tolerance loose enough to accept it is a tolerance loose enough to hide a real bug. Against
 * USNO this module lands within ~20 seconds.
 *
 * USNO publishes to the minute, so the bound is 90 s — 60 for its rounding, 30 for ours.
 */
const TOLERANCE_MS = 90_000;

/** Burlington, VT — the corpus's centre of gravity, and a latitude where the winter day is short. */
const BURLINGTON = { lat: 44.4759, lon: -73.2121 };
const ET = 'America/New_York';

function burlington(iso: string) {
  return sunTimes(Date.parse(iso), BURLINGTON.lat, BURLINGTON.lon, ET);
}

function expectWithin(actualMs: number | undefined, expectedIso: string) {
  expect(actualMs).toBeDefined();
  expect(Math.abs((actualMs as number) - Date.parse(expectedIso))).toBeLessThanOrEqual(
    TOLERANCE_MS,
  );
}

describe('sunTimes', () => {
  // USNO: rise 07:26, set 16:39 EST.
  test('matches USNO in mid-ice-season', () => {
    const times = burlington('2026-01-15T17:00:00Z');
    expectWithin(times?.sunriseMs, '2026-01-15T12:26:00Z');
    expectWithin(times?.sunsetMs, '2026-01-15T21:39:00Z');
  });

  // USNO: rise 07:05, set 18:59 EDT — the day the Tomhannock ice-fishing window closes.
  test('matches USNO at the end of a Jan 1 – Mar 15 posted window', () => {
    const times = burlington('2026-03-15T16:00:00Z');
    expectWithin(times?.sunriseMs, '2026-03-15T11:05:00Z');
    expectWithin(times?.sunsetMs, '2026-03-15T22:59:00Z');
  });

  // USNO: rise 07:26, set 16:16 EST — the solstice, the shortest day of the skating year.
  test('matches USNO at the winter solstice', () => {
    const times = burlington('2025-12-21T17:00:00Z');
    expectWithin(times?.sunriseMs, '2025-12-21T12:26:00Z');
    expectWithin(times?.sunsetMs, '2025-12-21T21:16:00Z');
  });

  /**
   * The reason a "daylight hours only" rule cannot be stored as a pair of fixed clock times: inside a
   * single posted season, true sunset moves about 80 minutes (16:39 EST → 18:59 EDT, of which the DST
   * hour is bookkeeping and 80 minutes is the sun). Compared in UTC so the March 8 transition doesn't
   * flatter the figure. On the wall clock a skater reads, the total swing is 2h20m.
   */
  test('sunset drifts over an hour across one posted season', () => {
    const jan = burlington('2026-01-15T17:00:00Z')?.sunsetMs as number;
    const mar = burlington('2026-03-15T16:00:00Z')?.sunsetMs as number;
    const driftMinutes = ((mar % 86_400_000) - (jan % 86_400_000)) / 60_000;
    expect(driftMinutes).toBeGreaterThan(75);
  });

  test('the day is taken in the lake’s zone, so any instant on that local date agrees', () => {
    // 00:30 local on the 15th and 23:30 local on the 15th fall on different *UTC* dates; both must
    // still resolve to the 15th's sunrise.
    const early = burlington('2026-01-15T05:30:00Z');
    const late = burlington('2026-01-16T04:30:00Z');
    expect(early?.sunriseMs).toBe(late?.sunriseMs);
    expectWithin(early?.sunriseMs, '2026-01-15T12:26:00Z');
  });

  test('survives the spring-forward boundary without shifting a day', () => {
    // 2026-03-08 is the US DST transition. The local day still has exactly one sunrise and one sunset.
    const times = burlington('2026-03-08T16:00:00Z');
    expect(new Date(times?.sunriseMs as number).toISOString()).toMatch(/^2026-03-08/);
    expect(new Date(times?.sunsetMs as number).toISOString()).toMatch(/^2026-03-08/);
    expect(times?.sunriseMs).toBeLessThan(times?.sunsetMs as number);
  });

  /**
   * Not reachable from this corpus, and tested precisely because it isn't: an unhandled polar day
   * yields `acos(x > 1)` = `NaN`, and every comparison against `NaN` is `false` — so a posted window
   * would silently report *closed* forever instead of reporting that it does not know.
   */
  test('returns null where the sun neither rises nor sets', () => {
    expect(sunTimes(Date.parse('2025-12-21T12:00:00Z'), 78.22, 15.65, 'UTC')).toBeNull(); // Svalbard
    expect(sunTimes(Date.parse('2026-06-21T12:00:00Z'), 78.22, 15.65, 'UTC')).toBeNull();
  });
});
