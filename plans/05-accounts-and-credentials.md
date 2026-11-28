# Accounts & credentials — the register

Every external account the project depends on, the credential each one yields, and **where that
credential lives** per environment. This is the doc the prod cutover reads; the release mechanics
are [`docs/deployment-and-release.md`](../docs/deployment-and-release.md), the vendor choices are
[`03-tech-stack-options.md`](./03-tech-stack-options.md), and the data sources are
[`04-integrations.md`](./04-integrations.md).

**Kept current by a test.** `packages/guards/src/credentialsRegister.test.ts` collects every
environment variable the backend, the pipelines and the two clients read, and fails the build if
one is missing from § 2 below. Add a variable → add its row in the same PR.

Legend: ✅ set up · ⬜ not yet · ❔ unknown · 🚫 deliberately not · 💰 paid · ⏳ has a lead time

> **Cost posture (D35):** hosted free tiers over self-run infrastructure, under ~$100/mo at ~1,000
> users. The paid rows below are the whole bill.

---

## 1. The account register

### Platform and tooling

| Account | For | Dev | Prod | Credential → where it lives | Notes |
| --- | --- | --- | --- | --- | --- |
| **Convex** — project `skating-app` | database, functions, file storage | ✅ `agile-bee-397` | ⬜ `diligent-guanaco-965` **uninitialized** | deployment env vars (§ 2a) · `CONVEX_DEPLOYMENT` in `packages/convex/.env.local` · `CONVEX_DEPLOY_KEY` for loaders and `convex deploy` | the cutover's first blocker is Clerk's prod vars (D-and-R doc § Prod cutover) |
| **Clerk** — instance `polite-lemming-64` | auth on both surfaces | ✅ dev instance, email-code only | ⬜ prod instance not configured | `CLERK_SECRET_KEY` + `CLERK_JWT_ISSUER_DOMAIN` + `CLERK_WEBHOOK_SIGNING_SECRET` on Convex · publishable key in both clients | webhook endpoint is **per instance** (§ 3c); password sign-in can never complete on dev |
| **Vercel** — `skating-app` under `teagan-atwaters-projects` (`desk@…`) | web hosting, previews per PR | ✅ | (same project; points at dev Convex) | `VITE_*` + Clerk keys + `SENTRY_AUTH_TOKEN` in project env | ⚠ the CLI logs into the wrong account easily (`newmoneycompany`, 0 projects) |
| **Expo / EAS** | mobile builds, updates, push | ✅ `development` + `preview` environments | ⬜ `production` environment **empty** | EAS environments carry the `EXPO_PUBLIC_*` set + `GOOGLE_SERVICES_JSON` (file) + `SENTRY_AUTH_TOKEN` + `FONTAWESOME_NPM_AUTH_TOKEN`; `EXPO_ACCESS_TOKEN` (label `convex-dev-push`) on Convex | Android keystore lives **only** on EAS (`Build Credentials Q16AvUyj_E`) |
| **Apple Developer Program** 💰 $99/yr | iOS builds, APNs | ✅ enrolled | — | APNs key uploaded to EAS 2026-09-14 (made by hand at developer.apple.com) | no iOS build has ever been made; no owned iPhone → [`backlog/ios-distribution.md`](./backlog/ios-distribution.md) |
| **Google Play Console** 💰 $25 once | store distribution, Health Connect review | ⬜ **no account** (founder, 2026-09-17) | — | — | not needed for EAS internal distribution; needed before any Play track or Health Connect adapter |
| **Google Cloud org + Firebase project** | FCM (Android push) | ✅ 2026-09-14 | (same project) | FCM V1 service-account key on EAS; `google-services.json` local + EAS file var | the org-policy override story is § 3b |
| **Sentry** — org `teagan-atwater`, projects `skating-web` + mobile | crash / error | ✅ both | — | DSNs in client env (public); `SENTRY_AUTH_TOKEN` on Vercel + EAS for source maps | |
| **GitHub** — the repo, Actions, Greptile app | CI, review | ✅ | — | Actions secret `FONTAWESOME_NPM_AUTH_TOKEN` | Greptile reviews are metered — one PR per phase |
| **FontAwesome Pro** 💰 one seat | icons | ✅ | — | npm token in `~/.npmrc` (local) + EAS envs + the Actions secret | [`docs/fontawesome-pro.md`](../docs/fontawesome-pro.md); the one recurring paid line item |
| **Figma** | the design system | ✅ | — | — | exports via the SVG pipeline; no key in the repo |
| **Resend** | transactional email | ✅ dev, 2026-09-11 | ⬜ prod needs its own key | `RESEND_API_KEY` + `RESEND_FROM_EMAIL` + `OPERATOR_ALERT_EMAIL` on Convex | sending domain `skating.teaganatwater.com`, CNAME-verified — **no MX, on purpose** (§ 3d) |
| **Squarespace** — DNS for `teaganatwater.com` | Resend's CNAMEs | ✅ | — | — | founder, 2026-09-17; the place to look when mail stops verifying |

### Infrastructure we operate

| Account | For | Dev | Prod | Credential → where it lives | Notes |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare** — R2 | every static artifact and raw archive | ✅ | ⬜ no `prod/` key — `upload-r2.sh <file> prod/<dated-key>` per archive, or point prod at the dated `dev/` objects; the custom domain + cache rule are still on `r2.dev` | one R2 API token per script, in gitignored config: `scripts/basemap/RCLONE_SETUP.md`, each `mirror-r2.sh`'s rclone remote, Fly's staged `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` / `R2_BUCKET` | buckets: `skating-basemap` (basemap ×2, bathymetry; public `r2.dev` subdomain) · `skating-imagery` (the winter frames and their `index/*.json`, served as `VITE_IMAGERY_ARCHIVE_URL` from **its own** public `r2.dev` host at the bucket's root — not `skating-basemap`'s, as this row said until B05 checked it by hosts and names on 2026-11-25, G-6; the summer aerial goes here too, under `dev/naip/`) · `skating-raw-lake-osm` · `skating-raw-lake-depth` · `skating-raw-wind-climate` |
| **Fly.io** 💰 ~$5/mo when cutting | the imagery granule box, per-job Machines | ✅ app `skating-imagery`, region `sjc` | — | `FLY_API_TOKEN` local; `R2_*` + `AWS_*` (anonymous Earth Search reads) staged on the app | read the imagery README's *six ways to get this wrong* before any `fly` command; secrets are `--stage`d and stay "Staged" forever, correctly · Phase B05 (building) runs the summer aerial on the same app under its own image label (`AERIAL_IMAGE`, never `FLY_IMAGE`): the work tiles in `ams`, beside Planetary Computer's blobs, the assembler in `iad` (`FLY_ASSEMBLE_REGION`, beside the bucket — unverified, see `scripts/aerial/README.md`); its archive is in `skating-imagery`, which the staged R2 token already writes, so G-6 needs no new credential |

### Data and API keys

| Account | For | State | Credential → where it lives | Notes |
| --- | --- | --- | --- | --- |
| **OpenRouteService** (HeiGIT) | drive-time isochrones (Phase 04), `foot-hiking` approaches (A06d) | ✅ | `ORS_API_KEY` on Convex; the ETL reads the same key | portal is <https://account.heigit.org>; measured quotas in § 3a |
| **Geoapify** | address autocomplete for a typed home (B03 §11) | ⬜ **no account yet** — the founder creates it; until then `geocode.suggest` answers `off` | `GEOAPIFY_API_KEY` on Convex | free plan, no card: 3,000 credits/day, 5 req/s; the key rides in the query string, so request URLs are never logged; terms and attribution in `04-integrations.md` § Geocoding |
| **NREL WIND Toolkit** | winter wind roses | ✅ | `WIND_TOOLKIT_API_KEY` + `WIND_TOOLKIT_EMAIL`, local `.env` in `scripts/wind-climate` | free, instant at <https://developer.nlr.gov/signup/>; the host moved from `developer.nrel.gov`, hence the variable name |
| **Strava API app** | push to Strava (`activity:write`) | ✅ registered | `STRAVA_CLIENT_ID` + `STRAVA_CLIENT_SECRET` on Convex; `WEB_APP_URL` for the OAuth return | callback domain `agile-bee-397.convex.site` — confirmed on the dashboard 2026-09-20; athlete cap lifted to 10 the same day (new apps start single-player); no real OAuth round-trip has run yet |
| **Google Photos Picker** — OAuth client *Skating App – Photos* in the Firebase Cloud project | the web's *From Google Photos* (A10-8, D207): scope `photospicker.mediaitems.readonly`, one consent per use, no refresh token | ✅ created 2026-09-28 | `GOOGLE_PHOTOS_CLIENT_ID` + `GOOGLE_PHOTOS_CLIENT_SECRET` on Convex | a Web application client; redirect `<WEB_APP_URL>/google-photos/callback` (the web app's page completes the pick as the signed-in person, so the flow reads `WEB_APP_URL` too, and runs only where that page is deployed); the project stays in production (Clerk's Google client shares it, and publishing status is project-wide), so until Google verifies the scope a picker sees the *unverified app* screen, capped at 100 users; verification comes with the store registration (L20); the button stays hidden until both variables are set |

### No account, by design

Sources the pipelines and the app read with no registration, listed so nobody goes looking for one:
**Open-Meteo** (no key; non-commercial free tier, D158) · **NWS `api.weather.gov`** (a `User-Agent`
header only) · **AWS Earth Search** (anonymous STAC; Sentinel-2/-1) · **Microsoft Planetary
Computer** (anonymous STAC and SAS tokens; NAIP for Phase B05's summer aerial, building) · **USGS** — 3DEP EPQS, 3DHP
live, NAIP, The National Map downloads · **Geofabrik** · **US Census TIGER** · **Natural Earth** ·
**Protomaps builds** · the state bathymetry portals (MassGIS, Maine GeoLibrary, NH GRANIT, VCGI,
VT ANR) · **HydroLAKES**, **GLOBathy**, **LAGOS-US** (EDI), **ALSC**, **NYSDEC CSLAP**.

### Not set up, on purpose

| Account | Why not | Trigger |
| --- | --- | --- |
| **Garmin / COROS / Polar** partner programs ⏳ weeks | no applications submitted (founder, 2026-09-17); nothing to build against until one lands | the founder submitting them → [`backlog/partnerships.md`](./backlog/partnerships.md) |
| **Google Health Connect** review | needs the Play account first | with Play |
| **PostHog** | D29 "later"; replay is L12-gated | [`backlog/posthog.md`](./backlog/posthog.md) |
| **Meta / Facebook developer app**, Google Groups access | Q8 / L5 — the inbound bridge is legal-gated | the feasibility + consent pass |
| **Copernicus Data Space** | never needed — Earth Search serves the same data anonymously | a Sentinel product Earth Search lacks |
| **Planet** 💰 quote-based · **Windy** 💰 €990/yr | evaluated and declined/deferred (D75) — [`research/imagery-and-weather-vendors.md`](./research/imagery-and-weather-vendors.md) | Planet: real imagery usage **and** a missed freeze event; Windy: a MapLibre-compatible path |
| **Lawyer** (Q10) | the one engagement that clears L1–L4 + L11 | before any launch past the friends alpha |

---

## 2. Where every secret lives

The same name never means two things, and a value lives in **one** place per environment. Names
only — values are never in the repo.

### 2a. Convex deployment env vars (`pnpm convex-dev env set NAME value`; prod: `--prod`)

Read by running functions only; `.env.local` values are read by the CLI, never by functions.

| Variable | Dev | Prod | Secret? |
| --- | --- | --- | --- |
| `CLERK_JWT_ISSUER_DOMAIN` | ✅ | ⬜ prod instance's | no |
| `CLERK_SECRET_KEY` | ✅ | ⬜ | **yes** |
| `CLERK_WEBHOOK_SIGNING_SECRET` | ✅ 2026-09-15 | ⬜ its own endpoint + secret | **yes** |
| `EXPO_ACCESS_TOKEN` | ✅ | ⬜ | **yes** |
| `ORS_API_KEY` | ✅ | ⬜ | **yes** |
| `GEOAPIFY_API_KEY` | ⬜ owed — once the founder creates the account; absent reads as `off` | ⬜ at cutover | **yes** |
| `RESEND_API_KEY` | ✅ | ⬜ prod key | **yes** |
| `RESEND_FROM_EMAIL` | ✅ `Gli Updates <updates@skating.teaganatwater.com>` | ⬜ | no |
| `OPERATOR_ALERT_EMAIL` | ✅ | ⬜ | no |
| `SUPPORT_FROM_EMAIL` | ⬜ owed — the founder sets it (an address at the sending domain; B01-5f, D284); absent, a support reply reads `failed`, never sent from `RESEND_FROM_EMAIL` | ⬜ | no |
| `SUPPORT_REPLY_TO_EMAIL` | ✅ 2026-11-23 — optional: the mailbox a skater's answer to a support reply goes to (sent as the reply's reply-to); unset, blank or not one address, a reply goes with no reply-to, and sending doesn't wait on it | ⬜ | no |
| `STRAVA_CLIENT_ID` · `STRAVA_CLIENT_SECRET` | ✅ | ⬜ | id no · secret **yes** |
| `GOOGLE_PHOTOS_CLIENT_ID` · `GOOGLE_PHOTOS_CLIENT_SECRET` | ✅ 2026-09-28 | ⬜ | id no · secret **yes** |
| `WEB_APP_URL` | ✅ the Vercel deployment URL | ⬜ the prod URL | no |
| `IMAGERY_ARCHIVE_URL` | ⬜ owed — A06i live imagery; the same base as web's `VITE_IMAGERY_ARCHIVE_URL` | ⬜ | no |
| `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_ENDPOINT` · `R2_BUCKET` | ⬜ owed — A06i lists `frames/` and writes `index/` in `skating-imagery` (`R2_BUCKET` defaults to it) | ⬜ | key id no · secret **yes** |
| `FLY_API_TOKEN` · `FLY_IMAGE` · `FLY_APP` · `FLY_REGION` | ⬜ owed — A06i spawns cut Machines; `FLY_IMAGE` is the pinned cutter image, `FLY_APP`/`FLY_REGION` default to `skating-imagery`/`sjc` | ⬜ | token **yes** |
| `NAIP_MANIFEST_URL` | ⬜ planned — Phase B05 (building): the public URL of the published summer aerial's manifest, which the July check diffs against; set at publish beside the web's `VITE_NAIP_PMTILES_URL` | ⬜ | no |
| `FLY_API_URL` | a knob, **never set on dev or prod** — B01-8b-2: replaces both of Fly's hosts (the Machines API and the log API) with a local stand-in, for a proof on a throwaway backend only | never | no |
| `IMAGERY_STAC_URL` | a knob, **never set on dev or prod** — B01-8b-2: replaces Earth Search (the poll's STAC catalog) with a local stand-in, for a proof on a throwaway backend only | never | no |
| `CONVEX_CLOUD_URL` · `CONVEX_SITE_URL` | provided by Convex | provided | no |

### 2b. Mobile — EAS environments (`development`, `preview`, `production`) and local `apps/mobile/.env.local`

`eas config --profile preview --platform android` shows what a build will see. Public unless marked.

| Variable | Notes |
| --- | --- |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_…` on dev/preview; `pk_live_…` for production |
| `EXPO_PUBLIC_CONVEX_URL` | the deployment URL |
| `EXPO_PUBLIC_PMTILES_URL` · `EXPO_PUBLIC_WORLD_PMTILES_URL` · `EXPO_PUBLIC_BATHYMETRY_PMTILES_URL` · `EXPO_PUBLIC_IMAGERY_ARCHIVE_URL` | R2 archive URLs; blank = layer never mounts (basemap blank falls to the expiring demo bucket) |
| `EXPO_PUBLIC_OFFLINE_BASEMAP` | the Layer-3 device spike, off by default |
| `EXPO_PUBLIC_SENTRY_DSN` | public |
| `GOOGLE_SERVICES_JSON` | EAS **file** variable; local copy gitignored |
| `SENTRY_AUTH_TOKEN` | **secret** — build-time source-map upload; `SENTRY_ORG` / `SENTRY_PROJECT` are committed in `app.config.ts`, not env |
| `FONTAWESOME_NPM_AUTH_TOKEN` | **secret** — `eas-build-pre-install` writes it to `~/.npmrc` on the builder |

### 2c. Web — Vercel project env and local `apps/web/.env`

| Variable | Notes |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` · `CLERK_SECRET_KEY` | server-side (no `VITE_` prefix); secret key **secret** |
| `VITE_CONVEX_URL` | |
| `VITE_PMTILES_URL` · `VITE_WORLD_PMTILES_URL` · `VITE_BATHYMETRY_PMTILES_URL` · `VITE_IMAGERY_ARCHIVE_URL` | same values as mobile's |
| `VITE_NAIP_PMTILES_URL` | ⬜ planned — Phase B05 (building): the summer aerial archive's public URL (its `-cells.json` date index is derived from it); local `apps/web/.env` in both checkouts and Vercel Preview and Production; web only (mobile has no console); blank ⇒ the layer never mounts |
| `VITE_SENTRY_DSN` | public |
| `VITE_POSTHOG_KEY` | public project token (write-only). Unset ⇒ analytics inert — no init, no network (D235) |
| `VITE_POSTHOG_HOST` | optional override; blank ⇒ `https://us.i.posthog.com`. Only point it at a reverse proxy that strips `Cookie` — same-origin ingestion sends Clerk's session to PostHog (D235) |
| `VITE_APP_VERSION` | optional; unset → `web` in the support form |
| `SENTRY_ORG` · `SENTRY_PROJECT` · `SENTRY_AUTH_TOKEN` | build-time; token **secret**; without it the plugin skips upload and builds still succeed |
| `VERCEL_ENV` | Vercel's own, already present — `vite.config.ts` reads it at build time and injects it as `VITE_DEPLOY_ENV`, which tags every analytics event (D235) |
| `VITE_DEPLOY_ENV` | not set by hand: build-injected from `VERCEL_ENV`. Set it in local `.env` only to simulate a preview build |

### 2d. GitHub Actions secrets

`FONTAWESOME_NPM_AUTH_TOKEN` — the only one. CI pushes Convex functions to a throwaway local
backend, so it needs no deployment credential.

### 2e. Local-only and pipeline credentials (all gitignored)

| Where | What |
| --- | --- |
| `~/.npmrc` | the FontAwesome token |
| `packages/convex/.env.local` | `CONVEX_DEPLOYMENT` (which deployment the CLI targets); `CONVEX_DEPLOY_KEY` for loaders that run as admin and for `convex deploy` |
| `scripts/wind-climate/.env` | `WIND_TOOLKIT_API_KEY`, `WIND_TOOLKIT_EMAIL` |
| `scripts/lake-depth/.env.local` → operator's shell | `SCRIPT_SENTRY_DSN` — optional public ingest DSN for `gli-data-scripts`; export it before running `snapshot-elevation` (D278). Not read by Convex, Vercel, or CI. |
| `scripts/basemap/RCLONE_SETUP.md` + each `mirror-r2.sh`'s rclone remote | R2 API tokens (Object Read & Write, scoped per bucket) |
| Fly app `skating-imagery`, staged secrets | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (empty — anonymous), `FLY_API_TOKEN` local for `flyctl` |
| The summer aerial (Phase B05), `scripts/aerial/.env.local` — documented by its `.env.example`, loaded by `run-aerial.sh` and `spawn.sh` (not secrets) | `AERIAL_IMAGE` (the aerial image pinned by digest; never the cutter's `FLY_IMAGE`) · `R2_BUCKET` (`skating-imagery`) · `R2_REMOTE` (the laptop's rclone remote, default `r2`) · `R2_PUBLIC_BASE_URL` (the bucket's public origin, which verify reads) · `NAIP_MANIFEST_URL` (the published manifest a `--from-current` select diffs against, its URL or a local copy; the same name Convex dev gets in § 2a) · `spawn.sh`'s placement and sizes: `FLY_APP`, `FLY_REGION` (default `ams`), `FLY_ASSEMBLE_REGION` (default `iad`), `MAX_PARALLEL`, `FLY_VM_SIZE`, `FLY_VM_MEMORY`, `FLY_ASSEMBLE_VM_SIZE`, `FLY_ASSEMBLE_MEMORY`. A pilot's `CONVEX_DEPLOYMENT` (a `local:` backend) may go here too. On the Machines: the app's staged `R2_*` above, and Fly's own `FLY_MACHINE_ID` (the assembler's sign that it is on one). |
| The summer aerial's local runs and proofs (not secrets, local only) | `AERIAL_LOCAL_BUCKET` (assemble against a directory, no rclone, no Fly, no row) · `RCLONE_CONFIG` (rclone's own; the assembler's entrypoint writes one from the staged secrets) · the stream proof's `AERIAL_STREAM_PROOF`, `AERIAL_SCALE_PROOF`, `AERIAL_INDEX_PROOF` (each a scratch directory; unset, the proof is skipped) and rclone's own `RCLONE_LOG_FILE`, `RCLONE_VERBOSE` · `AERIAL_ENV_FILE` (another env file than `.env.local`; the tests') |
| The summer aerial's shell knobs (not secrets; defaults are the image's, set for a local run or a test) | `cut-aerial.sh`: `AERIAL_PACK`, `AERIAL_COUNTS`, `AERIAL_PYTHON`, `AERIAL_SAS_MARGIN` (seconds a SAS token must have left, default 180), `AERIAL_WORKDIR`, `PC_STAC`, `PC_SAS` (Planetary Computer's STAC and anonymous SAS endpoints), `GDAL_HTTP_MAX_RETRY`, `GDAL_HTTP_RETRY_DELAY`, `VSI_CACHE_SIZE` · `assemble-aerial.sh`: `AERIAL_ASSEMBLE` · `spawn.sh`: `SPAWN_TIMEOUT`, `POLL_SECONDS`, `CAPACITY_TRIES`, `DRAIN_TRIES`, `ASSEMBLE_TRIES` · `run-aerial.sh`: `AERIAL_TSX`, `AERIAL_SCRATCH_DIR` · `bundle.sh`: `ESBUILD` · the warp proof: `ONLY`, `SKIP_CUT`, `CUT_AERIAL` |
| Imagery / pipeline knobs (not secrets, read from env) | `STAC_URL`, `STAC_COLLECTION`, `STAC_COLLECTION_S1`, `THALWEG_RATIO`, `NODE_TLS_REJECT_UNAUTHORIZED` (the ALSC scraper's expired certificate, one run, archived) |
| Pipeline shell wrappers — each `scripts/*/.env.local`, documented by its `.env.example` (not secrets) | the `mirror-r2.sh` family: `RCLONE_REMOTE`, `RAW_BUCKET`, `ELEVATION_BUCKET` · `basemap/upload-r2.sh`: `R2_REMOTE`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` · `imagery/fan-out.sh`: `FLY_APP`, `FLY_REGION`, `FLY_IMAGE`, `MAX_PARALLEL`, `MASK_SEASON` (⚠ the masks' season, never the frame's — the example file says why) |
| Test knobs (not secrets, read from env, local only) | `ERASURE_PROPERTY_RUNS`, `ERASURE_PROPERTY_SEED` — widen or replay the erasure property (`packages/convex/convex/erasure.test.ts`) · `SHEET_PROPERTY_RUNS`, `SHEET_PROPERTY_SEED` — the same for every property on the report sheet's seed policy (`apps/web/src/lib/sheetStore.propertyRuns.ts`: `sheetStore.properties.test.ts`, `sheetRemoval.properties.test.ts`) · `UNMERGE_PROPERTY_RUNS`, `UNMERGE_PROPERTY_SEEDS` — widen the unmerge's property (`packages/convex/convex/unmerge.property.test.ts`: runs a seed, default 4; seeds, default 1) · `CORPUS_PROPERTY_RUNS` — widen the Corpus tasks' one-writer property (`packages/convex/convex/corpusTasks.property.test.ts`: multiplies its runs, default 1); unset on CI, which runs each property's pinned seeds and one random seed |
| macOS Keychain | `eas credentials` stores an Apple password as an internet password, server `deliver.<apple-id>`; `EXPO_NO_KEYCHAIN=1` skips it |
| Seed operator identity (not a secret, read from env) | `CONVEX_RUN_AS` — **the operator's own Clerk user id**: the person running the script, who must hold a moderator or admin profile on the target deployment — never just any admin's. `seed-destinations --apply` runs `setCuratedBoost` as that person via `convex run --identity`, so the audit rows name them as the actor, and records `via: seed-destinations` beside them, so the console reads "Teagan via seed-destinations" (D256; A10 corpus seed, 2026-09-19) |

**Secrets rule:** client secrets (Clerk secret, Strava secret, Resend, ORS, Expo token) live in
Convex env vars, never in a client bundle; `.env.example` files document names, never values; the
Convex MCP server has `envGet` / `envSet` / `envRemove` / `envList` disabled (`envList` returned
values, not just names — disabled 2026-09-20; "is `X` set yet?" is `pnpm exec convex env list`,
whose output is also values). **Public-by-design identifiers** — deployment names, the Clerk
instance domain, publishable keys — may appear in docs where they help tell dev from prod: they ship
in every client bundle, and the deployment URL grants nothing on its own (every function checks
auth). Nothing else does; an identifier that doesn't help someone act (an OAuth client id, a
hostname of a service that isn't ours) stays out.

---

## 3. Setup notes worth keeping — the parts that were hard-won

### 3a. OpenRouteService — the portal moved and the limits are measured, not published (2026-08-13)

Dashboard: <https://account.heigit.org> (`openrouteservice.org/plans` 301s there). Neither the plans
page nor `/restrictions/` publishes per-endpoint quotas; what A06d's routing pass measured:

| | observed |
|---|---|
| `directions/foot-hiking` per minute | **40** — a 700 ms gap (~85/min) got exactly 40 through, then `429` |
| `directions` per day | **~2,000** — two consecutive days stopped dead at 2,000 |
| daily reset | not 24 h and not midnight UTC — refused at +24 h and again at +26½ h |
| quota exhausted signal | **`403 {"error":"Quota exceeded"}`**, *not* 429, no rate-limit headers |
| `isochrones` while `directions` was exhausted | **HTTP 200** — the pools are **per-endpoint** |

The last row is the one that matters: an ETL cannot starve the drive-time bands a skater waits on.
The operational rule it bought (`scripts/etl/src/accessCli.ts`): three consecutive 403s trip a
circuit breaker — before it existed one run sent 2,978 requests to an endpoint that had already
said no. Hosted isochrones cap at 60 min, so the 90-min band is a radius
([`backlog/self-hosted-ors.md`](./backlog/self-hosted-ors.md)).

### 3b. Push — Firebase / FCM and APNs (done for dev 2026-09-14)

The code is credential-blind (`pushRegistration.ts` mints an Expo token; `notificationDelivery.ts`
posts to `exp.host`). What the one-time setup hit, recorded so the prod cutover doesn't re-derive it:

- The Firebase project must sit **under the Google Cloud organization**, not "No organization", or
  the console can't override org policies for it (Resource Manager → Migrate).
- New orgs enforce `iam.managed.disableServiceAccountKeyCreation`, so *Generate new private key*
  fails. Override it **at the project** (needs Organization Policy Administrator on the org),
  generate the key, then re-enforce — existing keys keep working.
- The Apple-login path in `eas credentials` died on `iTunes service key is empty` — an Apple-side
  error, not a bad password. The APNs key was created by hand at developer.apple.com and pasted in.
  One key per Apple team covers every app.
- Steps, per environment: Firebase → Android app with package `com.teaganatwater.gli` →
  `google-services.json` into `apps/mobile/` (gitignored) and as the EAS file var
  `GOOGLE_SERVICES_JSON`; Service accounts → key → `eas credentials` → Android → *Set up FCM V1*.
  New EAS build (the native fingerprint changes). Verified end to end with a direct POST to
  `exp.host/--/api/v2/push/send` + `getReceipts` → `status: ok`.

### 3c. Clerk webhook — per instance, once (dev 2026-09-15; prod at cutover)

`user.updated` → `POST /clerk-webhook` on the Convex HTTP router keeps `profiles.email` /
`profileImageUrl` current the moment they change (the app-open `syncFromClerk` only catches up on
the next open, and the person the email channel serves is exactly the one not opening the app).

1. Clerk Dashboard → *Configure* → *Webhooks* → **Add endpoint**: the deployment's `.convex.site`
   host + `/clerk-webhook` (dev: `https://agile-bee-397.convex.site/clerk-webhook`). Subscribe to
   `user.updated` (`user.created` harmless; `user.deleted` acknowledged and ignored — finalization
   deletes the Clerk user itself).
2. The endpoint's signing secret → `CLERK_WEBHOOK_SIGNING_SECRET` on the matching deployment. Until
   set, the route answers **500** on purpose; Svix retries, nothing is lost.
3. Verify: change your email in Settings (web) or the You tab (mobile); the endpoint's *Messages*
   tab shows a 200 and the profile row moved.

Prod needs its own endpoint (`diligent-guanaco-965.convex.site`) and its own secret; neither
carries over.

### 3d. Resend — CNAME-verified, and there is deliberately no MX record

The sending domain is verified through Resend's CNAME flow, which serves the MX and SPF from their
side; adding an MX at the same name would break the CNAME. The full checklist is
[`phases/07-operator-surface.md`](./phases/07-operator-surface.md) § *Resend checklist*. All three
email vars ship unset on a fresh deployment on purpose — `lib/resend.ts` logs and returns rather
than blocking every deploy on a founder task.

### 3e. Fly — secrets are staged, and that is the finished state

`fly secrets set --app skating-imagery --stage KEY=value`; ignore flyctl's advice to `fly secrets
deploy` — this app has no long-lived Machines, every job's Machine is born with the staged set. The
rest of the traps (never plain `fly deploy`, `machine run` needs `--detach`, region `sjc` because
`sea` is dead) are in [`scripts/imagery/README.md`](../scripts/imagery/README.md).

---

## 4. The prod cutover — the account column

Every line is a provisioning act, not code; the ordered checklist is
[`docs/deployment-and-release.md`](../docs/deployment-and-release.md) § *Prod cutover*. By account:

1. **Clerk** — a production instance; its issuer domain + secret key on prod Convex; a `pk_live_`
   key in the `production` EAS environment and on Vercel; its own webhook endpoint + secret.
2. **Convex** — the first `convex deploy` (needs a deploy key); every § 2a variable on prod; the
   `--prod` corpus load and `backfillCells`.
3. **Resend** — a prod API key; the three email vars.
4. **Cloudflare R2** — `upload-r2.sh … prod/<key>` for each of the four archives (regional, world,
   bathymetry, imagery base) or reuse the dated `dev/` objects, then all four URLs per surface on
   Vercel and in EAS `production`; a Cloudflare zone for the custom domain (`upload.sh --prod` is
   the retired Convex-storage host).
5. **Expo / EAS** — fill the `production` environment; `EXPO_ACCESS_TOKEN` on prod Convex.
6. **Strava** — the callback domain on the API app; `WEB_APP_URL` on prod.
7. **Sentry** — prod DSNs if they're to be separate projects (or keep one per surface).
8. **Google Play** (when there is a store track) and **Apple** (the first iOS build).

When a line lands, its row in § 1 flips to ✅ and its variables in § 2 gain a prod column entry — in
the same PR, so the register and the deployment never disagree about which tier exists.
