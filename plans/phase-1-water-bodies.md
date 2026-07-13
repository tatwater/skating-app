# Phase 1 build plan — Water-body data

The concrete implementation plan for **Phase 1** of [`07-roadmap.md`](./07-roadmap.md).
Design rationale lives in the decisions log (D5, D6, D14, D36, D37, **D48**); this doc is
the *how* — ordered workstreams, file-level changes, and the test plan.

> **Goal.** Seed the map with real water bodies so a skater can open the map, pan their
> drive-time, and tap candidate lakes — *before* anyone has reported on them. Storage is the
> substrate for discovery (D14/D28); display is curated separately (D48).

## Scope (decided)

- **Pilot region: Vermont.** Compact, the Nordic-skating heartland (Lake Morey, Lake
  Champlain, Joe's Pond, …), one Geofabrik extract.
- **Lakes / ponds / reservoirs only. Rivers deferred** — modeling rivers as named *reaches*
  (D4/D36) is a later release once still-water is validated with users.
- **Read-only web map** to *confirm* the data renders. Interactive map, tap-to-detail, and
  report creation are **Phase 2**. Mobile's full map is also Phase 2 (bigger native lift);
  web is the fastest way to verify Phase 1.
- **Basemap: Protomaps** (D6) — start against hosted demo tiles, swap to a self-built
  Vermont `.pmtiles` once the water data is confirmed.

## Done criteria

- Vermont water bodies are in `waterBodies` (`source: 'osm'`), idempotently re-importable.
- `listInViewport` returns bodies whose **bbox intersects** the viewport (not just centroid).
- The read-only web map renders the polygons over a Protomaps basemap, with **"© OpenStreetMap
  contributors"** attribution visible.
- An admin can **remove** a body (it disappears from the map) and **restore** it, with a
  `moderationActions` audit row; a re-import does **not** resurrect a removed body.
- Tests green in CI; coverage does not regress.

---

## Workstreams (in dependency order)

### 1. `@skating/core` additions (pure, tested first)
The logic that both the ETL and Convex need, kept framework-free and property-tested (D40).
- `waterBodyTypeFromOsmTags(tags): WaterBodyType | null` — map OSM tags → our enum
  (`natural=water` + `water=lake|pond|reservoir|lagoon…`, `landuse=reservoir`, `natural=bay`,
  `wetland=marsh` → `marsh`, else `other`). Returns `null` for non-water / to-skip features.
  *Rivers (`waterway=*`, `water=river`) map to `null` this phase (deferred).*
- `representativePoint(geom): LatLng` — thin wrapper over Turf `pointOnFeature`, returning
  our `{ lat, lng }`. This is the **on-water** point (D48) stored as `centroid`.
- Reuse existing `polygonBBox`, `polygonIoU`, `bboxIntersects` (already present).
- Consider `surfaceAreaSqM(geom)` wrapping `@turf/area` (already a dep) for one code path.
- **Tests:** example tests for the tag mapping (each branch + the `null` cases) and a
  property test that `representativePoint` always lands inside the polygon.

### 2. Convex schema + enums
- **`waterBodies`** (`schema.ts`): add `removedAt?`, `removedByUserId?` (`v.id('profiles')`),
  `removalReason?` (`literals(REMOVAL_REASONS)`); add index **`by_external_id`**
  (`['source', 'externalId']`).
- **`lib/enums.ts`:** add `REMOVAL_REASONS = ['landowner_request','unskateable','junk',
  'duplicate','other'] as const`.
- **`lib/geospatial.ts`:** change the filter-key type from `{ reviewStatus }` to
  `{ listed: boolean }`.
- A small pure helper `isListed(body)` (in `@skating/core` or a convex lib): `true` unless
  `reviewStatus === 'rejected'` || `dedupStatus === 'merged'` || `removedAt != null`.
  Canonical bodies (no `reviewStatus`) and `pending`/`approved` user bodies → `true`.

### 3. Convex functions (`waterBodies.ts`) + `convex-test`
- **`importCanonical`** — an **`internalMutation`** (never client-callable) taking a batch of
  `{ externalId, name, type, polygon, bbox, centroid, surfaceAreaSqM }`. For each:
  upsert on `by_external_id` (`source: 'osm'`); on insert set `listed: true` in geospatial;
  on update, **patch geometry/name but preserve `removed*` and re-derive `listed` via
  `isListed`** (re-ETL safety, D48). Idempotent — re-running is a no-op on unchanged rows.
- **`remove`** / **`restore`** — `mutation`, `requireRole(ctx, 'admin')`; set/clear
  `removedAt`/`removedByUserId`/`removalReason`, re-insert the geospatial key with the new
  `listed`, and write a `moderationActions` row (`remove`/`restore`, `targetType: waterbody`).
- **`create`** / **`approve`** (existing): switch their geospatial filter key to `listed`
  (`create` → `true` per D37 auto-visible; a later `reject` → `false`).
- **`listInViewport`** (existing): filter `q.eq('listed', true)`, and implement the D5
  **bbox-intersection** target — query the geospatial index over the viewport **expanded by
  the largest body's half-extent**, then refine each candidate with
  `bboxIntersects(body.bbox, viewport)`. Tune the expansion against the real Vermont corpus.
- **Tests:** `importCanonical` idempotency (double-import = one row) + **removed-state
  survives re-import**; `remove`/`restore` gate on `admin` + write the audit row; a large
  body whose centroid is off-screen but bbox overlaps **is** returned by `listInViewport`;
  a `removed` body is **not**.

### 4. ETL pipeline (`scripts/etl`, run manually)
Not a workspace app — a manual `tsx` script directory. Pipeline stages:
1. **Fetch** the Vermont extract (`vermont-latest.osm.pbf` from Geofabrik). Document the
   URL + a checksum; don't commit the `.pbf`.
2. **Filter + convert** with local tools (Homebrew: `osmium-tool`, `gdal`): extract water
   multipolygons → GeoJSON. Keep OSM id as `externalId`.
3. **Transform (TS):** for each feature — `waterBodyTypeFromOsmTags` (drop `null`),
   **simplify** (`@turf/simplify`, tolerance ≈ `0.00005°` ≈ 5 m; coarsen a body past 5 m
   *only* if it would otherwise approach the 1 MiB/doc hard limit — see the fidelity note
   below), then `polygonBBox`, `representativePoint`, `surfaceAreaSqM`. Emit **NDJSON**.
   - **Per-feature resilience (PR#1 review P2).** `representativePoint` (Turf `pointOnFeature`)
     **throws** on a degenerate/collapsed ring; the core helpers stay pure and throwing (the
     right layer for the error boundary is here, not the helper). So the transform **wraps each
     feature in try/catch** — a bad polygon is **logged + skipped**, never aborting the batch —
     and tallies skipped counts in the run summary. Raw OSM has enough junk geometry that a
     single throw must not kill an import.
4. **Load:** a script that batches the NDJSON into `importCanonical` (respecting Convex
   mutation size limits — chunk the batches).
- **Fidelity-first sizing (D48).** The **primary target is a uniform ~5 m tolerance**
  applied to *every* body, Champlain included — ≥ Google/Apple water-fill fidelity for click
  zones + active-state coloring at z8–z15. The **only hard constraint is Convex's 1 MiB/doc
  limit**; `< ~100 KB/doc` is a **loose expectation** (nearly every body lands far under it),
  **not** a budget that overrides fidelity. Coarsen below 5 m **only** for a body that would
  otherwise breach 1 MiB with a safety margin — realistically Champlain is the sole
  candidate, and even at 5 m it should fit. No vertex cap. If a large lake's *query payload*
  (not its storage) becomes the problem, the fix is a coarse map-outline for the list layer +
  lazy-load full detail on tap (a Phase 2+ lever), **not** a degraded stored geometry.
  Vermont total ≈ 10–20 MB.
- Non-npm tools (`osmium`, `gdal`) are **local prerequisites** — document install in the
  script README; the *transform* stage stays testable TS via `@skating/core`.

### 5. Read-only web map (`apps/web`)
- Replace the Map `Placeholder` (`src/routes/index.tsx`) with a MapLibre GL map
  (`maplibre-gl` + `react-map-gl` or direct), framed on Vermont.
- Basemap: a Protomaps style over demo `.pmtiles` first; self-built Vermont extract after.
- A source/layer driven by `listInViewport` for the current viewport bbox; render polygons as
  a fill + outline. **No** tap-to-detail / interactivity yet (Phase 2).
- **Attribution control:** "© OpenStreetMap contributors" always visible (map attribution
  control), per `04-integrations.md`.
- Keep it behind the existing auth/provisioning gate (unchanged from Phase 0).

### 6. Docs + hygiene
- README updates: `packages/convex` (import path, `listed`, remove/restore), `scripts/etl`
  (prereqs + run steps), `apps/web` (map layer + basemap swap note).
- Confirm the drift-guard / token tests still pass; add attribution to the web about screen
  if that's where other credits live.

---

## Suggested PR breakdown
1. **core:** tag mapping + representative point (+ tests). *(no infra)*
2. **convex:** schema fields + `by_external_id` + `listed` refactor + `remove`/`restore` +
   `importCanonical` + `listInViewport` bbox refine (+ `convex-test`).
3. **etl:** `scripts/etl` pipeline + a committed **small fixture** (a handful of Vermont
   bodies) so the load path is exercisable without the full extract.
4. **web:** read-only MapLibre layer + Protomaps basemap + attribution.
5. **basemap:** swap demo tiles → self-built Vermont `.pmtiles` (can trail #4).

## Settled before the build (2026-07-12)
- **Loader mechanism.** `importCanonical` stays an `internalMutation` (never client-callable).
  The NDJSON loader chunks batches and shells out via **`pnpm exec convex run`** (the CLI can
  invoke internal functions with a deploy key; `npx` is blocked repo-wide, and `convex import`
  is unusable here because it bypasses the geospatial-index insert). Load into the **dev**
  deployment first and confirm it renders before anything touches prod.
- **`scripts/etl` is a private workspace package** (`"private": true`, never built/deployed):
  its own `package.json` declaring `@skating/core` as a direct dep (hoisted linker requires it)
  and its own Vitest transform tests. Not "a bare tsx dir" — the transform stays first-class TS.
- **Coverage exclusion.** Exclude the MapLibre map component and the ETL's subprocess/file-I/O
  **glue** from coverage collection — untestable shells only. All real logic lives in the
  tested `@skating/core`, so this is not coverage-gaming; the "coverage does not regress" gate
  still bites on logic.
- **`waterBodyTypeFromOsmTags` lives in `@skating/core`** (colocated with the `WATER_BODY_TYPES`
  enum it targets + core's property-test discipline), even though only the ETL consumes it today.
- **Zoom-scored display prominence is D49 — Phase 2, not here.** Phase 1 only populates
  `surfaceAreaSqM` and uses a soft viewport cap with truncation logging (below); the display
  score / per-zoom threshold is built with Phase 2's real map. `listed` stays a binary gate,
  decoupled from prominence.

## Open items to settle during the build (small)
- **Final simplify tolerance** — start 5 m, eyeball Champlain + a small pond on the map, adjust.
- **Viewport cap (D5).** The geospatial `limit` truncates *before* the bbox refine, so a wide
  (state-level) zoom silently drops bodies. Phase 1: raise the pilot cap (64 → ~512) and `log`
  a warning when truncation actually happens rather than drop silently; expansion is a tuned
  constant (~Champlain's half-height), not a per-query computation. **This is now known to be
  worse than a wide-zoom edge case — see "PR#4 prerequisite" below; the real fix must land in
  PR#4, not Phase 2.**
- **`.pmtiles` hosting** — Convex file storage vs. a static host/R2 (either is fine; pick when
  we swap off demo tiles).
- **National storage later** — watch the Convex DB storage tier as regions are added; scope
  Alaska to populated areas + named/area threshold (never the whole state). Not a Phase 1
  concern, logged so it isn't forgotten.

## PR#4 prerequisite: fix `listInViewport` (discovered during the PR#3 load)

**Status (2026-07-12): the ETL + import shipped (PR#9); `listInViewport` is broken at the real
corpus scale and must be fixed as the first thing in PR#4, before the map can render.**

**Symptom.** With all 9,967 Vermont bodies loaded, `listInViewport` returns **0** for a normal
city-zoom viewport (e.g. the Burlington waterfront) even though a manual bbox scan finds 14
bodies there, incl. Lake Champlain. So the data is correct; the *query* is broken.

**Root cause.** `listInViewport` indexes **centroids** and expands the query rectangle by
`MAX_BODY_EXTENT_DEG` (±2°, sized to catch Lake Champlain — 1.53° tall — via its off-screen
centroid). At real density that ±2° expansion covers ~all of Vermont, so the
`@convex-dev/geospatial` query hits the component's internal **~1024-row read cap**, returns a
spatially-arbitrary ~505 centroids, and the `bboxIntersects` refine finds none inside the small
actual viewport. One outsized body (Champlain) forcing a huge expansion for *every* query is the
core flaw.

**Recommended fix (PR#4).** Decouple the outliers from the common case:
1. Query the centroid index over the **actual viewport plus a small margin** (~a typical medium
   body's half-extent, e.g. ~0.05°) — bounded, well under the 1024-row cap, correct for the
   overwhelming majority of small/medium bodies.
2. Handle the **few large bodies explicitly** — flag bodies whose bbox extent exceeds a
   threshold (an `isLarge` boolean, or a dedicated small index) and always `bboxIntersects`-test
   that short list (Vermont: ~Champlain + Memphrémagog). This removes the need for the ±2°
   blanket expansion entirely.
   *(The fully-general alternative is multi-cell / bbox-coverage indexing — index each body under
   every S2 cell its bbox touches so a rectangle query is exact regardless of size — but that's a
   larger geospatial rework; the two-tier approach above is the pragmatic PR#4 scope.)*
3. Keep the truncation `log` (D5) as a backstop, but it should stop firing in normal use.

Add a `convex-test` case asserting a large body with an off-screen centroid **is** returned by a
small shoreline viewport (the exact case that regressed), plus a normal small-viewport case.

## Risks / watch-outs
- **Convex hard limits (two, both real)** — (1) **1 MiB/doc**; (2) **8192 elements per array**,
  which applies to a polygon ring's coordinates and bit Lake Champlain (~8,900-vertex ring at
  5 m). Keep uniform 5 m fidelity and coarsen a body past it *only* to fit a hard limit — the
  ETL does this adaptively (+~1 m/step; Champlain settles ~7 m) and skips anything still over
  the array cap per-feature. Fidelity is the priority; these two limits are the only hard lines.
- **Query read size** — `listInViewport` returning many full polygons could get heavy at wide
  zoom; if so, return low-detail outlines + lazy-load detail on tap (a Phase 2+ lever, noted).
- **OSM attribute quality** — names/types vary; the `other` bucket + later NHD enrichment
  (deferred) are the safety nets.
- **Attribution is a launch gate** — ODbL, treat like "Powered by Strava."
