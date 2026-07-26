# Phase 5 — Newsfeed page

> **Roadmap:** [`07-roadmap.md`](./07-roadmap.md) → Phase 5. This is the detailed build plan,
> in the style of the Phase 1/2/2.5/3 docs.
>
> **What this phase is.** The chronological, **cross-water-body** feed (D28) — the co-primary page
> alongside the map. Browse recent community activity without going lake-by-lake. It reuses the whole
> Phase 3 read stack (moderation gate, block set, `ReportDetail`, batch author/photo queries).
>
> **Status:** ✅ **Complete (dev; prod deferred) — 2026-07-17.** Merged as PR #18, deployed to the
> `dev:agile-bee-…` deployment, `adminAreas` OSM import loaded, and the skate-time migration accounted
> for (verified 2026-07-17 — see the Operational note below). All four workstreams
> landed with tests green + lint clean across the repo: **A** `@skating/core` (`skateTime`→`skateEndTime`
> rename + `skateStartTime` + `resolveSkateWindow`/`formatSkateWindow` + new `feed.ts` —
> `formatPlaceLabel`/`formatRelativeTime`/`buildFeedCardView`, 100% coverage); **B** Convex (schema
> rename + indexes + `skateStartTime`/`place`/`gpsActivities` timestamps + `adminAreas` table & second
> spatial index for boundaries + `adminAreas.ts` import/`resolvePlaceForCoord` + `reports.create` place
> stamp + `reports.listFeed` + `renameSkateTimeToSkateEndTime` migration + `scripts/admin-areas` OSM
> boundary ETL, all `convex-test`ed); **C** Web (`/feed` page, `FeedCard` + component tests, tap→drawer
> `?report=` overlay, report-form relabel + optional start/duration); **D** Mobile (feed tab FlatList +
> pull-to-refresh + `@gorhom/bottom-sheet` detail, `FeedCard` mirror + horizontal carousel, form
> relabel).
> **Operational (verified 2026-07-17 against `dev:agile-bee-…`):** (1) ✅ pushed to dev — the full
> Phase 5 backend is live (`reports:listFeed`, `reports:renameSkateTimeToSkateEndTime`,
> `adminAreas:importCanonical`, `adminAreas:resolvePlace`); (2) ✅ `scripts/admin-areas` OSM import
> loaded — `adminAreas` populated and `resolvePlace` returns correct town/county/state at known points
> across all five states (VT/NY/NH/ME/MA); (3) ✅ migration accounted for — the `reports` table on dev
> is **empty** (zero docs), so `renameSkateTimeToSkateEndTime` is a no-op with no legacy `skateTime`
> left; new reports write `skateEndTime` via the deployed schema; (4) ⏳ app-run verification — owned by
> the founder. Prod stays uninitialized.
>
> **⚠️ Brought forward, ahead of Phase 4 (drive-time), by decision (2026-07-16).** The feed ships
> **global** — *all* reports from *all* lakes across the whole imported region, newest skate-end time
> first. The roadmap's two drive-time bullets — *"within range"* and *"temporarily expand radius"* —
> are **definitionally Phase 4** and are deferred there: Phase 4 later injects an in-range / favorites
> predicate as an **additive filter** on the same feed query, which is near-zero rework (the page and
> card don't change; the result set narrows). This is a clean one-directional dependency, not a corner.
>
> **Build order:** **web first, then mobile** (mirrors Phase 2/3) — web front-loads the shared Convex
> `listFeed` query + card view-model and is faster to verify. Mobile mirrors once proven.

Decisions referenced as D#; see [`01-decisions.md`](./01-decisions.md).

---

## Decisions locked this session (2026-07-16)

1. **Sort by skate *end* time — rename `skateTime` → `skateEndTime`, and *add* `skateStartTime`.**
   The freshest read of the ice is the one from the skater who left *latest*, not who arrived earliest.
   `skateEndTime` ("when the skater got off the ice") is the **primary sort key everywhere** (newsfeed,
   per-body feed, profile history — all already sort by this field), so the rename is consistent, not
   feed-only. We **also keep the start** (founder call 2026-07-16) — it's cheap and useful.
   - **Storage: two timestamps, duration derived.** `reports.skateStartTime?` + `reports.skateEndTime`.
     **Do not store duration** — it's a pure function of the two, and storing all three invites drift
     (which value wins if they disagree?). `end − start` is computed for display.
   - **Manual form input modes:** **end** is required and defaults to **now** (one tap for the terse
     reporter — 84% of corpus posts skip thickness, so keep friction low). **Start is optional
     richness:** the user can enter a start time *or* a duration; a duration back-computes
     `start = end − duration` **at the input boundary** (we still persist only the two timestamps).
     Copy changes from the ambiguous *"When did you skate?"* to *"When did you get off the ice?"*
   - **`gpsActivities` prepped now for all three (Phase 8 wires them):** add optional `endTime` +
     `elapsedSeconds` alongside `startTime`. Here three values are **genuinely non-redundant** — a
     provider's `elapsedSeconds` (moving/elapsed time) legitimately differs from wall-clock
     `end − start` because of pauses/stops. Conversion maps the path's **end** → `skateEndTime` and its
     start → `skateStartTime`, after trimming a watch-left-recording tail to the on-water path.
   - **Semantics worth stating:** an all-day skate (ended 6pm) outranks a later short skate that ended
     3pm — correct; the 6pm observer holds the fresher read.

2. **The feed is global for now** (all lakes, all regions). No drive-time or favorites scoping in this
   phase — that is **Phase 4**, applied later as an additive filter (see status note above). Accepted
   trade-off: as real usage spreads across NY/VT/NH/ME/MA the unscoped feed gets noisy, but at alpha
   scale it's fine and Phase 4 fixes it before it matters.

3. **Location label is derived from the report's *point* (the put-in pin / GPS start), not the water
   body** (founder call 2026-07-16). A body-level label would stamp one town on all of Lake Champlain;
   a point-level label shows **which town/side the skater put in from** — and for a body spanning two
   states (Champlain: NY|VT) it shows the right one. It also **removes the 116k-body backfill**. The
   card reads `{body name} · {town or county}, {state}` — e.g. *"Lake Champlain · Burlington, VT."*
   - **Resolved server-side at `reports.create`** against a new **`adminAreas`** boundary table
     (below), stamped onto `report.place` so the feed reads it directly (no per-read geocode; works for
     offline-flush since the mutation runs at flush). Reuses the existing `@skating/core`
     `pointInPolygon`/`bboxIntersects` primitives — **no external geocoder dependency**.
   - Town coverage is effectively complete for our region: **New England (VT/NH/ME/MA) is fully divided
     into towns** (no unincorporated gaps) and NY land sits in towns too; **county is the fallback**.
   - ⚠️ **Open scope decision (ask founder):** `adminAreas` in-phase (recommended — town is the real
     disambiguator; state alone won't separate VT's many same-state "Mud Pond"s) **vs.** ship
     `{name} · {state}` first (point→state is cheap — ~5 state polygons) and add town/county when
     `adminAreas` lands. `adminAreas` is reused by GPS (Phase 8) + hazards (Phase 9), so it pays off.

4. **Tapping a card opens the report in a drawer/sheet overlay, not a full navigation** — preserves
   feed scroll position and keeps things snappy. Web: a state-driven sheet reusing `ReportDetail`
   (optional `?report=<id>` search param for deep-linkability without losing place). Mobile: the Phase 2
   `@gorhom/bottom-sheet` pattern.

5. **Photo thumbnail carousel** in feed cards **and** the drawer, for reports with photos.

6. **Lake map** in feed cards **and** the drawer, for reports with GPS paths (Phase 8), showing the
   skater's put-in, path, and any hazards they reported or confirmed along the way (Phase 9).

7. **Empty state** on both surfaces; **pull-to-refresh** on mobile. Web relies on Convex live
   reactivity (the feed auto-updates); a manual refresh affordance can be added later if wanted.

---

## Schema changes (all migration-aware)

Applied in `packages/convex/convex/schema.ts`.

1. **`reports` skate-time model — rename + add:**
   - Rename `skateTime` → **`skateEndTime`** (required) + the indexes:
     - `by_water_body_skate_time` → `by_water_body_skate_end_time` (`['waterBodyId', 'skateEndTime']`)
     - `by_author_skate_time` → `by_author_skate_end_time` (`['authorId', 'skateEndTime']`)
     - **new** `by_skate_end_time` (`['skateEndTime']`) — the global cross-body feed sort/paginate index.
   - Add **`skateStartTime?: number`** (optional; duration derived, never stored).
   - **⚠️ Not migration-free** (a rename). Ship a one-time `internalMutation`
     `renameSkateTimeToSkateEndTime` that copies each report's `skateTime`→`skateEndTime` (and stamps
     `place`, below). Reuse the Phase-3 strict-schema migration dance on a deployment with drift:
     temporarily `defineSchema(..., { schemaValidation: false })` (uncommitted) → push → run migration →
     revert → redeploy strict (memory: `phase-3-community-safety`). Dev has a handful of test reports;
     prod is uninitialized.
   - Touches the **mobile offline draft queue** (F2) draft shape + `@skating/core` `draftQueue.ts` /
     `reportForm.ts` / `report.ts` / `reportView.ts`, and the web/mobile report forms + all reads.

2. **`reports.place?: { town?: string; county?: string; state?: string }`** (optional ⇒ migration-free)
   — the point-derived location label, stamped at `reports.create` from `report.point` (the put-in pin /
   GPS start) via the `adminAreas` resolver. Card shows *town if present, else county*, plus state.

3. **`gpsActivities` — prep the end timestamp (Phase 8 wires it):** add optional **`endTime?`** alongside
   the existing `startTime`. We deliberately do **not** store provider moving/elapsed time — that's a
   speed-stats concern (Strava) and we compute no speed. Our duration signal is the *observation window*
   (wall-clock `endTime − startTime`): how much of the ice the reporter could watch. This mirrors the
   report model — a GPS activity's `startTime`/`endTime` map straight to `skateStartTime`/`skateEndTime`.
   Migration-free (both optional). No behavior now — GPS ingest is Phase 8.

4. **New `adminAreas` table** — administrative-boundary polygons for the region, for point→place lookup:
   ```
   name: string                 // this row's own name, e.g. "Burlington" (a town) or "Chittenden County" (a county) — never a joined "Town, County" string
   level: enum(state, county, town)   // admin granularity
   state: string                // 2-letter code (denormalized for the label)
   polygon: geojson             // boundary
   bbox: { minLat, minLng, maxLat, maxLng }   // prefilter
   centroid: { lat, lng }       // geospatial point index
   ```
   Geospatially indexed like `waterBodies`; `.index('by_level', ['level'])`. Small (5 states of
   towns/counties ≈ single-digit thousands of rows).

### `adminAreas` import (new tooling — no `waterBodies` re-import)

- Offline script (`scripts/admin-areas/`): from the **same per-state OSM extracts** the water ETL
  already uses, extract `boundary=administrative` relations at `admin_level` 4 (state) / 6 (county) /
  7–8 (town/city — New England towns fully tile VT/NH/ME/MA; NY land sits in towns) → simplify →
  emit NDJSON → `adminAreas.importCanonical` internalMutation (idempotent, geospatial insert). Same
  ODbL attribution as the water data — **no new dataset**.
- **`resolvePlaceForCoord(ctx, point)`** (convex, backed by `@skating/core` geometry): geospatial-
  nearest / bbox prefilter → `pointInPolygon` → return the most specific `{ town?, county?, state? }`.
  Reused by `reports.create` now and by GPS (Phase 8) + hazards (Phase 9) later.
- **Open scope decision (ask the founder):** `adminAreas` in-phase (recommended — town is the real
  disambiguator; state alone won't separate VT's many same-state "Mud Pond"s) **vs.** ship
  `{name} · {state}` first (point→state needs only ~5 state polygons) and add town/county as a
  fast-follow. In-phase is reused by Phases 8/9, so it pays off.

---

## `@skating/core` (pure logic first, 100% coverage — D40)

- **`feed.ts` (new):** `formatPlaceLabel({ town?, county?, state? })` → the card location string
  (`"Stowe, VT"` / `"Chittenden County, VT"` / `"VT"` fallback). Optionally a
  `buildFeedCardView(report, body, author)` view-model composing the existing `reportView.ts` summary
  helpers (skate-end relative time, ice/surface/quality chips) so both surfaces render identically.
  Pure + example/property tested.
- **Skate-time triangle** in `reportForm.ts`: `resolveSkateWindow({ end, start?, durationMinutes? })` —
  the input-boundary helper that yields `{ skateStartTime?, skateEndTime }`, back-computing
  `start = end − duration` when a duration is entered, and validating `start ≤ end`. Duration is never
  an output field. Add a `formatSkateWindow(start?, end)` display helper (derives + labels duration).
- **Rename `skateTime`→`skateEndTime`** + thread `skateStartTime?` through `reportForm.ts`
  (`ReportFormState`, `emptyReportForm`, `toReportInput`), `report.ts` (validation input/output —
  validate `skateStartTime ≤ skateEndTime` when present), `reportView.ts`, `draftQueue.ts`. Update all
  tests. Keep the epoch-ms canonical contract (D7).

---

## Convex backend

- **`adminAreas.ts` (new):** `importCanonical` internalMutation (geospatial insert) + the
  `resolvePlaceForCoord(ctx, point)` helper (geospatial/bbox prefilter → `pointInPolygon` → most
  specific `{ town?, county?, state? }`). Reused by `reports.create` (now) and Phases 8/9 (later).
- **`reports.create` (extend):** stamp `place = resolvePlaceForCoord(ctx, point)` from the resolved
  `report.point` (put-in pin / GPS start). Persist `skateStartTime?` alongside `skateEndTime`.
- **`reports.listFeed`** — the cross-body feed. `paginationOpts` (Convex `usePaginatedQuery`); query
  `by_skate_end_time` **desc**; filter `canViewReport(moderationStatus)` (moderation-only — a block
  never hides a report, D3). Enrich each page item into a **feed card**:
  - water body `{ name }` (batch `db.get` per distinct `waterBodyId`, follow `mergedIntoId` survivor) +
    the report's own `place` (point-derived label — no per-read geocode),
  - author `{ displayName, username }` via `profiles.publicByIds`, plus a **`blocked`** flag from
    `loadBlockedAuthorIds(ctx, viewer)` (de-emphasis + "Blocked" chip, D3 — report still shown),
  - **photo thumbnail URLs** (batch-resolve `thumbStorageId` via the `photos.getUrls` path).
  - Returns a `PaginationResult` of card view-models. Per-page enrichment is bounded by page size.
- **Reuse:** `profiles.publicByIds`, `photos.getUrls`, `lib/reportVisibility.ts`
  (`loadBlockedAuthorIds`, `canViewReport`), `@skating/core` geometry.
- **Migration:** `renameSkateTimeToSkateEndTime` internalMutation — copies `skateTime`→`skateEndTime`
  **and** stamps `place` on existing reports (resolve against `adminAreas`). Runs after the
  `adminAreas` import.

---

## Web UI (`apps/web`)

- **`/feed` route** (replace placeholder): `usePaginatedQuery(api.reports.listFeed)` → infinite-scroll
  list of **`FeedCard`** (body name + location label, skate-end relative time, ice/surface/quality
  summary chips, blocked-author de-emphasis + `BlockedChip`, **photo thumbnail carousel**). Empty state
  when there are no visible reports. `ProfileSearch` already sits here (Phase 3).
- **Tap → report drawer:** a state-driven `Sheet`/`Dialog` overlay reusing the existing `ReportDetail`
  presentational component (same block/flag/moderator controls), so the feed scroll position is
  preserved. Optional `?report=<id>` search param for deep-linking without a full navigation.
- Live-reactive (Convex) — no manual refresh needed; new reports stream in.
- **Report form (`ReportForm.tsx`):** relabel to *"When did you get off the ice?"* (default now) and add
  the optional start input (a start-time picker **or** a duration field → back-computes start via
  `resolveSkateWindow`). Show skate-time as the end; `skateStartTime` optional.

## Mobile UI (`apps/mobile`)

- **`feed` tab** (replace placeholder): `FlatList` + `usePaginatedQuery`, `RefreshControl`
  (pull-to-refresh), the `FeedCard` mirror with a horizontal **photo carousel**, empty state.
- **Tap → bottom-sheet** report detail (Phase 2 `@gorhom/bottom-sheet` pattern) reusing the mobile
  `ReportDetail` + safety/moderator controls.
- **Report form:** mirror the web relabel + optional start/duration input.

---

## Testing (lands with the feature — D40)

- **`@skating/core`:** `formatPlaceLabel` (town/county/state fallbacks); `resolveSkateWindow`
  (start/end vs. start/duration back-compute; `start ≤ end` validation) + `formatSkateWindow`; feed
  view-model shaping; `skateEndTime`-rename + `skateStartTime` regression across
  `reportForm`/`report`/`reportView`.
- **`convex-test`:** `listFeed` — **ordered by `skateEndTime` desc**; excludes hidden/removed
  (moderation-only); a blocked author's report is **still returned** but carries `blocked: true` (the
  D3 invariant); pagination cursors; photo-URL + author enrichment shape; merged-body survivor
  resolution. `adminAreas.resolvePlaceForCoord` (point in a town → town+county+state; multi-state
  border point → correct state; ocean/no-match → graceful empty). `reports.create` stamps `place`.
  Plus the `renameSkateTimeToSkateEndTime` migration.
- **Web:** component tests for `FeedCard` (location label, blocked chip, photo carousel), empty state,
  and the tap-to-drawer overlay preserving list state.
- **Mobile:** logic/hook tests (most logic in `@skating/core`) + component test for the card + carousel.

---

## PR / commit breakdown (one PR per phase — memory: bundle-prs-by-phase)

One Phase 5 PR; sub-workstreams as separate commits:

- **A — `@skating/core`**: `skateEndTime` rename + `skateStartTime` + `resolveSkateWindow`/
  `formatSkateWindow` + `feed.ts` (`formatPlaceLabel` + card view-model) + tests.
- **B — Convex**: schema (rename + `skateStartTime` + `reports.place` + `gpsActivities` timestamp prep +
  `adminAreas` table) + `adminAreas` import script + `resolvePlaceForCoord` + `reports.create` place
  stamp + `renameSkateTimeToSkateEndTime` migration + `by_skate_end_time` index + `reports.listFeed`
  enrichment + `convex-test`.
- **C — Web**: `/feed` page, `FeedCard`, photo carousel, tap-to-drawer overlay, report-form relabel +
  start/duration input.
- **D — Mobile**: the mirror — `feed` tab, pull-to-refresh, card + carousel, bottom-sheet detail,
  report-form relabel + start/duration input.

Push to the dev deployment (`convex dev --once`) + run the migration before app verification
(memory: `convex-test-is-not-deploy`).

---

## Out of scope / deferred (logged so it isn't lost)

- **Drive-time / favorites scoping + "temporarily expand radius"** → **Phase 4** (the additive filter
  on `listFeed`; `waterBodyFavorites` join; session-only radius expansion).
- **GPS *wiring* of the skate window** — `gpsActivities.endTime`/`elapsedSeconds` are added to the
  schema now (prep), but populating them from a provider path + on-water tail trimming + mapping
  start/end → the report is **Phase 8**.
- **Notification delivery** for feed activity → later (with the broader notifications work).
- **Weather-since strips** on feed cards → **Phase 10** (D19).
