/**
 * Reusable Convex validators.
 *
 * `literals()` turns a shared `as const` string tuple (from `@skating/core` or
 * `./enums`) into a Convex union validator while preserving the precise literal
 * types — so the schema stays single-sourced with the domain vocabulary and the
 * generated `DataModel` keeps exact string-literal field types.
 */

import { v } from 'convex/values'

/** Build a `v.union(v.literal(...))` from a readonly tuple, keeping literal types. */
export function literals<const T extends readonly [string, string, ...string[]]>(values: T) {
  return v.union(
    ...(values.map((value) => v.literal(value)) as {
      [K in keyof T]: ReturnType<typeof v.literal<T[K]>>
    }),
  )
}

/**
 * Build a `v.object` of `{ [key]: boolean }` from a readonly key tuple, keeping the
 * exact keys in the resulting type. Single-sources key sets (e.g. notification prefs)
 * so the schema, defaults, and the tuple can't drift apart.
 */
export function boolFlags<const T extends readonly [string, ...string[]]>(keys: T) {
  return v.object(
    Object.fromEntries(keys.map((key) => [key, v.boolean()])) as {
      [K in T[number]]: ReturnType<typeof v.boolean>
    },
  )
}

/** A geographic point. Used for report points, centroids, and tested coords. */
export const latLng = v.object({ lat: v.number(), lng: v.number() })

/** Axis-aligned bounding box — the cheap prefilter before precise Turf tests (D5). */
export const bbox = v.object({
  minLat: v.number(),
  minLng: v.number(),
  maxLat: v.number(),
  maxLng: v.number(),
})

/**
 * A GeoJSON geometry (Point / LineString / Polygon / MultiPolygon).
 *
 * Loosely typed for v1: precise geometry validation happens in the Turf-backed
 * query/action layer (D5), and the `@convex-dev/geospatial` component indexes the
 * point fields separately. Tighten to a structured validator when that lands.
 */
export const geoJson = v.any()
