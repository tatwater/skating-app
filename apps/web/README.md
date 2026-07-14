# @skating/web

The **TanStack Start** web app — the secondary surface, for keyboard/big-screen planning
and longer reports (D1/D27). Auth-gated routing, themed via shared design tokens, wired to
Clerk + Convex + Sentry. The **Map** (`/`) is the MVP surface: Phase 2 makes it interactive —
tap a lake → read its report feed → post your own (see [Map + reports](#map--reports-phase-2)).
Newsfeed/profile remain placeholders deep-dived in their own later-phase PRs.

## Stack

- **TanStack Start** (Vite 8) with file-based routing (`@tanstack/react-router`). The Start
  plugin owns the server entry and generates `src/routeTree.gen.ts`.
- **Tailwind CSS v4** + **shadcn/ui** components on the **Base UI** variant (`@base-ui/react`,
  `base-nova` style; `components.json`). shadcn's role tokens are aliased onto `@skating/design`
  tokens in `src/styles/app.css` (var-references, so the parity test is unaffected); a `@` → `src`
  alias (tsconfig + `vite.config.ts` + `vitest.config.ts`) resolves shadcn's `@/…` imports.
- **Clerk** auth (`@clerk/tanstack-react-start`) wired to **Convex** via
  `ConvexProviderWithClerk` (D26/D2). Server request middleware lives in `src/start.ts`.
- **next-themes** for the high-contrast/dark theme toggle (D34).
- **Sentry** crash/error reporting from day one (D29), on **both** the client (`instrument.client.ts`,
  loaded first by `client.tsx`, + router-aware browser tracing) and the **server**
  (`instrument.server.ts` + `wrapFetchWithSentry` in `server.ts` + global request/function
  middleware in `start.ts`), plus a root `Sentry.ErrorBoundary`. The `sentryTanstackStart` Vite
  plugin uploads source maps when a build token is set. Session Replay is intentionally off (D29).
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
    _map.tsx                 # pathless layout: one persistent MapView + <Outlet/> for drawers
    _map.index.tsx           # /            (bare map)
    _map.water.$id.tsx       # /water/$id   (water-body detail drawer, deep-linkable)
    _map.report.$id.tsx      # /report/$id  (report detail drawer, deep-linkable)
    feed.tsx                 # Newsfeed (placeholder)
    u.$username.tsx          # profile (incl. your own)
    settings.tsx  about.tsx  # account hub (the "You" analog) · licenses (D43)
    sign-in.tsx  sign-up.tsx # Clerk prebuilt <SignIn>/<SignUp>
    onboarding.tsx  reack.tsx# profile provisioning · risk-ack renewal
  components/
    AppProviders.tsx         # Clerk → Convex → theme
    AuthGate.tsx             # shared resolveAuthRoute → redirect (mobile parity, D7)
    AppShell.tsx             # signed-in nav chrome
    MapView.tsx              # interactive MapLibre map — client-only WebGL shell
    MapSelectionContext.tsx  # drawers → map: highlight / fly-to / photo pins / put-in pin
    DetailSheet.tsx          # non-modal drawer shell (keeps the map tappable behind it)
    DrawerStates.tsx         # shared loading + not-available drawer panels
    WaterBodyDetail.tsx      # water-body drawer: area + report feed + "Add a report"
    ReportDetail.tsx         # report drawer: fields (imperial) + photos + author
    ReportForm.tsx           # report create form (Dialog) + presentational ReportFormFields
    photoPipeline.ts         # HEIC decode → EXIF read → optimize/strip → upload (browser-only)
    ui/                      # shadcn/ui (Base UI): button, card, badge, sheet, dialog, …
  lib/                       # env, links, riskAck, authZone, waterMap, mapSelection,
                             #   reportDisplay, reportForm, photo (+ tests)
  styles/app.css             # Tailwind + design-token → CSS-variable bridge (+ shadcn aliases)
  router.tsx  start.ts       # router factory (+ Sentry tracing) · Clerk + Sentry middleware
  client.tsx  server.ts      # client + server entries (each loads its Sentry instrument first)
  instrument.client.ts       # client Sentry.init (D29)
  instrument.server.ts       # server Sentry.init (D29)
```

Auth-route resolution (`resolveAuthRoute`) and DOB parsing (`parseDateOfBirth`) are shared
with mobile via `@skating/core` (D7) — this app only adds the web-specific redirect mapping
(`src/lib/authZone.ts`).

## Map + reports (Phase 2)

The Map page (`/`) is an **interactive** MapLibre GL map (D5/D6/D47/D48/D49). One `MapView` stays
mounted under a pathless `_map` layout so pan/zoom survive opening a drawer; the map's viewport bbox
**and current integer zoom** drive `waterBodies.listInViewport`, where the zoom powers the **D49**
in-query prominence filter (wide views return the few prominent bodies — a boosted Lake Morey
guaranteed — not a read-capped slice). On open it frames on the browser geolocation fix when inside
the pilot region (D12/D20), else the default Vermont view. WebGL needs the DOM, so it's **client-only**
(a mounted gate) and the pure logic (style, feature/viewport transforms, framing, feature-id lookup)
lives in the testable `src/lib/waterMap.ts` while `components/MapView.tsx` is the untestable WebGL
shell (coverage-excluded via the `src/lib`-only coverage `include`).

**The loop (D47).** Tapping a lake highlights it (MapLibre feature-state) and opens a **drawer**
(shadcn `Sheet`, non-modal so the map stays usable behind it). Selection is **URL-backed and
deep-linkable** — `/water/$id` (detail: area, report feed by skate time, "Add a report") and
`/report/$id` (a report's fields in imperial, photos, author). Both silently follow a merged body to
its survivor and show a friendly "not available" panel for a removed/unlisted target. The drawers
push highlight / fly-to / photo pins up to the map via `MapSelectionContext`.

**Report create (§E).** "Add a report" opens a form (`Dialog`) — ice types / surface tags / quality /
sky / precip on toggle groups, multi-reading thickness (value ⇄ range, measured/estimated), manual
conditions, notes, skate time, visibility (**clamped to the author's ceiling**, D41), and an optional
**put-in pin** the skater drops on the map (arms a pin-drop mode; sets `reports.point`). Imperial
input → metric storage (D25) via the pure `src/lib/reportForm.ts`, validated by `@skating/core`'s
`validateReportInput` before submit. **Photos** run a browser-only pipeline (`components/photoPipeline.ts`):
HEIC→JPEG decode (`heic2any`) → EXIF GPS read (`exifr`) **before** a downscale + EXIF-strip re-encode
(`browser-image-compression`) → Convex storage upload → `photos.create`, with the GPS coord sent
**only** on the per-photo `placeOnMap` opt-in (D31/D42; the server re-drops it regardless). The web
form is ephemeral (no drafts — that's the mobile offline queue, D30).

**Basemap.** `VITE_PMTILES_URL` picks the Protomaps `.pmtiles` vector source; blank falls back to
the **hosted demo** (whole-planet — fine for local dev, but Protomaps asks it not ship to prod).
PR#5 built a **self-hosted Vermont extract** (z0–14, ~280 MB) served from **Convex file storage**
and set that var to the serving URL — a config swap, no code change. Build/host/wire steps live in
[`scripts/basemap`](../../scripts/basemap/README.md); the URL is deployment-specific (dev vs prod),
so set it per environment (local `.env` + Vercel). Font/sprite assets stay on Protomaps' hosted CDN.
**Attribution** ("© OpenStreetMap contributors", ODbL) is always visible via a non-compact
`AttributionControl` — a launch gate (`04-integrations.md`) — and is independent of the tile host.

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
| `VITE_PMTILES_URL` | Basemap `.pmtiles` URL (public; blank ⇒ Protomaps hosted demo) | The self-hosted Vermont extract's Convex serving URL — see [`scripts/basemap`](../../scripts/basemap/README.md). Blank falls back to the demo (dev only) |
| `VITE_SENTRY_DSN` | Sentry DSN — drives client **and** server (optional) | A **separate** `skating-web` Sentry project (same org as mobile) → project settings |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Source-map upload target (build-time; set on Vercel) | Sentry org slug + the `skating-web` project slug |
| `SENTRY_AUTH_TOKEN` | Enables source-map upload (build-time; set on Vercel) | Sentry → auth tokens. Absent ⇒ upload skipped, build still succeeds |

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

- Low-detail outlines + lazy-load full geometry on tap (a query-payload lever, Phase 2+).
- Report **comments** (Phase 3); **bounties** on the map (D47, later); real **Newsfeed** (Phase 6).
- **Follow graph** — `friends`/`followers` visibility resolve to author-only until Phase 3 (the
  filter already runs through `@skating/core`'s `canViewReport`, so it flips on with no re-write).
- **Offline draft queue** + native map — the mobile follow-on PR (§F, D9/D30). The web form is
  ephemeral by design.
- Signed-out viewing of `public` bodies/reports (deep links are auth-gated for the alpha).
- PostHog analytics/session replay (D29, "later").
- Clerk component theming to match the FUI palette; a richer auth-flow polish pass.
- Deeper component test coverage as real screens land.
