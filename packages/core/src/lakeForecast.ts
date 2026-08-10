/**
 * The short forward forecast for the drive decision (N6c Workstream B5b).
 *
 * The weather-since strip answers *what has happened to this ice since the report*. This is the same
 * question pointed the other way in time: **what will happen to it before I arrive.** A skater
 * reading "great ice, 2 hours ago" and a forecast of snow starting at 3pm has everything they need;
 * either half alone leaves them guessing, and the 90-minute drive is the decision this whole product
 * exists to serve.
 *
 * ## Two rules, and the second one is the hard one
 *
 * **It never feeds a calculation (D74).** Decay math runs on what happened. A hazard whose confidence
 * decayed on a forecast that did not come true would be unreproducible after the fact, which is the
 * property the whole D56 model is built on. Nothing in this module is imported by the decay path, and
 * `weather.ts` keeps forecast hours in a separate array from the ones `summarizeWeatherSince` reads —
 * a structural wall rather than a convention, because a convention is one careless spread away from
 * being broken silently.
 *
 * **It forecasts weather, never ice (D3).** "2 cm of snow at 3pm" is a third-party meteorological
 * forecast, attributed to Open-Meteo, and we may render it. "The ice will be unskateable by the time
 * you arrive" is a prediction about conditions, which is not ours to make — and it is exactly the
 * sentence this feature invites, because it is the sentence the skater is already thinking. Let them
 * think it. We show the snow and the clock; the inference is theirs, and it is a good one.
 */

import type { HourlyWeather } from './weather';

/**
 * How far ahead the strip looks.
 *
 * Twelve hours covers a decision made in the morning about an afternoon session and one made in the
 * evening about tomorrow morning — the two shapes the drive decision actually takes. Beyond that the
 * forecast degrades and the strip gets long enough that nobody reads the end of it.
 */
export const FORECAST_HORIZON_HOURS = 12;

/** Snowfall in an hour that is worth calling out, in cm. Below this it is flurries, not a reason. */
export const FORECAST_NOTABLE_SNOW_CM = 0.5;
/** Liquid precipitation in an hour worth calling out, in mm. Rain on ice is its own kind of bad news. */
export const FORECAST_NOTABLE_RAIN_MM = 0.5;

/** One hour of the forward strip. The variables that change whether you go — not the decay model's set. */
export interface ForecastHour {
  /** Epoch ms at the start of the hour, in the body's local time (Open-Meteo `timezone=auto`). */
  startMs: number;
  temperatureC: number;
  windSpeedKph: number;
  precipitationMm: number;
  snowfallCm: number;
}

/** The rendered forward forecast, or an empty `hours` when there is nothing to show. */
export interface ForecastSummary {
  hours: ForecastHour[];
  /**
   * The first hour at which snow or rain begins, if any falls in the horizon. This is the whole
   * point of the feature — the founder's scenario is a skater seeing that it starts snowing before
   * they would arrive — so it is computed once here rather than re-derived by each client.
   */
  precipStartsMs?: number;
  /** Whether the precipitation that starts is snow. Absent when nothing starts. */
  precipIsSnow?: boolean;
  /** Coldest and warmest hours in the horizon, for the one-line summary. */
  minTemperatureC?: number;
  maxTemperatureC?: number;
}

/** An hour counts as precipitating when either channel clears its own floor. */
function precipitates(hour: ForecastHour): boolean {
  return (
    hour.snowfallCm >= FORECAST_NOTABLE_SNOW_CM || hour.precipitationMm >= FORECAST_NOTABLE_RAIN_MM
  );
}

/**
 * Shape raw forward hours into the strip.
 *
 * **`nowMs` is compared against the same clock the hours carry.** Open-Meteo returns local-shifted
 * timestamps (`timezone=auto`, and `weather.ts` adds `utc_offset_seconds`), so the caller passes a
 * correspondingly shifted `nowMs`. Getting this wrong does not throw — it silently drops or admits a
 * few hours at the boundary, which is precisely the kind of bug that survives a review, so the
 * caller's offset arithmetic is asserted in `weather.test.ts` rather than trusted here.
 *
 * Hours are truncated to the horizon and sorted, because neither is guaranteed by a provider and
 * both are assumed by every renderer.
 */
export function summarizeForecast(
  hours: readonly HourlyWeather[],
  nowLocalMs: number,
  horizonHours: number = FORECAST_HORIZON_HOURS,
): ForecastSummary {
  const endMs = nowLocalMs + horizonHours * 3_600_000;
  const forward: ForecastHour[] = [];
  for (const hour of hours) {
    if (hour.startMs === undefined) continue; // no clock ⇒ nothing a strip can place
    if (hour.startMs < nowLocalMs || hour.startMs > endMs) continue;
    forward.push({
      startMs: hour.startMs,
      temperatureC: hour.temperatureC,
      windSpeedKph: hour.windSpeedKph,
      precipitationMm: hour.precipitationMm,
      snowfallCm: hour.snowfallCm ?? 0,
    });
  }
  forward.sort((a, b) => a.startMs - b.startMs);

  if (forward.length === 0) return { hours: [] };

  const summary: ForecastSummary = { hours: forward };
  const onset = forward.find(precipitates);
  if (onset) {
    summary.precipStartsMs = onset.startMs;
    // **Snow wins ties**, because on ice the two are not symmetric: snow insulates and hides, and it
    // is the one a skater most needs to see coming. An hour with both is a snow hour.
    summary.precipIsSnow = onset.snowfallCm >= FORECAST_NOTABLE_SNOW_CM;
  }
  summary.minTemperatureC = Math.min(...forward.map((h) => h.temperatureC));
  summary.maxTemperatureC = Math.max(...forward.map((h) => h.temperatureC));
  return summary;
}

/** True when a summary has nothing worth rendering — the drawer's "render nothing" test. */
export function forecastIsEmpty(summary: ForecastSummary | null | undefined): boolean {
  return !summary || summary.hours.length === 0;
}

/** Local hour as a bare clock reading — "3pm", "midnight". The strip's whole time vocabulary. */
function clockHour(localMs: number): string {
  const hour = new Date(localMs).getUTCHours();
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12;
  return `${twelve}${suffix}`;
}

/**
 * The strip's one line, in imperial (D25: store metric, display imperial — there is no metric
 * display mode in this product, and N6c-1 already had to fix this exact contradiction once).
 *
 * **Descriptive, never predictive about ice (D3).** The strongest sentence permitted here is "snow
 * starting around 3pm" — a third-party meteorological forecast, attributed. What it must never grow
 * into is "it'll be unskateable by the time you get there", which is the inference the skater draws
 * and not the one we state. The line names weather and a clock; the reader supplies the rest.
 *
 * Returns `null` when there is nothing to say, so the caller renders nothing at all.
 */
export function formatForecastStrip(summary: ForecastSummary | null | undefined): string | null {
  if (forecastIsEmpty(summary) || !summary) return null;
  const parts: string[] = [];

  if (summary.minTemperatureC !== undefined && summary.maxTemperatureC !== undefined) {
    const lo = Math.round(summary.minTemperatureC * 1.8 + 32);
    const hi = Math.round(summary.maxTemperatureC * 1.8 + 32);
    parts.push(lo === hi ? `Around ${lo}°F` : `${lo}–${hi}°F`);
  }

  if (summary.precipStartsMs !== undefined) {
    const what = summary.precipIsSnow ? 'snow' : 'rain';
    parts.push(`${what} starting around ${clockHour(summary.precipStartsMs)}`);
  }

  if (parts.length === 0) return null;
  const horizon = summary.hours.length;
  return `Next ${horizon} hour${horizon === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}
