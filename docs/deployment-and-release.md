# Deployment and release

How a change gets from a merged PR onto a phone, a browser and the backend — and, just as
important, what does **not** happen automatically. Three deployables (Convex, web, mobile), each
with its own release mechanics, plus the hand-run data pipelines that feed them.

> **Who this is for.** Whoever is about to ship something and wants to know which command, from
> which directory, against which environment — and what will silently *not* have shipped
> afterwards. Account-level setup (signing up for services, keys, DNS) lives in
> [`plans/05-accounts-and-credentials.md`](../plans/05-accounts-and-credentials.md); this doc is
> the recurring process, not the one-time provisioning.

---

## The one rule: merging deploys nothing except the website

| Deployable | What "deployed" means | Triggered by |
|---|---|---|
| **Convex** backend | functions + schema pushed to a deployment | `convex dev --once` / `convex deploy`, **by hand** |
| **Web** (`apps/web`) | a Vercel build of `main` | Vercel's Git integration, on push |
| **Mobile** (`apps/mobile`) | an APK/IPA on a device, or an OTA JS bundle | `eas build` / `eas update`, **by hand** |
| Tiles + corpus data | `.pmtiles` on R2, rows in Convex tables | `scripts/basemap`, `scripts/etl`, `scripts/imagery`, **by hand** |

CI (`.github/workflows/ci.yml`) lints, type-checks, tests, and pushes the Convex functions to a
*throwaway local backend* to prove they compile and that `convex/_generated` is current. That is
a check, not a deploy: **passing tests and a merged PR leave the dev deployment and every
installed phone exactly as they were.** Forgetting this is the most common way to "test" code
that isn't running — see [`convex-test` ≠ deploy](#convex) below.

---

## Environments

There are two tiers everywhere, and as of 2026-09-14 **only the dev tier has ever been brought
up.** Production is a cutover still ahead of us (see [Prod cutover](#prod-cutover--outstanding)).

| Layer | Dev | Prod |
|---|---|---|
| Convex | `agile-bee-397` (`teagan-atwater:skating-app:dev`) | `diligent-guanaco-965` — **uninitialized** (no functions, no env) |
| Clerk | dev instance `polite-lemming-64` (`pk_test_…`, email-code sign-in only) | prod instance — not yet configured |
| Vercel | preview deployments per PR | `skating-app` project (root `apps/web`) under `teagan-atwaters-projects` — currently *also* points at dev Convex |
| EAS environments | `development`, `preview` — both fully populated, both point at dev Convex + dev Clerk | `production` — **empty** |
| Tiles (R2) | `dev/…pmtiles` keys | `--prod` upload path exists in `scripts/basemap/upload.sh`, never run |
| Email (Resend) | `skating.teaganatwater.com` sending domain, keys on dev Convex only | prod needs its own key |

So today a "preview" phone build, the Vercel production URL and the dev Convex deployment are all
one system. That's fine while there are no real users; it's the thing the cutover ends.

---

## Convex

**Where the functions live:** `packages/convex/convex/`. **Which deployment:**
`packages/convex/.env.local` → `CONVEX_DEPLOYMENT` (gitignored, per checkout).

### Pushing to dev

```sh
pnpm convex-dev --once          # from the repo root of the branch you're testing
```

- **`convex-test` is not a deploy.** The test suite runs against an in-memory backend. After
  changing anything in `convex/`, push before opening the app or nothing you changed is running.
- **One dev deployment, many branches.** Every worktree pushes to the same `agile-bee-397`. A
  push from branch A deletes indexes/tables that only branch B's schema has — so always push
  from the branch you're about to test, and expect another session's push to have undone yours.
- `--once` pushes and exits. Bare `convex dev` stays running and re-pushes on save — useful when
  iterating, wrong when another session shares the deployment.
- Env vars are per-deployment, set via `pnpm convex-dev env set NAME value` (or the dashboard).
  `.env.local` values are read by the **CLI**, never by running functions — a var that is only in
  `.env.local` is not set.

### Schema changes

Convex validates every existing document against the schema on push, so narrowing a field before
the data is migrated fails the push (new code written, no way to run it). The order is always
**widen (old ∪ new) → deploy → paged backfill → narrow**. Indexes on optional fields are not
sparse: `undefined` sorts first, so a bare `lte()` range matches every row lacking the field.

### Pushing to prod (not yet possible)

```sh
pnpm convex-deploy              # = convex deploy; prompts (Y/n), no --yes flag
```

Blocked until `CLERK_JWT_ISSUER_DOMAIN` + `CLERK_SECRET_KEY` are set on prod pointing at the
Clerk **production** instance (`auth.config.ts` reads the issuer at deploy time). For
non-interactive use, drive the prompt with `expect` or set a prod `CONVEX_DEPLOY_KEY`.

### The Convex MCP server

`.mcp.json` runs it. Use `runOneoffQuery` / `logs` / `envList` to inspect a deployment instead of
deploying a throwaway query.

---

## Web (`apps/web`)

Vercel builds from GitHub: every push to `main` is a production deployment at
`skating-app-eight.vercel.app`; every PR gets a preview URL. Nothing to run by hand.

- Env vars are set **on Vercel** (Settings → Environment Variables), per environment. Only
  `VITE_*`-prefixed vars reach the client; build-time ones (`SENTRY_*`, `FONTAWESOME_NPM_AUTH_TOKEN`
  for the private FontAwesome registry via `vercel.json`'s `installCommand`) are not prefixed.
- The Vite build must not resolve the hoisted root `@clerk/shared` v3 — `apps/web` pins v4 locally.
- Before debugging a failed deploy from the CLI, check which account it's on: the CLI on this
  machine has also been logged in as `teagan@newmoneycompany.com`, whose scope has zero projects.
  Use `pnpm dlx vercel` (never `npx`) with `--scope teagan-atwaters-projects`.

---

## Mobile (`apps/mobile`)

Distribution is **EAS internal** — no Play Store / App Store listing. EAS project
`@tatwater/skating-app`, id `bc7e5bb9-9b85-4343-b93c-cdd14cbeeb64`. Run every `eas` command from
`apps/mobile` **of the branch you want to ship** (worktrees included — a build from `main` does
not contain an unmerged branch's code, however plausible the build log looks).

### The three build profiles (`eas.json`)

| Profile | What it produces | Needs the laptop? | Use it for |
|---|---|---|---|
| `development` | **expo-dev-client** shell: native code baked in, JS loaded from a Metro server | **Yes** — opens to Expo's "Development servers" launcher until `pnpm start` is running | iterating on JS with hot reload at your desk; the emulator |
| `preview` | **standalone APK**, JS bundled in, internal distribution | No | real-world testing on your own phone; anything you want to test away from the desk |
| `production` | store-ready binary, `autoIncrement` versioning | No | store submission — never yet run; its EAS environment is empty |

If you install a build and see an Expo UI with Home / Updates / Settings tabs instead of the app,
it's a `development` build with no Metro server — not a broken build. Rebuild with `preview`.

```sh
pnpm exec eas build --profile preview --platform android --no-wait
pnpm exec eas build:view <id> --json          # poll; rejects --non-interactive
```

Free-tier queue time is ~20 min before a ~20 min compile. The finished build's page has an
**Install** button + QR code; the `applicationArchiveUrl` in `build:view --json` is a direct APK
link that opens on the phone. Same package name (`com.teaganatwater.gli`) across profiles, so a
preview install replaces a dev-client install.

### Rebuild vs OTA update

`runtimeVersion: {policy: 'fingerprint'}` hashes the **native layer** (deps, config plugins,
permission strings, `google-services.json`, SDK). That hash is the interlock:

- **JS/asset-only change** → the fingerprint holds → publish an **EAS Update** and every install
  on that channel picks it up on next launch, no rebuild:
  ```sh
  pnpm exec eas update --channel preview --environment preview --message "…"
  ```
  (`--environment` is required with `--non-interactive`.) Channel `preview` → branch `preview`;
  the mapping is in `eas.json`.
- **Any native change** (new module, plugin, permission, SDK bump, adding/removing
  `google-services.json`) → the fingerprint changes → EAS simply won't offer the update to old
  builds. A fresh `eas build` + reinstall is the only path. There is no way to pin an OTA to an
  installed build's fingerprint.

### The fingerprint must agree on both sides

EAS computes the fingerprint locally *and* on the builder and hard-fails at
`CONFIGURE_EXPO_UPDATES` — before compiling anything — if they differ. Two known ways to trip it:

1. **`google-services.json` present on one side only.** It's gitignored; locally it sits at
   `apps/mobile/google-services.json`, on EAS it arrives as the *file* env var
   `GOOGLE_SERVICES_JSON`. Keep it in both places (in **every** EAS environment you build from)
   or neither. Worktrees each need their own copy — it isn't tracked, so it doesn't follow a
   checkout.
2. **A dependency that hashes differently on the builder** despite matching byte-for-byte
   (`@react-native-masked-view/masked-view`, 2026-08-26). Waived in `apps/mobile/.fingerprintignore`,
   which documents the cost.

Diagnose without spending a build: `eas fingerprint:compare --build-id <id> --json` and diff
`sources` by `filePath`. `--clear-cache` does not help — the fingerprint is computed after the
cache restores.

### Environment variables live in three places, and nothing reconciles them

Cloud builds upload the repo via git, so anything gitignored is absent on the builder — which is
why `.env.local` never reaches a build and **`packages/convex/convex/_generated/` must stay
committed** (the failure looks like `Unable to resolve module @skating/convex/api`, not like a
gitignore problem). When you add a client env var, add it to:

1. `apps/mobile/.env.local` (local Metro / emulator),
2. the `development` EAS environment,
3. the `preview` EAS environment (and `production`, once it exists).

`eas config --profile preview --platform android` shows what a build will actually see;
`PLACEHOLDER_ORG` in the Sentry plugin output means the environment didn't load. Build profiles
need an explicit `environment` field in `eas.json` or EAS loads no variables at all.

### Credentials on Expo's servers (state as of 2026-09-14)

| Credential | Status | Notes |
|---|---|---|
| Android keystore | ✅ on EAS (`Build Credentials Q16AvUyj_E`) | no local copy — losing EAS access means a new signing identity |
| FCM V1 service-account key (Android push) | ✅ uploaded 2026-09-14 | Firebase project → Service accounts → key; org policy `iam.managed.disableServiceAccountKeyCreation` had to be overridden at the project level to create it (and the project moved under the org first). Existing keys survive re-enforcing the policy. |
| `google-services.json` | ✅ local + `development` + `preview` | see the both-sides rule above |
| APNs push key (iOS push) | ✅ uploaded 2026-09-14 | created manually at developer.apple.com and pasted into `eas credentials` (the Apple-login path failed with `iTunes service key is empty`, an Apple-side error, not a bad password). One key per Apple team, covers every app. |
| iOS distribution cert / provisioning | ⬜ | no iOS build exists yet; needs `eas device:create` for ad-hoc installs |
| `EXPO_ACCESS_TOKEN` (Convex env) | ✅ dev deployment | lets `expoPush.ts` authenticate to Expo's push API; label on expo.dev is `convex-dev-push` |
| `CLERK_WEBHOOK_SIGNING_SECRET` (Convex env) | ✅ dev 2026-09-15 (endpoint registered in the dev Clerk instance) | verifies `POST /clerk-webhook` (`user.updated` → email/avatar mirrors). Route answers 500 until set, on purpose. Per Clerk instance; §11b of the credentials doc. |

`eas credentials` stores an Apple password in the macOS Keychain as an **internet** password,
server `deliver.<apple-id>`; clear a bad one with
`security delete-internet-password -s "deliver.<apple-id>"`, or skip storage with
`EXPO_NO_KEYCHAIN=1`.

### Push notifications end to end

Convex `notificationDelivery.deliverBatch` → Expo push API (bearer `EXPO_ACCESS_TOKEN`) → FCM
(Android) / APNs (iOS) → device. The server never talks to Firebase or Apple directly; both
credentials live on EAS. `pushRegistration` on the device only mints a token after the user turns
a push toggle on (never on launch); a build without `google-services.json` can't mint one and
treats that as "no push on this device". Until the FCM key was in place, deliveries logged
`InvalidCredentials` — that message is the credential smoke test.

---

## Data and tiles (hand-run)

None of these ship with the apps; each is a directory with its own README and is run on demand.
All of them are **config swaps** at the app layer — both apps read every tile URL from env vars,
so publishing a new archive is "upload, then change the URL in the three env places above".

| Pipeline | Output | Where it lands |
|---|---|---|
| `scripts/basemap` | world z0–6 + regional Protomaps archives + mask | R2 `dev/…pmtiles` (`upload.sh`, `--prod` path unrun) |
| `scripts/etl` | the water-body corpus, sub-areas, depth, access points, enrichment | Convex tables via `importCanonical` (`pnpm exec convex run`, internalMutation); provenance to `merge-manifest.json` |
| bathymetry | contour tiles | R2 `dev/bathymetry-<date>.pmtiles` |
| `scripts/imagery` | seasonal satellite/aerial granules | R2 (Fly machines do the render; read the README's "Four ways to get this wrong" first) |

Corpus loads can cost real Convex I/O: the N6d access-points load did 105 GB and disabled the
deployment. Always pass `marginMeters` to `listedBodiesNearCoord`, and run big loads
`--batch=1` where the README says so.

---

## Pre-PR checklist

One PR per phase, sub-workstreams as separate commits (reviews are metered). Before opening:

```sh
/code-review xhigh --fix <base>..<head>     # spell out the range
pnpm test && pnpm check-types && pnpm lint
```

Then `pnpm convex-dev --once` from that branch and actually exercise the change in the app —
CI proves it compiles, not that it works. Check for a pre-created PR before `gh pr create`.

---

## Prod cutover — outstanding

Everything below is unstarted; it's the list that turns "one dev system" into two tiers. Owner
of every line is the founder — they are provisioning decisions, not code.

1. **Clerk production instance** → `CLERK_JWT_ISSUER_DOMAIN` + `CLERK_SECRET_KEY` on prod Convex
   (`convex env set --prod`), never dev's values.
2. **First `convex deploy`** — unblocked by (1). Then the ETL `--prod` corpus load (prod has no
   bodies), and `backfillCells`.
3. **Resend prod key** + the three email vars on prod; the checklist (including why there is
   deliberately no MX record) is in `plans/phases/07-operator-surface.md` § "Resend checklist".
4. **Tiles**: `scripts/basemap/upload.sh … --prod`, then the prod tile URLs on Vercel and in the
   `production` EAS environment.
5. **Vercel**: point production at prod Convex/Clerk; keep previews on dev.
6. **EAS `production` environment**: populate all vars (+ `GOOGLE_SERVICES_JSON`); the FCM key and
   APNs key are per-app, so they carry over.
7. **Push**: `EXPO_ACCESS_TOKEN` on prod Convex.
7b. **Clerk webhook**: a new endpoint in the **prod** Clerk instance pointing at
   `https://diligent-guanaco-965.convex.site/clerk-webhook`, its signing secret as
   `CLERK_WEBHOOK_SIGNING_SECRET` on prod Convex. Per-instance, nothing carries over from dev —
   recipe in [`05-accounts-and-credentials.md`](../plans/05-accounts-and-credentials.md) §11b.
8. **Strava callback domain** (Phase 8) on the prod host.
9. First **iOS build**: `eas device:create`, distribution cert via `eas credentials`; push works
   on it with no further setup.

When a line lands, update the [Environments](#environments) table and
[`plans/05-accounts-and-credentials.md`](../plans/05-accounts-and-credentials.md) together.
