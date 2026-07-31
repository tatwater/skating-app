# Accounts & credentials setup

A prioritized checklist of external accounts / API registrations, ordered by
**lead time and blocking-ness** — so nothing stalls the build later. Goal: get a
legit friends-only proof-of-concept running.

Legend: 💰 = costs money · ⏳ = has approval/enrollment lead time · 🆓 = free/instant

> **Cost posture (D35):** favor hosted free tiers over self-hosted infra; a small
> paid bill (target < ~$100/mo at ~1000 users) beats ops toil.

## Where this stands (added 2026-07-24, with every phase built)

Inferred from what the code actually uses — **not** from a founder confirmation, so treat the
"unknown" rows as *check before relying on them*. This exists because "which account is still
missing" is now the question that gates several deferred items, and the list below had no status at all.

| Account | State | Notes |
|---|---|---|
| Convex (dev) | ✅ in use | **Prod deployment never initialized** — the prod cutover's first blocker |
| Clerk (dev) | ✅ in use | Prod instance env vars are what unblock `convex deploy` to prod |
| Vercel | ✅ in use | `SENTRY_AUTH_TOKEN` still unset ⇒ no build-time source-map upload |
| Expo / EAS | ✅ in use | Dev builds; a **new dev-client build** is needed for the Phase 8 recorder |
| Sentry | ✅ in use | Both surfaces |
| OpenRouteService (hosted) | ✅ in use | 60-min isochrone ceiling ⇒ the 90-min band is a radius fallback. **Also N6d's `foot-hiking` approach routing (D87)** — same key, and `elevation: true` returns ascent |
| Cloudflare R2 | ✅ in use | 948 MB 5-state basemap |
| Open-Meteo | ✅ no account | Phase 10 forecast/history; also the **elevation** endpoint (N6c A1) |
| NWS `api.weather.gov` | ⬜ not set up | 🆓 **no account, no key.** N6c B5 alerts. Needs only a `User-Agent` header (D74) |
| Copernicus Data Space | ⬜ not set up | 🆓 registration. **Not needed for the N6c deep link** — only for N6e's Sentinel-2 *recent-ice* tier (D75/D84) |
| USGS / The National Map (NAIP) | ⬜ nothing to set up | 🆓 **no account, no key, no quota** — public-domain aerial. This is what ships N6e's satellite toggle (D84, §14b) |
| Windy API | ⬜ deliberately not set up | €990/yr, and there is **no MapLibre overlay path** — we link out instead (D75, §15) |
| Planet | ⬜ deliberately not set up | Quote-based. Their free catalogue duplicates Copernicus; only PlanetScope is new (§16) |
| Apple Developer | ✅ enrolled | Per the Phase 8 doc. TestFlight distribution to the alpha crew still pending |
| Strava API app | ✅ registered | **Callback domain not yet set** to the Convex `.site` host ⇒ no real OAuth round-trip yet |
| Resend | ❔ unknown | Operator alerts log-and-skip until the key + verified domain exist (D38) |
| Google Play | ❔ unknown | $25 one-time; needed for Android distribution **and** any Health Connect review |
| PostHog | ⬜ not set up | Deliberate (D29) — add when there's usage to measure; replay is L12-gated |
| Garmin / COROS / Polar | ❔ unknown whether applied | **Weeks of review.** These gate the deferred watch adapters — the roadmap has said "apply now" since Phase 0 |
| Expo Push / APNs / FCM | ⬜ not set up | No push infrastructure exists at all; blocks push delivery + silent-push refresh |

---

## Do these first (longest lead time / blocking)

### 1. Apple Developer Program — 💰 ⏳
- **What:** enroll at <https://developer.apple.com/programs/> ($99/year).
- **Why now:** required for **TestFlight** (how friends install the iOS build) and
  for **push notifications** on iOS. Enrollment/identity verification can take
  **a few days** — start early.
- **Individual** enrollment is simplest; org enrollment needs a D-U-N-S number.

### 2. Strava API application — 🆓 ⏳(for expanded access)
- **What:** create an app at <https://www.strava.com/settings/api>.
  - Set **Authorization Callback Domain** (localhost + your dev/prod domains).
  - Record **Client ID** and **Client Secret** (secret stays server-side/Convex).
- **Why now:** OAuth + webhook wiring is central; start testing against your own
  account immediately.
- **⏳ Watch-outs:**
  - New apps have **rate limits** (~100–200 requests / 15 min, ~1,000–2,000 / day —
    *verify current values*). Webhook-driven design keeps us under them (D-series
    notes). Request an **increase early** if needed.
  - New apps may have an **athlete/access cap** until you request expansion —
    fine for a small friends alpha, but apply for more **before** widening.
  - Enable a **webhook push subscription** for activity events (see
    `04-integrations.md`).
  - Must display **"Powered by Strava"**; review the current **API Agreement**
    (esp. 2024 limits on cross-user display + AI use) before pulling media/text.

### 2b. Other GPS provider developer programs — ⏳ (approvals!)
All six GPS providers ship in **v1** (D24), and several need **partner approval with
real lead time** — apply now, in parallel with everything else:
- **Garmin** — Garmin Connect Developer Program (Health/Activity API). Partner
  application + review (**weeks**). Push/ping activity notifications.
- **COROS** — COROS Open API developer/partner application + review.
- **Polar** — **AccessLink** API; register at <https://admin.polaraccesslink.com>
  (lighter than Garmin). Webhooks.
- **Apple HealthKit** — no partner approval; enable the **HealthKit entitlement** +
  privacy usage strings in the app (uses #1 Apple account). On-device.
- **Google Health Connect** — Android permissions + Play **health-data access
  review** for sensitive permissions. On-device.
See `04-integrations.md` for per-provider integration detail.

### 3. Google Play Developer account — 💰 (one-time)
- **What:** <https://play.google.com/console> ($25 one-time).
- **Why:** needed to distribute the Android build (internal testing track for
  friends). Not blocking early dev (Expo dev builds run without it), so it can lag
  Apple — but cheap, so just do it.

---

## Do these when you start wiring (fast / free)

### 4. Convex — 🆓
- Sign up at <https://convex.dev>, `npx convex dev`. Free tier is generous.

### 4b. Clerk (auth) — 🆓 tier
- Sign up at <https://clerk.com>; wire **Clerk ↔ Convex** (D26). Handles email +
  social login on **both** Expo and web.

### 5. Expo / EAS — 🆓
- Account at <https://expo.dev>. Needed for **EAS dev builds** (required for native
  map modules — Expo Go won't cut it) and **Expo Push**. Free tier includes a
  limited number of cloud builds/month (or build locally).

### 6. Routing provider — **OpenRouteService (hosted)** 🆓 (D18/D35)
- Sign up for an API key at <https://openrouteservice.org>. Chosen over self-hosted
  Valhalla to avoid running a routing server; isochrones are cached per user (D18),
  so the free tier is ample. Valhalla stays a "later, only if we outgrow ORS" option.
- **Second use, same key (D87, N6d):** the **`foot-hiking`** profile for parking → put-in approach
  distance, with `elevation: true` for **ascent in metres**. Called at **ETL time, once per put-in** and
  cached on the row — never from a request path — so it adds no per-user quota pressure. This is why
  N6d's trail-routing question needed no new vendor: *"do you know of a service with an API"* was already
  answered by an account we've had since Phase 4.

### 7. Map tiles — pick one (renderer = MapLibre, no account)
- **Protomaps** — 🆓, no account: build a regional `.pmtiles` and host on a CDN/S3.
- **MapTiler** — 🆓 tier + key at <https://maptiler.com> (also does geocoding).

### 8. Geocoding (home address → coords, low volume)
- Prefer a **hosted** option (no self-hosting, D35): **Photon**- or **MapTiler**-
  hosted geocoding (key). Public **Nominatim** is acceptable given once-per-user
  volume, if we respect its usage policy.

### 9. Weather — 🆓 no account
- **Open-Meteo** <https://open-meteo.com> — no key. Nothing to set up. **The single source for
  anything that feeds a calculation** (D74): forecast + `past_days` history for the D56 decay math.
  **Also N6c B5b's short forward forecast**, at no additional cost: `weather.ts:112` already sends
  `forecast_days: '1'` and the window filter discards the forward hours, so a drawer-side "will it be
  snowing when I get there" strip is a parameter change and a slice, not a new call.
- **Also Open-Meteo:** the **elevation endpoint** (`/v1/elevation`, Copernicus GLO-90 DEM, batched
  coordinates) — N6c's lake-elevation pass. Same vendor, same no-key posture, ~1,200 requests to
  cover all 116,070 centroids.
- **NWS `api.weather.gov`** — 🆓, **no account and no API key**, US-only. Added for N6c B5 (official
  winter-storm / ice-storm / wind-chill **alerts**, `/alerts/active?area={state}`).
  - **Setup is one header:** a `User-Agent` identifying the app (contact info encouraged). Their docs
    note a key **may be required in future** — leave a comment at the call site so that isn't a surprise.
  - Rate limits are unpublished; retry a 429 after ~5 s. Poll **per state on a cron**, not per view.
  - **Zone precision for v1** (founder call, 2026-07-31), as a ladder: bodies stamped with their NWS
    forecast zone match on it; everything else falls back to `states[]`. **Polling stays per-state** —
    zone precision is about *matching*, not fetching, so read cost stays independent of corpus size. The
    zone geometry is a public download and the stamp is the `adminAreas` point-in-polygon pass again.
    ⚠ Some alerts are issued by **county (SAME/FIPS)** rather than forecast zone; handle both id spaces
    or a class of alerts silently never matches, and a missing warning looks exactly like no warning.
  - **Never blend it with Open-Meteo** (D74) — it's an advisory layer, not a physics input.
  - Coverage gap: US-only. A Québec expansion would need Environment Canada.

### 10. Web hosting — Vercel (D27)
- **Vercel** — sign up at <https://vercel.com>; first-class TanStack Start deploy.

### 11. Push (mobile) — 🆓
- **Expo Push** handles APNs/FCM. For iOS you still need #1 (Apple). Create a
  **Firebase** project for **FCM** (Android) — free.

### 12. Observability — 🆓 tiers (D29)
- **Sentry** — sign up at <https://sentry.io>; add `@sentry/react-native` (mobile)
  + browser SDK (web). Free developer tier. Set up **from day one** for crash/error.
- **PostHog** — <https://posthog.com>; add later for product analytics + feature
  flags + session replay (generous free tier). OSS.

### 13. Transactional email — **Resend** 🆓 tier (D38)
- Sign up at <https://resend.com>; create an API key → store in **Convex env vars**.
- **Verify a sending domain** (add DNS records) so operator alerts don't land in spam.
- Templates authored with **React Email** (`@react-email/components`) — no account
  needed, it's a library. First use = founder alerts on new support tickets / safety
  flags (D37/D38). Clerk still owns auth emails (D26) — don't duplicate.

---

## External data providers — the numbers behind the calls (added 2026-07-30, N6c)

Founder ask: record cost, benefit and setup for the providers we evaluated during N6c scoping, so the
"why not" is checkable and the "when" has a trigger. All three decisions are D75 unless noted.

### 14. Satellite imagery — **Copernicus Data Space** 🆓 (D75)

**The decision:** deep-link now (no account), integrate later (free account, quota-bound).

- **Licence — this is the part that unblocked a deferred roadmap item.** Copernicus Sentinel data is
  under the **free, full and open Copernicus licence**: reproduce, distribute and adapt, with
  attribution. The roadmap parked the satellite-imagery layer for want of *"an imagery source whose
  terms permit the use"* — that question is now answered, and what remains is cost, not permission.
- **Tier 1 — the deep link (N6c, ships now): 🆓, no account, no quota.**
  <https://browser.dataspace.copernicus.eu/> with lat/lng/zoom + a ~14-day Sentinel-2 L2A window.
  Nothing to set up. ⚠️ Verify the query-param shape against the live browser at build time — it's the
  one URL format we don't control.
- **Tier 2 — imagery in the app (deferred): 🆓 registration**, Sentinel Hub–compatible OGC/Process APIs.
  - **Free-tier quota: 10,000 requests + 10,000 processing units per month; 300/min.**
  - A full-screen tile view is ~10–20 requests ⇒ only **~500–1,000 lake views/month** raw. Not enough
    for general use.
  - **Server-side tile caching is what makes it viable**, and the open licence permits it: a popular
    body is viewed many times but only needs fetching once per **~5-day** satellite revisit. That turns
    the quota from per-view into per-lake-per-week, which fits comfortably.
  - **Benefit:** 10 m resolution is enough that open water vs. black ice vs. snow-covered ice is
    visually obvious. Cloud cover is the real limiter, not resolution.
  - **Do this when** we know which handful of bodies get real traffic — caching only wins if reads
    concentrate. N6c's proving run (B3a) is what starts producing that evidence.
  - **→ Now scoped as [N6e](./phase-N6e-satellite-imagery.md) Workstream C (D84, 2026-07-31)**, where it
    is **Tier 2** of a two-tier split. Everything above still holds — but it is no longer what gates the
    satellite toggle, because Tier 1 doesn't need an account at all:

### 14b. Aerial imagery — **USGS / The National Map (NAIP)** 🆓 — **no account** (D84)

**The tier that actually ships the toggle**, and it needs nothing set up.

- `basemap.nationalmap.gov`'s `USGSImageryOnly` tile service — NAIP-derived aerial orthoimagery,
  **~0.6 m**, conterminous US, **XYZ-compatible**.
- **Public domain.** USDA/USGS federal imagery: **no account, no key, no quota, no licence review.** The
  three things that deferred in-app imagery are all absent.
- **Cost: €0**, with no tier to outgrow. There is nothing on this line to budget.
- **What it's for:** reading *access*, not ice. Leaf-on summer imagery refreshed every ~2–3 years is
  useless for conditions and ideal for finding the pull-off — which is why it pairs with N6d rather than
  with the weather work.
- **The one thing to watch is courtesy, not cost:** no published quota is not the same as no limits, and
  it isn't a CDN we control. v1 points MapLibre at it directly and measures; a caching proxy is available
  whenever load justifies it (public-domain imagery may be freely cached), and **it's the same proxy
  Tier 2 needs** — build it once, when Tier 2 does.
- ⚠ **Confirm at build:** ArcGIS tile axis order is `/tile/{z}/{y}/{x}` (**y before x** — wrong order
  returns tiles, just the wrong ones) and the behaviour past native max zoom.

### 15. Windy — 💰 **evaluated and declined** (D75)

**The decision: link out (in-app browser on mobile), do not buy the API.**

- **Cost, confirmed against their pricing pages (2026-07-30):**
  | Product | Free "Testing" tier | Professional |
  |---|---|---|
  | **Map Forecast API** | 500 sessions/day, **GFS only**, 3 layers, *"development purpose only, not intended for production"* | **€990/year** (+ **€1,000** for ECMWF), 10,000 sessions/day, 40+ layers |
  | **Point Forecast API** | 500 requests/day, and it **returns randomly shuffled and slightly modified data** | **€990/year**, 10,000 requests/day, ECMWF excluded by licence |
  *(Priced per product — using both looks like ~€1,980/yr. Confirm with them before assuming a bundle.)*
- **The blocker is technical, not financial.** The Map Forecast API is, in their words, *"a simple-to-use
  library based on Leaflet 1.4.x"* and is tightly coupled to it. **We render MapLibre.** There is no way
  to overlay Windy's animated layers onto our map — buying it means embedding *their entire map*
  alongside ours, i.e. shipping a second map engine.
- **The free tier cannot be used anyway** — dev-only for the map API, and deliberately corrupted data for
  the point API.
- **What we do instead:** open `windy.com/?<lat>,<lng>,<zoom>` through **`expo-web-browser`** on mobile
  (D76), which delivers the founder's actual goal — Windy's animation, over our app, with a Done button —
  for €0 and one line of code. Web opens a new tab.
- **The Point Forecast API is separately unnecessary**: it duplicates what Open-Meteo already gives us
  for free, and D74 says one physics source regardless.
- **Trigger to revisit:** we want animated weather *inside* our own map canvas AND a MapLibre-compatible
  path exists (their product, or a raster-tile endpoint). Absent that, more money doesn't buy a
  different answer.

### 16. Planet — 💰 **evaluated and deferred** (D75)

**The decision: wait. Revisit only on evidence.**

- **Cost: not publicly listed — quote-based via sales.** Their pricing page carries no figures. Assume a
  commercial subscription scoped per area-of-interest; budget a real conversation, not a signup.
  *(They also run an Education & Research program; we are not academic, so it doesn't apply.)*
- **What money does *not* buy.** Planet's public-data catalogue — Sentinel-1, Sentinel-2 L1C/L2A,
  Landsat 4–9, HLS, Copernicus DEM — is **the same free data we can get directly from Copernicus**.
  Paying does not unlock it.
- **What money *does* buy: PlanetScope — ~3 m, near-daily revisit.** For ice this is a genuine product
  difference, not a vanity upgrade: a lake can go from open water to skateable in 48 hours, and a 5-day
  revisit can miss the entire onset. Worth being honest that the case here is real.
- **Why not yet:** it's a commercial imagery subscription against a pilot with no revenue, and **we do not
  yet know whether anyone opens the imagery link at all.**
- **Low-regret detail:** Planet serves its public data from **Sentinel Hub endpoints**
  (`services.sentinel-hub.com`) — the same API surface as the Copernicus Data Space. Building against
  Copernicus now is *not* a lock-out; it's the same client either way.
- **Trigger to revisit:** the free Copernicus link sees real usage **and** we hit a case where the 5-day
  revisit demonstrably missed a freeze event.

---

## Deferred (do NOT set up yet — see open questions)
- **Meta / Facebook developer app** for group ingestion (Q8) — restricted APIs +
  ToS; only after a feasibility/legal pass.
- **Google Groups ingestion** — no clean API; parked.
- **Full legal review** (Q10) — after the friends POC. **Interim guardrails already in
  place:** a temporary privacy notice (`PRIVACY.md`), a signup **age gate (16+)** and
  **assumption-of-risk acknowledgment** (D41/D45), and the AGPL **App Store exception**
  (`LICENSE-EXCEPTIONS.md`, D43) — all of which a lawyer confirms before broad launch.

---

## Secrets handling
- Client secrets (Strava, provider keys) live **server-side in Convex env vars**,
  never in the mobile/web bundle.
- Keep a local `.env.example` documenting required vars; never commit real values.
