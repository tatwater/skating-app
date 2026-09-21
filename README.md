# Gli

> **Working title.** ⛸️ The app calls itself Gli (Norwegian for "glide"); the repo and its
> infrastructure use `skating` on purpose, so they stay discoverable under any final name.

A **map-first app for sharing peer ice reports** for Nordic (wild) ice skating —
built so skaters can find, and share, time- and place-sensitive ice conditions for
the lakes, ponds, bays, and (eventually) rivers near them.

Nordic ice skating is a niche but passionate sport in the northern US. Ice that's
perfect today can be ruined tomorrow by sun, snow, rain, or a temperature swing — and
today the community coordinates almost entirely over email forums and Facebook groups,
which are hard to search, easy to miss, and have no map, no distance filtering, and no
freshness signal. This app is a purpose-built alternative.

> 🧭 **New here? Start with the [vision](./plans/00-vision.md)** — what we're building, for whom, and
> the four principles everything answers to.

## ⚠️ Safety first — please read

**This app never tells anyone that ice is safe.** Every report is *one named person's
observation at a specific time and place* — not a guarantee, not a prediction, not a
go/no-go verdict. Ice conditions change fast, and the decision to step onto ice is
**always yours alone**.

- We *contextualize* aging reports (e.g. "3 days of sun and rain since this report")
  to support your judgment — never to make the call for you.
- A report that says **"don't do it"** is as valuable as a positive one.
- A dangerously false "the ice is great!" report is a **safety** issue, not just spam —
  and can be flagged as such.

Wild ice skating is inherently dangerous. Use this app to inform your own decisions,
carry proper safety gear, skate with others, and know your rescue plan.

## Status

**Alpha in progress — built, not yet released.** As of September 2026:

- **The roadmap phases (`00`–`10`) are all built:** the map + peer reports (with an offline draft
  queue), comments, profiles, block/flag and moderation, drive-time filtering, the newsfeed,
  bounties + a trust score, hazards with on-ice alerting, weather-since context and weather-driven
  hazard decay, the `/admin` operator surface, and a native GPS track recorder with a push to Strava.
- **The enrichment phases (`A01`–`A09`) taught the app its water bodies.** A unified corpus of
  ~25,000 water bodies for the Northeast (VT, NH, ME, MA, and NY north of I-84), merged from four
  public catalogs and enriched with elevation, depth, bathymetry contours, winter wind roses, access
  points (put-ins, parking, walking approaches) and posted rules, a corpus lifecycle that pushes
  only the ~1,400 bodies with evidence of use, a full weather panel with weather-first discovery,
  the notification pipeline (inbox, push, email), and bays as places in their own right. Two phases
  are still open — **A06e** (satellite imagery of each water body: the reveal and the freeze-up
  scrubber ship; the multi-season backfill and its derived charts do not) and **A06h** (the weather
  panel: radar remains) — **A07c** (water body corrections) and **A10** (the reporting flow) are
  scoped, and the next era, **`B01`… launch readiness**, comes after them.
- **Everything runs on the development deployment.** Production has never been initialized — the
  prod cutover is deliberately deferred — and a handful of native surfaces still await on-device
  verification.

The full record, phase by phase, with everything deliberately deferred, is
[`plans/07-roadmap.md`](./plans/07-roadmap.md).

First target: a small **friends-only alpha** (~20 skaters) before any regional rollout,
timed for the first ice of the season (~November).

## What's here

A TypeScript monorepo (Turborepo + pnpm) — a working app on the dev deployment, the data pipelines
that feed it, the design record that drives it, and the docs that explain it:

- **`apps/mobile`** (Expo / React Native, primary) · **`apps/web`** (TanStack Start, secondary,
  home of the `/admin` operator surface) · shared **`packages/`** (`convex` backend, `core` logic,
  `design` tokens) · hand-run **`scripts/`** data pipelines.
- 🧭 **[`plans/00-vision.md`](./plans/00-vision.md)** — **the pitch.** The problem, the product,
  the principles, where it's going, and what it isn't. Read this first.
- 📖 **[`docs/`](./docs/)** — **how the important systems work, and why.** Read these to understand
  the product's mechanics rather than its history (see [How things work](#how-things-work) below).
- 🗂 **[`plans/README.md`](./plans/README.md)** — guided index to the design record: the
  **[decisions log](./plans/01-decisions.md)** (ADR-style, with rationale), the
  **[open questions](./plans/02-open-questions.md)**, the
  **[data model](./plans/06-data-model.md)**, the **[roadmap](./plans/07-roadmap.md)**, and one doc
  per phase under [`plans/phases/`](./plans/phases/).

## How things work

[`docs/`](./docs/) is the narrative layer: each doc explains one system in plain language, with the
safety reasoning behind its constants, and links to the decisions and phase docs behind it.

| Doc | What it explains |
|---|---|
| [Water body data](./docs/water-body-data.md) | Where the ~25,000 water bodies come from: four catalogs merged into one record each, what we refuse and why, and what we know about *your* lake (depth, contours, wind) versus what's estimated |
| [Corpus lifecycle](./docs/corpus-lifecycle.md) | Active vs. dormant water bodies — why we know about 25,000 and push a few hundred, and how one moves between states |
| [Report lifecycle](./docs/report-lifecycle.md) | A report never decays; what *does* change as it ages |
| [Hazard decay & lifecycle](./docs/hazard-decay-and-lifecycle.md) | How a reported hazard fades in confidence (never in "safety"), gets confirmed, cleared, and drawn |
| [Weather-since](./docs/weather-since.md) | The one reducer behind "what has the weather done since this report" |
| [Bounty decay & lifecycle](./docs/bounty-decay-and-lifecycle.md) | "Someone please go look" — when a bounty can open, what suppresses it, when it expires |
| [User reputation](./docs/user-reputation.md) | Trust as a boost-only score, and why conflicting reports never cost points |
| [On-ice alerts](./docs/on-ice-alerts.md) | The opt-in on-ice mode: course-over-ground projection, time-to-encounter, and why every constant is set the way it is |
| [Notifications](./docs/notifications.md) | The inbox as the product; push and email as ways of pointing at it |
| [Reading ice from orbit](./docs/reading-ice-from-orbit.md) | What Sentinel-2 and Sentinel-1 can and cannot see on a frozen lake |
| [Bathymetry challenges](./docs/bathymetry-challenges.md) | Drawing depth contours: five interpolators and five gates that didn't work, kept on purpose |
| [Minors & age policy](./docs/minors-and-age-policy.md) | Every choice about users under 18, and what it would take to open participation up |
| [Account deletion](./docs/account-deletion.md) | The request *is* the deletion; what the 30 days preserve |
| [Adding a region](./docs/adding-a-region.md) | The end-to-end runbook for expanding map coverage |
| [Deployment and release](./docs/deployment-and-release.md) | Three deployables, what merging does and doesn't deploy, and the prod cutover checklist |
| [FontAwesome Pro](./docs/fontawesome-pro.md) | Why `pnpm install` needs a private-registry token, and where it lives |

## Tech stack

A quick tour; the register — every choice with its decision, what was considered and set aside, and
what's deferred — is [`plans/03-tech-stack-options.md`](./plans/03-tech-stack-options.md).

| Area | Choice |
|---|---|
| Repo | TypeScript everywhere · Turborepo + pnpm workspaces · Biome · Vitest (+ `fast-check`, `convex-test`) · GitHub Actions |
| Mobile (primary) | Expo / React Native + Expo Router + Tamagui · MapLibre (`@maplibre/maplibre-react-native`) · `expo-sqlite` offline draft queue · Expo location / task-manager / notifications · EAS builds + `expo-updates` |
| Web (secondary) | TanStack Start + Tailwind + shadcn on Base UI · `maplibre-gl` + `terra-draw` · Recharts · Vercel |
| Backend | Convex (schema, functions, crons, HTTP endpoints, file storage) with our own ladder-grid spatial index · Clerk auth · Expo Push · Resend (templates moving to React Email in `packages/email`) · Sentry |
| Maps & artifacts | MapLibre GL · self-built Protomaps basemap, bathymetry contours and per-body imagery all as PMTiles on Cloudflare R2 · hosted OpenRouteService for drive-time bands and walking approaches |
| Data pipelines | `scripts/*` — TypeScript over `osmium`, GDAL, Python and `rclone`; imagery cut on per-job Fly.io machines; raw archives mirrored to R2 with manifests |

## Data sources & integrations

Everything the app knows about a water body is a **claim from a named source**, attached to a record
we mint ourselves. The register — every dataset and API, its license and quota, where it's
archived, and the alternatives considered — is
[`plans/04-integrations.md`](./plans/04-integrations.md); the story of how the sources become one
record per body is [`docs/water-body-data.md`](./docs/water-body-data.md).

- **Water bodies** — OpenStreetMap (Geofabrik extracts) merged with USGS NHD, 3DHP and GNIS;
  boundaries from OSM and US Census TIGER; the basemap from Protomaps builds.
- **What we know about each one** — elevation from USGS 3DEP; depth from a ranked ladder (state
  surveys, NYSDEC CSLAP, LAGOS-US, the Adirondack Lakes Survey, HydroLAKES, GLOBathy); contours from
  five state agencies (MA, ME, NH, VT ×2 — New York has none); winter wind from the NREL WIND Toolkit;
  put-ins, parking and trails from OSM, with walks routed by OpenRouteService.
- **What's happening now** — weather from Open-Meteo (the only source that feeds a calculation),
  official alerts from the NWS (advisory only, never blended), Sentinel-2 and Sentinel-1 passes via
  AWS Earth Search, NAIP aerials from the USGS National Map.
- **Outbound** — GPS tracks are recorded here and **pushed** to Strava; nothing is ever pulled
  from a fitness platform. A GPX import (bring a track from a watch or another app) is on the
  backlog; watch adapters (Garmin, COROS, Polar, HealthKit, Health Connect) wait on partner
  approvals.

Attribution is a build-time acceptance criterion: OSM (ODbL), Open-Meteo, Copernicus, each
bathymetry agency's credit line, and Strava's brand rules are rendered wherever their data appears.

## How we work

- **Safety-first, never authoritative** ([D3](./plans/01-decisions.md)) is the one invariant every
  change is checked against: no copy, score, decay curve or classification may say or imply that ice
  is safe, or predict it. Decay is *confidence*, not safety.
- **Decisions are documented.** Anything non-trivial gets a `D#` in the
  [decisions log](./plans/01-decisions.md) with its rationale; phases get a doc under
  [`plans/phases/`](./plans/phases/) and an entry in the [roadmap](./plans/07-roadmap.md). Conventions
  (phase names, workstreams, US spellings) are in [`plans/README.md`](./plans/README.md) and enforced
  by tests.
- **Tests land with the feature** ([D40](./plans/01-decisions.md)): Vitest for logic, `fast-check`
  for safety-sensitive math, `convex-test` for backend functions, aiming at full coverage.
- **One PR per phase**, sub-workstreams as commits; CI must be green (`pnpm lint`,
  `pnpm check-types`, `pnpm test`) and the change exercised on the dev deployment before review.
- **Merging deploys nothing except the website.** Convex pushes, EAS builds and every data
  pipeline are run by hand — see [`docs/deployment-and-release.md`](./docs/deployment-and-release.md).

Setup and contribution details are in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Repo layout

```
apps/
  mobile/           # Expo / React Native app (primary)
  web/              # TanStack Start web app + /admin (secondary)
packages/
  design/           # shared design tokens (FUI theme, light/dark/high-contrast)
  convex/           # Convex schema, functions, crons, HTTP endpoints
  core/             # shared logic, types, validators (dedup, geo, decay, units)
  email/            # every transactional mail template (React Email) + the render helper
scripts/            # hand-run data pipelines, one directory each, with their own READMEs:
  etl/              #   the water-body corpus (OSM + NHD + 3DHP + GNIS merge, depth, access points)
  admin-areas/      #   administrative boundaries, the region polygon and the basemap mask
  basemap/          #   the two Protomaps archives and their upload to R2
  lake-depth/       #   depth ladder + 3DEP elevation archives
  bathymetry/       #   state-agency contours → PMTiles
  wind-climate/     #   NREL WIND Toolkit → winter wind roses
  imagery/          #   Sentinel granule cutter on Fly.io → masked PMTiles on R2
  seed-destinations/#   curated shortlist → display boosts
  run-log/          #   the shared ETL run-history writer behind /admin/imports
plans/              # the design record: vision, decisions, data model, roadmap, phases/, features/, backlog/, research/
docs/               # how the important systems work, and why
```

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and our
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Given the subject matter, the
[safety-first, non-authoritative principle](./plans/00-vision.md#product-principles)
is non-negotiable in any contribution.

## Privacy & terms

This is a location app. See [`PRIVACY.md`](./PRIVACY.md) for the (interim, alpha-stage)
privacy notice and [`TERMS.md`](./TERMS.md) for the interim terms of use (including the
safety / assumption-of-risk framing). Home location is private by design; photos are
EXIF-stripped on upload with opt-in geotagging. Both are interim and will be replaced by
lawyer-reviewed versions before any broad launch.

## License

Licensed under the **[GNU AGPL-3.0](./LICENSE)**, **with an additional permission for
distribution through the Apple App Store and Google Play** — see
[`LICENSE-EXCEPTIONS.md`](./LICENSE-EXCEPTIONS.md).

## Acknowledgments

Ice terminology and safety culture draw on the Nordic skating community and the
[Nordic Skater](https://nordicskaters.squarespace.com/) and [Lake Ice](http://lakeice.squarespace.com/) reference sites. This project
aims to *support* that community's existing safety culture, not replace it.

Map data © OpenStreetMap contributors (ODbL). Weather by Open-Meteo. Contains modified Copernicus
Sentinel data. Depth and bathymetry from the state agencies and datasets credited above.
