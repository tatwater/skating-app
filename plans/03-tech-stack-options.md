# Tech stack & service options

Decided items live in `01-decisions.md`. This doc is a **research menu** of
external services — options with pros/cons, biased toward generous free tiers and
open-source-friendly licensing. Founder to narrow down.

## Decided (recap)
- **Monorepo:** Turborepo + pnpm workspaces (D39).
- **Lint / format:** Biome, repo-wide (D46).
- **Testing:** Vitest everywhere (+ `fast-check`, `convex-test`; Playwright/Maestro
  for E2E later); GitHub Actions CI (D40).
- **DB / backend:** Convex (+ file storage). **No Convex components** — `@convex-dev/geospatial` was
  retired by N1 in favour of a plain-table ladder-grid spatial index (see D5).
- **Language:** TypeScript everywhere.
- **Mobile:** Expo / React Native + Tamagui.
- **Web:** TanStack Start + Tailwind + shadcn.
- **Shared:** design-token package, Convex client, types, validators, logic.
- **Geometry:** Turf.js for polygon contains/intersects in Convex functions.
- **Map renderer:** MapLibre GL — **locked** (D6).
- **Routing / isochrones:** **hosted OpenRouteService** — not self-hosted Valhalla
  (D18/D35); calls are rare + cached.
- **Observability:** Sentry (crash/error) now, PostHog (analytics/flags) later (D29).
- **Image optimization:** client-side resize + thumbnail before upload (D31).
- **Auth:** Clerk (D26). **Web host:** Vercel (D27).

> **Cost posture (D35):** favor Vercel-hostable / hosted free tiers over
> self-hosted infra; target **< ~$100/mo at ~1000 active users / ~600 reports+comments
> per month**. The stack below stays comfortably under that.

---

## 1. Map renderer + tiles

| Option | Pros | Cons |
|---|---|---|
| **MapLibre GL** ✅ **chosen (D6)** | BSD/open, no token for renderer, works web + RN via `@rnmapbox/maps`, full custom style JSON | You assemble tiles/routing/geocoding yourself |
| Mapbox GL | Great DX, one vendor, bundled geocoding + isochrones, Studio styling | Proprietary, per-use billing, every contributor needs a token |

**Tiles (MapLibre):**
| Option | Pros | Cons |
|---|---|---|
| **Protomaps** ✅ **chosen (D6)** | Single `.pmtiles` **static file** on any CDN/S3 — low-ops (no server) **and unmetered**, ~free, no API key, **offline-friendly** (cacheable file — fits the cold-field app, D9/D12), custom styles | You host the file; updates = re-extract |
| MapTiler | Free tier, hosted vector tiles + styles, geocoding too | API key in client; usage-metered caps; vendor lock-in |

**Why Protomaps over MapTiler (long-term):** unmetered static file matches the cost
posture (D35); it's genuinely offline-friendly for a cold-weather field app (D9/D12); the
OSM ETL we build in Phase 1 is the *same shape* of work as building a `.pmtiles` basemap;
and it keeps the stack fully open (D43). MapTiler wins on instant setup + polished default
styles — fine to borrow its free demo/hosted tiles to get pixels on screen early, then swap
to a self-built regional extract (D5 keeps renderer/tiles/data independent, so it's a
one-line style change). Attribution: **"© OpenStreetMap contributors"** (ODbL) either way.
| Stadia Maps | Free tier, hosted | API key; usage caps |
| Self-hosted tileserver-gl | Full control | Ops burden |

## 2. Routing / drive-time isochrones
(Needed for home→put-in drive-time filtering.)
| Option | Pros | Cons |
|---|---|---|
| Mapbox Isochrone API | Turnkey, accurate | Proprietary, billed, token |
| **OpenRouteService (hosted)** ✅ **chosen (D18/D35)** | Free tier, open, isochrone API, **no server to run** | Rate limits on free tier — but calls are cached per user (D18), so limits are ample |
| Valhalla (self-host) | Free, open, powerful | Ops burden — **rejected for v1** (D35); revisit only if we outgrow ORS |
| GraphHopper | Good routing, free tier | Limits |

## 3. Geocoding (home address → coords) — low volume, once per user
Prefer a **hosted** option (no self-hosting, per D35); volume is tiny (once per user).
| Option | Pros | Cons |
|---|---|---|
| **Hosted Photon / MapTiler geocoding** (leaning) | Turnkey, no ops; MapTiler key doubles for tiles if we ever use it | Key / free-tier caps (fine at this volume) |
| Nominatim (OSM public) | Free | Usage policy limits heavy use; acceptable only because volume is once-per-user |
| Self-hosted Photon/Nominatim | Full control | Ops burden — avoid (D35) |

## 4. Water-body dataset
| Option | Pros | Cons |
|---|---|---|
| **OSM** (via Overpass / regional extracts) | Easy to query, global, often named | Attribute quality varies |
| **USGS NHD** | US-authoritative, names + surface area + polygons | Large/complex; US-only |
**Leaning:** OSM for v1 ease; enrich with NHD (surface area, official names) later.
**ETL:** one-time offline (GDAL/QGIS) — clip to region, simplify polygons, import
to Convex with bounding-box fields for prefiltering.

## 5. Weather (for "N days of sun/rain since report" + context)
| Option | Pros | Cons |
|---|---|---|
| **Open-Meteo** (leaning) | Free, no key, forecast **+ historical archive**, open | Attribution appreciated |
| NWS / NOAA API | Free, US-authoritative | US-only, no historical archive as clean |
| OpenWeatherMap | Historical + forecast | Free tier limited; key |
| Tomorrow.io | Rich data | Paid-leaning |

## 6. Push notifications
| Option | Pros | Cons |
|---|---|---|
| **Expo Push** (leaning, mobile) | Free, wraps APNs/FCM, easy in Expo | Mobile only |
| FCM direct | Free | More wiring |
| **Web Push (VAPID)** (web app) | Free, native browser API | Separate impl from mobile |

## 7. Auth
| Option | Pros | Cons |
|---|---|---|
| **Convex Auth** | Free, in-house, no extra vendor | More DIY UI |
| **Clerk** | Batteries-included UI, social login, Expo + web, generous free tier | Extra vendor; free-tier MAU cap |
| Auth0 / WorkOS | Enterprise-grade | Heavier / pricier |

**✅ Chosen: Clerk (D26)** — batteries-included on Expo + web, wired to Convex.

## 8. Photo storage
| Option | Pros | Cons |
|---|---|---|
| **Convex file storage** (leaning, v1) | One system, simple | No built-in transforms → we optimize **client-side** (D31) |
| Cloudflare R2 | Cheap, free egress | Separate service |
| Cloudflare Images | Resizing built in | Cost at scale |

**Optimization (D31):** Convex has no image transforms, so **resize/compress on the
client before upload** — mobile `expo-image-manipulator` (~2048px long edge, JPEG
~q0.7) + a ~400px thumbnail; web via canvas / `browser-image-compression`. Smaller
uploads = faster/cheaper field sync (D9) + less storage. Revisit Cloudflare Images
only if on-the-fly variants are ever needed.

## 9. Web hosting (TanStack Start / Nitro presets)
| Option | Pros | Cons |
|---|---|---|
| Cloudflare Pages/Workers | Generous free tier | Preset config |
| Netlify | Free tier, easy | — |
| Vercel | Easy | Free-tier limits |

**✅ Chosen: Vercel (D27)** — first-class TanStack Start deploy.

## 10. Mobile builds
- **EAS Build** (Expo): free tier (limited builds/mo) or build locally.

## 11. Observability (D29)
| Option | Pros | Cons |
|---|---|---|
| **Sentry** ✅ (crash/error, now) | Best-in-class native RN/Expo + web crash/perf, symbolication, OSS, free dev tier | Analytics is not its focus |
| **PostHog** ✅ (analytics/flags, later) | Product analytics + feature flags + session replay, OSS, generous free tier (1M events/mo) | Error tracking newer/less mature for native crashes |

Use **both**, staggered: Sentry from day one (is it crashing in the cold?),
PostHog when we want usage insight + flags. Both free-tier / OSS.

## 12. Offline sync (mobile, D30)
Purpose-built draft queue — **not** a full replication engine:
`expo-sqlite`/MMKV (drafts) + `expo-file-system` (photos) + NetInfo reconnect flush,
each draft idempotency-keyed. Rejected as overkill: WatermelonDB, PowerSync,
Replicache.

## 13. Monorepo & build orchestration (D39)
**Turborepo** + **pnpm workspaces**. `apps/mobile` (Expo), `apps/web` (TanStack
Start), `packages/*` (design tokens, Convex client, types/validators, shared logic).
One `turbo.json` pipeline; local + remote task caching.

## 14. Testing & CI (D40)
| Layer | Tool |
|---|---|
| Unit / logic (shared packages, the bulk) | **Vitest** |
| Invariants (visibility, dedup IoU, point-in-polygon) | **fast-check** (property-based) |
| Convex functions (auth gating, sync, merges) | **`convex-test`** (Vitest) |
| Web components | Vitest + `@testing-library/react` + jsdom |
| Mobile components | `@testing-library/react-native` |
| E2E (as flows stabilize) | **Playwright** (web) · **Maestro** (Expo) |
| Lint / format | **Biome** repo-wide (D46) |
| CI | **GitHub Actions** — `pnpm lint` + `turbo check-types test` + coverage |

Strategy: push shared logic into `packages/*` so one Vitest suite covers both apps;
property-test the correctness-/safety-sensitive math; ratchet the coverage threshold
upward over time. Strict TS type-check is the first (cheapest) test tier.

---

## Locked default stack (low-ops, hosted, ~free — D35)
- **Turborepo** + pnpm workspaces (D39); **Biome** lint/format (D46); **Vitest** +
  GitHub Actions CI (D40)
- **MapLibre** (D6) + **Protomaps** static tiles + **hosted OpenRouteService**
  isochrones (D18) + hosted Photon/MapTiler geocoding
- **Open-Meteo** weather
- **Expo Push** + Web Push
- **Convex** DB + file storage (client-side image optimization, D31);
  **Clerk** auth (D26)
- **Sentry** (crash/error) now; **PostHog** (analytics/flags) later (D29)
- **Vercel** (web hosting, D27) + EAS (mobile builds)
- Data: **OSM** v1, **NHD** enrichment later

**Cost sanity check (~1000 active users / ~600 reports+comments per month):** Convex, Clerk
(free ≤10k MAU), Vercel, Open-Meteo, ORS (cached → tiny volume), Protomaps
(unmetered static file), Sentry/PostHog free tiers — all comfortably within
free/low tiers, well under the **< $100/mo** target (D35).
