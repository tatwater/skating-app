# Roadmap

Phased build sequence. Each phase is independently useful and ends in something the
alpha crew can test. Decisions referenced as D#; see `01-decisions.md`.

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
- **Needs:** OpenRouteService key. Notification fan-out uses a per-user polygon scan (fine at alpha
  scale; reverse spatial index is a documented future seam).

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
  - **Planned 3rd lever — `canPostComments` (boolean, D57 extension):** comments are free-text content, so a
    boolean revocation fits; its point is muting a toxic commenter *without* silencing their safety reports.
    Enforce in `comments.create` (`assertCanPostComments`); optional/migration-free. See D57 in `01-decisions.md`.
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

## Phase 8 — GPS providers (fast-follow order — D24)
- **Strava + Apple HealthKit first** (covers most of the US alpha; Strava carries
  write-ups/photos, HealthKit covers Apple Watch).
- **Garmin next** (watch GPS + fallback for cross-user map display if Strava's terms
  forbid it — see `04-integrations.md`).
- **COROS · Polar · Google Health Connect** fast-follow.
- Detect ice-skate activities → prompt report → ingest **trusted path** (+ media
  where ToS allows). Normalize to `gpsActivities` and **resolve each to its
  `waterBodyId`** (D44) so skates are findable by lake.
- **User-created water bodies (D14) + match-on-create dedup (D36)** *(moved here from Phase 2 on
  2026-07-13 — needs GPS to be good)*. When an ingested path resolves to **no** known body (the D44
  fallback), this is where a new body gets created — **GPS-path-backed, not freehand**:
  - **Derive bounds from the trusted path** (buffer + concave hull of `gpsActivities.path`) to
    propose a polygon + centroid + `surfaceAreaSqM`, instead of asking the user to draw one by hand
    (freehand shapes are messy and low-trust; a real skated track is far better evidence).
  - **Match-on-create dedup before inserting (D36):** bbox + geospatial-nearest prefilter → score
    each candidate with `@skating/core` `geometry.ts` (`polygonIoU`, `pointInPolygon`,
    `bboxIntersects`) + a new **`dedup.ts`** (`nameSimilarity`, `classifyDedup` with the D36
    thresholds) → **steer the user onto a nearby existing body** ("attach here?") via a
    `findMatchCandidates` query; require an explicit `confirmedNew` to insert when strong matches
    exist. Stamp `dedupStatus` / `duplicateCandidateIds`; auto-visible then review-after (D37).
  - The **moderator dedup review queue + merge** is already Phase 7; this feeds it.
  - Deferred sub-decision: whether to also offer a **manual draw** path (e.g. Terra Draw) for users
    without a GPS provider connected, or to gate creation on a path entirely. Decide at build.
- **Done:** logging an ice skate on a supported device prompts a report with the
  real path prefilled, the skate shows up in that lake's history by name, and a skate on **new**
  water can create/attach a body from the trusted path (dedup-steered).
- **Status (2026-07-24): planning — re-scoped for zero credentials (approach "A").** ⚠️ Correction:
  provider approvals were **never applied for** in Phase 0 (contrary to earlier drafts on this line and
  in `04-integrations.md`/`05-accounts-and-credentials.md`); **no provider keys exist yet.** Chosen
  approach:
  1. Register the **free Strava** API app (instant, no review for single-athlete dev) → build the
     **Strava vertical slice** end-to-end on the founder's own account (OAuth → webhook → ingest →
     report prefill).
  2. Build the **credential-free** halves now regardless — **user-created bodies + match-on-create
     dedup (D14/D36)** and the **provider-agnostic ingest/resolution core** (new `convex/http.ts`
     router, normalization, D44 resolver, `gpsActivity`→report-prefill) — testable with fixtures and
     feeding the already-built Phase 7 dedup/merge review queue (which currently has nothing flowing
     into it).
  - **Shelved until approvals land:** Garmin/COROS/Polar (partner review, ~weeks — apply *now* so they
    don't gate later), Apple HealthKit (needs the $99 Apple enrollment + a real device), Google Health
    Connect (Play health-data review). The ingest core makes each an incremental add.
  - **Cross-user path display (D24/D35) deferred** — ToS-gated on a current Strava-Agreement read that
    hasn't happened; this slice is **ingest-only** (detect → prefill → resolve-to-lake), which per D24
    never blocks shipping (native reports never required a path).

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
  signal** ships v1 as a manual `shallow_bay_early_thaw` `bodyFeature` (no depth data source exists in
  OSM); the real fix is a **HydroLAKES + GLOBathy** backfill of `meanDepthM`/`maxDepthM`, a separate data
  PR. Full write-up (sources, state bathymetry, ETL update) in `phase-10-weather.md` → Later/deferred.
- **Done:** aging reports **and hazards** show a plain-text, Open-Meteo-attributed weather-since strip
  (peak/overnight-low temp · nights below freezing · sun · rain-vs-snow · wind); hazard decay reflects
  what the weather actually did (never hiding a hazard); report conditions auto-fill from Open-Meteo;
  corroboration distinguishes a weather-explained change from a real contradiction and escalates a
  repeated bad-actor pattern to the D57 posting-permission lever (never subtracting trust); and bounty
  freshness is weather-aware.

## Later / deferred (see 02-open-questions)
- **Per-body summary cards on the map at appropriate zoom (founder ask, 2026-07-21).** Today the map
  shows water-body polygons and you must open a lake to learn anything about it. The ask: at suitable
  zoom levels, surface a compact card/label over *unselected* bodies with the at-a-glance basics — lake
  name, recent report count, a general quality consensus, and the most important active hazard types.
  **Deliberately not in Phase 9** (decided at kickoff): it is a map-browse feature, not a hazard feature,
  and doing it properly would roughly double Phase 9's backend surface.
  - **Why it's its own piece of work:** it needs *cross-viewport* aggregation over both reports and
    hazards, which is exactly the read-cap-fragile geospatial path Phase 9 avoids by scoping hazards to
    the selected body (see PR #10/#11 on `listInViewport`). Computing it per read at viewport scale
    would reproduce that bug class.
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
- **Harden `waterBodies.listInViewport` against the read-cap crash — multi-cell / bbox-coverage geospatial
  indexing (surfaced 2026-07-22, Phase 6).** The current two-tier centroid query (PR #10/#11) is *safe at
  today's scale* but structurally fragile: the `@convex-dev/geospatial` component reads roughly **∝
  `maxResults`** (S2 read-ahead over the rectangle's cell covering), **not** ∝ results returned, so a wide,
  sparse viewport exhausts a large covering and hits Convex's hard **4,096-reads/query cap** — a *crash*,
  not slow paging. Today's mitigations are workarounds, not fixes: `maxResults` clamped to 256
  (`MAX_VIEWPORT_LIMIT`, ~20% under the measured ~320 crash edge on the ~10k-body VT corpus), and the
  `listed` filter is **kept out of the geospatial query** (its filter-stream intersection ~halves the safe
  ceiling) and re-checked in JS instead — cheap only because Phase 1 has ~no unlisted bodies.
  - **Why it's its own piece of work:** the real fix is the deferred **fully-general** approach noted in
    [`phase-1-water-bodies.md`](./phase-1-water-bodies.md) (PR#4 root-cause, ~line 211) and flagged again as
    a scale risk in [`phase-2.5-regional-expansion.md`](./phase-2.5-regional-expansion.md) (~line 255):
    **index each body under every S2 cell its bbox covers** (not just its centroid point), so a wide query
    reads a bounded set of cells rather than expanding a covering until it blows the cap — and lets the
    `listed` filter move back into the query. It's a sizable geospatial rework (index shape, reindex/ETL
    path, `listInViewport` rewrite, the two-tier large-body merge, and a fresh read-cap test surface), so it
    belongs in its own PR, not bundled into a feature phase.
  - **Do this when** the corpus grows enough (Phase 2.5+ multi-state expansion) that the 256 clamp visibly
    drops bodies at normal zoom, or many unlisted/removed bodies make the JS `listed` re-check lossy behind
    the cap — whichever bites first. Until then the two-tier + D49 zoom-score mitigation holds. *(Context:
    revisited during Phase 6 Step 4 while scoping bounty browse, which deliberately sidesteps this path by
    serving off the `bounties.by_status_expires` index instead of a geospatial viewport query.)*
- **Clip hazard footprints to the water-body boundary (founder idea, 2026-07-21; from Phase 9).** So a
  large point+radius in a small bay can't render a circle spilling across land onto a peninsula or a
  neighbouring lake. Deferred from Phase 9 deliberately: it touches the "what's drawn is what the
  proximity alert measures" invariant, so it must clip render *and* alert together — cleanest as a stored,
  precomputed clipped footprint the render, bbox and `distanceToHazard` all read. Its own focused commit
  + device verification; full write-up in [`phase-9-hazards.md`](./phase-9-hazards.md) → Out of scope. The
  `HAZARD_MAX_SIZE_M` ceiling shipped in Phase 9 is the interim backstop.
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
- Forum/Facebook ingestion + AI comment-vs-report classification (Q8).
- GPS-path hazard *deduction* (Q11); auto-merge dedup + community confirmations (D36).
- AI report summarization beyond weather facts (Q9); full ToS/legal review (Q10).
- In-app guides; group-skate organizing; Fitbit as a GPS provider.
- Satellite imagery layer toggleable in lake detail view. **NOTE: This plan still needs to be explored**
- **Photo-orphan GC cron (cleanup/polish).** The Phase 2 photo pipeline uploads before
  `reports.create`, so failed/abandoned/partial submits can strand storage. The client reclaims
  best-effort (`photos.remove`/`removeBlob`, incl. uploads that resolve after the form unmounts), but
  a killed app or a failed reclaim call can still leave orphans. Add a scheduled sweep of unreferenced
  `photos` rows + orphaned storage blobs past a grace window as the durable backstop. See
  `phase-2-map-and-reports.md` → "Settled during review" (2026-07-15). Low urgency until storage
  quotas bite.

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
- **Account deletion + data export** wired as auth/profile matures (D33).
