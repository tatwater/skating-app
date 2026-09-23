/**
 * The sheet's timeline (A10-6 / D206): the skate's day as a ruler. Sunrise and sunset as the lake
 * has them, the start and end of this Report as carets, *now*, the other Reports of the Post as
 * faded spans, photos at the minute they were taken, and D192's half-hour ladder as the tappable
 * ticks. One pure model; each surface draws it and maps a drag or a tap back through it.
 *
 * The domain is the day's daylight plus whatever the skate and the photos need: from an hour before
 * sunrise (or the earliest thing on it) to an hour after sunset (or the latest), on whole local
 * hours, never shorter than `MIN_SPAN_MS`. *Now* is drawn only when it falls on the same day as the
 * end time — a draft resumed tomorrow does not stretch to tomorrow.
 *
 * Nothing here is a safety claim (D3): times are when the author was there.
 */

import type { SunTimes } from './solar';
import { zonedMinuteOfDay } from './zonedTime';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The ruler is never shorter than this, so a short skate still reads as a time of day. */
export const MIN_SPAN_MS = 6 * HOUR_MS;
const EDGE_MS = HOUR_MS;

export interface TimelineOtherReport {
  id: string;
  label: string;
  startMs?: number;
  endMs: number;
}

export interface TimelinePhotoInput {
  id: string;
  takenAtMs: number;
  /** On this Report (else another Report of the Post, drawn dim). */
  mine: boolean;
  placed: boolean;
}

export interface TimelineInput {
  timeZone: string;
  nowMs: number;
  endMs?: number;
  startMs?: number;
  /** Civil sunrise and sunset for the end time's day at the body; `null` when unknown. */
  sun: SunTimes | null;
  others?: readonly TimelineOtherReport[];
  photos?: readonly TimelinePhotoInput[];
  /** D192's chips — the pinned minute and the half-hours — as tappable ticks. */
  ladder?: readonly { ms: number; pinned: boolean }[];
}

export type TimelineMarkKind = 'sunrise' | 'sunset' | 'start' | 'end' | 'now';

export interface TimelineMark {
  kind: TimelineMarkKind;
  ms: number;
  /** "END 4:12", "SUNSET 4:31", "NOW 6:40". */
  label: string;
  fraction: number;
}

export interface TimelineTick {
  ms: number;
  /** "8 AM", "9", "NOON", "1 PM"… — the period only where it changes. */
  label: string;
  fraction: number;
}

export interface TimelineSpan {
  id: string;
  label?: string;
  from: number;
  to: number;
  mine: boolean;
}

export interface TimelinePhoto extends TimelinePhotoInput {
  fraction: number;
}

export interface TimelineLadderTick {
  ms: number;
  pinned: boolean;
  /** "4:30" in the zone, for the tick's accessible name. */
  label: string;
  fraction: number;
}

export interface TimelineModel {
  fromMs: number;
  toMs: number;
  ticks: TimelineTick[];
  marks: TimelineMark[];
  spans: TimelineSpan[];
  photos: TimelinePhoto[];
  ladder: TimelineLadderTick[];
}

/** The most recent local whole hour at or before `ms`. */
export function floorToLocalHour(ms: number, timeZone: string): number {
  const minuteOfDay = zonedMinuteOfDay(ms, timeZone);
  return ms - (ms % MINUTE_MS) - (minuteOfDay % 60) * MINUTE_MS;
}

/** "4:12" in the zone — the marks carry their word ("END", "SUNSET") beside it. */
export function clockLabel(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(ms)
    .replace(/\s?[AP]M$/i, '');
}

/** The tick's hour and period, from one formatter shared across the ruler. */
function hourParts(fmt: Intl.DateTimeFormat, ms: number): { hour: number; period: string } {
  const parts = fmt.formatToParts(ms);
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '0'),
    period: (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toUpperCase(),
  };
}

function hourLabel(hour: number, period: string, first: boolean, previousHour: number): string {
  if (hour === 12) return period === 'PM' ? 'NOON' : '12 AM';
  const periodChanged = previousHour >= 0 && hour < previousHour;
  return first || periodChanged ? `${hour} ${period}` : String(hour);
}

/** Where an instant sits on the ruler, 0…1, clamped. */
export function timelineFraction(
  model: Pick<TimelineModel, 'fromMs' | 'toMs'>,
  ms: number,
): number {
  const span = model.toMs - model.fromMs;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (ms - model.fromMs) / span));
}

/** The instant under a fraction of the ruler, to the minute — what a drag hands back. */
export function timelineMsAt(
  model: Pick<TimelineModel, 'fromMs' | 'toMs'>,
  fraction: number,
): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  const ms = model.fromMs + clamped * (model.toMs - model.fromMs);
  return Math.round(ms / MINUTE_MS) * MINUTE_MS;
}

export function timelineModel(input: TimelineInput): TimelineModel {
  const { timeZone, nowMs, endMs, startMs, sun } = input;
  const anchor = endMs ?? nowMs;
  // One formatter each for the day test and the hour ticks: constructing `Intl` is the expensive
  // half, and a ruler asks the day question of every photo and Report and the hour of every tick.
  const dayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: true });
  const anchorDay = dayFmt.format(anchor);
  const onDay = (ms: number) => dayFmt.format(ms) === anchorDay;
  // Everything the ruler draws is on the anchor's day: another day's Report, photo or ladder chip
  // (a draft resumed tomorrow carries today's ladder) is not stretched to and not drawn.
  const others = (input.others ?? []).filter((o) => onDay(o.endMs));
  const photos = (input.photos ?? []).filter((ph) => onDay(ph.takenAtMs));
  const ladder = (input.ladder ?? []).filter((l) => onDay(l.ms));
  const nowOnDay = onDay(nowMs);

  const lows: number[] = [];
  const highs: number[] = [];
  if (sun) {
    lows.push(sun.sunriseMs - EDGE_MS);
    highs.push(sun.sunsetMs + EDGE_MS);
  }
  if (endMs !== undefined) {
    lows.push(endMs - EDGE_MS);
    highs.push(endMs + EDGE_MS);
  }
  if (startMs !== undefined) lows.push(startMs - EDGE_MS);
  if (nowOnDay) highs.push(nowMs + EDGE_MS / 2);
  for (const o of others) {
    lows.push((o.startMs ?? o.endMs) - EDGE_MS / 2);
    highs.push(o.endMs + EDGE_MS / 2);
  }
  for (const ph of photos) {
    lows.push(ph.takenAtMs - EDGE_MS / 2);
    highs.push(ph.takenAtMs + EDGE_MS / 2);
  }
  for (const l of ladder) lows.push(l.ms - EDGE_MS / 2);
  if (lows.length === 0) lows.push(anchor - MIN_SPAN_MS / 2);
  if (highs.length === 0) highs.push(anchor + MIN_SPAN_MS / 2);

  let fromMs = floorToLocalHour(Math.min(...lows), timeZone);
  let toMs = floorToLocalHour(Math.max(...highs), timeZone) + HOUR_MS;
  if (toMs - fromMs < MIN_SPAN_MS) {
    const pad = MIN_SPAN_MS - (toMs - fromMs);
    fromMs -= Math.floor(pad / 2 / HOUR_MS) * HOUR_MS;
    toMs = fromMs + MIN_SPAN_MS;
  }
  // Never more than a day: a photo from the night before does not turn the ruler into a week.
  if (toMs - fromMs > DAY_MS) fromMs = toMs - DAY_MS;

  const model: Pick<TimelineModel, 'fromMs' | 'toMs'> = { fromMs, toMs };
  const ticks: TimelineTick[] = [];
  let previousHour = -1;
  for (let ms = fromMs; ms <= toMs; ms += HOUR_MS) {
    const { hour, period } = hourParts(hourFmt, ms);
    const label = hourLabel(hour, period, ticks.length === 0, previousHour);
    previousHour = hour;
    ticks.push({ ms, label, fraction: timelineFraction(model, ms) });
  }

  const marks: TimelineMark[] = [];
  const mark = (kind: TimelineMarkKind, ms: number, word: string) =>
    marks.push({
      kind,
      ms,
      label: `${word} ${clockLabel(ms, timeZone)}`,
      fraction: timelineFraction(model, ms),
    });
  if (sun) {
    mark('sunrise', sun.sunriseMs, 'SUNRISE');
    mark('sunset', sun.sunsetMs, 'SUNSET');
  }
  if (startMs !== undefined) mark('start', startMs, 'START');
  if (endMs !== undefined) mark('end', endMs, 'END');
  if (nowOnDay) mark('now', nowMs, 'NOW');

  const spans: TimelineSpan[] = [];
  if (endMs !== undefined && startMs !== undefined && startMs < endMs) {
    spans.push({
      id: 'mine',
      from: timelineFraction(model, startMs),
      to: timelineFraction(model, endMs),
      mine: true,
    });
  }
  for (const o of others) {
    const from = o.startMs ?? o.endMs - 30 * MINUTE_MS;
    spans.push({
      id: o.id,
      label: o.label,
      from: timelineFraction(model, from),
      to: timelineFraction(model, o.endMs),
      mine: false,
    });
  }

  return {
    fromMs,
    toMs,
    ticks,
    marks,
    spans,
    photos: photos.map((ph) => ({ ...ph, fraction: timelineFraction(model, ph.takenAtMs) })),
    ladder: ladder.map((l) => ({
      ...l,
      label: clockLabel(l.ms, timeZone),
      fraction: timelineFraction(model, l.ms),
    })),
  };
}
