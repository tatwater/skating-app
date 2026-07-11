/**
 * "Weather since report" reducer (D19). Purely **descriptive** — it summarizes what
 * the weather has *done* over [skate time → now] to support the skater's own
 * judgment. It asserts nothing about current ice safety (D3).
 *
 * Input is Open-Meteo-style hourly data (see the mapping in `04-integrations.md`).
 */

export interface HourlyWeather {
  temperatureC: number
  precipitationMm: number
  windSpeedKph: number
  /** Open-Meteo `sunshine_duration` (seconds of sun in the hour), if available. */
  sunshineSeconds?: number
  /** Fallback when `sunshineSeconds` is absent: cloud cover % for the hour. */
  cloudCoverPct?: number
}

export interface WeatherSinceSummary {
  hours: number
  /** null when there is no data. */
  peakTempC: number | null
  hoursNearFreezing: number
  hoursAboveFreezing: number
  hoursOfSun: number
  totalPrecipMm: number
  /** null when there is no data. */
  maxWindKph: number | null
}

export interface WeatherSinceOptions {
  /** Lower bound of the "near freezing" band (°C). Default -2. */
  freezingBandLowC?: number
  /** Upper bound of the "near freezing" band (°C). Default +2. */
  freezingBandHighC?: number
  /** Cloud cover ≤ this % counts as a "sun" hour when `sunshineSeconds` is absent. Default 20. */
  sunnyCloudCoverMaxPct?: number
}

/**
 * Reduce hourly weather into the factual strip shown on aging reports (D19):
 * peak temp, hours near/above freezing, hours of sun, total precip, max wind.
 */
export function summarizeWeatherSince(
  hourly: readonly HourlyWeather[],
  options: WeatherSinceOptions = {},
): WeatherSinceSummary {
  const lowBand = options.freezingBandLowC ?? -2
  const highBand = options.freezingBandHighC ?? 2
  const sunnyMaxCloud = options.sunnyCloudCoverMaxPct ?? 20

  let peakTempC: number | null = null
  let maxWindKph: number | null = null
  let hoursNearFreezing = 0
  let hoursAboveFreezing = 0
  let hoursOfSun = 0
  let totalPrecipMm = 0

  for (const h of hourly) {
    peakTempC = peakTempC === null ? h.temperatureC : Math.max(peakTempC, h.temperatureC)
    maxWindKph = maxWindKph === null ? h.windSpeedKph : Math.max(maxWindKph, h.windSpeedKph)

    if (h.temperatureC >= lowBand && h.temperatureC <= highBand) hoursNearFreezing += 1
    if (h.temperatureC > 0) hoursAboveFreezing += 1

    totalPrecipMm += h.precipitationMm

    if (h.sunshineSeconds !== undefined) {
      hoursOfSun += h.sunshineSeconds / 3600
    } else if (h.cloudCoverPct !== undefined && h.cloudCoverPct <= sunnyMaxCloud) {
      hoursOfSun += 1
    }
  }

  return {
    hours: hourly.length,
    peakTempC,
    hoursNearFreezing,
    hoursAboveFreezing,
    hoursOfSun,
    totalPrecipMm,
    maxWindKph,
  }
}
