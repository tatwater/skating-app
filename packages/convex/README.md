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

- **`convex/schema.ts`** — all 18 entities from `plans/06-data-model.md`, with the
  suggested indexes. Shared vocabulary (ice types, hazards, visibility, roles, …) is
  imported from `@skating/core` via the `literals()` helper so it's single-sourced;
  backend-only enums live in `convex/lib/enums.ts`.
- **`convex/lib/`** — `auth.ts` (identity + role/status gating), `validators.ts`
  (`literals`, `boolFlags`, `latLng`, `bbox`, `geoJson`), `enums.ts`, `geospatial.ts`
  (typed `@convex-dev/geospatial` index of water-body centroids, D5).
- **`convex/convex.config.ts`** — the app definition; `app.use(geospatial)` installs the
  geospatial component (its `components.geospatial` handle powers `lib/geospatial.ts`).
- **`convex/profiles.ts`** — `current` + `upsertFromClerk` (idempotent Clerk→profile
  bridge; enforces the 16+ gate and username uniqueness).
- **`convex/waterBodies.ts`** — user `create` (queued for after-the-fact review, D37;
  indexes the centroid into geospatial), moderator `approve` (pending user bodies only;
  writes the `moderationActions` audit row + syncs the geo filter key), `listInViewport`
  (approved bodies in the map viewport, D5 — interim centroid lookup; bbox-intersection
  is the decided target, see its doc-comment), `listPendingReview`.
- **`convex/*.test.ts`** — `convex-test` suites: auth/role/suspension gating, upsert
  idempotency + age/username invariants, the approve→audit-log path.

## Deviations & deferrals (flagged for review)

- **`profiles` renames the doc's `users` table.** Per the identity model above;
  `plans/06-data-model.md` and `01-decisions.md` (D26) have been reconciled to match.
  `clerkUserId` (+ `by_clerk_user_id` index) is the Clerk tie the doc didn't spell out.
- **Geospatial (D5) is wired for centroids; the bbox-intersection refine remains.**
  `@convex-dev/geospatial` indexes water-body centroids (`waterBodies.create`/`approve`)
  and `listInViewport` does an interim centroid-in-viewport lookup with an approved-only
  filter. The decided target is **bbox-intersection** (a large lake shows when its bbox
  overlaps the viewport, even if its centroid is off-screen) via an expanded geospatial
  prefilter + `@skating/core`'s `bboxIntersects` refine — see the `listInViewport`
  doc-comment. Still deferred: that refine, indexing `reports.point`, and tightening
  `geoJson` from `v.any()` to a structured validator.
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
but installed components re-apply their own types at the call site (see the
`ConstructorParameters` assertion in `lib/geospatial.ts`), so the stub is sufficient.

## Scripts

```bash
pnpm --filter @skating/convex test         # codegen + Vitest (convex-test) + coverage
pnpm --filter @skating/convex check-types  # codegen + tsc --noEmit
pnpm --filter @skating/convex codegen      # regenerate convex/_generated/ offline
```
