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

## Phase 3 — Comments + profiles + user-facing safety tools
*(Was "Social graph + comments" — the **social graph was removed 2026-07-15 (D13)**. No
follows/friends. What remains is the community-interaction + safety layer, kept ahead of
the feeds so **blocks** are enforced before the Newsfeed filters on them.)*
- Threaded **comments** on reports (D21/D25). All reports are public (D13), so comments are too —
  gated only by moderation + blocks.
- **Profiles (D13):** public profiles are **searchable by name** and show name, photo, town/state,
  **bio**, #reports/#comments, trust score (D50), and full public report history; **private profiles
  are name + photo only** and not searchable (all minors; adults who opt in). No follow/friend graph.
- **User-facing safety tools (D32):** **block/mute** users; **flag/report** reports/comments/
  photos/users for abuse (incl. `unsafe_false_report`). Public UGC without block/flag is
  unacceptable, so these ship here. With no follow graph, a block is pure "hide this person."
- A minimal moderator **hide/remove** path (founder) so flagged content can be taken
  down immediately, even before the full operator surface (Phase 7).
- Report reads are trivial now — **moderation-visible + not-blocked**; there is no per-report
  visibility to resolve (D13).
- **Done:** comment threads work; profiles are viewable/searchable (privacy respected);
  users can block/mute and flag; content can be quickly taken down.

## Phase 4 — Drive-time filtering
- Isochrone from home (**hosted ORS**), cached per user (D18/D35); radius fallback.
- Filter map + feeds to the user's range.
- **Favorite water bodies (subscribe to *places*, not people).** Let a user mark specific bodies
  as **favorites** — a manual, per-body opt-in that complements drive-time as a *second axis* for
  scoping the **Newsfeed** (Phase 5) and **notifications** (D16): a favorited lake's reports/events
  surface **even when it's outside drive-time range**, and notification prefs can target "my
  favorites." This is the **place-based** curation axis — the deliberate analog to the removed
  people-follow graph (D13): you subscribe to *lakes you care about*, not to *individuals*. Likely
  a small `waterBodyFavorites` join (userId × waterBodyId); ties into the notification prefs (D16)
  and the Phase 5 feed. *(Could ship earlier if wanted — no ORS dependency; parked here as the
  natural home alongside the other feed-scoping controls.)*
- **Done:** map/feed show only in-range water bodies/reports (plus any favorited bodies).
- Needs: OpenRouteService key.

## Phase 5 — Newsfeed page
- Cross-water-body feed within range, newest **skate time** first (D28), showing
  **`public`** reports minus **blocks** (D13) — the block filter lands in Phase 3, so the
  feed is correct once that ships.
- **Temporarily expand radius** (session-only) to browse wider.
- **Done:** browse recent community activity without going lake-by-lake.

## Phase 6 — Bounties + trust score
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
- **Done:** end-to-end bounty loop; reporters accrue a public, boost-only trust score from
  corroboration + helpful marks.

## Phase 7 — Operator surface (admin, moderation, dedup review)
*(The founder-facing back office — the second half of the old combined phase.)*
- **Admin/moderator surface (D37):** a role-gated **`/admin` route tree in the web app**
  (not a separate app), organized as **work queues** — flag queue (with
  `unsafe_false_report` in a **priority lane** per D3), user admin (search/history,
  **ban/suspend/unban**, grant role), and a **support inbox** (`supportTickets`, D35 —
  not Zendesk). Role model expands to `member | moderator | admin` (admin ⊇ moderator).
- **Water-body dedup review queue (D36):** moderator view of `suspected_duplicate`
  bodies with a manual **merge** (re-point children → survivor, soft-tombstone loser),
  plus **approve/reject** of user-drawn bodies (`reviewStatus`, D37).
- **Display-tuning controls (D49):** admin UI to edit the `displayScore` curve constants
  (log-area bounds + score→zoom map) and to set/adjust per-body **`curatedBoost`** from the
  water-body surface. Phase 2 ships these as tuned constants + a seed; Phase 7 lifts them
  behind admin controls so they're **never buried in code** a non-engineer can't reach.
- Every admin mutation gates on `role` server-side and writes a **`moderationActions`**
  audit row.
- **Operator alerts (D38):** Resend + React Email — email the founder on new
  `supportTickets` and safety-priority items, deep-linking into `/admin`.
- **Done:** operators can ban/unban users, approve/reject user-drawn water bodies, and
  triage flags + support from `/admin`, with every action audited and safety items
  alerted by email.
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
- Needs: provider approvals/keys (all applied for in Phase 0).

## Phase 9 — Hazards
- Draw hazards (point/line/area) within a water body; typed vocabulary.
- Lifecycle (fresh/aging/stale) + "still there / gone" confirmations, triggered
  opportunistically (app-open nearby, report flow, post-hoc GPS path) (D12/D15).
- **Done:** hazards appear, age, and can be confirmed/cleared.
- **Offline hazard capture — inherited from Phase 2 F2 (decided 2026-07-15).** Hazards are drawn
  **on the ice, often offline**, so Phase 9 reuses the Phase 2 F2 offline substrate:
  - **The offline body-reference cache** (F2 "Layer 2" — `@skating/core` buffered
    `pointInPolygon` auto-select + an on-device LRU cache of recently-viewed body polygons)
    is built in F2 as a **standalone, reusable module** *specifically so hazard capture reuses
    it* — GPS + cached polygon tells the offline app which lake the skater is on without a
    network round-trip.
  - **Offline basemap tiles (F2 "Layer 3") were deferred here from Phase 2 F2 (decided
    2026-07-15).** F2's report capture needs only *which lake* (the body cache) + GPS, so it
    ships with **no offline basemap** and degrades the put-in pin to "drop at my current GPS
    location." **Hazards are different:** dropping an *accurate* hazard pin wants a **legible
    offline basemap + the lake polygon as visual reference**, so the offline tile-pack work
    (store per-region tiles on device — a real native spike: does `@maplibre/maplibre-react-native`'s
    offline-pack API work over our `pmtiles://` range source, or do we ship an on-device
    mini-`.pmtiles`?) lands **here**, not in F2. The F2 body-cache module is designed to accept
    a tile-pack field so this slots in without a rearchitecture.
  - The buffered auto-select (a tunable ~parking/approach radius so opening from the car still
    resolves the lake) is the same primitive hazard capture uses to bind a hazard to its body.

## Phase 10 — Weather-since strips
- Open-Meteo "what the weather has done since this report" factual strip (D19).
- **Done:** aging reports show peak temp / hours above freezing / sun / precip / wind.

## Later / deferred (see 02-open-questions)
- Forum/Facebook ingestion + AI comment-vs-report classification (Q8).
- Strava-path hazard *deduction* (Q11); auto-merge dedup + community confirmations (D36).
- AI report summarization beyond weather facts (Q9); full ToS/legal review (Q10).
- In-app guides; group-skate organizing; Fitbit as a GPS provider.
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
