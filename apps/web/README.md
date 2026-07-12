# @skating/web

The **TanStack Start** web app — the secondary surface, for keyboard/big-screen planning
and longer reports (D1/D27). Barebones Phase 0 shell: auth-gated routing, themed via shared
design tokens, wired to Clerk + Convex + Sentry. Each page is a placeholder to be
deep-dived in its own later-phase PR.

## Stack

- **TanStack Start** (Vite 8) with file-based routing (`@tanstack/react-router`). The Start
  plugin owns the server entry and generates `src/routeTree.gen.ts`.
- **Tailwind CSS v4** + **shadcn**-style components, projecting `@skating/design` tokens via
  a CSS-variable bridge (D7) — see `src/styles/app.css` and its parity test.
- **Clerk** auth (`@clerk/tanstack-react-start`) wired to **Convex** via
  `ConvexProviderWithClerk` (D26/D2). Server request middleware lives in `src/start.ts`.
- **next-themes** for the high-contrast/dark theme toggle (D34).
- **Sentry** client-side crash/error reporting from day one (D29).
- **Vitest** (+ Testing Library / jsdom) for logic, components, and the token-parity guard.

## Navigation (D28/D47)

Two co-primary top-level pages — **Map** (`/`, default) and **Newsfeed** (`/feed`). Creating
a report is surfaced *in place* on both, and bounties on the map — there are **no** standalone
`/report` or `/bounties` pages (D47). Profiles are their own page (`/u/:username`). Auth +
provisioning use the same gate as mobile: `sign-in` → `sign-up` → `onboarding` (collects
username + display name + DOB + risk ack) → `reack` (renew consent after a version bump).

```
src/
  routes/                    # file-based routes
    __root.tsx               # HTML shell + providers + AuthGate
    index.tsx  feed.tsx      # Map (default) · Newsfeed
    u.$username.tsx          # profile (incl. your own)
    settings.tsx  about.tsx  # account hub (the "You" analog) · licenses (D43)
    sign-in.tsx  sign-up.tsx # Clerk prebuilt <SignIn>/<SignUp>
    onboarding.tsx  reack.tsx# profile provisioning · risk-ack renewal
  components/
    AppProviders.tsx         # Clerk → Convex → theme
    AuthGate.tsx             # shared resolveAuthRoute → redirect (mobile parity, D7)
    AppShell.tsx             # signed-in nav chrome
    ui/                      # shadcn-style button / input / label
  lib/                       # env, sentry, links, riskAck, authZone (+ tests)
  styles/app.css             # Tailwind + design-token → CSS-variable bridge
  router.tsx  start.ts       # router factory · Clerk server middleware
```

Auth-route resolution (`resolveAuthRoute`) and DOB parsing (`parseDateOfBirth`) are shared
with mobile via `@skating/core` (D7) — this app only adds the web-specific redirect mapping
(`src/lib/authZone.ts`).

## Setup

```bash
cp .env.example .env     # then fill in real keys (see below)
```

`.env` (gitignored) holds:

| Var | What | Where from |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk client key (`pk_…`) — read server-side by the SDK | Clerk dashboard → API keys |
| `CLERK_SECRET_KEY` | Clerk secret (`sk_…`) — **server-only** | Clerk dashboard → API keys |
| `VITE_CONVEX_URL` | Convex deployment URL (public, client) | `pnpm convex-dev` / Convex dashboard |
| `VITE_SENTRY_DSN` | Sentry client DSN (optional) | A **separate** `skating-web` Sentry project (same org as mobile) → project settings |

Sentry uses its **own project** (`skating-web`), distinct from the mobile app's project but
in the same org (D29): the two surfaces run different SDKs and ship on different cadences, so
separate projects keep releases, source maps, issues, and alerts clean per platform. A DSN is
per-project, so `VITE_SENTRY_DSN` is the web project's DSN — never the mobile one.

Convex/Sentry fall back to inert placeholders, so the app **builds** without them. **Clerk is
different from mobile:** `@clerk/tanstack-react-start` reads its keys server-side and expects
them present, so a real Clerk key pair is needed to *run* the dev server (build/CI don't need
it). Clerk also needs a JWT template named `convex` and `CLERK_JWT_ISSUER_DOMAIN` set on the
Convex deployment (D26) — same as mobile.

## Run

```bash
pnpm --filter @skating/web dev     # http://localhost:3000
```

## Deploy (Vercel — you own this)

Vercel is the target (D27). On first deploy: create a project from this repo, set the
**Root Directory** to `apps/web`, add the env vars above as project env, and let Vercel
detect TanStack Start. If the auto-detected build target needs pinning, set it on the
`tanstackStart({ target: 'vercel' })` plugin option in `vite.config.ts` — confirm on the
first deploy. (Prereq: a Vercel account, on the Phase 0 lead-time list.)

## Test / typecheck

```bash
pnpm --filter @skating/web test          # Vitest (+ coverage)
pnpm --filter @skating/web check-types   # tsc --noEmit
pnpm --filter @skating/web build         # production build (regenerates routeTree.gen.ts)
```

## Deferred (later phases, intentionally not here)

- MapLibre renderer (Phase 2) — the Map page is a placeholder for now.
- In-place report creation + bounties (D47); real Newsfeed (Phase 6).
- Client-side image optimization + EXIF stripping on upload (Phase 2, D31/D42).
- PostHog analytics/session replay (D29, "later").
- Clerk component theming to match the FUI palette; a richer auth-flow polish pass.
- Deeper component test coverage as real screens land.
