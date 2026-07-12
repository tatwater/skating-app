# @skating/mobile

The **Expo / React Native** app — the primary surface for field ice-reporting (D1/D8).
Barebones Phase 0 shell: auth-gated tab navigation, themed via shared design tokens,
wired to Clerk + Convex + Sentry. Each screen is a placeholder to be deep-dived in its
own later-phase PR.

## Stack

- **Expo SDK 57** (new architecture), **Expo Router** tab navigation (D28), EAS
  dev-client workflow with Continuous Native Generation — no committed `ios/`/`android/`.
- **Tamagui** for UI, projecting `@skating/design` tokens (D7) — see `tamagui.config.ts`.
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
  about.tsx                  # license disclosure (AGPL-3.0 + App Store exception, D43)
src/
  providers/Providers.tsx    # Clerk → Convex → Tamagui → SafeArea
  lib/                       # env, convex client, sentry init, DOB parsing, risk-ack
  components/                # shared UI (PlaceholderScreen)
tamagui.config.ts            # design-token → Tamagui bridge
app.config.ts                # dynamic Expo config (single source of truth; no app.json)
```

## Setup

```bash
cp .env.example .env.local     # then fill in real keys (see below)
```

`.env.local` (gitignored) holds three **public** client keys (Metro inlines `EXPO_PUBLIC_*`):

| Var | What | Where from |
|---|---|---|
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk client key (`pk_…`) | Clerk dashboard → API keys |
| `EXPO_PUBLIC_CONVEX_URL` | Convex deployment URL | `npx convex dev` / Convex dashboard |
| `EXPO_PUBLIC_SENTRY_DSN` | Sentry client DSN | Sentry project settings |

The app boots with placeholders — sign-in, data, and crash reporting simply stay inert
until real keys land. Clerk also needs a JWT template named `convex` (D26) and the
`CLERK_JWT_ISSUER_DOMAIN` env var set on the Convex deployment.

## Run (dev build — not Expo Go)

Native modules (secure-store, Sentry, and later `@rnmapbox/maps`) need a **dev build**,
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

## Deferred (later phases, intentionally not here)

- MapLibre renderer `@rnmapbox/maps` (Phase 2) — the Map tab is a placeholder for now.
- Offline draft queue + image pipeline: `expo-sqlite`/`expo-file-system`/
  `expo-image-manipulator`/NetInfo (Phase 2, D30/D31).
- PostHog analytics/session replay (D29, "later").
- Component-level `@testing-library/react-native` rendering under Vitest — needs extra
  RN transform config; added as real screens arrive.
- Tab icons and the full FUI visual pass (styling deep-dive PR).

> **Adding a config plugin:** because we use a dynamic `app.config.ts` (no `app.json`),
> `npx expo install <pkg>` can't auto-register plugins — add them to the `plugins` array
> in `app.config.ts` by hand.
