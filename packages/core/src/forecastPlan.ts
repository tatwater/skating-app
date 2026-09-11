/**
 * The seven-day planner (N6h Workstream D, D155) — hours as cards, days as cards, episodes as
 * sentences.
 *
 * ## What it is
 *
 * The founder's shape, 2026-09-11: *"small cards in a horizontal scroll area with vertically stacked
 * temp, weather symbol, precipitation, time … then underneath, larger full-day summary cards in
 * their own horizontal scroll area, with a summary of each whole day's forecast, including things
 * like 'snow from 10 PM to 4 AM'."* A weather app's vocabulary, deliberately, because the question it
 * answers — *when this week do I get in the car* — is one a weather app is good at, and the only
 * thing wrong with a weather app is that it is about a town rather than this lake.
 *
 * D155's principle survives the redesign: **the run-up is drawn, not hidden.** The hourly row holds
 * every hour of every day, opens at *now*, and a day card is a *selector* that scrolls it — so a
 * reader who taps Thursday can drag back and see Wednesday night's snow. The morning/afternoon/
 * overnight grid D155 first described is gone; the day card does its job with fewer taps.
 *
 * ## What it is not (D3, D74)
 *
 * Nothing here reaches a calculation. It is render-only, fed from the forecast half of the fetch,
 * and it names weather and clocks — *"snow 10 PM–4 AM, 3″"* — never ice. "A calm clear morning after
 * six hours of snow" is a reason to go; the sentence that says so is the reader's, not ours.
 *
 * ## Clocks
 *
 * Every `startMs` is **local-shifted** (`weather.ts` adds `utc_offset_seconds`), so every date and
 * hour in this file is read back with **UTC getters** — the same rule as `formatLocalHourLabel`, for
 * the same reason: a local formatter would apply the offset twice and produce a perfectly plausible
 * wrong clock. The caller's `nowLocalMs` is shifted the same way (`Date.now() + utcOffsetMs`).
 */

import type { ForecastHour } from './lakeForecast';
import { cmToInches, cToF, kphToMph, mmToInches, roundTo } from './units';
import { localDateToDayMs, NIGHT_END_HOUR, NIGHT_START_HOUR, SUNLIT_WM2 } from './weatherDay';
import { formatLocalHourLabel } from './weatherPanel';

const HOUR_MS = 3_600_000;

/**
 * How many forward days the drawer asks Open-Meteo for.
 *
 * Seven, because `past_days: 1` + 7 = 8 days is still one billing unit (`ceil(days / 14)`), so the
 * planner costs exactly what the 12-hour strip already cost — 1.2 weighted calls per open. Sixteen is
 * the API's ceiling and would double that for days no skater plans against.
 */
export const FORECAST_PLAN_DAYS = 7;

/**
 * The symbol vocabulary. Each client maps these to its own glyph set; core never names an icon.
 *
 * Ordered **worst-first for ice**, and that order is load-bearing: a day's condition is the first of
 * these that meets the day's own bar (see `dayCondition`). Freezing rain outranks everything because
 * it arrives liquid and bonds; sleet and snow outrank rain because they hide the surface; the cloud
 * states are last and only ever describe a dry day.
 */
export const FORECAST_CONDITIONS = [
  'freezing-rain',
  'sleet',
  'thunder',
  'snow',
  'rain',
  'drizzle',
  'fog',
  'cloudy',
  'partly-cloudy',
  'clear',
] as const;
export type ForecastCondition = (typeof FORECAST_CONDITIONS)[number];

/** The condition as a word, for the symbol's accessible name — a glyph is never the only carrier. */
export const CONDITION_LABEL: Record<ForecastCondition, string> = {
  'freezing-rain': 'Freezing rain',
  sleet: 'Sleet',
  thunder: 'Thunderstorm',
  snow: 'Snow',
  rain: 'Rain',
  drizzle: 'Drizzle',
  fog: 'Fog',
  cloudy: 'Cloudy',
  'partly-cloudy': 'Partly cloudy',
  clear: 'Clear',
};

/**
 * The symbol each client draws, named rather than drawn: the two glyph sets (FontAwesome on both
 * clients today) resolve these to icons, and the day/night split lives here so neither client
 * decides on its own when a clear sky is a moon.
 */
export type ForecastGlyph =
  | 'sun'
  | 'moon'
  | 'cloud-sun'
  | 'cloud-moon'
  | 'cloud'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'freezing-rain'
  | 'sleet'
  | 'snow'
  | 'thunder';

export function conditionGlyph(condition: ForecastCondition, isNight: boolean): ForecastGlyph {
  switch (condition) {
    case 'clear':
      return isNight ? 'moon' : 'sun';
    case 'partly-cloudy':
      return isNight ? 'cloud-moon' : 'cloud-sun';
    case 'cloudy':
      return 'cloud';
    default:
      return condition;
  }
}

const PRECIP_CONDITIONS: ReadonlySet<ForecastCondition> = new Set([
  'freezing-rain',
  'sleet',
  'thunder',
  'snow',
  'rain',
  'drizzle',
]);

/**
 * WMO code → condition. Open-Meteo's documented set; codes it never emits (the WMO table has ~100)
 * fall through to the amount-based derivation rather than to a silent "clear".
 */
const WMO_CONDITION: Record<number, ForecastCondition> = {
  0: 'clear',
  1: 'clear',
  2: 'partly-cloudy',
  3: 'cloudy',
  45: 'fog',
  48: 'fog',
  51: 'drizzle',
  53: 'drizzle',
  55: 'drizzle',
  56: 'freezing-rain',
  57: 'freezing-rain',
  61: 'rain',
  63: 'rain',
  65: 'rain',
  66: 'freezing-rain',
  67: 'freezing-rain',
  68: 'sleet',
  69: 'sleet',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  77: 'snow',
  79: 'sleet',
  80: 'rain',
  81: 'rain',
  82: 'rain',
  83: 'sleet',
  84: 'sleet',
  85: 'snow',
  86: 'snow',
  87: 'sleet',
  88: 'sleet',
  95: 'thunder',
  96: 'thunder',
  99: 'thunder',
};

/** Water-equivalent below which an hour is dry for the amount-based fallback (matches the timeline). */
const PRECIP_MIN_MM = 0.05;
/** Cloud-cover edges for the fallback when there is no code: under 30 % reads clear, over 70 % cloudy. */
const PARTLY_CLOUDY_PCT = 30;
const CLOUDY_PCT = 70;
/** Below this the sun is down for the symbol's purposes; the ramp in `chartWeather` starts far higher. */
const NIGHT_SHORTWAVE_WM2 = 5;
/** Hour-of-day fallback for night when no shortwave is available. */
const NIGHT_FALLBACK_START_HOUR = 17;
const NIGHT_FALLBACK_END_HOUR = 7;
/** A daytime hour, for the modal-cloud vote — dusk-to-dawn cloud is invisible and votes for nothing. */
const DAYTIME_START_HOUR = 7;
const DAYTIME_END_HOUR = 17;

/**
 * Episode floors — what a run of hours has to add up to before it earns a sentence.
 *
 * Snow at 0.3 cm is a dusting nobody plans around; rain at 0.3 mm likewise. **Freezing rain has no
 * floor**: a trace is the one that matters. Wind at 32 km/h (20 mph) is Beaufort 5, where a lake's
 * fetch starts to matter and a skater starts to notice.
 */
export const EPISODE_MIN_SNOW_CM = 0.3;
export const EPISODE_MIN_RAIN_MM = 0.3;
export const EPISODE_WIND_KPH = 32;
/** A single dry hour inside a run of the same family is a lull, not two events. */
const EPISODE_BRIDGE_HOURS = 1;

export type EpisodeKind = 'snow' | 'rain' | 'freezing-rain' | 'sleet' | 'wind';

/** A run of consecutive hours doing one thing — the unit of the day card's sentences. */
export interface ForecastEpisode {
  kind: EpisodeKind;
  /** Local-shifted, inclusive start of the first hour. */
  startMs: number;
  /** Local-shifted, **exclusive** — the start of the hour after the last one. */
  endMs: number;
  hours: number;
  snowfallCm: number;
  rainMm: number;
  maxWindKph: number;
  maxGustKph: number | null;
}

/** One hourly card. Display values are pre-rounded imperial (D25), so a client never converts. */
export interface ForecastPlanHour extends ForecastHour {
  localDate: string;
  /** 0–23 on the lake's clock, read with UTC getters from the local-shifted `startMs`. */
  localHour: number;
  condition: ForecastCondition;
  /** For the sun/moon variant of a symbol. Shortwave when present, else a fixed dusk/dawn. */
  isNight: boolean;
  temperatureF: number;
  snowfallIn: number;
  rainIn: number;
  windMph: number;
  gustMph: number | null;
  /** True on the one card where the viewer would arrive if they left now (Phase 4 band, ≈). */
  arrival: boolean;
}

/** One day card. */
export interface ForecastPlanDay {
  localDate: string;
  dayMs: number;
  /** `Today` · `Tomorrow` · else the weekday, e.g. `Thu`. */
  label: string;
  /** `Thu 15` for the secondary line; the same form the past panel uses. */
  dateLabel: string;
  /** Index into `ForecastPlan.hours` of this day's first hour — the scroll target for a tap. */
  firstHourIndex: number;
  hourCount: number;
  /** Fewer than a full day of hours: today (already begun) or the series' last day (cut short). */
  partial: boolean;
  condition: ForecastCondition;
  highC: number;
  lowC: number;
  highF: number;
  lowF: number;
  /**
   * The coldest hour in the night that *ends* this morning — `[prev 18:00, this 09:00)`, the same
   * window `weatherDay.ts` defines for the archive, so "nights below 20 °F" means one thing on both
   * halves of the Planning tab. `null` when fewer than half those hours are in the series, **or
   * when it would only repeat `lowC`** — in a season where the low is always at night the line is
   * noise, and the card says it only when the night was colder than the calendar day.
   */
  nightLowC: number | null;
  nightLowF: number | null;
  snowfallCm: number;
  snowfallIn: number;
  rainMm: number;
  rainIn: number;
  maxWindKph: number;
  maxWindMph: number;
  maxGustKph: number | null;
  /** Hours the sun was genuinely up and out (`SUNLIT_WM2`), when shortwave is available. */
  sunlitHours: number | null;
  episodes: ForecastEpisode[];
  /** The episodes as sentences, in order — `Snow 10 PM–4 AM · 3.2″`. Empty on a quiet day. */
  lines: string[];
}

export interface ForecastPlan {
  hours: ForecastPlanHour[];
  days: ForecastPlanDay[];
  /** Index of the arrival card, or `null` when the viewer has no band or it falls past the series. */
  arrivalIndex: number | null;
  arrivalBandMinutes: 30 | 60 | 90 | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Per-hour
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` of a local-shifted instant, via UTC getters (see the module docblock). */
function localDateOf(localMs: number): string {
  const d = new Date(localMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/**
 * The hour's condition. **The code wins when present** — it is the forecaster's own word, and it is
 * the only input that can say sleet. Without one, the amounts and temperature reproduce the
 * timeline's fallback (liquid at or below 0 °C is freezing rain), then cloud cover picks a dry sky.
 */
export function hourCondition(hour: ForecastHour): ForecastCondition {
  if (hour.weatherCode !== undefined) {
    const mapped = WMO_CONDITION[hour.weatherCode];
    if (mapped) return mapped;
  }
  const snow = hour.snowfallCm;
  const rain = hour.rainMm ?? Math.max(0, hour.precipitationMm - snow * 10);
  const total = hour.precipitationMm > 0 ? hour.precipitationMm : rain + snow * 10;
  if (total >= PRECIP_MIN_MM) {
    if (snow > 0 && rain > 0) return 'sleet';
    if (snow > 0) return 'snow';
    if (hour.temperatureC <= 0) return 'freezing-rain';
    return 'rain';
  }
  const cloud = hour.cloudCoverPct;
  if (cloud === undefined) return 'clear';
  if (cloud >= CLOUDY_PCT) return 'cloudy';
  if (cloud >= PARTLY_CLOUDY_PCT) return 'partly-cloudy';
  return 'clear';
}

function isNightHour(hour: ForecastHour, localHour: number): boolean {
  if (hour.shortwaveWm2 !== undefined) return hour.shortwaveWm2 < NIGHT_SHORTWAVE_WM2;
  return localHour >= NIGHT_FALLBACK_START_HOUR || localHour < NIGHT_FALLBACK_END_HOUR;
}

function toPlanHour(hour: ForecastHour, arrival: boolean): ForecastPlanHour {
  const localHour = new Date(hour.startMs).getUTCHours();
  return {
    ...hour,
    localDate: localDateOf(hour.startMs),
    localHour,
    condition: hourCondition(hour),
    isNight: isNightHour(hour, localHour),
    temperatureF: roundTo(cToF(hour.temperatureC), 0),
    snowfallIn: roundTo(cmToInches(hour.snowfallCm), 1),
    rainIn: roundTo(mmToInches(hour.rainMm ?? 0), 2),
    windMph: roundTo(kphToMph(hour.windSpeedKph), 0),
    gustMph: hour.windGustKph === undefined ? null : roundTo(kphToMph(hour.windGustKph), 0),
    arrival,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Episodes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The family an hour's precipitation belongs to for run-building, or `null` when it is dry. */
function precipFamily(hour: ForecastPlanHour): Exclude<EpisodeKind, 'wind'> | null {
  switch (hour.condition) {
    case 'freezing-rain':
      return 'freezing-rain';
    case 'sleet':
      return 'sleet';
    case 'snow':
      return 'snow';
    case 'rain':
    case 'drizzle':
    case 'thunder':
      return 'rain';
    default:
      return null;
  }
}

/**
 * Group consecutive hours into runs by `keyOf`, bridging up to `EPISODE_BRIDGE_HOURS` hours whose
 * key is `null` when the same key resumes on the far side. Returns `[startIndex, endIndexExclusive,
 * key]` triples in order.
 */
function runs<K extends string>(
  hours: readonly ForecastPlanHour[],
  keyOf: (h: ForecastPlanHour) => K | null,
): [number, number, K][] {
  // Keys precomputed once, so the lull probe below is an array read rather than a re-derivation.
  const keys = hours.map(keyOf);
  const out: [number, number, K][] = [];
  let i = 0;
  while (i < keys.length) {
    const key = keys[i];
    if (key === null || key === undefined) {
      i++;
      continue;
    }
    const start = i;
    let end = i + 1;
    while (end < keys.length) {
      if (keys[end] === key) {
        end++;
        continue;
      }
      // A lull: look past it for the same key within the bridge.
      let probe = end;
      while (probe < keys.length && probe - end < EPISODE_BRIDGE_HOURS && keys[probe] === null)
        probe++;
      if (probe > end && keys[probe] === key) {
        end = probe + 1;
        continue;
      }
      break;
    }
    out.push([start, end, key]);
    i = end;
  }
  return out;
}

function episodeFrom(
  hours: readonly ForecastPlanHour[],
  start: number,
  end: number,
  kind: EpisodeKind,
): ForecastEpisode {
  const run = hours.slice(start, end);
  let snowfallCm = 0;
  let rainMm = 0;
  let maxWindKph = 0;
  let maxGustKph: number | null = null;
  let startMs = Number.POSITIVE_INFINITY;
  let lastStartMs = Number.NEGATIVE_INFINITY;
  for (const h of run) {
    snowfallCm += h.snowfallCm;
    rainMm += h.rainMm ?? 0;
    maxWindKph = Math.max(maxWindKph, h.windSpeedKph);
    if (h.windGustKph !== undefined) maxGustKph = Math.max(maxGustKph ?? 0, h.windGustKph);
    startMs = Math.min(startMs, h.startMs);
    lastStartMs = Math.max(lastStartMs, h.startMs);
  }
  return {
    kind,
    startMs,
    endMs: lastStartMs + HOUR_MS,
    hours: run.length,
    snowfallCm,
    rainMm,
    maxWindKph,
    maxGustKph,
  };
}

/** Does a precipitation run add up to something worth a sentence? Freezing rain always does. */
function episodeEarnsALine(e: ForecastEpisode): boolean {
  switch (e.kind) {
    case 'freezing-rain':
      return true;
    case 'snow':
      return e.snowfallCm >= EPISODE_MIN_SNOW_CM;
    case 'sleet':
      return e.snowfallCm >= EPISODE_MIN_SNOW_CM || e.rainMm >= EPISODE_MIN_RAIN_MM;
    case 'rain':
      return e.rainMm >= EPISODE_MIN_RAIN_MM;
    case 'wind':
      return true;
  }
}

/**
 * Every episode in the series, in start order. Precipitation runs and wind runs are built
 * independently — a windy snowstorm is two sentences, because they are two different reasons.
 */
export function detectEpisodes(hours: readonly ForecastPlanHour[]): ForecastEpisode[] {
  const out: ForecastEpisode[] = [];
  for (const [start, end, kind] of runs(hours, precipFamily)) {
    const e = episodeFrom(hours, start, end, kind);
    if (episodeEarnsALine(e)) out.push(e);
  }
  for (const [start, end] of runs(hours, (h) =>
    h.windSpeedKph >= EPISODE_WIND_KPH ? 'wind' : null,
  )) {
    out.push(episodeFrom(hours, start, end, 'wind'));
  }
  out.sort((a, b) => a.startMs - b.startMs || a.kind.localeCompare(b.kind));
  return out;
}

const EPISODE_NOUN: Record<EpisodeKind, string> = {
  snow: 'Snow',
  rain: 'Rain',
  'freezing-rain': 'Freezing rain',
  sleet: 'Sleet',
  wind: 'Wind',
};

/**
 * `10 PM–4 AM`, or `2–7 PM` when both ends share a meridiem — the collapse every printed forecast
 * uses, and the one that keeps a day card's lines short enough to scan.
 */
function clockRange(startMs: number, endMs: number): string {
  const a = formatLocalHourLabel(startMs);
  const b = formatLocalHourLabel(endMs);
  const [aHour, aSuffix] = a.split(' ');
  const [, bSuffix] = b.split(' ');
  return aSuffix === bSuffix ? `${aHour}–${b}` : `${a}–${b}`;
}

/**
 * One sentence for one episode, imperial (D25): `Snow 10 PM–4 AM · 3.2″` · `Rain 1–3 PM · 0.1″` ·
 * `Wind 2–7 PM · gusts 38 mph`. `all day` when the run covers the whole of the day it is printed on.
 *
 * The clock is a plain two-ended range and it may cross midnight — *"10 PM–4 AM"* is exactly the
 * founder's example, and readers parse it without a date because the card they are reading on is
 * the date.
 */
export function formatEpisode(e: ForecastEpisode, opts: { allDay?: boolean } = {}): string {
  const when = opts.allDay ? 'all day' : clockRange(e.startMs, e.endMs);
  const amount = (() => {
    switch (e.kind) {
      case 'snow':
        return `${roundTo(cmToInches(e.snowfallCm), 1)}″`;
      case 'sleet': {
        const parts: string[] = [];
        if (e.snowfallCm >= EPISODE_MIN_SNOW_CM)
          parts.push(`${roundTo(cmToInches(e.snowfallCm), 1)}″ snow`);
        if (e.rainMm >= EPISODE_MIN_RAIN_MM)
          parts.push(`${roundTo(mmToInches(e.rainMm), 2)}″ rain`);
        return parts.join(', ');
      }
      case 'rain':
      case 'freezing-rain':
        return e.rainMm >= EPISODE_MIN_RAIN_MM ? `${roundTo(mmToInches(e.rainMm), 2)}″` : '';
      case 'wind': {
        const gust = e.maxGustKph === null ? null : roundTo(kphToMph(e.maxGustKph), 0);
        const speed = roundTo(kphToMph(e.maxWindKph), 0);
        return gust !== null && gust > speed ? `gusts ${gust} mph` : `${speed} mph`;
      }
    }
  })();
  return amount ? `${EPISODE_NOUN[e.kind]} ${when} · ${amount}` : `${EPISODE_NOUN[e.kind]} ${when}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Days
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A day's symbol. **Any precipitation episode that starts on the day wins**, worst kind first — a
 * day with two hours of freezing rain and twenty of sun is a freezing-rain day on this lake. A dry
 * day takes the modal daytime cloud state, because nobody can see the clouds at night and a day
 * that is overcast until noon and clear after is "partly cloudy" in every weather app a reader has
 * ever used.
 */
function dayCondition(
  hours: readonly ForecastPlanHour[],
  episodes: readonly ForecastEpisode[],
): ForecastCondition {
  const kinds = new Set(episodes.map((e) => e.kind));
  for (const c of FORECAST_CONDITIONS) {
    if (!PRECIP_CONDITIONS.has(c)) break;
    if (c === 'thunder' || c === 'drizzle') continue; // no episode kind of their own
    if (kinds.has(c as EpisodeKind)) return c;
  }
  // Thunder folds into `rain` runs for the sentence and has no floor for the symbol: an hour of it
  // names the day. Drizzle does not — a trace under the rain floor is a cloudy day, not a wet one.
  if (hours.some((h) => h.condition === 'thunder')) return 'thunder';
  const daytime = hours.filter(
    (h) => h.localHour >= DAYTIME_START_HOUR && h.localHour < DAYTIME_END_HOUR,
  );
  const vote = daytime.length > 0 ? daytime : hours;
  const tally = new Map<ForecastCondition, number>();
  for (const h of vote) {
    if (PRECIP_CONDITIONS.has(h.condition)) continue;
    tally.set(h.condition, (tally.get(h.condition) ?? 0) + 1);
  }
  let best: ForecastCondition = 'clear';
  let bestCount = -1;
  // Iterate in the fixed order so a tie resolves toward the cloudier state — the cautious read.
  for (const c of FORECAST_CONDITIONS) {
    const n = tally.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function labelsFor(dayMs: number, todayMs: number): { label: string; dateLabel: string } {
  const d = new Date(dayMs);
  const weekday = WEEKDAYS[d.getUTCDay()] ?? '';
  const dateLabel = `${weekday} ${d.getUTCDate()}`;
  if (dayMs === todayMs) return { label: 'Today', dateLabel };
  if (dayMs === todayMs + 86_400_000) return { label: 'Tomorrow', dateLabel };
  return { label: weekday, dateLabel };
}

/**
 * The night that ends on `dayMs`: hours from the previous day's `NIGHT_START_HOUR` through this
 * day's `NIGHT_END_HOUR`, exclusive. `null` unless at least half of that window is in the series —
 * the first card's night is usually already underway when the forecast begins.
 */
function nightLow(all: readonly ForecastPlanHour[], dayMs: number): number | null {
  const start = dayMs - 86_400_000 + NIGHT_START_HOUR * HOUR_MS;
  const end = dayMs + NIGHT_END_HOUR * HOUR_MS;
  const expected = (end - start) / HOUR_MS;
  let seen = 0;
  let low = Number.POSITIVE_INFINITY;
  for (const h of all) {
    if (h.startMs < start || h.startMs >= end) continue;
    seen++;
    low = Math.min(low, h.temperatureC);
  }
  return seen * 2 >= expected ? low : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the planner from the forward hours.
 *
 * `hours` may arrive in any order and may include hours before `nowLocalMs` (a cache row is an hour
 * old at most); both are corrected here, because every renderer assumes ascending-and-forward and a
 * renderer is the wrong place to enforce it. Days are cut at the lake's local midnight — from the
 * hour's own date string, never by dividing a timestamp by 24 hours, which is wrong twice a season.
 */
export function buildForecastPlan(
  hours: readonly ForecastHour[],
  nowLocalMs: number,
  opts: { arrivalBandMinutes?: 30 | 60 | 90 | null; days?: number } = {},
): ForecastPlan {
  const arrivalBandMinutes = opts.arrivalBandMinutes ?? null;
  const maxDays = opts.days ?? FORECAST_PLAN_DAYS;

  // An hour still in progress is kept (its start is up to an hour behind now); one that has fully
  // elapsed is not, however fresh the cache row that carried it.
  const forward = hours
    .filter((h) => Number.isFinite(h.startMs) && h.startMs + HOUR_MS > nowLocalMs)
    .sort((a, b) => a.startMs - b.startMs);

  // The arrival card: the hour containing now + band, marked on exactly one card.
  const arrivalMs = arrivalBandMinutes === null ? null : nowLocalMs + arrivalBandMinutes * 60_000;
  let arrivalIndex: number | null = null;
  if (arrivalMs !== null) {
    const i = forward.findIndex((h) => arrivalMs >= h.startMs && arrivalMs < h.startMs + HOUR_MS);
    arrivalIndex = i >= 0 ? i : null;
  }

  const planHours = forward.map((h, i) => toPlanHour(h, i === arrivalIndex));

  // Cut into days by local date string. The hours are sorted, so a day is a contiguous run and the
  // cut is a single pass; the day cap drops the hours past it too, so the hour row and the day row
  // always describe the same span.
  const groups: { localDate: string; firstHourIndex: number; hours: ForecastPlanHour[] }[] = [];
  for (const [i, h] of planHours.entries()) {
    const last = groups[groups.length - 1];
    if (last && last.localDate === h.localDate) last.hours.push(h);
    else groups.push({ localDate: h.localDate, firstHourIndex: i, hours: [h] });
  }
  const kept = groups.slice(0, maxDays);
  const keptHours = kept.flatMap((g) => g.hours);
  if (arrivalIndex !== null && arrivalIndex >= keptHours.length) arrivalIndex = null;

  const episodes = detectEpisodes(keptHours);
  const todayMs = localDateToDayMs(localDateOf(nowLocalMs)) ?? Number.NaN;

  const days: ForecastPlanDay[] = [];
  for (const { localDate, firstHourIndex, hours: dayHours } of kept) {
    const dayMs = localDateToDayMs(localDate) ?? 0;
    const dayEnd = dayMs + 86_400_000;
    const own = episodes.filter((e) => e.startMs >= dayMs && e.startMs < dayEnd);
    const dayStartMs = dayHours.reduce((m, h) => Math.min(m, h.startMs), Number.POSITIVE_INFINITY);
    const dayEndMs =
      dayHours.reduce((m, h) => Math.max(m, h.startMs), Number.NEGATIVE_INFINITY) + HOUR_MS;
    let highC = Number.NEGATIVE_INFINITY;
    let lowC = Number.POSITIVE_INFINITY;
    let snowfallCm = 0;
    let rainMm = 0;
    let maxWindKph = 0;
    let maxGustKph: number | null = null;
    let sunlit = 0;
    let sawShortwave = false;
    for (const h of dayHours) {
      highC = Math.max(highC, h.temperatureC);
      lowC = Math.min(lowC, h.temperatureC);
      snowfallCm += h.snowfallCm;
      rainMm += h.rainMm ?? 0;
      maxWindKph = Math.max(maxWindKph, h.windSpeedKph);
      if (h.windGustKph !== undefined) maxGustKph = Math.max(maxGustKph ?? 0, h.windGustKph);
      if (h.shortwaveWm2 !== undefined) {
        sawShortwave = true;
        if (h.shortwaveWm2 >= SUNLIT_WM2) sunlit++;
      }
    }
    const nightRaw = nightLow(keptHours, dayMs);
    const night = nightRaw !== null && nightRaw < lowC ? nightRaw : null;
    const { label, dateLabel } = labelsFor(dayMs, todayMs);
    days.push({
      localDate,
      dayMs,
      label,
      dateLabel,
      firstHourIndex,
      hourCount: dayHours.length,
      partial: dayHours.length < 24,
      condition: dayCondition(dayHours, own),
      highC,
      lowC,
      highF: roundTo(cToF(highC), 0),
      lowF: roundTo(cToF(lowC), 0),
      nightLowC: night,
      nightLowF: night === null ? null : roundTo(cToF(night), 0),
      snowfallCm,
      snowfallIn: roundTo(cmToInches(snowfallCm), 1),
      rainMm,
      rainIn: roundTo(mmToInches(rainMm), 2),
      maxWindKph,
      maxWindMph: roundTo(kphToMph(maxWindKph), 0),
      maxGustKph,
      sunlitHours: sawShortwave ? sunlit : null,
      episodes: own,
      lines: own.map((e) =>
        formatEpisode(e, { allDay: e.startMs <= dayStartMs && e.endMs >= dayEndMs }),
      ),
    });
  }

  return { hours: keptHours, days, arrivalIndex, arrivalBandMinutes };
}

/** True when there is nothing to draw — the drawer's "render nothing" test, like `forecastIsEmpty`. */
export function forecastPlanIsEmpty(plan: ForecastPlan | null | undefined): boolean {
  return !plan || plan.hours.length === 0;
}

/**
 * The hour card's own clock label — `3 PM`, `midnight` folded to `12 AM` for the column. Kept here so
 * both clients print one form and neither hand-rolls the noon/midnight dance.
 */
export function planHourLabel(hour: ForecastPlanHour): string {
  return formatLocalHourLabel(hour.startMs);
}

/** `≈ arrival` — the one caption the drive-time hint is allowed to be (a band, not a time). */
export function arrivalCaption(plan: ForecastPlan): string | null {
  if (plan.arrivalIndex === null || plan.arrivalBandMinutes === null) return null;
  return `≈ arrival, ${plan.arrivalBandMinutes} min drive`;
}
