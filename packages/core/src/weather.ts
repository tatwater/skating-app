/**
 * "Weather since report" reducer (D19). Purely **descriptive** — it summarizes what
 * the weather has *done* over a window (e.g. [skate time → now], or a hazard's recent
 * days) to support the skater's own judgment. It asserts nothing about current ice
 * safety (D3).
 *
 * Two consumers, one fetch (Phase 10 / D56):
 *   - the **strip** reads the human subset (peak/low temp, nights below freezing, sun, rain, wind);
 *   - the **decay model** (`decayMultiplier`) reads the *model-internal integrals*
 *     (`freezingDegreeHours`/`thawDegreeHours`, freeze-run, freeze/thaw cycles).
 *
 * Input is Open-Meteo-style hourly data (see the mapping in `04-integrations.md`). The expanded
 * variable set (2026-07-22 scoping) supersedes the original five — see `plans/phase-10-weather.md` §1
 * for the per-variable rationale. Units follow Open-Meteo's native ones so the fetch layer can pass
 * values straight through: temperature °C, rain mm, snowfall **cm**, snow depth m, wind kph,
 * shortwave radiation W/m².
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface HourlyWeather {
  /**
   * Epoch ms at the start of this hour, in the **body's local time** (Open-Meteo `timezone=auto`).
   * Local — so `nightsBelowFreezing` buckets onto the right calendar night with no per-call tz math.
   * Optional: the decay integrals and every other aggregate are order-based and need no timestamp;
   * only `nightsBelowFreezing` uses it (and reads `null` when any hour lacks it).
   */
  startMs?: number;
  temperatureC: number;
  /** Open-Meteo `precipitation` (mm) — total water-equivalent (rain + snow-melt + showers). */
  precipitationMm: number;
  windSpeedKph: number;
  /** Open-Meteo `wind_gusts_10m` (kph). */
  windGustKph?: number;
  /** Open-Meteo `rain` (mm) — liquid only. Split from snowfall (opposite decay signs, D56). */
  rainMm?: number;
  /** Open-Meteo `snowfall` (**cm** — its native unit). Snow insulates + hides; never heals (D56). */
  snowfallCm?: number;
  /** Open-Meteo `snow_depth` (m). */
  snowDepthM?: number;
  /** Open-Meteo `shortwave_radiation` (W/m², hourly mean) — insolation; subsumes the season/solar term. */
  shortwaveWm2?: number;
  /** Open-Meteo `sunshine_duration` (seconds of sun in the hour), if available. */
  sunshineSeconds?: number;
  /** Fallback when `sunshineSeconds` is absent: cloud cover % for the hour. */
  cloudCoverPct?: number;
}

export interface WeatherSinceSummary {
  hours: number;

  // ── Descriptive (the strip) ──────────────────────────────────────────────────────────
  /** null when there is no data. */
  peakTempC: number | null;
  /** Window low ("did it freeze?"). null when there is no data. */
  minTempC: number | null;
  hoursNearFreezing: number;
  hoursAboveFreezing: number;
  /**
   * Distinct local nights whose minimum dropped below 0°C ("did it refreeze each night?" — the bimodal
   * open_water/thin_ice driver). A "night" is noon→noon-shifted so it doesn't split at midnight.
   * **null** when timestamps are unavailable (any hour missing `startMs`) — can't bucket honestly.
   */
  nightsBelowFreezing: number | null;
  hoursOfSun: number;
  totalPrecipMm: number;
  /** Liquid rain only (mm), summed from `rainMm` when the split is present; 0 otherwise. */
  rainMm: number;
  /** Snowfall (cm), summed from `snowfallCm` when present; 0 otherwise. */
  snowfallCm: number;
  /** Peak snow depth (m) over the window. null when no depth data. */
  maxSnowDepthM: number | null;
  /** null when there is no data. */
  maxWindKph: number | null;
  /** Peak gust (kph). null when no gust data. */
  maxWindGustKph: number | null;
  /** Wind-run (km) = Σ hourly wind speed × 1h. */
  windRunKm: number;

  // ── Model-internal integrals (the decay model consumes these; the strip never shows them) ──
  /** Σ over freezing hours of (0 − tempC) — magnitude, not a count. The ~1″/15-FDD growth backbone. */
  freezingDegreeHours: number;
  /** Σ over thawing hours of (tempC − 0) — the ~30%-faster-than-growth counterpart. */
  thawDegreeHours: number;
  /** Σ hourly shortwave radiation (≈ Wh/m²) — accumulated insolation. 0 when no radiation data. */
  insolationWhM2: number;
  /** Longest consecutive run of below-0 hours — a *sustained* freeze (the `thawed_rotten` gate). */
  longestFreezeRunHours: number;
  /** Count of freeze→thaw onsets (a below-0 hour followed by an above-0 hour) — drives candling/shell. */
  freezeThawCycles: number;
}

export interface WeatherSinceOptions {
  /** Lower bound of the "near freezing" band (°C). Default -2. */
  freezingBandLowC?: number;
  /** Upper bound of the "near freezing" band (°C). Default +2. */
  freezingBandHighC?: number;
  /** Cloud cover ≤ this % counts as a "sun" hour when `sunshineSeconds` is absent. Default 20. */
  sunnyCloudCoverMaxPct?: number;
}

/**
 * The local-night bucket an hour belongs to (needs a local `startMs`). Shifted back 12h so a night
 * (evening of day D through the morning of D+1, when the pre-dawn minimum lands) maps to a single
 * bucket instead of splitting at midnight.
 */
function nightIndex(startMs: number): number {
  return Math.floor((startMs - 12 * HOUR_MS) / DAY_MS);
}

/**
 * Reduce hourly weather into the descriptive strip + the model-internal decay integrals (D19/D56).
 * A single pass; every aggregate is recomputed independently in the property test so a stub can't pass.
 */
export function summarizeWeatherSince(
  hourly: readonly HourlyWeather[],
  options: WeatherSinceOptions = {},
): WeatherSinceSummary {
  const lowBand = options.freezingBandLowC ?? -2;
  const highBand = options.freezingBandHighC ?? 2;
  const sunnyMaxCloud = options.sunnyCloudCoverMaxPct ?? 20;

  let peakTempC: number | null = null;
  let minTempC: number | null = null;
  let maxWindKph: number | null = null;
  let maxWindGustKph: number | null = null;
  let maxSnowDepthM: number | null = null;
  let hoursNearFreezing = 0;
  let hoursAboveFreezing = 0;
  let hoursOfSun = 0;
  let totalPrecipMm = 0;
  let rainMm = 0;
  let snowfallCm = 0;
  let insolationWhM2 = 0;
  let windRunKm = 0;
  let freezingDegreeHours = 0;
  let thawDegreeHours = 0;

  // Freeze-run + freeze/thaw-cycle bookkeeping (order-dependent). A below-0 hour is "freezing"; an
  // above-0 hour is "thawing"; an exactly-0 hour carries the prior state (a flat 0°C stretch neither
  // starts a freeze nor breaks one).
  let longestFreezeRunHours = 0;
  let currentFreezeRun = 0;
  let freezeThawCycles = 0;
  let prevFreezing: boolean | null = null;

  // Per-night minimum temp, keyed by night bucket. `allTimed` drops to false the moment any hour
  // lacks `startMs`, which forces `nightsBelowFreezing` to null (we won't half-count nights).
  const nightMin = new Map<number, number>();
  let allTimed = hourly.length > 0;

  for (const h of hourly) {
    const t = h.temperatureC;
    peakTempC = peakTempC === null ? t : Math.max(peakTempC, t);
    minTempC = minTempC === null ? t : Math.min(minTempC, t);
    maxWindKph = maxWindKph === null ? h.windSpeedKph : Math.max(maxWindKph, h.windSpeedKph);
    if (typeof h.windGustKph === 'number') {
      maxWindGustKph =
        maxWindGustKph === null ? h.windGustKph : Math.max(maxWindGustKph, h.windGustKph);
    }
    if (typeof h.snowDepthM === 'number') {
      maxSnowDepthM = maxSnowDepthM === null ? h.snowDepthM : Math.max(maxSnowDepthM, h.snowDepthM);
    }

    if (t >= lowBand && t <= highBand) hoursNearFreezing += 1;
    if (t > 0) hoursAboveFreezing += 1;

    totalPrecipMm += h.precipitationMm;
    if (typeof h.rainMm === 'number') rainMm += h.rainMm;
    if (typeof h.snowfallCm === 'number') snowfallCm += h.snowfallCm;
    if (typeof h.shortwaveWm2 === 'number') insolationWhM2 += h.shortwaveWm2;
    windRunKm += h.windSpeedKph; // × 1h

    if (t < 0) freezingDegreeHours += -t;
    if (t > 0) thawDegreeHours += t;

    if (typeof h.sunshineSeconds === 'number') {
      hoursOfSun += h.sunshineSeconds / 3600;
    } else if (typeof h.cloudCoverPct === 'number' && h.cloudCoverPct <= sunnyMaxCloud) {
      hoursOfSun += 1;
    }

    const freezing: boolean | null = t < 0 ? true : t > 0 ? false : prevFreezing;
    if (freezing === true) {
      currentFreezeRun += 1;
      longestFreezeRunHours = Math.max(longestFreezeRunHours, currentFreezeRun);
    } else if (freezing === false) {
      currentFreezeRun = 0;
    }
    if (prevFreezing === true && freezing === false) freezeThawCycles += 1;
    if (freezing !== null) prevFreezing = freezing;

    if (typeof h.startMs === 'number') {
      const night = nightIndex(h.startMs);
      const prev = nightMin.get(night);
      nightMin.set(night, prev === undefined ? t : Math.min(prev, t));
    } else {
      allTimed = false;
    }
  }

  let nightsBelowFreezing: number | null = null;
  if (allTimed) {
    nightsBelowFreezing = 0;
    for (const min of nightMin.values()) if (min < 0) nightsBelowFreezing += 1;
  }

  return {
    hours: hourly.length,
    peakTempC,
    minTempC,
    hoursNearFreezing,
    hoursAboveFreezing,
    nightsBelowFreezing,
    hoursOfSun,
    totalPrecipMm,
    rainMm,
    snowfallCm,
    maxSnowDepthM,
    maxWindKph,
    maxWindGustKph,
    windRunKm,
    freezingDegreeHours,
    thawDegreeHours,
    insolationWhM2,
    longestFreezeRunHours,
    freezeThawCycles,
  };
}
