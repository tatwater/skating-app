# @skating/convex

The Convex backend (D2): the reactive database **schema**, server **functions**
(queries/mutations/actions), and their `convex-test` suites. The security boundary
is the Convex function, not the deployment (D37) — every function resolves the
caller from their Clerk identity and gates on account `status`/`role` server-side.

## Identity model (D26)

**Clerk owns the auth user**; we own a `profiles` row per user (display, prefs, role,
status, reputation). The two are tied by `profiles.clerkUserId` (= Clerk
`identity.subject`), and every other entity references a user by their `profiles._id`
(`authorId`, `userId`, `createdByUserId`, …). `convex/auth.config.ts` registers Clerk
as the Convex identity provider (needs the `CLERK_JWT_ISSUER_DOMAIN` deployment env var
and a Clerk JWT template named `convex`).

## Layout

- **`convex/schema.ts`** — all 17 entities from `plans/06-data-model.md` (the `follows`
  table was dropped with the social graph, D13), with the suggested indexes. Shared vocabulary
  (ice types, hazards, roles, …) is imported from `@skating/core` via the `literals()` helper
  so it's single-sourced; backend-only enums live in `convex/lib/enums.ts`.
- **`convex/lib/`** — `auth.ts` (identity + role/status gating), `validators.ts`
  (`literals`, `boolFlags`, `latLng`, `bbox`, `geoJson`), `enums.ts`, `cellIndex.ts`
  (the ladder-grid spatial index — write-side reconciliation for `waterBodyCells` /
  `adminAreaCells`, D5/D48/N1), `listing.ts` (the `isListed` derivation).
- **No Convex components are installed.** `convex.config.ts` was deleted with
  `@convex-dev/geospatial` in N1; spatial lookups are plain tables + indexes now.
- **`convex/profiles.ts`** — `current` + `upsertFromClerk` (idempotent Clerk→profile
  bridge; enforces the 16+ gate and username uniqueness) + `publicByIds` (minimal public
  attribution — `username`/`displayName` keyed by id — for report feeds/detail, Phase 2).
- **`convex/waterBodies.ts`** — internal `importCanonical` (idempotent OSM/NHD upsert keyed
  on `by_external_id`, preserves removed state across re-import, D14/D48; now also computes the
  D49 `displayScore`/`minVisibleZoom`) + `backfillCells` (the paginated cell-index migration);
  user `create` (queued for after-the-fact review, D37), moderator `approve`, admin
  `remove`/`restore` (reversible soft-delist + audit row, D48); public **`get`** (single-body
  detail; follows `mergedIntoId` to the survivor, flags removed/unlisted vs not-found, D36/D47),
  admin **`setCuratedBoost`** (recompute score + re-index + audit, D49), `listInViewport`
  (**two-tier bbox-intersection** viewport query with the optional D49 `zoom` prominence filter —
  see below), `searchByName` (map search box), public **`resolveBodyForCoord`** (GPS→lake for the
  F2 offline-draft flush: the same two-tier lookup + the shared buffered `nearestBodyForPoint`,
  ~300 m parking buffer), `listPendingReview`.
- **`convex/reports.ts`** — the read/write loop (D3/D22–D25/D41): `create` (`requireProfile`,
  re-enforces `@skating/core` `validateReportInput`, rejects minors, resolves the merged
  survivor, defaults `point` to the body centroid, server-stamps `reportTime`; **idempotent on an
  optional `idempotencyKey`** so a mobile offline-flush retry can't duplicate — F2/D30),
  `listByWaterBody` (feed by **skate time** desc, moderation + block filtered via `canViewReport`),
  `get` (moderation-checked), `update` (author-only last-write-wins).
- **`convex/photos.ts`** — `generateUploadUrl` (auth'd storage upload URL), `create` (records a
  `photos` row; **drops `coord` unless `placeOnMap === true`, D42** — enforced server-side),
  `getUrls` (resolve full/thumb serving URLs, null-guarded).
- **`convex/basemap.ts`** — internal `generateUploadUrl` / `getServingUrl`: the ops path for
  hosting the self-built Vermont `.pmtiles` basemap in Convex file storage (Phase 1, PR#5, D6 —
  its serving URL honors HTTP `Range` + CORS, which `pmtiles://` requires). Invoked by
  [`scripts/basemap`](../../scripts/basemap/README.md), never client-callable.
- **`convex/*.test.ts`** — `convex-test` suites: auth/role/suspension gating, upsert
  idempotency + age/username invariants, approve/remove/restore → audit-log paths, the
  ladder-grid `listInViewport` (cell scan, bbox refine, render-budget truncation log, a
  300-body dense viewport) **+ the D49 zoom cutoff / `setCuratedBoost` recompute + audit**, `get`'s
  merged-redirect/unavailable signal, report `create` (centroid default, minor rejection,
  idempotency-key dedup) / `listByWaterBody` (moderation + block filter), and photo `create`
  dropping `coord` without `placeOnMap`.

## Deviations & deferrals (flagged for review)

- **`profiles` renames the doc's `users` table.** Per the identity model above;
  `plans/06-data-model.md` and `01-decisions.md` (D26) have been reconciled to match.
  `clerkUserId` (+ `by_clerk_user_id` index) is the Clerk tie the doc didn't spell out.
- **Spatial lookups (D5) run on the N1 ladder grid.** A water body has one `waterBodyCells`
  row per grid cell its **bbox** covers, at a level no finer than the zoom it first draws at, so
  `listInViewport` is "scan the cells covering the viewport, at every rung up to this zoom" —
  bounded by geometry rather than by a tuned constant, with `by_cell`'s trailing `minVisibleZoom`
  turning the D49 cutoff into an index range. Admin boundaries use the same shape
  (`adminAreaCells`). This replaced a centroid index (`@convex-dev/geospatial`) whose reads
  scaled with `maxResults` rather than with results, and which crashed a wide viewport twice
  (PRs #10/#11) before its workarounds were retired here. `zoom` is a **required** argument —
  the completeness guarantee is stated against it. See
  `plans/phase-N1-read-path-durability.md` and `packages/core/src/spatialCells.ts`. Still
  deferred: a spatial index on `reports.point` (near-me / cross-body queries, Phase 5/6).
- **`geoJson` is now a structured GeoJSON-geometry validator** (`lib/validators.ts`),
  not `v.any()` — a discriminated union over Point/MultiPoint/Line/MultiLine/Polygon/
  MultiPolygon that rejects unknown `type`s and wrong nesting at the mutation boundary.
  It validates shape, not geometric validity (ring closure / min vertices are the
  Turf/`@skating/core` layer's job).
- **Dedup-on-create (D36) is stubbed** in `waterBodies.create` (a `TODO`). The pure
  geometry it needs — `polygonIoU`, `pointInPolygon`, `bufferedLineOverlap` (rivers),
  `polygonBBox` — now lives in `@skating/core` with property tests; what remains is the
  Convex-side wiring (bbox prefilter → these helpers → name similarity) + threshold
  tuning against the Phase 1 OSM corpus.

## Offline codegen (why `scripts/codegen.mjs` exists)

"Offline" here means the **build machine has no Convex deployment configured** — not
anything about a user's device being offline. `convex/_generated/` is gitignored (Convex
convention) and the real `convex codegen` hard-refuses without a configured deployment
(`✖ No CONVEX_DEPLOYMENT set`) — which CI doesn't have. `scripts/codegen.mjs` writes the
same files offline so `tsc` and `convex-test` work anywhere, and runs automatically
before `check-types`/`test`. `dataModel.d.ts` derives the model from `typeof schema`
(never needs regenerating on schema edits); `api.d.ts` is derived from the function
modules on disk (adding a `convex/*.ts` updates the typed API). Running `npx convex dev`
locally overwrites these with the identical real output.

When a `convex.config.ts` exists, the script also emits the component handle: a
`componentsGeneric()` in `api.js` and the loosely-typed `components: AnyComponents` stub
in `api.d.ts` — the same stub `convex dev` writes before its first push. The precisely-
typed component form needs live deployment analysis (the one thing we can't do offline),
but installed components re-apply their own types at the call site, so the stub is
sufficient. **Currently dormant** — N1 removed the only component we had.

## Scripts

```bash
pnpm --filter @skating/convex test         # codegen + Vitest (convex-test) + coverage
pnpm --filter @skating/convex check-types  # codegen + tsc --noEmit
pnpm --filter @skating/convex codegen      # regenerate convex/_generated/ offline
```
