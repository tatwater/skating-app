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

### B. Convex schema + geospatial — ✅ DONE (2026-07-13)
Minimal — the report/photo/comment tables already exist in full (Phase 0 schema). Only additive,
migration-free optional fields.

> **Shipped:** `displayScore`/`curatedBoost`/`minVisibleZoom` on `waterBodies`; `minVisibleZoom`
> wired as the geospatial **`sortKey`** across every insert (import/create/approve/remove/restore/
> backfill/setCuratedBoost). Confirmed the sortKey range filter works in `convex-test`.
- **`waterBodies`:** add `displayScore?: number`, `curatedBoost?: number`, and the derived integer
  `minVisibleZoom?: number` (D49). Optional ⇒ no migration; computed on `importCanonical` /
  `create` / `setCuratedBoost`. Backfilled onto the existing Vermont corpus by re-running the
  chunked ETL loader (same path Phase 1 used for `isLarge`).
- **`lib/geospatial.ts` (changed — the D49 fix; spike confirmed 2026-07-13):** store the integer
  **`minVisibleZoom` as the geospatial entry's `sortKey`** (the 5th `insert` arg — Phase 1 parks
  `createdAt` there, which nothing reads). `listInViewport` filters `q.lt('sortKey', zoom + 1)`
  (i.e. `minVisibleZoom <= zoom`) *inside* the query, so wide zooms return only the *few prominent*
  bodies (Lake Morey guaranteed via `curatedBoost`) rather than an arbitrary read-capped slice — a
  post-fetch JS refine could not, because the read cap fills before the prominent body is reached.
  **Confirmed:** `@convex-dev/geospatial@0.2.1` exposes `sortKey` with `.gte`/`.lt` range filters,
  and results order by `sortKey` — so a capped query keeps the *most prominent* bodies, not an
  arbitrary slice. `listed` stays a boolean `filterKey` (still refined in JS per the Phase 1
  read-cap note, not passed to the query). Reindex cost: writing `minVisibleZoom` is one geospatial
  re-insert per body (the ETL loader batches under the read cap; a full-corpus backfill paginates).
- **`reports`:** no schema change for web. *(An optional `idempotencyKey?` for the offline queue
  lands with the **mobile** PR, D30 — additive then.)* `reports.point` is already required in the
  schema; `create` fills it from the optional put-in pin, else the body centroid (Workstream C).
- **No `reports.point` geospatial index this phase** — report feeds query the existing
  `by_water_body_skate_time` DB index; near-me/cross-body geospatial is Phase 5/6.

### C. Convex functions + `convex-test` — ✅ DONE (2026-07-13)

> **Shipped:** `waterBodies` `get` (merged→survivor redirect + unavailable signal) + `setCuratedBoost`
> + `importCanonical`/`listInViewport` D49 wiring; `reports.ts` (`create`/`listByWaterBody`/`get`/
> `update`) with the server-side visibility clamp + put-in-pin/centroid + merged-target resolution +
> photo-ownership check; `photos.ts` (`generateUploadUrl`/`create` with the D42 coord gate/`getUrls`
> with null-URL guard). `convex-test`: all convex source at 100% coverage.

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

### D. Web UI — read + map (the loop, read side) — ✅ DONE (2026-07-13)

> **Shipped:** interactive `MapView` (tap→`/water/$id`, feature-state highlight, zoom passed into
> `listInViewport` for the D49 filter, browser-geolocation framing, drawer-driven fly-to + report
> photo pins), kept mounted across a pathless `_map` layout with `/`, `/water/$id`, `/report/$id`
> children so pan/zoom survive opening a drawer. Selection is **URL-backed + deep-linkable**;
> water-body detail (merged→survivor silent redirect, not-found vs. removed states, imperial area,
> report feed) and report detail (all fields imperial via a pure `reportDisplay`, photos, author,
> back-link, `placeOnMap` pins) render in a shadcn **Sheet** drawer. Read-side needed a small
> additive `profiles.publicByIds` query for author attribution (+ test). Pure helpers
> (`reportDisplay`, `mapSelection`, `waterMap` additions) unit-tested at 100%; a `ReportView`
> component test covers imperial rendering; MapLibre shell excluded from coverage.
>
> **shadcn/ui (Base UI) adopted (2026-07-13).** Initialized shadcn on the **Base UI** variant
> (`@base-ui/react`, `base-nova` style) — `components.json`, a `@`→`src` alias (tsconfig + Vite +
> Vitest), and parity-safe token aliases in `app.css` mapping shadcn roles onto the `@skating/design`
> tokens (var-references, so the hex-parity guard is unaffected). Added `sheet`/`card`/`badge`/
> `skeleton`/`separator`/`checkbox`; **full pass** migrated hand-rolled UI to shadcn primitives
> (`Panel`/`AuthCard`/settings/crash-fallback → `Card`, `RiskAckConsent` → `Checkbox`, `Button`
> regenerated). `pnpm build` green.

- **`MapView.tsx` (was `WaterMap.tsx`):** add a click/tap handler → set MapLibre **feature-state** highlight on the
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

### E. Web UI — write (report creation) — ✅ DONE (2026-07-13)

> **Shipped:** `ReportForm` (a shadcn **Dialog** opened from the water-body drawer, D47) —
> split into a presentational, Convex-free `ReportFormFields` (fully testable) + a container that
> wires the profile-derived/clamped visibility (D41), the photo pipeline, and the map put-in pin.
> All ice/surface/quality/sky/precip/method/visibility pickers ride the shadcn (Base UI)
> `ToggleGroup` (multi + single-element patterns; no `Select`); multi-reading thickness add/remove
> with a value⇄range toggle; imperial input → metric storage (D25) via a pure `lib/reportForm.ts`
> (`buildReportInput`, `visibilityOptions`, datetime-local round-trip) validated by
> `validateReportInput` before submit. **Photo pipeline** (`components/photoPipeline.ts`, browser-only
> glue): HEIC→JPEG decode (`heic2any`), EXIF GPS/timestamp read (`exifr`) *before* a downscale +
> EXIF-strip re-encode (`browser-image-compression`) → Convex storage upload → `photos.create`, with
> `coord` sent only on the per-photo `placeOnMap` opt-in (`lib/photo.ts` `photoUploadCoord`, D42).
> **Put-in pin:** the drawer went **non-modal** (`Sheet showOverlay={false}` + `modal={false}`) so the
> map stays tappable; "Set access point" arms `pinDropMode` in `MapSelectionContext`, the next map tap
> sets `putInPin` (green marker), and the Dialog stays mounted (state preserved) while hidden during
> the drop. New deps: `exifr`, `browser-image-compression`, `heic2any`. Pure libs 100%; a
> `ReportFormFields` component test covers the visibility clamp, thickness add/remove/XOR, put-in
> pin, and the photo geotag opt-in. `pnpm build` green.

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

### F. Mobile (separate follow-on PR(s)) — split into F1 (online) + F2 (offline queue), decided 2026-07-13
Built after web ships; reuses **all** of §A–§C unchanged. **Split into two PRs** (decided 2026-07-13):
the online loop lands and gets proven first, then the offline queue (the single hardest, mobile-only
piece) lands on its own so its review is scoped (Greptile reviews are metered).

**Shared prep (lands with F1):** lift the three pure web helpers out of `apps/web/src/lib` into
`@skating/core` so both apps draw from one source (they were web-local by accident of build order):
`reportDisplay` (`humanizeEnum`, the enum→label maps, imperial formatters), `reportForm`
(`buildReportInput`, `visibilityOptions`, thickness form state) and `photo` (`photoUploadCoord`). The
web-only glue stays in web: the datetime-**local** `<input>` round-trip and the browser photo pipeline
(`heic2any`/`exifr`/`browser-image-compression`) — neither applies on native.

#### F1 — native map + read + **online** report write
- **Map lib = `@maplibre/maplibre-react-native`** (decided 2026-07-13; **not** `@rnmapbox/maps`).
  Rationale: parity with web — it consumes the same MapLibre **style spec**, the same `pmtiles://`
  protocol, and the same `@protomaps/basemaps` flavors, so `waterMap.ts`'s `buildMapStyle`/palette
  reuse nearly verbatim, and there's **no Mapbox token** dependency. Needs an **EAS dev build** (native
  module can't run in Expo Go) — buildable now on the Android emulator / iOS Simulator with no accounts.
- Native map on the Map tab consuming the same `listInViewport` (viewport bbox + `zoom` → the D49
  in-query prominence filter); tap a body → its detail; **device geolocation framing** (D12/D20) via
  `expo-location` (in-region fix recenters, else the Vermont default) — the pure `frameForCoord` from
  `waterMap.ts` decides "in region?".
- **Detail UX mirrors web (decided 2026-07-13):** one **persistent map** with `@gorhom/bottom-sheet`
  drawers over it and a ported `MapSelectionContext`, so (a) the **put-in pin** works (map stays
  tappable while the report form drawer is open) and (b) selection is **URL-backed + deep-linkable**
  at `/water/$id` `/report/$id` (expo-router deep links) — not full pushed screens. Tamagui for the
  drawer content (D7: share tokens, not UI).
- The report create/read loop, mirroring web §D/§E but native (Tamagui): water-body detail (merged→
  survivor redirect, unavailable state, imperial area, feed by skate time), report detail (all fields
  imperial, photos, author, `placeOnMap` pins), and the create form (ice/surface/quality/thickness/
  conditions/visibility-clamped/notes/skate-time/put-in-pin) validated by `validateReportInput`.
- **Photo pipeline (native — simpler than web):** `expo-image-picker` with `exif: true` returns GPS
  directly (no `exifr`), and `expo-image-manipulator` resizes + **re-encodes to strip EXIF** and reads
  HEIC natively (no `heic2any`/`browser-image-compression`). D42 invariant unchanged: coord leaves the
  device only on the per-photo `placeOnMap` opt-in, and `photos.create` re-drops it server-side.
- **Verify on the Android emulator** (`Pixel_6_Android_15`) as the primary target (user's first device
  is a Pixel); iOS Simulator secondary.

#### F2 — offline draft queue (D9/D30) — the hard part (separate follow-on PR)
- **Storage (decided 2026-07-13): `expo-sqlite`** for the draft records (relational — a **list** of
  independent drafts, each its own `idempotencyKey` + captured-photo file paths + report fields —
  models cleanly and survives restarts) + **`expo-file-system`** for the captured photo files +
  **`@react-native-community/netinfo`** for reconnect detection. (MMKV/`expo-network` considered;
  sqlite chosen for the relational draft-list shape.)
- Reconnect flush (upload photos → `create` mutation); each draft carries an `idempotencyKey` — this
  is when the optional `reports.idempotencyKey?` schema field lands (additive, D30) and `reports.create`
  becomes idempotent on it.
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

### H. Regional expansion (post-MVP — Phase 2.5, its own PR) — decided 2026-07-14
Runs **after the mobile MVP (F1 + F2)** and before Phase 3 (see roadmap "Phase 2.5"). Pure data +
infra — no app features — so it's a separate PR. Widens the pilot's **single-state Vermont** corpus +
basemap to the Northeast lake-skating states. **Nothing here changes until the mobile online loop
ships**; and the map-bounds widening is the *last* step (after the data lands), never before.

- **Region scope (decided 2026-07-14): NY (upstate/northern only — exclude NYC + Long Island), VT,
  NH, ME, MA.** Explicitly **not** Geofabrik's `us/northeast` dump — it bundles NJ/PA/CT/RI, and we
  want nothing south or west of NY (no lake-skating culture → clutter + storage cost). So pull
  **per-state Geofabrik extracts** (`us/new-york`, `us/vermont`, `us/new-hampshire`, `us/maine`,
  `us/massachusetts`) and process each; **clip the NY extract by bbox** to drop the NYC/Long Island
  metro (roughly keep lat ≳ 41.3, and trim the SE corner) so downstate lakes never import.
- **Water data (`scripts/etl`):** re-run the Phase 1 pipeline per state → `importCanonical` (each body
  D49-scored on insert; the loader paginates under the read cap). Record each extract's download date +
  md5 (per the ETL README). Corpus grows well past VT's ~9,970 bodies.
- **Basemap tiles → Cloudflare R2 (decided 2026-07-14 — see "Settled").** Build one multi-state
  `.pmtiles` via `pmtiles extract --bbox <5-state bbox minus downstate NY> --maxzoom=14` from a current
  Protomaps planet build (the demo `v4.pmtiles` source in `scripts/basemap` is dead — use a live
  `build.protomaps.com/<date>.pmtiles`). It far exceeds VT's ~280 MB and **overflows Convex free
  storage**, so host on **R2**; migrate the VT tiles there too. `scripts/basemap/upload.sh` gains an R2
  target (or a sibling script); the app is untouched — just repoint `VITE_PMTILES_URL` /
  `EXPO_PUBLIC_PMTILES_URL` per environment.
- **Map bounds + framing (LAST):** widen `VERMONT_MAX_BOUNDS` + `INITIAL_CENTER` + `frameForCoord`'s
  in-region gate in **both** `apps/web/src/lib/waterMap.ts` and `apps/mobile/src/lib/waterMap.ts`
  (kept in sync with each other **and** the tile-extract bbox), plus the `--bbox` in `scripts/basemap`.
  Do this only once the water data is imported, so no pan area is ever empty of data.
- **`curatedBoost` re-seed:** the existing VT seed (`training_data/google_group/curated_boost_seed_vt.csv`)
  already lists NY/NH destinations (Lake George, Dillenbeck Bay, …) that were skipped for not being in
  the VT-only import — apply them once those states land.
- **Tests/hygiene:** ETL transform tests stay green; the widened bounds update `waterMap.test.ts` in
  both apps; ODbL attribution unchanged.

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

**Mobile — two separate follow-on PRs** (§F, decided 2026-07-13), each with its own short build-plan
doc once web is proven:
1. **F1 — mobile online loop:** lift the shared `reportDisplay`/`reportForm`/`photo` helpers into
   `@skating/core` (+ refactor web onto them); `@maplibre/maplibre-react-native` map + tap→detail;
   bottom-sheet drawers + `MapSelectionContext`; report read + **online** create (native photo
   pipeline via `expo-image-picker`/`expo-image-manipulator`); geolocation framing.
2. **F2 — mobile offline draft queue:** `expo-sqlite` draft list + `expo-file-system` photos +
   NetInfo reconnect flush; additive `reports.idempotencyKey?` + idempotent `reports.create`.

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

- **Photo-orphan cleanup is client-side + best-effort; a server-side GC is deferred (2026-07-15).**
  The report form uploads photos before `reports.create`, so a failed create, an abandoned form, or a
  partial upload (one of the full/thumb pair lands, the other fails) can strand storage server-side.
  Both surfaces now reclaim best-effort: each upload records its `storageId` the instant it lands, so
  a retry reuses it; on form-close / photo-remove / unmount-without-submit the client deletes any
  created row (`photos.remove` → row + blobs) **and** any bare uploaded-but-unrowed blob
  (`photos.removeBlob`, auth-gated + idempotent). Uploads (or row-creates) still *in flight* when the
  form unmounts also self-reclaim: a `disposedRef` flips at teardown, so a result arriving after the
  sweep deletes itself instead of writing to dead state (`photos.remove` tolerates an already-deleted
  blob, so the overlapping reclaim paths compose without stranding a row). **Residual (hard-failure
  only):** if the app is killed mid-flight, or a reclaim call itself fails (network), a blob/row can
  still be stranded. A **server-side GC cron** (sweep `photos` rows unreferenced by any report, and
  storage blobs with no `photos` row, older than a grace window) is the durable backstop —
  **deferred to a future cleanup/polish phase**; tracked in `07-roadmap.md` → "Later / deferred".
  Low urgency at alpha scale, but it should land before storage cost/quotas matter.

- **Regional expansion = Phase 2.5, Northeast skating states only (decided 2026-07-14).** After the
  mobile MVP (F1+F2), before Phase 3, expand the VT-only corpus + basemap to **NY (excl. NYC/Long
  Island), VT, NH, ME, MA** — via **per-state** Geofabrik extracts (not the `us/northeast` dump, which
  drags in NJ/PA/CT/RI we don't want) with NY bbox-clipped downstate. See Workstream H + roadmap
  "Phase 2.5". Map-bounds widening happens **last**, after the water data lands.

- **Basemap tiles move to Cloudflare R2 (decided 2026-07-14).** The 5-state `.pmtiles` extract
  overflows Convex's free storage tier, so tiles host on **R2** (zero egress, standard pmtiles host —
  the Phase 1-flagged off-ramp); the VT tiles migrate too. The app already reads the tile URL from
  `VITE_PMTILES_URL` / `EXPO_PUBLIC_PMTILES_URL`, so this is a hosting + env swap, **no app change**.
  (Operationally yours: create the R2 bucket + public base URL; `scripts/basemap` gains an R2 upload
  target.) **Related fix (2026-07-14):** the old Protomaps demo `.pmtiles` default 404'd (they prune
  dated builds) — both apps' `DEMO_PMTILES_URL` now points at a live build, but the demo is dev-only;
  production must set `*_PMTILES_URL`. Mobile's `.env.example` now documents `EXPO_PUBLIC_PMTILES_URL`
  (the missing-var gap that caused the 404).

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
- **Geospatial numeric-filter spike — DONE (2026-07-13):** `@convex-dev/geospatial@0.2.1` supports a
  numeric `sortKey` range (`.gte`/`.lt`). Approach locked: `minVisibleZoom` = `sortKey`;
  `listInViewport` filters `q.lt('sortKey', zoom + 1)`. Validate the result counts against the
  9,967-body corpus during implementation (the filter should shrink wide-zoom reads, not grow them).

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
