/**
 * Weather-driven hazard-decay precompute (Phase 10 / D56 §6). The strip fetches on drawer-open, so only
 * the **decay** needs a cron: the weather-adjusted freshness must be ready for the **offline on-ice alert**
 * (a phone on the ice can't fetch Open-Meteo) and must affect the map with no viewer present.
 *
 * The cron sweeps **only bodies with ≥1 active hazard** (via the `by_status` index) — not all 116k lakes —
 * so cost tracks hazard-carrying bodies (tens–hundreds at peak), not corpus size. It runs at a fixed hourly
 * base tick but **skips any hazard refreshed within `WEATHER_REFRESH_MIN_INTERVAL_HOURS`**, giving an
 * effective ~3h cadence without a redeploy (Convex crons can't retune their interval at runtime; Phase 7
 * lifts the threshold to an admin config, same lever pattern as the D52 tiers).
 *
 * It stores the **time-independent `decayMultiplier`** (+ `snowHidden`), never a frozen freshness bucket —
 * the online `toView` recomputes the live bucket from it. Fail-open throughout: a lagged/failed cron just
 * leaves the last multiplier (or none ⇒ 1), so weather trouble can never make a hazard less visible.
 *
 * Weather window (D56, refined 2026-07-22): `[max(lastConfirmedAt, now − lookback), now]` — "since last
 * confirmed", but capped to a recent lookback so a long-unconfirmed ridge's multiplier reflects *recent*
 * conditions (not a month of saturating degree-hours) and so the decay + the hazard strip share one window
 * → one cache entry → guaranteed consistency.
 */

import { decayMultiplier, isSnowHidden } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { resolveWeatherSince } from './weather';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Effective refresh cadence: skip a hazard refreshed more recently than this (Phase 7 → admin config). */
export const WEATHER_REFRESH_MIN_INTERVAL_HOURS = 3;
/** Weather window lookback: recent conditions are what erode confidence — a month-old thaw is irrelevant. */
export const HAZARD_WEATHER_LOOKBACK_DAYS = 7;

/** Squared degree distance — fine for picking the nearest of a handful of sample points at lake scale. */
function distSq(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

/** The nearest weather sample point to `target` — the body's centroid by default (D56 §5). */
export function nearestSamplePoint(
  body: Doc<'waterBodies'>,
  target: { lat: number; lng: number },
): { lat: number; lng: number } {
  const points = body.weatherSamplePoints?.length ? body.weatherSamplePoints : [body.centroid];
  let best = points[0] ?? body.centroid;
  let bestD = distSq(best, target);
  for (const p of points) {
    const d = distSq(p, target);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Center of a hazard's footprint bbox — its representative point for nearest-sample-point selection. */
function hazardCenter(hazard: Doc<'hazards'>): { lat: number; lng: number } {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}

interface HazardWeatherJob {
  hazardId: Id<'hazards'>;
  type: Doc<'hazards'>['type'];
  lastConfirmedAt: number;
  weatherAdjustedAt?: number;
  lat: number;
  lng: number;
}

/**
 * Every active, user-visible hazard the decay cron should refresh, each resolved to its nearest sample
 * point. Skips moderator-hidden and feature-promoted pins (they don't render, so weather is wasted on
 * them). Alpha-scale scan (tens–hundreds of active hazards); the `by_status` index keeps it off archived.
 */
export const listActiveHazardsForWeather = internalQuery({
  args: {},
  handler: async (ctx): Promise<HazardWeatherJob[]> => {
    const hazards = await ctx.db
      .query('hazards')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .collect();

    const bodyCache = new Map<string, Doc<'waterBodies'> | null>();
    const jobs: HazardWeatherJob[] = [];
    for (const h of hazards) {
      if (h.moderationStatus !== 'visible' || h.promotedToFeatureId !== undefined) continue;
      const key = h.waterBodyId;
      let body = bodyCache.get(key);
      if (body === undefined) {
        body = await ctx.db.get(h.waterBodyId);
        bodyCache.set(key, body);
      }
      if (!body || body.removedAt) continue;
      const point = nearestSamplePoint(body, hazardCenter(h));
      jobs.push({
        hazardId: h._id,
        type: h.type,
        lastConfirmedAt: h.lastConfirmedAt,
        weatherAdjustedAt: h.weatherAdjustedAt,
        lat: point.lat,
        lng: point.lng,
      });
    }
    return jobs;
  },
});

/** Store the freshly computed weather decay on a hazard (time-independent multiplier + snow caveat). */
export const storeHazardWeather = internalMutation({
  args: {
    hazardId: v.id('hazards'),
    decayMultiplier: v.number(),
    snowHidden: v.boolean(),
    weatherAdjustedAt: v.number(),
  },
  handler: async (ctx, a) => {
    const hazard = await ctx.db.get(a.hazardId);
    if (!hazard) return;
    await ctx.db.patch(a.hazardId, {
      decayMultiplier: a.decayMultiplier,
      snowHidden: a.snowHidden,
      weatherAdjustedAt: a.weatherAdjustedAt,
    });
  },
});

/**
 * Refresh weather-adjusted decay for every active hazard due a refresh. Runs hourly; per-hazard cadence is
 * gated by `WEATHER_REFRESH_MIN_INTERVAL_HOURS`. The shared `resolveWeatherSince` cache means many hazards
 * on the same body/window fold into one Open-Meteo fetch.
 */
export const refreshHazardWeather = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const minIntervalMs = WEATHER_REFRESH_MIN_INTERVAL_HOURS * HOUR_MS;
    const lookbackMs = HAZARD_WEATHER_LOOKBACK_DAYS * DAY_MS;

    const jobs = await ctx.runQuery(internal.hazardWeather.listActiveHazardsForWeather, {});
    for (const job of jobs) {
      if (job.weatherAdjustedAt !== undefined && now - job.weatherAdjustedAt < minIntervalMs) {
        continue; // refreshed recently enough — the effective cadence gate
      }
      const windowStart = Math.max(job.lastConfirmedAt, now - lookbackMs);
      const summary = await resolveWeatherSince(ctx, job.lat, job.lng, windowStart, now);
      await ctx.runMutation(internal.hazardWeather.storeHazardWeather, {
        hazardId: job.hazardId,
        decayMultiplier: decayMultiplier(job.type, summary),
        snowHidden: isSnowHidden(summary),
        weatherAdjustedAt: now,
      });
    }
  },
});
