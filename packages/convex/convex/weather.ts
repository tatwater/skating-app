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
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { action, internalMutation, internalQuery } from './_generated/server';
import { hazardCenter, nearestSamplePoint } from './lib/sampling';
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
 * Resolve a strip's weather window from a **server-validated entity**, never a client-supplied timestamp
 * (§3 resource guard). The strip fetches by `reportId` or `hazardId`; the server reads the entity's real
 * skate time / last-confirmed time and its body's sample point, so a caller can't mint arbitrary windows
 * to amplify Open-Meteo fetches + `weatherCache` inserts — the reachable window set is exactly the reports
 * / hazards that actually exist and are user-visible (Convex ids are unguessable, so an account only ever
 * reaches what it can already see). Sample point resolved the **same way the decay cron does** (§5) so the
 * strip and decay share one cache entry.
 *
 * Window start matches the decay cron / `reportStripState` exactly: a report uses its skate time; a hazard
 * uses `max(lastConfirmedAt, now − lookback)`. Returns `null` (⇒ a blank strip) when the entity is missing,
 * not user-visible, or its body is gone.
 */
export const resolveStripAnchor = internalQuery({
  args: {
    reportId: v.optional(v.id('reports')),
    hazardId: v.optional(v.id('hazards')),
  },
  handler: async (ctx, { reportId, hazardId }) => {
    const now = Date.now();
    let waterBodyId: Id<'waterBodies'>;
    let startMs: number;
    let near: { lat: number; lng: number };
    if (reportId !== undefined) {
      const report = await ctx.db.get(reportId);
      if (!report) return null;
      if (report.moderationStatus !== 'visible') return null;
      waterBodyId = report.waterBodyId;
      startMs = report.skateEndTime;
      near = report.point;
    } else if (hazardId !== undefined) {
      const hazard = await ctx.db.get(hazardId);
      if (!hazard) return null;
      // Same visibility gate the hazard drawer uses — a moderator-hidden or feature-promoted pin has no
      // strip (it doesn't render), so it can't drive a fetch either.
      if (hazard.moderationStatus !== 'visible' || hazard.promotedToFeatureId !== undefined) {
        return null;
      }
      waterBodyId = hazard.waterBodyId;
      startMs = Math.max(hazard.lastConfirmedAt, now - HAZARD_WEATHER_LOOKBACK_DAYS * DAY_MS);
      near = hazardCenter(hazard);
    } else {
      return null;
    }
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return null;
    const point = nearestSamplePoint(body, near);
    return { lat: point.lat, lng: point.lng, startMs };
  },
});

/**
 * Hard ceiling on how far back a weather window may start. Every legitimate window sits far inside it —
 * the report strip renders only for reports 6h–**14d** old (`reportStripState`), the hazard/decay window
 * is ≤7d, the bounty gate ≤6d — so clamping here never clips a real strip. What it *does* cap is the
 * number of distinct hourly cache keys any one caller can mint by pushing `startMs` into the arbitrary
 * past: without it, an (even authenticated) client could enumerate unbounded windows for a discoverable
 * body, each triggering an Open-Meteo fetch + a persistent `weatherCache` insert until real strips/decay
 * refreshes are throttled. Applied at the shared resolver so the strip, decay cron and bounty gate all
 * clamp identically → the same window→key (§5 consistency preserved).
 */
export const WEATHER_WINDOW_MAX_LOOKBACK_MS = 30 * DAY_MS;

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
  const windowStartMs = hourBucket(Math.max(startMs, nowMs - WEATHER_WINDOW_MAX_LOOKBACK_MS));
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
 * Public: the weather-since summary for the strip on a **report** or **hazard** drawer (web + mobile),
 * fetched on drawer-open. The caller identifies the entity by **id** — `reportId` for a report strip,
 * `hazardId` for a hazard strip — and the server derives the body, sample point and window start from that
 * entity (`resolveStripAnchor`): a report uses its skate time, a hazard its `max(lastConfirmedAt, now −
 * lookback)` (the decay cron's window, §5).
 *
 * Deriving the window from **server state instead of a client timestamp** is the resource guard (§3): with
 * a signed-in caller *and* server-derived windows, neither an anonymous nor an authenticated account can
 * enumerate arbitrary windows for a discoverable body to amplify Open-Meteo fetches + `weatherCache`
 * inserts — the reachable set is exactly the reports/hazards that exist and are visible (unguessable ids).
 * Returns the empty summary (a blank strip) when unauthenticated, the entity is gone/hidden, the window
 * isn't a full hour yet, or the fetch fails.
 */
export const getWeatherSinceForBody = action({
  args: {
    reportId: v.optional(v.id('reports')),
    hazardId: v.optional(v.id('hazards')),
  },
  handler: async (ctx, { reportId, hazardId }): Promise<WeatherSinceSummary> => {
    if (!(await ctx.auth.getUserIdentity())) return EMPTY_SUMMARY;
    const anchor = await ctx.runQuery(internal.weather.resolveStripAnchor, { reportId, hazardId });
    if (!anchor) return EMPTY_SUMMARY;
    return (
      (await resolveWeatherSince(ctx, anchor.lat, anchor.lng, anchor.startMs, Date.now())) ??
      EMPTY_SUMMARY
    );
  },
});
