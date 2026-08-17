/**
 * What the sign says — a posted seasonal window and daily hours (N6e).
 *
 * ## Why this is not an `accessAlert`
 *
 * A locked gate is a decaying community claim: somebody asserts it, others confirm it, and absent
 * either it expires after 30 days and again at the season boundary (`accessAlert.ts`). **A posted rule
 * is the opposite kind of fact.** Tomhannock Reservoir's ice-fishing window is *"January 1 - March 15,
 * daylight hours only"* every year until the City of Troy says otherwise, and running it through the
 * alert lifecycle would delete it each July — silently, because expiring is what alerts are *supposed*
 * to do. So this is a stored attribute with a moderator behind it, not a vote.
 *
 * ## Why a union rather than a boolean
 *
 * The obvious model is a "daylight hours only" checkbox. Posted rules come in three shapes, and a
 * boolean expresses one of them:
 *
 * - *"sunrise to sunset"* — NYC DEP watershed lands
 * - *"one-half hour before sunrise to one-half hour after sunset"* — the dominant wording in fish &
 *   wildlife regs (Newark Watershed, Denver Water, WI NR 20.12)
 * - *"6:00 AM – 8:00 PM"* — gated lots, and lots shared with a business
 *
 * `daylight` carrying an `offsetMinutes` collapses the first two; `clock` is the third. Flattening any
 * of it to fixed clock times would also be wrong in the one season that matters: true sunset at 44°N
 * moves about 80 minutes between January 15 and March 15 (`solar.test.ts`).
 *
 * ## The composition rule
 *
 * The same shape hangs off a water body, a put-in, and a parking area, and **the three are never
 * merged into one effective rule.** A lake open around the clock with one of three lots closed at dusk
 * is not a lake closed at dusk, and the other two lots must not inherit the restriction. Each renders
 * against the thing it governs; nothing in this module combines them.
 */

import { sunTimes } from './solar';
import { zonedInstant, zonedInstantOnDayOf, zonedParts } from './zonedTime';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

/**
 * An annual, recurring window — month and day, never a year.
 *
 * It may wrap the new year (`December 15 – March 15`), which is the common shape for an ice season and
 * the reason every comparison here goes through an ordinal rather than a `Date`.
 */
export interface PostedDateRange {
  startMonth: number; // 1-12
  startDay: number;
  endMonth: number;
  endDay: number; // inclusive
}

/** The daily half of a rule. `offsetMinutes: 0` is a bare "sunrise to sunset". */
export type PostedDailyWindow =
  | { kind: 'daylight'; offsetMinutes: number }
  | { kind: 'clock'; openMinute: number; closeMinute: number };

/**
 * A posted rule.
 *
 * **Every field is independently optional, and that is load-bearing.** "Open year-round, daylight
 * only" has no `dateRange`; "January 1 – March 15, any hour" has no `dailyWindow`; Tomhannock needs
 * all four. Welding any two together makes one of those inexpressible.
 */
export interface PostedAccess {
  dateRange?: PostedDateRange;
  dailyWindow?: PostedDailyWindow;
  /** A gate no schedule expresses: *"Must obtain access permit from the City of Troy"*. */
  permitRequired?: boolean;
  /** Where the rule came from, shown publicly — the `depthSourceNote` precedent. */
  note?: string;
}

/** A citation, not a paragraph — it renders inline in the drawer. Matches `MAX_DEPTH_NOTE_LENGTH`. */
export const MAX_POSTED_NOTE_LENGTH = 160;

/**
 * The zone a posted rule is read in.
 *
 * A closing time is a wall clock at a specific lake, so in principle it belongs to the body rather
 * than to the app. In practice all five states the corpus covers are Eastern, so a constant is not an
 * approximation here — it is the right answer, and it is the same single-timezone pilot assumption
 * `notifications.ts` makes for the 8pm digest.
 *
 * **What has to change if the corpus ever crosses into Central**: this constant becomes a lookup on
 * the body (from `states`, or a stored zone), and every caller already threads a `timeZone` parameter
 * through to make that a one-line change rather than a refactor. That threading is why these functions
 * take the zone instead of reading this directly.
 */
export const POSTED_ACCESS_TIMEZONE = 'America/New_York';

/**
 * The widest offset a "before sunrise / after sunset" rule may carry.
 *
 * Twelve hours is not a real posted rule; it is the point past which the offset has clearly been typed
 * in the wrong unit (someone entering hours, or seconds).
 */
export const MAX_DAYLIGHT_OFFSET_MINUTES = 720;

/** Days per month, permissive about February so a Feb 29 rule round-trips in a non-leap year. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Why a posted rule was refused, or `null` when it is fine.
 *
 * Validated in `@skating/core` so the lake editor can refuse it before the round trip and the mutation
 * can refuse it again at the trust boundary — the `referenceLinkError` discipline. The client check is
 * courtesy; the server one is the guarantee.
 */
export function postedAccessError(rule: PostedAccess): string | null {
  const { dateRange, dailyWindow, permitRequired, note } = rule;

  if (dateRange) {
    for (const [label, month, day] of [
      ['start', dateRange.startMonth, dateRange.startDay],
      ['end', dateRange.endMonth, dateRange.endDay],
    ] as const) {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return `The ${label} month must be between 1 and 12.`;
      }
      const maxDay = DAYS_IN_MONTH[month - 1] as number;
      if (!Number.isInteger(day) || day < 1 || day > maxDay) {
        return `${MONTH_NAMES[month - 1]} has no day ${day}.`;
      }
    }
  }

  if (dailyWindow) {
    if (dailyWindow.kind === 'daylight') {
      const { offsetMinutes } = dailyWindow;
      if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0) {
        return 'The sunrise/sunset offset must be a whole number of minutes, or 0.';
      }
      if (offsetMinutes > MAX_DAYLIGHT_OFFSET_MINUTES) {
        return `An offset of ${offsetMinutes} minutes is over ${MAX_DAYLIGHT_OFFSET_MINUTES / 60} hours — posted rules say "a half hour", so this is probably in the wrong unit.`;
      }
    } else {
      const { openMinute, closeMinute } = dailyWindow;
      for (const [label, minute] of [
        ['opening', openMinute],
        ['closing', closeMinute],
      ] as const) {
        if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
          return `The ${label} time must be a time of day.`;
        }
      }
      if (openMinute === closeMinute) {
        return 'The opening and closing times are the same — leave the daily hours off if the rule has none.';
      }
    }
  }

  if (typeof note === 'string' && note.trim().length > MAX_POSTED_NOTE_LENGTH) {
    return `The note is ${note.trim().length} characters; keep it under ${MAX_POSTED_NOTE_LENGTH} — it renders inline, so it wants to be a citation, not a paragraph.`;
  }

  // A row that asserts nothing is worse than no row: it renders an empty "Posted rules" heading and
  // reads as "we checked and there are none", which is a different and stronger claim than silence.
  if (!dateRange && !dailyWindow && !permitRequired && !note?.trim()) {
    return 'A posted rule needs a date range, daily hours, a permit requirement, or a note.';
  }

  return null;
}

/** Is `atMs` inside the annual window, reading the calendar in `timeZone`? Wrap-around aware. */
export function isWithinDateRange(range: PostedDateRange, atMs: number, timeZone: string): boolean {
  const { month, day } = zonedParts(atMs, timeZone);
  const today = month * 100 + day;
  const start = range.startMonth * 100 + range.startDay;
  const end = range.endMonth * 100 + range.endDay;
  // A range that wraps the new year is the union of two spans, not an interval.
  return start <= end ? today >= start && today <= end : today >= start || today <= end;
}

/** `January 1 – March 15`. */
export function describeDateRange(range: PostedDateRange): string {
  const from = `${MONTH_NAMES[range.startMonth - 1]} ${range.startDay}`;
  const to = `${MONTH_NAMES[range.endMonth - 1]} ${range.endDay}`;
  return `${from} – ${to}`;
}

/** `6:00 AM`, from minutes past midnight. Matches `formatSkateTime`'s `Intl` output. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

/** "a half hour" / "an hour" / "20 minutes" — the units a sign actually uses. */
function offsetPhrase(minutes: number): string {
  if (minutes === 30) return 'a half hour';
  if (minutes === 60) return 'an hour';
  if (minutes === 90) return 'an hour and a half';
  return `${minutes} minutes`;
}

/** `sunrise to sunset` · `a half hour before sunrise to a half hour after sunset` · `6:00 AM to 8:00 PM`. */
export function describeDailyWindow(window: PostedDailyWindow): string {
  if (window.kind === 'clock') {
    return `${formatMinuteOfDay(window.openMinute)} to ${formatMinuteOfDay(window.closeMinute)}`;
  }
  if (window.offsetMinutes === 0) return 'sunrise to sunset';
  const phrase = offsetPhrase(window.offsetMinutes);
  return `${phrase} before sunrise to ${phrase} after sunset`;
}

/**
 * The whole rule on one line: `January 1 – March 15 · sunrise to sunset · permit required`.
 *
 * Deliberately **not** `seasonWindow.ts:timingWindowLabel`, which fuzzes to half-months ("late December
 * to February"). That is right for hazard sightings, where the data does not support a date. A posted
 * sign does support one, and rounding "March 15" to "March" would misstate a legal boundary.
 *
 * Returns `null` when the rule says nothing renderable, so the caller draws no heading.
 */
export function describePostedAccess(rule: PostedAccess): string | null {
  const parts: string[] = [];
  if (rule.dateRange) parts.push(describeDateRange(rule.dateRange));
  if (rule.dailyWindow) parts.push(describeDailyWindow(rule.dailyWindow));
  if (rule.permitRequired) parts.push('permit required');
  return parts.length > 0 ? parts.join(' · ') : null;
}

export type PostedAccessReason = 'out_of_range' | 'before_open' | 'after_close';

export interface PostedAccessState {
  open: boolean;
  /** Why it is shut. `null` whenever `open` is true. */
  reason: PostedAccessReason | null;
  /** When the state next flips — the closing instant while open, the next opening while shut. */
  nextChangeMs?: number;
}

/** Where and when the question is being asked. `lat`/`lon` are only read by a `daylight` window. */
export interface PostedAccessAt {
  nowMs: number;
  lat: number;
  lon: number;
  timeZone: string;
}

interface DailySpan {
  openMs: number;
  closeMs: number;
}

/**
 * Is the rule open at `at.nowMs`, and when does that change?
 *
 * **This never reports "closed" from a calculation it could not do.** A `daylight` window on a day
 * where the sun does not rise yields no span, and the honest answer there is silence rather than a
 * closure nobody posted — this whole surface annotates and never suppresses, so a false *open* costs
 * a reader nothing while a false *closed* is us inventing a restriction.
 */
export function postedAccessStateAt(rule: PostedAccess, at: PostedAccessAt): PostedAccessState {
  if (rule.dateRange && !isWithinDateRange(rule.dateRange, at.nowMs, at.timeZone)) {
    return { open: false, reason: 'out_of_range', nextChangeMs: nextRangeOpeningMs(rule, at) };
  }

  const window = rule.dailyWindow;
  if (!window) return { open: true, reason: null };

  // Yesterday's span too, because a clock window may cross midnight (open 6:00 AM, close 2:00 AM) —
  // at 1 AM the span that contains you started on the previous local day.
  const spans = [-1, 0, 1]
    .map((delta) => dailySpanOn(window, at, delta))
    .filter((span): span is DailySpan => span !== null);
  if (spans.length === 0) return { open: true, reason: null };

  const current = spans.find((s) => at.nowMs >= s.openMs && at.nowMs < s.closeMs);
  if (current) return { open: true, reason: null, nextChangeMs: current.closeMs };

  const nextOpening = spans
    .map((s) => s.openMs)
    .filter((ms) => ms > at.nowMs)
    .sort((a, b) => a - b)[0];
  const reason: PostedAccessReason =
    nextOpening !== undefined && isSameLocalDay(nextOpening, at.nowMs, at.timeZone)
      ? 'before_open'
      : 'after_close';
  return {
    open: false,
    reason,
    ...(nextOpening !== undefined ? { nextChangeMs: nextOpening } : {}),
  };
}

/** The open/close instants of `window` on the local day `dayDelta` days from `at.nowMs`. */
function dailySpanOn(
  window: PostedDailyWindow,
  at: PostedAccessAt,
  dayDelta: number,
): DailySpan | null {
  const anchorMs = at.nowMs + dayDelta * DAY_MS;
  if (window.kind === 'clock') {
    // A close earlier in the day than the open means the window runs past midnight; `zonedInstant`
    // normalizes the minute overflow into the next day.
    const closeMinute =
      window.closeMinute > window.openMinute
        ? window.closeMinute
        : window.closeMinute + MINUTES_PER_DAY;
    return {
      openMs: zonedInstantOnDayOf(anchorMs, window.openMinute, at.timeZone),
      closeMs: zonedInstantOnDayOf(anchorMs, closeMinute, at.timeZone),
    };
  }
  const sun = sunTimes(anchorMs, at.lat, at.lon, at.timeZone);
  if (!sun) return null;
  return {
    openMs: sun.sunriseMs - window.offsetMinutes * MINUTE_MS,
    closeMs: sun.sunsetMs + window.offsetMinutes * MINUTE_MS,
  };
}

/** The next instant the annual window opens — its start date, at that day's opening time. */
function nextRangeOpeningMs(rule: PostedAccess, at: PostedAccessAt): number | undefined {
  const range = rule.dateRange;
  if (!range) return undefined;
  const today = zonedParts(at.nowMs, at.timeZone);
  const todayOrd = today.month * 100 + today.day;
  const startOrd = range.startMonth * 100 + range.startDay;
  const year = todayOrd < startOrd ? today.year : today.year + 1;
  const midnight = zonedInstant(year, range.startMonth, range.startDay, 0, at.timeZone);
  if (!rule.dailyWindow) return midnight;
  // Anchor on noon of the start day so the daylight span is computed for the right calendar date.
  return (
    dailySpanOn(rule.dailyWindow, { ...at, nowMs: midnight + DAY_MS / 2 }, 0)?.openMs ?? midnight
  );
}

function isSameLocalDay(aMs: number, bMs: number, timeZone: string): boolean {
  const a = zonedParts(aMs, timeZone);
  const b = zonedParts(bMs, timeZone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * What the rule means right now: `Closed now · opens 6:42 AM`, `Open now · until 4:39 PM`.
 *
 * The companion to `describePostedAccess`, never a replacement for it. The rule is the durable,
 * checkable fact and this is its consequence at one moment; a drawer showing only the second leaves a
 * reader unable to plan tomorrow, and one showing only the first makes them do the arithmetic.
 *
 * Returns `null` when there is nothing to add — an always-open rule has no state worth a line.
 */
export function describePostedAccessNow(state: PostedAccessState, timeZone: string): string | null {
  if (state.open) {
    if (state.nextChangeMs === undefined) return null;
    return `Open now · until ${formatZonedTime(state.nextChangeMs, timeZone)}`;
  }
  if (state.nextChangeMs === undefined) return 'Closed now';
  // Out of season is answered with a date; a daily window with a time. "Opens 6:42 AM" would be true
  // and useless in October.
  const when =
    state.reason === 'out_of_range'
      ? formatZonedDate(state.nextChangeMs, timeZone)
      : formatZonedTime(state.nextChangeMs, timeZone);
  return `Closed now · opens ${when}`;
}

function formatZonedTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(ms));
}

function formatZonedDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(new Date(ms));
}
