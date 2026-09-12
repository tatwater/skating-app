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
/**
 * One metric's distribution within one state (N6c A5) — the 10th–90th percentiles plus the sample
 * that produced them.
 *
 * `count` is not decoration: `decileRankOf` refuses to rank against a block below
 * `MIN_DECILE_SAMPLE`, because deciles over a handful of lakes are noise wearing a distribution's
 * clothes and the failure is silent — a block summarising eight bodies looks exactly like one
 * summarising eight thousand.
 */
export const decileBlock = v.object({
  deciles: v.array(v.number()),
  count: v.number(),
});

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

/**
 * The `PostedAccess` shape from `@skating/core` (N6e) — what a posted sign says about when you may be
 * there. **Keep in sync with the core interface**; a compile-time `Infer` check in `postedAccess.ts`
 * catches drift, the same guard `weatherSinceSummary` carries.
 *
 * Shared here rather than inlined per table because the identical shape hangs off three of them —
 * `waterBodies`, `putIns` and `parkingAreas` — and a rule that validated differently depending on
 * which one it was attached to would be a bug nobody would think to look for.
 *
 * Every field is optional, which is load-bearing rather than lax: "open year-round, daylight only" has
 * no `dateRange`, and "January 1 – March 15, any hour" has no `dailyWindow`. The check that a rule
 * asserts *something* is `postedAccessError`'s, in core, where both clients can run it too.
 */
export const postedAccess = v.object({
  dateRange: v.optional(
    v.object({
      startMonth: v.number(),
      startDay: v.number(),
      endMonth: v.number(),
      endDay: v.number(),
    }),
  ),
  dailyWindow: v.optional(
    v.union(
      v.object({ kind: v.literal('daylight'), offsetMinutes: v.number() }),
      v.object({ kind: v.literal('clock'), openMinute: v.number(), closeMinute: v.number() }),
    ),
  ),
  permitRequired: v.optional(v.boolean()),
  note: v.optional(v.string()),
});

const nullableNumber = v.union(v.number(), v.null());

/**
 * The `WeatherSinceSummary` shape from `@skating/core` (D19/D56), for the `weatherCache` table. **Keep in
 * sync with the core interface** — a compile-time `Infer` check in `weather.ts` catches drift. Nullable
 * fields read `null` only when there is no data (empty window / no timestamps / no gust or depth data).
 */
export const weatherSinceSummary = v.object({
  hours: v.number(),
  peakTempC: nullableNumber,
  minTempC: nullableNumber,
  hoursNearFreezing: v.number(),
  hoursAboveFreezing: v.number(),
  nightsBelowFreezing: nullableNumber,
  hoursOfSun: v.number(),
  totalPrecipMm: v.number(),
  rainMm: v.number(),
  snowfallCm: v.number(),
  maxSnowDepthM: nullableNumber,
  maxWindKph: nullableNumber,
  maxWindGustKph: nullableNumber,
  windRunKm: v.number(),
  freezingDegreeHours: v.number(),
  thawDegreeHours: v.number(),
  insolationWhM2: v.number(),
  longestFreezeRunHours: v.number(),
  freezeThawCycles: v.number(),
});

/**
 * What an actor-triggered queue row re-reads at flush (N8 / D166). One variant per queue kind that
 * settles before sending; the report-audience buckets (`favorite` / `digest` / `great`) carry none —
 * their re-check is the recipient's eligibility, which every row gets. The id lists are what
 * coalescing accumulates inside one settle window ("5 people found this helpful"), and each id is
 * re-verified individually, so a retracted thumb drops out of the count rather than dropping the row.
 *
 * `kind` is repeated from the row on purpose: it is what lets TypeScript narrow the variant, and a
 * Convex validator cannot express "the shape of `trigger` depends on a sibling field".
 */
export const notificationTrigger = v.union(
  v.object({
    kind: v.literal('thumb'),
    targetType: v.union(v.literal('report'), v.literal('hazard')),
    targetId: v.string(),
    actorIds: v.array(v.id('profiles')),
  }),
  v.object({
    kind: v.literal('corroboration'),
    reportId: v.id('reports'),
    byReportIds: v.array(v.id('reports')),
  }),
  v.object({
    kind: v.union(v.literal('comment'), v.literal('reply')),
    reportId: v.id('reports'),
    commentIds: v.array(v.id('comments')),
    actorIds: v.array(v.id('profiles')),
  }),
  v.object({
    kind: v.literal('hazard_lifecycle'),
    hazardId: v.id('hazards'),
    phase: v.union(
      v.literal('provisional'),
      v.literal('confirmed'),
      v.literal('healing_unsafe'),
      v.literal('disputed'),
      v.literal('archived'),
    ),
    // The voters whose confirmations moved the phase inside the window — kept so the flush can
    // apply the recipient's block set the way it does for thumbs, not only the enqueue gate.
    actorIds: v.array(v.id('profiles')),
  }),
  v.object({
    kind: v.literal('flag_resolved'),
    flagId: v.id('contentFlags'),
    resolution: v.union(v.literal('actioned'), v.literal('dismissed')),
  }),
  v.object({
    kind: v.literal('bounty_request'),
    bountyId: v.id('bounties'),
    waterBodyId: v.id('waterBodies'),
    requesterId: v.id('profiles'),
  }),
  v.object({
    kind: v.literal('bounty_answered'),
    bountyId: v.id('bounties'),
    waterBodyId: v.id('waterBodies'),
    reportIds: v.array(v.id('reports')),
  }),
  v.object({
    kind: v.literal('activity'),
    activityId: v.id('gpsActivities'),
  }),
);
