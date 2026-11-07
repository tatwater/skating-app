/**
 * Drive-time isochrone computation (Phase 04, decision #2). Turns a user's PRIVATE `homeCoord` (D11)
 * into the cached band geometry every drive-time read consumes: the 30/60-min **ORS isochrone
 * polygons** and the 90-min **crow-flies `outerRadiusMeters`** fallback (hosted ORS caps isochrones at
 * 60 min). `homeCoord` never leaves the server — only the derived polygons + radius are stored.
 *
 * Recompute is an **action** because it makes an outbound HTTP call to OpenRouteService (needs the
 * `ORS_API_KEY` env var); it reads the home via an internal query and writes bands via an internal
 * mutation, since actions have no direct db access. Scheduled from `profiles.setHome` on home change
 * (D18) — rate-limited by only ever running on an actual change, not per read. The outer radius is
 * computed locally (no API), so the 90 band still works even if ORS is unreachable.
 */

import {
  driveOrigin,
  ORS_BAND_RANGES_SEC,
  type OrsIsochroneResponse,
  outerBandRadiusMeters,
  parseOrsIsochrones,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { geoJson, latLng } from './lib/validators';

const ORS_ISOCHRONE_URL = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
/** The 90-min band has no ORS polygon (60-min cap), so it's a uniform crow-flies radius (decision #2). */
const OUTER_BAND_MINUTES = 90;

/**
 * The origin a profile's bands should be drawn from right now — **the travel base while it's in
 * force, else home** (`driveOrigin`, B03 §11) — or `null` when there is neither. Internal: the
 * coordinate never reaches a client.
 */
export const getOriginForIsochrones = internalQuery({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db.get(userId);
    return (profile && driveOrigin(profile, Date.now())) ?? null;
  },
});

/**
 * Store the freshly computed bands on the profile (internal), stamped with the `origin` they were
 * drawn from. Clearing (no origin) passes all-undefined, which drops the cached geometry so every
 * lake reads band `null` again.
 *
 * **A late answer for a place the skater has left is dropped.** The recompute reads the origin, then
 * waits on ORS; if the base was set, cleared or ran out meanwhile, the polygons it brings back are
 * for the old place, and the later recompute (the one that change scheduled) is the one that should
 * land. Comparing against the origin *now* makes the two orders of arrival end in the same state.
 */
export const storeBands = internalMutation({
  args: {
    userId: v.id('profiles'),
    origin: v.optional(latLng),
    band30: v.optional(geoJson),
    band60: v.optional(geoJson),
    outerRadiusMeters: v.optional(v.number()),
    computedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.userId);
    if (!profile) return;
    const current = driveOrigin(profile, Date.now());
    const sameOrigin =
      current === undefined || args.origin === undefined
        ? current === args.origin
        : current.lat === args.origin.lat && current.lng === args.origin.lng;
    if (!sameOrigin) return;
    const cachedIsochrones =
      args.band30 !== undefined || args.band60 !== undefined
        ? {
            ...(args.band30 !== undefined ? { band30: args.band30 } : {}),
            ...(args.band60 !== undefined ? { band60: args.band60 } : {}),
          }
        : undefined;
    await ctx.db.patch(args.userId, {
      cachedIsochrones,
      cachedIsochronesOrigin: args.origin,
      outerRadiusMeters: args.outerRadiusMeters,
      cachedIsochronesAt: args.computedAt,
    });
  },
});

/** Call ORS for the 30/60-min isochrones around `origin`; returns the parsed bands, or `{}` on failure. */
async function fetchOrsBands(origin: {
  lat: number;
  lng: number;
}): Promise<{ band30?: unknown; band60?: unknown }> {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    console.warn('ORS_API_KEY not set — skipping isochrone polygons (90-min radius still applies)');
    return {};
  }
  try {
    const res = await fetch(ORS_ISOCHRONE_URL, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [[origin.lng, origin.lat]],
        range: [ORS_BAND_RANGES_SEC.band30, ORS_BAND_RANGES_SEC.band60],
        range_type: 'time',
      }),
    });
    if (!res.ok) {
      console.warn(`ORS isochrone request failed: ${res.status}`);
      return {};
    }
    return parseOrsIsochrones((await res.json()) as OrsIsochroneResponse);
  } catch (err) {
    console.warn('ORS isochrone request threw', err);
    return {};
  }
}

/**
 * Recompute + cache a user's drive-time bands (decision #2). Reads the origin (home, or the travel
 * base while it's in force); if neither, clears the cache. Otherwise computes the local crow-flies
 * `outerRadiusMeters` (always) and best-effort ORS 30/60 polygons (skipped on any failure — the outer
 * radius still gives a usable 90 band). Scheduled by `setHome`, `setTravelBase`/`clearTravelBase`,
 * and once at a base's `until`, so the bands come home on their own.
 */
export const recompute = internalAction({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const origin = await ctx.runQuery(internal.isochrones.getOriginForIsochrones, { userId });
    const computedAt = Date.now();
    if (!origin) {
      await ctx.runMutation(internal.isochrones.storeBands, { userId, computedAt });
      return;
    }
    const bands = await fetchOrsBands(origin);
    await ctx.runMutation(internal.isochrones.storeBands, {
      userId,
      origin,
      ...(bands.band30 !== undefined ? { band30: bands.band30 as never } : {}),
      ...(bands.band60 !== undefined ? { band60: bands.band60 as never } : {}),
      outerRadiusMeters: outerBandRadiusMeters(OUTER_BAND_MINUTES),
      computedAt,
    });
  },
});
