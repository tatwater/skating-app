/**
 * The past-weather panel's copy (N6h Workstream C).
 *
 * ## Why the formatting lives in core rather than in each client
 *
 * Two reasons, one principled and one practical.
 *
 * **Principled:** this panel is the closest thing in the app to a statement about ice, and
 * [D3](../../plans/01-decisions.md) forbids a safety verdict. Keeping every sentence in one tested
 * module is how "observation, never counsel" stays enforceable instead of aspirational — two clients
 * phrasing the same freeze differently is how a verdict sneaks in.
 *
 * **Practical:** as of N6h, `apps/mobile` has **no charting library at all** (checked; Phase 7b's
 * Recharts kit is web-and-admin-only). So mobile renders this panel as text, web renders the same
 * text plus a chart over the same numbers, and neither owns the reasoning.
 *
 * ## What it leads with, and why that is not the temperature
 *
 * A general weather app already tells you the high and the low. What it cannot tell you is what the
 * ice has been through, and the two observations that matter most to a skater are:
 *
 * 1. **Wind while it was freezing.** A hard freeze under calm air makes black ice; the same freeze
 *    under wind makes a rippled surface nobody wants to skate. This is a fact about air, not a claim
 *    about ice — which is exactly why we are allowed to say it.
 * 2. **Snow since the freeze, and whether wind has moved it.** Snow insulates, hides, and never
 *    heals (D56). "Three inches fell on Tuesday and it has been calm since" is the whole story.
 *
 * ⚠ **The freezing-degree integrals never appear here.** They are model-internal by founder call
 * (Phase 10), and publishing one is a division away from an ice-thickness estimate — which
 * [D160](../../plans/01-decisions.md) confines to an operator-only instrument for a reason.
 */

import { formatPrecipInches, formatTemperatureF, formatWindMph, roundTo } from './units';
import {
  dominantWindSector,
  lastSnowDay,
  nightsBelowThresholdC,
  snowfallTotalCm,
  type WeatherDaySummary,
} from './weatherDay';

/** 16-point compass labels, index 0 = N clockwise — the same order the sector histogram uses. */
export const COMPASS_LABELS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

/**
 * Wind at or below this (kph) counted as "calm" while freezing — the black-ice threshold.
 *
 * 8 kph ≈ 5 mph. Chosen as the point below which a lake surface stays glassy rather than from a
 * published number, because the published numbers are about wave formation on open water and this is
 * about a skim of new ice. ⚠ **A guess, and labelled one** — worth revisiting against D160's
 * calibration data once a season of paired observations exists.
 */
export const CALM_FREEZE_MAX_KPH = 8;

/** Snowfall below this (cm) in a day is a dusting, not a snow event. */
export const PANEL_SNOW_THRESHOLD_CM = 0.5;

/** Rain above this (mm) in a day can resurface ice if a freeze follows — the event skaters chase. */
export const RESURFACE_RAIN_MM = 2;

/** The "nights below" threshold the panel reports, in °C. −6.7°C ≈ 20°F. */
export const HARD_FREEZE_NIGHT_C = -6.7;

export interface PastWeatherRow {
  dayMs: number;
  localDate: string;
  /** `null` when this day is a known gap — rendered as a hole, never as a zero. */
  highF: number | null;
  lowF: number | null;
  /** Overnight low for the night that *ended* this morning. `null` when unobserved. */
  nightLowF: number | null;
  hoursBelowFreezing: number | null;
  snowfallIn: number | null;
  rainIn: number | null;
  hoursOfSun: number | null;
  maxWindMph: number | null;
  /** Mean wind while freezing, mph — the black-ice signal. `null` when nothing froze. */
  freezeWindMph: number | null;
  /** True when the day is absent from the archive rather than merely quiet. */
  missing: boolean;
}

export interface PastWeatherPanel {
  /**
   * Plain observation lines, most decision-relevant first. Empty when there is nothing honest to say,
   * which the caller should render as absence rather than as "no notable weather".
   */
  headline: string[];
  rows: PastWeatherRow[];
  /** Days in the window with no data at all. */
  missingDays: number;
  /** Set when any row came from the coarser `filter` tier (D161 step 2). */
  coarse: boolean;
}

/** A day summary or a known hole. The panel draws both; only one of them has numbers. */
export type PanelDay = (Partial<WeatherDaySummary> & { dayMs: number; localDate: string }) | null;

function f(celsius: number | null | undefined): number | null {
  return typeof celsius === 'number' ? roundTo((celsius * 9) / 5 + 32, 0) : null;
}

function inFromCm(cm: number | null | undefined): number | null {
  return typeof cm === 'number' ? roundTo(cm / 2.54, 1) : null;
}

function inFromMm(mm: number | null | undefined): number | null {
  return typeof mm === 'number' ? roundTo(mm / 25.4, 2) : null;
}

function mph(kph: number | null | undefined): number | null {
  return typeof kph === 'number' ? roundTo(kph / 1.609344, 0) : null;
}

/** `2026-01-15` → `Thu 15` — a short label, formatted from the parts so no timezone can shift it. */
export function shortDayLabel(localDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) return localDate;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // ⚠ Built with `Date.UTC` and read with `getUTCDay`. A local constructor here would shift the
  // weekday by one for half the world, on a date that is already the lake's own local date.
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  ];
  return `${weekday} ${d}`;
}

/** `2026-01-15` → `Jan 15`, for prose lines that name a date. */
export function monthDayLabel(localDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) return localDate;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[Number(m[2]) - 1] ?? '?'} ${Number(m[3])}`;
}

/**
 * Turn stored day rows into the panel.
 *
 * `days` may contain holes (`null`) or rows carrying only `dayMs`/`localDate`; both render as gaps.
 * **A gap is never smoothed over** — `snowfallTotalCm` across five of seven days is not less snow, it
 * is less knowledge, and the headline says so rather than quietly under-reporting.
 */
export function buildPastWeatherPanel(
  days: readonly PanelDay[],
  options: { coarse?: boolean } = {},
): PastWeatherPanel {
  const rows: PastWeatherRow[] = [];
  const complete: WeatherDaySummary[] = [];

  for (const day of days) {
    if (!day) continue;
    const hasData = typeof day.hours === 'number';
    rows.push({
      dayMs: day.dayMs,
      localDate: day.localDate,
      highF: f(day.maxTempC),
      lowF: f(day.minTempC),
      nightLowF: f(day.nightMinTempC),
      hoursBelowFreezing:
        typeof day.hoursBelowFreezing === 'number' ? day.hoursBelowFreezing : null,
      snowfallIn: inFromCm(day.snowfallCm),
      rainIn: inFromMm(day.rainMm),
      hoursOfSun: typeof day.hoursOfSun === 'number' ? roundTo(day.hoursOfSun, 1) : null,
      maxWindMph: mph(day.maxWindKph),
      freezeWindMph: mph(day.freezingHoursMeanWindKph),
      missing: !hasData,
    });
    if (hasData) complete.push(fillDay(day));
  }

  rows.sort((a, b) => a.dayMs - b.dayMs);
  const missingDays = rows.filter((r) => r.missing).length;

  return {
    headline: buildHeadline(complete, missingDays),
    rows,
    missingDays,
    coarse: options.coarse ?? false,
  };
}

/** Default the optional measures so the span helpers can treat a partial row as a whole one. */
function fillDay(day: Partial<WeatherDaySummary> & { dayMs: number; localDate: string }) {
  return {
    dayMs: day.dayMs,
    localDate: day.localDate,
    hours: day.hours ?? 0,
    minTempC: day.minTempC ?? null,
    maxTempC: day.maxTempC ?? null,
    meanTempC: day.meanTempC ?? null,
    nightMinTempC: day.nightMinTempC ?? null,
    hoursBelowFreezing: day.hoursBelowFreezing ?? 0,
    hoursAboveFreezing: day.hoursAboveFreezing ?? 0,
    freezingDegreeHours: day.freezingDegreeHours ?? 0,
    thawDegreeHours: day.thawDegreeHours ?? 0,
    precipitationMm: day.precipitationMm ?? 0,
    rainMm: day.rainMm ?? 0,
    snowfallCm: day.snowfallCm ?? 0,
    maxSnowDepthM: day.maxSnowDepthM ?? null,
    hoursOfSun: day.hoursOfSun ?? 0,
    insolationWhM2: day.insolationWhM2 ?? 0,
    maxWindKph: day.maxWindKph ?? null,
    maxWindGustKph: day.maxWindGustKph ?? null,
    windRunKm: day.windRunKm ?? 0,
    windSectorHours: day.windSectorHours ?? [],
    freezingHoursMeanWindKph: day.freezingHoursMeanWindKph ?? null,
    freezingHoursMaxWindKph: day.freezingHoursMaxWindKph ?? null,
  } satisfies WeatherDaySummary;
}

/**
 * The observation lines, ordered by how much they change a driving decision.
 *
 * Every line is a description of weather. None is a description of ice, and none combines two
 * measures into an inference — *"cold and calm, so it should be good"* is counsel, while *"four
 * nights below 20°F, calm while freezing"* is two facts a skater draws their own conclusion from.
 */
function buildHeadline(days: readonly WeatherDaySummary[], missingDays: number): string[] {
  if (days.length === 0) return [];
  const lines: string[] = [];

  // 1. How many hard-freeze nights, the single most-asked question.
  const nights = nightsBelowThresholdC(days, HARD_FREEZE_NIGHT_C);
  const knownNights = days.filter((d) => d.nightMinTempC !== null).length;
  if (knownNights > 0) {
    lines.push(
      nights === 0
        ? `No nights below ${formatTemperatureF(HARD_FREEZE_NIGHT_C)} in the last ${knownNights} night${knownNights === 1 ? '' : 's'}`
        : `${nights} night${nights === 1 ? '' : 's'} below ${formatTemperatureF(HARD_FREEZE_NIGHT_C)}`,
    );
  }

  // 2. Wind while it froze. Reported as calm or as blowing, never as a consequence.
  const freezeWinds = days
    .map((d) => d.freezingHoursMeanWindKph)
    .filter((w): w is number => w !== null);
  if (freezeWinds.length > 0) {
    const mean = freezeWinds.reduce((a, b) => a + b, 0) / freezeWinds.length;
    lines.push(
      mean <= CALM_FREEZE_MAX_KPH
        ? `Calm while freezing — averaged ${formatWindMph(mean)}`
        : `Windy while freezing — averaged ${formatWindMph(mean)}`,
    );
  }

  // 3. Snow, and when. The "is it buried" question.
  const snowCm = snowfallTotalCm(days);
  const last = lastSnowDay(days, PANEL_SNOW_THRESHOLD_CM);
  if (last === null) {
    lines.push(`No snow in the last ${days.length} day${days.length === 1 ? '' : 's'}`);
  } else {
    const sector = dominantWindSector(days);
    const since = monthDayLabel(last.localDate);
    const windNote =
      sector !== null && (last.maxWindKph ?? 0) > 20
        ? `, ${COMPASS_LABELS[sector] ?? '?'} wind since`
        : '';
    lines.push(`${formatPrecipInches(snowCm * 10, 1)} of snow since ${since}${windNote}`);
  }

  // 4. Rain, which is the resurfacing input and the opposite sign from snow.
  const rainDays = days.filter((d) => d.rainMm >= RESURFACE_RAIN_MM);
  const lastRain = rainDays.at(-1);
  if (lastRain) {
    lines.push(`Rain on ${monthDayLabel(lastRain.localDate)}`);
  }

  // 5. Freeze–thaw churn, the candling/shell driver.
  const churn = days.filter((d) => d.hoursBelowFreezing > 0 && d.hoursAboveFreezing > 0).length;
  if (churn > 0) {
    lines.push(`${churn} day${churn === 1 ? '' : 's'} crossing freezing`);
  }

  // 6. Say what we do not know, last and plainly. A quiet gap is how a five-day span gets read as a
  //    seven-day one.
  if (missingDays > 0) {
    lines.push(`${missingDays} day${missingDays === 1 ? '' : 's'} of weather unavailable`);
  }

  return lines;
}
