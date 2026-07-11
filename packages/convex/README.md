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
  (`literals`, `boolFlags`, `latLng`, `bbox`, `geoJson`), `enums.ts`.
- **`convex/profiles.ts`** — `current` + `upsertFromClerk` (idempotent Clerk→profile
  bridge; enforces the 16+ gate and username uniqueness).
- **`convex/waterBodies.ts`** — user `create` (queued for after-the-fact review, D37),
  moderator `approve` (pending user bodies only; writes the `moderationActions` audit
  row), `listPendingReview`.
- **`convex/*.test.ts`** — `convex-test` suites: auth/role/suspension gating, upsert
  idempotency + age/username invariants, the approve→audit-log path.

## Deviations & deferrals (flagged for review)

- **`profiles` renames the doc's `users` table.** Per the identity model above; update
  `plans/06-data-model.md` to match. `clerkUserId` (+ `by_clerk_user_id` index) is the
  Clerk tie the doc didn't spell out.
- **Geospatial indexing is deferred (D5).** Point/`bbox`/GeoJSON fields match the data
  model, but the `@convex-dev/geospatial` component and Turf.js polygon tests aren't
  wired yet; `geoJson` is `v.any()` for now. This is the next big Convex task.
- **Dedup-on-create (D36) is stubbed** in `waterBodies.create` (a `TODO`), pending the
  bbox-prefilter + Turf machinery.

## Offline codegen (why `scripts/codegen.mjs` exists)

`convex/_generated/` is gitignored (Convex convention) and the real `convex codegen`
needs a configured deployment — which CI doesn't have. `scripts/codegen.mjs` writes
the same files offline so `tsc` and `convex-test` work anywhere, and runs automatically
before `check-types`/`test`. `dataModel.d.ts` derives the model from `typeof schema`
(never needs regenerating on schema edits); `api.d.ts` is derived from the function
modules on disk (adding a `convex/*.ts` updates the typed API). Running `npx convex dev`
locally overwrites these with the identical real output.

## Scripts

```bash
pnpm --filter @skating/convex test         # codegen + Vitest (convex-test) + coverage
pnpm --filter @skating/convex check-types  # codegen + tsc --noEmit
pnpm --filter @skating/convex codegen      # regenerate convex/_generated/ offline
```
