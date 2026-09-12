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
import {
  dayMsToLocalDate,
  localDateToDayMs,
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
  SUNLIT_WM2,
} from './weatherDay';
import { formatLocalHourLabel, shortDayLabel } from './weatherPanel';
import { PRECIP_MIN_MM } from './weatherTimeline';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

/** Cloud-cover edges for the fallback when there is no code: under 30 % reads clear, over 70 % cloudy. */
const PARTLY_CLOUDY_PCT = 30;
const CLOUDY_PCT = 70;
/** Below this the sun is down for the symbol's purposes; the ramp in `chartWeather` starts far higher. */
const NIGHT_SHORTWAVE_WM2 = 5;
/**
 * The fixed daytime, `[07:00, 17:00)`. Two jobs, one pair of numbers: the night fallback for the
 * symbol when no shortwave is available, and the hours whose cloud can be seen for the modal-cloud
 * vote — dusk-to-dawn cloud is invisible and votes for nothing.
 */
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
  /** Liquid, mm — see {@link liquidMm}; `rainMm` on the base hour is the provider's narrower field. */
  liquidMm: number;
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

/**
 * `YYYY-MM-DD` of a local-shifted instant. The value is already on the lake's clock, so its UTC
 * calendar date *is* the local date — which is exactly what `dayMsToLocalDate` reads (see the module
 * docblock, and `weatherDay.ts` on why this conversion is never open-coded).
 */
function localDateOf(localMs: number): string {
  return dayMsToLocalDate(localMs);
}

/**
 * Open-Meteo's own snow-to-water ratio: *"for the water equivalent in millimeter, divide by 7"* —
 * 7 cm of snow is 10 mm of water, so 0.7 cm per mm.
 */
export const SNOW_CM_PER_MM_WATER = 0.7;

/**
 * Liquid precipitation in the hour, mm — **derived, not fetched.**
 *
 * Open-Meteo's `rain` is large-scale liquid only; convective showers are a separate variable that
 * `HOURLY_VARS` does not request, and in a shoulder-season forecast a run of showers therefore
 * reads as dry under `rainMm`. But `precipitation` is documented as the total — rain + showers +
 * snow water-equivalent — so the liquid is the total less the snow at the provider's own ratio.
 * Asking for `showers` would put a thirteenth variable on every call including the corpus sweep
 * (+8 %, the cost class `precipitation_probability` was refused at, founder call 13) to learn a
 * distinction — large-scale versus convective — that matters to a meteorologist and not to ice.
 *
 * `max` of the two, because rounding can leave the derived value a hair under `rain` on a plain
 * rain hour, and `rain` can never exceed the liquid total.
 */
export function liquidMm(hour: ForecastHour): number {
  const fromTotal = hour.precipitationMm - hour.snowfallCm / SNOW_CM_PER_MM_WATER;
  return Math.max(0, hour.rainMm ?? 0, fromTotal);
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
  const rain = liquidMm(hour);
  const total = Math.max(hour.precipitationMm, rain + snow / SNOW_CM_PER_MM_WATER);
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
  return localHour >= DAYTIME_END_HOUR || localHour < DAYTIME_START_HOUR;
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
    liquidMm: liquidMm(hour),
    rainIn: roundTo(mmToInches(liquidMm(hour)), 2),
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
/**
 * Are two hours the same clock-hour apart — the next hour, with nothing missing between them?
 *
 * Judged on the UTC instant when both carry one, because the local-shifted `startMs` lies twice a
 * year: spring-forward makes consecutive hours look two apart, fall-back makes them look zero
 * apart. Without an instant (a fixture, a pre-planner row) the local clock is what there is.
 */
function consecutive(a: ForecastPlanHour, b: ForecastPlanHour): boolean {
  const from = a.utcMs ?? a.startMs;
  const to = b.utcMs ?? b.startMs;
  return to - from === HOUR_MS;
}

/**
 * Group consecutive hours into runs by `keyOf`, bridging up to `EPISODE_BRIDGE_HOURS` hours whose
 * key is `null` when the same key resumes on the far side. Returns `[startIndex, endIndexExclusive,
 * key]` triples in order.
 *
 * ⚠ **A run never spans a missing hour.** The parser drops an hour Open-Meteo returned without a
 * temperature, so adjacent entries are not always adjacent hours; matching weather on both sides of
 * a hole was one uninterrupted episode — *"10 PM–2 AM"* over an hour nobody has data for (Greptile
 * on #51). A hole ends the run, and the lull bridge only ever crosses an hour that exists.
 */
function runs<K extends string>(
  hours: readonly ForecastPlanHour[],
  keyOf: (h: ForecastPlanHour) => K | null,
): [number, number, K][] {
  // Keys precomputed once, so the lull probe below is an array read rather than a re-derivation.
  const keys = hours.map(keyOf);
  const joined = (i: number): boolean => {
    const a = hours[i - 1];
    const b = hours[i];
    return a !== undefined && b !== undefined && consecutive(a, b);
  };
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
    while (end < keys.length && joined(end)) {
      if (keys[end] === key) {
        end++;
        continue;
      }
      // A lull: look past it for the same key within the bridge, hour by present hour.
      let probe = end;
      while (
        probe < keys.length &&
        probe - end < EPISODE_BRIDGE_HOURS &&
        keys[probe] === null &&
        joined(probe)
      )
        probe++;
      if (probe > end && keys[probe] === key && joined(probe)) {
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
  // `hours` is ascending (`buildForecastPlan` sorted it), so the run's ends are its ends.
  const run = hours.slice(start, end);
  let snowfallCm = 0;
  let rainMm = 0;
  let maxWindKph = 0;
  let maxGustKph: number | null = null;
  for (const h of run) {
    snowfallCm += h.snowfallCm;
    rainMm += h.liquidMm;
    maxWindKph = Math.max(maxWindKph, h.windSpeedKph);
    if (h.windGustKph !== undefined) maxGustKph = Math.max(maxGustKph ?? 0, h.windGustKph);
  }
  return {
    kind,
    startMs: run[0]?.startMs ?? Number.NaN,
    endMs: (run[run.length - 1]?.startMs ?? Number.NaN) + HOUR_MS,
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
 * `10 PM–4 AM Fri`, or `2–7 PM` when both ends share a meridiem — the collapse every printed
 * forecast uses, and the one that keeps a day card's lines short enough to scan.
 *
 * **A run that ends on a later date names that day** (founder call, 2026-09-11: *"Snow until 6am
 * Wed" on Tuesday's card*). A run ending exactly at midnight belongs to its own day — `6 PM–12 AM`
 * needs no weekday — so the date is taken from the last hour, not from the exclusive end.
 */
function clockRange(startMs: number, endMs: number): string {
  const a = formatLocalHourLabel(startMs);
  const b = formatLocalHourLabel(endMs);
  if (localDateOf(endMs - 1) !== localDateOf(startMs)) return `${a}–${b} ${weekdayOf(endMs - 1)}`;
  const [aHour, aSuffix] = a.split(' ');
  const [, bSuffix] = b.split(' ');
  return aSuffix === bSuffix ? `${aHour}–${b}` : `${a}–${b}`;
}

/** `Thu`, from a local-shifted instant (UTC getters, as everywhere in this file). */
function weekdayOf(localMs: number): string {
  return shortDayLabel(localDateOf(localMs)).split(' ')[0] ?? '';
}

/** The amounts a sentence prints — an episode's own, or one day's share of it. */
export interface EpisodeAmounts {
  snowfallCm: number;
  rainMm: number;
  maxWindKph: number;
  maxGustKph: number | null;
}

function amountText(kind: EpisodeKind, a: EpisodeAmounts): string {
  switch (kind) {
    case 'snow':
      return `${roundTo(cmToInches(a.snowfallCm), 1)}″`;
    case 'sleet': {
      const parts: string[] = [];
      if (a.snowfallCm >= EPISODE_MIN_SNOW_CM)
        parts.push(`${roundTo(cmToInches(a.snowfallCm), 1)}″ snow`);
      if (a.rainMm >= EPISODE_MIN_RAIN_MM) parts.push(`${roundTo(mmToInches(a.rainMm), 2)}″ rain`);
      return parts.join(', ');
    }
    case 'rain':
    case 'freezing-rain':
      return a.rainMm >= EPISODE_MIN_RAIN_MM ? `${roundTo(mmToInches(a.rainMm), 2)}″` : '';
    case 'wind': {
      const gust = a.maxGustKph === null ? null : roundTo(kphToMph(a.maxGustKph), 0);
      const speed = roundTo(kphToMph(a.maxWindKph), 0);
      return gust !== null && gust > speed ? `gusts ${gust} mph` : `${speed} mph`;
    }
  }
}

function sentence(kind: EpisodeKind, when: string, amounts: EpisodeAmounts): string {
  const amount = amountText(kind, amounts);
  return amount ? `${EPISODE_NOUN[kind]} ${when} · ${amount}` : `${EPISODE_NOUN[kind]} ${when}`;
}

/**
 * How an episode's clock reads on one card.
 *
 * - `allDay` — the run covers a **whole** card, midnight to midnight. Never on a partial card: the
 *   truncated last day of the forecast reads *"rest of the forecast"*, not *"all day"* (Greptile on
 *   #51), and today's card is already captioned *"rest of today"*.
 * - `openEnded` — the run reaches the end of the series, so its end is not a forecast, it is where
 *   the forecast stops. The clock must not print that instant as an ending.
 */
export interface EpisodeClockOptions {
  allDay?: boolean;
  openEnded?: boolean;
}

/**
 * One sentence for one episode, imperial (D25): `Snow 10 PM–4 AM Fri · 3.2″` · `Rain 1–3 PM · 0.1″`
 * · `Wind 2–7 PM · gusts 38 mph` · `Snow all day` · `Snow from 10 PM` when the forecast ends before
 * the snow does.
 *
 * The clock is a plain two-ended range, and when it crosses midnight the end names its day — the
 * card it is printed on is the start's date, so only the far end needs one.
 */
export function formatEpisode(e: ForecastEpisode, opts: EpisodeClockOptions = {}): string {
  const when = opts.allDay
    ? 'all day'
    : opts.openEnded
      ? `from ${formatLocalHourLabel(e.startMs)}`
      : clockRange(e.startMs, e.endMs);
  return sentence(e.kind, when, e);
}

/**
 * The sentence a later day prints for an episode that began before it (founder call, 2026-09-11:
 * *"then on Wednesday's card 'Snow until 6am' again"*): `Snow until 6 AM · 1.2″`, with **that day's
 * share** of the amounts — the storm's total belongs to the card it started on. `all day` when the
 * run outlasts a whole card; `through 8 AM` — the last hour there is — when the forecast runs out
 * before the weather does.
 */
export function formatContinuation(
  e: ForecastEpisode,
  share: EpisodeAmounts,
  opts: EpisodeClockOptions = {},
): string {
  const when = opts.allDay
    ? 'all day'
    : opts.openEnded
      ? `through ${formatLocalHourLabel(e.endMs - HOUR_MS)}`
      : `until ${formatLocalHourLabel(e.endMs)}`;
  return sentence(e.kind, when, share);
}

/** The amounts of `e` that fall inside `[fromMs, toMs)`, summed over the plan's hours. */
function episodeShare(
  e: ForecastEpisode,
  hours: readonly ForecastPlanHour[],
  fromMs: number,
  toMs: number,
): EpisodeAmounts {
  const share: EpisodeAmounts = { snowfallCm: 0, rainMm: 0, maxWindKph: 0, maxGustKph: null };
  const lo = Math.max(e.startMs, fromMs);
  const hi = Math.min(e.endMs, toMs);
  for (const h of hours) {
    if (h.startMs < lo || h.startMs >= hi) continue;
    // Only hours doing the episode's thing count toward its share — a bridged lull adds nothing,
    // and a wind run's hours are not a snow run's.
    if (e.kind === 'wind' ? h.windSpeedKph < EPISODE_WIND_KPH : precipFamily(h) !== e.kind)
      continue;
    share.snowfallCm += h.snowfallCm;
    share.rainMm += h.liquidMm;
    share.maxWindKph = Math.max(share.maxWindKph, h.windSpeedKph);
    if (h.windGustKph !== undefined)
      share.maxGustKph = Math.max(share.maxGustKph ?? 0, h.windGustKph);
  }
  return share;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Days
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A day's symbol. **Any precipitation episode that touches the day wins**, worst kind first — a
 * day with two hours of freezing rain and twenty of sun is a freezing-rain day on this lake, and
 * so is the Friday a Thursday storm is still falling on (the sentence stays on the day the storm
 * started; the symbol goes wherever the snow does). A dry day takes the modal daytime cloud state,
 * because nobody can see the clouds at night and a day that is overcast until noon and clear after
 * is "partly cloudy" in every weather app a reader has ever used.
 *
 * `episodes` is every episode overlapping the day, not only those that start on it.
 */
function dayCondition(
  hours: readonly ForecastPlanHour[],
  episodes: readonly ForecastEpisode[],
): ForecastCondition {
  const kinds = new Set(episodes.map((e) => e.kind));
  for (const c of FORECAST_CONDITIONS) {
    if (!PRECIP_CONDITIONS.has(c)) break;
    // Thunder folds into `rain` runs for the sentence and has no floor for the symbol: an hour of
    // it names the day — at its own rank, so freezing rain and sleet still outrank it. Drizzle has
    // no episode kind and no say here: a trace under the rain floor is a cloudy day, not a wet one.
    if (c === 'thunder') {
      if (hours.some((h) => h.condition === 'thunder')) return c;
      continue;
    }
    if (c === 'drizzle') continue;
    if (kinds.has(c as EpisodeKind)) return c;
  }
  const daytime = hours.filter(
    (h) => h.localHour >= DAYTIME_START_HOUR && h.localHour < DAYTIME_END_HOUR,
  );
  const vote = daytime.length > 0 ? daytime : hours;
  // The dry hours vote; when there are none — every visible hour precipitated, all of it under
  // the floors — every hour votes, so a day of sub-floor drizzle is a drizzle day and not the
  // first entry of the table.
  const dry = vote.filter((h) => !PRECIP_CONDITIONS.has(h.condition));
  const tally = new Map<ForecastCondition, number>();
  for (const h of dry.length > 0 ? dry : vote) {
    tally.set(h.condition, (tally.get(h.condition) ?? 0) + 1);
  }
  let best: ForecastCondition = 'clear';
  let bestCount = 0;
  // Iterate in the fixed order so a tie resolves toward the cloudier (worse) state — the cautious
  // read. Strictly greater than zero, so an absent condition can never be the winner.
  for (const c of FORECAST_CONDITIONS) {
    const n = tally.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function labelsFor(dayMs: number, todayMs: number): { label: string; dateLabel: string } {
  // `Thu 15` — the past panel's own form, from the past panel's own function.
  const dateLabel = shortDayLabel(dayMsToLocalDate(dayMs));
  if (dayMs === todayMs) return { label: 'Today', dateLabel };
  if (dayMs === todayMs + DAY_MS) return { label: 'Tomorrow', dateLabel };
  return { label: dateLabel.split(' ')[0] ?? '', dateLabel };
}

/**
 * The night that ends on `dayMs`: hours from the previous day's `NIGHT_START_HOUR` through this
 * day's `NIGHT_END_HOUR`, exclusive. `null` unless at least half of that window is in the series —
 * the first card's night is usually already underway when the forecast begins.
 */
function nightLow(all: readonly ForecastPlanHour[], dayMs: number): number | null {
  const start = dayMs - DAY_MS + NIGHT_START_HOUR * HOUR_MS;
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
  // Where the forecast stops. An episode ending here has not ended; the data has.
  const seriesEndMs = (keptHours[keptHours.length - 1]?.startMs ?? Number.NaN) + HOUR_MS;

  const days: ForecastPlanDay[] = [];
  for (const { localDate, firstHourIndex, hours: dayHours } of kept) {
    const dayMs = localDateToDayMs(localDate) ?? 0;
    const dayEnd = dayMs + DAY_MS;
    // An episode's full sentence belongs to the day it starts on; every later day it reaches gets
    // a continuation line with its own share; the symbol follows every day it touches.
    const touching = episodes.filter((e) => e.startMs < dayEnd && e.endMs > dayMs);
    const own = touching.filter((e) => e.startMs >= dayMs);
    const continued = touching.filter((e) => e.startMs < dayMs);
    // Ascending, so the card's span is its first and last hour.
    const dayStartMs = dayHours[0]?.startMs ?? Number.NaN;
    const dayEndMs = (dayHours[dayHours.length - 1]?.startMs ?? Number.NaN) + HOUR_MS;
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
      rainMm += h.liquidMm;
      maxWindKph = Math.max(maxWindKph, h.windSpeedKph);
      if (h.windGustKph !== undefined) maxGustKph = Math.max(maxGustKph ?? 0, h.windGustKph);
      if (h.shortwaveWm2 !== undefined) {
        sawShortwave = true;
        if (h.shortwaveWm2 >= SUNLIT_WM2) sunlit++;
      }
    }
    // Not `hours < 24`: a spring-forward day has 23 hours and is whole. A card is partial when it
    // does not begin at its own midnight (today, already under way) or does not reach the next one
    // (the series' last day, cut short).
    const partial = (dayHours[0]?.localHour ?? 0) !== 0 || dayEndMs < dayEnd;
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
      partial,
      condition: dayCondition(dayHours, touching),
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
      lines: [
        ...continued.map((e) =>
          formatContinuation(e, episodeShare(e, dayHours, dayMs, dayEnd), {
            allDay: !partial && e.endMs >= dayEndMs,
            openEnded: e.endMs >= seriesEndMs,
          }),
        ),
        ...own.map((e) =>
          formatEpisode(e, {
            allDay: !partial && e.startMs <= dayStartMs && e.endMs >= dayEndMs,
            openEnded: e.endMs >= seriesEndMs,
          }),
        ),
      ],
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
