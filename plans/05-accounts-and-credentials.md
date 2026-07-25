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
| OpenRouteService (hosted) | ✅ in use | 60-min isochrone ceiling ⇒ the 90-min band is a radius fallback |
| Cloudflare R2 | ✅ in use | 948 MB 5-state basemap |
| Open-Meteo | ✅ no account | Phase 10 |
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

### 7. Map tiles — pick one (renderer = MapLibre, no account)
- **Protomaps** — 🆓, no account: build a regional `.pmtiles` and host on a CDN/S3.
- **MapTiler** — 🆓 tier + key at <https://maptiler.com> (also does geocoding).

### 8. Geocoding (home address → coords, low volume)
- Prefer a **hosted** option (no self-hosting, D35): **Photon**- or **MapTiler**-
  hosted geocoding (key). Public **Nominatim** is acceptable given once-per-user
  volume, if we respect its usage policy.

### 9. Weather — 🆓 no account
- **Open-Meteo** <https://open-meteo.com> — no key. Nothing to set up.

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
