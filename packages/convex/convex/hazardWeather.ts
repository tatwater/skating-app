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

import { decayMultiplier, HAZARD_WEATHER_LOOKBACK_DAYS, isSnowHidden } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { hazardCenter, nearestSamplePoint } from './lib/sampling';
import { resolveWeatherSince } from './weather';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Effective refresh cadence: skip a hazard refreshed more recently than this (Phase 7 → admin config). */
export const WEATHER_REFRESH_MIN_INTERVAL_HOURS = 3;

// Sampling helpers (`nearestSamplePoint`/`hazardCenter`) live in `lib/sampling` so `weather.ts` can share
// them without an import cycle — the strip must resolve the same point this cron does (§5 consistency).

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
    /**
     * The `lastConfirmedAt` this multiplier was computed against (the window's start floor). The
     * compare-and-swap guard below drops the write if it no longer matches — see the handler note.
     */
    expectedLastConfirmedAt: v.number(),
  },
  handler: async (ctx, a) => {
    const hazard = await ctx.db.get(a.hazardId);
    if (!hazard) return;
    // Compare-and-swap on the confirmation epoch. The refresh action snapshots a job (with its
    // `lastConfirmedAt`), fetches weather over the "since last confirmed" window, then calls this mutation.
    // If a confirmation advanced `lastConfirmedAt` in that gap, it already CLEARED the stored multiplier
    // (hazardConfirmations `recomputeLifecycle`), and this just-computed value is for the *old* window —
    // writing it now would resurrect stale weather against the new epoch and show the wrong freshness
    // bucket. So drop it; the next cron tick recomputes against the current window. Mirrors the read-in-
    // action / write-in-mutation guard the bounty path uses (§7c).
    if (hazard.lastConfirmedAt !== a.expectedLastConfirmedAt) return;
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
      // Isolate each hazard: an unexpected throw from the resolver/mutation (e.g. a transient OCC or cache
      // write conflict) skips just this hazard, not the whole tick. `fetchOpenMeteoHourly` already swallows
      // network/HTTP errors into `null`; this catches everything else so one bad job can't starve the rest.
      // Fail-open: a skipped hazard keeps its last-good multiplier (or none ⇒ 1) and retries next tick.
      try {
        const windowStart = Math.max(job.lastConfirmedAt, now - lookbackMs);
        const summary = await resolveWeatherSince(ctx, job.lat, job.lng, windowStart, now);
        // A failed fetch (`null`) is NOT an empty summary: keep the last good multiplier and DON'T stamp
        // `weatherAdjustedAt`, so a transient Open-Meteo blip can't erase a real signal or block retry for
        // the cadence window — the next tick tries again (fail-open, matches the cache layer's no-cache-on-
        // failure discipline in `weather.ts`).
        if (summary === null) continue;
        await ctx.runMutation(internal.hazardWeather.storeHazardWeather, {
          hazardId: job.hazardId,
          decayMultiplier: decayMultiplier(job.type, summary),
          snowHidden: isSnowHidden(summary),
          weatherAdjustedAt: now,
          // The epoch the window (and thus this multiplier) was computed against — the CAS guard's key.
          expectedLastConfirmedAt: job.lastConfirmedAt,
        });
      } catch (err) {
        console.warn(`hazard weather refresh failed for ${job.hazardId}`, err);
      }
    }
  },
});
