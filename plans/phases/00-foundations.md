# Phase 0 build record — Foundations

> **Status:** ✅ Complete (2026-07-12), PRs #1–#6. Phase 0 never had a plan doc of its own — the roadmap entry was its only record. This file is that entry, moved here verbatim in the 2026-09-16 roadmap rewrite so the roadmap can carry a summary and the detail has a home.

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

