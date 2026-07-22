/**
 * Convex schema — the app's core entities, mirroring `plans/06-data-model.md`.
 *
 * Shared vocabulary comes from `@skating/core` (single source of truth); backend-only
 * enums come from `./lib/enums`. Point/bbox/GeoJSON fields are defined here, but the
 * spatial *indexes* (`@convex-dev/geospatial`) are layered on later (D5) — see README.
 *
 * Identity split (D26): **Clerk owns the auth user**; we own a `profiles` row per
 * user holding all domain data (display, prefs, role, status, reputation). The two
 * are tied by `profiles.clerkUserId` (= Clerk `identity.subject`), and every other
 * entity references a user by their **`profiles._id`** (`authorId`, `userId`, …).
 * This renames the doc's `users` table to `profiles`; update 06-data-model.md to match.
 */

import {
  CONDITION_SOURCES,
  HAZARD_TYPES,
  ICE_TYPES,
  PRECIP_TYPES,
  PROFILE_VISIBILITIES,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  USER_ROLES,
  USER_STATUSES,
  WATER_BODY_TYPES,
} from '@skating/core';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  ACTIVITY_PROMPT_STATES,
  ACTIVITY_PROVIDERS,
  ADMIN_AREA_LEVELS,
  BODY_FEATURE_TYPES,
  BOUNTY_STATUSES,
  COMMENT_SOURCES,
  DEDUP_STATUSES,
  FLAG_REASONS,
  FLAG_STATUSES,
  FLAG_TARGET_TYPES,
  HAZARD_CONFIRM_VERDICTS,
  HAZARD_CONFIRM_VIA,
  HAZARD_GEOMETRY_KINDS,
  HAZARD_HEALING_STATES,
  HAZARD_STATUSES,
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
import { bbox, boolFlags, geoJson, latLng, literals } from './lib/validators';

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
    notificationPrefs, // every type toggleable (D16)
    dateOfBirth: v.number(), // UTC-midnight epoch ms; age gate (≥16) + minor status (<18) DERIVED (D41)
    riskAckVersion: v.optional(v.string()), // assumption-of-risk accepted (D45)
    riskAckAt: v.optional(v.number()),
    reputationPoints: v.number(), // cosmetic/reputational only (D17)
    // Denormalized lifetime contribution counts — the true #reports/#comments a public profile shows
    // (D13). Maintained incrementally on the create / author-remove / moderation paths so the profile
    // read never `.collect()`s an author's full history just to count it (the earlier windowed count
    // capped at PROFILE_HISTORY_LIMIT). Count only currently-**visible** content. Optional ⇒
    // migration-free; new profiles start at 0 and `backfillContributionCounts` seeds existing rows.
    reportCount: v.optional(v.number()),
    commentCount: v.optional(v.number()),
    badges: v.optional(v.array(v.string())),
    role: literals(USER_ROLES), // mod=content; admin ⊇ mod (D37)
    status: literals(USER_STATUSES), // suspend/ban (D37); deleted (D33)
    statusReason: v.optional(v.string()),
    suspendedUntil: v.optional(v.number()), // temp suspension; null on ban = indefinite (D37)
    moderatedByUserId: v.optional(v.id('profiles')),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_clerk_user_id', ['clerkUserId'])
    .index('by_username', ['username'])
    .index('by_status', ['status'])
    // Name search for public profiles (D13). The filter field lets the query exclude private
    // profiles in-index (they're not searchable); exact `@handle` lookups keep using `by_username`.
    .searchIndex('search_profile', {
      searchField: 'displayName',
      filterFields: ['profileVisibility'],
    }),

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
    .index('by_water_body', ['waterBodyId']), // per-lake skate history + bounty eligibility (D44)

  waterBodies: defineTable({
    name: v.string(),
    type: literals(WATER_BODY_TYPES),
    source: literals(WATER_BODY_SOURCES),
    externalId: v.optional(v.string()), // OSM/NHD id when source != user
    // Admin regions (2-letter US state codes) the body falls in, unioned from the per-state ETL
    // extracts at import — a border-spanning body (Lake Champlain) appears in multiple state
    // extracts and accumulates e.g. ["NY","VT"]. Powers the search-result location label +
    // curatedBoost disambiguation (Phase 2.5). Optional ⇒ migration-free.
    states: v.optional(v.array(v.string())),
    polygon: geoJson, // Polygon / MultiPolygon (rivers: the reach/segment)
    bbox, // prefilter index
    centroid: latLng, // geospatial point index (D5)
    // Outlier flag for the two-tier `listInViewport` (D5): a body whose bbox spans more than the
    // centroid prefilter's margin can have its centroid off-screen while its bbox fills the view,
    // so it's queried by a direct short-list scan instead of the centroid index. Derived from
    // bbox extent at import/create; see `waterBodies.listInViewport`.
    isLarge: v.optional(v.boolean()),
    surfaceAreaSqM: v.optional(v.number()),
    // Zoom-scored display prominence (D49). `displayScore` = normalize(log area) + `curatedBoost`;
    // `minVisibleZoom` is its integer bucket, ALSO written as the geospatial `sortKey` so
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
    .index('by_is_large', ['isLarge']) // large-body short list for listInViewport tier 2 (D5)
    .searchIndex('search_name', { searchField: 'name' }), // map search box: full-text lake lookup

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
    centroid: latLng, // geospatial point index (like waterBodies.centroid)
    createdAt: v.number(),
  })
    .index('by_level', ['level'])
    // Idempotent re-import upsert key (OSM re-runs), mirroring waterBodies.by_external_id (D14).
    .index('by_external_id', ['externalId']),

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
    .index('by_author', ['authorId'])
    // Newest-first author history for the profile page, bounded by a `.take()` on skate-end time so a
    // prolific reporter's page never `.collect()`s an unbounded set (D13).
    .index('by_author_skate_end_time', ['authorId', 'skateEndTime'])
    // The global cross-body newsfeed sort/paginate index — newest skate-end time first (Phase 5, D28).
    // `moderationStatus` leads so `listFeed` filters the moderation gate *in* the index (only
    // `visible`, D32) rather than after `paginate`, which would let a page of all-hidden reports
    // return empty with `isDone: false` and strand the feed on its empty state.
    .index('by_moderation_and_skate_end_time', ['moderationStatus', 'skateEndTime'])
    .index('by_idempotency_key', ['idempotencyKey']), // offline-flush dedup (F2/D30)

  comments: defineTable({
    reportId: v.id('reports'),
    parentCommentId: v.optional(v.id('comments')), // null = top-level; set = nested reply
    authorId: v.id('profiles'),
    body: v.string(),
    source: literals(COMMENT_SOURCES),
    moderationStatus: literals(MODERATION_STATUSES),
    editedAt: v.optional(v.number()),
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
    createdByUserId: v.id('profiles'),
    // Mobile offline queue (Phase 9 offline / F2/D30): one client-generated key carried across every
    // flush retry, so a create whose ack was lost returns the same hazard instead of dropping a
    // second pin on the same spot. Omitted by web/online callers.
    idempotencyKey: v.optional(v.string()),
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
    // SUPERSESSION — a third axis, distinct from both `status` and `moderationStatus` (D53). Set when
    // an admin promotes this hazard into a persistent `bodyFeatures` row: the feature now carries the
    // warning, so the hazard stops rendering, but this must NOT be done by setting `status: archived`,
    // which reads as "the community cleared it" (D3). Cleared on demote, so the hazard resurfaces.
    promotedToFeatureId: v.optional(v.id('bodyFeatures')),
    firstReportedAt: v.number(),
    lastConfirmedAt: v.number(), // drives the per-type freshness decay (D15/D52)
    confirmCount: v.number(), // "still here" confirms; excludes the author's own (D54 confirm-gate)
    goneCount: v.number(), // "fully healed & safe" verdicts ONLY — never "healing but unsafe" (D52)
    createdAt: v.number(),
  })
    .index('by_water_body_status', ['waterBodyId', 'status'])
    .index('by_water_body', ['waterBodyId'])
    // D55 auto-bundle: find an author's own unattached hazards on a body to offer into their report.
    .index('by_author_and_water_body', ['createdByUserId', 'waterBodyId'])
    .index('by_idempotency_key', ['idempotencyKey']), // offline-flush dedup (Phase 9 offline)
  // NOTE: no geospatial index for hazards (Phase 9 call 6). Hazards are only ever queried per body —
  // the map renders them for the selected lake, the mobile cache stores them per cached body, and the
  // proximity evaluator runs against that same cached set. A third @convex-dev/geospatial instance
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
    .index('by_hazard_and_user', ['hazardId', 'userId']),

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
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index('by_status', ['status'])
    .index('by_target', ['targetType', 'targetId']),

  moderationActions: defineTable({
    actorId: v.id('profiles'), // the moderator/admin who acted
    action: literals(MODERATION_ACTIONS),
    targetType: literals(MODERATION_TARGET_TYPES),
    targetId: v.string(),
    reason: v.string(), // required — accountability for appeals/reversals
    metadata: v.optional(v.any()), // e.g. prior/new state, mergedIntoId, suspendedUntil
    createdAt: v.number(),
  })
    .index('by_target', ['targetType', 'targetId'])
    .index('by_actor', ['actorId']),

  supportTickets: defineTable({
    userId: v.optional(v.id('profiles')), // null if submitted pre-auth
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
  }).index('by_status', ['status']),

  bounties: defineTable({
    requesterId: v.id('profiles'),
    waterBodyId: v.id('waterBodies'),
    windowHours: v.number(), // "skated in last 24/48h" (tunable)
    status: literals(BOUNTY_STATUSES),
    rewardPoints: v.number(), // cosmetic (D17)
    fulfillingReportIds: v.array(v.id('reports')),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index('by_water_body_status', ['waterBodyId', 'status']),

  reportRatings: defineTable({
    reportId: v.id('reports'),
    raterId: v.id('profiles'), // any viewer (D50) — often, but not only, the bounty requester
    bountyId: v.optional(v.id('bounties')),
    verdict: literals(RATING_VERDICTS),
    createdAt: v.number(),
  })
    .index('by_report', ['reportId'])
    .index('by_rater', ['raterId'])
    // Enforce one rating per (rater, report) via a point lookup on this compound index (D50).
    .index('by_rater_report', ['raterId', 'reportId']),

  photos: defineTable({
    storageId: v.string(), // Convex file storage ref (optimized full image, D31)
    thumbStorageId: v.string(), // ~400px thumbnail (D31)
    uploaderId: v.id('profiles'),
    caption: v.optional(v.string()),
    takenAt: v.optional(v.number()), // preserved from EXIF only if user opts in (D42)
    coord: v.optional(latLng), // preserved only if placeOnMap == true (D42)
    placeOnMap: v.boolean(), // opt-in: pin at coord vs. report-only (D42)
    createdAt: v.number(),
  }).index('by_uploader', ['uploaderId']),

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
  }).index('by_user', ['userId']),

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
    .index('by_coalesce', ['coalesceKey']),
});
