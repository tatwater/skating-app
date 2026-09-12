/**
 * The cold chain — D159's headline predicate, as the founder defined it (N6h / **D164**).
 *
 * > *"The nights-below are intended to be a chain of nights in a row (seeing temps below 20°F within
 * > 48 h of each other counts as consecutive)… 'No snow since' is since the last <20°F."*
 *
 * A chain is a run of nights whose minimum fell below a threshold, where **one** non-cold night
 * between two cold ones does not break it — that is the 48-hour rule, and it is a founder rule
 * rather than a physics constant, so it is {@link COLD_CHAIN_BRIDGE_NIGHTS} and nothing else. A night
 * the archive did not observe neither counts nor breaks: it consumes the same tolerance, because an
 * unknown night read as warm would silently end a real cold snap and read as cold would invent one.
 *
 * ## Why the chain is its own anchor
 *
 * Every since-style predicate before this borrowed its start from a user-visible entity — a report's
 * `skateEndTime`, a hazard's `lastConfirmedAt`. A lake nobody has written about had no anchor, so
 * *"no snow since"* was a claim with an invisible start. The chain supplies one: **the first night of
 * the current chain**, and the copy names it (*"4 nights below 20°F, no snow since the first"*).
 *
 * ## One definition, both surfaces
 *
 * The corpus-wide digest, the body-result card and the drawer's past-weather headline all call
 * {@link coldChain}. `nightsBelowThresholdC` — a count of cold nights in a window — is what the
 * headline used to print, and *"4 nights below 20°F"* meaning "four of the last seven" on one surface
 * and "four in a row" on another is exactly the two-definitions bug hole 3 was written to prevent.
 *
 * ## Walked by day key, never by array index
 *
 * The archive can hold a hole — a day with no row at all — and an array walk would put the nights on
 * either side of it next to each other. So the walk asks for each calendar day in turn and treats an
 * absent one as unobserved.
 */

import { cmToInches, formatTemperatureF, fToC, roundTo } from './units';
import { dayMsToLocalDate, monthDayLabel } from './weatherDay';

const DAY_MS = 86_400_000;

/**
 * The pinned thresholds, in °F (founder call 18). Four, not a slider: the digest carries one chain per
 * threshold, and a per-degree digest is a table nobody asked for. 32 is *"is it freezing at all"*,
 * 20 is the founder's, 10 and 0 are deep cold.
 */
export const COLD_CHAIN_THRESHOLDS_F = [32, 20, 10, 0] as const;
export type ColdChainThresholdF = (typeof COLD_CHAIN_THRESHOLDS_F)[number];

export function isColdChainThresholdF(value: unknown): value is ColdChainThresholdF {
  return (COLD_CHAIN_THRESHOLDS_F as readonly unknown[]).includes(value);
}

/**
 * The 48-hour rule as a count of nights: how many consecutive non-cold (or unobserved) nights a chain
 * survives. ⚠ A founder rule, not a physics constant (call 16).
 */
export const COLD_CHAIN_BRIDGE_NIGHTS = 1;

/**
 * Snowfall since the chain's first night below which "no snow since" holds, in cm. 0.5 cm is a
 * dusting the wind removes — the same number the panel uses (`PANEL_SNOW_THRESHOLD_CM`), pinned here
 * because the two must agree and the panel's constant lives a layer above this one.
 */
export const COLD_CHAIN_SNOW_FLOOR_CM = 0.5;

/** The most a chain is ever walked. The digest's window; a chain reaching it reads as open-ended. */
export const COLD_CHAIN_MAX_SPAN_DAYS = 30;

/** One night as the chain sees it: the day the night *ended on*, its minimum, and that day's snow. */
export interface ColdChainDay {
  dayMs: number;
  /** `null` when the archive did not observe the whole night — neither cold nor warm. */
  nightMinTempC: number | null;
  /** `null` when unknown — which is not zero, and the chain says so. */
  snowfallCm: number | null;
}

export interface ColdChain {
  thresholdF: ColdChainThresholdF;
  /** Cold nights in the chain. `0` when there is no chain. */
  nights: number;
  /**
   * The day the first cold night ended on — the anchor *"since the first"* names. `null` when
   * `nights` is 0.
   */
  startDayMs: number | null;
  /** The day the last cold night ended on. `null` when `nights` is 0. */
  endDayMs: number | null;
  /**
   * Which days from `startDayMs` were cold nights, as a bit mask: bit *i* set ⇔ the night ending on
   * `startDayMs + i·day` was cold. One number instead of an array so a digest row stays small, and
   * {@link nthColdNightDayMs} recovers the day any requested length was reached on.
   */
  coldNightMask: number;
  /**
   * True when the newest night is cold, or within {@link COLD_CHAIN_BRIDGE_NIGHTS} of a cold one —
   * the chain is still running. False when it was broken by two non-cold nights; `nights` then
   * describes the most recent chain that *was*, for the panel to date its end.
   */
  alive: boolean;
  /**
   * True when the walk reached the oldest day it was given while still inside the chain, so the
   * chain may be longer than `nights`. The copy prints *"30+ nights"*.
   */
  openEnded: boolean;
  /** Snowfall on and after `startDayMs`, cm, over the days that reported one. */
  snowSinceStartCm: number;
  /**
   * Days on or after `startDayMs` with no snowfall figure. Non-zero means *"no snow since"* cannot
   * be claimed — an absent day must never read as "no snow fell" (D161 step 4).
   */
  snowUnknownDays: number;
  /** The day the newest night the walk considered ended on — what "as of" means. */
  asOfDayMs: number | null;
}

/**
 * Walk the days newest-first and find the current chain at `thresholdF`.
 *
 * `days` may arrive in any order and with holes; only `dayMs` keys matter. `asOfDayMs` bounds the
 * walk (defaults to the newest day given) so a caller can ask *"as of yesterday"* while holding
 * today's partial row.
 */
export function coldChain(
  days: readonly ColdChainDay[],
  thresholdF: ColdChainThresholdF,
  options: { asOfDayMs?: number; maxSpanDays?: number } = {},
): ColdChain {
  const thresholdC = fToC(thresholdF);
  const byDay = new Map<number, ColdChainDay>();
  let newest = Number.NEGATIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  for (const d of days) {
    if (options.asOfDayMs !== undefined && d.dayMs > options.asOfDayMs) continue;
    byDay.set(d.dayMs, d);
    if (d.dayMs > newest) newest = d.dayMs;
    if (d.dayMs < oldest) oldest = d.dayMs;
  }
  const empty: ColdChain = {
    thresholdF,
    nights: 0,
    startDayMs: null,
    endDayMs: null,
    coldNightMask: 0,
    alive: false,
    openEnded: false,
    snowSinceStartCm: 0,
    snowUnknownDays: 0,
    asOfDayMs: null,
  };
  if (!Number.isFinite(newest)) return empty;
  const asOf = options.asOfDayMs ?? newest;
  const maxSpan = options.maxSpanDays ?? COLD_CHAIN_MAX_SPAN_DAYS;
  const isCold = (dayMs: number): boolean | null => {
    const min = byDay.get(dayMs)?.nightMinTempC;
    return typeof min === 'number' ? min < thresholdC : null;
  };

  // Find the newest cold night, allowing the bridge from the as-of night. If it is further back than
  // the bridge allows, the chain that ended there is *not* alive — but it is still the most recent
  // one, and the panel wants to date its end. So keep looking, just remember whether we crossed it.
  let end: number | null = null;
  let alive = false;
  for (let i = 0; i < maxSpan; i++) {
    const day = asOf - i * DAY_MS;
    if (day < oldest) break;
    if (isCold(day) === true) {
      end = day;
      alive = i <= COLD_CHAIN_BRIDGE_NIGHTS;
      break;
    }
  }
  if (end === null) return { ...empty, asOfDayMs: asOf };

  // Walk back from the end. A run of more than `COLD_CHAIN_BRIDGE_NIGHTS` non-cold nights breaks it;
  // the start is the last cold night reached before that.
  let start = end;
  let nights = 1;
  let gap = 0;
  let openEnded = false;
  for (let i = 1; ; i++) {
    const day = end - i * DAY_MS;
    const span = (end - day) / DAY_MS + 1;
    if (day < oldest || span > maxSpan) {
      // Ran out of days with the last night examined cold: the chain may go on beyond what was
      // given, and the copy must not print a hard number. Running out inside a bridgeable gap is
      // reported as it stands — the night beyond it is unknown either way, and printing "+" on every
      // chain that ends near a window edge would make the mark meaningless.
      openEnded = gap === 0;
      break;
    }
    if (isCold(day) === true) {
      start = day;
      nights += 1;
      gap = 0;
    } else {
      gap += 1;
      if (gap > COLD_CHAIN_BRIDGE_NIGHTS) break;
    }
  }

  let mask = 0;
  for (let day = start; day <= end; day += DAY_MS) {
    if (isCold(day) === true) mask += 2 ** ((day - start) / DAY_MS);
  }

  let snow = 0;
  let unknown = 0;
  for (let day = start; day <= asOf; day += DAY_MS) {
    const cm = byDay.get(day)?.snowfallCm;
    if (typeof cm === 'number') snow += cm;
    else unknown += 1;
  }

  return {
    thresholdF,
    nights,
    startDayMs: start,
    endDayMs: end,
    coldNightMask: mask,
    alive,
    openEnded,
    snowSinceStartCm: snow,
    snowUnknownDays: unknown,
    asOfDayMs: asOf,
  };
}

/**
 * The day the chain's `n`-th cold night (1-based) ended on, or `null` when it has fewer. This is the
 * feed's event time for *"at least N nights"* — the morning the lake crossed the line asked about.
 */
export function nthColdNightDayMs(
  chain: Pick<ColdChain, 'startDayMs' | 'coldNightMask' | 'nights'>,
  n: number,
): number | null {
  if (chain.startDayMs === null || n < 1 || n > chain.nights) return null;
  let seen = 0;
  let mask = chain.coldNightMask;
  for (let i = 0; mask > 0 && i <= COLD_CHAIN_MAX_SPAN_DAYS; i++) {
    if (mask % 2 === 1) {
      seen += 1;
      if (seen === n) return chain.startDayMs + i * DAY_MS;
    }
    mask = Math.floor(mask / 2);
  }
  return null;
}

/** Does the chain honestly satisfy *"no snow since the first night"*? Unknown days say no. */
export function noSnowSinceChain(
  chain: Pick<ColdChain, 'nights' | 'snowUnknownDays' | 'snowSinceStartCm'>,
): boolean {
  return (
    chain.nights > 0 &&
    chain.snowUnknownDays === 0 &&
    chain.snowSinceStartCm < COLD_CHAIN_SNOW_FLOOR_CM
  );
}

/** The threshold as the copy prints it — `20°F`, from the pinned Fahrenheit value. */
export function thresholdLabel(thresholdF: ColdChainThresholdF): string {
  return formatTemperatureF(fToC(thresholdF));
}

/**
 * The chain as one sentence, for the card and the panel alike.
 *
 * - alive: *"4 nights below 20°F, no snow since the first"* / *"…, 1.2 in of snow since the first"*
 *   / *"…, snow since the first unknown for 2 days"*. An open-ended chain prints *"30+ nights"*.
 * - ended: *"Run of 3 nights below 20°F ended Feb 3"* — the panel's case; the filter never matches
 *   a dead chain, so a card never prints this.
 * - none: `null`; the caller decides whether to say *"No nights below 20°F"* and over what window.
 */
export function describeColdChain(
  chain: Pick<
    ColdChain,
    'thresholdF' | 'nights' | 'startDayMs' | 'openEnded' | 'snowSinceStartCm' | 'snowUnknownDays'
  > &
    // A stored digest chain is alive by construction and carries no end; a computed one says.
    Partial<Pick<ColdChain, 'alive' | 'endDayMs'>>,
): string | null {
  if (chain.nights === 0 || chain.startDayMs === null) return null;
  const t = thresholdLabel(chain.thresholdF);
  const count = `${chain.openEnded ? `${chain.nights}+` : chain.nights} night${chain.nights === 1 && !chain.openEnded ? '' : 's'}`;
  if (chain.alive === false) {
    if (typeof chain.endDayMs !== 'number') return null;
    return `Run of ${count} below ${t} ended ${monthDayLabel(dayMsToLocalDate(chain.endDayMs))}`;
  }
  let snow: string;
  if (chain.snowUnknownDays > 0) {
    snow = `snow since the first unknown for ${chain.snowUnknownDays} day${chain.snowUnknownDays === 1 ? '' : 's'}`;
  } else if (chain.snowSinceStartCm < COLD_CHAIN_SNOW_FLOOR_CM) {
    snow = 'no snow since the first';
  } else {
    snow = `${roundTo(cmToInches(chain.snowSinceStartCm), 1)} in of snow since the first`;
  }
  return `${count} below ${t}, ${snow}`;
}
