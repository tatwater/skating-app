/**
 * Open-Meteo "weather-since" fetch + cache (Phase 10 / D19 / D56). The one new piece of infra the strip
 * and the decay model both ride on.
 *
 * **Forecast API with `past_days`, never the archive.** The historical archive is ERA5-backed and lags
 * ~5 days, but every window here is *recent* (a report from yesterday, a hazard's last few days). The
 * forecast endpoint's `past_days` (≤ 92) reaches right up to `now`, and 92 days comfortably covers the
 * longest window any consumer needs (the decay model's ≤ 45-day since-`lastConfirmedAt` span). So one
 * endpoint serves both; the archive is never worth a second integration. See `plans/phase-10-weather.md` §2.
 *
 * Like `isochrones.ts`, the outbound HTTP call lives in an **action** (no direct db access): it reads the
 * cache via an internal query and writes it via an internal mutation. The strip calls
 * `getWeatherSinceForBody` on drawer-open — a query can't fetch, so a read-only strip would silently never
 * fill on the hazard-free bodies the decay cron (§6) skips. `resolveWeatherSince` is the shared resolver
 * the cron + conditions auto-fill reuse.
 */

import { type HourlyWeather, summarizeWeatherSince, type WeatherSinceSummary } from '@skating/core';
import type { Infer } from 'convex/values';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import { action, internalMutation, internalQuery } from './_generated/server';
import { weatherSinceSummary } from './lib/validators';

// The validator and the core type must stay structurally identical — assert it at compile time so drift
// in either is a build error, not a silent DB/runtime mismatch.
type SummaryFromValidator = Infer<typeof weatherSinceSummary>;
const _assertSummaryForward: WeatherSinceSummary = null as unknown as SummaryFromValidator;
const _assertSummaryReverse: SummaryFromValidator = null as unknown as WeatherSinceSummary;
void _assertSummaryForward;
void _assertSummaryReverse;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_PAST_DAYS = 92; // Open-Meteo forecast `past_days` ceiling

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY_VARS = [
  'temperature_2m',
  'precipitation',
  'rain',
  'snowfall',
  'snow_depth',
  'wind_speed_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'sunshine_duration',
  'shortwave_radiation',
] as const;

function hourBucket(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Cache key for a sample point — rounded to ~110 m so a body's repeated queries share one entry. */
export function samplePointKeyFor(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

const EMPTY_SUMMARY = summarizeWeatherSince([]);

/** Open-Meteo's hourly response shape (only the fields we request; each var array is number-or-null). */
interface OpenMeteoResponse {
  utc_offset_seconds?: number;
  hourly?: {
    time?: number[]; // unix seconds (UTC), because we request `timeformat=unixtime`
    [key: string]: (number | null)[] | number[] | undefined;
  };
}

/** A required numeric field defaults to 0 when Open-Meteo returns null for the hour. */
function num(x: number | null | undefined): number {
  return typeof x === 'number' ? x : 0;
}

/**
 * Fetch the hourly series for [windowStartMs, nowMs] at a point, mapped to `HourlyWeather`. Returns `null`
 * on any failure (the caller then fails open — empty summary, no cache write, retried next drawer-open).
 * `startMs` (local, for night-bucketing) = unix + `utc_offset_seconds`; window filtering uses absolute UTC.
 */
async function fetchOpenMeteoHourly(
  lat: number,
  lng: number,
  windowStartMs: number,
  nowMs: number,
): Promise<HourlyWeather[] | null> {
  const pastDays = Math.min(
    MAX_PAST_DAYS,
    Math.max(1, Math.ceil((nowMs - windowStartMs) / DAY_MS)),
  );
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: HOURLY_VARS.join(','),
    past_days: String(pastDays),
    forecast_days: '1', // include today's already-elapsed hours up to now
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
      console.warn(`Open-Meteo request failed: ${res.status}`);
      return null;
    }
    json = (await res.json()) as OpenMeteoResponse;
  } catch (err) {
    console.warn('Open-Meteo request threw', err);
    return null;
  }

  const time = json.hourly?.time;
  if (!Array.isArray(time)) return null;

  const offsetMs = (json.utc_offset_seconds ?? 0) * 1000;
  const col = (k: string) => json.hourly?.[k] as (number | null)[] | undefined;
  const temp = col('temperature_2m');
  const precip = col('precipitation');
  const rain = col('rain');
  const snowfall = col('snowfall');
  const snowDepth = col('snow_depth');
  const wind = col('wind_speed_10m');
  const gust = col('wind_gusts_10m');
  const cloud = col('cloud_cover');
  const sunshine = col('sunshine_duration');
  const shortwave = col('shortwave_radiation');

  const out: HourlyWeather[] = [];
  for (let i = 0; i < time.length; i++) {
    const ts = time[i];
    if (typeof ts !== 'number') continue;
    const tsMs = ts * 1000;
    if (tsMs < windowStartMs || tsMs > nowMs) continue; // window filter (absolute UTC)
    const t = temp?.[i];
    if (typeof t !== 'number') continue; // no temperature ⇒ unusable hour

    const h: HourlyWeather = {
      startMs: tsMs + offsetMs, // local ms → correct night bucketing
      temperatureC: t,
      precipitationMm: num(precip?.[i]),
      windSpeedKph: num(wind?.[i]),
    };
    const rainV = rain?.[i];
    if (typeof rainV === 'number') h.rainMm = rainV;
    const snowfallV = snowfall?.[i];
    if (typeof snowfallV === 'number') h.snowfallCm = snowfallV;
    const snowDepthV = snowDepth?.[i];
    if (typeof snowDepthV === 'number') h.snowDepthM = snowDepthV;
    const gustV = gust?.[i];
    if (typeof gustV === 'number') h.windGustKph = gustV;
    const cloudV = cloud?.[i];
    if (typeof cloudV === 'number') h.cloudCoverPct = cloudV;
    const sunshineV = sunshine?.[i];
    if (typeof sunshineV === 'number') h.sunshineSeconds = sunshineV;
    const shortwaveV = shortwave?.[i];
    if (typeof shortwaveV === 'number') h.shortwaveWm2 = shortwaveV;
    out.push(h);
  }
  return out;
}

/** Read a cached summary for an exact (key, window) triple, or null on miss. */
export const readWeatherCache = internalQuery({
  args: {
    samplePointKey: v.string(),
    windowStartMs: v.number(),
    windowEndBucketMs: v.number(),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query('weatherCache')
      .withIndex('by_key', (q) =>
        q
          .eq('samplePointKey', a.samplePointKey)
          .eq('windowStartMs', a.windowStartMs)
          .eq('windowEndBucketMs', a.windowEndBucketMs),
      )
      .first();
    return row?.summary ?? null;
  },
});

/** Upsert a cached summary (idempotent on the key triple). */
export const writeWeatherCache = internalMutation({
  args: {
    samplePointKey: v.string(),
    windowStartMs: v.number(),
    windowEndBucketMs: v.number(),
    summary: weatherSinceSummary,
    fetchedAt: v.number(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query('weatherCache')
      .withIndex('by_key', (q) =>
        q
          .eq('samplePointKey', a.samplePointKey)
          .eq('windowStartMs', a.windowStartMs)
          .eq('windowEndBucketMs', a.windowEndBucketMs),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { summary: a.summary, fetchedAt: a.fetchedAt });
    } else {
      await ctx.db.insert('weatherCache', a);
    }
  },
});

/** The sample point for a body — its centroid in v1 (§5 makes this the nearest of `weatherSamplePoints`). */
export const getBodySamplePoint = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return null;
    return body.centroid;
  },
});

/**
 * Resolve the weather-since summary for a point + window, cache-first. Shared by the strip action, the
 * decay cron (§6), and conditions auto-fill (§7). Fails open: a fetch failure returns the empty summary
 * (strip shows nothing, decay multiplier stays 1) and is **not** cached, so the next call retries.
 */
export async function resolveWeatherSince(
  ctx: ActionCtx,
  lat: number,
  lng: number,
  startMs: number,
  nowMs: number,
): Promise<WeatherSinceSummary> {
  const windowStartMs = hourBucket(startMs);
  const windowEndBucketMs = hourBucket(nowMs);
  if (windowStartMs >= windowEndBucketMs) return EMPTY_SUMMARY; // no full hour of window yet

  const samplePointKey = samplePointKeyFor(lat, lng);
  const cached = await ctx.runQuery(internal.weather.readWeatherCache, {
    samplePointKey,
    windowStartMs,
    windowEndBucketMs,
  });
  if (cached) return cached;

  const hourly = await fetchOpenMeteoHourly(lat, lng, windowStartMs, nowMs);
  if (hourly === null) return EMPTY_SUMMARY; // fail open, don't cache

  const summary = summarizeWeatherSince(hourly);
  await ctx.runMutation(internal.weather.writeWeatherCache, {
    samplePointKey,
    windowStartMs,
    windowEndBucketMs,
    summary,
    fetchedAt: nowMs,
  });
  return summary;
}

/**
 * Public: the weather since `startMs` for a body's sample point. Called by the strip on drawer-open
 * (web + mobile). Returns the empty summary when the body/centroid is unavailable.
 */
export const getWeatherSinceForBody = action({
  args: { waterBodyId: v.id('waterBodies'), startMs: v.number() },
  handler: async (ctx, { waterBodyId, startMs }): Promise<WeatherSinceSummary> => {
    const point = await ctx.runQuery(internal.weather.getBodySamplePoint, { waterBodyId });
    if (!point) return EMPTY_SUMMARY;
    return resolveWeatherSince(ctx, point.lat, point.lng, startMs, Date.now());
  },
});
