# Decisions log (ADR-style)

Running log of decisions we've made and *why*, so future-us knows the rationale.
Format: what we decided, the reasoning, and the date.

---

## D1 — Map-first, mobile-primary + web-secondary
**Decided.** Mobile (Expo/React Native) is the primary surface for field
reporting; web (TanStack Start) is secondary for planning/long-form.
**Why:** The core behavior (report live / just-finished, from the ice) is mobile.
Web serves the "big screen + keyboard" planning use case.

## D2 — Convex as the app database
**Decided.** Convex for reactive data (feeds, follows, notifications, reports),
file storage (photos), and its geospatial component for point queries.
**Why:** Real-time reactivity fits live reports/feeds; TS-native; batteries
included (files, geo). Not a geospatial DB for polygons — see D5.

## D3 — Safety-first, non-authoritative framing (product-defining)
**Decided.** The app never asserts ice is safe/good. Reports are named-peer
observations at a specific time+place. We only *contextualize* aging reports
(e.g. weather since the report). "Don't do it" reports are first-class.
**Why:** Ethics + liability. Preserves the community's existing safety culture.

## D4 — Reports attach to water bodies, with in-polygon hazard geometry
**Decided.** Reports are tied to a whole water-body polygon (OSM/NHD), *and*
users can draw points/lines/shaded areas *within* the polygon to mark specific
hazards. Lakes/ponds are thought of as whole units; rivers as segments.
**Why:** Matches how skaters actually think ("the north half of the lake was
skateable") while still capturing localized danger.

## D5 — Geo stack: renderer + tiles + routing + data are separate concerns
**Decided (direction).** Mapbox/MapLibre render + geocode + isochrones; water-body
polygons come from OSM/USGS NHD (offline ETL into Convex); spatial logic via
Convex geospatial component + Turf.js. No runtime PostGIS at our scale.
**Why:** Map SDKs don't provide queryable water-body *records*; we own the data
and the spatial queries.

## D6 — Renderer: MapLibre GL (locked)
**Decided.** MapLibre GL is the renderer (web + React Native via `@rnmapbox/maps`),
with Protomaps (`.pmtiles`) tiles, **hosted OpenRouteService** isochrones, and
hosted geocoding. Full locked stack + cost rationale in `03-tech-stack-options.md`.
**Why:** BSD/open, no per-use renderer billing, no contributor token, and full
custom style JSON for the icy/FUI look. Mapbox is easier DX but proprietary,
billed per-use, and needs a token per contributor.
**Note:** we favor *hosted* free tiers over self-hosted infra for the surrounding
services — tiles are a static file, isochrones are rare + cached (see D35).

## D7 — Styling: Tailwind+shadcn on web, Tamagui on mobile, shared tokens
**Decided.** Web = Tailwind + shadcn. Mobile = Tamagui (no NativeWind — redundant
with Tamagui). Share a plain-TS design-token package consumed by both; share
Convex client, types, validators, and logic — **not** UI components.
**Why:** Cross-platform sharing is logic/data/tokens, not UI. Each surface uses
its native idiom.

## D8 — Expo for the mobile app
**Decided.** Expo (with EAS dev builds — needed for native map modules).
**Why:** Maps, background sync, push, and OTA updates are all much easier.

## D9 — Offline capture + later sync
**Decided.** Reports (incl. photos) can be drafted offline and upload when signal
returns; prompt the user to report once back in coverage.
**Why:** People skate in areas with no cell signal; live-while-skating often can't.

## D10 — Reward system is honesty-oriented, never rewards going out
**Decided (principle).** Rewards go to *honest reporting* — including "don't do
it" — with bonuses for photo evidence and "helpful" thumbs from requesters.
Never reward the act of skating/going onto ice.
**Why:** A reward for going out would incentivize skating marginal ice — unsafe.
**Resolved (see D17):** points are cosmetic/reputational only in v1.

## D11 — Home address is private; town optionally public
**Decided.** Home address is used only to compute drive-time filtering; stored as
a coordinate, visible to no one else. Users may optionally show their **town** on
their profile. Every report has one of **four** visibility levels:
Just me / Friends / Followers / Public (see D13).
**Why:** Address is sensitive PII (where you live + when you're away).

## D12 — Location model: opportunistic + post-hoc, never live GPS
**Decided.** No continuous background/live GPS tracking, ever — leave that to
other apps/devices. Instead:
- **On app-open, grab the user's current location** (opening the app implies
  intent to report at/near their spot). If that location is near known hazards,
  prompt to confirm them then.
- **After a Strava (or other GPS provider) activity uploads,** use its path *post-hoc* to check whether it
  passed near/over/around known hazards and prompt accordingly.
**Why:** Preserves battery (cold + wind drains phones fast) and avoids creepy
always-on tracking, while still enabling hazard confirmation.

## D13 — Social graph & report visibility
**Decided.**
- **Follow is the primitive; a mutual follow == "friends."** No separate
  friend-request concept.
- **Per-report visibility (4 levels):** *Just me* → *Friends* (mutual) →
  *Followers* → *Public*.
  - **Public** = contributes to the shared map/newsfeed any nearby user sees.
  - **Followers** = only your followers' feeds; does **not** populate strangers'
    maps. (This is the "spot secrecy" valve.)
- **Account-level "require approval for followers"** toggle (private-account
  pattern), orthogonal to per-report visibility.
**Why:** "Public" carries specific meaning here (feeds the shared map), so it's
genuinely distinct from "Followers." Familiar IG/Twitter mental model.
**Note:** default visibility should lean **Public** (or Followers) so the shared
map doesn't go sparse (cold-start), while fully respecting user choice.

## D14 — User-created (unmapped) locations allowed
**Decided.** Users can drop a pin / draw a water body not present in OSM/NHD.
**Why:** OSM/NHD miss small ponds, flooded fields, specific put-ins.
**Follow-up (must address before too long):** deduplication of user-created
locations that overlap each other or official polygons. Kept simple for now.

## D15 — Hazard lifecycle (Waze-style time-decay + confirmation)
**Decided (defaults, tweakable).**
- **< 24h** since last confirmation → *fresh* (full strength on map).
- **24–72h** → *aging* (visibly lighter).
- **> 72h** → *stale* (heavily faded; hidden by default behind a "show older" toggle).
- A **"still there" confirmation resets the clock** to fresh.
- **"Gone" reports** (small threshold, e.g. 2 independent; later reputation-weighted)
  **archive** the hazard (not hard-delete, so it can resurface if re-reported).
- Confirmation is **opportunistic** (per D12): on app-open near the hazard, when
  drafting a report on that water body, or via post-hoc Strava-path proximity.
**Why:** Mirrors Waze's proven model; ice changes fast so decay must be visible.

## D16 — Notifications are per-type toggleable
**Decided.** Every notification type (Strava/GPS provider ice-skate detected, bounty request on
a lake you skated, followed-user posted nearby, hazard-confirmation request, …) is
individually mutable in user settings.
**Why:** Avoid notification fatigue as the community grows.

## D17 — Reward points are cosmetic/reputational only (v1)
**Decided.** Points/badges are status only — no unlocks, no economy. Bonuses for
photo evidence + "helpful" thumbs from requesters. Never rewards going onto ice.
**Why:** Avoids building a real economy and avoids unsafe incentives.

## D18 — Real drive-time filtering via cached per-user isochrone
**Decided.** Filter by **actual drive time** from home, not straight-line radius.
Architecture that makes this cheap:
- Compute **one isochrone polygon per user** ("area reachable within N min drive
  from home") and **cache it** on the user record.
- Recompute only when the user changes **home** or **drive-time preference** —
  rarely. Not per report, not per map pan.
- Filtering = **point-in-polygon** (Turf.js) against the cached isochrone — same
  cost as a radius test.
- **Radius kept only as a defensive fallback** if routing is ever unavailable.
**Routing provider:** **hosted OpenRouteService** (free tier) preferred — calls
are rare + cached, so free-tier limits are ample and we avoid running a routing
server. Self-hosted Valhalla only if we ever outgrow ORS (see D35).
**Known v1 approximation:** we test the water body's location against the
isochrone, not the exact parking/put-in (often unknown yet). Refine with put-in
points later.
**Why:** Drive time is the right mental model ("how far am I willing to drive")
and the per-user-cached design removes the performance concern.

## D19 — "Weather since report" is descriptive, not predictive
**Decided.** For each aging report, show what the weather has *done* since the
skate time — peak temp, hours at/near freezing, hours of sun, total precipitation,
wind — from Open-Meteo history. Users draw their own conclusions.
**Why:** Supports judgment (D3) without asserting anything about current ice.
See `04-integrations.md` for the exact variable mapping.

## D20 — Map default framing: home when browsing, water body when on the ice
**Decided.** On app-open, after grabbing location (D12):
- If the user's location is **on/at a body of water** — inside its polygon or
  within a small shore buffer (~200m, to cover the parking/put-in) — **fit the map
  to that water body** (fill the screen with it) and surface its report/hazard
  prompt. This is the "I'm here to report" case.
- Otherwise, **center on home** (the planning/browsing case).
- If ambiguously near several, pick the **containing or nearest** water body.
- This sets only the **initial** framing; once the user pans/zooms, don't fight them.
**Why:** Opening the app while standing on Lake Morey should show Lake Morey, not
your house — matches the live-reporting intent behind grabbing location on open.

## D21 — Comments/conversations are v1 and nestable
**Decided.** Reports have threaded `comments` (nestable via `parentCommentId`; UI
caps depth). Comment **visibility inherits the parent report** (never wider).
**Why:** The email forums are fundamentally conversational (follow-ups, "how was
parking?"); the newsfeed references conversations.
**Ingestion nuance (Q8):** email replies must be classified **comment vs. new
report** (people reply to a report with their own report). Proposed: an **AI
classifier** over forum/email content routes each message. That AI runs on
email/forum data (not Strava), so it's **outside Strava's AI terms** — but the
ingestion itself remains legal-gated (Q8).

## D22 — Ice thickness captured as structured multi-readings
**Decided.** Optional `iceThickness.readings[]`: each a single value **or** range,
tagged **measured vs. estimated** (estimated = lower-trust), optionally located
within the polygon. Supports multiple test spots with different values.
**Why:** Real observations vary across a water body; a single number would lie.
Framed as one person's spot readings, never authoritative (D3).

## D23 — Report ice rating: keep BOTH coarse + tags
**Decided.** A coarse overall `skateQuality` (great/good/fair/poor, shown at the
top level) **and** detailed `iceTypes` / `surfaceTags`. Both optional.
**Why:** Quick-scan summary + drill-down detail. Neither is a safety verdict (D3).

## D24 — Trusted skated extent from GPS only; provider-agnostic activities
**Decided.** No manual "shade what you skated" UX. The **trusted** skated extent
comes only from a real GPS track on a linked activity. The architecture is
**provider-agnostic**: `activityConnections` + `gpsActivities` carry a `provider`
field and all six providers (Strava, Garmin, COROS, Polar, Apple HealthKit, Google
Health Connect) are v1-scoped.
- **Apply for ALL approvals in Phase 0** — Garmin/COROS/Polar partner reviews have
  weeks of lead time; don't let them gate later work.
- **Ship order within the GPS phase (fast-follow, not simultaneous):**
  **Strava + Apple HealthKit first** (covers most of the US alpha — Strava carries
  the write-ups/photos, HealthKit covers Apple Watch), **Garmin next** (watch GPS,
  and our fallback for map display — see below), then **COROS / Polar / Google
  Health Connect** as fast-follow.
- **Cross-user map display is ToS-gated (see D35 / `04-integrations.md`):** Strava's
  2024 terms restrict showing one user's Strava data to *other* users. We'll display
  a Strava-sourced GPS path publicly **only if the terms allow**; if not, we source
  the same path from a provider whose terms permit it (Garmin/COROS/Polar/on-device)
  and encourage users to connect that too. **Native reports never require a GPS
  path**, so we're never blocked from shipping.
- **Fitbit is not a v1 provider** (Health Connect doesn't reliably expose Fitbit GPS
  routes; many Fitbit users sync to Strava anyway) — logged as a possible future add.
**Why:** Only device-recorded GPS can be trusted for *where* someone actually
skated; hand-drawn areas can't. Multiple providers widen who can contribute.
**Why (also, D4 reconciliation):** the "north half was good" nuance is captured by
the GPS path (where they went) + the report's overall description, not a drawn area.

## D25 — Units, edits, comment depth (housekeeping)
**Decided.** (a) Store **metric internally, display imperial** (US crowd).
(b) Report edits are **last-write-wins** with `updatedAt` — no version history in v1.
(c) **Cap comment nesting at 2–3 levels** in the UI (data model allows deeper).
**Why:** Simplest choices that fit the audience and v1 scope.

## D26 — Auth: Clerk
**Decided.** Use **Clerk** for auth (not Convex Auth), across Expo + web, wired to
Convex.
**Why:** Batteries-included UI, social login, works on both surfaces, generous free
tier — fastest path to a friends alpha.

## D27 — Web hosting: Vercel
**Decided.** Deploy the TanStack Start web app on **Vercel**.
**Why:** Founder preference; first-class deploy target for the web stack.

## D28 — App navigation: Map + Newsfeed as co-primary pages
**Decided.** Two top-level pages — **Map** (default, spatial) and **Newsfeed**
(chronological, cross-water-body, in-range, temporary radius expansion) — plus
create/detail/profile flows. Route structure documented in `00-vision.md`.
**Why:** Newsfeed serves the "where's the community been lately?" browse/inspiration
need that lake-by-lake tapping doesn't.

## D29 — Observability: Sentry (errors/crash) + PostHog (analytics/flags)
**Decided.** **Sentry** for crash/error/performance monitoring from day one
(mature Expo/React Native + web support, symbolication, generous free tier).
**PostHog** for product analytics, feature flags, and session replay — added when
we want usage insight (also OSS, generous free tier). They overlap only partially:
Sentry owns native crash quality; PostHog owns product analytics.
**Why:** A field app used cold/offline needs early crash visibility. Both are
open-source with free tiers, matching the project's ethos and cost posture (D35).

## D30 — Offline capture & sync mechanics (Expo)
**Decided.** Implement D9 with a small, purpose-built draft queue — **not** a full
offline-first replication engine (WatermelonDB/PowerSync/Replicache are overkill;
our offline surface is only the user's *own* unsent drafts).
- Persist draft reports to **expo-sqlite** (or MMKV); persist captured photos as
  files via **expo-file-system**.
- Detect reconnect (NetInfo / `expo-network`); on reconnect, flush the queue:
  upload photos to Convex storage → call the create mutation.
- Each queued draft carries an **idempotency key** so retries never double-post.
- Prompt the user to submit pending drafts once back in coverage (D12).
**Why:** Convex has no durable offline mutation queue out of the box; a narrow
queue is simpler, debuggable, and battery-cheap.

## D31 — Image optimization on upload (client-side)
**Decided.** Resize/compress photos **on-device before upload**, not after. Convex
file storage has no built-in transforms — so we do it client-side:
- Mobile: **`expo-image-manipulator`** — downscale to ~2048px long edge, JPEG
  ~q0.7, plus a ~400px **thumbnail**.
- Web: canvas / `browser-image-compression`, same targets.
- Store both the optimized full image and the thumbnail in Convex storage.
**Why:** Smaller uploads sync faster/cheaper over weak field signal (battery +
D9), cut Convex storage cost, and need no extra service. Revisit Cloudflare Images
only if we later need on-the-fly variants.

## D32 — Content moderation, abuse reporting & safety enforcement
**Decided.** As a public UGC app with a social graph, we build basic safety tools
in v1-social scope: **block/mute** other users, **flag/report** a report, comment,
photo, or user for abuse, and a lightweight **takedown/hide** path for moderators
(founder initially). A dangerously false "the ice is great!" report is a *safety*
issue, not just spam — flagging must be prominent.
**Why:** Required for any public community; interacts directly with the safety-first
principle (D3). Data model adds `blocks` + `contentFlags` and moderation status
on user-generated content.

## D33 — Account lifecycle: deletion, retention, export
**Decided.** Users can **delete their account** and **export their data**. On
deletion we **anonymize** their past reports/comments (author replaced with a
"deleted user" tombstone) rather than hard-deleting the content, preserving the
community's historical ice record — unless a report is set to `just_me`, which is
removed. Full policy wording waits on legal (Q10), but the product behavior is
decided now.
**Why:** Privacy/PII obligations (D11) and user trust; but community value lives in
the report history, so anonymize-don't-erase is the default.

## D34 — Accessibility & theming (high-contrast + dark mode)
**Decided.** Two first-class themes: a **high-contrast / bright outdoor** mode for
readability in glare on sunny ice days, and a **dark mode** for evening planning at
home. Meet baseline accessibility (WCAG AA contrast, dynamic type, screen-reader
labels) — the FUI aesthetic (00-vision) must never cost legibility.
**Why:** The core use happens outdoors in bright sun with cold hands; readability
is a safety feature, not a nicety.

## D35 — Cost posture / hosting philosophy
**Decided.** Prefer **Vercel-hostable + hosted free-tier** services over
self-hosted infra. Accept a small paid bill for convenience: the target is to stay
**under ~$100/mo at ~1000 active users / ~600 reports+comments per month**, which
the current stack does comfortably. Concrete consequences:
- **Hosted OpenRouteService** for isochrones instead of self-hosted Valhalla (D18) —
  no routing server to run; calls are cached per user so free-tier limits are ample.
- **Protomaps** kept (it's a *static `.pmtiles` file* on a CDN/R2, not a server —
  low-ops **and** unmetered, so it beats metered tile APIs at our scale).
- Avoid standing up multiple self-hosted services just to stay free; if free-tier
  juggling gets burdensome, pay for the turnkey option instead.
- **Later:** a "Buy me a coffee"-style optional contribution, never paywalled
  features (monetization stays deferred — 00-vision).
**Why:** Founder-funded passion project; developer time is the scarce resource, so
trade a few dollars for less ops toil.

## D36 — Water-body dedup: match-on-create + soft-tombstone merge (resolves Q12)
**Decided.** Dedup of user-created locations (D14) is mostly *prevention* at
creation time, with a light merge path for the rest. **The cheapest dedup is the
one that never creates the duplicate.**
- **Match on create:** before writing a new `waterBodies` row, prefilter nearby
  candidates (bbox + geospatial-nearest on `centroid`) and score with Turf.js —
  `booleanPointInPolygon` for a dropped point, **IoU** (`area(intersect)/area(union)`)
  for a drawn polygon, plus normalized **name similarity** as a booster. Show
  ranked matches ("attach here?"); creating new requires an explicit "None of these."
- **Thresholds (tunable):** point-in-polygon → strong; polygon IoU ≥ 0.5 →
  suspected, ≥ 0.9 → near-certain; centroid < ~75m (small/point bodies) → suspected;
  name similarity ≥ 0.8 bumps a tier.
- **Classify on create:** stamp `dedupStatus`; overlaps with official OSM/NHD prefer
  attaching to the official body.
- **Merge = re-point + tombstone:** pick a survivor (official `source` beats user;
  else more reports / earlier / better geometry), **re-point child `reports` /
  `hazards` / `bounties`** to it, then soft-tombstone the loser
  (`dedupStatus: merged`, `mergedIntoId` → survivor). Never hard-delete — reuses the
  archive/anonymize pattern from D15/D33 so old refs resolve and bad merges reverse.
- **Rivers are reaches, not areas (D4):** compare linear bodies by buffered-line
  overlap / Hausdorff distance along the reach, **not** IoU.
- **Re-ETL overlap:** when a later OSM/NHD import overlaps a user body, run the same
  scan — flag, or auto-merge user→official at high confidence (official survives).
- **Staged rollout:** v1 = match-on-create + a **moderator review queue** (reuses the
  D32 moderator role) with a manual merge button. Later = auto-merge only very-high-
  confidence pairs + community "same place?" confirmations (Waze-style, cf. D15).
**Why:** No clustering infra needed at our scale; the UX prevents most dups and the
merge reuses patterns already in the plan (soft tombstones, moderator queue,
reputation-weighted confirmations).
