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
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  USER_ROLES,
  USER_STATUSES,
  VISIBILITY_LEVELS,
  WATER_BODY_TYPES,
} from '@skating/core'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import {
  ACTIVITY_PROMPT_STATES,
  ACTIVITY_PROVIDERS,
  BOUNTY_STATUSES,
  COMMENT_SOURCES,
  DEDUP_STATUSES,
  FLAG_REASONS,
  FLAG_STATUSES,
  FLAG_TARGET_TYPES,
  FOLLOW_STATUSES,
  HAZARD_CONFIRM_VERDICTS,
  HAZARD_CONFIRM_VIA,
  HAZARD_STATUSES,
  MODERATION_ACTIONS,
  MODERATION_STATUSES,
  MODERATION_TARGET_TYPES,
  NOTIFICATION_PREF_KEYS,
  NOTIFICATION_TYPES,
  POINT_EVENT_REASONS,
  RATING_VERDICTS,
  REMOVAL_REASONS,
  REPORT_SOURCES,
  REVIEW_STATUSES,
  SUPPORT_CATEGORIES,
  SUPPORT_STATUSES,
  WATER_BODY_SOURCES,
} from './lib/enums'
import { bbox, boolFlags, geoJson, latLng, literals } from './lib/validators'

/** Per-type notification toggles; keys single-sourced to mirror `notifications.type` 1:1 (D16). */
const notificationPrefs = boolFlags(NOTIFICATION_PREF_KEYS)

export default defineSchema({
  profiles: defineTable({
    clerkUserId: v.string(), // ties this profile to its Clerk auth user (identity.subject)
    displayName: v.string(),
    username: v.string(), // unique, for search/follow
    homeCoord: v.optional(latLng), // PRIVATE — filter input only (D11); set at onboarding
    homeTownLabel: v.optional(v.string()), // optional PUBLIC label (D11)
    driveTimePrefMinutes: v.number(), // e.g. 30/60/90 (D18)
    cachedIsochrone: v.optional(geoJson), // recomputed on home/pref change (D18)
    cachedIsochroneAt: v.optional(v.number()),
    requireFollowApproval: v.boolean(), // account-level (D13)
    notificationPrefs, // every type toggleable (D16)
    dateOfBirth: v.number(), // UTC-midnight epoch ms; age gate (≥16) + minor status (<18) DERIVED (D41)
    riskAckVersion: v.optional(v.string()), // assumption-of-risk accepted (D45)
    riskAckAt: v.optional(v.number()),
    reputationPoints: v.number(), // cosmetic/reputational only (D17)
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
    .index('by_status', ['status']),

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
    startTime: v.number(), // becomes report.skateTime if converted
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

  reports: defineTable({
    authorId: v.id('profiles'),
    waterBodyId: v.id('waterBodies'),
    point: latLng, // representative point (geo index)
    skateTime: v.number(), // WHEN THEY SKATED — primary sort key everywhere
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
    visibility: literals(VISIBILITY_LEVELS), // D13; DEFAULT derived per D41
    moderationStatus: literals(MODERATION_STATUSES), // default visible (D32)
    hazardIdsCreated: v.array(v.id('hazards')),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_water_body_skate_time', ['waterBodyId', 'skateTime'])
    .index('by_author', ['authorId']),

  comments: defineTable({
    reportId: v.id('reports'),
    parentCommentId: v.optional(v.id('comments')), // null = top-level; set = nested reply
    authorId: v.id('profiles'),
    body: v.string(),
    source: literals(COMMENT_SOURCES),
    moderationStatus: literals(MODERATION_STATUSES),
    editedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_report', ['reportId']),

  hazards: defineTable({
    waterBodyId: v.id('waterBodies'),
    type: v.array(literals(HAZARD_TYPES)),
    geometry: geoJson, // Point | LineString | Polygon (in-polygon draw, D4)
    bbox, // for proximity queries
    createdByUserId: v.id('profiles'),
    originReportId: v.optional(v.id('reports')),
    description: v.optional(v.string()),
    status: literals(HAZARD_STATUSES), // archived (not deleted) so it can resurface
    firstReportedAt: v.number(),
    lastConfirmedAt: v.number(), // drives the freshness decay (D15)
    confirmCount: v.number(),
    goneCount: v.number(),
    createdAt: v.number(),
  })
    .index('by_water_body_status', ['waterBodyId', 'status'])
    .index('by_water_body', ['waterBodyId']),

  hazardConfirmations: defineTable({
    hazardId: v.id('hazards'),
    userId: v.id('profiles'),
    verdict: literals(HAZARD_CONFIRM_VERDICTS),
    atCoord: v.optional(latLng),
    via: literals(HAZARD_CONFIRM_VIA), // trigger (D12)
    createdAt: v.number(),
  }).index('by_hazard', ['hazardId']),

  follows: defineTable({
    followerId: v.id('profiles'),
    followeeId: v.id('profiles'),
    status: literals(FOLLOW_STATUSES), // pending only when followee requires approval
    createdAt: v.number(),
  })
    .index('by_follower', ['followerId'])
    .index('by_followee', ['followeeId']),

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
    raterId: v.id('profiles'), // typically the bounty requester
    bountyId: v.optional(v.id('bounties')),
    verdict: literals(RATING_VERDICTS),
    createdAt: v.number(),
  })
    .index('by_report', ['reportId'])
    .index('by_rater', ['raterId']),

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
})
