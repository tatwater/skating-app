# Data model

Conceptual schema for the app's core entities. Notation is schema-flavored
pseudocode (`field: type`), **not** final Convex code — it's for us to react to.
Convex-specific notes (indexes, geospatial component) are at the bottom.

Guiding constraints from `01-decisions.md`:
- **Safety framing (D3):** no field asserts ice is "safe." Reports are observations;
  quality tags describe *skating surface*, not a go/no-go verdict.
- **Reports attach to whole water bodies + optional in-polygon hazard geometry (D4).**
- **Canonical (OSM/NHD) and user-created locations live in one table (D14).**
- **Hazards are their own entity with a lifecycle (D15).**
- **4-level visibility (D13); real drive-time via cached isochrone (D18).**

> ✅ **VOCABULARY CONFIRMED.** The ice-type / surface / hazard enums below use the
> community's official terms from the **Nordic Skater** reference site
> (<https://nordicskaters.squarespace.com/>), which the alpha crew uses even
> colloquially.

---

## Entities

### `profiles`  (was `users` in the original model — renamed in implementation, see note)
```
_id
clerkUserId: string         // ties this profile to its Clerk auth user (= identity.subject)
displayName: string
username: string            // unique, for search/follow
homeCoord: { lat, lng }     // PRIVATE — filter input only (D11)
homeTownLabel?: string      // optional PUBLIC label on profile (D11)
driveTimePrefMinutes: number // e.g. 30 / 60 / 90 (D18)
cachedIsochrone?: geojson   // polygon; recomputed on home/pref change (D18)
cachedIsochroneAt?: timestamp
requireFollowApproval: boolean // account-level (D13)
notificationPrefs: {         // per-type toggles — EVERY type is toggleable (D16)
  activityDetected,          // ice-skate detected on ANY linked provider (D24)
  bountyRequest, followedPostedNearby,
  hazardConfirmation, bountyFulfilled, newFollower,
  reportRated,               // someone rated your report helpful/unhelpful (D17)
  contentFlagResolved: boolean
}                            // keys mirror notifications.type 1:1 (D16 invariant)
minAge16Attested: boolean    // age gate at signup (D41); no birthdate stored
isMinor: boolean             // self-attested under 18 → protective visibility default (D41)
riskAckVersion?: string      // assumption-of-risk acknowledgment accepted (D45)
riskAckAt?: timestamp
reputationPoints: number     // cosmetic/reputational only (D17)
badges?: string[]
role: enum(member, moderator, admin)  // mod=content; admin ⊇ mod + bans/roles/PII (D32/D37)
status: enum(active, suspended, banned, deleted)  // suspend/ban = D37; deleted = D33
statusReason?: string          // mod-visible; optionally surfaced to the user (D37)
suspendedUntil?: timestamp      // temp suspension; null on a ban = indefinite (D37)
moderatedByUserId?: ref(profiles)  // who set the current suspend/ban state (D37)
deletedAt?: timestamp
createdAt: timestamp
```
> **Renamed `users` → `profiles` in implementation (D26).** Clerk owns the auth user;
> this table is the domain profile that *mirrors* it, tied by `clerkUserId` (=
> Clerk `identity.subject`). Every `ref(profiles)` below is a profile `_id`, never a
> Clerk id. `clerkUserId` + its `by_clerk_user_id` index are the additions the original
> `users` model didn't spell out; the auth wiring lives in `convex/auth.config.ts`
> (registers Clerk as the Convex identity provider) and `convex/profiles.ts`
> (`current`, `upsertFromClerk`). The rest of this doc still reads `ref(profiles)` for
> clarity even though the pseudocode predates the rename.
> **Deletion (D33):** on delete, set `status: deleted` and scrub PII (displayName →
> "deleted user", drop `homeCoord`/`homeTownLabel`). Authored public/followers/friends
> reports & comments are **anonymized, not erased** (preserve the ice record);
> `just_me` content is removed. Users can also **export** their data.
> **Ban/suspend (D37):** Convex is the source of truth — every function gates on
> `status`; **also lock the account in Clerk** so no new session issues. A ban
> preserves the account (appeal/reversal) — distinct from deletion, which scrubs PII.
> A suspension (`suspendedUntil` set) auto-lapses back to `active` once the time passes.

### `activityConnections`  (a user's linked GPS providers; provider-agnostic, all six v1 — D24)
```
_id
userId: ref(profiles)
provider: enum(strava, garmin, coros, polar, apple_health, google_health_connect, other)
externalUserId: string       // e.g. Strava athleteId
accessToken?, refreshToken?: string  // SERVER-ONLY; provider auth models differ
scopes: string[]
tokenExpiresAt?: timestamp
connectedAt: timestamp
```
> One row per (user, provider). Provider-specific auth/webhook details live in
> `04-integrations.md`. All six providers are v1-scoped and the schema is
> provider-agnostic (D24); they simply **ship in a fast-follow order** —
> Strava + Apple HealthKit first, Garmin next, then COROS / Polar / Google Health
> Connect — so every skater's device can contribute a **trusted** GPS path.

### `gpsActivities`  (detected ice skates from any provider; dedup + trusted path)
```
_id
userId: ref(profiles)
provider: enum(strava, garmin, coros, polar, apple_health, google_health_connect, other)
providerActivityId: string   // unique per provider — dedup webhook re-deliveries
sportType: string            // provider's ice-skate type (e.g. Strava "IceSkate")
startTime: timestamp         // becomes report.skateTime if converted
path?: geojson               // TRUSTED GPS track = skated extent (+ hazard proximity, Q11)
waterBodyId?: ref(waterBodies)   // resolved at ingest from path (D44) — the lake this skate was on
waterBodyIds?: ref(waterBodies)[] // when a skate spans connected bodies; waterBodyId = primary
photoUrls?: string[]         // provider-dependent + subject to provider ToS
promptState: enum(pending, prompted, converted, dismissed)
linkedReportId?: ref(reports)
detectedAt: timestamp
```
> **Water-body resolution (D44):** at ingest, spatially match `path` against
> `waterBodies` (bbox prefilter → Turf.js, the D5/D36 machinery) and store the
> resolved `waterBodyId` so skates are findable **by lake identity/name**, not by
> drawing a geospatial box ("5 miles on *Lake Morey*", not "5 miles somewhere here").
> If the path matches no known body, fall back to the D14/D36 create-or-attach flow.

### `waterBodies`  (canonical + user-created, unified per D14)
```
_id
name: string
type: enum(lake, pond, river, stream, reservoir, bay, marsh, other)
source: enum(osm, nhd, user)
externalId?: string          // OSM/NHD id when source != user
polygon: geojson             // Polygon / MultiPolygon (rivers: the reach/segment)
bbox: { minLat, minLng, maxLat, maxLng }  // prefilter index
centroid: { lat, lng }       // geospatial point index
surfaceAreaSqM?: number      // from NHD/OSM, or estimated for user shapes
createdByUserId?: ref(profiles) // when source == user
reviewStatus?: enum(pending, approved, rejected)  // source==user only; auto-visible then review-after (D37)
dedupStatus: enum(clean, suspected_duplicate, merged)  // default clean (D36)
mergedIntoId?: ref(waterBodies)       // set when merged; reads follow the survivor
duplicateCandidateIds?: ref(waterBodies)[]  // cached suspects for the review queue
createdAt: timestamp
```
> Rivers: model as **segments/reaches** (D4). A long river = multiple `waterBodies`
> rows (or one row per named reach), so reports/hazards attach to the right stretch.
> **Dedup (D36):** match on create (bbox prefilter → Turf IoU / point-in-polygon +
> name similarity) to steer users onto an existing body; suspects get
> `suspected_duplicate` + `duplicateCandidateIds`. A confirmed merge **re-points
> child reports/hazards/bounties** to the survivor and soft-tombstones the loser
> (`merged` + `mergedIntoId`) — never hard-deleted, so bad merges reverse. Rivers
> compared by buffered-line overlap, not IoU.

### `reports`  (the core)
```
_id
authorId: ref(profiles)
waterBodyId: ref(waterBodies)
point: { lat, lng }          // where the reporter was / representative point (geo index)
skateTime: timestamp         // WHEN THEY SKATED — primary sort key everywhere
reportTime: timestamp        // when submitted (may be later, offline sync)
source: enum(native, activity, imported)  // activity = from a GPS tracker (Strava/Garmin/…)
activityId?: ref(gpsActivities)           // set when source == activity; carries trusted path

// --- Ice description (surface, NOT a safety verdict) ---
iceTypes: enum[]             // multi-select, see vocab below
surfaceTags: enum[]          // multi-select, see vocab below
skateQuality?: enum(great, good, fair, poor)  // *skating* quality, optional
iceThickness?: {             // optional; multiple readings across the polygon
  readings: {
    valueCm?: number         // a single reading, OR
    minCm?, maxCm?: number   // a range
    method: enum(measured, estimated)   // estimated = lower-trust
    coord?: { lat, lng }     // where tested, within the polygon
    note?: string
  }[]
}
snowCoverCm?: number         // optional

// --- Extent ---
// No manual "shade what you skated" UX. Trusted skated extent comes ONLY from a
// real GPS path on the linked activity (activityId → gpsActivities.path). Native
// reports have no trusted extent (just the report point + water body).

// --- Conditions AT skate time (may be auto-filled from Open-Meteo) ---
conditions?: {
  airTempC?: number
  windSpeedKph?: number
  windDir?: string
  sky?: enum(clear, partly_cloudy, overcast, precip)
  precip?: enum(none, rain, snow, sleet)
  source: enum(user, openmeteo)   // provenance of the snapshot
}

photoIds: ref(photos)[]
notes?: string               // free text
visibility: enum(just_me, friends, followers, public)  // D13; DEFAULT derived per D41
                                                       // (public profile→public; locked/minor→followers)
moderationStatus: enum(visible, hidden, removed)  // default visible (D32)
hazardIdsCreated: ref(hazards)[]  // hazards drawn as part of this report
createdAt, updatedAt: timestamp
```

### `comments`  (threaded discussion on a report — v1, nestable)
```
_id
reportId: ref(reports)          // the report the thread hangs on
parentCommentId?: ref(comments) // null = top-level; set = nested reply
authorId: ref(profiles)
body: string
source: enum(native, imported)  // imported = from forum/email ingestion (Q8)
moderationStatus: enum(visible, hidden, removed)  // default visible (D32)
editedAt?: timestamp
createdAt: timestamp
```
> **Visibility inherits the parent report** — a comment never reaches a wider
> audience than the report it's on. Nested via `parentCommentId` (cap depth in UI).
> **Ingestion nuance (Q8):** email replies must be classified as *comment vs. new
> report* (people reply to a report with their own report). Proposed: an AI
> classifier reads each threaded email and routes it. That AI runs on
> **forum/email content** (not Strava data), so it's outside Strava's AI terms —
> but the ingestion itself is still legal-gated (Q8).

### `hazards`  (typed, geometried, lifecycled per D15)
```
_id
waterBodyId: ref(waterBodies)
type: enum[]                 // see hazard vocab below
geometry: geojson            // Point | LineString | Polygon (in-polygon draw, D4)
bbox: {...}                  // for proximity queries
createdByUserId: ref(profiles)
originReportId?: ref(reports)
description?: string
status: enum(active, archived)      // archived (not deleted) so it can resurface
firstReportedAt: timestamp
lastConfirmedAt: timestamp    // drives the freshness decay (D15)
confirmCount: number
goneCount: number
createdAt: timestamp
```
> **Lifecycle (D15), derived from `lastConfirmedAt`:**
> `< 24h` = fresh (full strength) · `24–72h` = aging (lighter) · `> 72h` = stale
> (faded, hidden by default). A "still there" confirmation resets `lastConfirmedAt`.
> `goneCount` past a small threshold (later reputation-weighted) → `status: archived`.

### `hazardConfirmations`  (the Waze-style votes)
```
_id
hazardId: ref(hazards)
userId: ref(profiles)
verdict: enum(still_there, gone)
atCoord?: { lat, lng }       // where the user was when confirming
via: enum(app_open_nearby, report_flow, strava_path)  // trigger (D12)
createdAt: timestamp
```

### `follows`  (follow is the primitive; mutual == friends, D13)
```
_id
followerId: ref(profiles)
followeeId: ref(profiles)
status: enum(pending, accepted)  // pending only when followee requires approval
createdAt: timestamp
```
> **friends(A,B)** := accepted follow A→B AND accepted follow B→A.
> **Visibility resolution** for viewer V on report R by author A:
> `public` → anyone · `followers` → V follows A (accepted) · `friends` → mutual ·
> `just_me` → only A. A **block** between V and A hides content both ways (below).

### `blocks`  (mute/block a user, D32)
```
_id
blockerId: ref(profiles)
blockedId: ref(profiles)
createdAt: timestamp
```
> A block hides each user's content/profile from the other and prevents follows.
> Applied on top of visibility resolution above.

### `contentFlags`  (abuse / safety reports, D32)
```
_id
flaggerId: ref(profiles)
targetType: enum(report, comment, photo, user)
targetId: string             // ref into the matching table
reason: enum(unsafe_false_report, spam, harassment, inappropriate, other)
note?: string
status: enum(open, reviewing, actioned, dismissed)
resolvedByUserId?: ref(profiles)   // a moderator or admin (users.role in {moderator, admin} — D37)
createdAt, resolvedAt?: timestamp
```
> `unsafe_false_report` is first-class: a dangerously false "ice is great" claim is
> a **safety** issue (D3), not mere spam. Moderator action sets the target's
> `moderationStatus` to `hidden`/`removed`. In the admin flag queue (D37) it sits in a
> **pinned priority lane**, not the FIFO — it's a safety incident, not spam.

### `moderationActions`  (audit log — who did what, why; D37)
```
_id
actorId: ref(profiles)          // the moderator/admin who acted
action: enum(hide, remove, restore, ban, suspend, unban,
             merge_waterbody, approve_waterbody, reject_waterbody,
             resolve_flag, dismiss_flag, grant_role, revoke_role)
targetType: enum(report, comment, photo, user, waterbody, contentFlag)
targetId: string
reason: string               // required — accountability for appeals/reversals
metadata?: { ... }           // e.g. prior/new state, mergedIntoId, suspendedUntil
createdAt: timestamp
```
> Append-only. Essential once there's more than one moderator, and for appeals and
> reversals — mirrors the never-hard-delete / reversible ethos (D15/D33). Every admin
> mutation writes exactly one row here.

### `supportTickets`  (lightweight in-app support inbox; D37, not Zendesk per D35)
```
_id
userId?: ref(profiles)          // null if submitted pre-auth
category: enum(bug, account, safety, other)
body: string
status: enum(open, in_progress, resolved)
assignedToUserId?: ref(profiles)
context?: {                  // auto-captured — what an email can't give us
  appVersion?, platform?, deviceModel?: string
  sentryEventId?: string     // link to the crash/error (D29)
}
resolvedByUserId?: ref(profiles)
createdAt, resolvedAt?: timestamp
```
> `category: safety` tickets route to the same priority attention as
> `unsafe_false_report` flags (D3).
> **Operator alert (D38):** creating a ticket emails the founder via Resend/React Email
> (safety tickets + `unsafe_false_report` flags flagged as priority), deep-linking into
> the `/admin` queue — email is the founder's inbox of record.

### `bounties`
```
_id
requesterId: ref(profiles)
waterBodyId: ref(waterBodies)
windowHours: number          // "skated in last 24/48h" (tunable)
status: enum(open, fulfilled, expired, cancelled)
rewardPoints: number         // cosmetic (D17)
fulfillingReportIds: ref(reports)[]
createdAt, expiresAt: timestamp
```
> On create: notify **eligible reporters** = users with a report *or* a detected GPS
> ice-skate on this water body within `windowHours`. Both are cheap indexed lookups
> now that `gpsActivities` carries a resolved `waterBodyId` (D44) — no per-bounty
> geometry scan. Fulfillment + reward gated by requester's helpful/unhelpful rating (below).

### `reportRatings`  (helpful thumbs → reward allocation, D17)
```
_id
reportId: ref(reports)
raterId: ref(profiles)          // typically the bounty requester
bountyId?: ref(bounties)
verdict: enum(helpful, unhelpful)
createdAt: timestamp
```

### `photos`
```
_id
storageId: string            // Convex file storage ref (optimized full image, D31)
thumbStorageId: string       // ~400px thumbnail (D31)
uploaderId: ref(profiles)
caption?: string
takenAt?: timestamp          // preserved from EXIF only if user opts in (D42)
coord?: { lat, lng }         // preserved from EXIF only if placeOnMap == true (D42)
placeOnMap: boolean          // opt-in: pin at coord on the lake map vs. report-only (D42)
createdAt: timestamp
```
> **EXIF (D42):** all EXIF is stripped client-side during the D31 optimize pass. Only
> **timestamp** and **GPS coord** may be preserved, and only on opt-in. If `placeOnMap`
> is false we **don't retain `coord`** at all — the photo attaches to the report only.

### `notifications`
```
_id
userId: ref(profiles)           // recipient
type: enum(activity_detected, bounty_request, followed_posted_nearby,
           hazard_confirmation, bounty_fulfilled, new_follower, report_rated,
           content_flag_resolved)
payload: { ...refs... }      // e.g. reportId / hazardId / bountyId / actorUserId
readAt?: timestamp
createdAt: timestamp
```
> Only sent if the recipient's `notificationPrefs[type]` is on (D16).

### `pointEvents`  (optional reputation ledger, for transparency)
```
_id
userId: ref(profiles)
delta: number
reason: enum(report_submitted, photo_evidence, helpful_thumb,
             hazard_confirmed, bounty_fulfilled)
refId?: string
createdAt: timestamp
```

---

## Vocabulary  (✅ confirmed — community/official terms)

**Water body `type`:** lake · pond · river · stream · reservoir · bay · marsh · other

**`iceTypes`** (what the ice *is*):
- `black_ice` — clear, new, strong (the good stuff)
- `snow_ice` / `white_ice` — refrozen snow, opaque, weaker
- `gray_ice` — waterlogged / weak (warning)
- `shell_ice` — surface layer over an air gap
- `sandwich_ice` — layered snow/ice
- `crust_ice` — thin refrozen crust
- `pack_ice` / `plate_ice` — refrozen broken chunks
- `candled_ice` — deteriorating vertical columns (spring rot)

**`surfaceTags`** (how it *skates*):
- `glass` / `smooth` · `rough` · `bumpy` · `rubble` · `cracked_surface`
- `snow_covered` · `drifted` · `slushy` · `wet` / `overflow`
- `frozen_chop` (froze while wavy) · `windswept`

**`hazards.type`** (localized dangers — drive the lifecycle):
- `open_water` / `lead`
- `thin_ice`
- `pressure_ridge`
- `wet_crack` (vs dry cracks which are normal — only wet/working cracks are hazards)
- `overflow_slush`
- `ice_heave` / `buckling`
- `drilled_hole` (ice-fishing holes)
- `inlet_outlet_current` / `spring` (moving water = weak)
- `shell_area` (air pocket zone)

---

## Relationships (textual ER)
```
profiles 1─* activityConnections     (one per provider)
profiles 1─* gpsActivities ─0/1 reports ; gpsActivities *─1 waterBodies (resolved, D44)
profiles 1─* reports *─1 waterBodies
reports 1─* comments (self-nesting via parentCommentId)
reports 1─* photos
reports 1─* hazards (created)      hazards *─1 waterBodies
hazards 1─* hazardConfirmations *─1 profiles
profiles *─* profiles  (follows; mutual = friends)
profiles *─* profiles  (blocks)
profiles 1─* contentFlags ─1 (report | comment | photo | user)
profiles(mod/admin) 1─* moderationActions ─1 (any moderated target)   (D37 audit log)
profiles 0/1─* supportTickets                                          (D37 support inbox)
profiles 1─* bounties *─1 waterBodies ; bounties *─* reports (fulfilling)
reports 1─* reportRatings *─1 profiles
profiles 1─* notifications
profiles 1─* pointEvents
```

---

## Derived / computed (not stored raw)
- **Drive-time filter:** cached isochrone polygon on `users` (D18) → point-in-polygon
  test against `waterBodies.centroid` / `reports.point`.
- **Weather-since-report strip:** computed from Open-Meteo over [skateTime → now]
  (D19; spec in `04-integrations.md`); cache per (waterBody, window).
- **Hazard freshness state:** derived from `lastConfirmedAt` at read time (D15).
- **Newsfeed:** reports within the viewer's isochrone, visibility-filtered, sorted
  by `skateTime` desc (not `reportTime`).

---

## Convex notes
- **Geospatial component (`@convex-dev/geospatial`)** indexes point fields
  (`waterBodies.centroid`, `reports.point`, `hazards` bbox center) for
  viewport/nearest queries.
  - **Implemented (D5):** the component is installed (`convex/convex.config.ts`) and
    `waterBodies.centroid` is indexed on `create`/`approve` with a `reviewStatus`
    filter key, queried by `waterBodies.listInViewport` (bbox → rectangle lookup,
    approved-only). The offline hermetic codegen (`scripts/codegen.mjs`) emits the
    `components` handle so this typechecks/tests without a deployment; see the convex
    package README. **Still to wire:** `reports.point` / hazard-center indexing and the
    Turf polygon-refine step (below) — the viewport query currently filters on centroid
    only, not the true polygon.
- **Polygon tests** (in-isochrone, in-water-body, hazard proximity) = bbox prefilter
  via indexed `bbox` fields + precise **Turf.js** in a Convex query/action. *(Deferred —
  the centroid/bbox prefilter exists; the Turf refine does not yet.)*
- **Suggested indexes:** `reports` by `waterBodyId + skateTime`, by `authorId`;
  `hazards` by `waterBodyId + status`; `follows` by `followerId` and by `followeeId`;
  `gpsActivities` by `provider + providerActivityId` (unique, dedup) and by
  `waterBodyId` (per-lake skate history + bounty eligibility, D44); `comments`
  by `reportId`; `activityConnections` by `userId`; `bounties` by
  `waterBodyId + status`; `blocks` by `blockerId` and by `blockedId`;
  `contentFlags` by `status` and by `targetType + targetId`; `waterBodies` by
  `dedupStatus` (review queue) and by `reviewStatus` (user-body approval queue, D37);
  `moderationActions` by `targetType + targetId` (target history) and by `actorId`;
  `supportTickets` by `status`; `profiles` by `status` (ban/suspend admin views),
  by `clerkUserId` (identity lookup, D26) and by `username` (search/uniqueness) — in
  addition to the bbox/centroid geo indexes.
- **Offline (D9):** client drafts `reports` + `photos` locally, upload on reconnect;
  `reportTime` = submit time, `skateTime` = user-set actual skate time.

---

## Open modeling questions

**Resolved:**
- Ice thickness → structured multi-readings (measured/estimated, optional coord).
- `skateQuality` → keep **both** coarse overall + detailed tags.
- Comments → **v1**, nestable (`comments` entity above).
- Skated extent → **GPS-only** (no manual shading); provider-agnostic activities.
- Vocabulary → confirmed (community/official terms).
- **Units** → store metric internally, display imperial (D25).
- **Report edits/versioning** → last-write-wins + `updatedAt`, no history in v1 (D25).
- **Comment depth** → data model allows arbitrary depth; UI caps at 2–3 (D25).
- **User-created location dedup** → match-on-create + soft-tombstone merge, v1
  moderator queue (D36); fields `dedupStatus` / `mergedIntoId` / `duplicateCandidateIds`.
- **GPS activity → water body** → resolved `waterBodyId` on `gpsActivities` at ingest
  (D44) so skates are findable by lake identity, not by geospatial area.
- **Photo EXIF / geotag** → strip all EXIF on upload; preserve timestamp + coord only
  on opt-in; `placeOnMap` gates spatial pinning and coord retention (D42).
- **Age gate & default visibility** → 16+ minimum; visibility default derived from
  profile privacy + minor status (D41); `minAge16Attested` / `isMinor` on `users`.
- **Notification prefs ↔ types** → `notificationPrefs` keys mirror `notifications.type`
  1:1 (every type toggleable, D16); `reportRated` added.

**Still open:**
- *(none in the data model right now — see `02-open-questions.md` for product-level
  open items like forum ingestion.)*
