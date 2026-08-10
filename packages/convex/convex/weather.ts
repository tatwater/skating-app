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
  type ForecastSummary,
  HAZARD_WEATHER_LOOKBACK_DAYS,
  type HourlyWeather,
  summarizeForecast,
  summarizeWeatherSince,
  type WeatherSinceSummary,
} from '@skating/core';
import type { Infer } from 'convex/values';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { action, internalMutation, internalQuery } from './_generated/server';
import { resolveSurvivor } from './lib/bodies';
import { defaultSampleAnchor, hazardCenter, nearestSamplePoint } from './lib/sampling';
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
 * The split return: hours at or before `nowMs`, and hours after it.
 *
 * **The two arrays are the D74 wall, and they are separate on purpose (N6c B5b).** `past` is what
 * every calculation reads — the decay cron, the bounty gate, the contradiction settle — and its
 * reproducibility depends on it containing only observations. `forecast` is render-only. Returning
 * one array with a timestamp filter each caller must remember to apply would put that guarantee in
 * every call site instead of in the type, and the failure mode is silent: a hazard whose confidence
 * decayed on a forecast that did not happen cannot be re-derived afterwards, and nothing would say so.
 */
interface OpenMeteoHours {
  past: HourlyWeather[];
  forecast: HourlyWeather[];
  /**
   * `utc_offset_seconds × 1000` — the shift already baked into every `startMs` above.
   *
   * Returned rather than recovered downstream because the forecast horizon is applied against these
   * local-shifted timestamps, and this region sits 4–5 hours off UTC: comparing them to a UTC `now`
   * slides the whole strip by most of its own length. Deriving the offset from the first hour's
   * timestamp instead would work until the hour Open-Meteo returns a gap at the front, and then it
   * would be wrong by exactly one hour with nothing to show for it.
   */
  utcOffsetMs: number;
}

/**
 * Fetch the hourly series around `nowMs` at a point, mapped to `HourlyWeather`. Returns `null`
 * on any failure (the caller then fails open — empty summary, no cache write, retried next drawer-open).
 * `startMs` (local, for night-bucketing) = unix + `utc_offset_seconds`; window filtering uses absolute UTC.
 *
 * Past hours span [windowStartMs, nowMs]; forward hours span (nowMs, +∞), trimmed to the horizon by
 * `summarizeForecast` rather than here, so this stays a transport function with no policy in it.
 */
async function fetchOpenMeteoHourly(
  lat: number,
  lng: number,
  windowStartMs: number,
  nowMs: number,
): Promise<OpenMeteoHours | null> {
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
    // **Two days, not one, and this is the entire cost of B5b.** One day was already here so the
    // series included today's elapsed hours up to now; the forward hours arrived in that same
    // response and were thrown away by the window filter. Asking for two means the 12-hour horizon
    // survives a day boundary, so an evening skater still sees tomorrow morning. Same endpoint, same
    // variables, same attribution, no new provider and no new quota — D74 holds untouched, because
    // this is still Open-Meteo and there is no second opinion being blended.
    forecast_days: '2',
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
  const forecast: HourlyWeather[] = [];
  for (let i = 0; i < time.length; i++) {
    const ts = time[i];
    if (typeof ts !== 'number') continue;
    const tsMs = ts * 1000;
    // Below the window start is neither past-we-asked-for nor future — drop it outright.
    if (tsMs < windowStartMs) continue;
    const isForecast = tsMs > nowMs; // window filter (absolute UTC); above `nowMs` is the forward half
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
    if (isForecast) forecast.push(h);
    else out.push(h);
  }
  // A 200 that yields zero usable hours (Open-Meteo's most recent hours can lag a live window) is a soft
  // failure, not a real "no weather" result — the sub-hour-window case is already handled upstream before
  // we ever fetch. Return `null` so the caller fails open and DOESN'T cache it, and the next drawer-open /
  // cron tick retries instead of serving a blank strip for the rest of the hour bucket.
  //
  // **Emptiness is judged per half by the caller, not here.** This transport says "nothing usable
  // came back at all"; whether an empty `past` is a soft failure is `resolveWeatherSince`'s rule and
  // whether an empty `forecast` is one is `resolveForecast`'s. Collapsing them here would let a
  // response carrying forward hours but no past ones look like a success to the decay path, which
  // would then cache an empty summary — the precise failure this comment was written about.
  return out.length > 0 || forecast.length > 0
    ? { past: out, forecast, utcOffsetMs: offsetMs }
    : null;
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
      // Same visibility gate the hazard drawer uses — a moderator-hidden pin has no strip (it doesn't
      // render), so it can't drive a fetch either. **Supersession is no longer part of that gate**
      // (D53 amendment, N5c): a promoted pin still renders, still opens, and still shows how the
      // weather has moved since it was last confirmed, because it is still a sighting on a date.
      if (hazard.moderationStatus !== 'visible') return null;
      waterBodyId = hazard.waterBodyId;
      startMs = Math.max(hazard.lastConfirmedAt, now - HAZARD_WEATHER_LOOKBACK_DAYS * DAY_MS);
      near = hazardCenter(hazard);
    } else {
      return null;
    }
    // `resolveSurvivor` for the same reason `weatherAlerts.listForBody` uses it: every other
    // per-body read in the codebase follows a merge, and a sample point taken from a tombstone's row
    // is a forecast for whichever duplicate happened to lose.
    const body = await resolveSurvivor(ctx, waterBodyId);
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
  // **`.past` only, and never `.forecast` (D74).** Everything downstream of this line is a
  // calculation whose result must be re-derivable from what actually happened — the decay
  // multiplier, the bounty gate, the contradiction settle. A forward hour reaching
  // `summarizeWeatherSince` would make all three unreproducible after the fact and nothing would
  // report it. The soft-failure rule below is unchanged: an empty past half is still "couldn't
  // tell", regardless of how many forward hours came with it.
  if (hourly.past.length === 0) return null;

  const summary = summarizeWeatherSince(hourly.past);
  await ctx.runMutation(internal.weather.writeWeatherCache, {
    samplePointKey,
    windowStartMs,
    windowEndBucketMs,
    summary,
    fetchedAt: nowMs,
  });
  return summary;
}

/** Read a cached forecast for a sample point + hour bucket, or null on miss. */
export const readForecastCache = internalQuery({
  args: { samplePointKey: v.string(), forecastBucketMs: v.number() },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query('weatherForecastCache')
      .withIndex('by_key', (q) =>
        q.eq('samplePointKey', a.samplePointKey).eq('forecastBucketMs', a.forecastBucketMs),
      )
      .first();
    if (!row) return null;
    const summary: ForecastSummary = { hours: row.hours };
    if (row.precipStartsMs !== undefined) summary.precipStartsMs = row.precipStartsMs;
    if (row.precipIsSnow !== undefined) summary.precipIsSnow = row.precipIsSnow;
    if (row.minTemperatureC !== undefined) summary.minTemperatureC = row.minTemperatureC;
    if (row.maxTemperatureC !== undefined) summary.maxTemperatureC = row.maxTemperatureC;
    return summary;
  },
});

/** Upsert a cached forecast (idempotent on the key pair). */
export const writeForecastCache = internalMutation({
  args: {
    samplePointKey: v.string(),
    forecastBucketMs: v.number(),
    hours: v.array(
      v.object({
        startMs: v.number(),
        temperatureC: v.number(),
        windSpeedKph: v.number(),
        precipitationMm: v.number(),
        snowfallCm: v.number(),
      }),
    ),
    precipStartsMs: v.optional(v.number()),
    precipIsSnow: v.optional(v.boolean()),
    minTemperatureC: v.optional(v.number()),
    maxTemperatureC: v.optional(v.number()),
    fetchedAt: v.number(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query('weatherForecastCache')
      .withIndex('by_key', (q) =>
        q.eq('samplePointKey', a.samplePointKey).eq('forecastBucketMs', a.forecastBucketMs),
      )
      .first();
    if (existing) await ctx.db.patch(existing._id, a);
    else await ctx.db.insert('weatherForecastCache', a);
  },
});

/**
 * Resolve the forward forecast for a point, cache-first (N6c B5b).
 *
 * **The window it asks for is one hour of past, and that is not waste.** Open-Meteo's `past_days`
 * has a floor of 1, so the smallest honest request already spans today; asking for a one-hour window
 * costs exactly what asking for none would, and it keeps this on the identical code path as the
 * weather-since fetch rather than adding a second, subtly-different request builder.
 *
 * Returns `null` when the fetch failed, so the caller fails open and the next drawer-open retries —
 * the same contract as `resolveWeatherSince`, and for the same reason: caching a blank strip for an
 * hour because of a transient blip is worse than fetching twice.
 */
export async function resolveForecast(
  ctx: ActionCtx,
  lat: number,
  lng: number,
  nowMs: number,
): Promise<ForecastSummary | null> {
  const samplePointKey = samplePointKeyFor(lat, lng);
  const forecastBucketMs = hourBucket(nowMs);
  const cached = await ctx.runQuery(internal.weather.readForecastCache, {
    samplePointKey,
    forecastBucketMs,
  });
  if (cached) return cached;

  const hourly = await fetchOpenMeteoHourly(lat, lng, hourBucket(nowMs - HOUR_MS), nowMs);
  if (hourly === null || hourly.forecast.length === 0) return null;

  // **`nowMs` is shifted into the body's local clock before the horizon is applied**, because the
  // hours carry local-shifted timestamps and comparing them against a UTC `now` would slide the
  // whole strip by the offset — 4–5 hours in this region, i.e. most of a 12-hour horizon.
  const summary = summarizeForecast(hourly.forecast, nowMs + hourly.utcOffsetMs);
  if (summary.hours.length === 0) return null;

  await ctx.runMutation(internal.weather.writeForecastCache, {
    samplePointKey,
    forecastBucketMs,
    ...summary,
    fetchedAt: nowMs,
  });
  return summary;
}

/**
 * Public: the short forward forecast for a **water body**'s drawer (N6c B5b).
 *
 * Keyed on the body rather than on a report or hazard, because unlike the weather-since strip this
 * has nothing to anchor to — the question "will it be snowing when I get there" is about the lake,
 * and it is asked most often on the lakes with no reports at all.
 *
 * **The resource guard is the same shape as `getWeatherSinceForBody`'s and it matters more here**,
 * since there is no entity to derive a window from: the only client-supplied value is a body id, and
 * the window is `now` on the server. So the reachable fetch set is one per body per hour bucket,
 * which is exactly what the cache already collapses.
 */
export const getForecastForBody = action({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<ForecastSummary | null> => {
    if (!(await ctx.auth.getUserIdentity())) return null;
    const point = await ctx.runQuery(internal.weather.resolveBodySamplePoint, { waterBodyId });
    if (!point) return null;
    return await resolveForecast(ctx, point.lat, point.lng, Date.now());
  },
});

/** The body's default weather sample point — `interiorPoint` where present, per `lib/sampling`. */
export const resolveBodySamplePoint = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return null;
    const point = nearestSamplePoint(body, defaultSampleAnchor(body));
    return { lat: point.lat, lng: point.lng };
  },
});

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
