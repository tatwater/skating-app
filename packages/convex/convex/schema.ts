/**
 * Convex schema — the app's core entities, mirroring `plans/06-data-model.md`.
 *
 * Shared vocabulary comes from `@skating/core` (single source of truth); backend-only
 * enums come from `./lib/enums`. Point/bbox/GeoJSON fields are defined here, but the
 * spatial *indexes* are the `*Cells` ladder-grid tables below (D5/N1) — see README.
 *
 * Identity split (D26): **Clerk owns the auth user**; we own a `profiles` row per
 * user holding all domain data (display, prefs, role, status, reputation). The two
 * are tied by `profiles.clerkUserId` (= Clerk `identity.subject`), and every other
 * entity references a user by their **`profiles._id`** (`authorId`, `userId`, …).
 * This renames the doc's `users` table to `profiles`; update 06-data-model.md to match.
 */

import {
  CONDITION_SOURCES,
  DEPTH_SOURCES,
  ELEVATION_SOURCES,
  HAZARD_TYPES,
  ICE_TYPES,
  PRECIP_TYPES,
  PROFILE_VISIBILITIES,
  RATING_TARGET_TYPES,
  RECURRENCE_FAMILIES,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  USER_ROLES,
  USER_STATUSES,
  WATER_BODY_TYPES,
  WIND_ROSE_SOURCES,
} from '@skating/core';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  ACTIVITY_PROMPT_STATES,
  ACTIVITY_PROVIDERS,
  ADMIN_AREA_LEVELS,
  BODY_FEATURE_TYPES,
  BOUNTY_GATE_DECISIONS,
  BOUNTY_STATUSES,
  CANONICAL_SOURCES,
  COMMENT_SOURCES,
  DATA_EXPORT_STATUSES,
  DEDUP_STATUSES,
  FLAG_REASONS,
  FLAG_STATUSES,
  FLAG_TARGET_TYPES,
  HAZARD_CONFIRM_VERDICTS,
  HAZARD_CONFIRM_VIA,
  HAZARD_GEOMETRY_KINDS,
  HAZARD_HEALING_STATES,
  HAZARD_STATUSES,
  IMPORT_RUN_KINDS,
  IMPORT_RUN_STATUSES,
  MODERATION_ACTIONS,
  MODERATION_STATUSES,
  MODERATION_TARGET_TYPES,
  NOTIFICATION_PREF_KEYS,
  NOTIFICATION_QUEUE_KINDS,
  NOTIFICATION_TYPES,
  POINT_EVENT_REASONS,
  PUTIN_SOURCES,
  PUTIN_STATUSES,
  RATING_VERDICTS,
  REMOVAL_REASONS,
  REPORT_SOURCES,
  REVIEW_STATUSES,
  SUPPORT_CATEGORIES,
  SUPPORT_STATUSES,
  WATER_BODY_SOURCES,
} from './lib/enums';
import {
  bbox,
  boolFlags,
  decileBlock,
  geoJson,
  latLng,
  literals,
  weatherSinceSummary,
} from './lib/validators';

/** Per-type notification toggles; keys single-sourced to mirror `notifications.type` 1:1 (D16). */
const notificationPrefs = boolFlags(NOTIFICATION_PREF_KEYS);

export default defineSchema({
  profiles: defineTable({
    clerkUserId: v.string(), // ties this profile to its Clerk auth user (identity.subject)
    displayName: v.string(),
    username: v.string(), // unique, for search (searchable by name, D13)
    homeCoord: v.optional(latLng), // PRIVATE — filter input only (D11); set at onboarding
    homeTownLabel: v.optional(v.string()), // optional PUBLIC label (D11)
    bio: v.optional(v.string()), // optional PUBLIC blurb, shown only on a public profile (D13)
    // Avatar mirrored from Clerk's `imageUrl` at `upsertFromClerk` (Phase 3 decision #2) — no upload
    // pipeline; users manage it via Clerk's own UI. Optional ⇒ migration-free; scrubbed on deletion.
    profileImageUrl: v.optional(v.string()),
    driveTimePrefMinutes: v.number(), // legacy single pref (D18); superseded by the bands + notif radii below
    // Drive-time bands derived from the PRIVATE `homeCoord` (Phase 4, decision #2). 30/60 are hosted-ORS
    // isochrone polygons (the API caps at 60 min); the 90 band is the crow-flies `outerRadiusMeters`
    // fallback. Recomputed on home/pref change (D18), stamping `cachedIsochronesAt`. All optional ⇒
    // migration-free; a viewer with no home has none and every lake reads band `null`.
    cachedIsochrones: v.optional(
      v.object({ band30: v.optional(geoJson), band60: v.optional(geoJson) }),
    ),
    outerRadiusMeters: v.optional(v.number()),
    cachedIsochronesAt: v.optional(v.number()),
    // Server-sync copy of the newsfeed filter row (Phase 4, decision #3/#6); local storage is the
    // working copy, this is the durable/LWW copy. All fields optional (all-absent = show everything).
    feedFilterPrefs: v.optional(
      v.object({
        radiusMinutes: v.optional(v.number()),
        qualityFloor: v.optional(literals(SKATE_QUALITIES)),
        thicknessFloorCm: v.optional(v.number()),
        noSnow: v.optional(v.boolean()),
        iceTypes: v.optional(v.array(literals(ICE_TYPES))),
        surfaceTags: v.optional(v.array(literals(SURFACE_TAGS))),
        recencyHours: v.optional(v.number()),
      }),
    ),
    // Two independent notification radii (Phase 4, decision #4): X₁ for the "all nearby" digest, X₂
    // for "great nearby" (X₂ ≥ X₁, enforced in `setNotificationPrefs`). Optional ⇒ migration-free.
    allRadiusMinutes: v.optional(v.number()),
    greatRadiusMinutes: v.optional(v.number()),
    profileVisibility: literals(PROFILE_VISIBILITIES), // public=searchable/browsable; minors forced private (D13/D41)
    /**
     * Global opt-out from the aggregate tracks layer (D58, Phase 8). Person-level rather than
     * per-activity **on purpose**: a preference about being in a crowd map is about the person, and
     * putting it here means flipping it retroactively drops every track they've ever contributed
     * rather than only future ones. Recording and Strava push are unaffected — this only governs
     * whether their path draws on a lake's community map. Optional ⇒ migration-free.
     */
    excludeTracksFromAggregate: v.optional(v.boolean()),
    notificationPrefs, // every type toggleable (D16)
    dateOfBirth: v.number(), // UTC-midnight epoch ms; age gate (≥16) + minor status (<18) DERIVED (D41)
    riskAckVersion: v.optional(v.string()), // assumption-of-risk accepted (D45)
    riskAckAt: v.optional(v.number()),
    reputationPoints: v.number(), // cosmetic/reputational only (D17); aggregated from `pointEvents` (D50, Phase 6)
    // Separate achievement currency for fulfilling bounties (D17 decision 11) — kept OUT of
    // `reputationPoints` so trust stays purely about report/hazard accuracy. Optional ⇒ migration-free;
    // treated as 0 when absent. Bumped by `bounty_fulfilled` point events; the rest bump reputation.
    bountyPoints: v.optional(v.number()),
    // Denormalized lifetime contribution counts — the true #reports/#comments a public profile shows
    // (D13). Maintained incrementally on the create / author-remove / moderation paths so the profile
    // read never `.collect()`s an author's full history just to count it (the earlier windowed count
    // capped at PROFILE_HISTORY_LIMIT). Count only currently-**visible** content. Optional ⇒
    // migration-free; new profiles start at 0 and `backfillContributionCounts` seeds existing rows.
    reportCount: v.optional(v.number()),
    commentCount: v.optional(v.number()),
    badges: v.optional(v.array(v.string())),
    // Granular posting permissions (Phase 10 / D57): a moderation lever FINER than a whole-app ban —
    // a user who abuses one surface loses that surface, appealably and reversibly, not the whole app.
    // Optional booleans, **absent ⇒ allowed** (fail-open in the safe direction; default-on for adults —
    // minors are already read-only, D41). Restricted/restored from the Phase 7 admin surface; fed by the
    // contradiction signal (D56). `contradictionCount` is a PRIVATE, non-scoring tally of weather-
    // unexplained, never-corroborated contradictions — NOT trust (D50 stays boost-only), a moderation
    // input the Phase 7 panel charts tenure-aware. Absent ⇒ 0.
    canPostReports: v.optional(v.boolean()),
    canPostHazards: v.optional(v.boolean()),
    // `canPostComments` (D57 extension, Phase 7): comments are free-text content — the classic
    // harassment/spam surface — so a boolean revocation fits, exactly like reports/hazards. Its point
    // is muting a toxic commenter *without* silencing their safety reports. Absent ⇒ allowed.
    canPostComments: v.optional(v.boolean()),
    /**
     * Per-user open-bounty cap (D57's deferred bounty lever, built in N2). Absent ⇒ the global
     * `MAX_OPEN_BOUNTIES_PER_DAY`; `0` ⇒ can't post bounties at all. A *number* rather than a boolean
     * on purpose: bounties aren't content, they're requests, so the proportionate lever for someone
     * spamming them is fewer — not none, and certainly not a ban.
     */
    activeBountyPostLimit: v.optional(v.number()),
    contradictionCount: v.optional(v.number()),
    role: literals(USER_ROLES), // mod=content; admin ⊇ mod (D37)
    status: literals(USER_STATUSES), // suspend/ban (D37); deleted (D33)
    statusReason: v.optional(v.string()),
    suspendedUntil: v.optional(v.number()), // temp suspension; null on ban = indefinite (D37)
    moderatedByUserId: v.optional(v.id('profiles')),
    /**
     * When the user asked to be deleted (D62). Distinct from `deletedAt`, which is stamped 30 days
     * later when the tombstone is actually written — this field is the *pending* state, and while
     * it's set the account is **read-only**: it can sign in, read, and cancel, but not contribute
     * (`requireContributor`, D62 amendment). Deliberately not a status value, because `status` is the
     * security gate `requireProfile` applies to **queries** as well, and someone in their grace window
     * has to be able to read the app to change their mind. Absent ⇒ no pending request.
     *
     * The consequence downstream is load-bearing: because nothing new can be posted, a departed user's
     * newest `skateEndTime` can never postdate this stamp, so N5a's erasure sweep is a stage of the
     * finalize chain rather than a deferred per-row schedule.
     */
    deletionRequestedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    /**
     * The season through which this tombstoned account's photos have been expired (D66/N5a) — a
     * **completion marker**, and the thing that makes `sweepDepartedPhotos` terminate.
     *
     * Without it the cron re-paginated every tombstone's whole photo table every day forever, and the
     * cost grew with every departure the app ever had. A tombstone can't gain photos (posting closed
     * at the request), so once a sweep has run for season *S* there is nothing further to do until the
     * boundary turns over — one pass per account per season, not one per account per day.
     *
     * Absent on every account that has never been swept, which is exactly the set the sweep wants
     * first; see the index for why that falls out for free rather than needing a backfill.
     */
    photosExpiredForSeason: v.optional(v.number()),
    /**
     * **A lease on `photoReconcile` for this uploader** — when the current staged run started, absent
     * when none is running.
     *
     * Two jobs need it. It stops a completion marker being written before the work is done: the
     * escalating cron claims the lease, and only the run's *final phase* stamps
     * `photosExpiredForSeason` and releases. A run that dies leaves a lease that goes stale after
     * `PHOTO_RECONCILE_LEASE_MS`, and the next daily tick re-escalates — so a failure costs a day, not
     * a season, and never permanent retention.
     *
     * And it serializes the two reconcile *modes* against each other, which is the sharper reason.
     * Both mutate the same photo rows through a mark → clear → sweep cycle, and both are escalated by
     * daily crons that had no idea whether a previous run was still going. Overlap could interleave
     * one run's `sweep` with another's `mark` and delete a photo the second run had marked but not yet
     * cleared — a *referenced* photo, which is the one mistake this whole area exists to prevent.
     */
    photoReconcileStartedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_clerk_user_id', ['clerkUserId'])
    .index('by_username', ['username'])
    .index('by_status', ['status'])
    /**
     * The departed-photo sweep's work queue (D66/N5a): tombstones that haven't been swept for the
     * current season yet.
     *
     * **This is the one place the non-sparse-index behaviour above is what we want**, and it's worth
     * saying so beside the warning that it's usually a trap. `photosExpiredForSeason` is absent on
     * every account that has never been swept, `undefined` sorts before every number, so a
     * `lt('photosExpiredForSeason', currentSeason)` range returns the never-swept accounts *first* and
     * then the ones last swept in an earlier season. That is precisely the queue, with no backfill and
     * no migration. The sibling index two lines down is the same shape being wrong; the difference is
     * that there the missing rows are ones the sweep must not touch, and here they're the ones it
     * exists to find.
     */
    .index('by_status_photos_expired', ['status', 'photosExpiredForSeason'])
    // The finalize cron's window sweep (D62).
    //
    // **This index is NOT sparse**, and assuming it was nearly deleted every account on dev. A Convex
    // index on an optional field contains the rows that don't have it, with `undefined` sorting
    // *before every number* — so a bare `lte(cutoff)` range matches every profile that never requested
    // deletion. `finalizeDueDeletions` bounds the range from below for exactly this reason; read its
    // comment before touching that query.
    .index('by_deletion_requested_at', ['deletionRequestedAt'])
    // Signups-per-day for the analytics rollup (Phase 7b). The implicit creation order can't be
    // range-scanned to "just this UTC day", so the daily job reads a bounded slice off this instead.
    .index('by_created_at', ['createdAt'])
    // Name search for public profiles (D13). The filter field lets the query exclude private
    // profiles in-index (they're not searchable); exact `@handle` lookups keep using `by_username`.
    .searchIndex('search_profile', {
      searchField: 'displayName',
      filterFields: ['profileVisibility'],
    }),

  /**
   * Short-lived OAuth `state` nonces (Phase 8, Strava).
   *
   * The OAuth callback arrives at an **unauthenticated** HTTP endpoint — there is no Clerk identity on
   * a redirect from Strava — so without this table there would be no way to know *whose* account is
   * being connected, and anyone could bind a Strava account to someone else's profile by replaying a
   * callback URL. So an authenticated mutation mints a single-use nonce bound to the user, and the
   * callback exchanges it. Rows are deleted on use and swept on expiry; nothing here outlives a
   * connect flow by more than a few minutes.
   */
  oauthStates: defineTable({
    state: v.string(), // the opaque nonce echoed back by the provider
    userId: v.id('profiles'),
    provider: literals(ACTIVITY_PROVIDERS),
    /** Where to send the browser afterwards — the app deep link (mobile) or a web route. */
    redirectTo: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_state', ['state'])
    .index('by_expires_at', ['expiresAt']),

  /**
   * A user's link to a third-party activity provider, tokens included.
   *
   * **Write these through `lib/activityConnections`, never with a bare `db.insert` here.** The table is
   * provider-generic, so the temptation for each new integration is to write it from its own file next
   * to its own OAuth flow — which is how the deletion gate got lost the first time (PR #29 review). A
   * connection write is always reached from an action holding a bare `userId` (the user is off at the
   * provider's consent screen, or the write is on the far side of a token refresh), so `requireProfile`
   * never sees it, and D62's erase pass over this table happens exactly once with no later rescan. A
   * redirect landing a second after finalization starts leaves live OAuth credentials for an account
   * that no longer exists — the worst row in the app to leak, since it grants continuing access to
   * someone else's service.
   */
  activityConnections: defineTable({
    userId: v.id('profiles'),
    provider: literals(ACTIVITY_PROVIDERS),
    externalUserId: v.string(), // e.g. Strava athleteId
    accessToken: v.optional(v.string()), // SERVER-ONLY
    refreshToken: v.optional(v.string()), // SERVER-ONLY
    scopes: v.array(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    connectedAt: v.number(),
  }).index('by_user', ['userId']),

  /**
   * A recorded skate — ours (`native`) or, one day, a watch adapter's.
   *
   * Today's only writer is `gpsActivities.record`, which resolves its user through `requireProfile`
   * and is therefore covered by the finalization lock for free. **A provider-ingest writer would not
   * be**, for the same reason `activityConnections` needed its own gate: an ingest holds a bare
   * `userId` handed to it by a webhook or a poll, so nothing in the request path notices that the
   * account is mid-deletion, and the tracks stage passes over this table exactly once. An activity
   * ingested a moment later is an *unpublished* recording — the bucket D62 erases — that would
   * outlive the deletion. If you add one, gate it (`lib/activityConnections.canConnectAccount`).
   */
  gpsActivities: defineTable({
    userId: v.id('profiles'),
    provider: literals(ACTIVITY_PROVIDERS),
    providerActivityId: v.string(), // unique per provider — dedup webhook re-deliveries
    sportType: v.string(),
    startTime: v.number(), // GPS start → report.skateStartTime on convert (D44)
    // Phase 5 prep (wired Phase 8): GPS end → report.skateEndTime. `elapsedSeconds` is the
    // provider's moving/elapsed time — NON-redundant with (end − start) because it excludes
    // pauses/stops. Both optional ⇒ migration-free; no behavior now (GPS ingest is Phase 8).
    endTime: v.optional(v.number()),
    elapsedSeconds: v.optional(v.number()),
    path: v.optional(geoJson), // TRUSTED GPS track = skated extent
    waterBodyId: v.optional(v.id('waterBodies')), // resolved at ingest (D44)
    waterBodyIds: v.optional(v.array(v.id('waterBodies'))), // when a skate spans bodies
    photoUrls: v.optional(v.array(v.string())),
    promptState: literals(ACTIVITY_PROMPT_STATES),
    linkedReportId: v.optional(v.id('reports')),
    detectedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_provider_activity', ['provider', 'providerActivityId']) // unique dedup (D24)
    .index('by_water_body', ['waterBodyId']) // per-lake skate history + bounty eligibility (D44)
    /**
     * The aggregate-tracks layer, season-scoped (N5a/D63).
     *
     * `by_water_body` orders by creation, so bounding the season after a `.take()` would be a filter
     * over the newest 200 *rows* rather than the newest 200 in-season ones: on a lake with more than
     * that in lifetime tracks, last season's would fill the window and this season's would silently
     * not draw. That is the shape of bug N1 spent a phase removing, and the fix is the same one —
     * bound it in the index.
     *
     * `startTime` rather than the linked report's `skateEndTime`, which is what the design says the
     * season is measured by. They differ by the length of one skate, and the boundary is July 1 — the
     * one week of the year no skate spans. Reading the report's field instead would mean fetching
     * every report in the window before knowing which to keep, which is the read this index exists to
     * avoid.
     */
    .index('by_water_body_start_time', ['waterBodyId', 'startTime']),

  waterBodies: defineTable({
    name: v.string(),
    type: literals(WATER_BODY_TYPES),
    source: literals(WATER_BODY_SOURCES),
    externalId: v.optional(v.string()), // OSM/NHD id when source != user
    /**
     * **Who this lake is, in each catalogue that knows it** — as against `externalId`, which is who
     * we happened to import it from.
     *
     * The two are the same string today, and the split exists because that is a coincidence rather
     * than a fact. `externalId` is a *key*: `importCanonical` upserts on it and contour tiles are
     * stamped with it, so it must not move. These are *claims about identity*, and a lake can hold
     * both — most do, once reconciled.
     *
     * **`nhdId` earns its place before any NHD geometry is ever imported.** OSM carries the same lake
     * twice more often than it looks (Long Pond is `way/150404999` at 2,552 acres and
     * `relation/2602300` at 2,532; Lovell Lake, Duncan Lake, Meadow Lake and Bolster Pond are the
     * same shape), and OSM cannot see its own duplicates. NHD can: all five pairs collapse onto a
     * single `Permanent_Identifier`. So this is a reconciliation key first and an import key second.
     *
     * **Reconcile by `polygonIoU`, never by point containment.** Measured, not assumed: North Bay's
     * interior point sits inside NHD's *Moosehead Lake*, so a containment join would give a bay its
     * parent's id and make the two look like duplicates of each other — while Moosehead itself
     * matched nothing at all, because `centroid` is `pointOnFeature` and lands on the shoreline of a
     * large irregular lake (D85 amendment). Both failures are silent.
     */
    osmId: v.optional(v.string()), // `way/<id>` / `relation/<id>`
    nhdId: v.optional(v.string()), // NHD `Permanent_Identifier`
    /**
     * Whose polygon `polygon` actually is — which `source` conflates with where the row came from.
     *
     * Separate so the two can diverge per lake without a migration: a body imported from OSM whose
     * geometry we later take from NHD (Beau Lake, absent from OSM's Maine extract because Geofabrik
     * clips the Québec half) keeps its OSM identity and access layer while drawing from NHD.
     * Absent means "the same as `source`", which is true of every row imported so far.
     */
    geometrySource: v.optional(literals(WATER_BODY_SOURCES)),
    // Admin regions (2-letter US state codes) the body falls in, unioned from the per-state ETL
    // extracts at import — a border-spanning body (Lake Champlain) appears in multiple state
    // extracts and accumulates e.g. ["NY","VT"]. Powers the search-result location label +
    // curatedBoost disambiguation (Phase 2.5). Optional ⇒ migration-free.
    states: v.optional(v.array(v.string())),
    polygon: geoJson, // Polygon / MultiPolygon (rivers: the reach/segment)
    bbox, // prefilter index
    /**
     * The on-water **representative point** (D48) — display, distance and the town stamp.
     *
     * **Renamed from `centroid`, because it never was one** (founder call, 2026-08-02). It comes
     * from Turf's `pointOnFeature`, which returns the bbox centre when that lands inside the polygon
     * and a point on the **boundary** when it does not — so on a curved or narrow lake it sits on
     * the shoreline. Lake Willoughby's is ring vertex 199.
     *
     * **That behaviour is correct and must not be "fixed" into a true centroid.** The area centroid
     * of a crescent lake is on the headland in the middle, i.e. on land — which breaks the on-water
     * guarantee every consumer here relies on. N6b already paid for this lesson: a hand-rolled
     * centroid join missed 4 of 6 real Maine lakes (`scripts/bathymetry/src/join.ts`). The name was
     * the bug, not the maths.
     *
     * Need a point genuinely *inside* the water — ray casting, DEM or weather sampling? Use
     * `interiorPoint`.
     */
    representativePoint: v.optional(latLng),
    /**
     * @deprecated Renamed to `representativePoint`. Kept optional through the transition window so
     * the schema still validates against rows written before the rename; every writer now sets both
     * and `backfillRepresentativePoint` fills the rest. Dropped once that has run everywhere.
     */
    centroid: latLng, // on-water representative point (D48); display + distance, not lookup
    // Weather sampling escape hatch (Phase 10 / D56 §5). Weather doesn't vary below Open-Meteo's grid
    // (~2–25 km), so **every body samples at its centroid by default** — town/county is the wrong
    // abstraction. Only the few genuinely multi-cell giants (Champlain ~200 km) need more: an admin sets
    // a handful of points spaced at grid resolution here, and a hazard/report picks its nearest. Absent /
    // empty ⇒ `[centroid]`. Populated via the Phase 7 admin surface; no auto-population in v1.
    weatherSamplePoints: v.optional(v.array(latLng)),
    /**
     * A point genuinely **inside** the water (N6c / `@skating/core`'s `fetchOrigin`), computed at
     * canonical import from the source geometry.
     *
     * **It exists because `centroid` above is not a centroid.** That field is Turf's
     * `pointOnFeature`, which returns the bbox centre when it lands inside the polygon and a point
     * on the **boundary** when it doesn't — true of any curved or narrow lake. Lake Willoughby's
     * `centroid` is ring vertex 199; Lake Champlain's sits **30.7 km** from mid-lake.
     *
     * **`centroid` is deliberately left as it is**, because a shoreline-ish point is right or
     * better for every consumer it has: drive-time bands (`notifications.ts`, `reports.ts` — you
     * drive to a shore, not to mid-lake) and the town/state stamp a pin-less report inherits. The
     * one consumer it hurt is **weather sampling**, where Open-Meteo's 2–25 km grid makes
     * Champlain's offset one to several cells wrong on an input to the D56 decay math — so
     * `lib/sampling.ts` prefers this field and falls back to `centroid`.
     *
     * Optional ⇒ migration-free; absent on any body not yet re-imported, which is the fallback's
     * whole job.
     */
    interiorPoint: v.optional(latLng),
    surfaceAreaSqM: v.optional(v.number()),
    // ── Derived shape stats (N6c Workstream A / D85) ───────────────────────────────────────────
    // Measured in the ETL transform on the **full-resolution OSM geometry, before `simplify()`** —
    // never on the polygon stored above. Perimeter is resolution-dependent (the coastline paradox),
    // our stored copy is simplified to ~5 m and Champlain is coarsened past that to fit the D48
    // array cap, so measuring what we store under-reports systematically and worst on exactly the
    // big crenellated lakes where the number is most interesting. The stored polygon exists for
    // drawing; these exist for describing. All computed by `@skating/core`'s `lakeGeometry.ts`.
    //
    // No index on any of them: like depth, they are only ever read with a body already in hand.
    // All optional ⇒ migration-free, and `importCanonical` patches an explicit field list.
    /** Total shoreline in metres, **including island rings** — the conventional definition, and
     *  what HydroLAKES' `Shore_len` measures, so D85's free cross-check compares like with like.
     *  Never authoritative (D3): OSM's shoreline is a tracing by many hands. */
    shorelineM: v.optional(v.number()),
    /** Longer side of the minimum-area bounding rectangle, in metres. NOT the hull diameter — see
     *  `lakeAxes`, which documents why the plan's stated method reported 2× the true width. */
    longAxisM: v.optional(v.number()),
    /** The long axis's bearing in `[0, 180)`, clockwise from north. Undirected: an axis has no head. */
    longAxisBearingDeg: v.optional(v.number()),
    /** Shorter side of the same rectangle. With `longAxisM` this is the "about 5 × 1 miles" line. */
    shortAxisM: v.optional(v.number()),
    /** Wind fetch in metres at 16 compass bearings, **indexed by the direction wind blows FROM** —
     *  so the drawer reads `fetchProfileM[fetchBucketFor(windDirection)]` with no arithmetic.
     *  Precomputed because the read-time alternative is geometry on every drawer open. */
    fetchProfileM: v.optional(v.array(v.number())),
    /**
     * Winter (Dec–Mar) wind-frequency rose, 16 sectors summing to 1, indexed by the direction wind
     * blows **from** — the same sectors as `fetchProfileM`, so the two multiply elementwise.
     *
     * **Fetch alone names the wrong direction, which is why this exists.** A direction with five
     * miles of open water that wind never blows from is not an exposed shore. Measured for Lake
     * Willoughby (NREL WTK 2 km, Dec–Mar): a strongly bimodal rose along its NNW–SSE trough — 19.4%
     * SE, 16.1% SSE, 18.6% NW — with the E/NE quadrant blocked by the ridges. That is terrain
     * channelling, and it is invisible to the geometry.
     *
     * Consumed as `frequency × fetch` (`@skating/core`'s `mostExposedSector`). Absent ⇒ the caption
     * says nothing about wind at all, deliberately: falling back to longest-fetch is the claim this
     * field was added to stop making.
     */
    windRose: v.optional(v.array(v.number())),
    /**
     * `v.literal` rather than `literals(WIND_ROSE_SOURCES)` because the helper requires two or more
     * members and there is exactly one source. The field exists anyway, on the D3/D68 principle
     * that a modelled number carries its provenance: if a second downscaling is ever added, every
     * already-stored rose stays attributable instead of becoming ambiguous.
     */
    windRoseSource: v.optional(v.literal(WIND_ROSE_SOURCES[0])),
    // Lake depth (N6a / D68). Best-available value plus **per-measurement** provenance: mean and max
    // routinely come from different rungs of the ladder (LAGOS-US holds 17,675 maxima against 6,137
    // means), so one `depthSource` could not honestly describe both. The ladder itself lives in
    // `@skating/core`'s `lakeDepth.ts` — `operator` beats every automated source and the depth loader
    // refuses to overwrite it; the rest is `state_agency` → `lagos_us` → HydroLAKES (split on `Vol_src`,
    // reported above modelled) → `globathy` → `osm_tag`.
    //
    // No index: depth is only ever read with a body already in hand (the decay cron has the row, so does
    // the drawer and the editor), and nothing selects *by* depth.
    //
    // Two consumers. The decay model reads shallowness as one bit (D69, via `isShallowBody` — depth OR a
    // `shallow_early_thaw` `bodyFeature`), and the clients show both numbers to skaters framed by
    // their source: measured reads plainly, modelled reads as an estimate (D3 — a 90 m-DEM guess must not
    // look like a depth-sounder transect). All optional ⇒ migration-free, and because `importCanonical`
    // patches an explicit field list, depth survives a canonical re-import untouched.
    meanDepthM: v.optional(v.number()),
    maxDepthM: v.optional(v.number()),
    meanDepthSource: v.optional(literals(DEPTH_SOURCES)),
    maxDepthSource: v.optional(literals(DEPTH_SOURCES)),
    // Free-text evidence behind an `operator` depth (D68 amendment, founder call): which agency, which
    // chart, which year. **Public** — it replaces the `operator` rung's own label in the skater-facing
    // caption, because "entered by a moderator" is attribution in name only and "NH Fish & Game, 1998
    // chart" is the thing that makes a hand-entered number checkable.
    //
    // One note per body rather than per measurement, unlike the sources themselves: a moderator reading a
    // chart gets both numbers off the same one, and free text absorbs the rare split ("mean from the 1998
    // chart, max from the 2015 DEC survey") without a second field nobody fills. Cleared when no
    // operator-sourced depth remains, so a note can never outlive the claim it substantiates.
    depthSourceNote: v.optional(v.string()),
    // Lake **surface elevation** (N6c A1) — a real freeze-ORDER signal: a 1,700 ft pond in the
    // Greens is skateable weeks before a valley lake twenty minutes away. One source, not a ladder
    // (see `@skating/core`'s `elevation.ts` for why depth needed five rungs and this needs one),
    // but D68's precedence discipline carries across unchanged: an `operator` value wins and the
    // loader refuses to overwrite it.
    //
    // Sampled at `interiorPoint` rather than `centroid`, because a DEM read taken on a bank is
    // biased upward by the bank. Accurate to ~5% on three of four spot-checked lakes and 20 m high
    // on the fourth — fine for freeze order, which is a hundreds-of-feet question, and the reason
    // the copy must never imply two lakes' elevations are comparable at tens of feet.
    //
    // No index: read only with a body already in hand. Optional ⇒ migration-free, and survives a
    // canonical re-import because `importCanonical` patches an explicit field list.
    elevationM: v.optional(v.number()),
    elevationSource: v.optional(literals(ELEVATION_SOURCES)),
    // Zoom-scored display prominence (D49). `displayScore` = normalize(log area) + `curatedBoost`;
    // `minVisibleZoom` is its integer bucket, ALSO denormalized onto `waterBodyCells` so
    // `listInViewport` filters `minVisibleZoom <= zoom` in-query. All optional ⇒ migration-free;
    // computed on import/create/setCuratedBoost. `curatedBoost` is admin-set (D49), preserved on
    // re-import like the other curation fields.
    displayScore: v.optional(v.number()),
    curatedBoost: v.optional(v.number()),
    minVisibleZoom: v.optional(v.number()),
    createdByUserId: v.optional(v.id('profiles')), // when source == user
    reviewStatus: v.optional(literals(REVIEW_STATUSES)), // source==user only (D37)
    dedupStatus: literals(DEDUP_STATUSES), // default clean (D36)
    mergedIntoId: v.optional(v.id('waterBodies')), // reads follow the survivor (D36)
    duplicateCandidateIds: v.optional(v.array(v.id('waterBodies'))),
    removedAt: v.optional(v.number()), // soft-delist (D48); reversible, cleared on restore
    removedByUserId: v.optional(v.id('profiles')), // the admin who removed it (D48)
    removalReason: v.optional(literals(REMOVAL_REASONS)), // why it was delisted (D48)
    createdAt: v.number(),
  })
    .index('by_dedup_status', ['dedupStatus']) // dedup review queue (D36)
    .index('by_review_status', ['reviewStatus']) // user-body approval queue (D37)
    .index('by_external_id', ['source', 'externalId']) // idempotent canonical upsert (D14/D48)
    // Reconciliation lookups only, and **equality only**. An index on an optional field is not
    // sparse in Convex — every one of the 116,070 rows without an `nhdId` sits at the front under
    // `undefined` — so a bare range scan here would read the whole corpus. `.eq()` is safe; `.lte()`
    // is the trap.
    .index('by_nhd_id', ['nhdId'])
    // The curation list (N2). Until now there was NO index on `curatedBoost` and no query listing
    // boosted bodies — `WaterBodyModeratorControls` edits the boost on a body you already navigated
    // to, and nothing told you which of 116k carry one. The five known Phase-2.5 mis-matches (South
    // Bay, Button Bay, Half Moon Cove, Foster Pond, Mill Pond, all boosted onto same-named lakes
    // elsewhere) were invisible until someone remembered them. A `> 0` range read costs the boosted
    // rows and nothing else: `undefined` sorts before every number, so unboosted bodies are excluded
    // by the range rather than filtered after the read.
    .index('by_curated_boost', ['curatedBoost'])
    .searchIndex('search_name', { searchField: 'name' }), // map search box: full-text lake lookup

  // Which bodies the N6b contour tileset actually draws lines for (N6c-1 / D2).
  //
  // **A side table rather than a flag on `waterBodies`, because contour coverage is a property of
  // the TILESET, not of the body.** Re-tiling replaces ~2,000 rows here instead of migrating 116,070,
  // and a body that drops out of a re-tile cannot leave a stale `true` behind — which is the failure
  // a boolean column invites, and it would be silent: a lake claiming surveyed bathymetry it no
  // longer has.
  //
  // Keyed on `externalId` for the same reason the tiles are (N6b): a Convex `_id` changes if a row
  // is recreated, and re-tiling five states because a re-import churned ids is not a thing we should
  // be one accident away from. That also means coverage survives a canonical re-import untouched.
  //
  // Populated from the built contour features, so it records lakes we actually DREW — 2,022 — not
  // the 2,437 that merely matched the join. A lake whose survey produced no usable line is not a
  // lake with contours.
  bathymetryCoverage: defineTable({
    source: literals(CANONICAL_SOURCES),
    externalId: v.string(),
  }).index('by_external_id', ['source', 'externalId']),

  // Per-state distribution basis for the derived caption (N6c A5). **One row per state**, holding
  // the 10th–90th percentiles of each metric across that state's listed bodies.
  //
  // The obvious alternative — a stored percentile per body — is the wrong shape: a percentile is a
  // property of the corpus, not of the body, so every import would invalidate all 116,070 of them
  // and keeping them true would mean rewriting the corpus on every run. Nobody would, so they would
  // quietly become claims about whenever the pass last finished. Deciles invert that: bodies store
  // nothing, a caption looks the basis up at render time, and re-deriving costs one job.
  //
  // Per state rather than per corpus because "among the deepest lakes we know about" spans five
  // states and is nearly meaningless — Vermont and coastal Maine are different populations. A
  // border-spanning body is counted in each of its `states`, which is correct: Champlain genuinely
  // is among the deepest in both Vermont and New York.
  //
  // A metric is **absent** rather than empty when its sample is too thin (`MIN_DECILE_SAMPLE`), and
  // `decileRankOf` returns null for an absent block — which the caption must read as "say nothing",
  // never as "average".
  regionStats: defineTable({
    state: v.string(), // 2-letter code, matching `waterBodies.states[]`
    metrics: v.object({
      maxDepthM: v.optional(decileBlock),
      meanDepthM: v.optional(decileBlock),
      elevationM: v.optional(decileBlock),
      surfaceAreaSqM: v.optional(decileBlock),
      longAxisM: v.optional(decileBlock),
    }),
    /** Bodies scanned for this state, whether or not they carried any metric — the honest denominator. */
    bodiesScanned: v.number(),
    updatedAt: v.number(),
  }).index('by_state', ['state']),

  // The water-body spatial index (N1) — one row per grid cell a *listed* body's bbox covers, at the
  // ladder level `indexLevelFor` picks (see `lib/cellIndex` / `@skating/core`'s `spatialCells`).
  // Replaces `@convex-dev/geospatial`, whose per-row *point* and read-∝-`maxResults` query shape
  // crashed a wide viewport against Convex's 4,096-read cap. `by_cell`'s trailing `minVisibleZoom`
  // makes the D49 zoom cutoff a *range* on the index — so a wide zoom reads only the bodies it will
  // actually draw, in prominence order — rather than a filter applied after the reads are spent.
  // An unlisted body has no rows at all, which is what makes the listing filter free.
  waterBodyCells: defineTable({
    waterBodyId: v.id('waterBodies'),
    z: v.number(), // ladder level — coarser levels hold bigger / more prominent bodies
    x: v.number(), // cell column, east from -180°
    y: v.number(), // cell row, north from -90°
    minVisibleZoom: v.number(), // denormalized from the body (D49), the in-query zoom cutoff
  })
    .index('by_cell', ['z', 'x', 'y', 'minVisibleZoom'])
    .index('by_body', ['waterBodyId']), // the write-path diff + backfill

  // Named sub-areas (N2 / D60) — a region *inside* one water body, carrying the name skaters
  // actually use for it. "Malletts Bay" is part of Lake Champlain, not a lake beside it: reports,
  // hazards and bounties keep belonging to the **parent**, and the sub-area is the finer name they
  // carry. Minting each bay as its own `waterBodies` row would split one sheet of ice's reports,
  // hazards, bounties, favorites and aggregate tracks across a dozen rows, and hand the D36 dedup
  // queue a permanent stream of parent-vs-child overlap pairs it has no verdict for.
  //
  // This is the **D4 model** (deferred since Phase 1 for rivers-as-named-reaches), instantiated for
  // lakes first, where the corpus evidence is overwhelming: every name the community seed failed to
  // match is a region inside one existing polygon.
  //
  // Two invariants, both enforced at the write boundary rather than assumed:
  //  - **inside its parent by construction** — the drawn shape is clipped to the parent polygon and
  //    the clipped result is stored (Decision 10 / `@skating/core`'s `clipSubAreaToParent`). This is
  //    what keeps moderator drawing consistent with the path-only doctrine: no water body is ever
  //    minted from a drawn shape, and a sub-area's geometry is constrained by an already-trusted one.
  //  - **visible only while its parent is** (Decision 11) — see `waterBodySubAreaCells`.
  waterBodySubAreas: defineTable({
    waterBodyId: v.id('waterBodies'), // parent — required, always an existing body
    name: v.string(), // "Malletts Bay"
    // Corpus spelling variants (S2 found Malletts under ten of them) plus names that share no token
    // with anything — the northeast arm of Champlain is "the Inland Sea" and nothing else.
    aliases: v.optional(v.array(v.string())),
    // `[name, ...aliases]` joined — Convex search indexes ONE field, so the aliases have to be in it
    // for a search to reach them. Denormalized on every name/alias write; never set by a client.
    searchText: v.string(),
    polygon: geoJson, // the CLIPPED shape, inside the parent by construction (Decision 10)
    bbox, // of the clipped polygon — what the cell index covers
    /** The on-water representative point — same `pointOnFeature` basis as a body (D48). */
    representativePoint: v.optional(latLng),
    /** @deprecated Renamed to `representativePoint`; see the note on `waterBodies`. */
    centroid: latLng, // on-water representative point, same `pointOnFeature` basis as a body (D48)
    surfaceAreaSqM: v.number(), // geodesic; also the Decision 9 tie-break (smallest containing wins)
    // Same D49 curve as a body, off the sub-area's own area + boost — so Malletts Bay can label at a
    // regional zoom while a small cove waits for z13, with no second curve to tune. Required (not
    // optional like the body's): this table has no legacy rows, so every write computes them.
    displayScore: v.number(),
    minVisibleZoom: v.number(),
    curatedBoost: v.optional(v.number()),
    createdByUserId: v.id('profiles'), // the moderator who drew it — every write is audited too
    createdAt: v.number(),
    updatedAt: v.number(),
    removedAt: v.optional(v.number()), // soft-delist, reversible — never a hard delete (D48 ethos)
    removedByUserId: v.optional(v.id('profiles')), // absent on a system delist — see below
    // Why the *system* delisted this bay, when no human did (N2). A canonical re-import that refines
    // a shoreline, or a merge onto a survivor with a different outline, can leave a hand-drawn bay no
    // longer inside its parent — Decision 10's "inside by construction" has to survive the parent
    // changing shape, so the bay is delisted rather than kept as geometry that escaped the invariant.
    // A `console.warn` was the only trace of that, which is a log nobody reads; this puts the reason
    // on the row, so `listForBody` carries it into the editor where the redraw actually happens (D5:
    // never silent). Cleared by any write that re-establishes containment — restore or redraw.
    systemDelistReason: v.optional(v.string()),
  })
    // Every non-map read is scoped to a parent already in hand — the report being created knows its
    // `waterBodyId`, the search hit carries its parent, the lake editor is one body. Bounded by the
    // handful of sub-areas one lake has, not by the corpus.
    .index('by_parent', ['waterBodyId'])
    .searchIndex('search_subarea', { searchField: 'searchText' }),

  // The sub-area spatial index (N2) — the third table on N1's shared ladder-grid mechanism, same
  // shape as `waterBodyCells`. It exists because a viewport is not a parent: the map render is the
  // one sub-area read that can't be scoped to a body already loaded, and fanning `by_parent` out over
  // the 1,000 bodies `listInViewport` can return is a read whose input is the render budget. "Sub-
  // areas only exist on a handful of giants" is a fact about today's data, not a bound — which is the
  // exact reasoning N1 exists to retire.
  //
  // **A row exists only while the sub-area is un-delisted AND its parent is listed** (Decision 11).
  // N1's "unlisted means absent" rule is what makes the listing filter free, and a sub-area that
  // outlived its parent's takedown would label a bay on a lake the app no longer has.
  waterBodySubAreaCells: defineTable({
    subAreaId: v.id('waterBodySubAreas'),
    z: v.number(),
    x: v.number(),
    y: v.number(),
    minVisibleZoom: v.number(), // denormalized (D49) — the in-query zoom cutoff, as on body cells
  })
    .index('by_cell', ['z', 'x', 'y', 'minVisibleZoom'])
    .index('by_sub_area', ['subAreaId']),

  // The admin-boundary spatial index (N1), same shape keyed by boundary `level` instead of zoom.
  // Retires `findContainingTown`'s ±0.2° centroid rectangle, which was explicitly sized on the
  // premise that "our towns run well under 0.4° across" — false for the Adirondack towns the
  // Phase-2.5 corpus added, and its failure was *silent* (the label quietly degraded to
  // county+state). A bbox covering has no such premise: containment is exact at any size.
  adminAreaCells: defineTable({
    adminAreaId: v.id('adminAreas'),
    z: v.number(),
    x: v.number(),
    y: v.number(),
    level: v.string(), // town | county | state — resolve asks for one level at a time
  })
    .index('by_cell', ['z', 'x', 'y', 'level'])
    .index('by_area', ['adminAreaId']),

  // Administrative-boundary polygons for point→place labels (Phase 5). A report's `point` (put-in
  // pin / GPS start) resolves against these to `{ town?, county?, state? }`, stamped onto
  // `reports.place` at create. Imported from the same per-state OSM extracts as the water ETL
  // (`boundary=administrative`, admin_level 4/6/7–8; same ODbL). Reused by GPS (Phase 8) + hazards
  // (Phase 9). Small (5 states of towns/counties ≈ single-digit thousands of rows).
  adminAreas: defineTable({
    name: v.string(), // this row's own name — "Burlington" (town) / "Chittenden County" (county)
    level: literals(ADMIN_AREA_LEVELS), // admin granularity
    state: v.string(), // 2-letter code, denormalized onto the label
    externalId: v.string(), // OSM relation id (way/123 · relation/456) — idempotent upsert key
    polygon: geoJson, // boundary
    bbox, // cheap point-containment prefilter before the Turf pointInPolygon test
    /** Representative interior point; display/debug only, never a lookup key (N1). */
    representativePoint: v.optional(latLng),
    /** @deprecated Renamed to `representativePoint`; see the note on `waterBodies`. */
    centroid: latLng, // representative interior point; kept for display/debug, not for lookup (N1)
    createdAt: v.number(),
  })
    // Idempotent re-import upsert key (OSM re-runs), mirroring waterBodies.by_external_id (D14).
    // Containment lookups go through `adminAreaCells`, not a level scan — see `findContainingArea`.
    .index('by_external_id', ['externalId']),

  // Cached Open-Meteo "weather-since" summaries (Phase 10 / D19 / D56). One row per
  // (sample point, window start, current-hour bucket): concurrent viewers of the same body/window share a
  // fetch, and bucketing the `now` end to the hour makes windows append-friendly. Warmed two ways — the
  // strip's drawer-open fetch action and the decay cron (§6) — and read by both. Source is the
  // **forecast API with `past_days`** (recent windows), never the ~5-day-lagged archive (§2). Ephemeral;
  // safe to drop/prune (a miss just refetches).
  weatherCache: defineTable({
    samplePointKey: v.string(), // rounded "lat,lng" — the grid-ish cache key
    windowStartMs: v.number(), // window start, bucketed to the hour (absolute UTC ms)
    windowEndBucketMs: v.number(), // `now` bucketed to the hour — the append-friendly end
    summary: weatherSinceSummary, // the computed reducer output (both consumers read this)
    fetchedAt: v.number(),
  })
    .index('by_key', ['samplePointKey', 'windowStartMs', 'windowEndBucketMs'])
    // Retention sweep (N3). `by_key` is an exact-triple lookup and can't be range-scanned by age, so
    // the pruner reads this instead. Ordering on the *window end* rather than `fetchedAt` is the
    // point: the end bucket is what makes a row reachable at all (see `pruneWeatherCache`).
    .index('by_window_end', ['windowEndBucketMs']),

  reports: defineTable({
    authorId: v.id('profiles'),
    waterBodyId: v.id('waterBodies'),
    point: latLng, // representative point (geo index)
    // When the skater **left the ice** — the primary sort key everywhere (D28; Phase 5 rename of
    // `skateTime`). The freshest read of the ice is the one from whoever got off latest.
    skateEndTime: v.number(),
    // Optional — when they got *on* the ice. Duration is DERIVED (end − start), never stored (Phase 5).
    skateStartTime: v.optional(v.number()),
    // Point-derived location label, stamped at create from `point` (put-in pin / GPS start) via the
    // `adminAreas` resolver — so a multi-town/-state body shows WHICH side the skater put in from
    // (Phase 5). Card reads "{body} · {town or county}, {state}". Optional ⇒ migration-free.
    place: v.optional(
      v.object({
        town: v.optional(v.string()),
        county: v.optional(v.string()),
        state: v.optional(v.string()),
      }),
    ),
    // The named sub-area this report's `point` falls in (N2 / D60), stamped at create by the
    // smallest-containing rule (Decision 9) and re-stamped by `subAreas.restampParent` whenever the
    // parent's sub-areas are redrawn, renamed or delisted. **Flat, not a nested object**, so the
    // bounty gate can index `['subAreaId', 'moderationStatus', 'skateEndTime']` without a dotted
    // path through an optional. `subAreaName` is denormalized for the feed card — a rename is
    // therefore a re-stamp, not just a patch on one row. Absent ⇒ this body has no sub-areas, or the
    // point sits outside all of them (open water on a lake with named bays).
    subAreaId: v.optional(v.id('waterBodySubAreas')),
    subAreaName: v.optional(v.string()),
    reportTime: v.number(), // when submitted (may be later, offline sync)
    source: literals(REPORT_SOURCES),
    activityId: v.optional(v.id('gpsActivities')), // set when source == activity
    // --- Ice description (surface, NOT a safety verdict, D3) ---
    iceTypes: v.array(literals(ICE_TYPES)),
    surfaceTags: v.array(literals(SURFACE_TAGS)),
    skateQuality: v.optional(literals(SKATE_QUALITIES)),
    iceThickness: v.optional(
      v.object({
        readings: v.array(
          v.object({
            valueCm: v.optional(v.number()), // a single reading, OR
            minCm: v.optional(v.number()), // a range
            maxCm: v.optional(v.number()),
            method: literals(THICKNESS_METHODS), // estimated = lower-trust
            coord: v.optional(latLng),
            note: v.optional(v.string()),
          }),
        ),
      }),
    ),
    snowCoverCm: v.optional(v.number()),
    // --- Conditions AT skate time (may be auto-filled from Open-Meteo, D19) ---
    conditions: v.optional(
      v.object({
        airTempC: v.optional(v.number()),
        windSpeedKph: v.optional(v.number()),
        windDir: v.optional(v.string()),
        sky: v.optional(literals(SKY_CONDITIONS)),
        precip: v.optional(literals(PRECIP_TYPES)),
        source: literals(CONDITION_SOURCES),
      }),
    ),
    photoIds: v.array(v.id('photos')),
    notes: v.optional(v.string()),
    // Per-report private-property opt-out (Phase 4, decision #7): when false, the map suppresses the
    // precise put-in pin derived from this report's `point` but keeps the coarse `place` label — we
    // hide a marker, we never scrub location. Default true; optional ⇒ migration-free.
    showPutIn: v.optional(v.boolean()),
    // No visibility field — every report is public (D13). Minors can't create reports (D41).
    // Client-generated dedup key for the mobile offline draft queue (F2/D30): a draft carries one
    // key from capture, so a reconnect flush whose ack was lost can retry `reports.create` and get
    // the same report back instead of a duplicate. Optional ⇒ migration-free (web/online omits it).
    idempotencyKey: v.optional(v.string()),
    moderationStatus: literals(MODERATION_STATUSES), // default visible (D32)
    // Soft "conflicting reports" indicator (Phase 10 / D56 §7): set when another recent report on this
    // body strongly disagreed AND the weather-since didn't explain the change. A disclosure for skaters
    // (both reports show it) so the human judges the disagreement — NOT a trust penalty (D50 stays
    // boost-only) and NEVER hides the report (D3). Absent ⇒ no known conflict. **Symmetric** — both sides
    // of a disagreement carry it.
    conflicting: v.optional(v.boolean()),
    // The escalation half of the contradiction signal (Phase 10 / D56 §7b) — set when this report is the
    // weather-unexplained, **un-corroborated minority** against a *more-corroborated* opposing report. Drives
    // the author's private `contradictionCount`; recomputed each settle, so a report that later earns
    // corroboration clears it (self-correcting, order-independent — never the corroborated majority). NOT a
    // trust penalty, NOT shown to skaters (that's `conflicting`). Absent ⇒ not a settled contradiction.
    contradiction: v.optional(v.boolean()),
    hazardIdsCreated: v.array(v.id('hazards')),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_water_body_skate_end_time', ['waterBodyId', 'skateEndTime'])
    // Per-body feed, paginated (infinite scroll). `moderationStatus` leads so the gate is applied
    // *in* the index (only `visible`, D32) rather than after `paginate` — the same reasoning as the
    // global feed index: a page of all-hidden reports mustn't come back empty with `isDone: false`.
    .index('by_water_body_moderation_and_skate_end_time', [
      'waterBodyId',
      'moderationStatus',
      'skateEndTime',
    ])
    // The sub-area-scoped freshness index (N2 / D60). `moderationStatus` sits in the middle for the
    // same reason as its body-scoped sibling above: the gate's cap has to be spent on rows it will
    // actually weigh, and a post-read `visible` filter lets hidden reports eat it. Sparse — only
    // reports on a lake with named bays carry a `subAreaId` at all.
    .index('by_sub_area_moderation_and_skate_end_time', [
      'subAreaId',
      'moderationStatus',
      'skateEndTime',
    ])
    .index('by_author', ['authorId'])
    // Newest-first author history for the profile page, bounded by a `.take()` on skate-end time so a
    // prolific reporter's page never `.collect()`s an unbounded set (D13).
    .index('by_author_skate_end_time', ['authorId', 'skateEndTime'])
    // The global cross-body newsfeed sort/paginate index — newest skate-end time first (Phase 5, D28).
    // `moderationStatus` leads so `listFeed` filters the moderation gate *in* the index (only
    // `visible`, D32) rather than after `paginate`, which would let a page of all-hidden reports
    // return empty with `isDone: false` and strand the feed on its empty state.
    .index('by_moderation_and_skate_end_time', ['moderationStatus', 'skateEndTime'])
    // Submission-time (not skate-time) day slices for the analytics rollup (Phase 7b). Deliberately
    // NOT the skate-end index: an offline report syncs days after the skate, so "what landed today"
    // and "what ice was skated today" are different questions and the photo-orphan sweep needs the
    // former (a photo is attached at create, whatever the skate time claims).
    .index('by_created_at', ['createdAt'])
    .index('by_idempotency_key', ['idempotencyKey']), // offline-flush dedup (F2/D30)

  comments: defineTable({
    reportId: v.id('reports'),
    parentCommentId: v.optional(v.id('comments')), // null = top-level; set = nested reply
    authorId: v.id('profiles'),
    body: v.string(),
    source: literals(COMMENT_SOURCES),
    moderationStatus: literals(MODERATION_STATUSES),
    editedAt: v.optional(v.number()),
    /**
     * When this comment's text was cleared because its author left (D62 second amendment).
     *
     * The row survives and `body` becomes empty: deleting it would leave a hole in a conversation
     * that isn't the departed author's — the thread is keyed by `reportId` and a reply whose parent
     * vanished is unreachable. So the shell stays, rendered as "this comment was deleted" under the
     * tombstone, which says *why* it is empty rather than leaving a blank row that reads as a bug.
     *
     * A **timestamp rather than a boolean**, and not merely for the audit: `body: ''` is also what an
     * empty draft would produce, and the two must stay distinguishable. Absent ⇒ ordinary comment.
     * Deliberately distinct from `moderationStatus: 'removed'` — a moderator judged that content, and
     * this is nobody judging anything.
     */
    redactedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_report', ['reportId'])
    .index('by_author', ['authorId']), // profile #comments count + enumerate a user's comments (D13)

  hazards: defineTable({
    waterBodyId: v.id('waterBodies'),
    // EXACTLY ONE type (changed from an array in Phase 9): per-type decay (D52), geometry-per-type
    // (D51) and the ridge_crossing verdict relabeling all need an unambiguous type. With an array,
    // "what decay tier is this?" has no answer — ambiguity exactly where the safety math must be
    // exact. Nuance goes in `description`, or in a second hazard.
    type: literals(HAZARD_TYPES),
    geometryKind: literals(HAZARD_GEOMETRY_KINDS), // the authoring primitive (D51)
    geometry: geoJson, // Point | LineString | Polygon (in-polygon draw, D4)
    radiusMeters: v.optional(v.number()), // set when geometryKind == point_radius (D51)
    // Set for line/polygon — the uncertainty half-width. A folded ridge (loose plates 1–15ft each
    // side) buffers far wider than a hairline crack; drives the honest fuzzy render (D3) and sizes
    // the proximity alert buffer. Type-aware default in @skating/core, user-adjustable.
    bufferMeters: v.optional(v.number()),
    bbox, // of the *footprint* (geometry grown by radius/buffer), for proximity prefiltering
    // The footprint intersected with the water-body polygon, stored at create (Phase 9.5) so a big
    // circle near shore can't imply danger across land / a neighbouring lake. Present ONLY when clipping
    // actually removed area; render, the stored bbox, AND the proximity/directional distance all read it
    // when set and fall back to the live footprint when absent — so it's migration-safe (existing rows
    // keep working, and are lazily recomputable) and the drawn halo can never drift from the measured one.
    clippedFootprint: v.optional(geoJson),
    // The named sub-area this hazard's footprint centre falls in (N2 / D60) — same stamp, same
    // re-stamp job, same flat shape as `reports` above, so the hazard reporter line composes through
    // the one `formatLocationLine` helper the feed card uses.
    subAreaId: v.optional(v.id('waterBodySubAreas')),
    subAreaName: v.optional(v.string()),
    createdByUserId: v.id('profiles'),
    // Mobile offline queue (Phase 9 offline / F2/D30): one client-generated key carried across every
    // flush retry, so a create whose ack was lost returns the same hazard instead of dropping a
    // second pin on the same spot. Omitted by web/online callers.
    idempotencyKey: v.optional(v.string()),
    // The pin this skater was shown at draw time and told was a **different** hazard (N5c / D80).
    // Recorded because the nudge promised not to argue: auto-merge is a strictly stronger claim than
    // the nudge's 25 m match, so without this a skater who tapped "no, this is different" could have
    // their pin silently merged a second later — the same argument, held quietly. A moderator can
    // still merge the pair by hand; what this blocks is the machine overruling a person who was
    // standing on the ice looking at it.
    dismissedDuplicateOf: v.optional(v.id('hazards')),
    // MERGE — a fourth axis, and like the other three it means one specific thing (N5c / D80). Set when
    // this pin was folded into another as a duplicate: the survivor carries the warning with the
    // **union** of both footprints, so a merge can never shrink warned area. Mirrors
    // `waterBodies.mergedIntoId` (D36) down to the tombstone-not-delete rule, and `resolveHazardSurvivor`
    // is its hop-capped reader. A moderator `unmerge` clears it and both pins return intact.
    //
    // Confirmations are NEVER re-pointed at the survivor: a confirmation is a named person's statement
    // about a specific pin (D65), and rewriting its `hazardId` would edit that statement. The chain is
    // read through instead.
    mergedIntoHazardId: v.optional(v.id('hazards')),
    // Pins a moderator has separated from this one. Without it, `unmerge` would be a button that undoes
    // nothing — the next create on the same spot would re-merge the pair by the same rule that merged
    // it the first time. Also carries a nudge dismissal forward when a moderator confirms the split.
    noMergeWith: v.optional(v.array(v.id('hazards'))),
    originReportId: v.optional(v.id('reports')), // set when drawn in-report or bundled later (D55)
    description: v.optional(v.string()),
    // Ice hazards are intensely visual and hard to describe ("folded ridges are hard to see" is a
    // recurring cause of death), so photos are the highest-value aid for the next skater. Plural
    // because a ridge or lead often needs two angles; reuses the report photo pipeline (D31/D42).
    photoIds: v.array(v.id('photos')),
    status: literals(HAZARD_STATUSES), // LIFECYCLE: archived (not deleted) so it can resurface
    // MODERATION — a separate axis from `status` on purpose (Phase 9). Archiving means the community
    // voted it healed; hiding means a moderator judged the pin bad. If a mod-hide looked like an
    // archive, abuse would be indistinguishable from a safety verdict (D3).
    moderationStatus: literals(MODERATION_STATUSES),
    healingState: v.optional(literals(HAZARD_HEALING_STATES)), // latest "healing but unsafe" (D52)
    // PROVENANCE — set when a moderator promotes this hazard into a persistent `bodyFeatures` row
    // (D53). It records where the feature came from and **nothing else**.
    //
    // It used to be a visibility axis, and the D53 amendment (N5c) is that it stopped being one: a
    // `bodyFeature` is a standing statement about the lake, a hazard is a sighting by a person on a
    // date, and promotion adds the first without deleting the second — in any season, before or after.
    // Hiding on this field rewrote past winters as winters in which nobody reported anything, blocked
    // the permalink, and blocked confirmation of the one claim that *is* confirmable ("it's here right
    // now", as opposed to "it forms here"). The only reader still filtering on it is
    // `listPromotionCandidates`, where an already-promoted hazard is finished as a *suggestion*.
    // Cleared on demote. Never set `status: archived` for a promotion — that reads as "the community
    // cleared it" (D3).
    promotedToFeatureId: v.optional(v.id('bodyFeatures')),
    firstReportedAt: v.number(),
    lastConfirmedAt: v.number(), // drives the per-type freshness decay (D15/D52)
    confirmCount: v.number(), // "still here" confirms; excludes the author's own (D54 confirm-gate)
    // "It's gone" verdicts: `fully_healed` **and** `never_existed`, which pool because they agree
    // about the present and the map shows the present (D65). This comment said `fully_healed` only,
    // and had been wrong since D65 shipped — a stale comment with a real consequence, because the
    // recurrence job needs `never_existed` counted *separately* (a claim the report was bogus is the
    // opposite of corroboration, where "it healed in March" is a fact about last winter). That job
    // reads `hazardConfirmations` for the split rather than this number.
    goneCount: v.number(),
    // Weather-driven decay (Phase 10 / D56). The decay cron (§6) stores the **time-independent**
    // `decayMultiplier` (NOT a frozen freshness bucket, which would drift between ticks) so the online
    // `toView` recomputes the live bucket, and the offline on-ice payload carries a snapshot. Absent ⇒ 1
    // (fail-open — missing weather never makes a hazard less visible). `snowHidden` is the "possibly
    // snow-covered" caveat (sign-flip 3); `weatherAdjustedAt` gates the cron's per-hazard refresh cadence.
    decayMultiplier: v.optional(v.number()),
    snowHidden: v.optional(v.boolean()),
    weatherAdjustedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_water_body_status', ['waterBodyId', 'status'])
    .index('by_water_body', ['waterBodyId'])
    // D55 auto-bundle: find an author's own unattached hazards on a body to offer into their report.
    .index('by_author_and_water_body', ['createdByUserId', 'waterBodyId'])
    // Phase 10 decay cron: sweep active hazards (across bodies) to refresh weather-adjusted decay,
    // **stalest first**. The trailing `weatherAdjustedAt` is what lets that sweep be capped without
    // starving anyone: on a plain `by_status` scan the cap always returns the same index prefix, so a
    // hazard past it would never be refreshed at all, no matter how many ticks ran (N1, Greptile PR
    // #27). Ascending, `undefined` sorts first — never-refreshed hazards ahead of stale ones — and a
    // refresh moves that hazard to the back of the queue.
    //
    // `moderationStatus` sits in the middle so the sweep's largest exclusion is a *range* rather than
    // a post-read filter. A hidden hazard is never refreshed, so it never gets stamped, so it sorts to
    // the front forever — filtering it in JS means it holds a slot in the cap for good and the rows
    // behind it starve, which is the same bug one level in. Excluded by the index, it costs nothing.
    .index('by_status_moderation_weather_adjusted', [
      'status',
      'moderationStatus',
      'weatherAdjustedAt',
    ])
    .index('by_created_at', ['createdAt']) // per-day hazard volume + photo-orphan sweep (Phase 7b)
    // The recurrence job's corpus walk (N5c / D77). `by_water_body` is creation-ordered and
    // `by_water_body_status` is per body, so neither can answer "every hazard first reported inside
    // this four-season window" — which is the read the once-a-year pass is built on. Keyed on
    // `firstReportedAt` because that is the season clock (D63), the field nobody can move, and the
    // one a cross-season record has to agree with.
    .index('by_first_reported', ['firstReportedAt'])
    // The same pass's **per-body** read, and the reason it is a second index rather than a filter on
    // `by_water_body`: that one is creation-ordered, so bounding the four-season window meant reading
    // *every hazard the lake has ever held* and dropping the old ones in memory. `hazards` never ages
    // out, so that read grows for the life of the app on the busiest lakes — a mutation whose read set
    // is a function of accumulated user-created rows, which is a transaction that eventually cannot
    // commit. With the range on the index the recompute is bounded by *four winters of one lake*
    // instead. (Greptile, PR #35 — the same shape as N1's `listInViewport` and `listPromotionCandidates`
    // before it: the bound has to be in the index, not after it.)
    .index('by_water_body_first_reported', ['waterBodyId', 'firstReportedAt'])
    .index('by_idempotency_key', ['idempotencyKey']) // offline-flush dedup (Phase 9 offline)
    // The merge chain (N5c / D80): every pin folded into one survivor, which is what the union
    // footprint is recomputed from and what `unmerge` walks. An equality read on a field almost every
    // row leaves unset, so it costs nothing to carry and turns "what was merged into this?" from a
    // scan of the body's hazards into a lookup.
    .index('by_merged_into', ['mergedIntoHazardId']),
  // NOTE: no spatial index for hazards (Phase 9 call 6). Hazards are only ever queried per body —
  // the map renders them for the selected lake, the mobile cache stores them per cached body, and the
  // proximity evaluator runs against that same cached set. A third spatial index
  // would re-enter the read-cap fragility that took PRs #10/#11 to fix on `listInViewport`, for no v1
  // benefit. Cross-viewport aggregation belongs to the deferred per-body summary cards.

  hazardConfirmations: defineTable({
    hazardId: v.id('hazards'),
    userId: v.id('profiles'),
    verdict: literals(HAZARD_CONFIRM_VERDICTS), // three-tier (D52) — only fully_healed removes
    atCoord: v.optional(latLng),
    via: literals(HAZARD_CONFIRM_VIA), // trigger (D12)
    createdAt: v.number(),
  })
    .index('by_hazard', ['hazardId'])
    // One confirmation per user per hazard per window — re-confirming updates rather than stacking.
    .index('by_hazard_and_user', ['hazardId', 'userId'])
    // **One verdict's holders, without reading the pin's whole argument** (N5c, Greptile PR #35).
    // The recurrence pass needs "how many distinct users currently say this was never real", and read
    // it by collecting every vote on the hazard and reducing — which on a contested pin is a large,
    // unbounded read to answer a question about a handful of rows. Capping that read was worse than
    // the read: because the row above is patched in place rather than stacked, a row's `verdict` *is*
    // its user's current verdict, so a truncated slice does not give a stale answer, it gives a
    // **wrong** one — decisive votes simply outside the prefix, silently admitting a hazard the
    // community rejected. Keyed on the verdict, the read is a handful of rows and exact.
    .index('by_hazard_and_verdict', ['hazardId', 'verdict'])
    // A user's confirmations across all hazards — the `Watchdog` badge counts distinct *others'*
    // hazards this user has acted on (D50, Phase 6).
    .index('by_user', ['userId'])
    // Per-day confirmation outcomes + age-at-confirmation, the empirical check on the D52 decay
    // table (Phase 7b). Day-sliced so the rollup never re-reads the whole confirmation history.
    .index('by_created_at', ['createdAt']),

  /**
   * Cross-season hazard recurrence (N5c / D77, D78) — *this is what was reported here, and in how many
   * of the last N winters.*
   *
   * **Precomputed, and the asymmetry with within-season clustering is about read bounds rather than
   * taste.** `listForBody` already collects a body's active hazards in one bounded read (Phase 9 call
   * 6), so duplicate clustering is free there and can never go stale. The cross-season read is the
   * opposite: `hazards` never ages out, so "every hazard on this lake across four winters" is a query
   * that grows forever — which is exactly why `listPromotionCandidates` had to be capped at 500 rows
   * mid-review. So recurrence is computed once a year at the rollover and stored here.
   *
   * **Every row is history, never a forecast (D3/D78).** What a row may say is *what was reported, in
   * how many distinct winters, out of how many, and where.* It may not say a hazard is there, will be
   * there, or is likely — and nothing derived from this table ever enters the on-ice payload, feeds
   * `displayScore`, or touches trust, points or the bounty gate.
   */
  hazardRecurrence: defineTable({
    waterBodyId: v.id('waterBodies'),
    // Five families, not the four promotable ones: `volatile` earns a row precisely so D78's raised
    // bar has something to be raised *about*. `crack` is the one family with no cross-season record —
    // a recurring working crack is not a permanent feature of a lake, so there is nothing to be about.
    family: literals(RECURRENCE_FAMILIES),
    // The **representative footprint**: the medoid member's own shape, carried across whole. Not a
    // synthesised average — a promoted cluster should keep the shape of a ridge somebody actually drew,
    // and an averaged line can bend through ice nobody ever marked.
    geometryKind: literals(HAZARD_GEOMETRY_KINDS),
    geometry: geoJson,
    radiusMeters: v.optional(v.number()),
    bufferMeters: v.optional(v.number()),
    bbox,
    // Every contributing hazard — survivors only, since a merge tombstone is represented by the pin it
    // was folded into (D80). This is the diff key: a recompute matches new clusters to existing rows on
    // member overlap rather than on identity, so a cluster that grew by one member is the same cluster
    // and keeps its suppression and its promotion.
    memberHazardIds: v.array(v.id('hazards')),
    // The medoid — the member whose shape the row carries, and the one a promotion records itself
    // against so `demote` has a source hazard to point back at. Stored rather than re-derived, because
    // re-deriving it at promote time could pick a different pin than the one whose geometry is here.
    representativeHazardId: v.id('hazards'),
    // **A season contributes at most one.** Three skaters pinning the same ridge in one January is one
    // winter of evidence; without that rule an enthusiastic week becomes "a pattern". Ascending, deduped,
    // keyed on `seasonOf(firstReportedAt)` — the clock nobody can move (D63).
    seasonsObserved: v.array(v.number()),
    // The denominator, stored rather than derived so a row always renders the fraction it was computed
    // under even after the constant moves. "3 of the last 4 winters" is only honest if both halves came
    // from the same pass.
    windowSeasons: v.number(),
    // The timing window (§C6), as days since July 1 — the interquartile range of members' day-of-season,
    // so one anomalous November sighting can't stretch it across the winter. Rendered widened to whole
    // half-months and never narrower than about three weeks, because a narrow window implies the rest of
    // the season is clear and that is a claim we do not have.
    firstReportedDayOfSeasonP25: v.number(),
    firstReportedDayOfSeasonP75: v.number(),
    // Operator-visible, and deliberately NOT a gate (answered at scoping, question 2): one skater
    // reporting the same ridge every winter on a pond nobody else visits would never promote under a
    // distinct-author requirement — and that is precisely the lake with the least other coverage, so
    // the rule would fail hardest where the feature matters most. Shown, so a false pattern from a
    // single reporter is visible; tunable into a gate later, with data.
    distinctAuthorCount: v.number(),
    suggestedFeatureType: v.optional(literals(BODY_FEATURE_TYPES)),
    priority: v.number(), // the ranking score (§C4) — a queue order for a human, never a probability
    // The place phrase, from the medoid (N2/D60). Absent when the medoid sits in no named sub-area,
    // and then the advisory omits the phrase entirely rather than inventing geography.
    subAreaId: v.optional(v.id('waterBodySubAreas')),
    subAreaName: v.optional(v.string()),
    /**
     * **Stored, not derived** (D78). The alternative ships 1-of-1 clusters over the wire and asks the
     * client not to render them, which is "admin-only if you don't open the network tab". The public
     * read filters on this at the index, so a thin pattern never leaves the server.
     */
    publiclyVisible: v.boolean(),
    computedAt: v.number(),
    computedForSeason: v.number(),
    // Suppression (§7.3): three pins in one cove across three winters that are three people misreading
    // the same shadow. Stops being suggested and stops being publicly advisable, permanently, across
    // recomputes. Reversible; never a delete.
    suppressedAt: v.optional(v.number()),
    suppressedByUserId: v.optional(v.id('profiles')),
    suppressReason: v.optional(v.string()),
    // Set when an operator promoted this cluster into a `bodyFeatures` row. The cluster leaves the
    // suggestion queue but **keeps accumulating members**, because the D53 amendment means skaters go
    // on filing sightings after a promotion and the denominator has to go on meaning something.
    promotedToFeatureId: v.optional(v.id('bodyFeatures')),
    // Set when a recompute could not match this row to any current cluster but had to keep it anyway
    // (it is promoted or suppressed — a human decision that a recomputation must not silently drop).
    staleSince: v.optional(v.number()),
    // Set when the body held more hazards in the window than one recompute will read, so this row's
    // history starts later than the window does. **The denominator is still printed as "of 4 winters"
    // and could now be an undercount**, which is exactly the kind of thing §11 forbids a surface to
    // swallow — so it is stored, shown on the operator card, and warned about in the logs rather than
    // left to look like a complete answer (Greptile, PR #35).
    computedFromPartialHistory: v.optional(v.boolean()),
  })
    .index('by_water_body', ['waterBodyId'])
    // The ranked cross-lake queue (§7.2) — bounded by construction, since it reads this precomputed
    // table and never touches `hazards` or `waterBodies` in bulk (the Phase 7b rule).
    .index('by_computed_season_and_priority', ['computedForSeason', 'priority'])
    // The skater-facing read. `publiclyVisible` sits in the key so the bar is applied *at the index*
    // rather than after the read — the difference between "admin-only" and "admin-only unless you look".
    .index('by_water_body_public', ['waterBodyId', 'publiclyVisible']),

  /**
   * The recurrence job's scratch queue (N5c / §C4).
   *
   * The job has two phases and Convex allows **one `.paginate()` per function execution**, which makes
   * "discover the bodies, then process them" a hard structural requirement rather than a style choice.
   * Phase one pages `hazards.by_first_reported` across the window and drops one row here per distinct
   * body; phase two takes one row per call, recomputes that body **completely**, and deletes the row.
   *
   * A table rather than an array threaded through scheduler arguments, because the array is unbounded
   * in exactly the case that matters: a corpus where lots of lakes have hazards is the corpus this pass
   * was built for, and an argument that grows with it would fail at the worst time.
   *
   * `claimedAt` is the **lease**. It bounds overlap between runs rather than protecting a single body's
   * recompute — that is one transaction and therefore atomic — and a stale lease is taken over rather
   * than respected, since the alternative to a wrong retry here is a body that is never recomputed at
   * all. The lesson Greptile taught this repo twice on PR #31: a marker written at schedule time is a
   * lie about completion.
   */
  recurrenceQueue: defineTable({
    waterBodyId: v.id('waterBodies'),
    runForSeason: v.number(),
    claimedAt: v.optional(v.number()),
    // **How many times this body has been handed to a recompute**, and it is counted in a *different*
    // transaction from the one that does the work — which is the whole point of it. A recompute that
    // exceeds a backend limit rolls its transaction back, taking any counter incremented inside it with
    // it, so the same body would be picked first on every subsequent run and the annual queue would
    // stall there permanently. Claiming and computing are therefore two mutations: the claim commits
    // whatever the compute then does.
    attempts: v.optional(v.number()),
    // Set when a body has failed `MAX_BODY_ATTEMPTS` times and is being stepped over so the rest of the
    // corpus can drain. Never deleted — a lake the pass cannot compute is a thing an operator should be
    // able to find, and a silently dropped row would present as "this lake has no patterns".
    skippedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    // The dedup on insert: one row per body per run, however many pages the body's hazards span.
    .index('by_season_and_body', ['runForSeason', 'waterBodyId'])
    // The sweep that clears an abandoned run's leftovers.
    .index('by_season', ['runForSeason'])
    // **Phase two's "what is left", answered by the index rather than scanned for** (Greptile, PR #35).
    //
    // It used to `.take(200)` and `.find()` an eligible row in that slice — which is only "the next
    // body" if no 200-row prefix is ineligible. Skipped rows are *retained on purpose*, and claimed
    // rows stay until their lease expires, so a prefix of exactly that kind is the expected end state
    // of a bad run: past 200 of them the scan found nothing, scheduled nothing, and every body behind
    // them went unrecomputed for the year. The same shape as `listRecentMerges` (§16.3) and
    // `by_status_moderation_weather_adjusted` — a predicate applied *after* a fixed read is a
    // starvation bug, not a filter.
    //
    // Both exclusions ride the key instead. `skippedAt` is an equality on `undefined` — indexes over
    // optional fields are not sparse, so "unset" is a real indexed value — and `claimedAt` ascending
    // puts unclaimed rows (`undefined` sorts first) ahead of claimed ones, oldest claim next. So the
    // *first* row is either eligible or proof that nothing is: if the oldest claim is still inside its
    // lease, every remaining claim is too.
    .index('by_season_skipped_claimed', ['runForSeason', 'skippedAt', 'claimedAt']),

  // Known seasonal water-body hazards — persistent, NOT decayed, no confirmation loop (D53).
  // Springs/current, constrictions and bridges/narrows are weaker every season regardless of cold, and
  // some pressure ridges reform in the same place annually. Making users re-mark them is busywork and
  // a false-negative risk: an un-re-marked spring looks "gone". Promotion/demotion are admin actions
  // (Phase 7 surface); v1 ships schema + rendering + the mutations.
  bodyFeatures: defineTable({
    waterBodyId: v.id('waterBodies'),
    type: literals(BODY_FEATURE_TYPES),
    geometryKind: literals(HAZARD_GEOMETRY_KINDS), // same authoring primitives as hazards (D51)
    geometry: geoJson, // Point | LineString | Polygon
    radiusMeters: v.optional(v.number()), // point_radius
    // line/polygon uncertainty half-width — a promoted `recurring_pressure_ridge` is a LineString and
    // must keep the ridge's real width, exactly like the hazard it came from (else it renders hairline).
    bufferMeters: v.optional(v.number()),
    bbox,
    note: v.optional(v.string()),
    addedByUserId: v.id('profiles'), // admin/moderator — promotion is an admin action (D37/D53)
    promotedFromHazardId: v.optional(v.id('hazards')),
    active: v.boolean(), // demotion flips this off (reversible, never hard-deleted)
    createdAt: v.number(),
  }).index('by_water_body_active', ['waterBodyId', 'active']),

  // No `follows` table (D13): the social graph was removed. Reports are all public — the only
  // relationship that narrows access is a block (below).

  blocks: defineTable({
    blockerId: v.id('profiles'),
    blockedId: v.id('profiles'),
    createdAt: v.number(),
  })
    .index('by_blocker', ['blockerId'])
    .index('by_blocked', ['blockedId']),

  contentFlags: defineTable({
    flaggerId: v.id('profiles'),
    targetType: literals(FLAG_TARGET_TYPES),
    targetId: v.string(), // ref into the matching table
    reason: literals(FLAG_REASONS),
    note: v.optional(v.string()),
    status: literals(FLAG_STATUSES),
    resolvedByUserId: v.optional(v.id('profiles')), // a moderator or admin (D37)
    // Auto-flag bundling (N2) — see `lib/autoFlag.ts`. A recurring system-generated problem bumps a
    // count on its open row instead of filing an identical one; a recurrence *after* a resolution
    // files a NEW row carrying the count forward and pointing back, because flipping a terminal row
    // open again would retroactively change a past day's flag-resolution count in the 7b rollup that
    // `by_status_resolved_at` serves. All optional ⇒ migration-free; absent `occurrences` reads as 1.
    occurrences: v.optional(v.number()),
    lastOccurrenceAt: v.optional(v.number()),
    supersedesFlagId: v.optional(v.id('contentFlags')),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index('by_status', ['status'])
    .index('by_target', ['targetType', 'targetId'])
    // Departed-user redaction (`lib/contentPurge`): clear the free-text `note` on every flag this
    // person filed. Nothing else needs to look a flag up by its filer — the queue reads by status and
    // by target — so this index exists solely so that sweep can be a bounded equality read instead of
    // a scan of a table that grows forever.
    .index('by_flagger', ['flaggerId'])
    // Auto-flag bundling's lookup (N2): "is there an OPEN flag for this (target, reason), and what
    // was the most recent terminal one?" `by_target` alone can't answer that under a cap, and why is
    // worth writing down — it's the `lib/scan.ts` trap in a place where the cap *decides* something.
    // Terminal rows accumulate forever on a chronically-flagged target, and they pile up on **both
    // sides** of the open row: scanning ascending buries it under old dispositions, scanning
    // descending buries it under new ones. Either way the bump silently becomes a duplicate filing at
    // `occurrences: 1`, resetting the count on exactly the contributor the mechanism exists to track.
    // `status` and `reason` in the key turn both halves into equality reads, so no cap is involved in
    // the decision at all — `reason` earns its place because open rows are NOT one-per-target (user
    // flags dedupe per flagger, so a much-flagged report carries one per reporter).
    .index('by_target_status_reason', ['targetType', 'targetId', 'status', 'reason'])
    // Analytics (Phase 7b): flags *filed* on a day, and flags *resolved* on a day. The resolution
    // index is keyed by status first so the rollup reads only terminal rows in the day's range —
    // `actioned`/`dismissed` accumulate forever, and a scan of all of them would grow without bound.
    .index('by_created_at', ['createdAt'])
    .index('by_status_resolved_at', ['status', 'resolvedAt']),

  moderationActions: defineTable({
    /**
     * The moderator/admin who acted — **absent when the system did** (N5c / D80).
     *
     * Auto-merge writes rows here, deliberately: a mechanism that folds one safety pin into another
     * without leaving an audit row is a mechanism nobody can check, and this one is explicitly meant
     * to be watched before it is trusted. But it has no human actor, and putting the *creating
     * skater* here would name a member as having taken a moderation action they never took. Absent is
     * the honest value, and "no actor" reads as "automatic" everywhere it is rendered.
     *
     * `by_actor` is only ever an equality read for a specific moderator, so an unset value simply
     * never matches — no sparse-index trap here (the `lte`-on-optional problem needs a range).
     */
    actorId: v.optional(v.id('profiles')),
    action: literals(MODERATION_ACTIONS),
    targetType: literals(MODERATION_TARGET_TYPES),
    targetId: v.string(),
    reason: v.string(), // required — accountability for appeals/reversals
    metadata: v.optional(v.any()), // e.g. prior/new state, mergedIntoId, suspendedUntil
    createdAt: v.number(),
  })
    .index('by_target', ['targetType', 'targetId'])
    .index('by_actor', ['actorId'])
    // The 7b rollup's day slice (N5c). Auto-merge is the one mechanism that changes a row without a
    // human, and its unmerge rate is the only empirical check on the bar — which means counting merges
    // per day, which means reading this table by time. Without the index that is a scan of an
    // append-only audit log, i.e. the exact unbounded-growth shape the Phase 7b rule forbids.
    .index('by_created_at', ['createdAt']),

  supportTickets: defineTable({
    userId: v.optional(v.id('profiles')), // absent when the Clerk user has no profile row yet
    // The submitter's Clerk subject — always present (`create` requires an authenticated identity) and
    // stamped even when `userId` is absent, so the per-submitter rate limit works pre-provisioning.
    clerkUserId: v.optional(v.string()),
    category: literals(SUPPORT_CATEGORIES),
    body: v.string(),
    status: literals(SUPPORT_STATUSES),
    assignedToUserId: v.optional(v.id('profiles')),
    context: v.optional(
      v.object({
        appVersion: v.optional(v.string()),
        platform: v.optional(v.string()),
        deviceModel: v.optional(v.string()),
        sentryEventId: v.optional(v.string()), // link to the crash/error (D29)
      }),
    ),
    resolvedByUserId: v.optional(v.id('profiles')),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index('by_status', ['status'])
    // Rate-limit lookup: how many tickets this submitter filed inside the window.
    .index('by_clerk_user_created', ['clerkUserId', 'createdAt'])
    // Analytics (Phase 7b): volume by category on a day, and resolution latency for tickets closed
    // that day — same bounded-by-status shape as `contentFlags` above.
    .index('by_created_at', ['createdAt'])
    .index('by_status_resolved_at', ['status', 'resolvedAt']),

  bounties: defineTable({
    requesterId: v.id('profiles'),
    waterBodyId: v.id('waterBodies'),
    // Optionally narrowed to a named sub-area (N2 / D60). "Someone skate Malletts Bay" is a
    // materially different ask from "someone skate Champlain," and that difference is most of why
    // bounties on a giant are weak today: a report from the far end fulfilled them.
    //
    // **Id only, no denormalized name** — unlike `reports.subAreaName`. The denorm exists on reports
    // because the global feed would otherwise need a join per card on its hottest read; bounties are
    // read in sets of at most a couple hundred, so resolving the name costs one `get` and keeps a
    // rename from needing a third table in the re-stamp job.
    subAreaId: v.optional(v.id('waterBodySubAreas')),
    windowHours: v.number(), // "skated in last 24/48h" (tunable)
    status: literals(BOUNTY_STATUSES),
    rewardPoints: v.number(), // cosmetic (D17)
    fulfillingReportIds: v.array(v.id('reports')),
    // When the requester's helpful thumb flipped this to `fulfilled` (Phase 7b). Stamped so the
    // time-to-fulfillment histogram — the chart that says whether DEFAULT_BOUNTY_LIFETIME_MS is
    // anywhere near the real answer time — has an end point; `status` alone only says *that* it
    // happened. Optional ⇒ migration-free, and forward-only: bounties fulfilled before this shipped
    // carry no timestamp and are simply absent from the histogram rather than guessed at.
    fulfilledAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index('by_water_body_status', ['waterBodyId', 'status'])
    // Trailing-window outcome funnel for the analytics rollup (Phase 7b).
    .index('by_created_at', ['createdAt'])
    // Global expiry sweep (`open → expired` past `expiresAt`, decision 12). The body-keyed index above
    // can't drive a global sweep without a full scan, so the cron reads `by_status_expires`.
    .index('by_status_expires', ['status', 'expiresAt'])
    // The requester's own bounties by status — the rolling daily-open cap counts their open ones
    // (decision 7) and `myBounties` lists them.
    .index('by_requester_status', ['requesterId', 'status']),

  // Polymorphic helpful/unhelpful thumb (D50 decision 4). The SAME one-vote-per-user thumbs UI + rule
  // apply to both reports and hazards, so the target is a `(targetType, targetId)` discriminator rather
  // than a hard `reportId`. Dev has zero rating rows, so this is a pure schema swap (no legacy backfill).
  reportRatings: defineTable({
    targetType: literals(RATING_TARGET_TYPES), // 'report' | 'hazard'
    targetId: v.string(), // a `reports` or `hazards` id (typed by `targetType`)
    raterId: v.id('profiles'), // any viewer (D50) — often, but not only, the bounty requester
    bountyId: v.optional(v.id('bounties')),
    verdict: literals(RATING_VERDICTS),
    createdAt: v.number(),
  })
    // Tally a target's thumbs (helpful/unhelpful counts, auto_low_quality routing).
    .index('by_target', ['targetType', 'targetId'])
    .index('by_rater', ['raterId'])
    // Enforce one rating per (rater, target) via a point lookup on this compound index (D50).
    .index('by_rater_target', ['raterId', 'targetType', 'targetId']),

  photos: defineTable({
    storageId: v.string(), // Convex file storage ref (optimized full image, D31)
    thumbStorageId: v.string(), // ~400px thumbnail (D31)
    uploaderId: v.id('profiles'),
    caption: v.optional(v.string()),
    takenAt: v.optional(v.number()), // preserved from EXIF only if user opts in (D42)
    coord: v.optional(latLng), // preserved only if placeOnMap == true (D42)
    placeOnMap: v.boolean(), // opt-in: pin at coord vs. report-only (D42)
    createdAt: v.number(),
    /**
     * Scratch mark for `photoReconcile` — the determinate orphan check for an uploader too prolific
     * for the one-shot scan (`REFERENCE_SCAN_CAP`). Set on every candidate, cleared by anything that
     * references it, and whatever is still marked at the end is provably unreferenced.
     *
     * Transient by design: it is meaningful only between the phases of one reconcile run, and every
     * run sets it fresh. Absent ⇒ not currently under consideration, which is why it needs no
     * migration and no index — the sweep pages `by_uploader` and reads the flag in memory.
     */
    orphanCandidate: v.optional(v.boolean()),
    /**
     * The same scratch mark for `photoReconcile`'s **season-expiry** mode (D66/N5a) — a departed
     * skater's photos, where the question is "is this named by a *hazard*" rather than "is this named
     * by anything".
     *
     * Its own field rather than sharing `orphanCandidate`, because the two runs answer different
     * questions over the same rows and both crons fire daily: a shared flag would let the orphan
     * pass's `reports` phase clear a mark the season pass set, and a photo on a surviving report is
     * exactly the one the season rule expires. Interleaving would fail toward *keeping* rather than
     * deleting, which is the safe direction — but "safe by accident, in a delete path" is not a
     * property worth relying on when a second optional boolean removes the interleaving entirely.
     *
     * Transient in the same way: meaningful only between the phases of one run, absent otherwise, no
     * migration and no index.
     */
    seasonExpiryCandidate: v.optional(v.boolean()),
  })
    .index('by_uploader', ['uploaderId'])
    // Day-sliced orphan sweep (Phase 7b): a photo abandoned between upload and attach is invisible
    // today, and the number decides whether the deferred GC cron is worth building.
    .index('by_created_at', ['createdAt']),

  /**
   * A requested data export (D33/D62, N3) — one row per request, the bundle itself in file storage.
   *
   * A **table** rather than a fire-and-forget action because assembling the bundle is asynchronous and
   * fallible, and the user needs somewhere to look. It's also the only durable record that a bundle
   * exists at all, which is what lets the hygiene cron find and expire it: a stored blob with no row
   * pointing at it is precisely the orphan class this phase exists to stop creating.
   *
   * `expiresAt` is not a nicety. An export is the densest concentration of one person's data in the
   * system — every report, every track, every photo, in one downloadable file — so it is deliberately
   * short-lived rather than sitting in storage forever.
   */
  dataExports: defineTable({
    userId: v.id('profiles'),
    status: literals(DATA_EXPORT_STATUSES),
    storageId: v.optional(v.string()), // set once the bundle lands
    sizeBytes: v.optional(v.number()),
    photoCount: v.optional(v.number()), // photos whose bytes are embedded
    // Photos left out because the bundle hit its byte budget. Surfaced, never silent — the Phase 7
    // "no silent caps" rule applies hardest to a file someone will treat as their complete record.
    omittedPhotoCount: v.optional(v.number()),
    error: v.optional(v.string()),
    emailedAt: v.optional(v.number()), // absent ⇒ never sent (Resend unprovisioned, or it failed)
    /**
     * How many times reclaiming this bundle's blob has failed (PR #29 review).
     *
     * Exists because the row is the **only pointer** to a stored bundle: deleting it after a failed
     * `storage.delete` strands the single densest PII artifact in the system with nothing left to find
     * it by. So a failed reclaim keeps the row and counts, and crossing the threshold pages a human
     * with the `storageId` rather than quietly giving up. Absent ⇒ 0.
     */
    cleanupAttempts: v.optional(v.number()),
    requestedAt: v.number(),
    readyAt: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_expires_at', ['expiresAt']),

  notifications: defineTable({
    userId: v.id('profiles'), // recipient
    type: literals(NOTIFICATION_TYPES),
    payload: v.any(), // e.g. reportId / hazardId / bountyId / actorUserId
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_user', ['userId']),

  pointEvents: defineTable({
    userId: v.id('profiles'),
    delta: v.number(),
    reason: literals(POINT_EVENT_REASONS),
    refId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    // Count a report's corroborators for the recommended feed (Phase 6 Step 5): `report_corroborated`
    // rows carry `refId = the corroborated report`, so a per-ref lookup tallies them without a scan.
    .index('by_ref', ['refId'])
    // Point-source composition over a trailing window (Phase 7b) — the chart that says whether
    // POINT_WEIGHTS lets volume masquerade as trust.
    .index('by_created_at', ['createdAt']),

  // Place-based curation (Phase 4, decision #1) — the D13 stand-in for the removed people-follow
  // graph. A user favorites specific water bodies: those reports notify by default, boost + badge in
  // the feed, and highlight on the map. Indexed both directions — `by_user` for the viewer's set,
  // `by_water_body` for the notification fan-out ("who favorited this lake?").
  waterBodyFavorites: defineTable({
    userId: v.id('profiles'),
    waterBodyId: v.id('waterBodies'),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_water_body', ['waterBodyId'])
    // Point lookup + uniqueness for `toggle`/`isFavorite` (one row per user×body).
    .index('by_user_water_body', ['userId', 'waterBodyId']),

  // Routable put-in markers (Phase 4, decision #7). `derived` markers are materialized by clustering
  // visible report points (approximate — a report `point` can be mid-lake); `official` markers are
  // admin-set (accurate, priority styling — the operator UI is Phase 7, the data + mutations land
  // here). A moderator `hide` writes a `hidden` row at the coord so the suppression outlives
  // re-clustering (decision #7). Indexed by body for the per-lake marker list + directions target.
  putIns: defineTable({
    waterBodyId: v.id('waterBodies'),
    coord: latLng,
    source: literals(PUTIN_SOURCES),
    originReportId: v.optional(v.id('reports')), // the report a derived marker came from
    status: literals(PUTIN_STATUSES), // hidden = moderator-suppressed coord
    createdByUserId: v.optional(v.id('profiles')), // the admin/mod who set official / hid it
    createdAt: v.number(),
  }).index('by_water_body', ['waterBodyId']),

  // Outbound-notification coalescing queue (Phase 4, decision #4). `reports.create` enqueues one row
  // per candidate recipient×bucket; a row coalesces per `(user, body, kind)` (bumping `count` +
  // `latestReportId` instead of stacking). The `flushNotificationQueue` cron drains rows whose
  // `flushAfter` has passed — the 8pm-ET digest is just a `flushAfter` set to the next 8pm; favorites/
  // great use a short debounce. `coalesceKey` seeds the eventual APNs collapse-id / Android tag.
  notificationQueue: defineTable({
    userId: v.id('profiles'),
    waterBodyId: v.id('waterBodies'),
    kind: literals(NOTIFICATION_QUEUE_KINDS),
    type: literals(NOTIFICATION_TYPES), // the `notifications.type` this flushes to
    coalesceKey: v.string(), // `${userId}:${waterBodyId}:${kind}` — collapse-id / tag seed
    latestReportId: v.id('reports'),
    count: v.number(), // how many reports coalesced into this pending push
    flushAfter: v.number(), // earliest delivery time (next 8pm for digest; debounce for fav/great)
    createdAt: v.number(),
  })
    .index('by_flush', ['flushAfter'])
    .index('by_coalesce', ['coalesceKey'])
    // Deletion erases a departing user's pending pushes (D62). Without this the finalize job would
    // have to scan the whole queue to find one person's rows — and it would still be wrong to leave
    // them, since flushing a queued digest to a tombstone is a notification nobody can read.
    .index('by_user', ['userId']),

  // ───────────────────────────────────────────────────────────────────────────
  // Analytics (Phase 7b / D37). Two tables, shaped to keep every chart's read cost independent of
  // the corpus — the `listInViewport` lesson (PRs #10/#11) applied before it can bite: charts read
  // pre-aggregated rows, never the live corpus. See `@skating/core` `metrics.ts` for the vocabulary.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One row per **bounty-create attempt**, appended by the create gate (Phase 7b, forward-only).
   *
   * The rejections are the point. `bounties.create` decides whether a lake already has fresh eyes by
   * comparing each recent report's age against a window that stretches with the author's trust and
   * the report's thumbs — and there is no way to know whether that window is set right without seeing
   * the attempts it blocked. So the gate records its verdict *and its inputs*: the (age, window) pair
   * is one dot on the scatter the roadmap asks for (dots above the line = blocked), and
   * `weatherReopened` is the numerator of the weather-reopen rate that says whether
   * BOUNTY_REOPEN_FREEZING/THAW_DEGREE_HOURS ever fire at all.
   *
   * `requesterId` is retained deliberately (founder call, 2026-07-24): a cap-hit *rate* tunes the cap,
   * but only attribution answers whether a handful of requesters account for all of it — the
   * empirical case for or against the deferred per-user `activeBountyPostLimit` lever (D57). It's
   * operator-only data of the same sensitivity as `moderationActions`, and the daily cron prunes rows
   * past the retention window so it can't accumulate a permanent behavioural record.
   */
  bountyGateEvents: defineTable({
    waterBodyId: v.id('waterBodies'),
    requesterId: v.id('profiles'),
    decision: literals(BOUNTY_GATE_DECISIONS),
    /** The report the verdict turned on — the blocker when suppressed, the closest call when allowed. */
    decidingReportId: v.optional(v.id('reports')),
    /** Age in hours of `decidingReportId` at the attempt — the scatter's x. Absent ⇒ no recent report. */
    reportAgeH: v.optional(v.number()),
    /** The freshness window actually applied to it, after trust/thumbs weighting — the scatter's y. */
    appliedWindowH: v.optional(v.number()),
    netThumbs: v.optional(v.number()),
    trustClass: v.optional(v.string()), // the deciding report author's class; absent ⇒ no class
    /** Did the weather pass clear a report that would otherwise have suppressed this attempt (D56)? */
    weatherReopened: v.boolean(),
    /**
     * The open-bounty cap actually applied to this attempt (N2). Recorded so 7b's cap-hit-rate chart
     * can't confuse "the global cap is too tight" with "this one user is restricted" — without it, a
     * handful of restricted users would read as evidence to loosen the cap for everyone. Absent on
     * rows written before the per-user limit existed.
     */
    appliedLimit: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_created_at', ['createdAt']) // the charts' bounded window read + the retention prune
    .index('by_water_body', ['waterBodyId']),

  /**
   * Per-user rate-limit bookkeeping for the client analytics signal (Phase 7b). `recordClientSignal`
   * is the one metric a browser reports directly (the future-skate rejection the server never sees),
   * so — like `supportTickets` — it needs a per-submitter window cap to keep one caller from inflating
   * an advisory chart. One row per accepted bump; the daily prune drops rows past the window, so this
   * never accumulates. Deliberately NOT a metric input itself — it only gates the bump.
   */
  clientSignalEvents: defineTable({
    userId: v.id('profiles'),
    signal: v.string(),
    createdAt: v.number(),
  })
    .index('by_user_created', ['userId', 'createdAt']) // the per-user window rate-limit lookup
    .index('by_created_at', ['createdAt']), // the daily retention prune

  /**
   * The pre-aggregated numbers every chart reads — one row per `(metric, date)` (UTC day).
   *
   * Two writers, never mixed on one metric (see `metrics.ts`): **counters** are bumped at the event
   * site, because the event leaves no trace to sweep for later (a weather-explained contradiction is
   * a `continue`); **rollups** are computed once a day by the cron, because the source rows are still
   * there and can be re-derived. `scalar` / `buckets` / `meta` are the three payload shapes, chosen by
   * the metric's spec, so the chart layer renders from the shape rather than special-casing each key.
   */
  metricSnapshots: defineTable({
    metric: v.string(), // a `MetricKey` from @skating/core — validated on write, not in the schema
    date: v.string(), // 'YYYY-MM-DD' UTC; lexicographic order == chronological, so a range is an index range
    scalar: v.optional(v.number()),
    buckets: v.optional(v.array(v.number())),
    meta: v.optional(v.any()), // small labelled record: a funnel, a composition, a per-type table
    updatedAt: v.number(),
  })
    // Point lookup for the upsert + the per-metric date-range read every chart makes.
    .index('by_metric_date', ['metric', 'date']),

  /**
   * One row per ETL run — the durable version of the summary every loader used to print to a
   * terminal that scrolls (N6c Workstream F2).
   *
   * **The question this exists to answer is "how did the last import go", and the sharper one
   * underneath it: "which bodies did it decline, and why".** Every loader we have (`etl`,
   * `admin-areas`, `lake-depth`, `wind-climate`, `bathymetry`) already computes a genuinely useful
   * summary — match rate, rejects by reason, overrides held, contested merges — and then throws it
   * away. Nothing was ever wrong with the numbers; there was simply nowhere to put them, so
   * coverage regressions between runs were invisible by construction.
   *
   * **One row per run, never one per body.** An 8k-row audit trail per run is a different feature
   * with a different cost, and the per-body question is already answered by the depth/elevation
   * provenance stored on the row itself. `failures` is therefore a *bounded sample* and
   * `failuresTotal` is the honest count beside it — a truncated list that doesn't say it was
   * truncated reads as "only three lakes failed", which is the specific lie this table exists to
   * stop telling.
   *
   * **`stages` is the full path, and it is the point.** A run is not one step: an archived
   * Geofabrik extract → an `osmium` filter → a tested transform → a batched load. Each stage
   * carries whatever provenance it actually has — the source URL, the build date, the sha256 the
   * archive verified, the exact command, the counts in and out — so an operator can trace a body
   * on the map back to the byte range of a file with a checksum. Recording only the last stage
   * would answer "how many rows landed" and never "landed from what".
   *
   * **`campaignId` groups the runs that were one operation.** Five state extracts are five loader
   * invocations and five rows, but they are one canonical update, and "how did the last import go"
   * is a question about the update rather than about Vermont.
   */
  importRuns: defineTable({
    kind: literals(IMPORT_RUN_KINDS),
    /** Human label for the run — 'VT canonical water', 'winter wind roses'. */
    label: v.string(),
    /** Operator-supplied grouping for runs that were one logical operation. */
    campaignId: v.optional(v.string()),
    /** Resolved target, recorded verbatim so a prod run is never mistaken for a dev one. */
    deployment: v.string(),
    isProd: v.boolean(),
    status: literals(IMPORT_RUN_STATUSES),
    startedAt: v.number(),
    /** Absent while `status` is 'running' — including for a run whose process was killed. */
    finishedAt: v.optional(v.number()),
    /**
     * Named tallies, deliberately free-form: each loader names its own (`inserted`, `updated`,
     * `matched`, `unmatched`, `cellsFetched`). A fixed column set would have to be the union of
     * five loaders' vocabularies and would still be wrong for the sixth.
     */
    counts: v.array(v.object({ name: v.string(), value: v.number() })),
    stages: v.array(
      v.object({
        name: v.string(),
        detail: v.optional(v.string()),
        /** The command as run, so the path is reproducible rather than merely described. */
        command: v.optional(v.string()),
        input: v.optional(v.string()),
        output: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        bytes: v.optional(v.number()),
        sha256: v.optional(v.string()),
        md5: v.optional(v.string()),
        /** Whether the archive verified the publisher's checksum at fetch time. */
        checksumVerified: v.optional(v.boolean()),
        /** When the *stage's input* was produced (an extract's build date), not when it ran. */
        sourceAt: v.optional(v.number()),
        counts: v.optional(v.array(v.object({ name: v.string(), value: v.number() }))),
      }),
    ),
    /** Bounded sample — see `failuresTotal` for the real count. */
    failures: v.array(
      v.object({
        stage: v.string(),
        /** Whatever identifies the item: an `externalId`, a grid cell, a state code. */
        key: v.optional(v.string()),
        reason: v.string(),
      }),
    ),
    failuresTotal: v.number(),
    /**
     * What share of what it *could* have covered, this run actually did — and where the rest went.
     *
     * **A rate, not a count, because a count cannot be wrong.** "9,981 bodies stamped" reads as a
     * complete pass whether the corpus is 10,000 or 116,070; only a denominator makes a shortfall
     * visible. Every loader here already knew its rate and printed it to a terminal.
     *
     * **`omissions` must account for the gap, and the UI checks that it does.** `eligible - covered`
     * minus the omission counts is rendered as *unexplained* when it isn't zero — which is the
     * difference between "we skipped 4,000 lakes below the HydroLAKES area floor" (a documented
     * limit of the source) and "4,000 lakes went missing and nobody noticed" (a bug). Those two look
     * identical in a totals-only summary, and they are the two readings that matter most.
     */
    coverage: v.optional(
      v.object({
        /** What is being counted — 'bodies', 'lakes', 'grid cells', 'towns'. */
        unit: v.string(),
        /** The honest denominator: everything this pass could in principle have stamped. */
        eligible: v.number(),
        /** What it actually stamped. */
        covered: v.number(),
        /** Where the difference went, by reason. Documented limits belong here, not in prose. */
        omissions: v.array(v.object({ reason: v.string(), count: v.number() })),
      }),
    ),
    /** The error that ended the run, when `status` is 'failed'. */
    error: v.optional(v.string()),
    notes: v.optional(v.array(v.string())),
  })
    // The admin list: newest first, optionally narrowed to one loader.
    .index('by_started', ['startedAt'])
    .index('by_kind_started', ['kind', 'startedAt'])
    .index('by_campaign', ['campaignId', 'startedAt']),
});
