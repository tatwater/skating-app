# Skating App

> **Working title — the project is not yet named.** ⛸️

A **map-first app for sharing peer ice reports** for Nordic (wild) ice skating —
built so skaters can find, and share, time- and place-sensitive ice conditions for
the lakes, ponds, and rivers near them.

Nordic ice skating is a niche but passionate sport in the northern US. Ice that's
perfect today can be ruined tomorrow by sun, snow, rain, or a temperature swing — and
today the community coordinates almost entirely over email forums and Facebook groups,
which are hard to search, easy to miss, and have no map, no distance filtering, and no
freshness signal. This app is a purpose-built alternative.

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

**Alpha in progress — built, not yet released.** Every planned phase (0–10) is now built: the map +
peer reports, community + safety tooling, drive-time filtering, the newsfeed, bounties + trust
score, hazards + on-ice alerting, weather-since context, the operator/admin surface, and — last —
**native GPS track recording with a push to Strava**. All of it runs on the **development**
deployment; **nothing is deployed to production yet** (the prod cutover is deliberately deferred),
and the newest native surfaces are still awaiting on-device verification. The full design record —
including everything deliberately deferred — lives under [`plans/`](./plans/).

First target: a small **friends-only alpha** (~20 skaters) before any regional rollout,
timed for the first ice of the season (~November).

## What's here

A TypeScript monorepo (Turborepo + pnpm) — a working app on the dev deployment, plus the design
docs that drive it:

- **`apps/mobile`** (Expo / React Native, primary) · **`apps/web`** (TanStack Start, secondary,
  home of the `/admin` operator surface) · shared **`packages/`** (`convex` backend, `core` logic,
  `design` tokens).
- 📖 **[`plans/README.md`](./plans/README.md)** — guided index to all the design docs: the
  **[vision](./plans/00-vision.md)**, the **[decisions log](./plans/01-decisions.md)** (ADR-style,
  with rationale), the **[data model](./plans/06-data-model.md)**, and the
  **[roadmap](./plans/07-roadmap.md)**.

## Tech stack

Full rationale in [`plans/03-tech-stack-options.md`](./plans/03-tech-stack-options.md).

| Area | Choice |
|---|---|
| Monorepo | Turborepo + pnpm workspaces |
| Language | TypeScript everywhere |
| Mobile (primary) | Expo / React Native + Tamagui |
| Web (secondary) | TanStack Start + Tailwind + shadcn (on Vercel) |
| Backend / DB | Convex (+ file storage + geospatial) |
| Auth | Clerk |
| Maps | MapLibre GL + Protomaps tiles + hosted OpenRouteService (isochrones) |
| Weather | Open-Meteo |
| Testing / CI | Vitest (+ fast-check, convex-test) · GitHub Actions |
| Observability | Sentry (crash/error) · PostHog (analytics, later) |

## Repo layout

```
apps/
  mobile/     # Expo / React Native app (primary)
  web/        # TanStack Start web app + /admin (secondary)
packages/
  design/     # shared design tokens (FUI theme, light/dark/high-contrast)
  convex/     # Convex schema, functions, client
  core/       # shared logic, types, validators (visibility, dedup, geo, units)
plans/        # design documentation (start here today)
docs/         # public documentation (how important systems work after they're built, and why)
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
