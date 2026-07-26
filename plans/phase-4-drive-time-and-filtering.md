# Phase 4 — Drive-time + dynamic filtering

> **Roadmap:** [`07-roadmap.md`](./07-roadmap.md) → Phase 4. This is the detailed build plan,
> in the style of the Phase 1/2/2.5/3/5 docs.
>
> **What this phase is.** Turns drive-time from a *hard global gate* (the original Phase-4 sketch)
> into a **soft, quality-weighted signal that behaves differently per context** — one thing while you
> *browse* (the newsfeed, pull), another while you're *notified* (push). It also lands **favorites**
> (place-based curation — the D13 stand-in for the removed people-follow graph), a **persisted feed
> filter row**, **put-in markers + directions** on the map, and an **offline read-cache** of recent
> reports. It layers on top of the global Phase 5 feed as an **additive filter** — the feed page and
> card don't change; the result set narrows and re-orders.
>
> **Status:** ✅ **Complete on dev (2026-07-18), PR #19** (prod deferred — Convex prod uninitialized).
> All six workstreams shipped (favorites, drive-time bands, feed filter row, notification queue + 8pm
> digest, put-ins + directions, offline read-cache). Review follow-ups (2026-07-18): the digest now
> consolidates per user into one notification grouped by body; profiles carry denormalized
> `reportCount`/`commentCount` for true totals; per-body report lists paginate; the feed shows recency
> scroll headers; minors are gated out of photo upload. **Push delivery is deferred** — the flush lands
> an in-app `notifications` row (the `coalesceKey` seeds the eventual APNs collapse-id / Android tag).
> Self-hosted ORS (true 90-min band) + "Recommended" filter-breaking posts remain deferred (see below).
>
> **Build order:** web first, then mobile (mirrors Phase 2/3/5). Backend + `@skating/core` geometry
> front-load; both clients consume the same `listFeed` filter args + isochrone helpers.

Decisions referenced as D#; see [`01-decisions.md`](./01-decisions.md).

---

## The core reframe (founder discussion, 2026-07-17)

Drive-time is **not** a binary "is this lake in range?" gate. Real behavior is quality-weighted:
*"On a normal day I won't drive more than ~30–45 min; but for perfect ice I'll do 90; 3 hours is too
far for anything short of a favorite."* So acceptable distance **rises with ice quality**, and the
right scoping differs by surface:

- **Browse (newsfeed) = pull, permissive default.** Show *everything* by default; filters *narrow* it;
  favorites get a prominence boost. The user is already looking — never hide by default.
- **Notifications = push, conservative default.** Only interrupt for things worth interrupting for:
  favorites (default on), and opt-in distance/quality bands.

Favorites are the **strongest signal** and cut across both: notify by default, boosted + prominent in
the feed, and highlighted on the map.

---

## Decisions locked this session (2026-07-17)

1. **Favorites (`waterBodyFavorites`) — place-based curation, the D13 stand-in.**
   A user marks specific water bodies as favorites (per-body opt-in). Effects:
   - **Notifications:** favorited-body reports notify **by default** (see #4), regardless of distance.
   - **Feed:** favorites get a **prominence boost** (pinned/badged near the top of an otherwise
     chronological page) and are **exempt from the distance filter** — but **still subject to the
     quality / snow / recency filters** (founder call: a favorite you don't want to hear about in bad
     conditions shouldn't jump the filters you deliberately set).
   - **Map:** favorited bodies are **visually highlighted**.
   - Schema: a small `waterBodyFavorites` join (`userId × waterBodyId`), indexed both directions.

2. **Three drive-time bands (30 / 60 / 90 min) stored as isochrone *polygons*, NOT membership rows.**
   - Store the bands as **nested isochrone polygons on `profiles`** and derive a lake's band at read
     time (bbox prefilter → Turf `pointInPolygon`, the existing D5/D36 machinery). **Do not** materialize
     a `userId × waterBodyId × band` membership table: within 90 min of a NE home there can be hundreds–
     thousands of bodies, it balloons per-user, and it **goes stale every time the corpus changes**
     (new user-created bodies, re-imports). Polygons auto-classify any new body for free.
   - **The 60-min hosted-ORS cap is real** (the public OpenRouteService isochrone API is hardcoded to a
     max range of 3600s = 60 min for `driving-car`). So: **30 & 60 bands come from ORS; the 90 band is a
     uniform crow-flies radius fallback** for now (tuned conservatively — rural NE effective driving
     speed ≪ highway; start ~45 mph ⇒ ~65 mi for 90 min, tunable). A crow-flies ring **over-approximates**
     reach (ignores roads/mountains/water crossings), which is acceptable for the *outer, aspirational*
     ring (low precision needed — it's the "would I make a special trip?" band). **Self-hosting ORS for a
     true 90-min isochrone is deferred** — see `07-roadmap.md` → Later/deferred.
   - `homeCoord` stays **PRIVATE** (D11): only the derived polygons + the outer radius are stored, never
     exposed. Recompute on home/pref change (D18), stamping `cachedIsochronesAt`.
   - **Known scaling seam (documented, not built): notification fan-out is the *reverse* lookup.** Browse
     asks "given my polygons, is this lake in-band?" (cheap, per-user, fresh). Notifications ask, per new
     report, "which users have *this lake* in their X-band?" With only polygons that's a scan over users'
     polygons per report — **fine at alpha scale** (dozens–hundreds of users). A reverse spatial index
     (index user home-points, or per-lake precomputed notify sets) is the future optimization; **not now.**
     *(Amended by N1, 2026-07-26: that scan was inline in `reports.create`, i.e. an unbounded read inside
     the app's most important write. It's now a **scheduled, self-continuing paged job** — bounded per
     invocation, and nobody gets dropped. The reverse index is still the real fix, still deferred: N1
     made the walk cheap to survive, not unnecessary.)*

3. **Newsfeed dynamic filter row — persisted, offline-first, additive on `listFeed`.**
   A filter bar above the Phase 5 feed, defaulting to *show all*:
   - **Drive radius** — off / 30 / 60 / 90 (matches the bands in #2).
   - **Overall quality floor** — `skateQuality ≥ {good, great}`.
   - **Ice thickness floor** — min cm.
   - **No snow cover** — checkbox.
   - **Ideal ice / surface types** — checkboxes (e.g. `black_ice`; `glass`/`smooth`).
   - **Recency floor** — last 24h / 48h / 7d / off *(added this session — see #5)*.
   - **⚠️ Optional-field semantics — include-unknown by default.** Quality, thickness, and snow depth are
     optional (only ~16% of corpus reports mention thickness). A quality/thickness floor **must NOT drop
     reports that simply omit the field** — otherwise a "≥4 in" filter hides 84% of reports. Default:
     **include reports missing the attribute**; only exclude them if we later add an explicit
     "must have measured thickness" toggle. **"No snow" keys off `surfaceTags`** (`snow_covered`/`drifted`),
     **not** the sparse `snowCoverCm` numeric.
   - **Favorites** are exempt from the *distance* filter but obey quality/snow/recency (see #1).

4. **Notifications — three opt-in types + a coalescing queue.**
   Types (each a `notificationPrefs` toggle, mirroring `notifications.type` 1:1 per D16):
   - **Favorites** (`favoriteReport`) — **default ON**; any report on a favorited body, any distance.
   - **All reports within X₁** (`nearbyReportDigest`) — opt-in; radius `allRadiusMinutes` ∈ {30,60,90}.
   - **Great reports within X₂** (`greatReportNearby`) — opt-in; radius `greatRadiusMinutes` ∈ {30,60,90},
     with **X₂ ≥ X₁** (two independent radii — the model that encodes "I'll drive *farther* for better
     ice"). Fires on `skateQuality == great`.

   **Delivery = a coalescing queue, not per-report fire-and-forget, and never "un-send":**
   - **"All within X₁" → a once-daily digest at 8pm ET** (tunable), grouped by water body. Corpus check:
     ~87% of reports are submitted before 8pm ET; the after-8pm stragglers that miss the digest are, by
     construction, the lowest-priority slice (non-favorite, non-great). *(Per-user local-time / true-sunset
     offset is deferred — matters once we serve more than one timezone.)*
   - **Favorites + Great → fire ~individually**, even after 8pm, but with a **short debounce/coalesce
     window on `(user, waterBody)`** so two reports on the same lake in quick succession become **one**
     push.
   - **Coalescing mechanism:** send with a stable key — APNs **`apns-collapse-id`** / Android notification
     **`tag`** — so a second push **replaces** the first on-screen ("2 new reports on Lake Morey"). You
     can't retract a delivered push, so we don't try; the replacement supersedes it whether or not it was
     read. **⚠️ Verify Expo's push API surfaces `collapseId`** — if it doesn't, self-manage by holding a
     short server-side debounce window and sending one combined push.
   - Model outbound as a **queue row with a coalescing key**, flushed by the digest cron (all-bucket) or a
     short debounce (favorites/great).

5. **Recency in the feed — headers + an optional hard floor.**
   - **Section-divider headers** ("Older than 2 days") interleaved in the infinite scroll — pure
     client-side, derived from `skateEndTime` as the user scrolls. Orients the casual scroller; no query
     change.
   - **Optional hard recency floor** (#3) for "only show me the last 48h." Both ship; they serve
     different users and don't conflict.

6. **Filter memory — local-first + server-sync.**
   Persist the filter row so it stays how the user left it. **Local storage is the working copy** (UI
   always reads it → instant, offline-safe); a **`profiles.feedFilterPrefs` blob is the durable/sync
   copy**; reconcile **last-write-wins** on connect (UI prefs, no conflict stakes). Same offline-first
   shape as the Phase 2 report queue.

7. **Put-in markers + directions on the map.**
   - **Derived from report points**, with curation and privacy controls — a small **`putIns` entity**
     (not pure read-time derivation), because we need to store admin-set official ones *and* give
     moderators something concrete to hide.
     - `source: derived` markers are **materialized by clustering visible report points**, **snapped to
       the nearest shore/road edge** (a report `point` can be mid-lake / on-ice — it is *not* a true
       put-in, so derived markers are approximate).
     - `source: official` markers are **admin-set** (accurate; priority styling) from the operator
       dashboard (Phase 7 surface; the data + mutation land here).
   - **Per-report `showPutIn` opt-out** (default on) for private-property access — hides the **precise
     pin** but keeps the **coarse town-level `place` label** (Phase 5); we suppress a marker, we don't
     scrub location.
   - **Moderator hide = per-coord suppression** (one action kills the marker regardless of how many
     reports feed it) + a `moderationActions` audit row.
   - **Directions deep-link from the lake detail drawer/page button** (never a map tap — a map tap opens
     the detail drawer). Platform-aware: `maps.apple.com/?daddr=…` on iOS, Google Maps on Android/web.
     **Destination = a put-in coord, never the on-water `centroid`** (the centroid is a guaranteed
     on-water point, so routing there drives you into the middle of the lake).

8. **Offline read-cache of recent reports (mobile).**
   Reuse the **expo-sqlite** infra from the Phase 2 F2 offline write-queue. Cache, for on-ice-without-
   service recall:
   - feed reports the user **read recently**,
   - reports for any lake whose **detail/drawer the user opened** (from feed or map) — a strong "might go
     there" signal,
   - **proactively pre-cache favorites'** recent reports on the last good connection (most likely to be
     standing on with no signal).
   - **Thumbnails only, not full photos** (full images blow the cache).

9. **"Recommended" filter-breaking feed posts → deferred to Phase 6.** Occasionally surfacing
   *exceptional* ice that breaks the user's own distance/quality/thickness filters is only trustworthy
   once we have **corroboration + trust (D50, Phase 6)** — one unverified "it's amazing!" report should
   not drive someone 3 hours. Documented in `07-roadmap.md` → Phase 6.

---

## Schema changes (all migration-aware — see `06-data-model.md`)

Applied in `packages/convex/convex/schema.ts`.

1. **`profiles` — isochrone bands + prefs (all optional ⇒ migration-free):**
   - Replace the single `cachedIsochrone?` with **`cachedIsochrones?: { band30?: geojson; band60?: geojson }`**
     + **`outerRadiusMeters?: number`** (the 90-band crow-flies fallback) + `cachedIsochronesAt?`.
   - **`feedFilterPrefs?`** — the server-sync copy of the filter row (#3/#6):
     `{ radiusMinutes?, qualityFloor?, thicknessFloorCm?, noSnow?, iceTypes?: string[], surfaceTags?: string[], recencyHours? }`.
   - Extend **`notificationPrefs`** with `favoriteReport` (default true), `nearbyReportDigest`,
     `greatReportNearby`, plus `allRadiusMinutes?` / `greatRadiusMinutes?` (X₁/X₂). (The legacy single
     `driveTimePrefMinutes` folds into these; keep or drop during the migration.)

2. **New `waterBodyFavorites` table** — `{ userId: ref(profiles), waterBodyId: ref(waterBodies), createdAt }`;
   indexes `by_user` and `by_water_body` (the fan-out lookup).

3. **New `putIns` table** —
   `{ waterBodyId: ref(waterBodies), coord: {lat,lng}, source: enum(derived, official), originReportId?: ref(reports), status: enum(visible, hidden), createdByUserId?: ref(profiles), createdAt }`;
   index `by_water_body`. Plus a per-body **suppression** notion for moderated derived coords (a `hidden`
   row, or a small suppression list) so a mod action outlives re-clustering.

4. **`reports.showPutIn?: boolean`** (default true; optional ⇒ migration-free) — the private-property
   opt-out that hides the precise put-in pin while keeping the coarse `place` label.

5. **`notifications.type`** — add `favorite_report`, `nearby_report_digest`, `great_report_nearby`
   (keys mirror `notificationPrefs` 1:1, D16). `payload` carries `reportId`/`waterBodyId` (+ a count for
   coalesced/digest notifications).

---

## `@skating/core` (pure logic first, 100% coverage — D40)

- **`driveTime.ts` (new):** `bandForCoord(point, { band30?, band60?, outerRadiusMeters }, home)` →
  `30 | 60 | 90 | null` (Turf `pointInPolygon` for 30/60, haversine radius for 90). `isWithinRadius`
  helper. Pure + property tested.
- **`feedFilters.ts` (new):** `matchesFilters(report, filters, { band, isFavorite })` — the single source
  of truth both clients and the query narrate. Encodes the **include-unknown** rule for optional fields,
  the favorites-exempt-from-distance rule, the `surfaceTags`-based "no snow", and the recency floor.
- **`putIn.ts` (new):** `clusterPutIns(points)` + `snapToEdge(coord, polygon)` (nearest shore/road edge);
  `directionsUrl(coord, platform)` (Apple/Google deep link). Pure + tested.
- Extend `notificationPrefs` / `feedFilterPrefs` types + validators.

## Convex backend

- **`waterBodyFavorites.ts` (new):** `toggle`, `listForUser`, `isFavorite`.
- **`profiles.ts` (extend):** on home/pref change, call the **isochrone action** (below) and cache
  `cachedIsochrones` + `outerRadiusMeters`. `setFeedFilterPrefs` (server-sync copy). `setNotificationPrefs`
  extended with the new toggles + radii.
- **`isochrones.ts` (new action):** call **hosted ORS** for the 30/60 polygons (`driving-car`, ranges
  1800/3600s); compute `outerRadiusMeters` for the 90 band; store on the profile. Rate-limited + cached
  (only on home/pref change). **Needs the OpenRouteService API key** (env). *(Self-hosted ORS → future,
  see roadmap Later/deferred.)*
- **`reports.listFeed` (extend, from Phase 5):** accept optional **`filters`** + the viewer's cached
  bands + favorite set; apply `matchesFilters` server-side; **boost favorites** to the top of the page.
  Additive — unfiltered behavior is exactly Phase 5.
- **`putIns.ts` (new):** `listForBody` (derived cluster over visible report points via `clusterPutIns`,
  merged with `official` rows, minus `hidden`/suppressed); `setOfficial` + `hide` (admin/mod, writes
  `moderationActions`).
- **Notifications:** a **coalescing queue** + a **daily digest cron** (Convex scheduled function, 8pm ET,
  tunable) that flushes the `nearbyReportDigest` bucket grouped by body; favorites/great enqueue with a
  short debounce. `reports.create` enqueues candidates (favorite-of / in-band / great-in-band) — the
  fan-out scan noted in decision #2.

## Web + Mobile UI

- **Feed filter row** above the Phase 5 feed (both clients), reading **local storage first** then
  reconciling `feedFilterPrefs` (LWW). Recency **section-divider headers** in the infinite scroll.
  Favorites badged/boosted.
- **Favorite toggle** on the lake detail drawer/page + a heart on feed cards/map.
- **Map:** highlight favorited bodies; render **put-in markers**; **Directions button in the lake detail
  drawer** (not on map tap) → platform deep link to a put-in coord.
- **Mobile offline read-cache** (expo-sqlite): cache read/opened/favorite reports (thumbnails only);
  serve from cache when offline.
- **Notification settings screen:** the three toggles + two radius pickers (X₂ ≥ X₁ enforced).

---

## Testing (lands with the feature — D40)

- **`@skating/core`:** `bandForCoord` (in/out of each band, radius edge); `matchesFilters` (**include-
  unknown** for missing quality/thickness/snow; favorites exempt from distance but not quality/recency;
  `surfaceTags`-based no-snow; recency floor); `clusterPutIns`/`snapToEdge`/`directionsUrl` per platform.
- **`convex-test`:** `waterBodyFavorites.toggle`; `listFeed` with filters (narrowing + favorite boost +
  include-unknown); `putIns.listForBody` (derived + official merge, hidden/suppressed excluded);
  notification fan-out enqueues the right recipients; the digest cron groups by body; coalescing key.
  `isochrones` action mocked (no live ORS in tests).
- **Web/Mobile:** filter-row persistence (local-first, server reconcile); recency headers; favorite
  toggle; directions deep link; mobile offline-cache read path.

---

## PR / commit breakdown (one PR per phase — memory: bundle-prs-by-phase)

- **A — `@skating/core`:** `driveTime.ts`, `feedFilters.ts`, `putIn.ts`, pref/type extensions + tests.
- **B — Convex:** schema (bands/prefs/`feedFilterPrefs`, `waterBodyFavorites`, `putIns`, `reports.showPutIn`,
  notification types) + `isochrones` action + `listFeed` filter/boost + `putIns` + favorites + the
  coalescing queue + digest cron + `convex-test`.
- **C — Web:** filter row + persistence, favorite toggle/boost, map highlight + put-ins + directions,
  notification settings.
- **D — Mobile:** the mirror + the expo-sqlite offline read-cache.

Push to the dev deployment (`convex dev --once`) + run any migration before verification
(memory: `convex-test-is-not-deploy`). **Needs the OpenRouteService API key.**

---

## Out of scope / deferred (logged so it isn't lost)

- **Self-hosted ORS** for a true 90-min (and beyond) isochrone band + higher rate limits + profile
  tuning → `07-roadmap.md` → Later/deferred. Until then the 90 band is a uniform crow-flies radius.
- **Reverse spatial index for notification fan-out** (per-lake notify sets / indexed home-points) →
  future scaling; the per-report user-polygon scan is fine at alpha scale (decision #2).
- **"Recommended" filter-breaking feed posts** → **Phase 6** (needs corroboration/trust, D50).
- **Per-user local-time / true-sunset digest timing** → later (fixed 8pm ET for the single-timezone
  pilot).
- **Operator UI for official put-ins** lives in the **Phase 7** admin surface; the `putIns` data +
  `setOfficial`/`hide` mutations land here.
