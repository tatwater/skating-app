/**
 * Reusable Convex validators.
 *
 * `literals()` turns a shared `as const` string tuple (from `@skating/core` or
 * `./enums`) into a Convex union validator while preserving the precise literal
 * types — so the schema stays single-sourced with the domain vocabulary and the
 * generated `DataModel` keeps exact string-literal field types.
 */

import { v } from 'convex/values';

/** Build a `v.union(v.literal(...))` from a readonly tuple, keeping literal types. */
export function literals<const T extends readonly [string, string, ...string[]]>(values: T) {
  return v.union(
    ...(values.map((value) => v.literal(value)) as {
      [K in keyof T]: ReturnType<typeof v.literal<T[K]>>;
    }),
  );
}

/**
 * Build a `v.object` of `{ [key]: boolean }` from a readonly key tuple, keeping the
 * exact keys in the resulting type. Single-sources key sets (e.g. notification prefs)
 * so the schema, defaults, and the tuple can't drift apart.
 */
export function boolFlags<const T extends readonly [string, ...string[]]>(keys: T) {
  return v.object(
    Object.fromEntries(keys.map((key) => [key, v.boolean()])) as {
      [K in T[number]]: ReturnType<typeof v.boolean>;
    },
  );
}

/**
 * Like `boolFlags`, but every key is **optional** — a partial toggle patch (e.g. flipping a single
 * notification pref) that the handler merges onto the stored full object. Keeps the exact keys typed.
 */
export function partialBoolFlags<const T extends readonly [string, ...string[]]>(keys: T) {
  return v.object(
    Object.fromEntries(keys.map((key) => [key, v.optional(v.boolean())])) as {
      [K in T[number]]: ReturnType<typeof v.optional<ReturnType<typeof v.boolean>>>;
    },
  );
}

/** A geographic point. Used for report points, centroids, and tested coords. */
export const latLng = v.object({ lat: v.number(), lng: v.number() });

/** Axis-aligned bounding box — the cheap prefilter before precise Turf tests (D5). */
export const bbox = v.object({
  minLat: v.number(),
  minLng: v.number(),
  maxLat: v.number(),
  maxLng: v.number(),
});

/**
 * A GeoJSON geometry — the shapes we actually store (`Point` / `MultiPoint` /
 * `LineString` / `MultiLineString` / `Polygon` / `MultiPolygon`). The `type` literal
 * discriminates the union even where coordinate nesting coincides (e.g. `MultiPoint`
 * vs `LineString`), so an unknown `type` or wrong nesting depth is rejected at the
 * mutation/DB boundary (D5).
 *
 * This validates *shape*, not geometric validity: a `Position` is `number[]` (Convex
 * can't pin tuple length), and ring closure / winding / min-vertex-count are enforced
 * by the Turf-backed layer in `@skating/core`, not here. `GeometryCollection` is
 * intentionally omitted — it's recursive and unused.
 */
const position = v.array(v.number()); // [lng, lat] (+ optional elevation)
export const geoJson = v.union(
  v.object({ type: v.literal('Point'), coordinates: position }),
  v.object({ type: v.literal('MultiPoint'), coordinates: v.array(position) }),
  v.object({ type: v.literal('LineString'), coordinates: v.array(position) }),
  v.object({ type: v.literal('MultiLineString'), coordinates: v.array(v.array(position)) }),
  v.object({ type: v.literal('Polygon'), coordinates: v.array(v.array(position)) }),
  v.object({ type: v.literal('MultiPolygon'), coordinates: v.array(v.array(v.array(position))) }),
);
