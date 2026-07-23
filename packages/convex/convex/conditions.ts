/**
 * Report conditions auto-fill from Open-Meteo (Phase 10 / §7a / D19). Populates the stubbed `openmeteo`
 * condition source with the weather **at the skate time** (a point-in-time reading — distinct from the
 * "since" summary that feeds the strip + decay).
 *
 * A mutation can't fetch, so `reports.create` **schedules** this action post-insert (the isochrones
 * pattern) — it's eventually-consistent: the report inserts immediately and conditions land a beat later.
 * **User-entered values always win:** the action only fills when the report has no conditions at all, and
 * the store mutation re-checks before writing, so a user's `source: 'user'` conditions are never clobbered.
 * **D3:** observed weather, never a safety assertion.
 */

import { conditionsFromHour, PRECIP_TYPES, SKY_CONDITIONS } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { nearestSamplePoint } from './hazardWeather';
import { literals } from './lib/validators';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_PAST_DAYS = 92;
const MAX_HOUR_GAP_MS = 3 * HOUR_MS; // if the nearest hour is further than this from the skate time, bail

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CONDITIONS_VARS = [
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'rain',
  'snowfall',
] as const;

interface OpenMeteoResponse {
  hourly?: { time?: number[]; [key: string]: (number | null)[] | number[] | undefined };
}

/** Fetch the weather at `atMs` for a point → the observed conditions, or null on failure / no near hour. */
async function fetchConditionsAt(lat: number, lng: number, atMs: number, nowMs: number) {
  const pastDays = Math.min(MAX_PAST_DAYS, Math.max(1, Math.ceil((nowMs - atMs) / DAY_MS) + 1));
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: CONDITIONS_VARS.join(','),
    past_days: String(pastDays),
    forecast_days: '1',
    timezone: 'auto',
    timeformat: 'unixtime',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  });

  let json: OpenMeteoResponse;
  try {
    const res = await fetch(`${OPEN_METEO_URL}?${params.toString()}`);
    if (!res.ok) {
      console.warn(`Open-Meteo conditions request failed: ${res.status}`);
      return null;
    }
    json = (await res.json()) as OpenMeteoResponse;
  } catch (err) {
    console.warn('Open-Meteo conditions request threw', err);
    return null;
  }

  const time = json.hourly?.time;
  if (!Array.isArray(time) || time.length === 0) return null;
  const col = (k: string) => json.hourly?.[k] as (number | null)[] | undefined;

  // The hour closest to the skate time.
  let bestIdx = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < time.length; i++) {
    const ts = time[i];
    if (typeof ts !== 'number') continue;
    const gap = Math.abs(ts * 1000 - atMs);
    if (gap < bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestGap > MAX_HOUR_GAP_MS) return null;

  const temp = col('temperature_2m')?.[bestIdx];
  const wind = col('wind_speed_10m')?.[bestIdx];
  if (typeof temp !== 'number' || typeof wind !== 'number') return null;
  const dir = col('wind_direction_10m')?.[bestIdx];
  const cloud = col('cloud_cover')?.[bestIdx];
  const rain = col('rain')?.[bestIdx];
  const snow = col('snowfall')?.[bestIdx];

  return conditionsFromHour({
    temperatureC: temp,
    windSpeedKph: wind,
    ...(typeof dir === 'number' ? { windDirDeg: dir } : {}),
    ...(typeof cloud === 'number' ? { cloudCoverPct: cloud } : {}),
    ...(typeof rain === 'number' ? { rainMm: rain } : {}),
    ...(typeof snow === 'number' ? { snowfallCm: snow } : {}),
  });
}

/** Report info the auto-fill needs, resolved to the body's nearest sample point. Null when unusable. */
export const getReportForConditions = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId);
    if (!report) return null;
    if (report.conditions !== undefined) return { hasConditions: true as const };
    const body = await ctx.db.get(report.waterBodyId);
    if (!body) return null;
    const point = nearestSamplePoint(body, report.point);
    return {
      hasConditions: false as const,
      skateEndTime: report.skateEndTime,
      lat: point.lat,
      lng: point.lng,
    };
  },
});

/** Store auto-filled conditions — only if the report still has none (a user entry always wins). */
export const storeReportConditions = internalMutation({
  args: {
    reportId: v.id('reports'),
    conditions: v.object({
      airTempC: v.number(),
      windSpeedKph: v.number(),
      windDir: v.string(),
      sky: literals(SKY_CONDITIONS),
      precip: literals(PRECIP_TYPES),
    }),
  },
  handler: async (ctx, { reportId, conditions }) => {
    const report = await ctx.db.get(reportId);
    if (!report || report.conditions !== undefined) return; // user (or a prior fill) already set it
    await ctx.db.patch(reportId, { conditions: { ...conditions, source: 'openmeteo' } });
  },
});

/** Auto-fill a report's conditions from the weather at its skate time. Scheduled from `reports.create`. */
export const autofillConditions = internalAction({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const info = await ctx.runQuery(internal.conditions.getReportForConditions, { reportId });
    if (!info || info.hasConditions) return;
    const conditions = await fetchConditionsAt(info.lat, info.lng, info.skateEndTime, Date.now());
    if (!conditions) return; // fail open — leave conditions blank rather than guess
    await ctx.runMutation(internal.conditions.storeReportConditions, { reportId, conditions });
  },
});
