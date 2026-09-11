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

/**
 * **Which local calendar day did this instant fall on, at a place with this UTC offset?**
 *
 * ⚠ **The one conversion from an instant to a `dayMs` key, and it must not be open-coded again.**
 * `weatherDays.dayMs` is UTC-midnight of a *local* date, so flooring a real UTC timestamp to a UTC
 * day answers a different question and is wrong by up to the offset. In this region that is 4–5
 * hours, which means **every evening skate is misfiled onto the next day** — the common case, not an
 * edge case. Two independent call sites got this wrong before the helper existed (the panel's window
 * anchor, and the D160 calibration window), which is what a missing abstraction looks like.
 *
 * The output is a key, never an instant: do not add it to anything or format it with a local
 * formatter. {@link dayMsToLocalDate} is its inverse.
 */
export function localDayMsAt(instantMs: number, utcOffsetSeconds: number): number {
  return Math.floor((instantMs + utcOffsetSeconds * 1000) / DAY_MS) * DAY_MS;
}

/**
 * A standing-time UTC offset guessed from longitude, in seconds, for when nothing better is stored.
 *
 * ⚠ **A fallback, never a preference.** Real offsets come from Open-Meteo (`utc_offset_seconds`,
 * stored on the day row) and know both the actual zone boundary and whether DST was in force. This
 * knows neither: it is `round(lng / 15)` hours, so it lands on the right hour for the whole
 * five-state region — every one of which is US Eastern — and would be wrong for a place whose zone
 * boundary does not follow its meridian, or by an hour in summer.
 *
 * It exists so that a report against a cell with no stored offset is off by at most an hour rather
 * than by five, and so the failure is a documented approximation instead of a silent UTC assumption.
 */
export function approximateUtcOffsetSeconds(lng: number): number {
  return Math.round(lng / 15) * 3600;
}

/**
 * Formatters are expensive to construct and we ask the same handful of zones over and over.
 *
 * `null` marks a zone the runtime rejected, so a bad identifier costs one `try` rather than one per
 * call. Bounded by the number of distinct IANA zones the corpus touches — one, in practice.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function dateFormatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const hit = zoneFormatters.get(timeZone);
  if (hit !== undefined) return hit;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // `en-CA` yields `YYYY-MM-DD`, but prove it rather than trust it — a runtime without tz data
    // silently formats in UTC, which is the failure this exists to prevent.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fmt.format(0))) fmt = null;
  } catch {
    fmt = null;
  }
  zoneFormatters.set(timeZone, fmt);
  return fmt;
}

/**
 * The local calendar date at an instant, in an IANA zone — **exact, including both DST edges.**
 *
 * ⚠ **This is the answer that offset arithmetic cannot give.** A stored `utcOffsetSeconds` describes
 * one moment, and the archive stamps a whole 92-day response with a single one (see the field's note
 * in `schema.ts`), so a winter day backfilled in July carries EDT. Even a per-date offset is
 * ambiguous at a transition: spring-forward makes an hour belong to two dates and fall-back makes one
 * belong to neither, and no amount of arithmetic on a day-granularity offset resolves either.
 *
 * A zone identifier does, because the runtime carries the transition instants. Verified against the
 * real Convex runtime rather than assumed: `2025-03-09T04:30Z` is `2025-03-08` (the evening before
 * the clocks move) and `2025-11-02T04:30Z` is `2025-11-02` (inside the hour fall-back removes).
 *
 * Returns `null` for an unknown zone or a runtime without timezone data, so a caller falls back
 * rather than silently getting UTC.
 */
export function localDateInZone(instantMs: number, timeZone: string): string | null {
  if (!Number.isFinite(instantMs)) return null;
  const fmt = dateFormatterFor(timeZone);
  if (!fmt) return null;
  const formatted = fmt.format(instantMs);
  return /^\d{4}-\d{2}-\d{2}$/.test(formatted) ? formatted : null;
}

/** {@link localDateInZone} as a `dayMs` key. `null` when the zone is unusable. */
export function localDayMsInZone(instantMs: number, timeZone: string): number | null {
  const date = localDateInZone(instantMs, timeZone);
  return date === null ? null : localDateToDayMs(date);
}

/**
 * The UTC offset a **local date** was on, in seconds — what `utcOffsetSeconds` always claimed to be.
 *
 * Probes UTC noon of the date, which lands inside that local date for every offset in ±12h and can
 * never fall in a transition gap (both US transitions fire between 01:00 and 03:00 local).
 */
export function utcOffsetSecondsInZone(dayMs: number, timeZone: string): number | null {
  if (!Number.isFinite(dayMs)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(dayMs + DAY_MS / 2);
  } catch {
    return null;
  }
  const name = parts.find((p) => p.type === 'timeZoneName')?.value;
  // `GMT-05:00`, or bare `GMT` at exactly zero.
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? '');
  if (!m) return null;
  if (!m[1]) return 0;
  const magnitude = Number(m[2]) * 3600 + Number(m[3]) * 60;
  return m[1] === '-' ? -magnitude : magnitude;
}

/**
 * Hours below which a stored day is **still in progress**, not a finished observation.
 *
 * ⚠ **Not `=== 24`.** DST days are 23 or 25 hours long and both transitions fall inside a Northeast
 * skating season, so an equality test would mark the spring-forward day permanently incomplete and
 * quietly drop a real day out of every window that crosses it.
 */
export const COMPLETE_DAY_MIN_HOURS = 23;

/**
 * Has this day finished happening?
 *
 * The archive deliberately stores **today's hours** (`forecast_days: '1'`) so a reader can see what
 * is happening now, and rewrites the row tomorrow when the day is whole. That makes "partial" a
 * normal, expected state of a perfectly good row — and it means *having data* and *being a complete
 * day* are different questions. Summing an unfinished day into a window integral reports un-elapsed
 * precipitation as zero and an in-progress high as final.
 *
 * ## ⚠ Why the hour count alone cannot answer this
 *
 * It used to be `hours >= 23` and nothing else, on the reasoning that a row too short to be a DST day
 * must still be in progress. **That reasoning had it backwards.** Open-Meteo's forecast endpoint
 * returns whole calendar days, and nothing trims the response to the elapsed part — so today's row is
 * stored with all 24 hours from the very first fetch of the morning, the un-elapsed ones carrying
 * *forecast* values. Today therefore passed a 23-hour test at 6 AM, and the panel's headline and the
 * D160 calibration integral both consumed tomorrow-ish weather as settled fact.
 *
 * So completeness is a question about **the date**, and the hour count only guards the other end: a
 * historical row with six hours in it is a damaged observation, not a finished day.
 *
 * `todayLocalDayMs` is the reader's *lake's* current local day — {@link localDayMsAt} of now at the
 * cell's stored offset — never the device's. A phone in California looking at a Vermont lake must not
 * decide what "today" means there.
 *
 * ⚠ **All three arguments are required on purpose.** The two-argument version of this question is the
 * one that was wrong for months, and an optional "today" would let a call site keep asking it by
 * saying nothing. Every caller has a date and can get an offset.
 */
export function isCompleteDay(
  hours: number | undefined | null,
  dayMs: number,
  todayLocalDayMs: number,
): boolean {
  if (typeof hours !== 'number' || hours < COMPLETE_DAY_MIN_HOURS) return false;
  return dayMs < todayLocalDayMs;
}

/**
 * The window a clear hour is allowed to count as *sun* in, when Open-Meteo gave us no
 * `sunshine_duration` and we are falling back to cloud cover.
 *
 * ⚠ **A clear sky at 2 AM is not sunshine.** Without this the fallback reports a cloudless January
 * day as **24 hours of sun**, which is not merely imprecise — it is a claim the reader will use to
 * reason about melt and glare on a field literally named "hours of sun". Deliberately narrow (a
 * Northeast December day is ~9 hours between horizons) so the fallback under-claims rather than
 * over-claims; `shortwave_radiation`, when present, is preferred over the clock because it knows the
 * actual solar geometry for the day.
 */
export const DAYLIGHT_START_HOUR = 8;
export const DAYLIGHT_END_HOUR = 16;

/**
 * Above this irradiance an hour counts as *sunlit* for {@link WeatherDaySummary.sunlitThawHours}.
 *
 * 120 W/m² is roughly the difference between "the sun is technically up" and "you can feel it on a
 * dark surface". A midwinter Northeast noon under clear sky runs ~350–450 W/m²; heavy overcast at the
 * same hour is ~40–80. The threshold sits between them so a grey thaw and a sunny thaw separate.
 */
export const SUNLIT_WM2 = 120;

/**
 * Albedo — the fraction of incoming shortwave a surface **reflects** — estimated from snow depth.
 *
 * ⚠ **This is the single largest term in how much the sun actually does to a lake, and it swings by
 * roughly a factor of six.** Fresh snow reflects 0.8–0.9; bare clear ice reflects only ~0.1, and
 * observed lake values run as low as 0.075. So an identical 3 kWh/m² day deposits ~9× more energy
 * into black ice than into the same lake under 5 cm of snow. Any melt term that ignores albedo is
 * wrong by more than it is right.
 *
 * Snow depth is the only surface signal the archive holds, so it is the only one used. The three
 * steps are coarse on purpose: the transitions (fresh → melting → gone) are where the real physics
 * lives, and interpolating between them would imply a precision the input does not have.
 *
 * ⚠ **It is a property of the snow, not of the ice.** Nothing here knows whether the ice underneath
 * is black, white, or absent — which is exactly why the output is model-internal (see
 * {@link WeatherDaySummary.meltIndexMm}) and never a skater-facing number.
 */
export function estimateAlbedo(snowDepthM: number | null): number {
  if (snowDepthM === null || snowDepthM <= 0) return 0.15; // bare ice
  if (snowDepthM < 0.02) return 0.5; // patchy or melting-out snow
  return 0.8; // snow cover
}

/**
 * Latent heat of fusion as an areal energy density: melting 1 mm of ice takes ~334 kJ/m², which is
 * **92.8 Wh/m²**. This is a physical constant, not a tuned parameter — it is what converts absorbed
 * shortwave into a melt depth without inventing a coefficient.
 */
export const MELT_WH_PER_MM = 92.8;

/**
 * Degree-hour factor for the temperature half of the melt index, in mm water-equivalent per °C-hour.
 *
 * 0.25 mm/°C·h ≈ **6 mm/°C·day**, mid-range for the degree-day factors reported for lake and glacier
 * ice. ⚠ Unlike {@link MELT_WH_PER_MM} this one **is** empirical, and it is a stand-in for every flux
 * that correlates with air temperature but is not radiation — sensible heat, longwave, condensation.
 * It is the obvious thing for D160's instrument to fit against a season of observations.
 */
export const MELT_MM_PER_DEGREE_HOUR = 0.25;

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

  /**
   * How long the sun shone, in hours.
   *
   * ⚠ **A duration, and duration is the wrong unit for what the sun does.** An hour near solar noon
   * and an hour near sunset differ by most of their energy: irradiance on a horizontal surface scales
   * with the sine of the solar elevation angle, and at 44°N in January the sun peaks around 25°
   * (sin ≈ 0.42) and reaches 0 at both ends of the day. So a 6-hour December day and a 6-hour March
   * day are the same number here and are not remotely the same event.
   *
   * Keep using it to answer *"was it sunny?"*. **Never use it to reason about melt** — that is
   * {@link WeatherDaySummary.absorbedInsolationWhM2}, which measures energy and therefore prices the
   * geometry for free.
   */
  hoursOfSun: number;
  /** Σ hourly `shortwave_radiation` × 1 h — the energy that *arrived*, before the surface reflects. */
  insolationWhM2: number;
  /**
   * Σ hourly shortwave × (1 − albedo) — the energy the surface actually **kept**.
   *
   * The honest version of "how much sun". Solar geometry is already inside the irradiance, and
   * {@link estimateAlbedo} supplies the reflection the irradiance knows nothing about.
   */
  absorbedInsolationWhM2: number;
  /**
   * Hours with air above freezing **and** meaningful sun on the surface ({@link SUNLIT_WM2}).
   *
   * Founder observation, 2026-09-03, and it is the mechanism the literature agrees on: *"a single
   * afternoon with sun above freezing will make the ice's surface sticky and soft in a way that kind
   * of ruins it."* A grey 2 °C afternoon and a sunny 2 °C afternoon have the same
   * `hoursAboveFreezing` and do very different things to a skating surface, because shortwave
   * penetrates clear ice and melts it at the grain boundaries from *within* — the process that
   * produces candled, rotten ice with little load-bearing capacity, and which can run while air
   * temperature is still below freezing.
   *
   * An observation about weather, not a claim about ice (D3): it counts sunlit hours above freezing,
   * and says nothing about what the ice did with them.
   */
  sunlitThawHours: number;
  /**
   * A melt-side energy budget in mm water-equivalent — the mirror of {@link freezingDegreeHours}.
   *
   * The standard *enhanced temperature-index* form from the glaciology literature,
   * `M = TF·T + SRF·(1−α)·SW`, which exists precisely because a pure degree-day model misses that
   * melt rates are governed to a large extent by radiation. Here that is
   * {@link MELT_MM_PER_DEGREE_HOUR} × thaw-degree-hours + absorbed insolation ÷
   * {@link MELT_WH_PER_MM}.
   *
   * ⚠ **Model-internal. This never reaches a skater surface, in any unit, under any label** — D3 and
   * D150, the same confinement D160 puts on the Stefan thickness estimate. It is a number *about a
   * model*, and a millimetre of implied melt is one step from a load-bearing claim. Its legitimate
   * readers are the operator calibration instrument and the season-close signal, both of which
   * compare it against reality rather than publish it.
   */
  meltIndexMm: number;

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
 * Was the sun up for this hour? Only consulted by the cloud-cover fallback in {@link
 * summarizeWeatherDays} — see {@link DAYLIGHT_START_HOUR}.
 *
 * Prefers `shortwave_radiation`, which is zero at night by construction and therefore knows the real
 * sunrise for this date and latitude; the fixed clock window is the last resort.
 */
function isDaylightHour(h: LocalHourlyWeather): boolean {
  if (typeof h.shortwaveWm2 === 'number') return h.shortwaveWm2 > 0;
  return h.localHour >= DAYLIGHT_START_HOUR && h.localHour < DAYLIGHT_END_HOUR;
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
  let absorbedInsolationWhM2 = 0;
  let sunlitThawHours = 0;
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
    if (typeof h.shortwaveWm2 === 'number') {
      insolationWhM2 += h.shortwaveWm2;
      // Albedo from *this hour's* snow depth rather than the day's maximum: a shallow cover that
      // melts out by noon leaves the afternoon absorbing like bare ice, and that afternoon is the
      // one that matters. Using the daily max would let the morning's snow shield the whole day.
      absorbedInsolationWhM2 += h.shortwaveWm2 * (1 - estimateAlbedo(h.snowDepthM ?? null));
      // The founder's "sunny afternoon above freezing". Both conditions, on the same hour — a sunny
      // morning followed by a mild grey afternoon is not this, and would score zero here correctly.
      if (t > 0 && h.shortwaveWm2 >= SUNLIT_WM2) sunlitThawHours += 1;
    }

    if (typeof h.sunshineSeconds === 'number') {
      hoursOfSun += h.sunshineSeconds / 3600;
    } else if (
      typeof h.cloudCoverPct === 'number' &&
      h.cloudCoverPct <= sunnyMaxCloud &&
      isDaylightHour(h)
    ) {
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
    absorbedInsolationWhM2,
    sunlitThawHours,
    meltIndexMm:
      MELT_MM_PER_DEGREE_HOUR * thawDegreeHours + absorbedInsolationWhM2 / MELT_WH_PER_MM,
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
