/**
 * The weather the sheet shows beside the end time (A10 §4, founder call 2026-09-21): the archive's
 * hour at the body when the skater got off, and — once a start time or a duration is given — the
 * whole run of hours they were on the ice. Pure over the hours `getWeatherDaysForBody` already
 * returns for the drawer's past-weather panel, so the sheet costs no new Open-Meteo call.
 *
 * Two jobs: *show* (a sentence per hour and one for the window, in the units the skater reads) and
 * *seed* (the `conditions` block a correction starts from, through the same mapping the server's
 * autofill uses, so "correct it" edits the number the server would have stored).
 *
 * Nothing here is a safety claim (D3 / D150): it is what the weather did, never what the ice is.
 */

import type { ReportConditionsInput } from './report';
import { cToF, kphToMph, roundTo } from './units';
import { precipTypeFrom, windDirToCompass } from './weatherConditions';
import { utcOffsetSecondsAt, utcOffsetSecondsInZone } from './weatherDay';
import { precipitationKind, type TimelineHour } from './weatherTimeline';

const HOUR_MS = 60 * 60 * 1000;

/** One stored hour as the archive keeps it — the timeline's hour without the day's date, which lives on the day. */
export type ArchivedHour = Omit<TimelineHour, 'localDate'>;

/** A day of archived hours as the panel action returns it. */
export interface WeatherWindowDay {
  dayMs: number;
  hours: readonly ArchivedHour[];
}

/** One archived hour placed on the clock. */
export interface WindowHour extends ArchivedHour {
  /** The instant the hour began, at the body. */
  startMs: number;
}

/**
 * The instant a stored local hour began. `dayMs` is the local date at UTC midnight; local midnight
 * is that minus the day's offset, and the hour's own offset is read at the hour so a series across
 * a DST change keeps every hour on the wall clock the lake had (`utcOffsetSecondsAt`).
 */
export function hourStartMs(dayMs: number, localHour: number, timeZone: string): number | null {
  const dayOffset = utcOffsetSecondsInZone(dayMs, timeZone);
  if (dayOffset === null) return null;
  const approx = dayMs - dayOffset * 1000 + localHour * HOUR_MS;
  const offset = utcOffsetSecondsAt(approx, timeZone);
  if (offset === null) return null;
  return dayMs - offset * 1000 + localHour * HOUR_MS;
}

/** Every archived hour, on the clock, ascending. Days with no hours contribute nothing. */
export function placeHours(days: readonly WeatherWindowDay[], timeZone: string): WindowHour[] {
  const out: WindowHour[] = [];
  for (const day of days) {
    for (const hour of day.hours) {
      const startMs = hourStartMs(day.dayMs, hour.localHour, timeZone);
      if (startMs === null) continue;
      out.push({ ...hour, startMs });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The hours a skate covered: the hour the end time falls in when there is no start, else every
 * hour that overlaps `[start, end]`. Empty when the archive has nothing there yet — the sheet then
 * shows nothing, never a guess.
 */
export function hoursInWindow(
  hours: readonly WindowHour[],
  endMs: number,
  startMs?: number,
): WindowHour[] {
  const from = startMs ?? endMs;
  return hours.filter((h) => h.startMs + HOUR_MS > from && h.startMs <= endMs);
}

/** The hour the end time falls in, or `null` when the archive has none. */
export function hourAt(hours: readonly WindowHour[], ms: number): WindowHour | null {
  return hours.find((h) => h.startMs <= ms && ms < h.startMs + HOUR_MS) ?? null;
}

/** "24 °F · wind NW 8 mph · snow" — one hour, in the units the skater reads. Sun is left to the window. */
export function describeWeatherHour(hour: ArchivedHour): string {
  const parts = [`${roundTo(cToF(hour.temperatureC), 0)} °F`];
  if (hour.windSpeedKph !== undefined) {
    const mph = roundTo(kphToMph(hour.windSpeedKph), 0);
    const dir =
      hour.windDirectionDeg === undefined ? '' : `${windDirToCompass(hour.windDirectionDeg)} `;
    parts.push(mph === 0 ? 'calm' : `wind ${dir}${mph} mph`);
  }
  const precip = precipitationKind(hour);
  if (precip) parts.push(precip.label.toLowerCase());
  return parts.join(' · ');
}

export interface WeatherWindowSummary {
  hours: number;
  minF: number;
  maxF: number;
  /** Peak wind over the window, mph, and the compass point it mostly blew from. */
  maxWindMph?: number;
  windFrom?: string;
  /** Total precipitation over the window, mm, and whether any of it fell as snow. */
  precipitationMm: number;
  snowed: boolean;
  /** One sentence: "1–4 PM: 22–27 °F, wind up to 12 mph from the NW, 0.3 in of snow". */
  sentence: string;
}

/**
 * The whole skate's weather in one line, for the sheet under a start-and-end pair. Ranges, never a
 * mean — a skater remembers "it got windy" and a mean hides it.
 */
export function summarizeWeatherWindow(
  hours: readonly WindowHour[],
  timeZone: string,
): WeatherWindowSummary | null {
  if (hours.length === 0) return null;
  const tempsF = hours.map((h) => cToF(h.temperatureC));
  const minF = roundTo(Math.min(...tempsF), 0);
  const maxF = roundTo(Math.max(...tempsF), 0);
  const winds = hours.filter((h) => h.windSpeedKph !== undefined);
  const maxWindMph =
    winds.length > 0
      ? roundTo(kphToMph(Math.max(...winds.map((h) => h.windSpeedKph as number))), 0)
      : undefined;
  const windFrom = dominantWindFrom(winds);
  const precipitationMm = roundTo(
    hours.reduce(
      (sum, h) => sum + (h.precipitationMm ?? (h.rainMm ?? 0) + (h.snowfallCm ?? 0) * 10),
      0,
    ),
    1,
  );
  const snowed = hours.some((h) => (h.snowfallCm ?? 0) > 0);

  const first = hours[0] as WindowHour;
  const last = hours[hours.length - 1] as WindowHour;
  const span =
    hours.length === 1
      ? clockLabel(first.startMs, timeZone)
      : `${clockLabel(first.startMs, timeZone)}–${clockLabel(last.startMs + HOUR_MS, timeZone)}`;
  const parts = [minF === maxF ? `${minF} °F` : `${minF}–${maxF} °F`];
  if (maxWindMph !== undefined) {
    parts.push(
      maxWindMph === 0
        ? 'calm'
        : `wind up to ${maxWindMph} mph${windFrom ? ` from the ${windFrom}` : ''}`,
    );
  }
  if (precipitationMm > 0) {
    parts.push(
      snowed ? `${snowLabel(hours)} of snow` : `${roundTo(precipitationMm / 25.4, 2)} in of rain`,
    );
  }
  return {
    hours: hours.length,
    minF,
    maxF,
    ...(maxWindMph !== undefined ? { maxWindMph } : {}),
    ...(windFrom !== undefined ? { windFrom } : {}),
    precipitationMm,
    snowed,
    sentence: `${span}: ${parts.join(', ')}`,
  };
}

function snowLabel(hours: readonly WindowHour[]): string {
  const cm = hours.reduce((sum, h) => sum + (h.snowfallCm ?? 0), 0);
  const inches = roundTo(cm / 2.54, 1);
  return inches < 0.1 ? 'a dusting' : `${inches} in`;
}

/** The compass point the wind mostly blew from over the window — the modal sector, ties to the first. */
function dominantWindFrom(hours: readonly ArchivedHour[]): string | undefined {
  const counts = new Map<string, number>();
  for (const h of hours) {
    if (h.windDirectionDeg === undefined || (h.windSpeedKph ?? 0) === 0) continue;
    const dir = windDirToCompass(h.windDirectionDeg);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

function clockLabel(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric' }).format(ms);
}

/**
 * The `conditions` block a correction starts from — the archive's hour through the server's own
 * mapping (`conditionsFromHour`'s pieces), so the author edits the number the autofill would have
 * stored rather than a rounded label. `source` is left to the sheet: it stamps `user` once the
 * author changes anything.
 */
export function conditionsFromWindowHour(
  hour: ArchivedHour,
): Omit<ReportConditionsInput, 'source'> {
  const rainMm = hour.rainMm ?? 0;
  const snowfallCm = hour.snowfallCm ?? 0;
  const precip = precipTypeFrom(rainMm, snowfallCm);
  return {
    airTempC: hour.temperatureC,
    ...(hour.windSpeedKph !== undefined ? { windSpeedKph: hour.windSpeedKph } : {}),
    ...(hour.windDirectionDeg !== undefined
      ? { windDir: windDirToCompass(hour.windDirectionDeg) }
      : {}),
    // The archive stores no cloud cover; a WMO code names the sky when the hour has one.
    ...(skyFromCode(hour.weatherCode, precip !== 'none') !== undefined
      ? { sky: skyFromCode(hour.weatherCode, precip !== 'none') }
      : {}),
    precip,
  };
}

/** WMO 0 clear · 1–2 partly cloudy · 3 overcast · ≥ 40 precipitating; anything else unknown. */
function skyFromCode(
  code: number | undefined,
  precipitating: boolean,
): ReportConditionsInput['sky'] | undefined {
  if (precipitating) return 'precip';
  if (code === undefined) return undefined;
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly_cloudy';
  if (code === 3) return 'overcast';
  if (code >= 40) return 'precip';
  return undefined;
}
