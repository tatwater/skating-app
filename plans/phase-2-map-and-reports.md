# Phase 2 build plan — Map + reports (the MVP)

The concrete implementation plan for **Phase 2** of [`07-roadmap.md`](./07-roadmap.md). Design
rationale lives in the decisions log (D3, D4, D6, D9, D13, D14, D20, D22–D25, D30, D31, D36,
D41, D42, **D49**); this doc is the *how* — ordered workstreams, file-level changes, and the
test plan.

> **Goal.** Turn the read-only Phase 1 map into the usable MVP: a skater taps a real lake, reads
> its peer reports (newest **skate time** first), and **posts their own** — ice types, surface,
> quality, thickness, photos, conditions, visibility. Plus the one thing that makes the map usable
> at scale: **D49 zoom-scored display prominence**.
>
> **This is the usable MVP** — the "Done" line of the roadmap: *friends can post and read reports
> on real lakes.* The pilot region's OSM corpus (9,967 Vermont bodies, imported in Phase 1) covers
> the alpha crew's destinations, so **user-created water bodies are deferred to Phase 7** (see Scope)
> — the MVP reads and writes reports on the *canonical* corpus.

## Surface sequencing (decided 2026-07-13)

- **Web first, then mobile — as two separate PRs** (web = this plan's §A–§E; mobile = §F, a
  follow-on plan). Rationale: every Convex function the web MVP needs is exactly what mobile
  consumes, so **web-first front-loads the shared backend**; and we prove the entire data model
  online before taking on the native-build lift + the offline-capture complexity (D30), which is
  the single hardest piece in the phase and **mobile-only**.
- **No store/dev-account dependency blocks this.** Web ships on Vercel (no store, ever). The
  mobile map (`@rnmapbox/maps`, a native module) needs an **EAS dev build** — buildable now on
  iOS Simulator / Android with no accounts; putting it on the alpha crew's **physical iPhones**
  needs **Apple Developer enrollment** (start that now, in parallel — it has lead time). App
  Store / Play **submission + review** is fully deferred to post-MVP.

## Scope (decided)

**In scope (web PR):**
- **Interactive map** — extend the Phase 1 `WaterMap` with tap-to-select, selection highlight,
  and a wintery-but-functional style (D6/D34). Home/water framing on open via **device
  geolocation** (D12/D20).
- **D49 zoom-scored display prominence** — a derived `displayScore` (area + admin `curatedBoost`;
  **no popularity term yet**) → a bucketed `minVisibleZoom`, stored **and indexed as a geospatial
  filter key** so `listInViewport` filters `minVisibleZoom <= zoom` **inside the query** (not a
  post-fetch refine). This is the *real* fix for the Phase 1 soft-cap truncation stopgap: at wide
  zoom the query returns the *few prominent* bodies instead of an arbitrary read-capped slice, so a
  small-but-beloved lake (Lake Morey, via `curatedBoost`) is guaranteed to appear (see Workstream B).
- **Water-body detail** — name, area (imperial display), report feed sorted by skate time; report
  creation surfaced **in place** (D47), not a separate top-level route.
- **Reports (create + read, online)** — full ice description (ice types, surface tags, coarse
  quality, structured multi-reading thickness, snow cover), optional **manual** conditions,
  photos (client-optimized + EXIF-stripped, opt-in geotag), **derived-default visibility (clamped
  so a locked/minor author can't post `public`, D41)**, notes, skate time, and an optional
  **put-in pin** (`reports.point`; defaults to the body centroid) marking the access point the
  skater used. Metric storage / imperial display (D25).
- **Photos** — Convex file storage upload with **client-side optimize + EXIF strip** (D31/D42),
  including a **HEIC→JPEG decode step** so iPhone uploads work on desktop web; opt-in `placeOnMap`
  geotag pinning (coord retained *only* on opt-in).

**In scope (mobile PR, follow-on — §F):** native MapLibre map, the same tap→detail→report loop,
**offline draft queue** (D9/D30), device geolocation framing, `expo-image-manipulator` optimize.

**Explicitly OUT of Phase 2 (deferred, by decision):**
- **User-created water bodies (D14) + match-on-create dedup (D36)** → **Phase 7** (decided
  2026-07-13). Rationale: the good version is **GPS-path-backed** (derive bounds / verify the skater
  was on new water from a real Strava/Garmin/etc. track) rather than error-prone freehand polygon
  drawing — and GPS provider integrations don't exist until Phase 7 anyway. The pilot region's OSM
  corpus (9,967 Vermont bodies) covers the alpha crew's destinations, so nothing in the MVP needs
  it. Phase 2 therefore builds **no** `dedup.ts`, no `waterBodies.create` dedup, no
  `findMatchCandidates`, and no draw tool; `waterBodies.create` stays the existing v1 scaffold stub.
  Fully detailed in Phase 7 of `07-roadmap.md`.
- **Hazards** → Phase 8. Report-create leaves `hazardIdsCreated` empty; **no** in-polygon hazard
  drawing. *(Mind the seam: D4 ties reports to hazard geometry, so the report data path should
  leave room for it — but we build none of it now.)*
- **Weather auto-fill of `conditions`** → Phase 10 (Open-Meteo). Phase 2 stores `conditions` as
  optional **manual** entry (`source: 'user'`).
- **Moderator dedup review queue + merge** → Phase 4. With user-created bodies deferred (above),
  Phase 2 produces no new duplicates; the merge tooling still lands in Phase 4 for any canonical
  overlaps. Phase 2 *does* keep `get`'s `mergedIntoId` redirect so a link to a merged body already
  resolves to its survivor (forward-correct, cheap).
- **Popularity term in `displayScore`** → Phase 3+ (needs report/skate signal that doesn't exist
  until this phase lands).
- **Comments** → Phase 3. Report detail renders the report + photos only.
- **Follow graph / full visibility resolution** → Phase 3. Visibility is stored + filtered now
  (via `@skating/core`), but only **just_me / public** are meaningful (friends/followers resolve
  to author-only until follows exist). Correct-by-construction when Phase 3 lands.
- **Stored `homeCoord` / drive-time filtering** → Phase 5. Map framing uses **device geolocation**
  (D12), not a stored home.
- **Cross-water-body / near-me report queries + a `reports.point` geospatial index** → Phase 5/6
  (Newsfeed + drive-time). Phase 2 queries reports **by water body** off the existing DB index.

## Done criteria (web PR)

- Tapping a listed Vermont water body opens its detail (name, area, report feed by skate time).
- A signed-in user can **create a report** (with photos, EXIF-stripped, optional geotag) and see
  it appear in that body's feed, respecting its visibility.
- The map renders bodies by **zoom-scored prominence** (Lake Morey shows at state zoom; small
  clutter drops) — no read-cap truncation warnings in normal use.
- A deep link to a **merged** body resolves to its survivor; a link to a **removed/unavailable**
  body shows a clear "not available" state rather than a blank.
- OSM/basemap attribution still visible; light/dark/high-contrast honored; **tests green in CI,
  coverage does not regress** (untestable map/upload glue excluded from collection, per Phase 1's
  precedent).

---

## Workstreams (web PR — in dependency order)

### A. `@skating/core` additions (pure, tested first) — ✅ DONE (2026-07-13)
The logic both Convex and the apps need, kept framework-free and property-tested (D40). All land
before anything consumes them.

> **Shipped:** `display.ts` (`displayScore` + integer-bucket `minVisibleZoom`), `report.ts`
> (`validateReportInput` + normalization, incl. the D41 visibility-ceiling check), and
> `maxVisibilityForProfile` in `visibility.ts`. Also **relocated the shared report vocab** into
> `@skating/core` `types.ts` so the form + validator draw from one source: `THICKNESS_METHODS`,
> `SKY_CONDITIONS`, `PRECIP_TYPES`, `CONDITION_SOURCES` (were Convex-only in `lib/enums.ts`; the
> schema now imports them from core), plus the `orange_peel` surface tag. Core: 138 tests, 100%
> coverage; all packages typecheck.

- **`display.ts` (D49):**
  - `displayScore({ surfaceAreaSqM, curatedBoost? }): number` — `normalize(log(area)) +
    (curatedBoost ?? 0)`. Use **fixed log-area reference bounds** (tunable constants, e.g. ~100 m²
    → 0 … ~Champlain ~1.1e9 m² → 1) rather than corpus-relative normalization, so adding a region
    later never forces a re-score of every existing body.
  - `minVisibleZoom(score): number` — monotonic decreasing map from score → zoom (higher score ⇒
    draws at a *lower/wider* zoom), clamped to a **discoverability floor** (every listed body
    becomes visible by some detail zoom regardless of score — area guarantees a floor, D49) and a
    widest zoom for top-score bodies. **Returns an integer zoom bucket** (e.g. 5..14) so it can be
    stored and indexed as a geospatial filter key (Workstream B). Exact curve/constants tuned
    against the Vermont corpus during build.
  - **Tests:** monotonicity (bigger area ⇒ score up ⇒ minVisibleZoom down; `curatedBoost` raises
    prominence), floor/ceiling clamps, and a property that every body is visible by the floor zoom.

  *(`dedup.ts` moved to Phase 7 with user-created water bodies — see Scope.)*

- **`report.ts` (validation/normalization — D22–D25/D41):**
  - `validateReportInput(input, now): { ok: true; normalized } | { ok: false; errors }` — the
    shared server-and-client contract (re-enforced server-side per D37). Rules: `waterBodyId` +
    `skateTime` + `visibility` required; `skateTime` not implausibly future (small cushion; past
    is fine for offline, D9); each thickness reading is `valueCm` **XOR** (`minCm`+`maxCm`) with
    `min ≤ max`; `iceTypes`/`surfaceTags` from the enums; `snowCoverCm` ≥ 0. Observation-friendly
    (a "don't do it" report with only `notes` is valid, D3) — nothing about ice *quality* is
    required.
  - **Visibility clamp (D41, safety):** add a pure `maxVisibilityForProfile({ profilePublic })` (or
    equivalent) and enforce that a report's `visibility` never exceeds it — a **locked/minor author
    cannot select `public`** (clamp or reject). `deriveDefaultVisibility` only sets the *default*;
    this is the *ceiling*, and both client (offered options) and server (`reports.create`) enforce it.
  - Reuse existing `deriveDefaultVisibility` (visibility.ts), `canViewReport` (visibility.ts),
    unit formatters (units.ts), area helpers (units.ts / geometry.ts).
  - **Tests:** required-field + skate-time-future rejection; thickness value-XOR-range invariant
    (property test); a minimal "notes-only" report validates; **a locked/minor profile can't set
    `public`** (clamp/reject).

### B. Convex schema + geospatial
Minimal — the report/photo/comment tables already exist in full (Phase 0 schema). Only additive,
migration-free optional fields.
- **`waterBodies`:** add `displayScore?: number`, `curatedBoost?: number`, and the derived integer
  `minVisibleZoom?: number` (D49). Optional ⇒ no migration; computed on `importCanonical` /
  `create` / `setCuratedBoost`. Backfilled onto the existing Vermont corpus by re-running the
  chunked ETL loader (same path Phase 1 used for `isLarge`).
- **`lib/geospatial.ts` (changed — the D49 fix, decided 2026-07-13):** the geospatial index gains a
  **numeric `minVisibleZoom` filter dimension** alongside `listed`, so `listInViewport` filters
  `minVisibleZoom <= zoom` *inside* the query. This is what makes wide zooms return the *few
  prominent* bodies (Lake Morey guaranteed via `curatedBoost`) rather than an arbitrary read-capped
  slice — a post-fetch JS refine could not, because the read cap fills before the prominent body is
  reached. **Spike first:** confirm `@convex-dev/geospatial` supports a numeric **range** filter
  key; if it only does equality, fall back to (a) an equality set over discrete integer zoom buckets
  `minVisibleZoom in {…≤ zoom}`, or (b) a numeric **sort** by `displayScore` taking top-N. Reindex
  cost: writing `minVisibleZoom` is one geospatial re-insert per body (the ETL loader batches under
  the read cap; a full-corpus backfill paginates).
- **`reports`:** no schema change for web. *(An optional `idempotencyKey?` for the offline queue
  lands with the **mobile** PR, D30 — additive then.)* `reports.point` is already required in the
  schema; `create` fills it from the optional put-in pin, else the body centroid (Workstream C).
- **No `reports.point` geospatial index this phase** — report feeds query the existing
  `by_water_body_skate_time` DB index; near-me/cross-body geospatial is Phase 5/6.

### C. Convex functions + `convex-test`
- **`waterBodies.ts` additions:**
  - `get` (query) — single body detail (name, type, area, polygon, centroid); **follows
    `mergedIntoId` to the survivor** (a link to a merged duplicate resolves to the canonical body,
    transparently); returns a distinguishable "unavailable" signal (vs. plain not-found) for a
    removed/rejected body so the UI can message it. Excludes unlisted from public callers.
  - `setCuratedBoost` (mutation) — `requireRole('admin')`; set `curatedBoost`, recompute
    `displayScore` + `minVisibleZoom`, re-insert the geospatial key, write a `moderationActions` row.
  - `importCanonical` — also compute + store `displayScore` + `minVisibleZoom` (small addition, so
    imported bodies score immediately).
  - `listInViewport` — **replace the Phase-1 soft-cap truncation with zoom-based rendering (D49):**
    take the client `zoom` and filter `minVisibleZoom <= zoom` **as a geospatial filter key**
    (Workstream B), so wide zooms return few prominent bodies instead of a read-capped arbitrary
    slice. Keeps the two-tier viewport lookup + the read-cap backstop; the in-query zoom filter is
    what actually makes wide zooms legible instead of truncated (and guarantees the Morey criterion).

  *(`create` stays the existing v1 scaffold stub; dedup + `findMatchCandidates` moved to Phase 7.)*
- **`reports.ts` (new):**
  - `create` (mutation) — `requireProfile`; `validateReportInput` (server re-enforce, D37);
    `deriveDefaultVisibility` from the caller's profile if unset **and clamp to
    `maxVisibilityForProfile` (locked/minor ⇒ never `public`, D41)**; verify the water body exists /
    resolve `mergedIntoId`; set `point` from the optional put-in pin, else the body centroid;
    server-stamp `reportTime`; insert. Photos are uploaded + rowed first (see `photos.ts`) and
    passed as `photoIds`.
  - `listByWaterBody` (query) — reports for a body, `skateTime` desc, **visibility-filtered per
    viewer** via `canViewReport` (viewer relationship = self / none until Phase 3 — forward
    correct). Excludes `moderationStatus != visible`.
  - `get` (query) — single report, visibility-checked.
  - `update` (mutation) — author-only last-write-wins edit + `updatedAt` (D25).
- **`photos.ts` (new):**
  - `generateUploadUrl` (mutation) — auth'd Convex storage upload URL.
  - `create` (mutation) — record a `photos` row after the client uploads the optimized full +
    thumb (`storageId`, `thumbStorageId`, `uploaderId`, `caption?`, `takenAt?`, `coord?`,
    `placeOnMap`). **Enforce D42 server-side: drop `coord` unless `placeOnMap === true`.**
  - `getUrls` (query) — resolve serving URLs (full + thumb) for a set of photo ids.
- **Tests (`convex-test`):** report `create` validates + derives visibility, **clamps a
  locked/minor author away from `public`**, and defaults `point` to the body centroid when no
  put-in pin is given; `listByWaterBody` hides `just_me` from a non-author and shows `public`
  (property-ish over viewer relationship); photo `create` drops `coord` when `placeOnMap` is false;
  `waterBodies.get` **redirects a merged id to its survivor** and flags a removed body; a
  high-`minVisibleZoom` (low-prominence) body is absent at wide zoom while a boosted body appears;
  `setCuratedBoost` gates on `admin`, recomputes `minVisibleZoom`, + writes the audit row.

### D. Web UI — read + map (the loop, read side)
- **`WaterMap.tsx`:** add a click/tap handler → set MapLibre **feature-state** highlight on the
  tapped body → open its detail; pass `zoom` into `listInViewport`; render by the D49 zoom filter.
  Home/water framing on open via the **browser geolocation API** (D12/D20: on-water ⇒ fit to that
  body; else center on location; else fall back to the Vermont region), setting only the *initial*
  framing.
- **Water-body detail** — presented as an **in-place drawer / side panel** over the map (D47), but
  **URL-backed at `/water/$id`** so selection is deep-linkable (see "Settled during review"). Shows
  name, `formatAreaAcres`, the `listByWaterBody` feed, and a "Create report" affordance surfaced in
  place (D47) — not a separate top-level page. A `/water/$id` that `get` resolves through
  `mergedIntoId` **silently lands on the survivor** (bad/old link still ends at the right lake); a
  removed/unavailable body shows a friendly "this lake isn't available" state instead of a blank.
- **Report read** — likewise a drawer/panel, **URL-backed at `/report/$id`** (deep-linkable):
  render a report (all fields, imperial via units.ts), its photos (thumbs + full), author, skate
  time; photo **pins on the lake map** when `placeOnMap` (D42). *(Comments are Phase 3 — omitted.)*
- **Tests:** the pure `waterMap.ts`-style helpers stay unit-tested; component tests (Vitest +
  Testing Library) for detail rendering + imperial formatting; the imperative MapLibre shell stays
  excluded from coverage (Phase 1 precedent).

### E. Web UI — write (report creation)
- **Report create form** (in-place on Map/detail, D47): ice types (`ICE_TYPES` multi-select),
  surface tags (`SURFACE_TAGS`), coarse `skateQuality`, **multi-reading thickness** (add/remove;
  value XOR range; measured/estimated), snow cover, optional **manual** conditions, **photos**,
  visibility (default from `deriveDefaultVisibility`; **options offered are clamped to
  `maxVisibilityForProfile` — a locked/minor user is never shown `public`**, D41), notes, skate
  time (default now, editable to the past), and an optional **put-in pin** the skater drops on the
  map to mark the access point they used (sets `reports.point`; a nice future signal for guiding
  others to good access). Metric storage, imperial input/display (units.ts). Validates via
  `validateReportInput` before submit. The form is **ephemeral** (in-memory) on web — no persisted
  drafts; the offline draft queue is a mobile-only concern (§F, D30).
- **Photo pipeline (web, D31/D42):** on select → **if HEIC/HEIF, decode to a canvas-readable format
  first** (Chrome/Firefox can't decode HEIC in `<canvas>`; iPhones shoot HEIC by default) → read
  EXIF GPS/timestamp with **`exifr`** *before* stripping → downscale to ~2048px long edge + a ~400px
  thumb and **re-encode to strip all EXIF** (`browser-image-compression` / canvas) →
  `generateUploadUrl` → upload both → `photos.create`, passing `coord`/`takenAt` **only** when the
  user opts into `placeOnMap` / timestamp. New deps: **`exifr`**, **`browser-image-compression`**,
  **`heic2any`** (HEIC decode) — all to be installed when this workstream lands.
- **Tests:** report-form validation + visibility default (Testing Library); **a locked/minor
  profile is not offered `public`**; thickness add/remove + value-XOR-range UI; geotag opt-in
  toggles coord retention; put-in pin sets/clears `point`.

### F. Mobile (separate follow-on PR — outline only)
Built after web ships; reuses **all** of §A–§C unchanged.
- Install `@rnmapbox/maps` + an **EAS dev build** config (Expo dev client; native module can't run
  in Expo Go). Native MapLibre map on the Map tab consuming the same `listInViewport`; tap →
  detail; device geolocation framing (D12/D20).
- The report create/read loop, mirroring web but native (Tamagui).
- **Offline draft queue (D9/D30) — the hard part:** `expo-sqlite`/MMKV for draft reports +
  `expo-file-system` for captured photos; NetInfo/`expo-network` reconnect flush (upload photos →
  create mutation); each draft carries the `idempotencyKey` (adds the optional `reports` schema
  field then). `expo-image-manipulator` for the optimize + EXIF-strip pass.
- **Multiple concurrent drafts are a real case (not one-at-a-time):** a skater can hop **several
  lakes in a day with no signal**, capturing a report per lake, and they all sit in the queue until
  reconnect. So the queue is a **list** of independent drafts (each its own `idempotencyKey` +
  photo set), not a single slot — unlike web's ephemeral single form (§E). Reconnect flushes them
  all; a partial-failure flush must retry only the unsent ones (idempotency key prevents dupes).
- Prompt to submit pending drafts on reconnect (D12). Maestro E2E for the capture→sync flow later.

### G. Docs + hygiene
- README updates: `packages/convex` (reports/photos functions, displayScore/minVisibleZoom),
  `apps/web` (report flow, photo pipeline). Update `plans/README.md` index + the roadmap's Phase 2
  status when it lands.
- Confirm token/drift-guard tests still pass; keep OSM + "Powered by Strava" (N/A this phase) and
  ODbL attribution visible.

---

## Suggested PR breakdown

**Web (this plan) — one PR, clean sub-workstream commits** (Greptile reviews are metered, so one
PR; commits map to §A–§E):
1. **core:** `display.ts` (incl. bucketed `minVisibleZoom`) + `report.ts` validation & visibility
   clamp (+ tests). *(no infra)*
2. **convex:** `displayScore`/`curatedBoost`/`minVisibleZoom` schema + geospatial numeric filter key
   + `reports.ts` + `photos.ts` + `waterBodies` `get` (merged redirect)/`setCuratedBoost` +
   `listInViewport` in-query zoom filter (+ `convex-test`).
3. **web read:** map tap-to-detail + water-body detail (merged redirect / unavailable state) +
   report read + geolocation framing.
4. **web write:** report create form (put-in pin, visibility clamp) + photo pipeline (incl. HEIC).
5. **docs.**
   > *Optional split seam if the single PR gets too large for one review: read path (commits 1–3)
   > vs. write path (commit 4). Default is one PR unless it balloons.*
   >
   > *(User-created water bodies + dedup are no longer in this plan — deferred to Phase 7, GPS-backed.)*

**Mobile — a separate follow-on PR** (§F), with its own short build-plan doc once web is proven.

## Settled during review (2026-07-13)
- **URL-backed, deep-linkable selection (both surfaces).** Water-body selection and report views
  are presented as **drawers / side panels** in place (D47) — but their state lives in the **URL**
  (`/water/$id`, `/report/$id`), not just local component state, so a user can **deep-link a lake
  or a report to another skater off-platform** (email forums, texts). This applies to **mobile too**
  (expo-router deep links), not just web. Tapping a body/report pushes the route; closing the drawer
  pops back to `/` (Map). Deep-linking is a first-class requirement here, not a nicety — the
  community coordinates off-platform, so a shareable link to "this lake / this report" is core to
  the value loop.
  - **Auth-gated for now (decided 2026-07-13).** A shared link still passes through the existing
    AuthGate — the recipient signs in (then onboarding/age-gate/risk-ack) before landing on the
    target. Acceptable for a friends alpha (everyone has an account). **Mitigation:** set Clerk's
    session lifetime very long (multi-month) so existing users effectively never hit a sign-in wall
    from a shared link — a config task, tracked in §G/roadmap. **Fast-follow (post-MVP):** let
    `public`-visibility bodies/reports render for **signed-out** viewers, gating only with a blocking
    risk-ack modal. Not in Phase 2.

- **Prominence lives in the query, not a post-fetch refine (D49, decided 2026-07-13).** `minVisibleZoom`
  is a bucketed integer stored on `waterBodies` and indexed as a geospatial **filter key**, so
  `listInViewport` filters `minVisibleZoom <= zoom` inside the query. A post-fetch JS filter (the
  original sketch) *cannot* satisfy the "Lake Morey at state zoom" criterion: the read cap fills with
  an arbitrary slice before a small-but-boosted body is reached. See Workstream B (incl. the spike +
  fallbacks if the component lacks numeric range filters).

- **Minor/locked visibility is clamped, not just defaulted (D41, decided 2026-07-13).** `@skating/core`
  gains a `maxVisibilityForProfile` ceiling; the report form only offers allowed levels and
  `reports.create` re-enforces it server-side, so a locked/minor author can never post `public` even
  by editing the field. `deriveDefaultVisibility` remains the *default* only.

- **Put-in pin (decided 2026-07-13).** The report form lets the skater optionally drop a pin marking
  the **access point** they used; it sets the required `reports.point` (default: body centroid). Named
  access points / put-ins are a nice future first-class concept — for now the data rides on `point`.

- **User-created water bodies deferred to Phase 7 (decided 2026-07-13).** Cut from Phase 2 entirely;
  the good version is GPS-path-backed and GPS integrations are Phase 7. See Scope + `07-roadmap.md`.

- **HEIC on web supported (decided 2026-07-13).** The photo pipeline decodes HEIC/HEIF before the
  canvas optimize/strip pass (via `heic2any`), so iPhone photos upload from desktop browsers.

- **Web report form is ephemeral; drafts are mobile-only.** No persisted web drafts (submit or lose,
  sidestepping orphan photos). The offline draft queue (§F) is the real draft feature and must hold
  **multiple** concurrent drafts (a day of offline lake-hopping), not one.

## Open items to settle during the build (small)
- **`displayScore` curve constants** — start with fixed log-area bounds + a linear score→zoom map;
  eyeball Champlain, Morey, and a small pond across z6–z14 and adjust the floor/span.
  **→ Phase 4:** these constants must get **admin-UI modification controls** in the operator
  surface (D37) — they should be tunable through the UI, **never buried as code constants** a
  non-engineer can't reach. Phase 2 ships them as tuned constants; Phase 4 lifts them behind admin
  controls.
- **`curatedBoost` seeding** — which known Vermont destinations get a manual boost at launch. **A
  data-derived VT seed already exists:** `training_data/google_group/curated_boost_seed_vt.csv`
  (from 1,197 real community posts — Champlain, Malletts Bay, Lake Morey, Button Bay, Colchester/
  Shelburne Pond, Burlington Bay, Lake Iroquois…). **Before using it, intersect with the bodies
  actually in the VT OSM import** — the seed's region tag is "which community discusses it," so it
  includes NY/NH lakes VT skaters frequent (Lake George, Dillenbeck Bay) that won't exist in a
  VT-only import. Apply via a tiny admin action or one-off internal mutation.
  **→ Phase 4:** per-body `curatedBoost` must be **editable from the admin water-body surface**
  (set/adjust the boost on any body through the UI), not only via a seed script — same "don't bury
  it in code" principle as the score constants above.
- **Geospatial numeric-filter spike** — before wiring Workstream B, confirm `@convex-dev/geospatial`
  supports a numeric **range** filter key for `minVisibleZoom <= zoom`; pick the fallback (integer
  bucket equality-set, or `displayScore` sort) if not.

## Risks / watch-outs
- **Report-form surface area is large** — the ice/surface/thickness/conditions vocab is real
  (D22/D23). Push all validation into `@skating/core` (§A) so both apps + Convex share one
  contract and the UI is thin.
  - **Enum reconciliation — DONE (2026-07-13, §A):** per the community corpus (see `06-data-model.md`
    "Corpus validation"), `SURFACE_TAGS` **added `orange_peel`** (49 occ) and **kept the superset**
    — `windswept`/`frozen_chop` retained despite near-zero usage (founder call: don't strip meaningful
    terms). `glare_ice` rejected (= `black_ice` + `glass`); `resurfaced` held. `ICE_TYPES` unchanged.
- **EXIF must be stripped by construction (D42)** — the *only* metadata that may survive is
  timestamp + GPS, and GPS *only* on `placeOnMap`. Enforce on **both** client (strip) and server
  (`photos.create` drops `coord`) so a client bug can't leak location.
- **Visibility is forward-loaded** — friends/followers resolve to author-only now; make sure the
  filter uses `@skating/core` `canViewReport` so Phase 3's follow graph flips it on with no report
  re-write, and **no feature silently widens exposure** (D41).
- **`listInViewport` read-cap** — the D49 **in-query** `minVisibleZoom` filter is the real fix (wide
  zooms return few prominent bodies, so the cap isn't hit in normal use), but keep the Phase 1
  read-cap safety (limit, `isListed` JS refine, truncation `log`) as a backstop. Watch the filter
  interaction: the read-cap note warned that a filter-stream *intersection* lowers the safe
  `maxResults` ceiling — validate the `minVisibleZoom` filter against the 9,967-body corpus during
  the spike so it doesn't reintroduce the wide-zoom crash it's meant to prevent.
- **Hazard seam (Phase 8)** — don't paint the report data path into a corner that makes in-polygon
  hazard geometry hard to add later; `hazardIdsCreated` already exists in the schema, leave it be.
