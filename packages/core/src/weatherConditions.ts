/**
 * Map a single hour of Open-Meteo data to the report's **observed `conditions`** (Phase 10 / §7a). This
 * is *point-in-time* weather at the skate time — distinct from the "since" summary (`weather.ts`) that
 * feeds the strip + decay. Pure + tested; the Convex `conditions` action does the fetch and calls these.
 *
 * **D3:** this is *observed weather*, never a safety assertion. It pre-fills fields the reporter left
 * blank (`source: 'openmeteo'`); a user-entered value always wins.
 */

import type { PrecipType, SkyCondition } from './types';

/** The observed conditions we can derive from one hour of weather. */
export interface ObservedConditions {
  airTempC: number;
  windSpeedKph: number;
  /** 8-point compass, e.g. "N", "SW". */
  windDir: string;
  sky: SkyCondition;
  precip: PrecipType;
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Meteorological wind direction (degrees the wind blows *from*) → 8-point compass. */
export function windDirToCompass(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  return COMPASS_8[Math.round(normalized / 45) % 8] as string;
}

/**
 * Sky state from cloud cover %, or `precip` when it's actively precipitating (the `SKY_CONDITIONS` set
 * treats "precipitating" as its own state). Bands: ≤25 clear · ≤75 partly cloudy · >75 overcast.
 */
export function cloudCoverToSky(cloudCoverPct: number, precipitatingMm: number): SkyCondition {
  if (precipitatingMm > 0) return 'precip';
  if (cloudCoverPct <= 25) return 'clear';
  if (cloudCoverPct <= 75) return 'partly_cloudy';
  return 'overcast';
}

/** Precipitation type from the rain/snow split (mixed ⇒ sleet). Rain in mm, snowfall in cm. */
export function precipTypeFrom(rainMm: number, snowfallCm: number): PrecipType {
  const hasRain = rainMm > 0;
  const hasSnow = snowfallCm > 0;
  if (hasRain && hasSnow) return 'sleet';
  if (hasSnow) return 'snow';
  if (hasRain) return 'rain';
  return 'none';
}

export interface ConditionsHour {
  temperatureC: number;
  windSpeedKph: number;
  windDirDeg?: number;
  cloudCoverPct?: number;
  rainMm?: number;
  snowfallCm?: number;
}

/** Build the observed conditions from one mapped hour of weather. */
export function conditionsFromHour(h: ConditionsHour): ObservedConditions {
  const rainMm = h.rainMm ?? 0;
  const snowfallCm = h.snowfallCm ?? 0;
  return {
    airTempC: h.temperatureC,
    windSpeedKph: h.windSpeedKph,
    windDir: windDirToCompass(h.windDirDeg ?? 0),
    sky: cloudCoverToSky(h.cloudCoverPct ?? 0, rainMm + snowfallCm),
    precip: precipTypeFrom(rainMm, snowfallCm),
  };
}
