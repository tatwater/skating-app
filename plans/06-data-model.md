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
> community's official terms (from the reference site), which the alpha crew uses
> even colloquially.

---

## Entities

### `users`
```
_id
displayName: string
username: string            // unique, for search/follow
homeCoord: { lat, lng }     // PRIVATE — filter input only (D11)
homeTownLabel?: string      // optional PUBLIC label on profile (D11)
driveTimePrefMinutes: number // e.g. 30 / 60 / 90 (D18)
cachedIsochrone?: geojson   // polygon; recomputed on home/pref change (D18)
cachedIsochroneAt?: timestamp
requireFollowApproval: boolean // account-level (D13)
notificationPrefs: {         // per-type toggles (D16)
  activityDetected,          // ice-skate detected on ANY linked provider (D24)
  bountyRequest, followedPostedNearby,
  hazardConfirmation, bountyFulfilled, newFollower,
  contentFlagResolved, ...: boolean
}
reputationPoints: number     // cosmetic/reputational only (D17)
badges?: string[]
role: enum(member, moderator)  // moderator can hide/remove flagged content (D32)
status: enum(active, deleted)  // deletion anonymizes authored content (D33)
deletedAt?: timestamp
createdAt: timestamp
```
> **Deletion (D33):** on delete, set `status: deleted` and scrub PII (displayName →
> "deleted user", drop `homeCoord`/`homeTownLabel`). Authored public/followers/friends
> reports & comments are **anonymized, not erased** (preserve the ice record);
> `just_me` content is removed. Users can also **export** their data.

### `activityConnections`  (a user's linked GPS providers; provider-agnostic, all six v1 — D24)
```
_id
userId: ref(users)
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
userId: ref(users)
provider: enum(strava, garmin, coros, polar, apple_health, google_health_connect, other)
providerActivityId: string   // unique per provider — dedup webhook re-deliveries
sportType: string            // provider's ice-skate type (e.g. Strava "IceSkate")
startTime: timestamp         // becomes report.skateTime if converted
path?: geojson               // TRUSTED GPS track = skated extent (+ hazard proximity, Q11)
photoUrls?: string[]         // provider-dependent + subject to provider ToS
promptState: enum(pending, prompted, converted, dismissed)
linkedReportId?: ref(reports)
detectedAt: timestamp
```

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
createdByUserId?: ref(users) // when source == user
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
authorId: ref(users)
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
visibility: enum(just_me, friends, followers, public)  // D13
moderationStatus: enum(visible, hidden, removed)  // default visible (D32)
hazardIdsCreated: ref(hazards)[]  // hazards drawn as part of this report
createdAt, updatedAt: timestamp
```

### `comments`  (threaded discussion on a report — v1, nestable)
```
_id
reportId: ref(reports)          // the report the thread hangs on
parentCommentId?: ref(comments) // null = top-level; set = nested reply
authorId: ref(users)
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
createdByUserId: ref(users)
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
userId: ref(users)
verdict: enum(still_there, gone)
atCoord?: { lat, lng }       // where the user was when confirming
via: enum(app_open_nearby, report_flow, strava_path)  // trigger (D12)
createdAt: timestamp
```

### `follows`  (follow is the primitive; mutual == friends, D13)
```
_id
followerId: ref(users)
followeeId: ref(users)
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
blockerId: ref(users)
blockedId: ref(users)
createdAt: timestamp
```
> A block hides each user's content/profile from the other and prevents follows.
> Applied on top of visibility resolution above.

### `contentFlags`  (abuse / safety reports, D32)
```
_id
flaggerId: ref(users)
targetType: enum(report, comment, photo, user)
targetId: string             // ref into the matching table
reason: enum(unsafe_false_report, spam, harassment, inappropriate, other)
note?: string
status: enum(open, reviewing, actioned, dismissed)
resolvedByUserId?: ref(users)   // a moderator (users.role == moderator)
createdAt, resolvedAt?: timestamp
```
> `unsafe_false_report` is first-class: a dangerously false "ice is great" claim is
> a **safety** issue (D3), not mere spam. Moderator action sets the target's
> `moderationStatus` to `hidden`/`removed`.

### `bounties`
```
_id
requesterId: ref(users)
waterBodyId: ref(waterBodies)
windowHours: number          // "skated in last 24/48h" (tunable)
status: enum(open, fulfilled, expired, cancelled)
rewardPoints: number         // cosmetic (D17)
fulfillingReportIds: ref(reports)[]
createdAt, expiresAt: timestamp
```
> On create: notify **eligible reporters** = users with a report (or detected Strava
> ice-skate) on this water body within `windowHours`. Fulfillment + reward gated by
> requester's helpful/unhelpful rating (below).

### `reportRatings`  (helpful thumbs → reward allocation, D17)
```
_id
reportId: ref(reports)
raterId: ref(users)          // typically the bounty requester
bountyId?: ref(bounties)
verdict: enum(helpful, unhelpful)
createdAt: timestamp
```

### `photos`
```
_id
storageId: string            // Convex file storage ref
uploaderId: ref(users)
caption?: string
takenAt?: timestamp
coord?: { lat, lng }         // if EXIF/known
createdAt: timestamp
```

### `notifications`
```
_id
userId: ref(users)           // recipient
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
userId: ref(users)
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
users 1─* activityConnections     (one per provider)
users 1─* gpsActivities ─0/1 reports
users 1─* reports *─1 waterBodies
reports 1─* comments (self-nesting via parentCommentId)
reports 1─* photos
reports 1─* hazards (created)      hazards *─1 waterBodies
hazards 1─* hazardConfirmations *─1 users
users *─* users  (follows; mutual = friends)
users *─* users  (blocks)
users 1─* contentFlags ─1 (report | comment | photo | user)
users 1─* bounties *─1 waterBodies ; bounties *─* reports (fulfilling)
reports 1─* reportRatings *─1 users
users 1─* notifications
users 1─* pointEvents
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
- **Polygon tests** (in-isochrone, in-water-body, hazard proximity) = bbox prefilter
  via indexed `bbox` fields + precise **Turf.js** in a Convex query/action.
- **Suggested indexes:** `reports` by `waterBodyId + skateTime`, by `authorId`;
  `hazards` by `waterBodyId + status`; `follows` by `followerId` and by `followeeId`;
  `gpsActivities` by `provider + providerActivityId` (unique, dedup); `comments`
  by `reportId`; `activityConnections` by `userId`; `bounties` by
  `waterBodyId + status`; `blocks` by `blockerId` and by `blockedId`;
  `contentFlags` by `status` and by `targetType + targetId`; `waterBodies` by
  `dedupStatus` (review queue) — in addition to the bbox/centroid geo indexes.
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

**Still open:**
- *(none in the data model right now — see `02-open-questions.md` for product-level
  open items like forum ingestion.)*
