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
 * **Practical:** both clients render these sentences verbatim and neither owns the reasoning.
 *
 * ⚠ This paragraph used to justify that split by saying `apps/mobile` had **no charting library**, so
 * mobile got text where web got a chart. Workstream D retired the claim: the missing piece was never
 * a library but shared *geometry*, `react-native-svg` was already a dependency, and both clients now
 * draw the identical timeline from `weatherTimeline.ts`. The sentences still live here — a chart and
 * a sentence answer different questions, and only one of them is a place a safety verdict can hide.
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

import {
  type ColdChain,
  type ColdChainThresholdF,
  coldChain,
  describeColdChain,
  thresholdLabel,
} from './coldChain';
import {
  cmToInches,
  cToF,
  formatPrecipInches,
  formatWindMph,
  kphToMph,
  mmToInches,
  roundTo,
} from './units';
import {
  dominantWindSector,
  isCompleteDay,
  lastSnowDay,
  monthDayLabel,
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

/**
 * The "nights below" threshold the panel reports — 20°F, the founder's. One of D164's pinned
 * thresholds, so the drawer and the discovery filter cannot describe the same lake with two numbers.
 */
export const HARD_FREEZE_NIGHT_F: ColdChainThresholdF = 20;

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
  /**
   * True when the day has data but **has not finished happening** — today, mid-afternoon.
   *
   * ⚠ **A third state, not a shade of the other two.** A missing day is unknown, a complete day is
   * settled, and a partial day is *true so far*: its high may still rise, and its "no snow" means
   * none yet. The strip draws it, because what is happening now is exactly what a skater wants; the
   * headline excludes it, because a headline is a claim about a finished window.
   */
  partial: boolean;
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
  /**
   * Days present but still in progress — normally 0 or 1, the 1 being today.
   *
   * Excluded from every headline integral, so `headline` describes `rows.length − missingDays −
   * partialDays` finished days. The strip still draws them.
   */
  partialDays: number;
  /** Set when any row came from the coarser `filter` tier (D161 step 2). */
  coarse: boolean;
}

/** A day summary or a known hole. The panel draws both; only one of them has numbers. */
export type PanelDay = (Partial<WeatherDaySummary> & { dayMs: number; localDate: string }) | null;

// The conversions themselves live in `units.ts` (D25's one imperial-display layer); these are only
// the null-passing wrappers the row builder needs, so a second copy of the factors can never drift
// from the first.
function f(celsius: number | null | undefined): number | null {
  return typeof celsius === 'number' ? roundTo(cToF(celsius), 0) : null;
}

function inFromCm(cm: number | null | undefined): number | null {
  return typeof cm === 'number' ? roundTo(cmToInches(cm), 1) : null;
}

function inFromMm(mm: number | null | undefined): number | null {
  return typeof mm === 'number' ? roundTo(mmToInches(mm), 2) : null;
}

function mph(kph: number | null | undefined): number | null {
  return typeof kph === 'number' ? roundTo(kphToMph(kph), 0) : null;
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

/**
 * Format an `HourlyWeather.startMs` as a local clock time — **the only correct way to render one.**
 *
 * ⚠ **`new Date(startMs).toLocaleTimeString()` is wrong here and looks right.** `startMs` is
 * deliberately *local-shifted* (`weather.ts` adds `utc_offset_seconds`, so the reducer can bucket a
 * night without per-call timezone maths). Passing it to a local formatter applies the offset a
 * **second** time — a silent 4–5 hour slide in the Northeast that produces a perfectly plausible
 * sentence: "snow starts at 1 AM" when it starts at 8 PM. No type catches it and no test catches it
 * unless the test knows to look.
 *
 * So the shift is read back out with **UTC getters**, which is correct precisely because the value is
 * already local. Same rule as `shortDayLabel` and `monthDayLabel` above, for the same reason.
 *
 * This exists ahead of the hourly panel that will need it (N6h Workstream D) so the obvious function
 * is also the right one — a note in a docblock is not protection when the code is written weeks later.
 */
export function formatLocalHourLabel(startMs: number): string {
  if (!Number.isFinite(startMs)) return '';
  const d = new Date(startMs);
  const hour24 = d.getUTCHours();
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const minutes = d.getUTCMinutes();
  return minutes === 0
    ? `${hour12} ${suffix}`
    : `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

/**
 * A local hour-of-day (0–23) as a 12-hour clock label — `14` → `2 PM`.
 *
 * The sibling of {@link formatLocalHourLabel}, for the archive's hourly rows, which carry a plain
 * `localHour` integer rather than a timestamp. Neither client should hand-roll the `% 12 === 0 ? 12`
 * dance: both timelines print this under a scrub crosshair, and an off-by-one at noon or midnight is
 * the kind of thing that reads fine until someone checks it against a clock.
 */
export function formatLocalHour(localHour: number): string {
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) return '';
  const suffix = localHour < 12 ? 'AM' : 'PM';
  return `${localHour % 12 === 0 ? 12 : localHour % 12} ${suffix}`;
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
  options: {
    /**
     * The **lake's** current local day, from `localDayMsAt(Date.now(), cellOffsetSeconds)`.
     *
     * ⚠ Required, and not defaulted to the device's clock. Today's row arrives holding 24 hours from
     * the first fetch of the morning — the un-elapsed ones forecast — so without this the headline
     * states tonight's predicted low as an observed one. See {@link isCompleteDay}.
     */
    todayLocalDayMs: number;
    coarse?: boolean;
    /**
     * The cold chain computed server-side over a wider window than the panel draws (D164). The
     * panel shows seven days; a chain that started three weeks ago would otherwise read "7+ nights"
     * for the rest of the winter. When absent the panel computes the chain over its own days.
     */
    chain?: ColdChain;
  },
): PastWeatherPanel {
  const rows: PastWeatherRow[] = [];
  const complete: WeatherDaySummary[] = [];

  for (const day of days) {
    if (!day) continue;
    const hasData = typeof day.hours === 'number';
    // ⚠ **`hasData` is not `isComplete`, and conflating them was a bug.** The archive stores today's
    // row on purpose, so a row can be entirely valid and still describe a day that has not happened
    // yet. Feeding that into the headline reports un-elapsed precipitation as zero ("no snow in the
    // last 7 days" while it is snowing) and a forecast high as the day's high.
    const finished = isCompleteDay(day.hours, day.dayMs, options.todayLocalDayMs);
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
      partial: hasData && !finished,
    });
    if (finished) complete.push(fillDay(day));
  }

  rows.sort((a, b) => a.dayMs - b.dayMs);
  const missingDays = rows.filter((r) => r.missing).length;
  const partialDays = rows.filter((r) => r.partial).length;

  return {
    headline: buildHeadline(complete, missingDays, partialDays, options.chain),
    rows,
    missingDays,
    partialDays,
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
    absorbedInsolationWhM2: day.absorbedInsolationWhM2 ?? 0,
    sunlitThawHours: day.sunlitThawHours ?? 0,
    meltIndexMm: day.meltIndexMm ?? 0,
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
function buildHeadline(
  days: readonly WeatherDaySummary[],
  missingDays: number,
  partialDays = 0,
  servedChain?: ColdChain,
): string[] {
  // ⚠ `days` is finished days only. Every "in the last N days" below counts `days.length`, so if a
  // partial row ever leaks back in here those sentences silently start describing an unfinished
  // window while reading exactly as before.
  if (days.length === 0) return [];
  const lines: string[] = [];

  // 1. How many hard-freeze nights, the single most-asked question — as a **chain** (D164), the same
  //    `coldChain` the discovery filter reads, so "4 nights below 20°F" means one thing on the card
  //    and in the drawer. A chain that reaches the window's oldest day prints "7+".
  const knownNights = days.filter((d) => d.nightMinTempC !== null).length;
  if (knownNights > 0) {
    const chain =
      servedChain ??
      coldChain(
        days.map((d) => ({
          dayMs: d.dayMs,
          nightMinTempC: d.nightMinTempC,
          snowfallCm: d.snowfallCm,
        })),
        HARD_FREEZE_NIGHT_F,
      );
    lines.push(
      describeColdChain(chain) ??
        `No nights below ${thresholdLabel(HARD_FREEZE_NIGHT_F)} in the last ${knownNights} night${knownNights === 1 ? '' : 's'}`,
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
    const since = monthDayLabel(last.localDate);
    // ⚠ **"since" has to be measured over the days SINCE, and it was not.** The sector came from the
    // whole window — including the days *before* the snow fell — and the gate was the snow day's own
    // peak gust, so a calm week following a blustery snowfall could be captioned with the direction
    // the wind had been blowing beforehand. Two true numbers, one false sentence, which is the exact
    // shape the "last on, not since" note below rejects; the fix is to ask the same question the
    // grammar asks.
    const after = days.filter((d) => d.dayMs > last.dayMs);
    const sector = dominantWindSector(after);
    const peakSinceKph = after.reduce((max, d) => Math.max(max, d.maxWindKph ?? 0), 0);
    const windNote =
      sector !== null && peakSinceKph > 20 ? `, ${COMPASS_LABELS[sector] ?? '?'} wind since` : '';
    // ⚠ **"last on", not "since".** `snowCm` is the total across the whole window while `since` is
    // the *most recent* snow day, so "3″ of snow since Feb 4" would assert that all three inches
    // fell after Feb 4 when most of them may have fallen a week earlier. Two true numbers, one false
    // sentence — the exact shape D3 forbids, arrived at by grammar rather than by inference.
    lines.push(`${formatPrecipInches(snowCm * 10, 1)} of snow, last on ${since}${windNote}`);
  }

  // 4. Rain, which is the resurfacing input and the opposite sign from snow.
  //    Picked by day key rather than by array position: `buildPastWeatherPanel` sorts its *rows* and
  //    not this list, so `.at(-1)` would name whichever rainy day happened to arrive last.
  let lastRain: WeatherDaySummary | null = null;
  for (const d of days) {
    if (d.rainMm >= RESURFACE_RAIN_MM && (lastRain === null || d.dayMs > lastRain.dayMs)) {
      lastRain = d;
    }
  }
  if (lastRain) {
    lines.push(`Rain on ${monthDayLabel(lastRain.localDate)}`);
  }

  // 5. Freeze–thaw churn, the candling/shell driver.
  const churn = days.filter((d) => d.hoursBelowFreezing > 0 && d.hoursAboveFreezing > 0).length;
  if (churn > 0) {
    lines.push(`${churn} day${churn === 1 ? '' : 's'} crossing freezing`);
  }

  // 5b. Sun *while above freezing*, which is a different event from either one alone.
  //
  // Founder, 2026-09-03: *"a single afternoon with sun above freezing will make the ice's surface
  // sticky and soft in a way that kind of ruins it."* The literature agrees on the mechanism —
  // shortwave penetrates clear ice and melts it internally at the grain boundaries — and it is the
  // reason `hoursAboveFreezing` alone under-describes a thaw: a grey 2 °C day and a sunny 2 °C day
  // score identically there and do very different things to a skating surface.
  //
  // ⚠ Stated as *sunny hours above freezing*, never as what they did to the ice. The mechanism is
  // why the line is worth printing; the claim stays on the weather (D3).
  const sunnyThaw = days.filter((d) => d.sunlitThawHours >= 1).length;
  if (sunnyThaw > 0) {
    const hours = Math.round(days.reduce((sum, d) => sum + d.sunlitThawHours, 0));
    lines.push(
      `${hours} sunny hour${hours === 1 ? '' : 's'} above freezing, over ${sunnyThaw} day${sunnyThaw === 1 ? '' : 's'}`,
    );
  }

  // 6. Say what we do not know, last and plainly. A quiet gap is how a five-day span gets read as a
  //    seven-day one.
  if (missingDays > 0) {
    lines.push(`${missingDays} day${missingDays === 1 ? '' : 's'} of weather unavailable`);
  }

  // 7. And say what has not finished yet, for the same reason. Without this the reader has no way to
  //    tell that today was left out of everything above — the lines would simply describe a shorter
  //    window than the strip draws, which is the quiet kind of wrong.
  if (partialDays > 0) {
    lines.push(
      partialDays === 1
        ? 'Today is still in progress and is not counted above'
        : `${partialDays} days are still in progress and are not counted above`,
    );
  }

  return lines;
}
