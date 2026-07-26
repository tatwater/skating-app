# Data model

Conceptual schema for the app's core entities. Notation is schema-flavored
pseudocode (`field: type`), **not** final Convex code — it's for us to react to.
Convex-specific notes (indexes, the ladder-grid spatial index) are at the bottom.

Guiding constraints from `01-decisions.md`:
- **Safety framing (D3):** no field asserts ice is "safe." Reports are observations;
  quality tags describe *skating surface*, not a go/no-go verdict.
- **Reports attach to whole water bodies + optional in-polygon hazard geometry (D4).**
- **Canonical (OSM/NHD) and user-created locations live in one table (D14).**
- **Hazards are their own entity with a lifecycle (D15).**
- **Reports are always public (no visibility field); public/private profiles are the only
  privacy switch, no social graph (D13); real drive-time via cached isochrone (D18).**

> ✅ **VOCABULARY CONFIRMED.** The ice-type / surface / hazard enums below use the
> community's official terms from the **Nordic Skater** reference sites
> (<https://nordicskaters.squarespace.com/> and <http://lakeice.squarespace.com/>), which the alpha crew uses even
> colloquially.

---

## Entities

### `profiles`  (was `users` in the original model — renamed in implementation, see note)
```
_id
clerkUserId: string         // ties this profile to its Clerk auth user (= identity.subject)
displayName: string
username: string            // unique, for search (searchable by name, D13)
homeCoord: { lat, lng }     // PRIVATE — filter input only (D11)
homeTownLabel?: string      // optional PUBLIC label on profile (D11)
bio?: string                 // optional PUBLIC blurb, shown only on a public profile (D13)
cachedIsochrones?: {         // Phase 4: nested drive-time bands, derived from homeCoord (D18).
  band30?: geojson           // ORS driving-car isochrone, 1800s
  band60?: geojson           // ORS driving-car isochrone, 3600s (hosted ORS max range)
}                            // band membership derived at read time (Turf pointInPolygon) — NOT a
outerRadiusMeters?: number   // materialized userId×waterBodyId table (balloons + goes stale). The 90-min
                             // band is a uniform crow-flies radius (hosted ORS caps at 60; self-host later).
cachedIsochronesAt?: timestamp  // recomputed on home/pref change (D18)
feedFilterPrefs?: {          // Phase 4: server-sync copy of the newsfeed filter row (local-first + LWW).
  radiusMinutes?: 30 | 60 | 90     // drive-radius filter (null/absent = off = show all)
  qualityFloor?: enum(good, great) // skateQuality floor; INCLUDE-UNKNOWN (never drops reports w/o quality)
  thicknessFloorCm?: number        // thickness floor; INCLUDE-UNKNOWN (only ~16% of reports carry it)
  noSnow?: boolean                 // keys off surfaceTags (snow_covered/drifted), NOT snowCoverCm
  iceTypes?: string[]              // "ideal ice" checkboxes (e.g. black_ice)
  surfaceTags?: string[]           // "ideal surface" checkboxes (e.g. glass/smooth)
  recencyHours?: number            // hard recency floor (e.g. 24/48/168); null = off
}                            // NOTE: driveTimePrefMinutes (old single D18 pref) folds into the notification
                             // radii + this filter; kept/dropped at the Phase-4 migration.
profileVisibility: enum(public, private)  // THE ONLY privacy switch for the PERSON (reports are always
                             // public, D13). public = searchable + browsable (name, photo, town, bio,
                             // counts, trust score, report history); private = name + photo only, not
                             // searchable. Minors forced private; adults default public (D13/D41).
excludeTracksFromAggregate?: boolean  // Phase 8 / D58: keep my recorded paths out of the community
                             // aggregate tracks layer. PERSON-level on purpose — flipping it
                             // retroactively drops every track they've contributed, not just future
                             // ones. Recording + Strava push are unaffected; this governs only whether
                             // their line draws on a lake's map for other people.
notificationPrefs: {         // per-type toggles — EVERY type is toggleable (D16)
  activityDetected,          // ice-skate detected on ANY linked provider (D24)
  bountyRequest,
  hazardConfirmation, bountyFulfilled,
  reportRated,               // someone rated your report helpful/unhelpful (D17)
  reportCommented,           // someone commented on your report (D21; Phase 3)
  favoriteReport,            // Phase 4: report on a favorited body (DEFAULT ON), any distance
  nearbyReportDigest,        // Phase 4: "all reports within X₁" — delivered as the 8pm-ET daily digest
  greatReportNearby,         // Phase 4: "great reports within X₂" — fires ~individually (coalesced)
  contentFlagResolved: boolean
}                            // keys mirror notifications.type 1:1 (D16 invariant)
allRadiusMinutes?: 30 | 60 | 90     // Phase 4: X₁ for nearbyReportDigest
greatRadiusMinutes?: 30 | 60 | 90   // Phase 4: X₂ for greatReportNearby — enforce X₂ ≥ X₁ (drive
                                    // farther for better ice)
dateOfBirth: timestamp       // collected at signup (D41); age gate (≥16) + minor status
                             // (<18, protective defaults) are DERIVED from it, recomputed
                             // at read time so the 18th-birthday transition is automatic
riskAckVersion?: string      // assumption-of-risk acknowledgment accepted (D45)
riskAckAt?: timestamp
reputationPoints: number     // cosmetic/reputational only (D17)
badges?: string[]
role: enum(member, moderator, admin)  // mod=content; admin ⊇ mod + bans/roles/PII (D32/D37)
status: enum(active, suspended, banned, deleted)  // suspend/ban = D37; deleted = D33
statusReason?: string          // mod-visible; optionally surfaced to the user (D37)
suspendedUntil?: timestamp      // temp suspension; null on a ban = indefinite (D37)
moderatedByUserId?: ref(profiles)  // who set the current suspend/ban state (D37)
canPostReports?: boolean       // D57: per-action posting right; absent ⇒ true for adults. Revocable as a
canPostHazards?: boolean        // moderation lever finer than a whole-app ban — proportionate + appealable.
                                // reports.create / hazards.create gate on these server-side (like `status`).
contradictionCount?: number     // D56/D57: private, non-scoring tally of weather-unexplained, never-
                                // corroborated contradictions. NOT trust (D50 stays boost-only) — a
                                // moderation input; the Phase-7 panel charts it tenure-aware. Absent ⇒ 0.
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
> "deleted user", drop `homeCoord`/`homeTownLabel`/`bio`, clear `dateOfBirth`). All reports &
> comments are public (D13), so **all** are **anonymized, not erased** (preserve the ice record) —
> there's no private content to selectively remove. Users can also **export** their data.
> **Ban/suspend (D37):** Convex is the source of truth — every function gates on
> `status`; **also lock the account in Clerk** so no new session issues. A ban
> preserves the account (appeal/reversal) — distinct from deletion, which scrubs PII.
> A suspension (`suspendedUntil` set) auto-lapses back to `active` once the time passes.

### `activityConnections`  (a user's linked GPS providers; provider-agnostic, all six v1 — D24)
```
_id
userId: ref(profiles)
provider: enum(native, strava, garmin, coros, polar, apple_health, google_health_connect, other)
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
>
> **Amended by Phase 8 (2026-07-24, L7/D58).** Two changes the build made real:
> **(a)** `provider` gained **`native`** — our own in-app recorder, and the only A-input wired today.
> It's a first-class provider value rather than a special case because the *legal* status of a track
> follows its source: a `native` track is our first-party data (free to aggregate and draw on public
> reports), where a track read out of `strava` never could be (L7). **(b)** For Strava this row now
> holds a **push** credential (`activity:write`), not a read one — the pull direction is shelved. The
> remaining providers are the deferred watch adapters, kept in the enum so adding one later is an
> adapter, not a migration.

### `oauthStates`  (short-lived OAuth `state` nonces — Phase 8, Strava)
```
_id
state: string                 // the opaque nonce echoed back by the provider
userId: ref(profiles)
provider: enum(ACTIVITY_PROVIDERS)
redirectTo?: string           // app deep link (mobile) or web route to bounce back to
expiresAt: timestamp
createdAt: timestamp
indexes: by_state, by_expires_at
```
> **Why this table exists (a Phase-8 discovery, not in the original plan):** an OAuth callback lands on
> an **unauthenticated** HTTP endpoint — a browser redirect from Strava carries no Clerk identity — so
> without a nonce bound to the user there is no way to know *whose* account is being connected, and a
> replayed callback URL could bind a Strava account to the wrong profile. An authenticated mutation
> mints the nonce; the callback burns it (on read, even when expired). A 6-hourly cron sweeps
> abandoned rows: a nonce that lingers is a credential that lingers. Nothing here outlives a connect
> flow by more than a few minutes.

### `gpsActivities`  (ice skates from any capture source; dedup + trusted path)
```
_id
userId: ref(profiles)
provider: enum(native, strava, garmin, coros, polar, apple_health, google_health_connect, other)
                             // Phase 8: `native` (our own recorder) is the only one wired.
providerActivityId: string   // unique per provider — dedup webhook re-deliveries. For `native`
                             // it's the recorder session's client-generated idempotency key, which
                             // is what makes an offline re-flush return the original row.
sportType: string            // provider's ice-skate type (e.g. Strava "IceSkate")
startTime: timestamp         // GPS start → report.skateStartTime on convert
endTime?: timestamp          // Phase 5 prep (wired Phase 8): GPS end → report.skateEndTime
elapsedSeconds?: number      // Phase 5 prep: provider moving/elapsed time — NON-redundant with
                             // (end − start) because it excludes pauses/stops. Phase 8: trim a
                             // watch-left-recording tail to the on-water path before deriving end.
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
> **Wired in Phase 8 (2026-07-24).** `gpsActivities.ingestTrack` fills this table from the native
> recorder; a device-supplied `waterBodyId` is treated as a **hint only** and re-resolved unless it
> still checks out (the offline body cache goes stale, and the body may have been merged away since).
> `linkedReportId` is written in the **same transaction** as `reports.create` — a half-linked pair
> can't exist, which matters because the *activity* side is what the D58 aggregate layer's
> publish-is-consent predicate reads. The table needed **no schema change**: the Phase-5 stub already
> had the right shape and indexes. `path` is the substrate for the **aggregate tracks layer** —
> see D58 for the four structural privacy gates that decide which rows in this table ever draw for
> anyone but their owner.

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
dedupStatus: enum(clean, suspected_duplicate, near_certain, merged)  // default clean (D36)
mergedIntoId?: ref(waterBodies)       // set when merged; reads follow the survivor
duplicateCandidateIds?: ref(waterBodies)[]  // cached suspects for the review queue
removedAt?: timestamp                 // soft-delist (D48); reversible, cleared on restore
removedByUserId?: ref(profiles)       // the admin who removed it (D48)
removalReason?: enum(landowner_request, unskateable, junk, duplicate, other)  // D48
createdAt: timestamp
```
> **Listing (`listed`, D48/D5).** Whether a body shows on the public map is a **derived
> boolean**: **`true`** for canonical (`osm`/`nhd`) bodies and auto-visible/approved user bodies;
> **`false`** when `rejected`, `merged`, or **removed** (`removedAt` set). Since N1 it decides
> whether the body is in the spatial index at all — an unlisted body has no `waterBodyCells` rows,
> so `waterBodies.listInViewport` can't reach it. Removal (D48) is a **reversible soft-delist** (never a hard delete):
> flip `listed` off, stamp `removed*`, write a `moderationActions` audit row, and — because
> the OSM import re-runs — the idempotent `importCanonical` upsert **must preserve** a
> removed state so a re-import never resurrects it.
> **`centroid` is a guaranteed on-water representative point** (Turf `pointOnFeature`), not
> a raw area centroid — the area centroid of a crescent/horseshoe lake can land on shore,
> which would break both the geospatial point index and D20's "fit the map to this lake."
> Rivers: model as **segments/reaches** (D4). A long river = multiple `waterBodies`
> rows (or one row per named reach), so reports/hazards attach to the right stretch.
> **Dedup (D36):** match on create (bbox prefilter → Turf IoU / point-in-polygon +
> name similarity) to steer users onto an existing body; suspects get
> `suspected_duplicate` + `duplicateCandidateIds`. A confirmed merge **re-points
> child reports/hazards/bounties** to the survivor and soft-tombstones the loser
> (`merged` + `mergedIntoId`) — never hard-deleted, so bad merges reverse. Rivers
> compared by buffered-line overlap, not IoU.
> **Built in Phase 8 (2026-07-24), with two amendments.** **(a)** `dedupStatus` gained
> **`near_certain`** — D36 always described three match tiers but the schema had two, so the top tier
> had nowhere to go; `listDedupCandidates` now surfaces both, near-certain first. A flagged body stays
> **listed**: hiding it would take every report and hazard filed against it off the map on a machine's
> guess (D3). **(b)** `create` is **path-only at the trust boundary** — it takes a
> `gpsActivities` **`activityId`, not a polygon**, and derives the geometry server-side from the
> recorded track (`core/pathToBody.ts`: buffer the LineString, fill interior rings, refuse a track with
> no extent). "No freehand drawing, ever" (D14) is therefore a server contract, not a UI convention.

### `adminAreas`  (administrative boundaries for point→place labels — Phase 5)
```
_id
name: string                 // "Burlington", "Chittenden County"
level: enum(state, county, town)   // admin granularity
state: string                // 2-letter code (denormalized onto the label)
polygon: geojson             // boundary
bbox: { minLat, minLng, maxLat, maxLng }  // prefilter index
centroid: { lat, lng }       // geospatial point index
createdAt: timestamp
```
> **Purpose (Phase 5, decided 2026-07-16):** resolve a report's `point` (put-in pin / GPS start) →
> `{ town?, county?, state? }` so the newsfeed/lake cards show *which town/side* a skater put in from —
> correct even for a body spanning multiple towns or states (Lake Champlain = NY|VT). Imported from the
> **same per-state OSM extracts** the water ETL uses (`boundary=administrative`, `admin_level` 4/6/7–8;
> same ODbL attribution, **no new dataset**). New England (VT/NH/ME/MA) is fully tiled by towns; county
> is the fallback for any gap. `resolvePlaceForCoord` (bbox prefilter → Turf `pointInPolygon`, the
> D5/D36 machinery) returns the most-specific match; stamped onto `reports.place` at create (no
> per-read geocode). Reused by GPS ingest (Phase 8) + hazards (Phase 9).

### `reports`  (the core)
```
_id
authorId: ref(profiles)
waterBodyId: ref(waterBodies)
point: { lat, lng }          // where the reporter was / representative point (geo index)
skateTime: timestamp         // WHEN THEY SKATED — primary sort key everywhere
                             // ⚠️ Phase 5 (decided 2026-07-16): RENAMED → `skateEndTime`, redefined
                             // as "when the skater left the ice" (the freshest read wins the sort).
                             // Manual form asks "When did you get off the ice?"; GPS (Phase 8) maps
                             // the path's END time.
skateStartTime?: timestamp   // Phase 5: optional — when they got ON the ice. Duration is DERIVED
                             // (end − start), never stored. Manual form accepts start OR a duration
                             // (back-computes start); GPS supplies both.
place?: {                    // Phase 5: point-derived location label, stamped at create from `point`
  town?: string              // (the put-in pin / GPS start) via the `adminAreas` resolver — so a
  county?: string            // multi-town/-state body shows WHICH side the skater put in from.
  state?: string             // Card reads "{body} · {town or county}, {state}". No per-read geocode.
}
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
showPutIn?: boolean          // Phase 4: default true. The private-property opt-out — false hides this
                             // report's derived put-in PIN on the map but KEEPS the coarse `place`
                             // label (we suppress a marker, we don't scrub location).
// No `visibility` field — every report is PUBLIC (D13). Minors can't create reports at all (D41).
moderationStatus: enum(visible, hidden, removed)  // default visible (D32)
hazardIdsCreated: ref(hazards)[]  // hazards drawn as part of this report
createdAt, updatedAt: timestamp
```

### `waterBodyFavorites`  (place-based curation — Phase 4, the D13 follow-graph stand-in)
```
_id
userId: ref(profiles)
waterBodyId: ref(waterBodies)
createdAt: timestamp
```
> **Purpose (Phase 4):** you subscribe to *lakes you care about*, not to people (D13). A favorite
> **notifies by default** (`favoriteReport`), gets a **feed prominence boost** (exempt from the distance
> filter, but still obeys quality/snow/recency filters), and is **highlighted on the map**. Indexed
> `by_user` (my favorites) **and** `by_water_body` (the notification fan-out: who favorited this body?).

### `putIns`  (access-point markers on a water body's shore — Phase 4)
```
_id
waterBodyId: ref(waterBodies)
coord: { lat, lng }          // snapped to the nearest shore/road edge
source: enum(derived, official)   // derived = clustered from report points; official = admin-set (accurate)
originReportId?: ref(reports)     // for a derived marker, a representative source report
status: enum(visible, hidden)     // hidden = moderator-suppressed (per-coord, outlives re-clustering)
createdByUserId?: ref(profiles)   // the admin, when source == official
createdAt: timestamp
```
> **Derived vs. official (Phase 4).** `derived` markers are materialized by **clustering visible report
> `point`s** (respecting each report's `showPutIn` opt-out) and **snapping to shore/road** — a report
> point can be mid-lake/on-ice, so derived markers are *approximate*. `official` markers are **admin-set**
> from the Phase-7 operator surface (accurate; priority styling). A **moderator hide is per-coord**
> (a `hidden` row / suppression entry) so one action kills the marker regardless of how many reports feed
> it, plus a `moderationActions` audit row. **Directions** deep-link (Apple/Google) from the lake detail
> **drawer button** target a put-in `coord`, **never** the on-water `waterBodies.centroid`.

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
> **All reports are public (D13), so comments are too** — gated only by moderation + blocks.
> Nested via `parentCommentId` (cap depth in UI).
> **Ingestion nuance (Q8):** email replies must be classified as *comment vs. new
> report* (people reply to a report with their own report). Proposed: an AI
> classifier reads each threaded email and routes it. That AI runs on
> **forum/email content** (not Strava data), so it's outside Strava's AI terms —
> but the ingestion itself is still legal-gated (Q8).

### `hazards`  (typed, geometried, lifecycled per D15/D52; authored per D51)
```
_id
waterBodyId: ref(waterBodies)
type: enum                   // EXACTLY ONE — see hazard vocab below. Changed from `enum[]` 2026-07-21:
                             //   per-type decay (D52), geometry-per-type (D51), the ridge_crossing
                             //   verdict relabeling and the one-tap presets all need an unambiguous
                             //   type. With an array, "what decay tier is this?" has no answer —
                             //   ambiguity exactly where the safety math must be exact. Nuance that
                             //   used to need a second type goes in `description` or a second hazard.
geometryKind: enum(point_radius, line, polygon)  // the authoring primitive (D51)
geometry: geojson            // Point | LineString | Polygon (in-polygon draw, D4)
radiusMeters?: number        // set when geometryKind == point_radius (the draggable circle, D51)
bufferMeters?: number        // set for line/polygon — the uncertainty half-width (D51/D52 research):
                             //   a folded ridge (loose plates 1–15ft each side) buffers far wider than
                             //   a hairline tectonic crack; drives honest render (D3) + the alert buffer.
                             //   Type-aware default (ridge » wet_crack); user-adjustable.
bbox: {...}                  // for proximity queries (built from geometry + radius/buffer)
createdByUserId: ref(profiles)
originReportId?: ref(reports)     // set when drawn in-report; null for the standalone flow (D51)
description?: string
photoIds: ref(photos)[]      // optional hazard photos (D51 research): ice hazards are intensely visual
                             //   and hard to describe (folded ridges "hard to see" is a recurring cause
                             //   of death) — photos are the highest-value aid for the next skater.
                             //   PLURAL as of 2026-07-21: a ridge or lead often needs two angles, and
                             //   the multi-photo report pipeline (D31/D42) is reused as-is.
status: enum(active, archived)      // LIFECYCLE axis: archived (not deleted) so it can resurface
moderationStatus: enum(visible, hidden, removed)  // MODERATION axis — deliberately separate from
                             //   `status` (added 2026-07-21). Hiding a troll pin by archiving it would
                             //   make abuse indistinguishable from "the community voted this healed",
                             //   which is a D3 violation: a moderator action must never read as a
                             //   safety verdict. Mirrors reports/comments.
healingState?: enum(none, healing_unsafe)  // latest "healing but unsafe" verdict (D52); annotates render
firstReportedAt: timestamp
lastConfirmedAt: timestamp    // drives the freshness decay (D15/D52)
confirmCount: number          // "still here" confirms; excludes the author's own (D54 confirm-gate)
goneCount: number             // "fully healed & safe" verdicts only (D52) — NOT "healing but unsafe"
createdAt: timestamp
```
> **Confidence (D51/D54):** a hazard is **provisional** until `confirmCount ≥ confirmThreshold`
> (1, tunable) and **confirmed** after — derived, not stored. Provisional hazards render softer and,
> on-ice, surface as the "can you confirm?" prompt rather than a hard alert (D54 Layer 1).
> **Lifecycle — per-type decay (D52, extends D15), derived from `type` + `lastConfirmedAt`** via a
> tunable `HAZARD_DECAY` table in `@skating/core` (Tier A volatile 24/72h … Tier D permanent 14d/45d;
> admin-editable Phase 7 / D49). Freshness tiers: fresh (full strength) · aging (lighter) · stale
> (faded, hidden by default). A **"still here"** confirmation resets `lastConfirmedAt`. `goneCount`
> (fully-healed verdicts only) past the removal threshold (**2**, tunable, no reputation yet — D54) →
> `status: archived`. A **"healing but unsafe"** verdict sets `healingState` and does **not** archive —
> the pin stays so future skaters can read the healing ice (D52). Copy never implies a decayed
> open-water hazard is skateable (D3).

### `hazardConfirmations`  (the Waze-style votes — three-tier, D52)
```
_id
hazardId: ref(hazards)
userId: ref(profiles)
verdict: enum(still_there, healing_unsafe, fully_healed)  // D52 — only fully_healed counts toward removal
atCoord?: { lat, lng }       // where the user was when confirming
via: enum(app_open_nearby, report_flow, strava_path)  // trigger (D12)
createdAt: timestamp
```
> **Three-tier verdicts (D52):** `still_there` resets the decay clock; `healing_unsafe` keeps the
> hazard on the map (annotates `hazards.healingState`) but does not count toward removal; `fully_healed`
> is the only verdict that increments `goneCount` toward the (2, tunable) archive threshold.

### `bodyFeatures`  (known seasonal water-body hazards — persistent, not decayed; D53)
```
_id
waterBodyId: ref(waterBodies)
type: enum(spring_current, constriction, bridge_narrows, recurring_pressure_ridge,
           gas_hole, reef_hole, delta, shallow_bay_early_thaw, other)  // last four added 2026-07-21
                                                                       // (Phase 9 research): persistent
                                                                       // natural sources that recur every
                                                                       // season regardless of cold
geometry: geojson            // Point | LineString | Polygon (same primitives as hazards, D51)
radiusMeters?: number
bbox: {...}
note?: string
addedByUserId: ref(profiles) // admin/moderator (promotion is an admin action, D37/D53)
promotedFromHazardId?: ref(hazards)  // when promoted from a recurring hazard (D53)
active: boolean              // demotion flips this off (reversible, never hard-deleted)
createdAt: timestamp
```
> **Always-shown, no time-decay, no confirmation loop (D53).** Moving water at springs/constrictions/
> bridges is weaker *every season regardless of cold*, and some pressure ridges reform in the same
> place annually — modeling them as durable body attributes avoids busywork re-marking and the
> false-negative of an un-re-marked spring looking "gone." Rendered with distinct "known seasonal
> hazard" styling. **Promotion/demotion are admin actions** (Phase 7 surface, D49-style tuning). v1
> ships schema + rendering; population is admin/seed-driven.

> **No `follows` table (D13).** The social graph was removed, so there is no follow/friend edge.
> And reports have **no visibility field** — every report is public — so read access is just
> *moderation-visible + not blocked*. A **block** between two users hides content both ways (below).

### `blocks`  (mute/block a user, D32)
```
_id
blockerId: ref(profiles)
blockedId: ref(profiles)
createdAt: timestamp
```
> A block hides each user's content/profile from the other. With no follow graph (D13) there
> is no follow state to also unwind — it's pure "hide this person," applied on top of the
> moderation check (reports are otherwise all public).

### `contentFlags`  (abuse / safety reports, D32)
```
_id
flaggerId: ref(profiles)
targetType: enum(report, comment, photo, user, hazard)  // hazard added Phase 9 (D51) — mods can hide a bad pin
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
             merge_waterbody, approve_waterbody, reject_waterbody, set_curated_boost,
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

### `reportRatings`  (helpful thumbs → trust score, D17/D50)
```
_id
reportId: ref(reports)
raterId: ref(profiles)          // any viewer (D50) — often, but not only, the bounty requester
bountyId?: ref(bounties)        // set when the rating fulfills a bounty
verdict: enum(helpful, unhelpful)
createdAt: timestamp
```
> **Trust score (D50):** a `helpful` mark raises the author's reputation/trust score (boost-only);
> `unhelpful` informs moderation/quality signals but is **not** a public penalty. This is the
> reputational, asymmetric stand-in for the removed social graph (D13) — never a safety weight (D3).
> One rating per (rater, report); a rater cannot rate their own report.

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
type: enum(activity_detected, bounty_request,
           hazard_confirmation, bounty_fulfilled, report_rated,
           report_commented,          // someone commented on your report (D21; Phase 3)
           favorite_report,           // Phase 4: report on a favorited body (fires ~individually)
           nearby_report_digest,      // Phase 4: the 8pm-ET daily "all within X₁" digest, grouped by body
           great_report_nearby,       // Phase 4: great report within X₂ (fires ~individually)
           content_flag_resolved)
payload: { ...refs... }      // e.g. reportId / waterBodyId / hazardId / bountyId / actorUserId;
                             // + a count for coalesced/digest notifications (Phase 4)
readAt?: timestamp
createdAt: timestamp
```
> Only sent if the recipient's `notificationPrefs[type]` is on (D16).
> **On-ice hazard alerts are NOT rows here (D54).** The Phase 9 Layer-1 "reported hazard nearby —
> confirm?" / "⚠ hazard ahead" alerts are **client-local** (each phone evaluates its own GPS against
> cached hazards, D12), not server pushes — so they need no new `type`. `hazard_confirmation` already
> covers the confirm-ask surface. A server push to a *sleeping* on-ice phone is deferred (D54 Layer 2).

### `pointEvents`  (optional reputation/trust ledger, for transparency — D17/D50)
```
_id
userId: ref(profiles)
delta: number                // boost-only in practice (D50); no public penalties
reason: enum(report_submitted, photo_evidence, helpful_thumb,
             report_corroborated,   // independent same-body report agreed within the window (D50)
             hazard_confirmed, bounty_fulfilled)
refId?: string
createdAt: timestamp
```
> The user's **trust score** (`profiles.reputationPoints`) is the aggregate of these events.
> `report_corroborated` is the D50 corroboration signal; it is **boost-only** and window-bounded,
> so a later report of *changed* conditions never penalizes an earlier honest one (D3).

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
- `glass` / `smooth` · `rough` · `bumpy` · `orange_peel` (dimpled/textured, finer than bumpy)
- `rubble` · `cracked_surface`
- `snow_covered` · `drifted` · `slushy` · `wet` / `overflow`
- `frozen_chop` (froze while wavy) · `windswept`

**`hazards.type`** (localized dangers — drive the lifecycle; per-type decay in `HAZARD_DECAY`,
[`phase-9-hazard-research.md`](./phase-9-hazard-research.md)). **Exactly one per hazard.**

> **Canonicalized 2026-07-21 (Phase 9 kickoff).** The pre-Phase-9 enum stored slash-pairs as *separate*
> keys (`open_water` **and** `lead`; `ice_heave` **and** `buckling`; `inlet_outlet_current` **and**
> `spring`), which meant `Record<HazardType, HazardDecay>` could not typecheck against the research
> table and two keys could disagree about their own decay tier. Each pair collapses to **one canonical
> key with a two-part display label**; the alias survives in the UI, not in the data. Both the `hazards`
> and `hazardConfirmations` tables were empty on dev, so this cost nothing to fix — and would have been
> expensive later. **16 canonical keys:**

| Key | Label | Tier |
|---|---|---|
| `open_water` | Open water / lead | A |
| `thin_ice` | Thin ice | A |
| `overflow_slush` | Overflow / slush | A |
| `drain_hole` | Drain hole | A |
| `wind_hole` | Wind hole | A |
| `slush_hole` | Slush / mush hole | A |
| `thawed_rotten` | Thawed / rotten ice | A\* |
| `ridge_crossing` | Ridge crossing *(passage marker)* | A\* |
| `wet_crack` | Wet / working crack | B |
| `drilled_hole` | Drilled hole *(man-made)* | B |
| `shell_area` | Shell ice | B |
| `pressure_ridge` | Pressure ridge | C |
| `ice_heave` | Ice heave / buckling | C |
| `spring_current` | Spring / inlet-outlet current | D |
| `gas_hole` | Gas hole | D |
| `reef_hole` | Reef hole | D |

Notes on the individual terms:
- `wet_crack` — vs dry cracks which are normal; only wet/working cracks are hazards.
- `drilled_hole` — **man-made only** (ice-fishing / auger holes; re-skin overnight, weak spot lingers days).
- `spring_current` — moving water = weak. Replaces the former `inlet_outlet_current` + `spring` pair.
- `shell_area` — air-pocket zone.
- **Added 2026-07-21 (Phase 9 hazard research — lakeice.info + corpus):**
- `thawed_rotten` — a thawed/rotten/candled *zone* (the #1 fatality cause per lakeice: "~half of ice
  fatalities involve thaw"). ⚠ **Cold weather must NOT auto-heal this** — a thawed sheet grows a
  deceptive cold skin overnight and collapses midday (the "overnight-ice trap"). Very short decay.
- `drain_hole` — water draining through the sheet after a wet thaw (volatile).
- `wind_hole` — opens in warm/windy conditions at exposed points; refreezes to black ice (volatile).
- `slush_hole` / `mush_hole` — slush over open water; treacherous (volatile).
- `gas_hole` — persistent marsh-gas source (deltas/river mouths); deroofs into open holes; **recurs
  seasonally → strong `bodyFeatures` candidate** (D53).
- `reef_hole` — thin ice over a shallow/reef spot; **recurs annually → `bodyFeatures` candidate** (D53).
- `ridge_crossing` — **a "passage" marker, not a danger** (D51 research): a spot where a `pressure_ridge`
  was crossable. Reuses the hazard machinery (geometry, decay, confirm loop) but renders as a
  positive-but-cautious passage marker and the three verdicts are relabeled by the copy helpers
  (*still crossable / dicey now / ridge closed*). **Most volatile of all** — "a ridge reasonable to
  cross in the morning may be a mess a couple hours later" (lakeice); copy never asserts safety (D3).

### Corpus validation (2026-07-13)
Validated against **1,197 real posts** (Jul 2025–Jun 2026) from the community's VT/NH/ADK/ME
Nordic-skating Google Groups (methodology + re-runnable scripts: `training_data/google_group/`,
a private design input — see `08-legal-feasibility-checklist.md` L5a). **The enums hold up well** —
every term appears, in the expected frequency order:
- **Ice types:** `black_ice` (248 occ / 173 msgs — dominant, "the good stuff") ≫ `gray_ice` (100) >
  `shell_ice` (44) > `snow_ice`/`white_ice` (20) > `sandwich_ice` (12) > `candled_ice` (10). All present.
- **Surface tags:** `glass`/`smooth` (245) dominant; `cracked_surface` (89), `snow_covered` (73),
  `rubble` (72), `bumpy` (66), `rough` (62), `slushy` (54), `drifted` (45) all well-used.
- **Hazards:** `open_water`/`lead` (218) and `pressure_ridge` (116) dominate; `thin_ice` (49),
  `shell_area` (44), `inlet/outlet/current/spring` (35) follow. The `dry` vs `wet` crack distinction
  is corroborated — skaters explicitly call out "dry cracks" as normal.

**Refinement candidates — RESOLVED for Phase 2 (2026-07-13), applied to `@skating/core` `SURFACE_TAGS`.**
Decision: **keep a superset** — add clearly-useful terms, don't strip low-usage ones that still have
real meaning (cheap to keep; a missing tag can't be picked, a rare tag just sits unused):
- **Added:** `orange_peel` (49 occ) — a vivid, frequently-used dimpled/textured surface, finer-grained
  than `bumpy`. Now a `surfaceTag`.
- **Kept despite near-zero corpus usage (founder call — superset over stripping):** `windswept`
  (0 occ; overlaps `drifted`, 45) and `frozen_chop` (1 occ). Both have clear meaning and may come up;
  retained so the vocab is a superset.
- **Not added — `glare_ice` (5 occ):** redundant with the IS-vs-SKATES split — "glare ice" = clear
  glossy ice = `black_ice` (ice type) + `glass` (surface). Adding it as its own tag would create
  cross-dimension ambiguity for little gain at 5 occurrences.
- **Held — `resurfaced` (7 occ):** left out for now; overlaps `smooth`/`glass`. Revisit only if
  report-form testing surfaces a real gap.
- **Not an enum gap, but notable:** "wild ice" (53) is the sport's own name (wild/Nordic skating),
  not a surface/ice descriptor. Informal quality words (`solid`, `supportable`, `skateable`) map to
  the coarse `skateQuality` (D23).

**Report-shape signals (validate which fields matter):** ~**40% of posts carry photos** (436 image
attachments) — justifies a first-class photo pipeline (D31/D42); **41%** mention conditions; only
**16%** mention thickness — corroborating that `iceThickness` is genuinely *optional* (D22). Thread
data: 865 threads, 703 standalone vs. 162 with replies (~19%) — right-sizes comments-as-v1 (D21).

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
profiles *─* profiles  (blocks — no follow graph, D13)
profiles *─* waterBodies  (waterBodyFavorites — place-based curation, D13; Phase 4)
waterBodies 1─* putIns  (derived from reports.point + admin-set; Phase 4)
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
- **Age gate & minor status:** derived from `profiles.dateOfBirth` (D41) — the 16+
  signup gate and the under-18 protective defaults (`@skating/core` age math). Computed
  at read time, so the minor→adult transition needs no birthdate re-attestation or
  scheduled job; protections persist past 18 until the user widens them.
- **Drive-time band (Phase 4):** `profiles.cachedIsochrones.band30/band60` (ORS) + `outerRadiusMeters`
  (90-min crow-flies fallback) → point-in-polygon / radius test against `waterBodies.centroid` /
  `reports.point`, yielding `30 | 60 | 90 | null` **at read time** (D18). Deliberately not materialized
  per-user (staleness + scale). **Notification fan-out is the reverse lookup** — a per-user polygon scan,
  moved out of `reports.create` into a scheduled paged job by N1 so the write path doesn't scale with user
  count; a reverse spatial index (making the walk unnecessary rather than merely bounded) is still a
  documented future seam.
- **Derived put-in markers (Phase 4):** cluster `reports.point` (visible + `showPutIn != false`) per body,
  snap to shore, merge with `putIns` (`official`) minus `hidden`/suppressed.
- **Weather-since-report strip:** computed from Open-Meteo over [skateTime → now]
  (D19; spec in `04-integrations.md`); cache per (waterBody, window).
- **Hazard freshness state:** derived from `lastConfirmedAt` at read time (D15).
- **Newsfeed:** global by default (Phase 5), sorted by `skateEndTime` desc, minus moderation-hidden
  (a block never hides a report, D3 — it de-emphasizes). **Phase 4** layers the `feedFilterPrefs` as an
  *additive* narrow (drive band + quality/thickness/no-snow/type/recency, **include-unknown** for optional
  fields) and **boosts favorites** (favorites exempt from the distance narrow, not the rest).
- **Trust score (D50):** `profiles.reputationPoints` aggregated from `pointEvents`
  (helpful marks + window-bounded corroboration). Corroboration is derived from `reports`
  on the same `waterBodyId` within a tunable window whose ice descriptors agree — no stored
  social edges. Boost-only; reputational/cosmetic (D17), never a safety weight (D3).

---

## Convex notes
- **Spatial index (D5, rebuilt as N1 2026-07-26): the ladder grid.** An object gets one row per
  grid cell its **bbox** covers, in a plain Convex table — `waterBodyCells` and `adminAreaCells`,
  both keyed `by_cell = [z, x, y, …]`. A viewport read scans the cells covering the viewport at every
  rung up to the current zoom; a containment lookup scans one cell per rung. See
  [`phase-N1-read-path-durability.md`](./phase-N1-read-path-durability.md) and
  `packages/core/src/spatialCells.ts`.
  - **Which rung:** the coarser of *how big the object is* and (for water bodies) *the zoom it first
    draws at* (D49 `minVisibleZoom`). That ceiling is what makes a zoom-filtered query provably
    complete — an object is never indexed finer than the zoom it appears at.
  - **Viewport semantic (unchanged, now exact): a body is "in view" when its `bbox` intersects the
    viewport**, not when its centroid is inside it — a large lake can fill the screen with its
    centroid off-screen. Because a body is in *every* cell it covers, this needs no margin and no
    large-body special case; candidates are refined with `bboxIntersects` from `@skating/core`.
  - **`listed` (D48) decides whether a body is indexed at all.** A removed / rejected / merged body
    has no cell rows, so the listing filter costs a read nothing. (It was previously a filter *key* on
    a centroid index that the query couldn't afford to use — the component's filter-stream
    intersection roughly halved its safe ceiling — so listing was re-checked in JS instead.)
  - **`@convex-dev/geospatial` was retired here**, along with `convex.config.ts`: the app installs no
    Convex components. Its reads scaled with `maxResults` rather than with results returned, which
    crashed a wide viewport against the 4,096-read cap twice (PRs #10/#11), and its one-point-per-key
    write API couldn't express bbox coverage at all.
  - **Still not spatially indexed, deliberately:** `reports.point` and hazard centers. Hazards are
    only ever read per body (Phase 9 call 6); a reports index waits for a near-me query that needs it.
- **Polygon tests** (in-isochrone, in-water-body, hazard proximity) = bbox prefilter
  via indexed `bbox` fields + precise **Turf.js** in a Convex query/action. The pure
  Turf-backed primitives live in `@skating/core` (`bboxIntersects`, `pointInPolygon`,
  `polygonIoU`, `bufferedLineOverlap`, `polygonBBox`) with property tests, and the Convex side wires
  them in: the cell scan prefilters, `bboxIntersects` / `pointInPolygon` refine.
- **Suggested indexes:** `reports` by `waterBodyId + skateTime`, by `authorId`;
  `hazards` by `waterBodyId + status`;
  `gpsActivities` by `provider + providerActivityId` (unique, dedup) and by
  `waterBodyId` (per-lake skate history + bounty eligibility, D44); `comments`
  by `reportId`; `activityConnections` by `userId`; `bounties` by
  `waterBodyId + status`; `blocks` by `blockerId` and by `blockedId`;
  `waterBodyFavorites` by `userId` (my favorites) and by `waterBodyId` (notification fan-out — Phase 4);
  `putIns` by `waterBodyId` (Phase 4);
  `contentFlags` by `status` and by `targetType + targetId`; `reportRatings` by
  `reportId` and a unique `raterId + reportId` (one rating per rater/report, D50); `waterBodies` by
  `dedupStatus` (review queue), by `reviewStatus` (user-body approval queue, D37), and by
  `externalId` (idempotent canonical OSM/NHD upsert, D14/D48 — `by_external_id`);
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
- **Age gate & report/profile privacy** → 16+ minimum (DOB stored, age/minor status derived, D41);
  **reports are always public** — no visibility field (D13); the only privacy switch is
  `profileVisibility` (`public`/`private`); minors are forced-private and **read-only** (can't post
  reports until 18, D41).
- **Notification prefs ↔ types** → `notificationPrefs` keys mirror `notifications.type`
  1:1 (every type toggleable, D16); `reportRated` added.

**Still open:**
- *(none in the data model right now — see `02-open-questions.md` for product-level
  open items like forum ingestion.)*
