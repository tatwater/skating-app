# Roadmap

Phased build sequence. Each phase is independently useful and ends in something the
alpha crew can test. Decisions referenced as D#; see `01-decisions.md`.

> **Status (2026-07-24): every planned phase — 0 through 10 — is built.** Phase 8 was the last
> one, and with it the roadmap holds nothing unbuilt that wasn't *explicitly* deferred. What
> remains is not feature work: the **prod cutover** (Convex prod has never been initialized), the
> **device-verification backlog** (Phases 8/9/9.5 native surfaces), and the **deferred register** at
> the bottom of this doc — which is now grouped into candidate next phases (**N1–N8**) plus the
> hard-blocked list.

> **Seasonal context:** first ice is ~November; planning is happening in summer. The
> alpha crew won't lean on the app until most phases are in place, so it's fine to
> build core plumbing early even when a user-facing headline feature lands later.

> **Start now (lead-time gates, in parallel with Phase 0):** Apple Developer
> enrollment; Strava API app; **Garmin / COROS / Polar partner applications**
> (approval takes weeks — apply for *all* GPS providers now even though they ship
> fast-follow, D24); Clerk, Convex, Vercel, Expo, **Sentry** accounts. See
> `05-accounts-and-credentials.md`.

## Phase 0 — Foundations ✅ Complete (2026-07-12)
> **Status:** shipped and verified. Both apps sign in (age-gated, risk ack recorded); the
> web app is **deployed to Vercel** (TanStack Start via the Nitro Vite plugin → a real SSR
> Vercel Function) with Map + Newsfeed rendering behind the provisioning gate; CI (`pnpm lint`
> + `turbo check-types test`) is green with coverage; crashes report to Sentry on both
> surfaces (confirmed capturing a live server error). Getting the first deploy green took a
> chain of fixes: a `build` task that runs Convex codegen (`_generated` is gitignored), the
> Nitro plugin for a Vercel-servable server, an `apps/web`-local `@clerk/shared` v4 pin (the
> web/mobile stacks need different majors under the hoisted linker), and piping the
> `VITE_*`/`SENTRY_*` env vars through `turbo.json` so the build receives them.

- **Turborepo + pnpm** monorepo (D39): `apps/mobile`, `apps/web`, shared `packages/*`
  (design tokens, Convex client, types/validators, logic) (D7).
- **Biome** lint/format + **Vitest + CI from day one** (D40/D46): GitHub Actions
  running `pnpm lint` + `turbo check-types test`, coverage reporting wired even while
  suites are small. Test scaffolding is boilerplate — stand it up now so every later
  phase lands with tests. *(`@skating/core` is the first package: pure logic at 100%
  coverage with example + property tests.)*
- Convex project + schema from `06-data-model.md`.
- **Clerk** auth wired to Convex (D26), on both Expo + web, with the **age gate (16+)**
  and **assumption-of-risk acknowledgment** at signup (D41/D45).
  - **Shipped:** the server contract is the trust boundary (D37) — `profiles.upsertFromClerk`
    enforces the 16+ DOB gate and **requires + records** a current risk acknowledgment
    (`RISK_ACK_VERSION` single-sourced in `@skating/core`). Mobile sign-up UI collects DOB +
    shows the blocking acknowledgment.
  - **Shipped (mobile auth-provisioning):** a **profile-provisioning gate** in the root
    navigator admits a signed-in user to the tabs only once their `profiles` row records a
    **current** risk acknowledgment. The other signed-in states each get a screen: no row
    → **onboarding** (collects **username + displayName + DOB + risk ack**, calls
    `upsertFromClerk`); a missing/stale ack after a `RISK_ACK_VERSION` bump → a **re-ack**
    screen (renews consent only, via `acceptCurrentRiskAck` — no re-entering fields). DOB +
    ack flow through the enforced mutations — Clerk `unsafeMetadata` is no longer used, and
    the acceptance time is **server-stamped**, never client-supplied. Username/displayName
    rules (normalize + validate) are single-sourced in `@skating/core` and re-enforced
    server-side (D37).
  - **Shipped (web auth/provisioning):** `apps/web` mirrors the mobile gate via the *same*
    pure `resolveAuthRoute` (lifted to `@skating/core` alongside `parseDateOfBirth`, D7). A
    client-side `AuthGate` redirects into the right zone; **onboarding** calls
    `upsertFromClerk`, **re-ack** calls `acceptCurrentRiskAck`. Sign-in/up use Clerk's
    prebuilt `<SignIn>/<SignUp>` (this SDK's custom-flow hooks moved to a newer "signals"
    API; prebuilt is the durable choice and flows straight into onboarding).
- App shells: **Expo** (Expo Router tabs) + **TanStack Start** (Vite 8, file-based routing;
  deployed to **Vercel**, D27). **Web scaffold shipped:** Map (`/`) + Newsfeed (`/feed`)
  top-level, Report/Bounties folded in, profiles at `/u/:username` (D47); placeholder pages
  like mobile.
- FUI design tokens consumed by Tailwind (web, via a CSS-variable bridge with a drift-guard
  test) + Tamagui (mobile) (D7), with **high-contrast + dark themes** scaffolded (D34).
- **Sentry** wired on both surfaces from day one (D29).
- **License hygiene:** `LICENSE` (AGPL-3.0) + `LICENSE-EXCEPTIONS.md` (App Store /
  Play exception, D43) present and referenced from README + each app's about screen.
- **Done ✅:** sign in on both apps (age-gated, risk ack recorded); empty Map + Newsfeed
  pages render; CI is green with coverage reporting; deploy is green; crashes report
  to Sentry.
- Needs: Convex, Clerk, Vercel, Expo, Apple (dev build), Sentry.
- **Follow-ups (non-blocking):** set `SENTRY_AUTH_TOKEN` on Vercel to enable build-time
  source-map upload (runtime crash reporting already works without it); Apple dev-build
  distribution for the mobile alpha crew is still pending its own track.

## Phase 1 — Water-body data ✅ Complete (2026-07-13)
> **Detailed build plan:** [`phase-1-water-bodies.md`](./phase-1-water-bodies.md).
> **Pilot region: Vermont** (compact; the Nordic-skating heartland — Lake Morey et al.).
> **Rivers deferred** to a later release (reaches are hard; pilot skating is still-water) —
> import lakes/ponds/reservoirs only.
>
> **Status:** shipped across PRs #7–#11. `@skating/core` OSM tag mapping + on-water point (#7);
> Convex `listed` refactor + `by_external_id` + `importCanonical` + admin remove/restore (#8);
> the `scripts/etl` OSM pipeline + the real 9,967-body Vermont import (#9); the read-only MapLibre
> web map + the two-tier `listInViewport` fix that made the corpus queryable at scale (#10); and
> the **self-hosted Vermont `.pmtiles` basemap** — built with `pmtiles extract` (z0–14, ~280 MB),
> hosted on **Convex file storage** (colocated; its serving URL passes the `Range` + CORS checks
> `pmtiles://` needs), tooling + reproducible pipeline in `scripts/basemap` (#11). All tests green
> with coverage held. **Operational follow-ups (you own):** set `VITE_PMTILES_URL` to the dev
> serving URL in local `.env`, confirm the map renders against self-hosted tiles, then re-run the
> upload with `--prod` and set the prod URL in Vercel. Off-ramp to Cloudflare R2 (zero egress) is
> documented if tile bandwidth grows.

- **OSM ETL** (`scripts/etl`, run manually) for Vermont: filter water features, map OSM
  tags → our `type` enum, **simplify to ~5 m fidelity** (Google/Apple-parity for click
  zones + fill coloring), compute `bbox` / `centroid` (an **on-water** point, D48) /
  `surfaceAreaSqM`; emit NDJSON keyed by OSM id (D5/D14). Store generously — clutter is a
  *display* problem (zoom-based rendering), not a reason to under-populate (D48).
- **Idempotent import** into `waterBodies`: an internal `importCanonical` mutation
  (`source: 'osm'`, `listed: true`), upsert-keyed on `source + externalId` (new
  **`by_external_id`** index), inserting centroids into the geospatial index. Re-runnable;
  **preserves removed state** across re-imports (D48).
- **`listed` filter-key refactor + bbox-intersection viewport (D5/D48):** replace the
  Phase-0 `reviewStatus`-only geospatial filter with the derived `listed` boolean (fixes
  canonical bodies being hidden + the D37 auto-visible contradiction), and implement the
  decided bbox-intersection `listInViewport` (expanded geospatial prefilter → `@skating/core`
  `bboxIntersects` refine), now tunable against the real polygon corpus.
- **Admin remove/restore (D48):** minimal `remove`/`restore` mutations (soft-delist +
  `removalReason` + `moderationActions` audit row) so the fresh import can be curated and a
  landowner takedown honored. Request-intake UX defers to Phase 7.
- **Read-only map layer (web):** a MapLibre map (**Protomaps `.pmtiles`** basemap, D6 —
  start on hosted demo tiles, swap to a self-built Vermont extract) rendering the imported
  polygons, to *confirm* the data. Full interactive map + report creation stays Phase 2.
- **Attribution:** "© OpenStreetMap contributors" (**ODbL**) shown wherever the data/basemap
  appears — a build-time acceptance criterion like "Powered by Strava" (see
  `04-integrations.md`).
- **Done:** Vermont water bodies queryable by bbox (bbox-intersection) and rendering on the
  read-only web map, with OSM attribution; admins can remove/restore a body.
- Needs: OSM extract tooling (osmium/GDAL + a JS simplify pass), Convex, a Protomaps
  basemap (self-built or hosted demo).

## Phase 2 — Map + reports (the MVP) ✅ Complete (2026-07-16)
> **Detailed build plan:** [`phase-2-map-and-reports.md`](./phase-2-map-and-reports.md).
> **Web first, then mobile (two PRs)** — web front-loads the shared Convex backend and proves the
> whole data model online before the native-build + offline-capture (D30) lift. No store/dev-account
> dependency blocks it (web ships on Vercel; mobile needs only an EAS dev build + — for physical
> iPhones — Apple Developer enrollment, which should start now in parallel).
>
> **Status (web MVP): ✅ shipped (2026-07-13)** — §A–§E complete: `@skating/core` scoring/validation,
> Convex `reports`/`photos` + D49 geospatial zoom filter + `waterBodies.get`/`setCuratedBoost`, the
> interactive map (tap→detail, geolocation framing, deep-linkable `/water/$id` · `/report/$id`
> drawers), and report create (multi-reading thickness, manual conditions, put-in pin, photos with
> HEIC decode + EXIF strip + geotag opt-in). Built on shadcn/ui (Base UI).
>
> **Status (mobile §F1): ✅ shipped (2026-07-14, PR #13)** — native `@maplibre/maplibre-react-native`
> map with the D49 zoom filter, `expo-location` framing, `@gorhom/bottom-sheet` drawers +
> deep-linkable `/water/[id]` · `/report/[id]`, and the read + **online** report-create loop
> (native `expo-image-picker`/`expo-image-manipulator` photo pipeline). Shared helpers lifted into
> `@skating/core`.
>
> **Status (mobile §F2 — offline draft queue, D30): ✅ shipped (2026-07-16, dev)** — capture a
> report with no signal and it flushes on reconnect. `@skating/core` carries the pure heart: a
> buffered `pointInPolygon` GPS→lake resolver and a checkpointed, idempotent flush state machine
> (transient-retry vs. permanent-park). On-device an `expo-sqlite` LRU caches recently-viewed body
> polygons (Layer 2 — GPS auto-select offline, reused by Phase 9), plus an `expo-sqlite` +
> `expo-file-system` draft queue with NetInfo/foreground/manual flush; `reports.create` is idempotent
> on an additive `idempotencyKey`, and `waterBodies.resolveBodyForCoord` resolves a coord-only draft
> at flush. Offline editing + a drafts list ship too. **Offline basemap *tiles* (F2 "Layer 3") were
> deferred to Phase 9** (hazard pins need them; report capture doesn't). Native UI pending an emulator
> verification pass (pure + Convex layers are tested).

- MapLibre map (D6) with wintery style; home/water framing on open (D20).
- **Zoom-scored display prominence (D49):** which bodies draw at a given zoom is a derived
  display score (area now; popularity + admin `curatedBoost` later), decoupled from the D48
  `listed` gate — so a small-but-beloved lake (Lake Morey) can still show at state zoom while
  clutter drops. Phase 1 only stores `surfaceAreaSqM`; the score/threshold lands here.
- Tap a water body → detail view (name, area, report feed by **skate time**).
- Create + read a **report** (ice types, surface tags, coarse quality, structured
  thickness, photos, conditions) — always public (D13, no visibility field) and
  **offline-capable** (D9/D30), with **client-side image optimization + EXIF stripping**
  on upload (D31/D42).
- **Photo geotag opt-in** (D42): default off; if on, photos pin at their coord within
  the water body.
- **Reports are always public** (D13) — no per-report visibility field at all. Minors are
  **read-only** (can't post; D41). *(The Phase 2 web/mobile MVP shipped with a 2-level visibility
  selector; it was removed in the D13 revision — reports carry no visibility now.)*
- *(User-created water bodies + dedup **moved to Phase 8**, decided 2026-07-13 — the good version is
  GPS-path-backed, and the Vermont OSM corpus already covers the alpha. See Phase 8.)*
- **Done:** friends can post and read reports on real lakes. *This is the usable MVP.*
- Needs: MapLibre + tiles (Protomaps), Convex file storage.

## Phase 2.5 — Regional expansion (Northeast skating states) ✅ Complete (dev; prod deferred) (2026-07-15)
> **Detailed plan + runbook:** [`phase-2.5-regional-expansion.md`](./phase-2.5-regional-expansion.md)
> (was §H of the Phase 2 plan). Slotted **after the mobile online loop (F1); reordered ahead of F2**
> (2026-07-14 — F2 is the orthogonal offline queue). It's data + infra, so it doesn't gate the
> community layer (Phase 3) — but the corpus should be region-complete before drive-time / feeds
> (Phase 4/5) reason over it.
>
> **Status: ✅ mostly shipped on dev (2026-07-15)** — ~116k bodies across NY/VT/NH/ME/MA imported
> (NY clipped downstate), a 948 MB multi-state basemap on Cloudflare R2, map bounds widened to the
> region, a **lake name-search box** (added when the big corpus made it near-essential) in both apps,
> and the **`curatedBoost` re-seed** (mechanism `applyCuratedBoostSeed` shipped + VT seed applied at
> flat +0.3 — 21 bodies boosted). **Remaining:** clean per-body curation (a few bay mis-matches; add
> the Champlain/Lake George bays OSM lacks) via the **Phase 7 admin UI**, and the prod cutover
> (Convex prod uninitialized).

Widen the pilot's **single-state Vermont** corpus + basemap to the Northeast **lake-skating** states.
- **Region scope (decided 2026-07-14):** **NY (upstate/northern only — exclude NYC + Long Island),
  VT, NH, ME, MA.** Deliberately **not** the whole Geofabrik "us/northeast" dump: nothing south or
  west of NY (no NJ/PA — and CT/RI omitted too) — no lake-skating culture there, so importing them is
  pure clutter + cost. Use **per-state Geofabrik extracts** for exactly those 5 states; **clip NY by
  bbox** to drop the NYC/Long Island metro.
- **Water data:** re-run the Phase 1 ETL (`scripts/etl`) per state → `importCanonical` into Convex
  (each body scored for D49 on insert). Much bigger corpus than VT's ~9,970.
- **Basemap tiles → Cloudflare R2 (decided 2026-07-14):** the 5-state `.pmtiles` extract (z0–14) far
  exceeds VT's ~280 MB and **blows past the Convex free storage tier**, so the tiles move to
  **Cloudflare R2** now (zero egress, the standard pmtiles host — the off-ramp Phase 1 already flagged).
  The VT tiles migrate too, so all environments serve from one host. **App change is nil** — it reads
  `VITE_PMTILES_URL` / `EXPO_PUBLIC_PMTILES_URL`, so this is an env swap.
- **Map bounds + framing:** widen `VERMONT_MAX_BOUNDS` / `INITIAL_CENTER` + the geolocation in-region
  gate (web + mobile, kept in sync with the tile bbox) — **only after** the water data lands, so we
  never expose pan area with no data.
- **`curatedBoost` re-seed:** the VT seed CSV already lists NY/NH lakes (Lake George, Dillenbeck Bay)
  skipped for not being in the VT import — apply them once those states are in.
- **Done:** a skater anywhere in NY (north of the metro) / VT / NH / ME / MA opens the app and sees
  their lakes with a real basemap, served from R2.

## Phase 3 — Comments + profiles + user-facing safety tools ✅ Complete (2026-07-16)
> **Detailed build plan:** [`phase-3-community-and-safety.md`](./phase-3-community-and-safety.md)
> (design settled 2026-07-16 — the four "don't code into a corner" calls are recorded there).
>
> **Status: ✅ shipped on dev (2026-07-16, PR #17)** — all four workstreams landed: **A** `@skating/core`
> `comment`/`block` modules + revised `visibility` (report gate → moderation-only; `isAuthorBlocked` +
> the "a block never hides a report" invariant test); **B** Convex `blocks`/`comments`/`contentFlags`/
> `moderation` + extended `profiles` (search index, `getPublicProfile`, `searchProfiles`, `updateProfile`,
> `loadBlockedAuthorIds` union, `backfillNotificationPrefs`); **C** web UI (profile page + edit, 2-level
> comment threads with `[hidden]` placeholders, block/flag controls + "Blocked" chip, role-gated inline
> moderator actions, profile search, blocked-users list); **D** the mobile mirror. Review fixes followed:
> block-failure surfacing, a bidirectional "Blocked" chip, bounded profile reads, and a broadened
> profiles migration to canonicalize legacy `notificationPrefs` drift. Trust score renders `0` everywhere
> (D50 computation is Phase 6). Prod cutover still deferred (Convex prod uninitialized).
*(Was "Social graph + comments" — the **social graph was removed 2026-07-15 (D13)**. No
follows/friends. What remains is the community-interaction + safety layer, kept ahead of
the feeds so **blocks** are enforced before the Newsfeed filters on them.)*
- Threaded **comments** on reports (D21/D25). All reports are public (D13), so comments are too —
  gated only by moderation + blocks.
- **Profiles (D13):** public profiles are **searchable by name** and show name, photo, town/state,
  **bio**, #reports/#comments, trust score (D50), and full public report history; **private profiles
  are name + photo only** and not searchable (all minors; adults who opt in). No follow/friend graph.
- **User-facing safety tools (D32):** **block** users (block == "mute" — one feature); **flag/report**
  reports/comments/photos/users for abuse (incl. `unsafe_false_report`). Public UGC without block/flag
  is unacceptable, so these ship here.
- **A block hides the person's profile + comments + interaction, but NOT their reports (2026-07-16,
  safety-first D3):** an interpersonal block must never pull safety observations off the map/feed. A
  blocked author's report stays visible with a de-emphasized author line + a "Blocked" chip. (This
  refines the earlier "moderation-visible + not-blocked" note: report reads are **moderation-visible
  only**; the block set gates comments/profiles + drives author de-emphasis.)
- A minimal moderator **hide/remove** path (founder) so flagged content can be taken
  down immediately, even before the full operator surface (Phase 7).
- **Done ✅:** comment threads work; profiles are viewable/searchable (privacy respected);
  users can block/mute and flag; content can be quickly taken down.

## Phase 4 — Drive-time + dynamic filtering ✅ Complete (dev; prod deferred) (2026-07-18)
> **Detailed build plan:** [`phase-4-drive-time-and-filtering.md`](./phase-4-drive-time-and-filtering.md)
> (decisions settled 2026-07-17).
>
> **Status: ✅ shipped on dev (2026-07-18), PR #19** — all six workstreams landed: **favorites**
> (`waterBodyFavorites` — notify-by-default, feed boost exempt from distance, map highlight at *every*
> zoom); **three drive-time bands** as read-time isochrone polygons on `profiles` (30/60 from hosted ORS,
> 90 = crow-flies radius fallback; `homeCoord` stays private); the **persisted feed filter row**
> (include-unknown by default, local-first + `feedFilterPrefs` LWW sync); the **notification coalescing
> queue** (favorites / all-within-X₁ digest / great-within-X₂, X₂ ≥ X₁ enforced) drained by a
> DST-correct **8pm-ET digest** that rolls up per user into one notification grouped by body; **put-ins +
> directions** (derived from report points, drawer-only deep-link to a put-in coord); and the **mobile
> offline read-cache** (recently-read feed + opened lakes + favorites' recent reports). **Review
> follow-ups (2026-07-18):** consolidated per-user digest, denormalized profile `reportCount`/
> `commentCount` (true totals, not a windowed cap), paginated per-body report lists, recency scroll
> headers, minor photo-upload gate, and coverage/cleanup. **Push delivery is deferred** (flush lands an
> in-app `notifications` row); self-hosted ORS (true 90-min band) and the "Recommended" filter-breaking
> feed posts are deferred (roadmap Later / Phase 6). Prod cutover still deferred (Convex prod uninitialized).
> **Reframed 2026-07-17:** drive-time is now a **soft, quality-weighted signal that behaves differently
> per context** (browse vs. notify), not a hard global gate. Browse (feed) defaults *permissive* — show
> all, filters narrow, favorites boosted; notifications default *conservative* — favorites on, distance/
> quality opt-in.
- **Favorites (`waterBodyFavorites`) — the strongest signal + the D13 place-based curation stand-in.**
  Mark specific bodies as favorites: **notify by default**, **feed prominence boost** (exempt from the
  distance filter, but still subject to quality/snow/recency filters), and **map highlight**. You
  subscribe to *lakes*, not people.
- **Three drive-time bands (30/60/90) as isochrone *polygons* on `profiles`** (derive band at read time;
  **not** a per-user membership table — it balloons + goes stale). Hosted ORS caps at **60 min**, so 30/60
  come from ORS and the **90 band is a uniform crow-flies radius fallback** (self-hosted ORS deferred —
  see Later/deferred). `homeCoord` stays private (D11).
- **Newsfeed dynamic filter row (persisted, offline-first):** drive radius, quality floor, thickness
  floor, no-snow (off `surfaceTags`), ideal ice/surface types, **recency floor** + "older than N days"
  scroll headers. **Optional-field filters include-unknown by default** (a thickness floor must not hide
  the ~84% of reports without a reading). Filter memory = **local-first + `profiles.feedFilterPrefs`
  server-sync** (LWW). Additive on the Phase 5 `listFeed`.
- **Notifications = a coalescing queue, three opt-in types:** favorites (default on) · all within **X₁** ·
  great within **X₂** (**two independent radii, X₂ ≥ X₁** — "drive farther for better ice"). "All" →
  **once-daily 8pm-ET digest** grouped by body (corpus: ~87% of reports land before 8pm; misses are the
  lowest-priority slice); favorites/great fire ~individually, coalesced per `(user, waterBody)` via APNs
  `collapse-id` / Android `tag` (replace, never un-send).
- **Map put-ins + directions:** put-in markers **derived from report points** (+ admin-set official ones,
  Phase 7 UI), snapped to shore; per-report `showPutIn` opt-out (private property) + moderator hide.
  **Directions deep-link from the lake detail drawer button** (never a map tap), targeting a **put-in
  coord, not the on-water centroid**.
- **Mobile offline read-cache** (reuse expo-sqlite): recently-read + opened-lake + favorites' reports
  (thumbnails only) for on-ice-without-service recall (D9).
- **Done:** feed/map/notifications scope by favorites + quality-weighted drive-time; put-ins + directions
  on the map; filters persist; recent reports readable offline.
- **Needs:** OpenRouteService key. Notification fan-out uses a per-user polygon scan — moved off the
  `reports.create` write path into a scheduled paged job by N1; a reverse spatial index (removing the
  scan entirely) is still a documented future seam.

## Phase 5 — Newsfeed page ✅ Complete (dev; prod deferred) (2026-07-17)  *(brought forward ahead of Phase 4 — see doc)*
> **Detailed build plan:** [`phase-5-newsfeed.md`](./phase-5-newsfeed.md) (decisions settled 2026-07-16).
> **Reordered ahead of Phase 4 (2026-07-16):** the feed ships **global** (all lakes, all regions); the
> two drive-time bullets below — *"within range"* and *"temporarily expand radius"* — are definitionally
> Phase 4 and move there as an **additive filter** on the same `listFeed` query (near-zero rework).
- Cross-water-body feed, newest **skate-*end* time** first (D28) — **sort key redefined 2026-07-16:**
  `reports.skateTime` → **`skateEndTime`** ("when the skater left the ice" = the freshest read), a
  project-wide rename affecting every surface that sorts reports (per-body feed + profile history too).
  Also **store `skateStartTime`** (optional; duration derived, never stored) — manual form takes
  start-or-duration; `gpsActivities` gets `endTime`/`elapsedSeconds` prep (wired Phase 8). Shows
  **`public`** reports minus **blocks** (D13) — the block filter landed in Phase 3.
- Feed card carries the water body **name + a point-derived town/county + state label** (from the report's
  put-in pin / GPS start — shows which town/side, correct for multi-town/-state lakes; disambiguates
  same-name lakes). Backed by a new **`adminAreas`** boundary table (OSM, same ODbL) resolved at report
  create — no per-read geocode, no 116k-body backfill. Reused by GPS (Phase 8) + hazards (Phase 9).
- Tap a card → **report drawer/sheet** (no full navigation — preserves scroll); **photo carousel** in
  cards + drawer; empty state; pull-to-refresh (mobile).
- ~~**Temporarily expand radius** (session-only) to browse wider.~~ → **Phase 4** (needs drive-time).
- **Done:** browse recent community activity without going lake-by-lake.

## Phase 6 — Bounties + trust score ✅ Complete (dev; prod deferred) (2026-07-22)
> **Detailed build plan:** [`phase-6-bounties-and-trust.md`](./phase-6-bounties-and-trust.md) (decisions
> settled 2026-07-21). All six workstreams shipped on **web + mobile**, green (core/convex/web/mobile
> suites). Trust class is derived server-side + rendered as a cosmetic chip/ring (never a raw number, D50);
> bounty browse rides the bounded `by_status_expires` index (no viewport geospatial); recommended-feed
> caps are stateless (impression-tracking = logged fast-follow). Prod cutover outstanding.
- **Bounties:** request a report for a water body; notify eligible recent skaters (report
  *or* resolved GPS skate on that body, D44); fulfill; helpful/unhelpful thumbs →
  cosmetic points/badges (D10/D17).
  - *(Ordering note: this phase now precedes **GPS providers (Phase 8)**, so the "resolved GPS
    skate" half of eligibility (D44) lights up only once Phase 8 lands. Native **reports** are the
    eligibility signal at Phase 6 — enough for a working bounty loop; GPS widens it later.)*
- **Trust score (D50) — the asymmetric reputation signal that stands in for the removed
  social graph (D13).** A reporter's public trust score rises from two signals:
  - **(a) Corroboration within a similar timeframe.** An independent report on the **same
    water body within a tunable window** that **agrees** (similar `skateQuality`/`iceTypes`/
    hazards) boosts both reporters. **Boost-only + window-bounded:** a later report of
    *different* conditions is not counter-evidence (ice changed), so **nobody is penalized for
    conditions changing** — this protects honest "don't do it"/negative reports (D3). Derived
    from `reports` on the same body + `pointEvents` (`report_corroborated`); no social edges.
  - **(b) Helpful marks.** Any viewer can mark a report **useful/helpful** (`reportRatings`,
    D17); `helpful` raises the author's score. `unhelpful` feeds moderation/quality, not a
    public penalty.
  - **Constraints (D17/D3):** reputational/**cosmetic only** — never weights safety, never
    gates visibility/ranking of safety content, never makes the app assert ice is safe.
- **"Recommended" filter-breaking feed posts (moved here from Phase 4, 2026-07-17).** Occasionally
  inject into a user's feed an *exceptional* report that breaks their own **distance / quality / thickness**
  filters — so someone who never touches the filters still gets a shot at seeing a lake in rare condition.
  **Deliberately gated on this phase:** the "exceptional" bar must be **corroboration/trust (D50)**, not a
  lone `skateQuality == great`, or we'd build a machine for wasted trips (and implicitly amplify one
  unverified claim — a D3 concern). Mechanics: a relaxed complement query, ranked, **frequency-capped**
  (≤1–2 per session/day), **per-lake de-duped**, visually distinct ("Recommended — exceptional ice outside
  your usual range"); breaks distance/quality/thickness but **never recency, blocks, or moderation**.
- **Done:** end-to-end bounty loop; reporters accrue a public, boost-only trust score from
  corroboration + helpful marks; the feed can occasionally recommend corroborated exceptional ice
  outside a user's filters.

## Phase 7 — Operator surface (admin, moderation, dedup review) ✅ Complete (dev; prod deferred) (2026-07-24)
*(The founder-facing back office — the second half of the old combined phase.)*
> **Detailed build plan:** [`phase-7-operator-surface.md`](./phase-7-operator-surface.md) (planning
> session 2026-07-23; D37/D38 + the D49/D52/D56/D57 tuning surfaces). Read-only config control-room,
> in-house Convex analytics, in-context moderation across the web app, two PRs (operator core + analytics).
>
> **Shipped:** PR 7a (operator core — merged, #24) + PR 7b (analytics & tuning). Two Convex tables
> (`metricSnapshots` daily rollups, `bountyGateEvents` forward-only per-attempt), a `@skating/core`
> metric vocabulary, maintain-on-write counters for the events that leave no trace (contradiction
> funnel, flag dispositions, future-skate-time rejections), three rollup crons (6-hourly recompute,
> weekly corpus sweep, daily gate-event prune), the admin read layer + the tenure-aware
> contributor-trend query, a validated Recharts chart kit (dataviz-checked palette), and the
> `/admin/tuning` control-room + dashboard app-health strip + trust-trend panel.
>
> **Key build deltas vs this plan (settled 2026-07-23/-24 — the phase-7 doc is authoritative):**
> - **Config is a read-only control-room, NOT editable-in-dash.** The "admin UI to *edit* the
>   displayScore curve / HAZARD_DECAY / FRESH_REPORT_HOURS" bullets below are superseded: the founder
>   works with a coding agent, so *editing the constant in `@skating/core` and redeploying* is the
>   tuning workflow. Global constants render read-only (live value + explanation + companion chart +
>   "defined in `packages/core/…` · requires a redeploy"). Only genuinely per-row data stays editable
>   (`curatedBoost`, `weatherSamplePoints`, `canPost*`, ban/suspend/role, `bodyFeatures`). `appConfig`
>   (a runtime override table) is a documented future seam, not built speculatively.
> - **`bountyGateEvents` carries `requesterId`** (founder call): a cap-hit *rate* tunes the cap, but only
>   attribution answers whether a handful of requesters drive it — the case for the deferred
>   `activeBountyPostLimit` lever. Pruned at 180d (privacy + storage).
> - **The gate had to stop throwing to be observable.** A thrown Convex mutation rolls its writes back,
>   so a throwing gate could only log the attempts it *allowed*. `bounties.createChecked` now returns its
>   verdict and `create` re-raises it, so `suppressed`/`capped` events commit.
> - **Two planned metrics changed shape** to stay honest: `viewport_truncated` (client can't observe it —
>   post-query refinement drops rows) → `zoom_band_distribution` (server-side, points at the curve);
>   `weather_strip_renders` (client-only state) → `weather_strip_coverage` (corpus classified server-side).
> - **All five "additional stats flagged during planning" shipped** (cap-hit rate, photo-orphan count,
>   viewport→zoom-band, weather-strip coverage, future-skate rejection, per-state coverage).
- **Admin/moderator surface (D37):** a role-gated **`/admin` route tree in the web app**
  (not a separate app), organized as **work queues** — flag queue (with
  `unsafe_false_report` in a **priority lane** per D3), user admin (search/history,
  **ban/suspend/unban**, grant role), and a **support inbox** (`supportTickets`, D35 —
  not Zendesk). Role model expands to `member | moderator | admin` (admin ⊇ moderator).
- **Water-body dedup review queue (D36):** moderator view of `suspected_duplicate`
  bodies with a manual **merge** (re-point children → survivor, soft-tombstone loser),
  plus **approve/reject** of user-drawn bodies (`reviewStatus`, D37).
- **Display-tuning surface (D49):** ~~admin UI to edit~~ **read-only control-room view of** the
  `displayScore` curve constants (log-area bounds + score→zoom map) paired with the
  `zoom_band_distribution` chart, plus per-body **`curatedBoost`** set from the water-body surface
  (that one stays editable — it's per-row data). Constants stay in `@skating/core`; the control-room
  surfaces the live value + its chart so they're **never buried in code** a non-engineer can't *see*
  (edit = change the constant + redeploy, per the settled decision above).
- **Hazard-tuning surface (D52/D54, from Phase 9):** same read-only pattern for hazards — the
  `HAZARD_DECAY` per-type durations live in `hazardDecay.ts`, checked against the
  `hazard_confirm_outcomes` + `hazard_age_at_confirm_h` charts (a type confirmed "still here" past its
  stale line is decaying too fast). The confirm/removal thresholds are likewise constants + their charts.
- **Bounty-freshness surface + chart (D56 §7c, from Phase 10):** the decay-based bounty gate rendered
  read-only — `FRESH_REPORT_HOURS`, the trust/thumbs boosts, and the **weather-reopen thresholds**
  (`BOUNTY_REOPEN_FREEZING_DEGREE_HOURS` / `BOUNTY_REOPEN_THAW_DEGREE_HOURS`) — raise them and a
  corroborated report holds bounties off through more weather; lower them and bounties reopen sooner.
  Ship a **bounty-suppression chart** so the effect is
  legible before touching a number: instrument every `bounties.create` gate decision into a lightweight
  `bountyGateEvents` log — `{ waterBodyId, decision: suppressed|allowed, suppressingReportId?, reportAgeH,
  netThumbs, trustClass, weatherReopened: bool, appliedWindowH }` — and chart, over a chosen window,
  **(a)** a scatter of *report age at bounty attempt* vs *the suppression window actually applied* (dots
  above the line = blocked, below = allowed) with the base/boosted window bands overlaid, and **(b)** a
  time series of the **weather-reopen rate** (share of attempts where warming/freezing flipped a
  would-be-block to allow). Too-many dots clustered just under the line ⇒ bounties open too easily (raise
  the reopen thresholds / base window); a flat-zero reopen rate through a real thaw ⇒ too hard (lower them).
  The event log is also the honest input for the Phase-10-deferred **decay-magnitude refit**.
- **Known seasonal body features (D53, from Phase 9):** a moderator surface to **promote** a recurring
  hazard into a persistent **`bodyFeatures`** attribute (spring/current, constriction, bridge-narrows,
  recurring pressure ridge) and to **demote** one — so a permanent risk stops needing user re-marking.
  Includes the **`hazard` flag queue** (`contentFlags.targetType: hazard`) to hide a bad/malicious pin.
- **Posting-rights & appeals tooling (D57, feeds from Phase 10):** restrict/restore per-action posting
  rights (`canPostReports` / `canPostHazards`) as a lever **finer than suspend/ban** (D37) — proportionate,
  appealable, reversible — plus an **appeals / reinstatement** workflow. Backed by a **contributor-trust
  panel**: the private, non-scoring **contradiction counter** (from the Phase-10 D56 signal) shown
  *alongside* a **good-vs-bad reports trend over time**, deliberately **tenure-aware** so a 10-year
  contributor and a 1-month account with the same raw count are obviously distinguishable at a glance.
  - **3rd lever — `canPostComments` (boolean, D57 extension): ✅ BUILT in Phase 7** *(status corrected
    2026-07-24 — this read "planned")*. Comments are free-text content, so a boolean revocation fits; its
    point is muting a toxic commenter *without* silencing their safety reports. Enforced in
    `comments.create` via `assertCanPostComments` (`lib/auth.ts`); optional/migration-free. See D57.
  - **Deferred bounty lever — `activeBountyPostLimit` (nullable int, NOT a boolean):** bounty abuse is
    volumetric, so the lever is a per-user override of `MAX_OPEN_BOUNTIES_PER_DAY` (`?? 3`; `0` ⇒ can't post),
    which subsumes a `canPostBounties` flag. Built only if a real spammer earns it — the existing cap does most
    of the work. Keep the boolean-per-capability shape; don't build a `postingRestrictions` framework for 3–4 fields.
- Every admin mutation gates on `role` server-side and writes a **`moderationActions`**
  audit row.
- **Operator alerts (D38):** Resend + React Email — email the founder on new
  `supportTickets` and safety-priority items, deep-linking into `/admin`.
- **Done:** operators can ban/unban users, **restrict/restore per-action posting rights and handle
  appeals** (D57), approve/reject user-drawn water bodies, and triage flags + support from `/admin`, with
  every action audited and safety items alerted by email.
- Needs: Resend (domain verified).

## Phase 8 — Native track capture + Strava push (the A→B→C pipeline) ✅ Complete (dev; prod deferred) (2026-07-24)
> **Status: ✅ complete — all five workstreams shipped.** Suites green: core 752 / convex 540 /
> web 157 / mobile 76. **Still device-unverified** (Android-emulator GPX playback + a friend's iPhone
> for iOS background/battery parity) — the one outstanding item that isn't the prod cutover.
> 8a unified freshness (D59) → 8b recorder + B spine → 8c user bodies + dedup (D14/D36) →
> 8d Strava push (C) → 8e aggregate layer + privacy (D58).
>
> **Key build deltas vs this plan** (the phase doc's "Open questions" resolved, plus what the code found):
> - **D59's premise was partly wrong.** `bounties.ts` had **no recency-decay curve to extract** — it
>   computes a *window in hours* and compares. The genuinely shared surface is the netThumbs clamp; the
>   decay curve is **net-new**. Every Phase 6 bounty test passes untouched (the D59 acceptance gate).
> - **Two deliberate bounty↔report divergences, now documented rather than accidental:** net-unhelpful
>   thumbs *shorten* a bounty window (shortening summons fresh eyes — safety-positive) but are
>   **boost-only** for report freshness, where they'd let downvotes fade someone's path off the map;
>   and weather collapses a bounty window to 0 but only *multiplies* report freshness down.
> - **Freshness has no visible report-aging consumer in v1** (founder call): it drives path opacity +
>   the shared bounty primitives; report cards keep their relative-time labels. Least D3 risk.
> - **`pathToBody` buffers but does NOT hull** — a hull swallows land/islands on any non-circumnavigating
>   track. It *does* fill interior rings (a lap around a pond would otherwise store a donut with a hole
>   at the lake's centre where reports fail to resolve) and refuses a track with no extent (turf happily
>   buffers a motionless phone into a perfect circular "pond"). No `@turf/convex` dep added.
> - **`waterBodies.create` is now path-only at the trust boundary** — it takes an `activityId`, **not a
>   polygon**, so "no freehand drawing, ever" is a server contract rather than a UI convention. Existing
>   tests were migrated to the new contract, not relaxed.
> - **`near_certain` added to `DEDUP_STATUSES`** — D36 always had three tiers and the schema had two.
>   `listDedupCandidates` now surfaces both, near-certain first. A flagged body stays **listed** (D3).
> - **New `oauthStates` table + `convex/http.ts`** (first HTTP router in the repo): an OAuth callback is
>   an unauthenticated browser redirect, so a single-use state nonce is what binds it to a user.
>   **Token refresh is net-new** for this codebase (every other integration uses a static key).
> - **No `toEncodedPolyline`/`@mapbox/polyline`** — both maps draw the GeoJSON path directly.
> - **Aggregate layer caps at 200 tracks/body** and returns the dropped count (no silent truncation).
>
> **Follow-ups after the build (2026-07-25):** the D58 aggregate opt-out shipped **mobile-only** and was
> added to the web settings page (copy single-sourced in `core/trackPrivacy.ts` so a privacy promise
> can't drift between surfaces); `ingestTrack` stopped accepting a `distanceMeters` it never stored
> (derivable from `path` exactly).
>
> **Outstanding:** device verification (Android-emulator GPX playback + a friend's iPhone for iOS
> background/battery parity), a real Strava sandbox upload (callback domain now set), and the prod
> cutover.

> **Detailed build plan:** [`phase-8-native-capture.md`](./phase-8-native-capture.md) (scoped
> 2026-07-24). Reframe write-up:
> [`research/native-track-capture-and-strava-push.md`](./research/native-track-capture-and-strava-push.md)
> + Strava legal read (`08-legal-feasibility-checklist.md` L7). New decisions: **D58** (aggregate-track
> privacy), **D59** (unified report freshness).

> **⚠️ The old "pull GPS from Strava" plan is dead.** Strava's Nov-2024 terms **forbid** displaying one
> athlete's data to any other user (even public data) and **ban AI/ML** over it — killing the cross-user
> map/heatmap/report-path off Strava data. **The whole phase inverted:** we **record the track in a native
> in-app recorder** (first-party data we own → legal to aggregate + draw on public reports) and **push** it
> to Strava (`activity:write`, the Garmin model — clearly allowed, the adoption lever: *record once, keep
> your Strava stats*). Modeled as **A → B → C**: A = capture inputs (**native recorder** first;
> Garmin/HealthKit/COROS/Polar deferred), **B = our own track store + resolve-to-lake + aggregate, the
> always-owned hub**, C = push outputs (**Strava** first). No provider keys exist yet; only the **free
> Strava app** (instant, no review) is needed, and only for the push slice.

- **Native recorder (A-input #1)** — session record/pause/resume/stop over a durable expo-sqlite buffer,
  a Record-grade GPS profile, background/foreground-service, reusing the **Phase 9.5 on-ice primitives**.
  Track post-processing (smooth/gate/cull → GPX + GeoJSON) in `@skating/core`. Phone-only skater's source;
  battery is an honest, opt-in trade (D3 copy). **Paths only ever come from legitimate recorded sources —
  no freehand drawing, ever.**
- **B — our track store + resolve-to-lake (D44)** — normalize any track → `gpsActivities`, resolve to its
  `waterBodyId`, link to a report. **The recorded path renders on the report detail view** (display-only)
  **and** on the aggregate tracks layer.
- **User-created water bodies (D14) + match-on-create dedup (D36)** *(moved here from Phase 2 — needs a
  trusted path)*. A skate resolving to **no** known body creates/attaches one **from the trusted path only**
  (buffer + hull → polygon; new `core/dedup.ts` + `pathToBody.ts`; `findMatchCandidates` steer; stamp
  `dedupStatus`/`duplicateCandidateIds`; auto-visible then review-after, D37). **Path-only gated — no manual
  draw** (no path ⇒ no proof of presence, no scale/shape reference). **Feeds the already-built Phase 7 merge
  queue** (which has had nothing flowing into it).
- **Strava push (C-output #1)** — new `convex/http.ts` router (first in the repo), OAuth `activity:write` +
  per-user token refresh, `POST /uploads` + poll, per-session "also upload?" toggle (watch-wins deferred),
  "Powered by Strava" / "Connect with Strava" brand kit (L7).
- **Aggregate tracks layer (B, D58)** — decaying public-track overlay per selected body (opacity fades as
  the linked report ages, D59). Privacy = **publish-is-consent** (only report-linked, non-minor paths), **no
  k-anonymity** (a public report is meant to be shared — one skater is enough), **put-in-gated endpoint
  clipping** (`showPutIn` withheld ⇒ clip first/last ~150 m, protecting a skate-from-home), **minors excluded
  by construction**, global **opt-out**. The tuning-heavy crowd-intelligence derivations (pressure-ridge /
  clearest-side, L9 deduction) are **deferred** — need volume + calibration.
- **Unified report freshness (D59)** — one `core/reportFreshness` primitive; report-aging and path-opacity
  consume the *identical* value (the path is the report's extent — can't diverge); **bounties refactor onto
  the shared primitives** (keeping their own window/trust/reopen policy; existing Phase 6 tests stay green).
- **Done:** a phone-only skater records a skate in-app, sees the real path on their report and on the lake
  map (fading as it ages), can push it to their Strava, and a skate on **new** water creates/attaches a body
  from the trusted path (dedup-steered).
- **Deferred:** third-party capture adapters (Garmin/HealthKit/HC/COROS/Polar) + the watch-wins ingest path
  — each integrated individually later (**apply for Garmin/COROS/Polar partner programs now**, ~weeks of
  review); additional push targets (Whoop); path-cluster hazard deduction (L9/Q11).

## Phase 9 — Hazards ✅ Complete (dev; prod deferred) (2026-07-22)
> **Detailed build plan:** [`phase-9-hazards.md`](./phase-9-hazards.md) (decisions settled 2026-07-18;
> **D51–D55** — D55 added at build kickoff: on-ice hazards auto-bundle into the skater's later report).
> Ship order within the **single PR**: online-first commits (authoring + lifecycle + render +
> client-side on-ice alerts) → offline commit (hazard/confirmation draft-queue reuse) → PR. The
> **Layer-3 offline basemap tile-pack** that was originally sequenced into the offline commit was
> **dropped from this phase** — it's a native spike that needs a device build, and the on-ice flow
> already degrades correctly without it (see `phase-9-hazards.md` → *Layer-3 offline basemap tile-pack —
> spike findings*).
- **Authoring — geometry-per-type, not freeform-by-default (D51).** Most people can't hand-draw an
  accurate blob on a phone from what they see on the ice, so the primitive matches the hazard's shape:
  **point + adjustable radius** (default — `open_water`, `thin_ice`, `overflow_slush`, `drilled_hole`,
  `shell_area`, `spring_current`, and the holes/zones), **polyline** (`pressure_ridge`, `ice_heave`,
  `wet_crack`), **polygon** (opt-in "advanced" — **renders + stores but is not authorable in v1**; the
  vertex-dragging editor was deferred at build kickoff, call 5). The type keys shipped as **16 canonical
  keys**: build-kickoff call 2 collapsed the slash-pairs (`open_water` absorbs `lead`, `ice_heave`
  absorbs `buckling`, `spring_current` replaces both `inlet_outlet_current` and `spring`) so
  `Record<HazardType, HazardDecay>` typechecks against the research table, and the 2026-07-21 research
  pass **added seven types**: volatile holes `drain_hole` / `wind_hole` / `slush_hole`, the
  `thawed_rotten` zone (the #1 fatality cause), the persistent natural holes `gas_hole` / `reef_hole`,
  and the `ridge_crossing` passage marker. Rendered **fuzzy + advisory** ("reported *around here*"),
  never a surveyed boundary (D3). Two paths — **standalone** quick-flag and **in-report**
  (`hazardIdsCreated[]`) — on **both web and mobile**. Full 16-key table + labels in `06-data-model.md`.
- **Lifecycle — per-type decay + three-tier healing confirmation (D52, extends D15).** Decay rate is
  per hazard type (Tier A volatile 24/72h → Tier D permanent 14d/45d; tunable, admin-editable Phase 7).
  Confirmations are **"still here" / "healing but unsafe" / "fully healed & safe"** — only the last
  counts toward removal (2 independent, tunable); "healing but unsafe" **keeps the pin** so future
  skaters can read the healing ice. Triggered opportunistically (app-open nearby, report flow, post-hoc
  GPS path — D12/D15). A decayed open-water hazard never reads as "all clear" (D3).
- **Known seasonal body features (D53).** Springs/current, constrictions, bridges/narrows, and
  ridges that reform annually graduate into a persistent **`bodyFeatures`** entity — always-shown, no
  decay, no re-marking. v1 ships schema + rendering; promotion/demotion is an **admin action** (Phase 7).
- **On-ice alerts — client-side, D12-clean (D54).** The server only **syncs hazard data** to devices
  that care about a lake; each phone evaluates its **own** GPS against cached hazards. **Layer 0** silent
  cache sync + **Layer 1** on-ice proximity alert where the confirm-gate *is* the confirmation mechanism
  (unconfirmed → soft "can you confirm?"; ≥1 independent confirm → "⚠ hazard ahead") ship in v1. Because
  hazards are cached on-device, alerts fire **with no cell signal**. **Layer 2** (directional
  "hazard ahead" 30–60s out via an opt-in live-position "on-ice mode" — a conscious safety exception to
  D12) and **server-push-to-a-sleeping-phone** are **deferred/designed-for**.
- **Deferred, designed-for:** non-destructive **consensus rendering** (cluster same-type hazards, keep
  the rows) + **GPS negative-evidence** (Q11 — tracks through a hazard nudge its *confidence*, never
  auto-clear it). Both post-density / Phase 8+.
- **Done:** hazards are drawn (right primitive per type), age per type, can be confirmed via the
  three-tier vote / cleared; permanent body features persist without re-marking; skaters on that ice get
  a client-local alert (offline-capable) gated behind one confirmation.
- **Offline hazard capture — inherited from Phase 2 F2 (decided 2026-07-15).** Hazards are drawn
  **on the ice, often offline**, so Phase 9 reuses the Phase 2 F2 offline substrate:
  - **The offline body-reference cache** (F2 "Layer 2" — `@skating/core` buffered
    `pointInPolygon` auto-select + an on-device LRU cache of recently-viewed body polygons)
    is built in F2 as a **standalone, reusable module** *specifically so hazard capture reuses
    it* — GPS + cached polygon tells the offline app which lake the skater is on without a
    network round-trip.
  - **Offline basemap tiles (F2 "Layer 3") were deferred here from Phase 2 F2 (decided
    2026-07-15) — then dropped from Phase 9 at build time (2026-07-21).** F2's report capture
    needs only *which lake* (the body cache) + GPS, so it ships with **no offline basemap** and
    degrades the put-in pin to "drop at my current GPS location." Hazards want the same offline
    basemap *ideally* — dropping an accurate pin is easier with the lake polygon as reference — but
    the tile-pack turned out to be a real native spike (does `@maplibre/maplibre-react-native`'s
    offline-pack API crawl our `pmtiles://` range source, or must we ship an on-device
    mini-`.pmtiles`?) that **can't be resolved without a device build**, which the rest of the native
    Phase 9 UI is also waiting on. It was **timeboxed and not built**; on-ice capture degrades
    correctly regardless (the pin drops at GPS, sizing/Done/queue all work — only *tapping the map*
    to Move/Trace needs tiles). Findings + the three candidate routes are recorded in
    `phase-9-hazards.md` → *Layer-3 offline basemap tile-pack — spike findings*; revisit alongside
    the device-build pass. The F2 body-cache module was already designed to accept a tile-pack field,
    so slotting it in later needs no rearchitecture.
  - The buffered auto-select (a tunable ~parking/approach radius so opening from the car still
    resolves the lake) is the same primitive hazard capture uses to bind a hazard to its body.

## Phase 10 — Weather-since strips + weather-driven hazard decay ✅ Complete (dev; prod deferred) (2026-07-23)
> **Detailed build plan:** [`phase-10-weather.md`](./phase-10-weather.md) (scoping settled 2026-07-22;
> new decision **D56**). **Scoping scan found half of this phase already on dev:** the D19 **weather-since
> reducer** (`summarizeWeatherSince`) is built + property-tested in `@skating/core`, and **auto-suggest
> skate times is done (Phase 9.5)** — see the struck bullet below. The genuinely new work is **four
> deliverables:** (1) a live **Open-Meteo fetch + `weatherCache`** (the one new piece of infra — a Convex
> action like `isochrones.ts`, on the **forecast API with `past_days`** — *not* the ~5-day-lagged
> archive — fetched **on drawer-open**), (2) wiring the **weather-since strip** onto aging report **and
> hazard** views (plain-text, verdict-free, Open-Meteo-attributed), (3) **weather-driven hazard decay**
> (`decayMultiplier(type, weatherSince)` + `effectiveAge`, threaded through `hazards.ts` and **precomputed
> server-side for the offline on-ice alert**), and (4) **report conditions auto-fill** (`openmeteo`
> source, already stubbed) **+ the Phase-6 corroboration contradiction *signal*** (withhold-boost +
> conflicting-reports disclosure + escalate-to-moderation via the new **D57** posting-permission lever —
> never a trust subtraction) **+ the Phase-6 decay-based bounty-freshness score** — the deferred tasks
> that were explicitly waiting on weather-since. Lands on **dev**; prod deferred.
- Open-Meteo "what the weather has done since this report" factual strip (D19). **Plain-text,
  verdict-free** (e.g. "since this report: peak 41°F · low 22°F · 3 nights below freezing · 6h strong sun
  · ½″ rain"); the quantitative degree-hour integrals stay model-internal. The pure reducer
  (`summarizeWeatherSince`) is already built — Phase 10 adds the fetch + display wiring, not the math.
- **Expanded weather-variable set (scoping pass 2026-07-22).** The original five (peak temp · hours
  near/above freezing · sun · precip · wind) miss what the *decay model* needs: **freezing- & thaw-degree-
  *hours*** (magnitude, not hour-counts — the ~1″/15-FDD backbone), **overnight low** ("did it freeze last
  night"), **rain vs snow split** (opposite signs — snow insulates + hides, never heals), **solar
  radiation** (insolation subsumes the season/solar-term multiplier — 8× seasonal swing), **clear-night
  radiational cooling**, **wind-in-context**, and **sustained-freeze-run / freeze-thaw-cycle** counts. Full
  variable table in the phase doc / hazard-research §5.
- **Weather-driven dynamic hazard decay (extends D52, planned here 2026-07-18; signs corrected by the
  2026-07-21 research pass).** Reuse the same Open-Meteo "weather-since" pull to modulate hazard
  freshness instead of relying on elapsed time alone: `effectiveAge = elapsed × decayMultiplier(type,
  weatherSince)`. Per-type sensitivity — **refreeze-healed types** (`open_water`, `thin_ice`,
  `drilled_hole`, `overflow_slush`, the holes) **accelerate** toward stale with accumulated
  freezing-degree-days (~1″ of new ice per ~15 FDD is the quantitative backbone) and **decelerate**
  under warm/sun/rain (a thaw can even **re-escalate** a fading `thin_ice`/`overflow_slush` hazard —
  warmth never heals these). **Corrected finding:** the structural types (`pressure_ridge`,
  `ice_heave`) are **not** weather-insensitive — a ridge can melt out to open water in a two-day windy
  warm spell, so they get a **thaw multiplier floored at ≥1** (thaw escalates, never heals), and
  `spring_current` stays effectively permanent. **The `thawed_rotten` rule (research §5 — do not let it
  live only in the research doc, it's a corrected safety finding): its decay must NOT accelerate on
  cold.** A thaw-rotted sheet grows a deceptive skin overnight and collapses midday — the
  "overnight-ice trap," implicated in the 2013 fatalities where victims went out on morning-hardened
  ice and stayed as it weakened. So `thawed_rotten` carries a very-short base decay (12h/36h) and a
  **cold-weather multiplier floored at ≥1 (never <1)**; only a sustained hard freeze of the whole
  sheet — not one cold night — heals it. **Same D3 caveat as D52:** accelerated decay ≠ "safe" — a
  refrozen lead is thin ice, so the copy must never imply skateability. Pure logic in `@skating/core`
  (property-tested, D40); admin-tunable alongside the D52 decay tiers (Phase 7). **Never-hide invariant
  (founder call 2026-07-22, D56):** weather can **age** a hazard (fresh→aging) but the cold-acceleration
  direction is **bounded so weather alone can never push a hazard past `aging` into hidden/`stale`** —
  only elapsed time + a human `fully_healed` confirmation fully retires a pin. **Fail-open** (missing
  weather ⇒ multiplier=1; weather trouble never makes a hazard less visible). **Sampling:** body
  **centroid by default** (nearly every body < one Open-Meteo grid cell — *not* town/county, wrong
  abstraction); an optional `weatherSamplePoints[]` escape hatch covers the few multi-cell giants
  (Champlain/Winnipesaukee), nearest-point assignment. **Cron:** the decay precompute sweeps **only bodies
  with ≥1 active hazard** (not all 116k) at a fixed hourly tick, skipping hazards refreshed within an
  admin-tunable `weatherRefreshMinIntervalHours` (Convex crons can't retune interval at runtime), and
  **stores the `decayMultiplier` (time-independent), not a frozen freshness bucket** (which would drift
  between ticks — online `toView()` recomputes the live bucket). The **strip fetches on drawer-open** (no
  cron — a query can't fetch, so a read-only strip would never fill on hazard-free bodies), sharing the
  same `weatherCache`.
- **Three deferred tasks the fetch unblocks (added to scope 2026-07-22).** (a) **Conditions auto-fill:**
  populate the stubbed `openmeteo` source (weather *at* the skate time) on report create — user-entered
  values always win; runs as a **scheduled post-insert action** (a mutation can't fetch), so it's
  eventually-consistent. (b) **Corroboration contradiction *signal* (D56/D57):** finish the Phase-6
  `runCorroboration` stub — a later disagreeing report counts as a contradiction **only when the
  weather-since doesn't explain the change**, and even then it **never subtracts trust** (D50 stays
  boost-only): it withholds the boost, shows a "conflicting reports" indicator, and — *on a repeated,
  never-corroborated pattern* — auto-files an `/admin` flag so a human can restrict the offender's
  `canPostReports`/`canPostHazards` right (D57, finer + appealable vs a whole-app ban). Honest "the ice
  changed" reports stay unpenalized (D3/D50). (c) **Decay-based bounty-freshness (Phase-6 upgrade):**
  replace the hard `FRESH_REPORT_HOURS = 48h` bounty gate with a **freshness score = recency × thumbs ×
  trust × weather-since** (reuses §4's decay shape) so warming weather reopens bounties sooner. All land
  with tests + the boost-only invariant intact.
- **~~Auto-suggest skate start/end times from the on-ice dwell~~ ✅ Done (Phase 9.5, 2026-07-22).** Built
  ahead of schedule: `apps/mobile/src/lib/dwell.ts` (`suggestedSkateWindow`) + `dwellTracker.ts`, wired
  into `ReportForm.tsx` (earliest-in/latest-out across today's dwells, grace-debounced). **No Phase 10
  work.** *(Original note, kept for history:* the on-ice GPS watcher knows when a device entered/left a
  lake footprint; that interval is a strong prior for the report form's skate window. Needs enter/leave
  bookkeeping (debounced against brief GPS excursions) + a form pre-fill, and overlaps the D24
  activity-detection path — so it lands with the report-form / activity work, not the hazard feature.)*
- **Deferred to this phase's Later/deferred (see the phase doc):** the **lake-depth / shallow-water decay
  signal** ships v1 as a manual `shallow_early_thaw` `bodyFeature` (no depth data source exists in
  OSM); the real fix is a **HydroLAKES + GLOBathy** backfill of `meanDepthM`/`maxDepthM`, a separate data
  PR. Full write-up (sources, state bathymetry, ETL update) in `phase-10-weather.md` → Later/deferred.
  **→ scoped as [N6a](./phase-N6a-lake-depth.md) (2026-07-29).** Correction worth carrying: *"the decay
  model reads a simple `isShallow` scalar"* was never true — the v1-without-the-data half of this bullet
  **did not ship**. The `bodyFeature` renders and is wired to nothing, so N6a builds the signal rather
  than sharpening it, and the manual flag turns out to be permanent (73% of the corpus is below every
  global source's area floor).
- **Done:** aging reports **and hazards** show a plain-text, Open-Meteo-attributed weather-since strip
  (peak/overnight-low temp · nights below freezing · sun · rain-vs-snow · wind); hazard decay reflects
  what the weather actually did (never hiding a hazard); report conditions auto-fill from Open-Meteo;
  corroboration distinguishes a weather-explained change from a real contradiction and escalates a
  repeated bad-actor pattern to the D57 posting-permission lever (never subtracting trust); and bounty
  freshness is weather-aware.

## Later / deferred — the deferred register (see 02-open-questions)

*Rebuilt 2026-07-25, after a full read of `plans/` against the code with every phase built. Everything
below is deliberately-deferred work, split by **whether we could start it tomorrow**. Two rules for
keeping it honest: when an item ships, strike it here with a pointer (two entries had gone stale and
were silently claiming to be deferred — hazard-footprint clipping and `canPostComments` — so **verify
against code before trusting an entry**); and when a blocker clears, move the item up rather than
leaving it to be rediscovered.*

### Next-phase candidates — unblocked, chunked (N1–N8)

Nothing in this half is waiting on anyone. It's grouped so each chunk is one coherent review surface
with a shared test/verification shape, ordered **highest-impact first** — where impact means *what a
skater or the operator feels during the first-ice friends alpha*, not what's most interesting to build.
Chunks are independent unless noted; sizes are rough.

*Numbering note (2026-07-27): **N3** (storage-hygiene crons) and **N4** (account lifecycle) merged into
one phase, filed under both numbers — the crons are the lifecycle work's own cleanup path, not a
separate chunk. **N5–N8 keep their numbers**, so pointers written before today still resolve.*

~~**N1 — Read-path durability: the crash class.**~~ **✅ COMPLETE on dev (2026-07-26)** — see
[`phase-N1-read-path-durability.md`](./phase-N1-read-path-durability.md) for the design, the
corrections to what this entry used to say, and the measured results.

Shipped: `@convex-dev/geospatial` is **gone entirely** (both instances, plus `convex.config.ts` —
the app installs no components now). Water bodies and admin boundaries are indexed into
`waterBodyCells` / `adminAreaCells`, one row per grid cell an object's **bbox** covers, at a rung no
finer than the zoom it first draws at — so a viewport read is "scan the cells covering the viewport,
at every rung up to this zoom", bounded by geometry rather than by a measured constant. That retired
the ±margin, the `isLarge` outlier list and both of its per-read `.collect()`s, the 256 clamp's role
as a crash guard, and the JS `listed` re-check (an unlisted body has no cell rows at all).

Four things this entry had wrong, all corrected in the phase doc: the fix **wasn't expressible** in
the component we were on (it indexes one point per key); the trigger had **already fired** (the 256
clamp was measured against 9,967 bodies and never revisited after Phase 2.5 loaded ~116k); a **fifth**
unbounded `.collect()` ran on every viewport read and wasn't listed; and two of the four named
`.collect()` sites were misfiled (the bounty cap already logged; `findContradictingPriors` doesn't
exist — it's `contradictionCluster`, which hid a second scan inside an N+1).

Two things came out that weren't scoped: **`adminAreas` had the same bug with a worse symptom** — a
±0.2° centroid search sized on the premise that "our towns run well under 0.4° across", which the
Adirondacks falsified silently (9 towns exceed 0.35°, 264 more are marginal), so a report from inside
one quietly lost its town label; and **`reports.create` was scanning every profile in the app** to
fan out notifications, an unbounded read on the most important write in the product, now a scheduled
self-continuing paged job.

Measured on dev after backfilling 116,070 bodies: the off-data pan that used to crash costs **22**
document reads, the heaviest real viewport **1,771** (under half of Convex's 4,096 cap), and dense
eastern Maine returns **513** bodies where the old clamp returned 256 — 257 real lakes that had been
missing from the map. `waterBodies:viewportReadStats` keeps that checkable, and every measured
viewport is recorded with its exact bbox so the table can be re-run rather than trusted.

*Left for later:* the notification **reverse spatial index** — still N7, since N1 only made the
profile walk bounded, not unnecessary.

~~**N2 — Operator surface completion + corpus curation.**~~ **✅ COMPLETE on dev (2026-07-26)** — see
[`phase-N2-lake-editor-and-subareas.md`](./phase-N2-lake-editor-and-subareas.md) for the design, the
seven corrections to what this entry and its own plan claimed, and the measured results.

Shipped: **named sub-areas** (D60) — a bay is a region *inside* one polygon, not a lake beside it, so
one sheet of ice keeps one set of reports, hazards, bounties, favorites and tracks while carrying the
name skaters actually use. Full citizens: labelled on the feed card and both detail surfaces, searchable
by alias, drawn on both clients off a third ladder-grid cell table, and targetable by a bounty. Plus the
**per-lake editor** (D61) at `/admin/water/$id` with the camera locked to the body, the `weatherSamplePoints`
writer that Phase 10 shipped a reader for and never a mutation, auto-flag bundling, and
`activeBountyPostLimit`.

Four things this entry had wrong, all corrected in the phase doc: "add the bays OSM lacks" was
**unbuildable** (`waterBodies.create` is path-only) and asked for the wrong shape anyway; the five
"bay mis-matches" were **already fixed** and the note was stale (what was actually missing was a screen
that lists curated bodies at all); Champlain and Winnipesaukee are *not* both multi-cell giants — at
180 km² Winnipesaukee's grid proposes one point, which is the centroid default; and the bundling fix's
obvious form would have corrupted a 7b rollup by reopening terminal flags.

Two things came out that weren't scoped: the **read walk was extracted** from `waterBodies` into
`lib/cellScan.ts` rather than copied for the second layer, because those ~100 lines encode four
PR-#27 corrections that a copy would drift from; and **`MapView` became a shared shell** so the editor
and the skater map are one canvas (founder call, with the skater suite green unchanged as the price).

*A worry that bodies need aliases the way sub-areas do was checked and dismissed:
"Saranac Lake" already returns Upper, Middle and Lower, and they're genuinely three lakes.*

~~**N3 / N4 — Account lifecycle + storage hygiene (D33/D62).**~~ **✅ COMPLETE on dev (2026-07-27)** —
see [`phase-N3-N4-account-lifecycle.md`](./phase-N3-N4-account-lifecycle.md) for the design, the
corrections to what these entries used to say, and the measured results. **The two entries are one
phase**; the old N3 (two storage-hygiene crons, "tiny — a half-day") is a workstream inside it,
because the lifecycle work *creates* the storage problems the crons exist to solve: an export bundle is
a stored blob needing a TTL sweep, deletion strands a departing user's unattached photo blobs, and the
grace window needs a finalize cron in the same family. One phase, one review surface, one test pattern.

Deletion/export is a trust-and-launch requirement that touches every surface showing an author. The
**mechanism is unblocked**; only the *policy wording* is legal-gated (L3), so build the machinery and
leave the copy to the Q10 pass. Public content **anonymizes rather than erases** (D33/D13) — but that
rule is no longer uniform, and **D62** says why: D33's premise ("all reports are public, so there's no
private content to selectively remove") predates Phase 4's `homeCoord`/isochrones and Phase 8's raw GPS
paths + OAuth tokens. Three buckets now — erase the private, anonymize the public record, and
**keep-but-sever** published GPS tracks (kept iff linked to a visible report, which is D58's own
publish-is-consent predicate reused).

Two things this pair of entries had wrong, both corrected in the phase doc: the photo-orphan GC's
**evidence gate already exists and has produced nothing** — Phase 7b built the `photo_orphans` metric
*and* the `photos.by_created_at` index expressly to decide whether the cron was worth building, and it
reads 0 on dev because dev holds **0 photos** (and 0 `weatherCache` rows, 1 report, 2 profiles); and
the anonymized-author work is **smaller** than "everywhere" implies, since `reports`/`bounties`/
`comments` already funnel a missing author through one `{ displayName: 'Unknown', … }` shape. What's
*bigger* than stated: `by_clerk_user_id` and `by_username` are read with `.unique()`, so tombstone
sentinels must be per-row-unique or the second deleted account breaks auth app-wide.

Two things came out that weren't scoped: **`showPutIn` was bypassed on the report-detail map** —
`gpsActivities.getForReport` returned the raw path to every viewer, so a skater who withheld their
put-in had their first/last 150 m drawn publicly, despite the aggregate layer 60 lines below carefully
clipping it (fixed here, since deletion can't respect a rule the live product doesn't); and
**`weatherCache` growth is multiplied by N2**, which shipped the `weatherSamplePoints` writer — rows
accrue per hour *per sample point*, not per hour per lake. Its retention argument also turned out
stronger than "disk growth": the cache key contains the current hour bucket, so yesterday's rows are
*unaddressable* rather than merely stale.

**The bug worth carrying forward past this phase.** The finalize cron's first real tick against dev
returned `due: 2, started: 2` on a deployment where nobody had requested deletion — it would have
queued **every account in the app**. A Convex index on an **optional** field is *not sparse*: rows
without the field are in it, and `undefined` sorts before every number, so a bare `lte(cutoff)` range
matches everything. The schema comment asserting the index was "sparse in practice" was a guess wearing
documentation's clothes. Nothing was lost — a mid-flight cancel guard, written for an entirely
different reason, was the only thing in the way. Every other bare upper-bound range in the codebase was
swept and is on a required field. **Tests didn't catch this; running the job against a real deployment
did**, and the regression test was only trusted after reverting the fix and watching it fail.

~~**N5a — Seasons: seasonal visibility, the season filter, departed-user redaction.**~~ **✅ COMPLETE
2026-07-28** (built, all suites green, **deployed to dev**; not device-tested, prod deferred) — see
[`phase-N5a-seasons.md`](./phase-N5a-seasons.md); decisions **D63**, **D64**, **D65**, **D66** + the
**D62 amendment** and its **second amendment**. *(Re-scoped: this entry used to be "hazard authoring &
confirmation polish". It keeps that entry's two **lifecycle** items, because they touch the same
`deriveHazardLifecycle` a seasonal reset does; the three **authoring-UX** items became **N5b**.)*

The founder ask that started it: **reports and paths from previous seasons should not be visible on the
map at all** — fully hidden, not deleted — with a deliberate way to browse a past season, and recurring
hazards easy to bring back.

Worth stating because it surprised the register: **nothing in the app expires today.** `reportFreshness`
(D59) is an *opacity* multiplier, not a visibility gate, and the only age cutoffs anywhere are the
offline-cache window and the 48-hour `recommended` strip — so a report from the 2024/25 season still
renders in a lake's drawer, at ~0 opacity, with its GPS path still on the aggregate map.

- **A season is July 1 → June 30**, labelled `'24/'25`. **Derived, never stored** — no column, no
  backfill, no cron, nothing to drift. `skateEndTime` is already the range field of three existing
  indexes, so seasonal scoping makes those reads **cheaper**.
- **Hazards reset on the same boundary**, and recurrence is **D53's `bodyFeatures` promotion** rather
  than new machinery. That makes the pre-first-ice promotion pass a **safety** task, not housekeeping —
  the sharp edge of this phase, since hiding hazards means the first skater of the season sees a clean
  map where last winter there was a ridge.
- ~~**Departed-user erasure at 30 days**~~ → **redaction**, and **✅ shipped 2026-07-27 (PR #30)**.
  This bullet described round one of the D62 amendment and is kept struck rather than deleted, because
  every clause of it was reversed later the same day by the **second amendment** and the superseded
  version is the one someone reading the register would otherwise act on. What actually shipped:
  a deletion **request** makes you a ghost immediately (profile scrubbed, unreachable to everyone else,
  posting closed — only the *login* waits 30 days, so the decision is reversible); published content is
  **kept and anonymized**, with every free-text field cleared at 30 days (`reports.notes`, reading
  notes, `hazards.description`, photo captions, comment bodies, `contentFlags.note`); **hazards are
  never erased** — they are the multi-season record recurrence detection is built on; **bounties go at
  the request**, not at finalize; and **put-ins survive by ordinary derivation**, since the report they
  derive from is kept. Flat 30 days rather than the D59 curve — and the terminal pass ignores the clock
  entirely, which is the correction three walkthrough bugs shared.
- Folded in from the old entry: **"this never existed" confirmation verdict** and **naming confirmers**
  — designed at build kickoff as **D65** (pools with `fully_healed` toward the same 2-vote archive *and*
  files a moderation flag; confirmers named subject to `profileVisibility`).
- **A departed skater's photos split on evidential value (D66)** — hazard photos kept, everything else
  expires at the end of the season it was taken in. Promoted out of the deferred register at kickoff
  because its clock *is* this phase's boundary; deferring it means inventing a per-photo TTL later.
- **Suggested crossings decay in the opposite direction from hazards (D64).** Moved here from N5b once
  the founder's version of "ridge-crossing v2" turned out to be a lifecycle change rather than an
  authoring one: several *suggested crossings* per ridge, individually downvotable, decaying **faster**
  than hazards and needing **more** corroboration to survive. `ridge_crossing` currently inherits the
  hazard rules whole — including the map opacity floor where stale never means gone — which is
  conservative for a danger and **anti-conservative for a passage**: a marker placed in November still
  reads "reported crossable" in March. Copy becomes *"suggested crossing"*, never "safe". A single
  "closed" vote — **invisible today** — makes a crossing visibly **disputed**; closing still takes two,
  because removing on one vote lets any single user delete a contribution and destroys the information
  that a crossing was ever found there. The two constants, settled at kickoff: expiry is its **own**
  72-hour window (not the existing `agingH: 36`, which would make "faded" and "gone" the same instant),
  and it takes **two** independent confirmations to stop being provisional against every hazard's one.

**Two premises the code check falsified**, both making the phase *more* consequential:
- **Reports don't draw on the map at all** — there is no report layer. What reaches the map from a
  report is its put-in marker, its track and (while open) its photo pins. So the map half of this is
  **tracks + hazards**; reports are season-scoped in the *feed and lake list*. Put-ins are deliberately
  exempt, and the trap is that `putIns.listForBody` derives them by reading **reports** — scope that
  read carelessly and put-ins vanish with it.
- **Hazards never age out.** `deriveHazardLifecycle` archives on community "fully healed" votes only;
  there is no time-based archival anywhere. An unvisited hazard stays `active` forever, fading to
  `stale` — behind a "show older" toggle in the list, but on the map at a deliberate opacity **floor**
  (D3: decay is confidence, not safety). A ridge reported in Feb 2025 is still on the map today. That
  makes the hazard half the *most* consequential part, and means the recurring-hazard case is currently
  handled **by accident** — the stale pin never leaves, asserting a position nobody has evidence for.

~~**N5b — Hazard authoring UX.**~~ **✅ COMPLETE 2026-07-29** (built, deployed to dev, all suites green;
**not device-tested**) — see [`phase-N5b-hazard-authoring.md`](./phase-N5b-hazard-authoring.md)
for the design, the four corrections to what this entry and its own plan claimed, and decision
**D67**.

Shipped: **freeform areas**, the last of D51's three primitives — terra-draw on web with real vertex
dragging, close-the-ring on mobile's existing tap-to-place trace. And **snap-to-shoreline**, where two
taps near a shore produce the band of ice along it, straight off `waterBodies.polygon`.

Two things this entry had wrong, both in its own plan and both load-bearing. The affordance was scoped
for `thin_ice_shore` and `ice_edge`, which **are not hazard types** — research §4 used them as English
descriptions of a shape and the plan read prose as identifiers, which mattered because the pass's own
rule forbids minting new ones. And its headline open question — *is a ~270 kB draw chunk acceptable on
a phone?* — **had no answer**: terra-draw ships no React Native adapter, so the chunk can never reach a
phone at all, and "web + mobile behind the same lazy chunk boundary" was unbuildable as written.

Two more that changed the shape of the work. The *"lighter mobile-only path"* the plan offered as a
fallback **already shipped** — it is the Phase 9 polyline trace, so mobile needed no engine, no chunk
and no second state machine. And "all client work" understated it: `HazardDraft` was a two-variant
union whose every transition assumed exactly two, and `isValidHazardShape`'s polygon branch validated
only the first ring of the first part, capped vertices per-ring, and never checked closure or
self-intersection — dead code until this phase gave a client a way to reach it.

One correction the build made to itself: on both clients "adjust corners" on a snapped band was
quietly collecting a *third* shore tap instead of editing the ring, because the map's click handler
takes shore taps first. Web now hands the band to the vertex editor — which takes it off the
shoreline, exactly as D67 says it should — and mobile offers Re-pick instead, since without terra-draw
"adjust" would have meant re-tapping the whole ring.

**And six the review found after the suites were green** (all fixed; *§What the review found* in the
phase doc has the detail). The load-bearing one: a **refused band was a dead end**, because both clients
keyed the ± stepper on the band coming back *valid* — so a refusal took away the narrowing that fixes the
commonest one. Measured: on a ~100 m pond going the long way round, the default 25 m half-width refuses
where 15 m succeeds at the same two taps, which is exactly the small-pond case Decision 4 exists for. The
others: a stray map tap on mobile silently re-picked the band (its shore-tap branch had no drop-mode
gate, which web gets structurally); "pick a different stretch" armed terra-draw and shore-picking on one
canvas; a snapped band re-typed onto a non-shore type kept its shoreline (now a D67 amendment — hand-drawn
areas survive a re-type, bands don't); the draw banner read *"1 corners"*; and `waterBodies.get` fired on
type selection rather than on arming the snap.

**Two pre-existing bugs also got fixed here, outside this pass's scope.** Every admin *detail* page was a
dead link — TanStack made `admin.water.$id.tsx` a child of an outlet-less leaf, so `/admin/water/:id` and
`/admin/users/:id` (Phase 7's whole ban / suspend / grant-role surface) matched the URL and rendered the
parent's queue table instead, with every test passing in isolation. Guarded now by a test on the route
*file layout*. And favourite paint drifted onto the wrong lakes, because `setData` doesn't clear MapLibre
feature-state and our ids are array indices, so panning rebound them.

*Left for later:* nothing from this pass. Paste-GeoJSON stays admin-only, as scoped. The one thing the
review deliberately didn't settle: whether 25 m is the right default band half-width for a small pond, or
whether the derivation should try narrowing itself before refusing.

**N6 — Lake depth.** *(Split at kickoff 2026-07-29 into **N6a** — the depth attribute and its decay
consumer — and **N6b** — the bathymetric contour layer — after the founder asked whether we could draw
real topographic lines inside the lake polygons. The answer is yes, from measured state-agency surveys,
and that turned out to be phase-sized on its own. Was sequenced after N1 so the two shared one reindex;
**N1 has now shipped and its backfill is run**, so both are unblocked.)*

**N6a — Lake depth: the precedence ladder and the shallow signal.** ✅ **BUILT + on dev 2026-07-30** (ETL written and tested but **not yet run** — it needs three third-party downloads plus a licence/column confirmation; not device-tested; prod deferred) — see
[`phase-N6a-lake-depth.md`](./phase-N6a-lake-depth.md); decisions **D68** (provenance-carrying depth) and
**D69** (shallow amplifies thaw only). **Four of this entry's own premises were false**, all corrected in
the phase doc, and the first one reshaped the work:

- **The `isShallow` scalar this entry claimed to be "replacing" has never existed.** `phase-10-weather.md`
  describes the decay model as reading it; nothing does. `shallow_early_thaw` lives in exactly two
  places — the enum and an admin dropdown label — so a moderator can set it and see a pin, and it changes
  no decay anywhere. `decayMultiplier` takes no body-level input at all. **The signal is the deliverable**;
  the data is what extends it past hand-flagged bodies.
- **"Own data PR — no app changes" was unachievable**, and the field shape here is wrong: mean and max
  depth arrive from *different* sources (LAGOS-US holds 17,675 maxima and 6,137 means), so one
  `depthSource` cannot be honest. Provenance is per measurement (D68).
- **"For most bodies" is off by an order of magnitude, and the correction is better news than the claim.**
  HydroLAKES' floor is 10 ha; a 4,000-body sample of the dev corpus puts **7%** above it (73% are under
  1 ha). But **every** sampled body drawing at z ≤ 10 is above the floor — 234 of 234, plus all 16
  curated-boosted bodies. The data reaches 7% of the corpus and ~100% of what a skater browses at regional
  zoom. The inverse is the honest half: the shallow signal is most predictive for the ponds no global
  source reaches, so the manual `bodyFeature` is **permanent infrastructure, not a stand-in**.
- **"Real data instead of a manual flag" overstates both named sources** — HydroLAKES' `Depth_avg` is
  modelled from a 90 m DEM, GLOBathy's `Dmax` is a random forest validated at 1,503 lakes *globally*.
  Neither is measured bathymetry, which is why provenance is a field and why D3 governs the display.
- **A better first source than either:** **LAGOS-US DEPTH** — *observed* depths compiled from ~65 agency /
  university / monitoring sources, lakes > 1 ha, an order of magnitude below HydroLAKES' floor. It becomes
  rung 2 of the D68 ladder, above both modelled sources.

**N6b — The bathymetry layer: real isobaths inside the lake.** ✅ **COMPLETE (2026-08-01); prod
deferred.** See [`phase-N6b-bathymetry-layer.md`](./phase-N6b-bathymetry-layer.md).

Archived (five sources, 298 MB, mirrored privately) → normalized → **joined, 2,437 of 2,491 lakes
(98%)**, Vermont included for the first time → gated → **2,044 lakes contoured into 49,767 lines** →
tiled to a **15 MB** z9–z14 `.pmtiles` on the Phase 2.5 upload lane → uploaded → drawn by both clients.

The render half is small because **D81 and D82 removed most of what there was to decide**: contours
are a property of the detail view, so the source mounts on drawer-open and unmounts on close, with no
toggle, no persisted preference and no settings row. They sit under every hazard, fade in once their
own lines are on screen, and carry one credit line at the bottom of the drawer, derived from the
features actually drawn. The rung-1 depth write stays correctly gated behind N6a's ordering gate.

**Two findings worth carrying forward.** GLOBathy's 1.4 M per-lake rasters are a linear
distance-from-shoreline transform, so contours drawn from them would be an authoritative-looking
rendering of a guess — permanently out of scope, not deferred. And **every input-side quality gate we
tried was falsified by a render**: five of them, each plausible on paper. The layer ships with no
output-side gate at all, which is only tolerable because D82 means a contour makes no claim a skater
can act on wrongly.

- **A source lake key is not always one lake.** 15 keys hold two or more water bodies — NH files two
  ponds 51 km apart under one `au_id`, Maine's MIDAS `870` scatters over 379 km. One key resolves to
  one polygon, so unsplit, the second pond's geometry is clipped against a shoreline miles away and
  vanishes *without an error*. Found by rendering a blank card. Split before the join now.
- **The join blows Convex's 16 MB per-execution read cap**, and lowering the batch size cannot fix it:
  the cost per lake spans three orders of magnitude between a farm pond and a point in the middle of
  Champlain. Batching is adaptive — split-and-retry, with a lake that fails alone recorded as a named
  reject.
- **Checked against the agencies' own charts.** Maine IF&W and VT DEC both publish finished depth maps,
  and for Maine those are the *originals our points were digitised from*. Max depth matches exactly on
  both lakes checked (36 ft, 42 ft), which independently validates the whole unit chain.
- **⚠ Three gates, and two of them had to be re-derived by looking.** The density gate's premise was
  overturned by its own comparison (quality does not track the gap ratio); the shore-share gate was
  added and removed the same day after it kept the worst map in a 20-lake sample and dropped four of
  the cleanest. Its replacement — disconnected pieces per contour level — was falsified within the hour
  by Lake Champlain, whose 10.2 pieces per level are a dozen real basins. **Five metrics have now
  failed to predict output quality**, so we ship with no output gate at all, which D82 makes cheap.
  The whole sequence is written up for a non-specialist reader in
  [`docs/bathymetry-challenges.md`](../docs/bathymetry-challenges.md).
- **A fairness bug in the primary gate**, found by the founder asking whether the floor should be a
  density rather than a count: the coverage gap was normalised by the **bbox diagonal**, which across
  2,437 bodies runs 1.76–3.36× `sqrt(area)` — so long thin lakes got up to a 4× easier pass. Now
  normalised by `sqrt(area)`.

- **All five states are covered, and two of them aren't what this entry assumed.** VT publishes
  **soundings, not isobaths** (2.4M BioBase sonar points over 66 lakes, plus 105k NOAA-chart points for
  Champlain), which makes it the *hardest* lane rather than the easy pilot half. Maine's IF&W depth maps
  turned out to be **already digitised by the state** (147,755 points over 1,525 lakes). NH (9,285
  contours / 558 lakes) and MA (27,989 contours) are clean published isobaths. **NY publishes nothing** —
  checked exhaustively; it is covered only via Champlain, and the PDF digitisation path is costed in the
  phase doc.
- **The interpolation was the hard part by a wide margin**, and every failure was invisible in review and
  obvious on a render. Five mechanisms were rejected — IDW (bullseyes), TIN (facets), moving average
  (search-radius arcs), isotropic GMT `surface` (splits a real trough into isolated pits), and coordinate
  compression left uncompressed (smears every lake into a lens). What works: `gmt surface` with the
  shoreline as a depth-0 constraint, solved on an axis-compressed grid and `grdedit`-ed back to real
  metres. **The shoreline constraint is load-bearing** — without it contours never close and nothing
  nests.
- **⚠ One limitation is documented and unresolved: the anisotropy axis is straight, and lakes bend.**
  Mitigated by capping anisotropy at each lake's own measured elongation (a curved basin's point cloud is
  rounder, so it relaxes itself). Five options for a curving axis are costed in the phase doc §*Options
  for the curving axis* — the recommendation is to accept the current state and revisit with a
  medial-axis frame only when a real user complains about a named lake.
- **Also unresolved:** contour crowding on steep beds (the obvious fix — dropping bunched levels — was
  rejected because it would understate depth by omission), and the fact that the most detailed-looking
  part of a rendered lake is the unmeasured strip between the shore and the first sounding.
- **Density gate set at 12%** by rendering twelve real lakes in three bands. The comparison overturned its
  own premise: quality does **not** track the gap ratio — the worst map in the grid was at 10%, with more
  soundings than any other sample.
- **D89 — the contour interval is a fixed 5 ft ladder, not a per-lake target.** Ring *count* now reads as
  depth across lakes (three on a 17 ft pond, eleven on a 59 ft one) rather than every lake being
  normalised to a dozen bands. The old depth-only rule was backwards in the way that mattered: it gave
  Washington Pond (36 ft, **105 soundings**) a 2 ft interval and Lake Morey (42 ft, **68,139 soundings**)
  a 5 ft one. The ladder only ever steps *coarser* — for depth, or for thin data — never finer. Contour
  lanes reach it by **subtraction only**: an agency's published levels are thinned toward the ladder and
  never moved or added to, and the deepest published level is always kept, because thinning away the
  innermost ring is D82's understating-by-omission by another road.
- **The render half found one real thing, and it was a licence problem rather than a rendering one.** To
  stay small, a tile carries a short agency label — and for Champlain that label is `VCGI / NOAA`, which
  is exactly the credit we may **not** render: VCGI's terms name the University of Vermont, and NOAA asks
  that attribution not imply its involvement in data it did not draw. So the client resolves each label
  to the required wording verbatim (`CONTOUR_SOURCE_TERMS` in `@skating/core`), and a test in
  `scripts/bathymetry` pins that table against the source registry **in both directions** — adding a
  source without registering it would ship lines with no credit at all.

Settled at kickoff: **PMTiles on R2** (the Phase 2.5 basemap infra), **VT + NH first**, Maine's
point-interpolation path written up rather than built. Two findings worth carrying:

- **Not from GLOBathy's rasters, permanently.** They are generated by converting each cell's Euclidean
  distance-to-shoreline into a depth with a linear equation, so contours drawn from them are inward
  offsets of an outline we already store — smooth, plausible, and carrying zero information about basin
  shape. The mistake is available (free, global, already joined for N6a, and the output *looks like*
  bathymetry), which is why it is recorded as out of scope rather than deferred.
- **Vermont is cheap, and we build it ourselves anyway** *(decided 2026-07-30)*. VT ANR + NOAA-charted
  Champlain isobaths are cleanly published, and an open-source CC0 project has already run the same chain
  over them — useful as prior art (two of the phase doc's findings come from its README, including the
  Champlain **datum trap**), but not as a dependency. Reusing its prebuilt tiles would save one lane of a
  pipeline we're building for NH/MA/NY regardless, while leaving one state's overlay on someone else's
  tiling parameters and skipping the end-to-end proof on half our pilot. **Every state goes through our
  own pipeline.**

- **All six open questions answered 2026-07-31**, and two of them were **dissolved rather than decided**.
  **D81** — contours are a property of the detail view, not a toggleable layer — removes the zoom-cutoff /
  D49-prominence question (contours are never on the browse map) *and* the persisted-preference question
  (there's no preference left to persist). **D82** — bathymetry is context, not counsel — removes what the
  doc called its hardest part: the copy that had to explain that "shallow = safer" reverses across the
  season is now **no copy at all**, since depth's safety role stays inside the decay math the skater never
  reads. **D83** keeps each state's native contour interval and units, labelled, because resampling a
  survey means drawing isobaths nobody surveyed. And attribution turned out smaller than feared: OSM's
  on-map obligation is the *basemap's*, while state-agency contour credits have no placement rule and
  belong at the bottom of the lake drawer with the depth provenance.

*Also folded into N6a:* the ETL update carrying OSM `depth`/`maxdepth` tags where they exist (rare).
**Built 2026-07-31, in the review pass, having been asserted here and missed in the build** — this line
claimed the work was folded in while `osm_tag` sat in the enum with no producer, which is the same
described-as-wired failure N6a opened by cataloguing. It rides the **water** ETL (`scripts/etl`,
`--depths` → `load-depths`), not the depth ETL, since only that pass ever sees an OSM feature, and it
therefore ships with the canonical re-import rather than the depth run.
*Also folded into N6b:* bulk state-agency bathymetry (NH GRANIT, VT ANR, MassGIS, NYSDEC), since those
datasets are being fetched there anyway — an operator override covers specific lakes until then.

**N6c — Expanded lake profiles: derived stats, captions, and reference links.** 📋 Scoped 2026-07-30,
unbuilt — see [`phase-N6c-expanded-lake-profiles.md`](./phase-N6c-expanded-lake-profiles.md); decisions
**D70** (derived-not-hand-maintained), **D71** (links generated, not stored), **D74** (one physics source
+ NWS alerts), **D75** (satellite ships as a link), **D76** (in-app browser, never a WebView).

N6a gave every lake two depth numbers and a provenance caption, and **told a skater nothing about what
they mean**. This phase is that payoff plus the lake-page gaps open since Phase 2 — shape, exposure,
elevation, and where else to look.

> **All five open questions answered 2026-07-31**, adding **D85** (geometry stats measured on the source
> geometry) and **D86** (the summary card's quality consensus renders as a graded mark, never a word —
> reversing the doc's own recommendation to defer). Also in scope now: a **short forward forecast** on the
> lake drawer, which turned out to be free — `weather.ts:112` already requests `forecast_days: '1'` and
> the window filter discards the forward hours. NWS alerts move to **zone precision with a state
> fallback rung**, so a slipping zone import can't block the feature.

- **⛔ Elevation now *gates* the N6a depth ETL run** (founder call, 2026-07-31 — *"definitely block N6a
  ETL run until we're ready for elevation"*). `elevationM` is a per-centroid lookup against Open-Meteo's
  free elevation endpoint (~1,200 batched requests for all 116,070). Folding it into that unrun loader
  costs **one column**; doing it afterwards costs **a second full pass over the corpus**. Recorded as a
  hard gate in [N6a](./phase-N6a-lake-depth.md#before-the-etl-runs--the-ordering-gate), with the escape
  hatch stated so it stays reversible under season pressure.
- **There are two ETL passes in flight, not one (D85).** The depth run carries elevation; the **canonical
  water re-import** carries the geometry stats, because shoreline and axis must be measured on the
  pre-simplification geometry rather than the ~5 m-simplified polygon we store. Conflating them is how a
  field gets missed.
- **Wind fetch is the genuinely new signal** — a 16-bearing over-water-distance profile precomputed at
  ETL (16 numbers/body), so the drawer can pair today's wind direction with the distance it crossed. It
  is one of the main determinants of whether a lake sets smooth black ice or gets wind-slabbed, and
  nothing in `plans/` had mentioned it before this pass. Long axis + shoreline length come along with it.
- **The links cover 116k *because* they aren't stored (D71).** They're pure functions of
  `(centroid, name, states)`, so full-corpus coverage costs a `@skating/core` module and no migration.
  The founder asked for ETL coverage; not storing them is what delivers it.
- **This retires the satellite-imagery blocker below.** Copernicus Sentinel data is under the free, full
  and open licence, so *"needs an imagery source whose terms permit the use"* is answered — the deep link
  ships here (D75), and **in-app imagery is now its own phase, [N6e](./phase-N6e-satellite-imagery.md)**
  (scoped 2026-07-31 at the founder's ask). The cost trigger turned out to bind only *half* of it: see
  **D84**.
- **NWS alerts are the one new integration** (free, no key, `User-Agent` only). Open-Meteo still computes;
  NWS only informs (D74).
- **A proving run, not a general rollout:** `scripts/seed-satellite` (renamed from `seed-destinations`
  2026-07-31 — named after the job, not its first dataset) matches the ~35–40 destinations already
  surfaced in research to `waterBodies` rows, sets `curatedBoost`, and verifies each generated Copernicus
  URL — proving URL shape, name-matching at 116k, and imagery legibility before anything is built on top.
  **Two commands, not one:** a `--dry-run` emitting reviewable matches, then an apply step, because the
  founder reviews the list before boosts land. The unmatched entries are the interesting output.

**N6d — Lake access points: parking, named put-ins, and access alerts.** 📋 Scoped 2026-07-30, unbuilt —
see [`phase-N6d-lake-access-points.md`](./phase-N6d-lake-access-points.md); decisions **D72** (parking
modelled apart from put-ins) and **D73** (access blockers decay, they aren't notes). **Split out of N6c at
scoping** — it was roughly the size of everything else there combined, and it's the only part introducing
a new lifecycle. Independent of N6c; either order.

- **The bug this fixes:** `putIns` is a bare coordinate and `directionsUrl` routes a car to it. For a
  hike-in pond that's a destination a maps app cannot route to, discovered at the trailhead in winter.
- **OSM already has the data, and already named it.** A second `osmium tags-filter` pass over the *same*
  Geofabrik extract yields named slipways, parking, toilets and trails — no new source, no new download,
  no new account. Compass-side fallback labels ("North launch") where OSM is silent. This is what makes
  named access points a 116k feature rather than a 36-lake one.
- **Access blockers reuse the hazard confirm/deny machinery but must *not* reuse its decay.** A locked
  gate does not thaw; applying the D56 weather multiplier would let a warm week silently expire a road
  closure (D73). Plain TTL + confirmation, hard-expiring at the N5a season boundary.
- **One N5a carve-out:** access-point photos document infrastructure, not conditions, so they're excluded
  from the seasonal photo purge (D66) while staying inside N3's redact-don't-erase.

> **All four open questions answered 2026-07-31.** **D87** — approach distance is **routed**, not flown:
> **OpenRouteService's `foot-hiking` profile** is the same account, key and client Phase 4's drive-time
> isochrones already use, and with `elevation: true` it returns **ascent in metres**, which answers the
> founder's *"elevation gain is going to affect people just as much as distance"* with a request parameter
> rather than a second integration. Called at ETL time and cached — **never from a request path**. The
> **Hike-In chip** ships on the map card, the drawer and the feed card, and the drive time and the walk are
> **never summed**: a 55-minute drive plus a 25-minute walk is not an 80-minute drive.
> **D88** — access photos ride D57's existing posting permission; a permission always equal to another
> permission is one that will silently drift.
> **A D72 amendment** — the ~250 m radius caps the OSM pass's *guessing*, never a human's assertion, so an
> author can associate a trailhead lot a mile from the ice. That makes `parkingAreas` **many-to-many** with
> bodies (a trailhead serving three ponds is normal here), which is cheap now and awkward later.

**N6e — Satellite imagery in the app: the one map-layer toggle.** 📋 Scoped 2026-07-31, unbuilt — see
[`phase-N6e-satellite-imagery.md`](./phase-N6e-satellite-imagery.md); decisions **D81** (second half —
satellite is the map's only layer toggle and it replaces the base map) and **D84** (two imagery tiers).
**Split out of N6c's Workstream B3** at the founder's ask — *"I don't want to lose track of this, because
I want to do it ASAP."* The Copernicus deep link (D75) ships in N6c either way.

- **It doesn't fit inside B3, and the reason is the phase.** B3 ships a URL. This ships a **base-map
  swap**: a style branch on two clients, a persisted toggle, an attribution that changes with it, an
  offline story, and an interaction with every layer already on the map.
- **The quota that deferred this binds only half of it (D84).** Sentinel-2's 10,000 requests/month says
  nothing about **USGS/NAIP aerial** — public domain, no key, no quota, ~0.6 m. And the highest-frequency
  use of a satellite view (*where's the pull-off, which dirt road, is that an island*) is served **better**
  by 0.6 m summer aerial than by 10 m winter Sentinel-2. **The valuable tier is the unconstrained one.**
- **Tier 2 is a dated observation, not a base map.** A Sentinel-2 pass from eleven days ago rendered
  without its date foregrounded is the D3 trap in raster form. Its date is not a caption detail; it is the
  content — which is why the phase's last open question asks whether it belongs in the drawer rather than
  on the map at all.
- **The swap line is content vs. chrome (D81).** Hazards, skate paths, put-ins and parking stay drawn;
  fills, outlines and contours are what the photograph replaces. A skater who turns on imagery to check a
  put-in must not lose the hazard pins doing it.
- **The pairing that justifies it: imagery + N6d.** *"Park here, then 400 m on foot"* is a claim; a 0.6 m
  photo of the pull-off, the gap in the trees and the path to the shore is the confirmation — at home, in
  daylight, before the drive. NAIP's leaf-on summer imagery is useless for ice and ideal for access.

**N5c — Hazard identity: one clustering primitive, two time windows.** ✅ **Built 2026-07-31, both
halves.** The within-season half shipped as **PR #34** (clustering, nudge, pooling, consensus
rendering, auto-merge, manual authoring, the D53 amendment and the rename); the cross-season half —
`hazardRecurrence`, the rollover job, the operator queue and the skater advisory — is built on
`phase-n5c-recurrence`, green across every suite, **unpushed and undeployed**. The advisory ships
**dark** behind `RECURRENCE_ADVISORIES_PUBLIC = false`, which is the intended state: operators watch
patterns form for two rollovers before anybody sets the public bar. Scoped 2026-07-30 —
see [`phase-N5c-hazard-memory.md`](./phase-N5c-hazard-memory.md); decisions **D77** (one clustering
primitive, two windows), **D78** (recurrence is history with its denominator, admin-only until a tunable
bar), **D79** (moderators author body features directly), **D80** (duplicates are consensus: prevent,
pool, render, merge reversibly), plus a **D53 amendment** (supersession is a backlink, not a hiding
mechanism) and the `shallow_bay_early_thaw` → `shallow_early_thaw` rename. **Moved out of *Waiting on a
blocker* by a founder call**, and merged at scoping with the duplicate-corroboration ask of the same day.

- **Two founder asks turned out to be one problem.** *"Which hazards existed on this lake in `'24/'25`?"*
  and *"if three people pin the same ridge, do their confirmations split?"* are the same geometric
  judgement at two time scales. One `clusterHazards` in `@skating/core`, two callers, two tolerances —
  because building it twice guarantees they drift, which is the D65 four-copies lesson.
- **The corpus gate was answered, not waited out.** Dev holds **one** hazard row and the three-season gate
  can't fire before ~2029, so the engine ships now with thin patterns **admin-only** and the skater-facing
  advisory dark behind a constant (D78). Nothing shows a skater a one-winter coincidence; operators watch
  patterns form and set the bar from evidence.
- **The duplicate half has no corpus gate and pays off in the first winter.** Splitting confirmations
  doesn't fade hazards — there's no time-based archival and the opacity floor is deliberate — but it does
  stop the on-ice alert escalating, and it **deletes** a `ridge_crossing`, which is the one pin that
  expires on time alone (D64).
- **Absorbs two entries from *Volume + calibration*:** consensus rendering of clustered same-type hazards,
  and auto-merge of very-high-confidence dedup pairs (now reversible, on the D36 tombstone pattern).
- **Reaches a `bodyFeature` type nothing could reach before.** Recurring volatile hazards propose
  `shallow_early_thaw` at a raised bar, checked against N6a's depth (D68/D69) — recurrence proposes the
  flag from observation, depth checks the proposal.

**N7 — Notification pipeline, the non-push half.** *(Grouped because both are pipeline internals that
**don't** need push credentials — worth doing while push is blocked, so the pipeline is correct and
scalable by the time delivery lands.)*
- **Per-user local-time / true-sunset digest timing** (today: a fixed 8pm ET, fine for a
  single-timezone pilot).
- **Reverse spatial index for notification fan-out** — replace the per-user polygon scan (a documented
  seam since Phase 4). **N1 changed its urgency, not its value:** the scan no longer sits inside
  `reports.create` (it's a scheduled, self-continuing paged job), so this is now a cost optimization
  rather than a latent write-path crash. Still the right end state — every new report walks every
  profile, which is work proportional to users × reports.

**N8 — The unbundled remainder.** *(Genuinely independent, genuinely low-urgency — do these
opportunistically or when a trigger fires, not as a planned phase.)*
- **Apple HealthKit capture adapter** — notable as **the one watch adapter needing no partner
  approval** (entitlement + dev build only), so it's unblocked while Garmin/COROS/Polar wait on review.
  Shares the iOS device-verification dependency.
- **Server-tracked "recommended" caps/dedup** — the impressions store + `acknowledgeRecommended`
  read/write split. Fully designed **including the fail-open guardrail** (never suppress on uncertain
  state); trigger is real data showing the feature feels spammy, plus per-hour pacing if per-day is too
  sparse.
- **Code-level GPS replay rig for CI** — the Android emulator's GPX playback covers manual QA today.
- **First-class in-app avatar upload** — Clerk manages avatars for now; revisit only if its UX bites.

### Waiting on a blocker

Grouped by *what* is blocking, because that's what determines when it moves.

- **A lawyer (Q10 / L1 — one engagement clears most of this).** Full ToS + privacy policy +
  assumption-of-risk enforceability; the minor-data posture (L2); deletion/retention wording (L3 — the
  N3 *mechanism* is unblocked, only the copy waits); the AGPL App Store / Play exception text (L4); the
  landowner-takedown wording and any obligation to honor requests (L11). Separately legal-gated:
  **forum / Facebook / Google-Group ingestion + republication** (Q8 / L5 — feasibility *and* consent
  *and* ToS); **AI summarization beyond weather facts** (Q9 / L6 — liability review); **PostHog session
  replay** (L12 — masking + minor-exclusion + a `PRIVACY.md` update must land first); **ODbL
  share-alike** (L10 — only bites if we ever publish the derived `waterBodies` extract).
- **External approval queues (weeks).** Garmin / COROS / Polar capture adapters + the watch-wins ingest
  path (L8) — **the roadmap has said "apply now" since Phase 0; confirm whether the applications are
  actually in, because this is the longest pole in the whole register.** Google Health Connect
  additionally needs a Play health-data access review (and a Play account). Additional push targets
  (Whoop) need their own API access.
- **Device access.** Phase 8 verification (Android-emulator GPX playback + a friend's iPhone for iOS
  background/battery parity); the **Layer-3 offline basemap tile-pack**, built flag-off in Phase 9.5 and
  needing exactly **one** on-device confirmation; real cold-weather battery draw and real
  compass/course-noise behavior (Phase 9.5 QA). No owned iPhone is the standing constraint — budget for
  a QA gap and stay conservative in the iOS background-mode copy.
- **Push infrastructure + store credentials.** Remote **push delivery** — Phases 3/4/6 all deliberately
  land in-app `notifications` rows; `expo-notifications` is installed (Phase 9.5) but **local-only**,
  with no token registration, no APNs/FCM credentials, and no server sender. **Silent
  background-refresh push to a closed app** (D54) needs that whole layer *plus* a privacy decision
  (the biggest departure from D12) *plus* accepting that iOS throttles silent pushes at its discretion —
  a shaky base for safety content, which is why it's deferred twice over.
- **The prod cutover.** Convex **prod has never been initialized**, and `convex deploy` stays blocked
  until the **Clerk prod** env vars exist. Then: the multi-state import into prod, the prod tile URL,
  Vercel/EAS env vars, `SENTRY_AUTH_TOKEN` for build-time source maps, and the Resend key + verified
  sending domain (until which operator alerts log-and-skip). TestFlight / Play internal-testing
  distribution to the alpha crew rides on the same accounts. *First step is a founder task, not an
  external wait.*
- ~~**Hazard memory → automated `bodyFeatures` promotion + "potential hazard" surfacing (founder ask,
  2026-07-27).**~~ **→ SCOPED AS N5c (2026-07-30), and the blocker was answered rather than waited out.**
  The gate said *three seasons of in-app hazard rows*; dev holds **one**, so the gate couldn't fire
  before ~2029. The founder call was to **build the engine now with thin patterns admin-only** (D78) —
  which avoids the D3 trap by the gate rather than by the delay, since the trap is showing a *skater* a
  one-winter coincidence, and nothing does that. Deferring would instead have meant three winters of rows
  nobody looked at as a series, and a matching radius tuned from scratch in 2029. See
  [`phase-N5c-hazard-memory.md`](./phase-N5c-hazard-memory.md).
  - **The D62 constraint is closed, and it's worth keeping the record of why it mattered.** Under the
    first amendment a departed user's hazards were *deleted*, so recurrence would have been computed over
    a corpus silently missing rows — a count that looks complete and isn't. Under redact-don't-erase,
    **hazards are kept and anonymized**; only their descriptions go, and the multi-season record survives
    a departure intact. That is the main reason the second amendment matters to the roadmap and not only
    to the deletion flow.
  - **The D3 constraint stands and became D78's copy discipline**: any recurrence claim is **history,
    never a prediction** — "ridges usually form here" and "there is a ridge here" are different sentences
    and only one of them is ours to say. Every public advisory carries both numbers, is past-tense with a
    reporter, and never enters the on-ice payload.
- **Volume + calibration (buildable, but building now is speculative).** ~~Per-body map summary cards~~
  **→ moved into N6c as Workstream E (2026-07-30, founder call)**; the density gate that held them here
  is retired by a design rule rather than by waiting — *a body with nothing to say gets no card at all,
  not an empty one* — so they're safe to ship into a sparse corpus. **GPS-path hazard
  deduction** (Q11 / L9 — the *legal* half cleared with the Phase 8 pivot, so what's left is path volume
  plus an L14 privacy pass); pressure-ridge / clearest-side crowd intelligence; ~~non-destructive
  **consensus rendering** of clustered same-type hazards~~ and ~~**auto-merge** of very-high-confidence
  dedup pairs~~ — **both folded into N5c (2026-07-30, D80)**, since the clustering primitive N5c needs
  across seasons is the same one they need within a season; community "same place?" confirmations and the
  re-ETL overlap scan (D36's staged half) stay here;
  **in-app satellite imagery** (moved here from "needs design" by N6c — the licence is settled, what's
  left is whether reads concentrate enough for server-side tile caching to fit the free quota, plus the
  standing Planet cost question); a
  **decay-magnitude refit** of `HAZARD_DECAY` + the `decayMultiplier` magnitudes against a real in-app
  corpus (signs are locked, numbers are tunable defaults); a dedicated bounties **geospatial** instance
  (only past the 200-scan cap); and **self-hosted ORS** for a true 90-min band (a ~$15–50/mo warm
  container — a cost/ops decision, not a technical one).
- **Needs design before it's buildable.** ~~The **satellite imagery layer**~~ **→ resolved by N6c
  (2026-07-30, D75): the licence question is answered** (Copernicus Sentinel data is free/full/open with
  attribution), the deep link ships in N6c, and what's left — imagery rendered *in* the app — moved to
  **Volume + calibration** below, since it's now a cost/traffic call rather than a design one. Still
  here: **in-app guides**;
  **group-skate organizing**; **rivers as named reaches** (the D4 model, deferred since Phase 1 —
  validate still-water with users first). Deliberately *not* doing: **Fitbit** as a provider, the
  **`appConfig`** runtime-tuning seam (edit-and-redeploy is the settled posture), **encoded-polyline**
  transport, and **k-anonymity** contributor gating (dropped by D58).

### Design sketches for deferred items (kept in full)

The long-form write-ups the entries above point at — preserved verbatim, since the *why* is the point.

- **Per-body summary cards on the map at appropriate zoom (founder ask, 2026-07-21).**
  **✅ PROMOTED INTO N6c AS WORKSTREAM E (2026-07-30, founder call — *"it's about time we took care of
  that"*).** Kept in full because the sketch is what N6c's workstream was written from, with three
  changes made at that scoping: **(1)** the card carries **active report counts and types only** — no
  recurrence / "potential hazard" line from N5c, since this surface sits closest to the map where D3
  pressure is highest (asked and answered at N5c scoping, and recorded there as worth revisiting
  deliberately later); **(2)** the **consensus quality** signal below is deferred to that same later
  pass, as the other D3-sensitive half — it is N6c's open question 5; **(3)** the "do this when" density
  trigger is **retired by a design rule instead of by waiting** — a body with nothing to say gets **no
  card at all**, not an empty one, so the feature is harmless in a sparse corpus and simply appears on
  the lakes people are actually using. The original text follows.

  Today the map
  shows water-body polygons and you must open a lake to learn anything about it. The ask: at suitable
  zoom levels, surface a compact card/label over *unselected* bodies with the at-a-glance basics — lake
  name, recent report count, a general quality consensus, and the most important active hazard types.
  **Deliberately not in Phase 9** (decided at kickoff): it is a map-browse feature, not a hazard feature,
  and doing it properly would roughly double Phase 9's backend surface.
  - **Why it's its own piece of work:** it needs *cross-viewport* aggregation over both reports and
    hazards. When this was written that meant the read-cap-fragile geospatial path Phase 9 avoided by
    scoping hazards to the selected body (PR #10/#11). **N1 changed the calculus**: a viewport read is
    now bounded, so the objection is no longer "this reproduces a crash" but the plain cost of
    aggregating per read at viewport scale — which the denormalized-on-write shape below still answers
    better. The per-body scoping decision stands on its own merits.
  - **Likely shape:** a denormalized per-body summary maintained **on write** — the Phase 4
    contribution-counter pattern (`lib/contributionCounts.ts`) generalized. Something like
    `waterBodies.summary { recentReportCount, consensusQuality, topHazardTypes[], updatedAt }`, bumped by
    `reports.create` / moderation transitions / hazard create+confirm, and swept by a cron for time
    decay (the counts are inherently time-windowed, so they go stale without a tick).
  - **Open sub-questions:** what "recent" window; how to derive a consensus quality that never reads as
    an authoritative safety claim (D3 — the same trap as hazard decay); whether the card renders as a
    MapLibre `symbol` layer with data-driven zoom filters or as HTML overlays; and how it interacts with
    `minVisibleZoom`/`displayScore` (D49) so cards don't fight the existing prominence scoring.
  - **Do this when** there's enough report density that a lake summary is non-empty for most bodies in a
    viewport — before that it's mostly blank cards.
- ~~**Harden `waterBodies.listInViewport` against the read-cap crash — multi-cell / bbox-coverage
  geospatial indexing**~~ **✅ SHIPPED as N1 (2026-07-26).** Kept as a pointer because the *root cause*
  is worth remembering: `@convex-dev/geospatial` reads roughly **∝ `maxResults`** (S2 read-ahead over
  the query rectangle's covering), **not** ∝ results returned, so a wide sparse viewport exhausted a
  covering and hit Convex's hard **4,096-reads/query** cap — a crash, not slow paging. Every mitigation
  around it (`MAX_VIEWPORT_LIMIT = 256`, keeping the `listed` filter out of the query, the `isLarge`
  outlier scan) was a workaround for that one property.
  - The fix this entry proposed — "index each body under every S2 cell its bbox covers" — turned out
    **not to be expressible in that component at all**: its write API is one point per unique key. So
    N1 replaced it with a plain-table ladder grid, where reads cost only the rows returned. See
    [`phase-N1-read-path-durability.md`](./phase-N1-read-path-durability.md).
  - Its "do this when" trigger — *the 256 clamp visibly drops bodies at normal zoom* — had **already
    fired and gone unnoticed**: dense eastern Maine holds 513 bodies at z12. That's the lesson worth
    carrying forward more than the mechanism.
- ~~**Clip hazard footprints to the water-body boundary**~~ **✅ SHIPPED in Phase 9.5 (2026-07-22)** —
  this entry was stale (caught 2026-07-24). `core/hazardGeometry.clipFootprintToBody` precomputes the
  clipped polygon at create time and `hazardLayer` render, bbox and `distanceToHazard` all read the
  *same* stored footprint — which is what the "what's drawn IS what the proximity alert measures"
  invariant required. Kept here only as a pointer; see [`phase-9.5-on-ice-alerting.md`](./phase-9.5-on-ice-alerting.md).
- **Self-hosted OpenRouteService (true 90-min+ isochrone band).** Phase 4 ships drive-time on the
  **hosted ORS**, whose isochrone API is hardcoded to a **60-min max range** for `driving-car` — so the
  90-min band is a uniform crow-flies radius fallback there. Self-hosting ORS (a memory-hungry JVM/Docker
  service loading an OSM routing graph — **cannot** run on Convex or Vercel; needs a persistent container
  with ~4–8 GB RAM on a small VM: Hetzner/Fly.io/Railway/Render, ~$15–50/mo; Cloudflare **not** required)
  lets us (a) raise the isochrone range for a **real 90-min (and beyond) band**, (b) drop the hosted
  free-tier daily quota + rate limits, and (c) tune the routing profile. Our actual load is trivial
  (isochrones computed only on home-address change, cached per user), so it's a single small **warm**
  instance, not a fleet — the graph build takes minutes, so it stays warm rather than cold-starting per
  request. **Do this when** the 90-min band's accuracy matters or hosted quota bites; until then the
  radius fallback is fine for the outer, aspirational ring. *(Context: Phase 4 discussion 2026-07-17.)*
- *(The one-line entries that used to sit here — forum/Facebook ingestion + comment-vs-report
  classification (Q8), GPS-path hazard deduction (Q11), auto-merge dedup + community confirmations
  (D36), AI summarization beyond weather facts (Q9), the full legal review (Q10), in-app guides,
  group-skate organizing, and Fitbit — now live in **Waiting on a blocker** above, filed under what's
  actually blocking each. Not dropped; sorted.)*
- ~~Satellite imagery layer toggleable in lake detail view. **NOTE: This plan still needs to be explored**
  — and it needs an imagery source whose terms permit the use, which is its own question.~~
  **✅ EXPLORED — and the blocking question is answered (N6c, 2026-07-30, D75).** Kept as a pointer
  because the shape of the answer is worth carrying: *"an imagery source whose terms permit the use"* had
  been treated as an open search, and **Copernicus Sentinel data already satisfied it** — free, full and
  open licence, reproduce/distribute/adapt with attribution. The blocker was never a missing source; it
  was that nobody had checked the one obvious one.
  - **What ships in N6c:** a Copernicus Browser **deep link** per body — zero cost, zero quota, no
    account. Sentinel-2 is 10 m on a ~5-day revisit, which is enough that open water vs. black ice vs.
    snow-covered ice is visually obvious; cloud cover is the limiter, so the link opens a ~14-day window.
  - **The toggle this entry asked for exists, derived** (D70): `satelliteImagery: 'auto' | 'on' | 'off'`,
    where `auto` resolves off surface area, because 10 m pixels cannot resolve a 2-hectare pond. Per-row
    data ⇒ **the admin control needs no redeploy**; only the threshold behind `auto` is a code constant.
  - **What's left, and where it went → [N6e](./phase-N6e-satellite-imagery.md), scoped 2026-07-31** at the
    founder's ask (*"I want to do it ASAP"*). And the scoping pass found that **the quota binds only half
    of it (D84)**: the 10,000-requests/month ceiling is a *Sentinel-2* constraint and says nothing about
    **USGS/NAIP aerial imagery**, which is **public domain, no key, no quota, 0.6 m**. The
    highest-frequency use of a satellite view — read the landscape, find the pull-off, check the
    put-in — is served *better* by 0.6 m summer aerial than by 10 m winter Sentinel-2, **and** it's the
    unconstrained tier. So the toggle ships on Tier 1 now; Tier 2 (dated Sentinel-2 ice imagery, with
    server-side tile caching the open licence permits) keeps the traffic trigger under **Volume +
    calibration**.
  - **The toggle's semantics are settled (D81):** satellite is the map's **only** layer switch, it
    replaces the *base map* rather than the content, and hazards, skate paths and access points stay drawn
    in both modes. Bathymetric contours go with the base map — they're cartographic furniture, and they
    have no toggle of their own.
  - **Planet** stays deferred as a *cost* decision (D75): their public catalogue is the same free data,
    and only PlanetScope (~3 m, near-daily) is new. Full numbers in `05-accounts-and-credentials.md`.
- ~~**Photo-orphan GC cron (cleanup/polish).**~~ **→ folded into N3 (2026-07-27).** The Phase 2 photo
  pipeline uploads before `reports.create`, so failed/abandoned/partial submits can strand storage. The
  client reclaims best-effort (`photos.remove`/`removeBlob`, incl. uploads that resolve after the form
  unmounts), but a killed app or a failed reclaim call can still leave orphans. See
  `phase-2-map-and-reports.md` → "Settled during review" (2026-07-15).
  - This entry said "low urgency until storage quotas bite", and **the trigger it was waiting for is not
    the one that fired**: N3's account deletion strands a departing user's unattached blobs and emits
    export bundles that need a TTL, so the cron became that phase's own cleanup path rather than a
    quota-driven chore. Worth remembering that a deferred item can be pulled in by a *sibling feature*
    and not by its own stated trigger.
  - Worth remembering too: Phase 7b built the `photo_orphans` metric **and** the `photos.by_created_at`
    index expressly to decide whether this cron was worth building — and neither this sketch nor the
    N3 entry knew it existed. It reads 0 on dev because dev holds **0 photos**, so the gate never had
    data to decide with. An evidence gate nobody points at is not a gate.

## Cross-cutting (every phase)
- **Tests land with the feature** — Vitest unit/logic + property tests for
  safety-sensitive math; `convex-test` for functions; coverage ratchets up (D40).
- Notifications with per-type toggles — every type toggleable (D16).
- Safety-first, non-authoritative framing in all copy (D3); assumption-of-risk ack (D45).
- Privacy by default: reports always public but the person controls **profile** privacy (D13),
  minors read-only (D41); EXIF stripped, geotag opt-in (D42).
- Metric internal / imperial display (D25).
- **Accessibility + dark mode** honored as UI is built (D34).
- **Sentry** crash/error hygiene; **PostHog** analytics/flags added once there's
  usage to measure (D29) — session replay masked/off where location or minors are
  involved (revisit before enabling).
- **Account deletion + data export** wired as auth/profile matures (D33, amended by **D62**) — scoped
  as **N3** in the register above; the mechanism is unblocked, only the policy wording waits on Q10/L3.
