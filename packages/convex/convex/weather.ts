/**
 * Open-Meteo "weather-since" fetch + cache (Phase 10 / D19 / D56). The one new piece of infra the strip
 * and the decay model both ride on.
 *
 * **Forecast API with `past_days`, never the archive.** The historical archive is ERA5-backed and lags
 * ~5 days, but every window here is *recent* (a report from yesterday, a hazard's last few days). The
 * forecast endpoint's `past_days` (≤ 92) reaches right up to `now`, and 92 days comfortably covers the
 * longest window any consumer needs (the report strip's ≤ 14-day cap and the hazard/decay 7-day
 * lookback). So one endpoint serves both; the archive is never worth a second integration. See
 * `plans/phase-10-weather.md` §2.
 *
 * Like `isochrones.ts`, the outbound HTTP call lives in an **action** (no direct db access): it reads the
 * cache via an internal query and writes it via an internal mutation. The strip calls
 * `getWeatherSinceForBody` on drawer-open — a query can't fetch, so a read-only strip would silently never
 * fill on the hazard-free bodies the decay cron (§6) skips. `resolveWeatherSince` is the shared resolver
 * the cron + conditions auto-fill reuse.
 */

import {
  HAZARD_WEATHER_LOOKBACK_DAYS,
  type HourlyWeather,
  summarizeWeatherSince,
  type WeatherSinceSummary,
} from '@skating/core';
import type { Infer } from 'convex/values';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import { action, internalMutation, internalQuery } from './_generated/server';
import { nearestSamplePoint } from './lib/sampling';
import { latLng, weatherSinceSummary } from './lib/validators';

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
  // Open-Meteo anchors `past_days` to the REAL current date, so size it from `Date.now()`, never from the
  // window end `nowMs` (which a caller may set in the past — e.g. the contradiction settle passes the older
  // report's skate time). Sizing from `nowMs` would make the returned series start at `realNow − (nowMs −
  // windowStart)`, silently dropping the earliest `(realNow − nowMs)` of the intended window and biasing
  // `weatherExplainsIceChange` toward under-firing (over-flagging honest "the ice changed" reports). The
  // window filter below still trims the top at `nowMs`. `Date.now() ≥ nowMs` always, so this only ever
  // widens the fetch enough to cover the whole window.
  const pastDays = Math.min(
    MAX_PAST_DAYS,
    Math.max(1, Math.ceil((Date.now() - windowStartMs) / DAY_MS)),
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
  // A 200 that yields zero usable hours (Open-Meteo's most recent hours can lag a live window) is a soft
  // failure, not a real "no weather" result — the sub-hour-window case is already handled upstream before
  // we ever fetch. Return `null` so the caller fails open and DOESN'T cache it, and the next drawer-open /
  // cron tick retries instead of serving a blank strip for the rest of the hour bucket.
  return out.length > 0 ? out : null;
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

/**
 * The weather sample point for a body, resolved the **same way the decay cron does** (§5) so the strip and
 * the decay always read the same point → the same cache entry. `near` (a report's put-in or a hazard's
 * center) picks the nearest of `weatherSamplePoints`; absent, it falls back to the centroid. In v1 (no
 * sample points set) every path collapses to the centroid, but wiring `near` keeps strip↔decay consistent
 * the moment a giant gets multi-cell sample points.
 */
export const getBodySamplePoint = internalQuery({
  args: { waterBodyId: v.id('waterBodies'), near: v.optional(latLng) },
  handler: async (ctx, { waterBodyId, near }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return null;
    return nearestSamplePoint(body, near ?? body.centroid);
  },
});

/**
 * Resolve the weather-since summary for a point + window, cache-first. Shared by the strip action, the
 * decay cron (§6), and the bounty/contradiction gates (§7). Returns:
 *   - a summary (possibly the empty one) when the window is valid — cached for the hour bucket;
 *   - the **empty** summary, uncached, when the window isn't a full hour yet (a real "no weather" result);
 *   - **`null`** when the fetch itself failed (network/HTTP/empty-200) — a distinct "couldn't tell" that
 *     callers fail open on WITHOUT caching, so the next call retries. The decay cron relies on this to
 *     avoid overwriting a good multiplier (and blocking retry) on a transient blip.
 */
export async function resolveWeatherSince(
  ctx: ActionCtx,
  lat: number,
  lng: number,
  startMs: number,
  nowMs: number,
): Promise<WeatherSinceSummary | null> {
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
  if (hourly === null) return null; // fetch failed — don't cache, let the caller retry next time

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
 * Public: the weather-since summary for a body's sample point. Called by the strip on drawer-open (web +
 * mobile). `near` resolves the hazard/report's nearest sample point so the strip matches the decay (§5).
 *
 * Two window modes, both ending at the server's `now`:
 *   - **report strip:** pass `startMs` (the skate time — a fixed past instant).
 *   - **hazard strip:** pass `sinceLastConfirmedAt`; the window start is derived **server-side** as
 *     `max(lastConfirmedAt, now − lookback)` — the SAME expression the decay cron uses (§6). Deriving it
 *     here (not on the client) keeps the strip and the decay on one clock, so a client-clock skew can't
 *     bucket the strip into a different `weatherCache` entry than the stored multiplier (§3 consistency).
 *
 * Returns the empty summary when the body is unavailable, no window is given, or the fetch fails (`null`) —
 * a blank strip, uncached, retried on the next open.
 */
export const getWeatherSinceForBody = action({
  args: {
    waterBodyId: v.id('waterBodies'),
    startMs: v.optional(v.number()),
    sinceLastConfirmedAt: v.optional(v.number()),
    near: v.optional(latLng),
  },
  handler: async (
    ctx,
    { waterBodyId, startMs, sinceLastConfirmedAt, near },
  ): Promise<WeatherSinceSummary> => {
    const now = Date.now();
    const windowStart =
      sinceLastConfirmedAt !== undefined
        ? Math.max(sinceLastConfirmedAt, now - HAZARD_WEATHER_LOOKBACK_DAYS * DAY_MS)
        : startMs;
    if (windowStart === undefined) return EMPTY_SUMMARY;
    const point = await ctx.runQuery(internal.weather.getBodySamplePoint, { waterBodyId, near });
    if (!point) return EMPTY_SUMMARY;
    return (
      (await resolveWeatherSince(ctx, point.lat, point.lng, windowStart, now)) ?? EMPTY_SUMMARY
    );
  },
});
