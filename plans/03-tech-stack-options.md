# Tech stack & options

What the app **runs on** — languages, frameworks, vendors, infrastructure, tooling — as built, and
what was considered and set aside along the way. Every choice cites its decision; the *why* lives
there once, and this doc is the register. Data sources and third-party APIs are the other register,
[`04-integrations.md`](./04-integrations.md); the account-by-account setup notes (keys, quotas,
what's provisioned) are [`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md).

> **Cost posture (D35):** hosted free tiers over self-run infrastructure; pay for the turnkey option
> before standing up a server; target **under ~$100/month at ~1,000 active users**. Where the stack
> spends anything today, the row says so.

---

## The stack, by layer

### Languages, repo, tooling

| Layer | Choice | Decision | Why, in a clause |
| --- | --- | --- | --- |
| Language | TypeScript everywhere; `strict` | D39 | one type system across apps, backend, pipelines |
| Monorepo | Turborepo + pnpm workspaces (`apps/*`, `packages/*`, `scripts/*`) | D39 | one pipeline, task caching, shared packages without publishing |
| Lint / format | Biome, repo-wide | D46 | one tool, one config, fast |
| Tests | Vitest everywhere · `fast-check` for safety-sensitive math · `convex-test` for functions · Testing Library for components | D40 | shared logic in `packages/core` means one suite covers both apps; 90% line floor in `core` and `convex` |
| CI | GitHub Actions: lint → throwaway Convex push (proves `convex/_generated` is current) → type-check → test with coverage | D40 | the Convex step catches the codegen-drift class CI otherwise can't |
| Design | Figma (light- and dark-mode design systems; SVG export pipeline into the apps) | — | design moved out of code in 2026-09 |
| Icons | FontAwesome Pro (sharp families), inline SVG on both surfaces | — | private registry; see [`docs/fontawesome-pro.md`](../docs/fontawesome-pro.md) |
| Code review | Greptile on every PR (metered — few PRs per phase) | — | see `CLAUDE.md` |
| AI-assisted dev | Convex MCP server (`.mcp.json`), read-only, prod refused | — | inspect the deployment without deploying a throwaway query |

### Backend

| Layer | Choice | Decision | Why, in a clause |
| --- | --- | --- | --- |
| Database + functions | **Convex** — schema, queries/mutations/actions, scheduled functions, crons, HTTP endpoints, file storage | D2 | one system for data, logic, realtime, storage; no ORM, no server to run |
| Spatial index | **Our own ladder-grid cell index** on plain tables (`cells`, `listedBodiesNearCoord`) | D5 (amended A01) | the `@convex-dev/geospatial` component was retired in A01 — read cost was unbounded at corpus scale |
| Geometry | Turf.js in `packages/core` (contains, intersects, buffer, union, area, point-on-feature) | D5 | pure functions, same code in Convex and on both clients |
| Auth | **Clerk** — Expo + web SDKs, JWT into Convex, `user.updated` webhook (verified with `standardwebhooks`) | D26 | batteries-included on both surfaces; profile mirrors refreshed by webhook and on app open |
| Email | **Resend** via a Convex action (`lib/resend.ts`, never-throw) · templates in **React Email**, one package for all of them: [`packages/email`](../packages/email) (`@skating/email` — `Layout`, `renderEmail` → `{ html, text }` from one tree, a preview server on `pnpm --filter @skating/email dev`) | D38 | operator alerts, the data export, A08's digest and unsubscribe mail; the senders still build strings by hand — moving them is [`features/react-email.md`](./features/react-email.md) |
| Push | **Expo Push** (APNs/FCM via `exp.host`), receipts handled | D174 | wraps both stores; local notifications for on-ice alerts (09b) never touch a server |
| Files | Convex file storage for photos; clients resize/compress before upload | D31 | Convex has no transforms, so optimization is client-side |
| Artifacts | **Cloudflare R2** — basemap, bathymetry and imagery archives; raw-data mirrors (`mirror-r2.sh`) | 02b, D148 | zero egress; the multi-state basemap blew past Convex storage, and everything static followed |
| Artifact format | **PMTiles** — one format for basemap (vector), bathymetry contours (vector) and per-pass imagery (masked raster) | D6, D81, D148 | a static file on a CDN, range-requested; the clients read all three with one loader |
| Batch compute | **Fly.io** per-job Machines (`scripts/imagery`), created per granule and destroyed | D148 | render where the data is, pay only while it runs (~$5/mo pattern) |

### Clients

| Layer | Choice | Decision | Why, in a clause |
| --- | --- | --- | --- |
| Mobile (primary) | **Expo / React Native**, Expo Router, **Tamagui** | D7 | file-based routing; tokens shared with web through `@skating/design` |
| Mobile map | `@maplibre/maplibre-react-native` | D6, 02a | not `@rnmapbox/maps`: same renderer as web, no token, MapLibre-native PMTiles |
| Mobile offline | `expo-sqlite` (draft queue + body-polygon LRU), `expo-file-system` (photos), NetInfo-driven flush, idempotency keys | D30 | a purpose-built draft queue, not a replication engine |
| Mobile native | `expo-location` + `expo-task-manager` (recorder, on-ice mode) · `expo-notifications` (local) · `expo-image-picker/manipulator` · `expo-web-browser` (external links, D76) · `expo-secure-store` | 08, 09b, D76 | every native capability is an Expo module — no custom native code, so EAS builds stay reproducible |
| Mobile builds | **EAS** `preview` profile (standalone, internal distribution), `expo-updates` for JS-only changes; Android first, no iOS build yet | — | see [`docs/deployment-and-release.md`](../docs/deployment-and-release.md) |
| Web (secondary) | **TanStack Start** (Vite, Nitro) + **Tailwind** + **shadcn on Base UI** (`base-nova`), `next-themes` | D7, D27 | home of `/admin`; SSR for the shareable deep links |
| Web map | `maplibre-gl` + `pmtiles` + `@protomaps/basemaps` style · **terra-draw** for hazard/outline drawing | D6, D67 | terra-draw has no React Native adapter, so mobile draws by tap-to-place |
| Web charts | **Recharts** (operator analytics), validated against the `dataviz` kit | 07-2 | |
| Web hosting | **Vercel**, Git integration on `main`, preview per PR | D27 | the one deployable that ships on merge |
| Errors | **Sentry** on both apps (native crash + web) | D29 | on from day one — "is it crashing in the cold?" |
| Analytics | in-house operator analytics on Convex (`metricSnapshots`, rollups, never a corpus scan) | 07-2 | PostHog is still "later" — see *Deferred* |

### Maps & routing services

| Layer | Choice | Decision | Why, in a clause |
| --- | --- | --- | --- |
| Renderer | **MapLibre GL** (web + RN) | D6, locked | open, no token, one style JSON for both surfaces |
| Basemap | self-built **Protomaps** archives — world z0–6 + five-state region + a generated mask — on R2 | D6, 02b | unmetered static file; never the Protomaps demo bucket in production |
| Routing | **OpenRouteService, hosted** — isochrones (drive-time bands) and `foot-hiking` (walking approaches), all cached on the row | D18, D35, D87 | calls are rare and cached, so the free tier is ample; one key for both |
| Geocoding | **none yet** — home is set from device geolocation, report location from the map or the GPS path. **Wanted:** a hosted geocoder for the *location anchor* — search from home, from an address (a cabin, a friend's), or from here | D11, D18 · [`backlog/location-anchor.md`](./backlog/location-anchor.md), Q17 | source options in `04` § Geocoding; the volume is once per anchor, so any hosted tier fits |

### Data pipelines (`scripts/*`)

Hand-run, never built with the apps; each directory's README is the runbook.

| Tool | Used for |
| --- | --- |
| TypeScript via `tsx`, on `@skating/core` | every transform and loader; tested like app code |
| `osmium-tool` | filtering OSM extracts (water, boundaries, access features) |
| GDAL (`ogr2ogr`, `gdal_contour`, `gdalwarp`) | format/CRS wrangling, contour generation, raster cutting |
| Python (numpy + GDAL's `osgeo` bindings) | the SAR chain in `scripts/imagery` (`sar-*.py`), zonal stats, tile packing |
| `pmtiles` CLI | extracting basemap regions, packing archives |
| `rclone` | mirroring raw archives and publishing to R2 (`mirror-r2.sh`, `upload-r2.sh`) |
| `flyctl` + Docker | the imagery granule box |
| `@skating/run-log` | one `importRuns` row per loader run → `/admin/imports` |

---

## Considered and set aside

Collected here from the decisions and phase docs, so the next person doesn't re-evaluate them.

| Option | For | Why not | Where |
| --- | --- | --- | --- |
| Mapbox GL + Mapbox tiles / Isochrone API | renderer, tiles, routing | proprietary, per-use billing, every contributor needs a token | D6 |
| MapTiler, Stadia | hosted tiles | metered API key in the client; a static PMTiles file is unmetered and offline-friendly | D6 |
| Self-hosted tileserver-gl | tiles | a server to run for a static-file problem | D6 |
| `@rnmapbox/maps` | mobile map | `@maplibre/maplibre-react-native` is the same renderer as web with no vendor coupling | 02a |
| `@convex-dev/geospatial` | spatial queries | **used, then retired (A01)** — reads scaled with result size and one ETL read 105 GB; the ladder-grid index bounds every read | D5, A01 |
| Valhalla (self-host), GraphHopper | routing | a server to run / a second vendor and key for no capability ORS lacks | D18, D35, D87 |
| Convex Auth | auth | more DIY UI on two surfaces; Clerk's Expo + web SDKs won | D26 |
| Auth0 / WorkOS | auth | enterprise-weight and priced for it | D26 |
| Cloudflare Images | photo variants | on-the-fly transforms not needed; client-side resize is enough | D31 |
| Convex file storage for tiles | basemap hosting | blew the storage tier at five states; R2 has zero egress | 02b |
| WatermelonDB, PowerSync, Replicache, **Zero** (Rocicorp) | offline sync | full replication / sync engines for a draft-queue problem; Zero additionally wants to own the query layer Convex already owns | D30 |
| MMKV | draft storage | `expo-sqlite` already held the polygon cache; one store | D30 |
| Cloudflare Pages / Netlify | web hosting | Vercel has first-class TanStack Start deploys | D27 |
| Skia (`@shopify/react-native-skia`) on mobile | the imagery reveal | **set aside, not rejected** — the baked-alpha raster made the reveal a plain `ImageSource`, so a native dependency and a fresh dev-client build bought nothing then; it stays the named fallback if the clip doesn't generalize, and the likely route for FUI effects RN views can't draw (gradient fades on an S-curve, pattern fills) once the design pass asks for them | A06e |
| An always-on radar server (LibreWXR-class) | radar | ~$760/yr for what cutting on Fly→R2 costs ~$5/mo | D157 |
| The `appConfig` runtime-tuning seam | operator tuning | constants stay in code; edit = redeploy, so every value is in git and tests | 07-2 |
| Encoded-polyline transport | GPS paths | not worth a second wire format at our path sizes | 08 |
| A separate `corrections` table | water body corrections | `contentFlags` already carries dedup, queue, purge, notification and rollups | A07c |
| A cell index for bounties | bounty discovery | skaters *do* find bounties near their GPS position — but the read is corpus-wide: `listOpen` takes the 200 soonest-expiring open bounties across the whole region off `by_status_expires` and filters to the viewport / `near` in memory. Fine while open bounties number in the dozens; past ~200 open at once a nearby one could fall outside the scan. The fix is the water bodies' own pattern (index by cell, read only the cells in view); the trigger is the cap warning firing | 06 |
| Windy Map Forecast API | animated weather | Leaflet-only, can't overlay MapLibre; we link out instead | D75, D76 |

---

## Deferred tech — not built, still intended or still possible

Each row has a backlog or feature doc that points back here; when one ships, flip the row (or
move the item into the tables above) in the same PR, so this list and the docs can't disagree.

| Item | Status | Trigger |
| --- | --- | --- |
| **PostHog** (product analytics, flags, session replay) | not wired; the in-house Convex analytics cover the operator's questions | usage insight past the alpha; session replay is legal-gated (L12) → [`backlog/posthog.md`](./backlog/posthog.md) |
| **Web Push** (VAPID) | not built — no service worker; web is inbox + email | a real ask → [`backlog/web-push.md`](./backlog/web-push.md) |
| **End-to-end tests** — Playwright (web), Maestro (Expo) | not set up; the emulator's GPX playback is manual QA | flows stabilizing after the alpha → [`backlog/e2e-tests.md`](./backlog/e2e-tests.md) |
| **Self-hosted OpenRouteService** | hosted ORS caps isochrones at 60 min (the 90-min band is a radius) | a cost/ops call, ~$15–50/mo → [`backlog/self-hosted-ors.md`](./backlog/self-hosted-ors.md) |
| **iOS builds / TestFlight** | no iOS build exists; Android via EAS internal distribution | the Apple account, with the prod cutover → [`backlog/ios-distribution.md`](./backlog/ios-distribution.md) |
| **Production tier** — Convex prod, Clerk prod instance, prod tile URLs, Resend prod key, EAS `production` | never initialized; everything is dev | the prod cutover, [`docs/deployment-and-release.md`](../docs/deployment-and-release.md) |
| **`@clerk/clerk-expo` → `@clerk/expo`** (Core 3) | the current package is deprecated | nothing; rides the identifier cleanup in [`backlog/gli-identifiers.md`](./backlog/gli-identifiers.md) |
| **React Email in every sender** | the package and the first template exist; three senders still hand-build HTML | next mail design pass → [`features/react-email.md`](./features/react-email.md) |
| **A hosted geocoder** — for the location anchor | none exists; every "near" is device or home | scoping the anchor → [`backlog/location-anchor.md`](./backlog/location-anchor.md), options in `04` § Geocoding |

---

## Cost sanity check (D35)

At today's scale everything below is on a free tier or a few dollars; the ceiling is the posture,
not the bill.

| Service | Tier | Notes |
| --- | --- | --- |
| Convex | free | one dev deployment; prod uninitialized |
| Clerk | free (≤10k MAU) | |
| Vercel | hobby | web, previews per PR |
| Expo / EAS | free | build minutes are the constraint, not money |
| Cloudflare R2 | ~free | a few GB of archives, zero egress |
| Fly.io | ~$5/mo when cutting | per-job machines, nothing running between jobs |
| OpenRouteService | free | quotas are per endpoint; an ETL can't starve the app (`ors-quota` note) |
| Open-Meteo | free, **non-commercial** | D158: the $319/yr plan has a written trigger, and the license is one of its three conditions |
| Sentry | free dev tier | |
| Resend | free | dev keys only until the cutover |
| FontAwesome Pro | 💰 one seat | the one paid line item; a design trade, see `docs/fontawesome-pro.md` |
| Apple / Google developer accounts | 💰 | with the store track, not yet |

Well under the **< $100/mo** target at ~1,000 active users; the first things that would move it are
imagery volume (R2 + Fly), Open-Meteo's plan, and a self-hosted ORS.
