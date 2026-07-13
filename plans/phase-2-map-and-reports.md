# Phase 2 build plan — Map + reports (the MVP)

The concrete implementation plan for **Phase 2** of [`07-roadmap.md`](./07-roadmap.md). Design
rationale lives in the decisions log (D3, D4, D6, D9, D13, D14, D20, D22–D25, D30, D31, D36,
D41, D42, **D49**); this doc is the *how* — ordered workstreams, file-level changes, and the
test plan.

> **Goal.** Turn the read-only Phase 1 map into the usable MVP: a skater taps a real lake, reads
> its peer reports (newest **skate time** first), and **posts their own** — ice types, surface,
> quality, thickness, photos, conditions, visibility. Plus the two things that make the map
> usable at scale and the corpus complete: **D49 zoom-scored display prominence** and
> **user-created water bodies** with match-on-create dedup (D36).
>
> **This is the usable MVP** — the "Done" line of the roadmap: *friends can post and read reports
> on real lakes.*

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
  **no popularity term yet**) → `minVisibleZoom`; `listInViewport` renders by zoom. This is the
  *real* fix for the Phase 1 soft-cap truncation stopgap.
- **Water-body detail** — name, area (imperial display), report feed sorted by skate time; report
  creation surfaced **in place** (D47), not a separate top-level route.
- **Reports (create + read, online)** — full ice description (ice types, surface tags, coarse
  quality, structured multi-reading thickness, snow cover), optional **manual** conditions,
  photos (client-optimized + EXIF-stripped, opt-in geotag), derived-default visibility, notes,
  skate time. Metric storage / imperial display (D25).
- **Photos** — Convex file storage upload with **client-side optimize + EXIF strip** (D31/D42);
  opt-in `placeOnMap` geotag pinning (coord retained *only* on opt-in).
- **User-created water bodies** (D14) with **match-on-create dedup** (D36): steer onto a nearby
  existing body (bbox → IoU / point-in-polygon + name similarity) before creating new.

**In scope (mobile PR, follow-on — §F):** native MapLibre map, the same tap→detail→report loop,
**offline draft queue** (D9/D30), device geolocation framing, `expo-image-manipulator` optimize.

**Explicitly OUT of Phase 2 (deferred, by decision):**
- **Hazards** → Phase 8. Report-create leaves `hazardIdsCreated` empty; **no** in-polygon hazard
  drawing. *(Mind the seam: D4 ties reports to hazard geometry, so the report data path should
  leave room for it — but we build none of it now.)*
- **Weather auto-fill of `conditions`** → Phase 10 (Open-Meteo). Phase 2 stores `conditions` as
  optional **manual** entry (`source: 'user'`).
- **Moderator dedup review queue + merge** → Phase 4. Phase 2 only does match-on-create *steering*
  + stamps `dedupStatus` / `duplicateCandidateIds`; auto-visible (review-after, D37).
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
- A user can **create a water body** where OSM has none, and the flow **steers them onto a nearby
  existing body** when one matches (dedup).
- OSM/basemap attribution still visible; light/dark/high-contrast honored; **tests green in CI,
  coverage does not regress** (untestable map/upload glue excluded from collection, per Phase 1's
  precedent).

---

## Workstreams (web PR — in dependency order)

### A. `@skating/core` additions (pure, tested first)
The logic both Convex and the apps need, kept framework-free and property-tested (D40). All land
before anything consumes them.

- **`display.ts` (D49):**
  - `displayScore({ surfaceAreaSqM, curatedBoost? }): number` — `normalize(log(area)) +
    (curatedBoost ?? 0)`. Use **fixed log-area reference bounds** (tunable constants, e.g. ~100 m²
    → 0 … ~Champlain ~1.1e9 m² → 1) rather than corpus-relative normalization, so adding a region
    later never forces a re-score of every existing body.
  - `minVisibleZoom(score): number` — monotonic decreasing map from score → zoom (higher score ⇒
    draws at a *lower/wider* zoom), clamped to a **discoverability floor** (every listed body
    becomes visible by some detail zoom regardless of score — area guarantees a floor, D49) and a
    widest zoom for top-score bodies. Exact curve/constants tuned against the Vermont corpus
    during build.
  - **Tests:** monotonicity (bigger area ⇒ score up ⇒ minVisibleZoom down; `curatedBoost` raises
    prominence), floor/ceiling clamps, and a property that every body is visible by the floor zoom.

- **`dedup.ts` (D36):**
  - `nameSimilarity(a, b): number` — normalized 0..1 (token/edit-distance hybrid over normalized
    names). Property-tested: identical ⇒ 1, symmetric, disjoint ⇒ low.
  - `classifyDedup(candidates): { ranked: RankedCandidate[]; suggested: DedupStatus }` — given
    per-candidate `{ pointInPolygon, iou, centroidDistanceM, nameScore }`, apply the D36
    thresholds (point-in-polygon ⇒ strong; IoU ≥ 0.5 suspected, ≥ 0.9 near-certain; centroid
    < ~75 m ⇒ suspected; name ≥ 0.8 bumps a tier), rank, and suggest a `dedupStatus`. Pure; the
    geometry inputs are computed by the caller from existing `geometry.ts` primitives
    (`polygonIoU`, `pointInPolygon`, `bboxIntersects`) — no new geometry math here.
  - **Tests:** each threshold branch + tier-bumping; ranking order; the "clean vs suspected vs
    near-certain" classification.

- **`report.ts` (validation/normalization — D22–D25/D41):**
  - `validateReportInput(input, now): { ok: true; normalized } | { ok: false; errors }` — the
    shared server-and-client contract (re-enforced server-side per D37). Rules: `waterBodyId` +
    `skateTime` + `visibility` required; `skateTime` not implausibly future (small cushion; past
    is fine for offline, D9); each thickness reading is `valueCm` **XOR** (`minCm`+`maxCm`) with
    `min ≤ max`; `iceTypes`/`surfaceTags` from the enums; `snowCoverCm` ≥ 0. Observation-friendly
    (a "don't do it" report with only `notes` is valid, D3) — nothing about ice *quality* is
    required.
  - Reuse existing `deriveDefaultVisibility` (visibility.ts), `canViewReport` (visibility.ts),
    unit formatters (units.ts), area helpers (units.ts / geometry.ts).
  - **Tests:** required-field + skate-time-future rejection; thickness value-XOR-range invariant
    (property test); a minimal "notes-only" report validates.

### B. Convex schema + geospatial
Minimal — the report/photo/comment tables already exist in full (Phase 0 schema). Only additive,
migration-free optional fields.
- **`waterBodies`:** add `displayScore?: number` and `curatedBoost?: number` (D49). Optional ⇒ no
  migration; computed on `importCanonical` / `create` / `setCuratedBoost`.
- **`reports`:** no schema change for web. *(An optional `idempotencyKey?` for the offline queue
  lands with the **mobile** PR, D30 — additive then.)*
- **`lib/geospatial.ts`:** unchanged. **No `reports.point` geospatial index this phase** — report
  feeds query the existing `by_water_body_skate_time` DB index; near-me/cross-body geospatial is
  Phase 5/6.

### C. Convex functions + `convex-test`
- **`waterBodies.ts` additions:**
  - `get` (query) — single body detail (name, type, area, polygon, centroid); follows
    `mergedIntoId` to the survivor; excludes unlisted from public callers.
  - `create` — **implement the D36 dedup stub**: bbox + geospatial-nearest prefilter → score each
    candidate with `geometry.ts` → `classifyDedup`; require an explicit `confirmedNew: true` to
    insert when strong matches exist; stamp `dedupStatus` + `duplicateCandidateIds`; compute
    `displayScore`; `reviewStatus: 'pending'` + `listed: true` (auto-visible, review-after, D37).
  - `findMatchCandidates` (query) — the read-side of dedup that powers the "attach here?" UX:
    given a proposed point/polygon + name, return ranked existing bodies **before** the user
    commits.
  - `setCuratedBoost` (mutation) — `requireRole('admin')`; set `curatedBoost`, recompute
    `displayScore`, re-insert geospatial key, write a `moderationActions` row.
  - `importCanonical` — also compute + store `displayScore` (small addition, so imported bodies
    score immediately).
  - `listInViewport` — **replace the Phase-1 soft-cap truncation with zoom-based rendering (D49):**
    take the client `zoom`, and keep only candidates with `minVisibleZoom(displayScore) <= zoom`.
    Keeps the two-tier viewport lookup + read-cap safety; the zoom filter is what actually makes
    wide zooms legible instead of truncated.
- **`reports.ts` (new):**
  - `create` (mutation) — `requireProfile`; `validateReportInput` (server re-enforce, D37);
    `deriveDefaultVisibility` from the caller's profile if unset; verify the water body exists /
    resolve `mergedIntoId`; server-stamp `reportTime`; insert. Photos are uploaded + rowed first
    (see `photos.ts`) and passed as `photoIds`.
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
- **Tests (`convex-test`):** report `create` validates + derives visibility; `listByWaterBody`
  hides `just_me` from a non-author and shows `public` (property-ish over viewer relationship);
  photo `create` drops `coord` when `placeOnMap` is false; dedup `create` refuses without
  `confirmedNew` when a strong match exists and stamps `duplicateCandidateIds`; `listInViewport`
  returns a high-score body at a wide zoom and drops a low-score one; `setCuratedBoost` gates on
  `admin` + writes the audit row.

### D. Web UI — read + map (the loop, read side)
- **`WaterMap.tsx`:** add a click/tap handler → set MapLibre **feature-state** highlight on the
  tapped body → open its detail; pass `zoom` into `listInViewport`; render by the D49 zoom filter.
  Home/water framing on open via the **browser geolocation API** (D12/D20: on-water ⇒ fit to that
  body; else center on location; else fall back to the Vermont region), setting only the *initial*
  framing.
- **Water-body detail** — presented as an **in-place drawer / side panel** over the map (D47), but
  **URL-backed at `/water/$id`** so selection is deep-linkable (see "Settled during review"). Shows
  name, `formatAreaAcres`, the `listByWaterBody` feed, and a "Create report" affordance surfaced in
  place (D47) — not a separate top-level page.
- **Report read** — likewise a drawer/panel, **URL-backed at `/report/$id`** (deep-linkable):
  render a report (all fields, imperial via units.ts), its photos (thumbs + full), author, skate
  time; photo **pins on the lake map** when `placeOnMap` (D42). *(Comments are Phase 3 — omitted.)*
- **Tests:** the pure `waterMap.ts`-style helpers stay unit-tested; component tests (Vitest +
  Testing Library) for detail rendering + imperial formatting; the imperative MapLibre shell stays
  excluded from coverage (Phase 1 precedent).

### E. Web UI — write (report creation + user-created bodies)
- **Report create form** (in-place on Map/detail, D47): ice types (`ICE_TYPES` multi-select),
  surface tags (`SURFACE_TAGS`), coarse `skateQuality`, **multi-reading thickness** (add/remove;
  value XOR range; measured/estimated), snow cover, optional **manual** conditions, **photos**,
  visibility (default from `deriveDefaultVisibility`, editable), notes, skate time (default now,
  editable to the past). Metric storage, imperial input/display (units.ts). Validates via
  `validateReportInput` before submit.
- **Photo pipeline (web, D31/D42):** on select → read EXIF GPS/timestamp with **`exifr`** *before*
  stripping → downscale to ~2048px long edge + a ~400px thumb and **re-encode to strip all EXIF**
  (`browser-image-compression` / canvas) → `generateUploadUrl` → upload both → `photos.create`,
  passing `coord`/`takenAt` **only** when the user opts into `placeOnMap` / timestamp.
- **User-created water body (D14/D36):** a **draw tool** (propose **Terra Draw** +
  `terra-draw-maplibre-gl-adapter`, MIT, renderer-agnostic — cleaner with MapLibre than
  mapbox-gl-draw) to drop a point or draw a polygon → `findMatchCandidates` → show ranked "attach
  to this existing lake?" list → attach the report to the existing body, **or** an explicit "None
  of these" → `waterBodies.create` with `confirmedNew`. New deps: `terra-draw`,
  `terra-draw-maplibre-gl-adapter`, `exifr`, `browser-image-compression`.
- **Tests:** report-form validation + visibility default (Testing Library); thickness add/remove +
  value-XOR-range UI; geotag opt-in toggles coord retention; dedup "attach vs create" branch.

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
- Prompt to submit pending drafts on reconnect (D12). Maestro E2E for the capture→sync flow later.

### G. Docs + hygiene
- README updates: `packages/convex` (reports/photos functions, dedup, displayScore),
  `apps/web` (report flow, draw tool, photo pipeline). Update `plans/README.md` index + the
  roadmap's Phase 2 status when it lands.
- Confirm token/drift-guard tests still pass; keep OSM + "Powered by Strava" (N/A this phase) and
  ODbL attribution visible.

---

## Suggested PR breakdown

**Web (this plan) — one PR, clean sub-workstream commits** (Greptile reviews are metered, so one
PR; commits map to §A–§E):
1. **core:** `display.ts` + `dedup.ts` + `report.ts` validation (+ tests). *(no infra)*
2. **convex:** `displayScore`/`curatedBoost` schema + `reports.ts` + `photos.ts` +
   `waterBodies` `get`/`create`-dedup/`findMatchCandidates`/`setCuratedBoost` + `listInViewport`
   zoom filter (+ `convex-test`).
3. **web read:** map tap-to-detail + water-body detail + report read + geolocation framing.
4. **web write:** report create form + photo pipeline.
5. **web user-bodies:** draw tool + match-on-create dedup UX.
6. **docs.**
   > *Optional split seam if the single PR gets too large for one review: read path (commits 1–3)
   > vs. write path (commits 4–5). Default is one PR unless it balloons.*

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

## Open items to settle during the build (small)
- **`displayScore` curve constants** — start with fixed log-area bounds + a linear score→zoom map;
  eyeball Champlain, Morey, and a small pond across z6–z14 and adjust the floor/span.
  **→ Phase 4:** these constants must get **admin-UI modification controls** in the operator
  surface (D37) — they should be tunable through the UI, **never buried as code constants** a
  non-engineer can't reach. Phase 2 ships them as tuned constants; Phase 4 lifts them behind admin
  controls.
- **`curatedBoost` seeding** — which known Vermont destinations get a manual boost at launch
  (Morey, Champlain arms, Joe's Pond…). A tiny admin action or one-off internal mutation for now.
  **→ Phase 4:** per-body `curatedBoost` must be **editable from the admin water-body surface**
  (set/adjust the boost on any body through the UI), not only via a seed script — same "don't bury
  it in code" principle as the score constants above.
- **Draw-tool choice** — confirm Terra Draw vs. a mapbox-gl-draw shim once we integrate (Terra
  Draw is the current lean for MapLibre cleanliness/licensing).

## Risks / watch-outs
- **Report-form surface area is large** — the ice/surface/thickness/conditions vocab is real
  (D22/D23). Push all validation into `@skating/core` (§A) so both apps + Convex share one
  contract and the UI is thin.
- **EXIF must be stripped by construction (D42)** — the *only* metadata that may survive is
  timestamp + GPS, and GPS *only* on `placeOnMap`. Enforce on **both** client (strip) and server
  (`photos.create` drops `coord`) so a client bug can't leak location.
- **Visibility is forward-loaded** — friends/followers resolve to author-only now; make sure the
  filter uses `@skating/core` `canViewReport` so Phase 3's follow graph flips it on with no report
  re-write, and **no feature silently widens exposure** (D41).
- **`listInViewport` stays read-cap-fragile** — the D49 zoom filter is the real fix, but keep the
  Phase 1 read-cap safety (256 limit, `isListed` JS refine, truncation `log`) as the backstop.
- **Dedup false-negatives** create duplicates the Phase 4 queue must clean — tune thresholds
  toward *steering* (prefer a false "attach?" prompt over a silent new body); `confirmedNew` is
  the escape hatch.
- **Hazard seam (Phase 8)** — don't paint the report data path into a corner that makes in-polygon
  hazard geometry hard to add later; `hazardIdsCreated` already exists in the schema, leave it be.
