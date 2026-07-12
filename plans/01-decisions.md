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
**Note:** default visibility is **derived** (public for adults with public profiles;
followers for locked profiles and all under-18 accounts) so the shared map doesn't go
sparse (cold-start) while fully respecting user choice — see **D41** for the mechanics.

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
**Implementation note (identity split).** Clerk owns the auth user; we own a **`profiles`**
table (renamed from the data model's `users`) that mirrors it, tied by
`profiles.clerkUserId` = Clerk `identity.subject`. Every other entity references a user by
their `profiles._id`, never a Clerk id. `convex/auth.config.ts` registers Clerk as the
Convex identity provider (needs the `CLERK_JWT_ISSUER_DOMAIN` deployment env var + a Clerk
JWT template named `convex`); `convex/profiles.ts` provisions the row (`upsertFromClerk`,
idempotent, enforces the 16+ gate and username uniqueness). The security boundary is the
Convex function (D37), which resolves the caller's profile and gates on `status`/`role`
server-side — not the deployment.

## D27 — Web hosting: Vercel
**Decided.** Deploy the TanStack Start web app on **Vercel**.
**Why:** Founder preference; first-class deploy target for the web stack.

## D28 — App navigation: Map + Newsfeed as co-primary pages
**Decided.** Two top-level pages — **Map** (default, spatial) and **Newsfeed**
(chronological, cross-water-body, in-range, temporary radius expansion) — plus
create/detail/profile flows. Route structure documented in `00-vision.md`.
**Why:** Newsfeed serves the "where's the community been lately?" browse/inspiration
need that lake-by-lake tapping doesn't.
**Web refinement (D47):** on web these two stay top-level, but **Report and Bounties are
folded into them** (report surfaced on both; bounties on Map) rather than getting their
own top-level routes — see D47. Mobile keeps its five tabs.

## D29 — Observability: Sentry (errors/crash) + PostHog (analytics/flags)
**Decided.** **Sentry** for crash/error/performance monitoring from day one
(mature Expo/React Native + web support, symbolication, generous free tier).
**PostHog** for product analytics, feature flags, and session replay — added when
we want usage insight (also OSS, generous free tier). They overlap only partially:
Sentry owns native crash quality; PostHog owns product analytics.
**Why:** A field app used cold/offline needs early crash visibility. Both are
open-source with free tiers, matching the project's ethos and cost posture (D35).
**Session-replay gating (minors + location — resolves review item #1):** PostHog
**session replay ships OFF** initially, and is **never recorded for minors** by
construction. Mechanics:
- Everyone is 16+ (D41), so the population is 16+; the sensitive slice is **under-18
  (`isMinor`) users** plus the fact that this is a *location* app.
- Initialize PostHog **with recording disabled** (`disable_session_recording: true`);
  analytics *events* (counts) are fine for everyone. Only **`startSessionRecording()`
  after the user resolves AND `isMinor === false`** — so a minor's session is never
  captured even if replay is later enabled. This is a few lines, gated on the Convex
  user record; the only nuance is that PostHog usually inits at boot before the user
  loads, so start recording *after* auth resolves, not at init.
- When replay is eventually turned on for adults, run it with input/text **masking**
  on (`maskAllInputs`, mask location UI) so coordinates/PII don't leak into replays.
- Update this notice/PRIVACY.md before enabling replay in production.

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
**Export format:** a **JSON bundle** of the user's own data (profile, reports,
comments, hazards created, follows, connections metadata — *not* secrets/tokens) plus
their uploaded **photo files**. JSON is the right call: machine-readable, matches the
TS stack, trivially generated from Convex, and easy to extend — no need for a
heavier/standardized format at this scale.

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

## D37 — Admin/moderator surface: gated `/admin` in the web app (not a separate app)
**Decided.** The operator experience (moderation + app administration + support) is a
**role-gated `/admin` route tree inside the existing TanStack Start web app** (D1/D27),
**not** a second application.
**Why:**
- The web surface exists precisely for the keyboard/big-screen tasks (D1); moderation
  (reading flag context, comparing duplicate polygons on a map, writing ban reasons) is
  exactly that. It's the web app's natural second job.
- **Zero new infra**, which is the cost posture (D35): a separate app duplicates the
  Vercel project, Clerk config, CI, and Convex wiring to serve *one* operator (founder)
  at launch. Not justified.
- **The security boundary is the Convex function, not the deployment.** Every admin
  capability is a Convex function that hard-checks the caller's `role` server-side; a
  separate frontend adds no real isolation. Never trust the client for authorization.
- Operators need the same context members see (report, thread, map) **plus** extra
  actions — sharing the app reuses those components instead of rebuilding them.
**Role model.** Expand `users.role` from `member | moderator` to
**`member | moderator | admin`**. Moderator = content (flags, takedowns, water-body
merges/rejections). **Admin ⊇ moderator**, plus bans, role-granting, support, and
anything touching PII / account lifecycle. Keeps the door open for external/volunteer
moderators without handing them the keys. Role-granting is admin-only and audited.
**Model additions (see `06-data-model.md`):**
- **Ban/suspend state on `users`:** `status` gains `suspended | banned`
  (+ `statusReason`, `suspendedUntil`, `moderatedByUserId`). Source of truth in Convex
  (every function gates on `status`); **also lock the account in Clerk** so no new
  session issues (belt + suspenders). A ban preserves the account for appeal/reversal —
  distinct from D33 deletion, which scrubs PII.
- **`moderationActions` audit log** (who/what/why/when) — essential for multiple mods,
  appeals, and reversals; mirrors the never-hard-delete/reversible ethos (D15/D33).
- **User-created water-body review:** `waterBodies` gains a `reviewStatus`
  (`pending | approved | rejected`) for `source: user` bodies — distinct from
  `dedupStatus` (D36 handles *duplicates*, not *approval*). Default **auto-visible +
  review-after** (a skater on unmapped ice shouldn't wait on a human — cf. the
  don't-block-shipping instinct in D24); mods can reject/merge later.
- **`supportTickets`** — a lightweight in-app table + admin inbox, not Zendesk (D35);
  auto-captures context (userId, app version, device, recent Sentry event) an email can't.
**Surface = work queues, not pages:** flag queue (with **`unsafe_false_report` pinned to
a priority lane** — a dangerously false "ice is great" report is a *safety* incident per
D3, not FIFO spam), water-body review queue (D36 merge + user-body approve/reject on a
map), user admin (search/history/ban/suspend/role), support inbox, and a dashboard
(open/safety-flag counts, pending bodies, recent actions; later links to PostHog/Sentry
per D29).
**Scope.** Lands in **Phase 4** (the operator/moderation phase — the review split of
the old Phase 3; see `07-roadmap.md`).

## D38 — Transactional email: Resend + React Email
**Decided.** **Resend** is the transactional email provider; email templates are authored
with **React Email** (`@react-email/components`). Sent from **Convex actions** (Node
runtime) via the Resend SDK/API; API key lives in Convex env vars (never client-side).
**First use — operator alerts (D37):** email the founder on every **new
`supportTickets` row**, and on any **safety-priority** item (`unsafe_false_report` flags,
`category: safety` tickets). Without this, tickets pile up unseen — email is the founder's
actual inbox of record. Alert emails deep-link into the `/admin` queue.
**Why:**
- Resend is developer-first with a **generous free tier** (fits D35's cost posture) and
  is the natural pairing with React Email (same authors).
- **React Email** = author templates as React/TSX with a live preview — same idiom as the
  rest of the TS stack (D7), and templates can share the design-token package.
- Convex actions already hold the other server secrets (D24/integrations); email send is
  just another server-side action.
**Boundaries.** Resend is for **app transactional/operator** mail. **Clerk still owns auth
emails** (verification, magic links, password reset — D26); we don't duplicate those.
User-facing product email (digests, etc.) stays deferred; in-app `notifications` (D16)
remain the primary user channel. Wire alongside the D37 admin surface in **Phase 4**.

## D39 — Monorepo tooling: Turborepo
**Decided.** The monorepo is a **Turborepo** workspace (pnpm workspaces underneath),
with the shared `packages/*` (design tokens, Convex client, types/validators, logic)
and the two `apps/*` (Expo mobile, TanStack Start web) as workspace packages.
**Why:** Turbo's task graph + remote/local caching makes `lint`/`typecheck`/`test`/
`build` fast and incremental across packages, and it's the idiomatic choice for a
TS monorepo sharing logic/tokens across surfaces (D7). No custom build orchestration
to hand-roll.
**Consequences:** one root `turbo.json` defines the pipeline; CI (D40) runs Turbo
tasks and reuses the cache; each package owns its own `package.json` scripts.

## D40 — Testing & CI: Vitest everywhere, layered strategy
**Decided.** **Vitest** is the test runner across the whole monorepo, with as much
coverage of *both apps' logic* as we can get. The strategy is layered so effort lands
where bugs are most costly (spatial math, visibility, safety):
- **Unit / logic (the bulk):** Vitest over the shared `packages/*` — visibility
  resolution (D13), dedup scoring/IoU (D36), isochrone point-in-polygon (D18),
  hazard-freshness derivation (D15), unit conversion (D25), the "weather-since"
  reducer (D19). Pure functions, no I/O — fast and deterministic.
- **Property-based tests (`fast-check`)** for the gnarly invariants where
  example-based tests miss edge cases: visibility resolution (never wider than the
  report's setting; blocks always win), dedup IoU thresholds, point-in-polygon near
  boundaries. High value given these are *correctness- and safety-sensitive*.
- **Convex functions:** **`convex-test`** (Vitest-based) to exercise queries/mutations
  against an in-memory Convex — auth gating (every admin fn checks `role`, D37),
  idempotent offline sync (D30), re-point-on-merge (D36).
- **Web components:** Vitest + `@testing-library/react` + jsdom for the shadcn/Tailwind UI.
- **Mobile:** Vitest for all RN *logic/hooks* (the shared logic already lives in
  `packages/*`, so most of it is covered there); component-level RN testing via
  `@testing-library/react-native`.
- **End-to-end (added as flows stabilize):** **Playwright** for web; **Maestro** for
  the Expo app (lighter than Detox, great for the offline-capture → sync flow, D9/D30).
**CI (GitHub Actions):** on every PR run **`pnpm lint`** (Biome, D46), **`pnpm
check-types`** and **`pnpm test`** (both via Turbo, so they cache — D39), publish
**coverage** (uploaded as an artifact now; Codecov later) with a ratcheting threshold
on `packages/*` (start realistic, only ever raise it), and gate merges on green. Add an
EAS build + `expo-doctor` check and a Convex deploy-preview later. Type-check counts
as a test tier — strict TS is the cheapest bug filter we have.
**Realized (Phase 0):** `@skating/core` is the first package — pure logic (units,
visibility resolution, hazard freshness, weather-since) at **100% coverage** with
example + `fast-check` property tests; the CI workflow (`.github/workflows/ci.yml`)
runs the three checks on Node 22.
**Why:** A field safety app that runs cold/offline can't lean on manual QA; the
spatial + visibility + safety logic is exactly what property tests and `convex-test`
are good at. Vitest keeps one runner/config idiom across the stack (matches D7).

## D41 — Minimum age 16; default report visibility derived from profile + age
**Decided.**
- **Minimum age is 16.** Under-16 accounts are not permitted. **We collect the user's
  date of birth at signup** and *derive* the age gate (≥16) and minor status (<18) from
  it (age math in `@skating/core`; stored as `profiles.dateOfBirth`). 16 lets the
  occasional independent teen skater participate without pulling us into full
  child-directed-service obligations; the realistic user base is overwhelmingly adults.
- **Default report visibility is *derived*, never a bare "public":**
  - **Adult + public profile (the default):** new reports default **`public`**.
  - **Private/locked profile** (account has `requireFollowApproval` on, i.e. the user
    locked down — D13): new reports default **`followers`**, not public.
  - **Any under-18 account:** starts **locked** (`requireFollowApproval` seeded on at
    signup), so via the locked-profile rule above their reports default **`followers`**
    and never *default* to public — **not** via a live age check at post time. The lock
    **persists past 18**, so a **birthday never changes a post default**; the public
    options merely become available to select. The post default is therefore a pure
    function of the stored privacy setting (`deriveDefaultVisibility` takes no age input).
    *Corollary:* the profile-settings mutation must not let a minor unlock — the age
    check belongs at the moment of *changing the setting*, not at post time.
- **"If your profile is public, your reports are public (by default)"** is the mental
  model — one obvious switch (lock the profile) cascades to a safer default. **New
  features must honor existing per-user privacy settings** — a later feature never
  silently widens exposure.
**Why:** Public-by-default fights cold-start (D13) *without* overriding user choice:
locking the profile is the one-tap privacy valve, and minors get a protective default
regardless. Keeps the privacy-by-default principle (00-vision) and the cold-start
need honestly reconciled instead of left as a "lean."
**Note:** This is the resolution of the D13 tension flagged in review — D13's "lean
public" now has concrete, safe mechanics.
**Updated (2026-07-10):** originally this stored *no* birthdate — a bare self-attested
16+ flag plus an `isMinor` boolean — to minimize PII (D11). Changed to store DOB because
the boolean model made the **minor→adult transition undetectable**: `isMinor` could only
flip via manual re-attestation, so protections were sticky-forever and the 18th birthday
was a non-event. Deriving age from a stored DOB makes that transition automatic
(recomputed at read time, like suspension lapse) — at 18 the public options simply become
*available* to choose; nothing already set is silently widened. This is a deliberate,
bounded relaxation of D11's minimization in exchange for correct lifecycle handling: DOB
is treated as sensitive PII (**scrubbed on deletion, D33**), and the precise compliance
posture around collecting minors' birthdates is flagged for the ToS/legal review (Q10).
**Implementation status (Phase 0, 2026-07-11):**
- **Done — server gate:** `convex/profiles.upsertFromClerk` takes `dateOfBirth` and enforces
  the hard 16+ minimum server-side (`meetsMinimumAge`, `@skating/core`); minor status is
  derived, so it self-corrects at 18 with no job. `parseDateOfBirth` (mobile) now rejects
  implausibly ancient years (< 1900) so junk dates can't sail past the gate as "very old".
- **⏳ Still to come:** like the acknowledgment (see D45's status note), the mobile client
  doesn't yet *call* `upsertFromClerk`, so the client-side age gate is UX-level until the
  auth-provisioning PR wires it through the enforced mutation path.
- **Done — timezone birthday boundary (was review finding 4):** the signup gate
  (`meetsMinimumAge`) previously compared a **UTC-midnight DOB** against the **current
  instant**, so a user already 16 on their *local* calendar in a timezone ahead of UTC was
  briefly rejected until UTC caught up. Fixed in `@skating/core` by evaluating the gate at
  `now + MAX_UTC_OFFSET_AHEAD_MS` (UTC+14, the widest real offset) — a fixed cushion, so it
  stays deterministic and client/server still agree (both pass `Date.now()`). `isMinor` is
  deliberately left on plain-UTC semantics: the protections it drives persist past 18
  regardless (a birthday never widens anything already set), so its sub-day boundary skew
  removes no protection early and is immaterial.

## D42 — Photo EXIF stripping + opt-in geotag placement
**Decided.** **Strip all EXIF on upload by default**, with **two fields deliberately
preserved when the user opts in**: capture **timestamp** and **GPS lat/lng**. Tying a
photo to *when* during a session and *where on the lake* it was taken is genuinely
useful (which end of the lake had the pressure ridge). But location is sensitive, so
it's the user's call:
- **Per-user default + per-photo override:** a `placeOnMap` choice. If on, the photo
  is pinned at its coordinate within the water body on the map. If off, the photo is
  **attached to the report only** — no spatial pin — and we **don't retain the coord**.
- **Everything else in EXIF is stripped unconditionally** (device, lens, orientation
  beyond what's needed to render upright, thumbnails-with-metadata, etc.).
- Stripping happens **client-side during the D31 resize/compress pass** — one
  on-device step, before the bytes ever leave the phone.
**Why:** Privacy-by-default (00-vision) means we don't ship hidden geodata; but
opt-in geotagging unlocks real value (spatial photo placement, and a corroborating
signal for hazard location). Doing it during the existing D31 optimization pass costs
nothing extra.

## D43 — License: AGPL-3.0 + an App Store / Play distribution exception
**Decided.** Keep the repo under **AGPL-3.0** (it's the right copyleft for a hosted
service — it closes the SaaS loophole so nobody can run a closed fork of *this
service*; our server logic is the in-repo Convex functions). **But** (A)GPL's
anti-further-restriction terms conflict with the Apple App Store and Google Play
distribution terms (the documented VLC / GNU Go removals). Since **we are the sole
copyright holder**, we resolve it the standard way: **add a GPLv3 §7 "additional
permission"** (an *App Store exception*) that lets recipients who obtain the app
through Apple's App Store or Google Play comply with those stores' terms
notwithstanding the license's usage/DRM/device-limit restrictions.
- Full exception text lives in **`LICENSE-EXCEPTIONS.md`** (repo root), referenced
  from `README.md` and from each app's about screen.
- This is an *added permission*, not a relicense — the code stays AGPL-3.0; store
  users simply get extra latitude. Being the sole author makes this unambiguous.
- **Final wording is still legal-gated (Q10)** — the drafted exception is a solid,
  conventional template, but a lawyer confirms before any public/store launch.
**Why:** We want AGPL's copyleft *and* to ship on both stores. The §7 additional
permission is exactly the mechanism the GPL provides for this, and it's how projects
in this spot have historically resolved it (relicense-with-exception by the copyright
holder). Dual-licensing (proprietary store binary) was considered and rejected as
heavier for no added benefit at our scale.

## D44 — Every ice skate resolves to a water-body ID (findable by lake, not just by area)
**Decided.** A detected GPS activity (`gpsActivities`, D24) is **resolved to the
`waterBodyId` it took place on** at ingest time (spatial match of the trusted path
against `waterBodies` polygons — bbox prefilter → Turf.js, the D5/D36 machinery). We
store the resolved `waterBodyId` on the activity (and, when a skate genuinely spans
connected bodies, an optional `waterBodyIds[]` with the primary broken out).
**Why:** Users must be able to find *"skates on Lake Morey"* **by the lake's identity
(its ID/name), not by drawing a geospatial box**. "A 5-mile skate somewhere around
here" is useless; "5 miles on Lake Morey specifically" is the whole point. Resolving
once at ingest makes every downstream query (a lake's skate history, bounty
eligibility, hazard-path proximity) a cheap indexed lookup instead of a repeated
geometry scan.
**Consequences (see `06-data-model.md`):** `gpsActivities` gains `waterBodyId?` (+
optional `waterBodyIds?`); indexed by `waterBodyId`. Bounty eligibility (D-bounties)
and the per-lake feed query off it. If the path matches no known body, we fall back
to the D14/D36 create-or-attach flow (offer to create/attach a water body).

## D45 — In-app assumption-of-risk acknowledgment at signup (interim, pre-legal)
**Decided.** Because this is a *safety* app, signup includes a short, blocking
**assumption-of-risk + non-authoritative acknowledgment** ("reports are peers'
observations, never a safety guarantee; you alone decide whether to step on ice") and
links to the privacy notice (`PRIVACY.md`) + interim terms (`TERMS.md`), recorded with
a timestamp + version on the user record (`riskAckVersion`/`riskAckAt`, D-data-model).
This is the **interim** safety/legal guardrail for the friends alpha; the full
ToS/assumption-of-risk/disclaimer review remains **Q10** before any broad launch.
**Why:** Reinforces D3 at the one moment we have the user's full attention, and gives
us a recorded acknowledgment now without waiting on the full legal pass. Cheap,
honest, and directly on-mission.
**Implementation status (Phase 0, 2026-07-11):**
- **Done — server contract (the trust boundary, D37):** `RISK_ACK_VERSION` is single-
  sourced in `@skating/core`; `convex/profiles.upsertFromClerk` **requires a *current*
  acknowledgment** (rejects stale/missing) and records `riskAckVersion`/`riskAckAt` on the
  profile, preserving the original acceptance time on a same-version app-launch re-sync
  (only re-stamped when the user accepts a bumped version). So a profile **cannot exist
  without a recorded, current acceptance** — regardless of what any client does.
- **Done — mobile UI:** the sign-up screen shows the blocking acknowledgment + collects DOB.
- **⏳ Still to come (auth-provisioning PR):** the mobile client does **not yet call
  `upsertFromClerk`** — at signup it only *stages* DOB + the acknowledgment in Clerk
  `unsafeMetadata` (client-writable, read by nothing server-side). So today the age/risk
  gates are **UX-level on the client**, backed by a ready-and-safe server contract that
  isn't invoked yet. Wiring provisioning requires the username/displayName collection UI,
  so it's scoped with that work — the client must pass DOB + the acknowledgment **from the
  enforced mutation path**, never trusting `unsafeMetadata`. Tracked in roadmap Phase 0.

## D46 — Lint + format: Biome (repo-wide)
**Decided.** **Biome** is the single lint + format tool for the whole repo (one
`biome.json` at root; `preset: recommended` rules + formatter: 2-space, 100 cols,
single quotes, semicolons-as-needed). Run at the **root** (`pnpm lint` = `biome check
.`, `pnpm format` = `biome check --write .`), not as a per-package Turbo task — Biome
is fast enough repo-wide that per-package caching isn't worth the config. It respects
`.gitignore` (`vcs.useIgnoreFile`) and skips unknown file types.
**Why:** One fast Rust tool replaces ESLint + Prettier, near-zero config, matches the
low-ops posture (D35) and the TS-everywhere idiom (D7). Formatting and linting share
one pass, so "lint" also enforces formatting — no drift.
**Boundary:** app-specific ESLint configs (e.g. `eslint-config-expo` for RN-specific
rules) can be added **scoped to an app** later if a framework needs plugin rules Biome
doesn't cover; Biome stays the repo-wide baseline.

## D47 — Web navigation: Map + Newsfeed top-level; Report & Bounties folded in
**Decided (web surface).** The web app keeps **two top-level pages — Map (default) and
Newsfeed** (D28) — but does **not** give Report or Bounties their own top-level routes:
- **Create-a-report** is surfaced *in place* on **both** Map and Newsfeed (the two lenses
  a planner is already looking at), not on a separate `/report/new` page.
- **Bounties** are surfaced *in place* on **Map** only (they're inherently spatial —
  "someone wants a report on this water body"). *(Tentative — revisit if bounties want
  their own browse surface as the feature grows.)*
- **Profiles are their own pages** (`/u/:username`), including the current user's own —
  the one place that genuinely warrants a dedicated route.
- **Detail *child* routes are expected** — `/report/:id`, `/bounties/:id` (and
  `/water/:id`) for full detail views — but there are **no top-level `/report` or
  `/bounties` browse pages**: `/` (Map) and `/feed` are expected to cover the browse +
  create need, with these child routes reached from there. Built as the in-place content
  proves it needs a dedicated view; deferred until we know how complex each gets.
**Why:** The founder wants the web surface information-dense and powerful (FUI, 00-vision):
fold the *actions* (report) and *spatial asks* (bounties) into the pages the user is
already reading, and spend dedicated routes only where identity or depth demands them.
**Scope note:** this refines the **web** route list only. **Mobile's shipped 5-tab
structure** (Map · Newsfeed · ＋Report · Bounties · You) is **unchanged**; whether mobile
later adopts the same fold is left open, not decided here.

## D48 — Water-body removal: reversible soft-delist (curation + landowner takedown)
**Decided.** Admins can **remove a water body from the map** — but never a hard delete.
It's a **reversible soft-delist**, consistent with the never-destroy ethos everywhere
else (hazard archive D15, account anonymize D33, merge tombstone D36).
**Two motivations, one mechanism:**
- **Curation** — unskateable / inaccessible junk cluttering the map (the alpine tarn or
  backyard pond nobody can get to).
- **Landowner takedown** — "don't send people to my private pond." Partly
  good-citizenship, partly **trespass-risk mitigation**, which is on-mission for a safety
  app (D3).
**Mechanics:**
- Removal flips the derived geospatial filter key **`listed`** to `false`, dropping the
  body off the map immediately with **no new query machinery**.
- Record *why* on the document: `removedAt`, `removedByUserId`,
  `removalReason: enum(landowner_request | unskateable | junk | duplicate | other)`.
  **Restore** clears them.
- Every remove/restore writes a **`moderationActions`** audit row (reuse the existing
  `remove` / `restore` actions + `targetType: waterbody`, D37).
- **Re-ETL safety:** the idempotent `importCanonical` upsert (keyed on `source +
  externalId`) **must preserve a removed state** — a later re-import must NOT resurrect a
  removed body, above all a landowner takedown.
**The `listed` key (also resolves a Phase-0 latent bug).** This introduces a boolean
`listed` geospatial filter key that replaces the old `reviewStatus`-only filter on
`waterBodies.listInViewport`. `listed` is **true** for canonical (`osm`/`nhd`) bodies and
for auto-visible/approved user bodies; **false** for `rejected`, `merged`, or `removed`.
The old `reviewStatus === 'approved'` filter (Phase 0 scaffold) would have (a) **hidden
every canonical body** — they carry no `reviewStatus` — which is the exact opposite of
Phase 1's goal, and (b) contradicted D37's "**user bodies are auto-visible,
review-after**" by hiding freshly-created `pending` bodies. `listed` fixes both.
**Scope.** A **minimal admin `remove`/`restore` mutation lands in Phase 1** — data hygiene
for curating the fresh OSM import the moment we look at it, and cheap given `listed`
already exists. The **takedown *request* intake** (a form → a work queue an admin triages)
rides with the **Phase 4** operator surface (D37), not hand-rolled now.
**Deferred edges (logged, not built):** (a) a landowner's pond **re-created as a user body**
(D14) — teaching dedup to honor a suppression list is future hardening; (b) the exact
takedown **wording/obligation** is **legal-gated (Q10)** — we ship the mechanism now,
settle the policy later.
**Why:** A map that can't be curated fills with unskateable clutter, and a safety app that
can direct people onto private land needs a takedown lever. This is the display-side
complement to the storage decision: **store every lake** (discovery needs bodies to exist
before anyone reports on them — D14/D28), but **control what displays** (soft-delist +
zoom-based rendering), rather than under-populating the data.

## D49 — Zoom-scored display prominence (the zoom-based rendering D48 gestured at)
**Decided (mechanism); built in Phase 2, not Phase 1.** D48 said clutter is a *display*
problem solved by "zoom-based rendering." This decision names that mechanism: which bodies
*draw at a given zoom* is a derived **display score**, separate from whether a body is
allowed on the map at all.
**Decoupled from `listed` (D48).** `listed` is the binary "may this body appear on the map,
ever" gate — Lake Morey is always `listed: true`. The zoom at which it actually **draws** is
a distinct display-tier concept layered on top. Do **not** overload `listed` with prominence.
**Score shape (when built):**
```
score = w_area · normalize(log(area))   // log — pond→Champlain spans orders of magnitude
      + w_pop  · normalize(popularity)   // reports + distinct skaters, trailing & decayed
      + curatedBoost                      // admin bump for known destinations
→ minVisibleZoom(score)                   // higher score ⇒ draws at a lower (wider) zoom
```
- **Popularity is a boost, not a gate.** A pure popularity gate is rich-get-richer (popular
  lakes draw more → get more reports → score higher), which buries obscure-but-good spots and
  fights the discovery mission (D14/D28). Area guarantees a discoverability *floor* at the
  appropriate zoom; popularity only promotes.
- **`curatedBoost` is the cold-start answer.** In Phase 1 there is zero popularity signal (no
  reports/skates/users), so "we know Lake Morey matters before we have data" is expressed as a
  manual admin boost — the same curation muscle as the D48 remove/restore surface.
**Phase 1 scope:** build **none** of the scoring. Phase 1 only populates `surfaceAreaSqM` (the
raw material) and uses a soft viewport cap with truncation logging (see D5). The stored
`displayScore` and threshold curve are optional Convex fields added in Phase 2 — free to defer
(optional fields need no migration). See `phase-1-water-bodies.md` and Phase 2 in the roadmap.
**Why:** area alone would let Champlain dominate and would drop a small-but-beloved lake like
Morey from the state view; a score that combines area with (later) popularity and an
admin-curated boost keeps the map legible at every zoom without under-populating the data.
