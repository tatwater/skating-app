# @skating/mobile

The **Expo / React Native** app — the primary surface for field ice-reporting (D1/D8).
Auth-gated tab navigation, themed via shared design tokens, wired to Clerk + Convex + Sentry.
**Phase 2 F1** built the online map + report loop (native MapLibre map, tap→detail→feed, report
create with photos); **Phase 2 F2** added the offline draft queue (capture with no signal → flush on
reconnect). Newsfeed / Bounties / You stay placeholders for their later phases.

## Stack

- **Expo SDK 57** (new architecture), **Expo Router** tab navigation (D28), EAS
  dev-client workflow with Continuous Native Generation — no committed `ios/`/`android/`.
- **Tamagui** for UI, projecting `@skating/design` tokens (D7) — see `tamagui.config.ts`.
- **`@maplibre/maplibre-react-native`** map (Phase 2 §F): reads the same Protomaps `.pmtiles`
  basemap as web via the native `pmtiles://` scheme (no Mapbox token), and reuses the web basemap
  style/palette (`src/lib/waterMap.ts`). Detail + report create render in a `@gorhom/bottom-sheet`
  drawer over a persistent map (`app/(tabs)/(map)/`), URL-backed + deep-linkable (`/water/[id]`,
  `/report/[id]`). Photo pipeline: `expo-image-picker` (EXIF) + `expo-image-manipulator` (resize +
  EXIF strip). Report/display logic is shared from `@skating/core` (`reportForm`/`reportView`).
- **Clerk** auth (`@clerk/clerk-expo`) wired to **Convex** via `ConvexProviderWithClerk`
  (D26/D2). Session tokens persist in the device keychain (`expo-secure-store`).
- **Sentry** crash/error reporting from day one (D29).
- **Vitest** for logic tests (D40).

## Layout

```
app/                         # Expo Router routes (file-based)
  _layout.tsx                # Sentry wrap + providers + auth-gated Stack.Protected
  (auth)/                    # signed-out flow — sign-in, sign-up (16+ gate + risk ack)
  (tabs)/                    # Map · Newsfeed · ＋Report · Bounties · You
    (map)/                   # persistent map + bottom-sheet drawer: index, water/[id], report/[id]
  about.tsx                  # license disclosure (AGPL-3.0 + App Store exception, D43)
src/
  providers/Providers.tsx    # Clerk → Convex → Tamagui → SafeArea
  lib/                       # env, convex client, sentry, risk-ack, waterMap + photo helpers
  components/                # MapView, MapDrawer, WaterBody/Report detail, ReportForm, photoPipeline
tamagui.config.ts            # design-token → Tamagui bridge
app.config.ts                # dynamic Expo config (single source of truth; no app.json)
```

## Setup

```bash
cp .env.example .env.local     # then fill in real keys (see below)
```

`.env.local` (gitignored) holds two kinds of var. **Client** keys are inlined into the JS
bundle by Metro (`EXPO_PUBLIC_*`) and are therefore public by construction — only ever put
publishable keys here. **Build** vars are read by `app.config.ts` at native-build time (the
`@sentry/react-native/expo` plugin) and never reach the bundle.

| Var | Kind | What | Where from |
|---|---|---|---|
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | client | Clerk client key (`pk_…`) | Clerk dashboard → API keys |
| `EXPO_PUBLIC_CONVEX_URL` | client | Convex deployment URL | `pnpm convex-dev` / Convex dashboard |
| `EXPO_PUBLIC_PMTILES_URL` | client | Basemap `.pmtiles` URL (public; **blank ⇒ the Protomaps demo, which is dev-only and expires — it will 404**) | The self-hosted extract's serving URL — the **same value as web's `VITE_PMTILES_URL`**; see [`scripts/basemap`](../../scripts/basemap/README.md) |
| `EXPO_PUBLIC_BATHYMETRY_PMTILES_URL` | client | Bathymetric-contour `.pmtiles` (N6b) — a *second* archive, added to the style only while a lake drawer is open. **Blank ⇒ the layer never mounts** | Same R2 bucket as the basemap; see [`scripts/bathymetry`](../../scripts/bathymetry/README.md) |
| `EXPO_PUBLIC_SENTRY_DSN` | client | Sentry client DSN | Sentry project settings |
| `EXPO_PUBLIC_OFFLINE_BASEMAP` | client | **Optional, off by default.** `1` enables the unverified Layer-3 offline-basemap spike (`src/lib/offlineBasemap.ts`). Leave blank unless you're actively testing it | n/a — a local flag |
| `SENTRY_ORG` | build | Sentry org slug. **Falls back to `PLACEHOLDER_ORG`**, which silently breaks source-map upload — check with `eas config` | Sentry settings |
| `SENTRY_PROJECT` | build | Sentry project slug — same silent-fallback caveat | Sentry settings |
| `SENTRY_AUTH_TOKEN` | build | Uploads source maps so stack traces symbolicate. **Secret — never commit; store in EAS only** | Sentry → auth tokens |

The app boots with placeholders — sign-in, data, and crash reporting simply stay inert
until real keys land. Clerk also needs a JWT template named `convex` (D26) and the
`CLERK_JWT_ISSUER_DOMAIN` env var set on the Convex deployment.

### `.env.local` vs. EAS environments

`.env.local` covers **local** builds (`pnpm --filter @skating/mobile android|ios`) and Metro.
A **cloud EAS build never sees it** — the file is gitignored, so it isn't uploaded. Cloud builds
read the same vars from the **EAS environment** named by the build profile's `environment` field
in `eas.json`. Forgetting this is the classic failure: the build succeeds, then the app launches
with no sign-in, no data, and a 404ing basemap.

| EAS environment | Populated? |
|---|---|
| `development` | ✅ all 8 (the 5 required client keys + 3 Sentry build vars) |
| `preview` | ✅ all 8 |
| `production` | ❌ empty — prod deployment is still deferred |

`EXPO_PUBLIC_OFFLINE_BASEMAP` is deliberately **not** in any EAS environment: it's an opt-in
experiment that should stay off in shared builds.

```bash
eas env:list --scope project --environment preview    # what's stored
eas config --profile preview --platform android      # what the build will actually resolve
```

Keep the two in sync by hand — nothing reconciles `.env.local` against EAS for you.

## Run (dev build — not Expo Go)

Native modules (secure-store, Sentry, and the `@maplibre/maplibre-react-native` map) need a **dev build**,
so Expo Go won't work (D8). Build once per platform, then iterate over the JS with Metro:

```bash
pnpm --filter @skating/mobile start          # Metro dev server (--dev-client)
# then install a dev build on a simulator/device — see EAS below
```

## EAS (you own this — needs your Expo account)

`eas.json` is committed with `development` / `preview` / `production` profiles. First-time
setup, from `apps/mobile/`:

1. **Install & log in** (once, globally):
   ```bash
   npm i -g eas-cli
   eas login
   ```
2. **Link the project** — creates the EAS project and writes `owner` + `extra.eas.projectId`
   into `app.config.ts`:
   ```bash
   eas init
   ```
3. **Build a dev client** (cloud build on Expo's infra):
   ```bash
   eas build --profile development --platform ios      # or android, or `--platform all`
   ```
   Install the resulting build on a simulator/device, then run `pnpm --filter
   @skating/mobile start` and open it.
4. **Store the build-time secrets** Sentry needs for source-map upload (never commit these):
   ```bash
   eas env:create --name SENTRY_AUTH_TOKEN --scope project --visibility secret
   eas env:create --name SENTRY_ORG --scope project
   eas env:create --name SENTRY_PROJECT --scope project
   ```

Prerequisites to have ready: an **Expo account**, and (for iOS device builds) **Apple
Developer** enrollment — both are on the Phase 0 lead-time list.

## Test / typecheck

```bash
pnpm --filter @skating/mobile test          # Vitest (logic) + coverage
pnpm --filter @skating/mobile check-types   # tsc --noEmit
npx expo-doctor                             # project health
```

## Offline draft queue (Phase 2 F2, D30)

Capture a report with no signal; it flushes on reconnect. The pure heart lives in `@skating/core`
(a buffered `pointInPolygon` GPS→lake resolver + a checkpointed, idempotent flush state machine),
so this app is the native adapter:

- **`lib/bodyCache.ts` (Layer 2):** an `expo-sqlite` LRU of recently-viewed body polygons (cached on
  every `waterBodies.get`), so a device GPS fix resolves *which* lake you're on offline via the
  shared buffered ranker (a ~300 m parking/approach buffer). Reused by Phase 9 hazard capture.
- **`lib/draftStore.ts` + `lib/draftPhotos.ts`:** the draft list (`expo-sqlite`) + captured photos
  copied into the document dir (`expo-file-system`, safe from cache eviction).
- **`lib/flushService.ts` + `OfflineDraftsContext`:** wires the core flush to Convex (idempotent
  `reports.create` on `reports.idempotencyKey`; `waterBodies.resolveBodyForCoord` for a coord-only
  draft) + storage upload; flushes on `@react-native-community/netinfo` reconnect + app-foreground +
  a manual "Sync now" (D12).
- **Capture/edit UI:** the ＋ Report tab is the offline capture entry + drafts list; `draft/new`
  (GPS auto-select) and `draft/[id]` (edit) modal routes; the put-in degrades to "use my current
  location" off-map.

**Offline basemap tiles ("Layer 3") are deferred to Phase 9** — report capture needs only *which
lake* + GPS, not a visible basemap; accurate hazard pins will need it. The body cache is designed to
gain a tile-pack column then.

## Deferred (later phases, intentionally not here)

- PostHog analytics/session replay (D29, "later").
- Component-level `@testing-library/react-native` rendering under Vitest — needs extra
  RN transform config; added as real screens arrive.
- Tab icons and the full FUI visual pass (styling deep-dive PR).

> **Adding a config plugin:** because we use a dynamic `app.config.ts` (no `app.json`),
> `npx expo install <pkg>` can't auto-register plugins — add them to the `plugins` array
> in `app.config.ts` by hand.
