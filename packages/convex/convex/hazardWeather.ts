/**
 * Weather-driven hazard-decay precompute (Phase 10 / D56 §6). The strip fetches on drawer-open, so only
 * the **decay** needs a cron: the weather-adjusted freshness must be ready for the **offline on-ice alert**
 * (a phone on the ice can't fetch Open-Meteo) and must affect the map with no viewer present.
 *
 * The cron sweeps **only bodies with ≥1 active hazard** (via the `by_status_weather_adjusted` index) — not
 * all 116k lakes — so cost tracks hazard-carrying bodies (tens–hundreds at peak), not corpus size. It runs
 * at a fixed hourly base tick but **skips any hazard refreshed within `WEATHER_REFRESH_MIN_INTERVAL_HOURS`**,
 * giving an effective ~3h cadence without a redeploy (Convex crons can't retune their interval at runtime;
 * Phase 7 lifts the threshold to an admin config, same lever pattern as the D52 tiers). The scan is
 * stalest-first so its per-tick cap rotates through the backlog rather than re-reading one prefix (N1).
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
import { isShallowBody } from './lib/depth';
import { hazardCenter, nearestSamplePoint } from './lib/sampling';
import { takeCapped } from './lib/scan';
import { resolveWeatherSince } from './weather';

/** Active hazards the decay sweep considers per tick. Hundreds at peak by design (the cron scopes
 *  to hazard-carrying bodies, not the 116k-lake corpus), so this is a backstop, not a bound (N1).
 *  Safe to cap only because the scan is stalest-first — see `listActiveHazardsForWeather`. */
const ACTIVE_HAZARD_SCAN_CAP = 1000;
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
  /** Whether the hazard's body is shallow — amplifies the thaw response only (N6a / D69). */
  isShallow: boolean;
}

/**
 * The active, user-visible hazards the decay cron should refresh next — **stalest first** — each
 * resolved to its nearest sample point. Alpha-scale scan (tens–hundreds of active hazards); the
 * index keeps it off archived and moderator-hidden rows.
 *
 * The scan order *is* the backlog rotation. `by_status_moderation_weather_adjusted` is ascending on
 * `weatherAdjustedAt` with `undefined` first, so a tick reads the never-refreshed hazards, then the
 * longest-stale ones; refreshing a hazard stamps `weatherAdjustedAt = now` and sends it to the back.
 * On the plain `by_status` scan this used to run, the cap returned the *same* prefix every hour — a
 * hazard sitting past row 1,000 would have kept absent decay and snow-hidden state forever, and the
 * cadence gate downstream couldn't help, because it filters what was already read (Greptile PR #27).
 *
 * **Anything skipped has to rotate too, or it's the same bug one level in** (Greptile PR #27, round
 * 5). A hazard the sweep declines to refresh is never stamped, so it sorts to the front of a
 * `undefined`-first index *forever* and holds its slot in the cap against everything behind it.
 * Moderator-hidden rows — the numerous case — are excluded by the index and cost nothing. The two
 * that can only be judged after reading (a feature-promoted pin, D53; a hazard whose body was
 * removed) come back as `deferred`, and the action stamps them so they move to the back. That stamp
 * is honest: `weatherAdjustedAt` records when the sweep last *considered* a hazard, and the answer
 * "this one needs no weather" is a considered one. If such a hazard becomes eligible again it waits
 * at most one cadence window, and its decay is absent-⇒-1 meanwhile, which is fail-open.
 */
export const listActiveHazardsForWeather = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ jobs: HazardWeatherJob[]; deferred: Id<'hazards'>[] }> => {
    // The corpus-scaling read the Phase-10 review flagged. Bounded per tick, and because the order is
    // stalest-first, a capped run drains the backlog across ticks instead of re-reading one prefix.
    const hazards = await takeCapped(
      ctx.db
        .query('hazards')
        .withIndex('by_status_moderation_weather_adjusted', (q) =>
          q.eq('status', 'active').eq('moderationStatus', 'visible'),
        ),
      ACTIVE_HAZARD_SCAN_CAP,
      'hazardWeather.listActiveHazardsForWeather',
    );

    // One entry per body, holding both the row and its shallowness (N6a). Cached together because the
    // shallow check costs an indexed read of the body's features and many hazards share a body — the
    // same reason the body row itself is cached. Bounded by hazard-carrying bodies, not the corpus.
    const bodyCache = new Map<
      string,
      { body: Doc<'waterBodies'> | null; isShallow: boolean } | undefined
    >();
    const jobs: HazardWeatherJob[] = [];
    const deferred: Id<'hazards'>[] = [];
    for (const h of hazards) {
      if (h.promotedToFeatureId !== undefined) {
        deferred.push(h._id);
        continue;
      }
      const key = h.waterBodyId;
      let entry = bodyCache.get(key);
      if (entry === undefined) {
        const body = await ctx.db.get(h.waterBodyId);
        // Skip the feature read entirely for a body we're about to defer anyway.
        const isShallow = body && !body.removedAt ? await isShallowBody(ctx, body) : false;
        entry = { body, isShallow };
        bodyCache.set(key, entry);
      }
      if (!entry.body || entry.body.removedAt) {
        deferred.push(h._id);
        continue;
      }
      const point = nearestSamplePoint(entry.body, hazardCenter(h));
      jobs.push({
        hazardId: h._id,
        type: h.type,
        lastConfirmedAt: h.lastConfirmedAt,
        weatherAdjustedAt: h.weatherAdjustedAt,
        lat: point.lat,
        lng: point.lng,
        isShallow: entry.isShallow,
      });
    }
    return { jobs, deferred };
  },
});

/**
 * Mark hazards the sweep looked at and decided need no weather (promoted to a feature, or on a
 * removed body), so they leave the front of the stalest-first queue. Only `weatherAdjustedAt` moves —
 * no multiplier is invented for a pin that doesn't render. Without this they would be re-read, and
 * re-skipped, on every tick forever, holding slots against hazards that do need refreshing.
 */
export const deferHazardWeather = internalMutation({
  args: { hazardIds: v.array(v.id('hazards')), weatherAdjustedAt: v.number() },
  handler: async (ctx, { hazardIds, weatherAdjustedAt }) => {
    for (const hazardId of hazardIds) {
      const hazard = await ctx.db.get(hazardId);
      if (!hazard) continue;
      await ctx.db.patch(hazardId, { weatherAdjustedAt });
    }
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

    const { jobs, deferred } = await ctx.runQuery(
      internal.hazardWeather.listActiveHazardsForWeather,
      {},
    );
    // Rotate the ones we declined out of the queue's front before doing any work, so a tick that
    // fails partway through still leaves the backlog draining rather than stuck.
    if (deferred.length > 0) {
      await ctx.runMutation(internal.hazardWeather.deferHazardWeather, {
        hazardIds: deferred,
        weatherAdjustedAt: now,
      });
    }
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
          // The shallow bit rides in the body context, not the options object: it's a fact about the
          // lake, not one of the tunable magnitudes (N6a / D69).
          decayMultiplier: decayMultiplier(job.type, summary, {}, { isShallow: job.isShallow }),
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
