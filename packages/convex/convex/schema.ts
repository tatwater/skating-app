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
  HAZARD_TYPES,
  ICE_TYPES,
  PRECIP_TYPES,
  PROFILE_VISIBILITIES,
  RATING_TARGET_TYPES,
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
  BOUNTY_GATE_DECISIONS,
  BOUNTY_STATUSES,
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
import { bbox, boolFlags, geoJson, latLng, literals, weatherSinceSummary } from './lib/validators';

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
    // Admin regions (2-letter US state codes) the body falls in, unioned from the per-state ETL
    // extracts at import — a border-spanning body (Lake Champlain) appears in multiple state
    // extracts and accumulates e.g. ["NY","VT"]. Powers the search-result location label +
    // curatedBoost disambiguation (Phase 2.5). Optional ⇒ migration-free.
    states: v.optional(v.array(v.string())),
    polygon: geoJson, // Polygon / MultiPolygon (rivers: the reach/segment)
    bbox, // prefilter index
    centroid: latLng, // on-water representative point (D48); display + distance, not lookup
    // Weather sampling escape hatch (Phase 10 / D56 §5). Weather doesn't vary below Open-Meteo's grid
    // (~2–25 km), so **every body samples at its centroid by default** — town/county is the wrong
    // abstraction. Only the few genuinely multi-cell giants (Champlain ~200 km) need more: an admin sets
    // a handful of points spaced at grid resolution here, and a hazard/report picks its nearest. Absent /
    // empty ⇒ `[centroid]`. Populated via the Phase 7 admin surface; no auto-population in v1.
    weatherSamplePoints: v.optional(v.array(latLng)),
    surfaceAreaSqM: v.optional(v.number()),
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
    // The curation list (N2). Until now there was NO index on `curatedBoost` and no query listing
    // boosted bodies — `WaterBodyModeratorControls` edits the boost on a body you already navigated
    // to, and nothing told you which of 116k carry one. The five known Phase-2.5 mis-matches (South
    // Bay, Button Bay, Half Moon Cove, Foster Pond, Mill Pond, all boosted onto same-named lakes
    // elsewhere) were invisible until someone remembered them. A `> 0` range read costs the boosted
    // rows and nothing else: `undefined` sorts before every number, so unboosted bodies are excluded
    // by the range rather than filtered after the read.
    .index('by_curated_boost', ['curatedBoost'])
    .searchIndex('search_name', { searchField: 'name' }), // map search box: full-text lake lookup

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
    goneCount: v.number(), // "fully healed & safe" verdicts ONLY — never "healing but unsafe" (D52)
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
    .index('by_idempotency_key', ['idempotencyKey']), // offline-flush dedup (Phase 9 offline)
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
    // A user's confirmations across all hazards — the `Watchdog` badge counts distinct *others'*
    // hazards this user has acted on (D50, Phase 6).
    .index('by_user', ['userId'])
    // Per-day confirmation outcomes + age-at-confirmation, the empirical check on the D52 decay
    // table (Phase 7b). Day-sliced so the rollup never re-reads the whole confirmation history.
    .index('by_created_at', ['createdAt']),

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
});
