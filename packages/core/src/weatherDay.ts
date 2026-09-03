/**
 * Daily weather observations — the durable half of the weather panel (N6h / **D153**).
 *
 * ## Why this is a separate reducer from `summarizeWeatherSince`
 *
 * That one answers *"what has the weather done since this report was filed"* — one window, one
 * summary, anchored to something a user did. This one answers *"what has this lake been through, day
 * by day"* — a series, anchored to nothing, and **true for ever once computed**. Same hourly input,
 * different shape, different lifetime: a weather-since summary is cached for an hour bucket and
 * pruned at 24 h, a day summary is written once and kept for the season.
 *
 * ## The day boundary problem, and why hours carry a local *date* rather than a shifted timestamp
 *
 * `HourlyWeather.startMs` is deliberately **local-shifted** (`weather.ts` adds
 * `utc_offset_seconds`), which is right for night bucketing and wrong for anything that needs a
 * calendar. Open-Meteo returns a **single** `utc_offset_seconds` for the whole response, so across a
 * DST transition — and both of them fall inside a Northeast skating season — the shift is an hour out
 * for part of the window. Deriving calendar days by dividing that shifted value by 86 400 000 would
 * quietly misfile an hour on either side of the change.
 *
 * So the archive fetch asks Open-Meteo for `timeformat=iso8601`, which returns local wall-clock
 * strings, and every hour arrives here already carrying the **local date and hour the lake actually
 * experienced**. No offset arithmetic happens in this file at all, which is the only way to be
 * DST-correct without a timezone database.
 *
 * ## Two temperature minima, deliberately
 *
 * `minTempC` is the calendar-day minimum — what a reader expects a daily row's "low" to mean.
 * `nightMinTempC` is the minimum across an explicit **night window**, defined once here and used by
 * the cross-body filter (D159), whose headline predicate is *"three nights below 20°F"*. A night
 * spans two calendar days, so without a single shared definition the feed and the drawer would
 * disagree about the same lake while both looked right in isolation.
 */

import type { HourlyWeather } from './weather';

const DAY_MS = 86_400_000;

/**
 * The night that *ended* on a given morning: from 18:00 the previous evening to 09:00 that day.
 *
 * Attached to the day it ends on, not the day it starts on, because that is how the question is
 * asked — *"how cold did it get last night"* is asked in the morning, about the ice you are standing
 * on now. It also means a day's night window is complete the moment that day's hours are, so a daily
 * append never has to wait for tomorrow to close a row.
 */
export const NIGHT_START_HOUR = 18;
export const NIGHT_END_HOUR = 9;

/** Compass sectors for the wind histogram — the same 16 the fetch profile and wind rose are indexed by. */
export const WIND_SECTOR_COUNT = 16;

/** An hourly observation that knows what local day and hour it happened on. */
export interface LocalHourlyWeather extends HourlyWeather {
  /** Local calendar date as Open-Meteo returned it under `timezone=auto`, `YYYY-MM-DD`. */
  localDate: string;
  /** Local hour of day, 0–23. */
  localHour: number;
  /** Open-Meteo `wind_direction_10m` (degrees, meteorological — the direction wind comes *from*). */
  windDirectionDeg?: number;
}

export interface WeatherDaySummary {
  /**
   * The local calendar date as `Date.UTC(y, m, d)`. **A sortable key, not an instant** — it is UTC
   * midnight of a *local* date, which is a real moment somewhere else. Never render it with a
   * local-timezone formatter; format the date parts, or the label slips a day for half the world.
   */
  dayMs: number;
  /** `YYYY-MM-DD`, kept alongside `dayMs` so a reader never has to reverse the encoding above. */
  localDate: string;

  /** Hours actually observed. **Not always 24** — DST days are 23 or 25, and a partial day is short. */
  hours: number;

  minTempC: number | null;
  maxTempC: number | null;
  meanTempC: number | null;
  /**
   * Minimum across [previous 18:00, this 09:00) local. `null` when that window was not fully
   * observed — the first day of any fetch has no previous evening, and a `null` here must never be
   * read as "it did not get cold".
   */
  nightMinTempC: number | null;

  hoursBelowFreezing: number;
  hoursAboveFreezing: number;
  /** Σ over freezing hours of (0 − °C). The ~1″/15-FDD growth backbone; model-internal (D160). */
  freezingDegreeHours: number;
  /** Σ over thawing hours of (°C − 0). */
  thawDegreeHours: number;

  precipitationMm: number;
  rainMm: number;
  snowfallCm: number;
  maxSnowDepthM: number | null;

  hoursOfSun: number;
  insolationWhM2: number;

  maxWindKph: number | null;
  maxWindGustKph: number | null;
  /** Wind-run (km) = Σ hourly speed × 1 h. */
  windRunKm: number;
  /**
   * Hours per 16-point compass sector, index 0 = N and increasing clockwise. Empty when no hour
   * carried a direction. Multiplied against a body's `fetchProfileM` this is what turns "windy" into
   * "wind ran the full 3.2 km fetch", which is the difference between rough ice and black ice.
   */
  windSectorHours: number[];

  /**
   * Mean wind speed across this day's *freezing* hours — `null` when none froze.
   *
   * The single most useful number in this record and the reason the sector histogram is worth its
   * bytes: a hard freeze under calm air makes black ice, and the same freeze under wind makes a
   * rippled surface nobody wants to skate. It is an observation about air, not a claim about ice
   * (D3) — but it is the observation a skater is actually trying to reconstruct.
   */
  freezingHoursMeanWindKph: number | null;
  freezingHoursMaxWindKph: number | null;
}

/** Parse `YYYY-MM-DD` into a sortable UTC-midnight key. Returns `null` for anything malformed. */
export function localDateToDayMs(localDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

/** The inverse of {@link localDateToDayMs}, for readers holding only the numeric key. */
export function dayMsToLocalDate(dayMs: number): string {
  const d = new Date(dayMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** Meteorological degrees → 16-point sector index (0 = N, clockwise). */
export function windSectorOf(degrees: number): number {
  const step = 360 / WIND_SECTOR_COUNT;
  const norm = ((degrees % 360) + 360) % 360;
  return Math.round(norm / step) % WIND_SECTOR_COUNT;
}

interface DayAccumulator {
  localDate: string;
  dayMs: number;
  hours: LocalHourlyWeather[];
}

/**
 * Reduce a run of local-stamped hours into one summary per local calendar day.
 *
 * Days are returned in ascending order. Hours whose `localDate` is unparseable are dropped rather
 * than guessed at — a misfiled day is worse than a missing one, because a missing day is visible.
 *
 * ⚠ **A day at either end of the input is very likely partial**, and this reducer does not hide that:
 * `hours` reports what was actually seen, and `nightMinTempC` stays `null` unless the whole night
 * window was present. Callers that store these rows must decide for themselves whether a short day is
 * worth keeping (the archive writer keeps it and overwrites later, since a re-fetch of the same day
 * is idempotent).
 */
export function summarizeWeatherDays(
  hourly: readonly LocalHourlyWeather[],
  options: { sunnyCloudCoverMaxPct?: number } = {},
): WeatherDaySummary[] {
  const sunnyMaxCloud = options.sunnyCloudCoverMaxPct ?? 20;

  const byDay = new Map<string, DayAccumulator>();
  for (const h of hourly) {
    const dayMs = localDateToDayMs(h.localDate);
    if (dayMs === null) continue;
    let acc = byDay.get(h.localDate);
    if (!acc) {
      acc = { localDate: h.localDate, dayMs, hours: [] };
      byDay.set(h.localDate, acc);
    }
    acc.hours.push(h);
  }

  const ordered = [...byDay.values()].sort((a, b) => a.dayMs - b.dayMs);

  return ordered.map((acc) => {
    const prev = byDay.get(dayMsToLocalDate(acc.dayMs - DAY_MS));
    return summarizeOneDay(acc, prev, sunnyMaxCloud);
  });
}

function summarizeOneDay(
  acc: DayAccumulator,
  prev: DayAccumulator | undefined,
  sunnyMaxCloud: number,
): WeatherDaySummary {
  let minTempC: number | null = null;
  let maxTempC: number | null = null;
  let tempSum = 0;
  let tempCount = 0;
  let hoursBelowFreezing = 0;
  let hoursAboveFreezing = 0;
  let freezingDegreeHours = 0;
  let thawDegreeHours = 0;
  let precipitationMm = 0;
  let rainMm = 0;
  let snowfallCm = 0;
  let maxSnowDepthM: number | null = null;
  let hoursOfSun = 0;
  let insolationWhM2 = 0;
  let maxWindKph: number | null = null;
  let maxWindGustKph: number | null = null;
  let windRunKm = 0;
  let freezingWindSum = 0;
  let freezingWindCount = 0;
  let freezingHoursMaxWindKph: number | null = null;
  const windSectorHours = new Array<number>(WIND_SECTOR_COUNT).fill(0);
  let anyDirection = false;

  for (const h of acc.hours) {
    const t = h.temperatureC;
    minTempC = minTempC === null ? t : Math.min(minTempC, t);
    maxTempC = maxTempC === null ? t : Math.max(maxTempC, t);
    tempSum += t;
    tempCount += 1;

    if (t < 0) {
      hoursBelowFreezing += 1;
      freezingDegreeHours += -t;
      freezingWindSum += h.windSpeedKph;
      freezingWindCount += 1;
      freezingHoursMaxWindKph =
        freezingHoursMaxWindKph === null
          ? h.windSpeedKph
          : Math.max(freezingHoursMaxWindKph, h.windSpeedKph);
    }
    if (t > 0) {
      hoursAboveFreezing += 1;
      thawDegreeHours += t;
    }

    precipitationMm += h.precipitationMm;
    if (typeof h.rainMm === 'number') rainMm += h.rainMm;
    if (typeof h.snowfallCm === 'number') snowfallCm += h.snowfallCm;
    if (typeof h.snowDepthM === 'number') {
      maxSnowDepthM = maxSnowDepthM === null ? h.snowDepthM : Math.max(maxSnowDepthM, h.snowDepthM);
    }
    if (typeof h.shortwaveWm2 === 'number') insolationWhM2 += h.shortwaveWm2;

    if (typeof h.sunshineSeconds === 'number') {
      hoursOfSun += h.sunshineSeconds / 3600;
    } else if (typeof h.cloudCoverPct === 'number' && h.cloudCoverPct <= sunnyMaxCloud) {
      hoursOfSun += 1;
    }

    maxWindKph = maxWindKph === null ? h.windSpeedKph : Math.max(maxWindKph, h.windSpeedKph);
    if (typeof h.windGustKph === 'number') {
      maxWindGustKph =
        maxWindGustKph === null ? h.windGustKph : Math.max(maxWindGustKph, h.windGustKph);
    }
    windRunKm += h.windSpeedKph;
    if (typeof h.windDirectionDeg === 'number') {
      const sector = windSectorOf(h.windDirectionDeg);
      windSectorHours[sector] = (windSectorHours[sector] ?? 0) + 1;
      anyDirection = true;
    }
  }

  return {
    dayMs: acc.dayMs,
    localDate: acc.localDate,
    hours: acc.hours.length,
    minTempC,
    maxTempC,
    meanTempC: tempCount > 0 ? tempSum / tempCount : null,
    nightMinTempC: nightMinimum(acc, prev),
    hoursBelowFreezing,
    hoursAboveFreezing,
    freezingDegreeHours,
    thawDegreeHours,
    precipitationMm,
    rainMm,
    snowfallCm,
    maxSnowDepthM,
    hoursOfSun,
    insolationWhM2,
    maxWindKph,
    maxWindGustKph,
    windRunKm,
    windSectorHours: anyDirection ? windSectorHours : [],
    freezingHoursMeanWindKph: freezingWindCount > 0 ? freezingWindSum / freezingWindCount : null,
    freezingHoursMaxWindKph,
  };
}

/**
 * Minimum across [prev 18:00, this 09:00). Returns `null` unless **both** halves contributed at least
 * one hour, so a fetch that begins at dawn cannot report a suspiciously mild "night".
 */
function nightMinimum(acc: DayAccumulator, prev: DayAccumulator | undefined): number | null {
  if (!prev) return null;
  let min: number | null = null;
  let sawEvening = false;
  let sawMorning = false;
  for (const h of prev.hours) {
    if (h.localHour < NIGHT_START_HOUR) continue;
    sawEvening = true;
    min = min === null ? h.temperatureC : Math.min(min, h.temperatureC);
  }
  for (const h of acc.hours) {
    if (h.localHour >= NIGHT_END_HOUR) continue;
    sawMorning = true;
    min = min === null ? h.temperatureC : Math.min(min, h.temperatureC);
  }
  return sawEvening && sawMorning ? min : null;
}

/**
 * How many of these days had a night colder than `thresholdC` — **D159's headline predicate**, living
 * in exactly one place so the feed filter and the drawer panel can never disagree.
 *
 * Days whose night window was incomplete (`nightMinTempC === null`) are **not counted**, and are also
 * not counted *against*: this returns what is known, and a caller wanting "3 nights out of 7" must
 * check `days.length` itself. Treating unknown as warm would silently under-report a cold week;
 * treating it as cold would invent one.
 */
export function nightsBelowThresholdC(
  days: readonly WeatherDaySummary[],
  thresholdC: number,
): number {
  let n = 0;
  for (const d of days) {
    if (d.nightMinTempC !== null && d.nightMinTempC < thresholdC) n += 1;
  }
  return n;
}

/** Total snowfall (cm) across these days — the "has anything fallen on it" question. */
export function snowfallTotalCm(days: readonly WeatherDaySummary[]): number {
  return days.reduce((sum, d) => sum + d.snowfallCm, 0);
}

/** Total liquid rain (mm) — the resurfacing-event input, opposite in sign to snow (D56). */
export function rainTotalMm(days: readonly WeatherDaySummary[]): number {
  return days.reduce((sum, d) => sum + d.rainMm, 0);
}

/**
 * The most recent day with measurable snowfall, or `null` if none. `thresholdCm` defaults to 0.5 cm —
 * below that is a dusting the wind removes, and reporting it as "snow" would make the panel cry wolf
 * every week.
 */
export function lastSnowDay(
  days: readonly WeatherDaySummary[],
  thresholdCm = 0.5,
): WeatherDaySummary | null {
  let latest: WeatherDaySummary | null = null;
  for (const d of days) {
    if (d.snowfallCm >= thresholdCm && (latest === null || d.dayMs > latest.dayMs)) latest = d;
  }
  return latest;
}

/**
 * The dominant wind sector across a span, weighted by hours. `null` when no day carried directions.
 * Paired with a body's `fetchProfileM` this answers which shore took the wind.
 */
export function dominantWindSector(days: readonly WeatherDaySummary[]): number | null {
  const totals = new Array<number>(WIND_SECTOR_COUNT).fill(0);
  let any = false;
  for (const d of days) {
    for (let i = 0; i < d.windSectorHours.length && i < WIND_SECTOR_COUNT; i++) {
      const v = d.windSectorHours[i] ?? 0;
      if (v > 0) any = true;
      totals[i] = (totals[i] ?? 0) + v;
    }
  }
  if (!any) return null;
  let best = 0;
  for (let i = 1; i < WIND_SECTOR_COUNT; i++) {
    if ((totals[i] ?? 0) > (totals[best] ?? 0)) best = i;
  }
  return best;
}
