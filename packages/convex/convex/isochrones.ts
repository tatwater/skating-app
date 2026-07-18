/**
 * Drive-time isochrone computation (Phase 4, decision #2). Turns a user's PRIVATE `homeCoord` (D11)
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
  ORS_BAND_RANGES_SEC,
  type OrsIsochroneResponse,
  outerBandRadiusMeters,
  parseOrsIsochrones,
} from '@skating/core'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { geoJson } from './lib/validators'

const ORS_ISOCHRONE_URL = 'https://api.openrouteservice.org/v2/isochrones/driving-car'
/** The 90-min band has no ORS polygon (60-min cap), so it's a uniform crow-flies radius (decision #2). */
const OUTER_BAND_MINUTES = 90

/** Read a profile's private home coord for the isochrone action (internal — never client-exposed). */
export const getHomeForIsochrones = internalQuery({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db.get(userId)
    return profile?.homeCoord ?? null
  },
})

/**
 * Store the freshly computed bands on the profile (internal). Clearing (`homeCoord` removed) passes
 * all-undefined, which drops the cached geometry so every lake reads band `null` again.
 */
export const storeBands = internalMutation({
  args: {
    userId: v.id('profiles'),
    band30: v.optional(geoJson),
    band60: v.optional(geoJson),
    outerRadiusMeters: v.optional(v.number()),
    computedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.userId)
    if (!profile) return
    const cachedIsochrones =
      args.band30 !== undefined || args.band60 !== undefined
        ? {
            ...(args.band30 !== undefined ? { band30: args.band30 } : {}),
            ...(args.band60 !== undefined ? { band60: args.band60 } : {}),
          }
        : undefined
    await ctx.db.patch(args.userId, {
      cachedIsochrones,
      outerRadiusMeters: args.outerRadiusMeters,
      cachedIsochronesAt: args.computedAt,
    })
  },
})

/** Call ORS for the 30/60-min isochrones around `home`; returns the parsed bands, or `{}` on failure. */
async function fetchOrsBands(home: {
  lat: number
  lng: number
}): Promise<{ band30?: unknown; band60?: unknown }> {
  const apiKey = process.env.ORS_API_KEY
  if (!apiKey) {
    console.warn('ORS_API_KEY not set — skipping isochrone polygons (90-min radius still applies)')
    return {}
  }
  try {
    const res = await fetch(ORS_ISOCHRONE_URL, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [[home.lng, home.lat]],
        range: [ORS_BAND_RANGES_SEC.band30, ORS_BAND_RANGES_SEC.band60],
        range_type: 'time',
      }),
    })
    if (!res.ok) {
      console.warn(`ORS isochrone request failed: ${res.status}`)
      return {}
    }
    return parseOrsIsochrones((await res.json()) as OrsIsochroneResponse)
  } catch (err) {
    console.warn('ORS isochrone request threw', err)
    return {}
  }
}

/**
 * Recompute + cache a user's drive-time bands (decision #2). Reads home; if unset, clears the cache.
 * Otherwise computes the local crow-flies `outerRadiusMeters` (always) and best-effort ORS 30/60
 * polygons (skipped on any failure — the outer radius still gives a usable 90 band).
 */
export const recompute = internalAction({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const home = await ctx.runQuery(internal.isochrones.getHomeForIsochrones, { userId })
    const computedAt = Date.now()
    if (!home) {
      await ctx.runMutation(internal.isochrones.storeBands, { userId, computedAt })
      return
    }
    const bands = await fetchOrsBands(home)
    await ctx.runMutation(internal.isochrones.storeBands, {
      userId,
      ...(bands.band30 !== undefined ? { band30: bands.band30 as never } : {}),
      ...(bands.band60 !== undefined ? { band60: bands.band60 as never } : {}),
      outerRadiusMeters: outerBandRadiusMeters(OUTER_BAND_MINUTES),
      computedAt,
    })
  },
})
