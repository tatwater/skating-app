/**
 * Wall-clock ↔ instant primitives for a named IANA zone.
 *
 * Extracted when `solar.ts` and `postedAccess.ts` (N6e) both needed what `schedule.ts` had already
 * worked out for the notification digest. Three copies of an `Intl.DateTimeFormat` parse is three
 * chances to fix a DST bug in two places, so the primitives live here and `schedule.ts` re-exports
 * `zonedParts` for the callers that already import it from there.
 *
 * All timezone math goes through `Intl` (full ICU in the Convex runtime, Node, and both clients)
 * rather than a fixed offset, so it stays correct across the EST↔EDT shift. Note this is the *other*
 * stance from `season.ts`, which does its calendar arithmetic in UTC on purpose: a season boundary is
 * ours to define, while a posted closing time is a wall clock at a specific lake.
 */

const DAY_MS = 86_400_000;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Wall-clock parts of `ms` in `timeZone`, as numbers. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // `hour12: false` can render midnight as "24"; normalize it to 0.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Signed offset (ms) such that `localWallClock = utc + offset` at instant `ms` in `timeZone`. */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/** Minutes since local midnight at instant `ms` in `timeZone`. */
export function zonedMinuteOfDay(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * The instant at which the clock in `timeZone` reads `minuteOfDay` on the given calendar date.
 *
 * The offset is resolved by guessing with the offset at the naive UTC reading, then re-reading the
 * offset *at the guess* and correcting once — enough to settle either side of a DST boundary.
 *
 * `minuteOfDay` may exceed 1439; `Date.UTC` normalizes the overflow into the following day, which is
 * what a window that closes after midnight wants.
 */
export function zonedInstant(
  year: number,
  month: number, // 1-12
  day: number,
  minuteOfDay: number,
  timeZone: string,
): number {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);
  const guess = wallClockAsUtc - zoneOffsetMs(wallClockAsUtc, timeZone);
  return wallClockAsUtc - zoneOffsetMs(guess, timeZone);
}

/**
 * Whether this runtime knows `timeZone` — `Intl` throws a `RangeError` for anything it doesn't. The
 * runtime's own table is the one authority on what counts as a zone, and every helper in this file
 * would throw on a string it rejects, so a zone that crosses a trust boundary (a client writing
 * `profiles.timezone`, N8/C) is checked here before it can become the argument that throws later.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The instant `minuteOfDay` reads on the local calendar day containing `atMs`, offset by `dayDelta`. */
export function zonedInstantOnDayOf(
  atMs: number,
  minuteOfDay: number,
  timeZone: string,
  dayDelta = 0,
): number {
  const p = zonedParts(atMs + dayDelta * DAY_MS, timeZone);
  return zonedInstant(p.year, p.month, p.day, minuteOfDay, timeZone);
}
