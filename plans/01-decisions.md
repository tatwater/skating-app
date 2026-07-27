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
**Decided.** Convex for reactive data (feeds, notifications, reports) and
file storage (photos).
**Why:** Real-time reactivity fits live reports/feeds; TS-native; batteries
included (files, geo). Not a geospatial DB for polygons — see D5.
**Amended 2026-07-26 (N1):** the geospatial *component* is no longer part of this — spatial queries
run on plain Convex tables + indexes. The batteries-included argument held for everything except
geo, where the component's read profile (∝ requested results, not returned ones) turned a wide
viewport into a crash. See D5.

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
Turf.js over our own index. No runtime PostGIS at our scale.
**Why:** Map SDKs don't provide queryable water-body *records*; we own the data
and the spatial queries.
**Amended 2026-07-26 (N1):** "spatial logic via the Convex geospatial component" became **our own
ladder-grid index** — one row per grid cell an object's bbox covers, in plain Convex tables
(`waterBodyCells` / `adminAreaCells`), with Turf.js still doing the precise refine. The component
indexed a single *point* per row and read roughly ∝ the results you asked for rather than the ones
it returned, so a wide sparse viewport blew Convex's 4,096-read cap — a crash that took two patches
before the mechanism itself was replaced. Owning the index means the read bound follows from
geometry. See [`phase-N1-read-path-durability.md`](./phase-N1-read-path-durability.md).

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
their (public) profile. **Reports are always public** (D13) — there is no per-report
privacy level; the profile-privacy switch controls personal discoverability, not reports.
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

## D13 — Reports are always public; profiles are public or private (no social graph)
**Decided (2026-07-15, revised twice — see "Evolution" below).**
- **No follow/friend graph.** No follow, no mutual "friends," no follower-approval. A report is a
  report regardless of who made it, so there is no social layer to build.
- **Reports are ALWAYS public.** There is no per-report privacy level — no `just_me`, no
  `friends`/`followers`. Every report contributes to the shared map/newsfeed everyone in range
  sees; that *is* the app. If you don't want to share an observation with the community, don't
  post it (keep a private log in Strava/notes instead — a solo private log here would just recreate
  the anti-commons dynamic we rejected with the follow graph, for negligible benefit).
  - Reads are gated only by **moderation** (`moderationStatus`, D32) and **blocks** (below) — not
    by any visibility level.
- **Profile visibility (`public` / `private`).** This is the *only* privacy switch, and it governs
  **personal discoverability**, not reports:
  - **Public profile:** searchable by name; a browsable page showing name, photo, **town/state**,
    **bio**, **#reports / #comments**, **reputation score/class** (D50), and the user's full public
    report history.
  - **Private profile:** **name + photo only** — no bio/stats/history, and **not searchable**.
  - **A private profile's reports are still public and name-attributed** (D3): "private profile"
    means *you're not a browsable/searchable personage*, not that your activity is hidden. It is
    deliberately **not** a spot-secrecy valve.
  - **Minors (<18) are forced private** (see D41).
- **Blocks still exist** (D32): a block hides two users' content/profiles from each other — pure
  "stop showing me this person," no follow state to unwind.
**Why:** The app is a planning/reporting **commons**, not a social network. Flattening to
"public-or-don't-post" keeps the shared map maximally populated and the model dead simple. The one
real benefit of a social layer — knowing *whose* reports to trust — is served by an asymmetric,
public **trust score** (D50), not by friending or private tiers.
**Evolution.**
- *v1 (superseded):* a follow primitive (mutual = "friends"), 4 report levels
  (*Just me / Friends / Followers / Public*), follower-approval — with a "followers" tier as a
  spot-secrecy valve. Removed 2026-07-15: the secrecy valve is a net negative for a safety commons.
- *interim (superseded same day):* dropped to 2 report levels (`just_me` / `public`). Then removed
  `just_me` too — a private-only report is a thin use case that still withholds from the commons;
  "public or don't post" is cleaner. Reports now carry **no visibility field**; the `follows` table,
  `requireFollowApproval`, and the report `visibility` enum are all gone (see `06-data-model.md`).

## D14 — User-created (unmapped) locations allowed
**Decided.** Users can drop a pin / draw a water body not present in OSM/NHD.
**Why:** OSM/NHD miss small ponds, flooded fields, specific put-ins.
**Follow-up (must address before too long):** deduplication of user-created
locations that overlap each other or official polygons. Kept simple for now.
### Amendment + build (2026-07-24, Phase 8) — path-only; "draw" is gone
**Shipped**, and narrower than written above: a user-created body comes **only from a recorded GPS
path**, never a drawn shape. `waterBodies.create` takes a `gpsActivities` **`activityId`** and derives
the polygon server-side (`core/pathToBody.ts`), so *no freehand drawing, ever* is a **server contract**
rather than a UI convention. **Why the narrowing:** no path ⇒ no proof the person was there and no
scale/shape/location frame of reference — a hand-drawn blob is a claim, a skated track is evidence.
The follow-up dedup question above is answered by **D36**, also built this phase (match-on-create
scoring feeds the Phase 7 merge queue, which until now had nothing flowing into it).

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
a lake you skated, hazard-confirmation request, report you made was rated helpful, …) is
individually mutable in user settings.
**Why:** Avoid notification fatigue as the community grows.

## D17 — Reward points are cosmetic/reputational only (v1)
**Decided.** Points/badges are status only — no unlocks, no economy. Bonuses for
photo evidence + "helpful" thumbs from requesters. Never rewards going onto ice.
**Why:** Avoids building a real economy and avoids unsafe incentives.
**See D50** for the **trust score** — the reputation signal (corroboration + helpful marks)
that also stands in for the removed social graph (D13). It is subject to the same rule as
points: reputational/cosmetic only, never a safety weight.

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

### Amendment (2026-07-24, Phase 8) — the flow inverted: we record, then push
The **core claim above survives unchanged** (trusted extent = a real GPS track; no hand-drawn areas;
provider-agnostic storage), but the *plumbing* is now the opposite direction, because the **L7 read
of Strava's post-Nov-2024 terms** killed the pull model:
- **The "cross-user map display is ToS-gated / we'll display a Strava path publicly if the terms
  allow" bullet is RESOLVED — they don't allow it.** Strava data provided by a user may only be shown
  *to that user*, publicly-viewable or not, plus a blanket AI/ML ban. So **Strava *pull* is shelved
  indefinitely**: it can never legally feed the lake map, a heatmap, or a path on a public report.
- **The first A-input is our own `native` recorder**, not a provider. A track we record is
  first-party Developer Application Data, so aggregating it, drawing it on public reports, and later
  heatmapping it are all legal with **none** of Strava's restrictions. The binding privacy constraint
  moved from Strava to **us** (→ **D58**, L14).
- **Strava's role flips to *push* only** (`activity:write` — the user's own skate to their own
  account). It's the adoption lever ("record once, keep your Strava stats"), not a data source.
- **The remaining five providers stay deferred adapters**, unchanged in intent: each is an incremental
  A-input into the same normalized `gpsActivities` shape (L8 per-provider ToS at integration time).
  **The "apply for Garmin/COROS/Polar partner programs now" instruction still stands** — approvals
  take weeks and would otherwise gate the fast-follow.
- **Fitbit remains a non-provider.** Unchanged.
See [`phase-8-native-capture.md`](./phase-8-native-capture.md) and L7 in
[`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md) for the full read.

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
**Decided.** As a public user-generated-content app, we build basic safety tools:
**block/mute** other users, **flag/report** a report, comment, photo, or user for abuse,
and a lightweight **takedown/hide** path for moderators (founder initially). A dangerously
false "the ice is great!" report is a *safety* issue, not just spam — flagging must be
prominent.
**Why:** Required for any public community; interacts directly with the safety-first
principle (D3). Data model adds `blocks` + `contentFlags` and moderation status
on user-generated content.
**Note (no social graph, D13):** with follows removed, a **block** is pure "hide this
person's content/profile from me and mine from them" — there is no friendship/follow state
to also tear down. Block/mute ship in **Phase 3** alongside comments + flagging.

## D33 — Account lifecycle: deletion, retention, export
**Decided.** Users can **delete their account** and **export their data**. On
deletion we **anonymize** their past reports/comments (author replaced with a
"deleted user" tombstone) rather than hard-deleting the content, preserving the
community's historical ice record. Since **all reports are public** (D13), there's no
private content to selectively remove — every report is anonymized-not-erased uniformly.
Full policy wording waits on legal (Q10), but the product behavior is decided now.
**Why:** Privacy/PII obligations (D11) and user trust; but community value lives in
the report history, so anonymize-don't-erase is the default.
**Export format:** a **JSON bundle** of the user's own data (profile, reports,
comments, hazards created, connections metadata — *not* secrets/tokens) plus
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
### Build note (2026-07-24, Phase 8) — the producer finally exists
Match-on-create shipped: `waterBodies.findMatchCandidates` (bbox + geospatial-nearest prefilter →
`core/dedup.ts` scoring over the *existing* `geometry.ts` primitives — no new geodesy) stamps
`dedupStatus` / `duplicateCandidateIds`, and creating new requires an explicit `confirmedNew`. This
is what the **Phase 7 merge queue** has been waiting for — it shipped in 7a with nothing flowing into
it. **One schema amendment:** `DEDUP_STATUSES` gained **`near_certain`**; the thresholds above always
described three tiers but the enum had two, so the top tier had nowhere to go. `listDedupCandidates`
surfaces both, near-certain first, and a flagged body stays **listed** (D3 — hiding it would pull
every report and hazard filed against it off the map on a machine's guess). The **re-ETL overlap scan**
and **auto-merge + community confirmations** remain deferred, as staged above.

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
**`member | moderator | admin`**. **Moderator = the full content + community-safety
toolkit:** flags, takedowns, water-body merges/rejections, `curatedBoost`, `bodyFeatures`
promote/demote, per-action posting restrictions (D57), **and ban/suspend/unban**. **Admin
⊇ moderator**, and the admin-only line is drawn at exactly three things: **role-granting,
support/PII (the support inbox), and the constants/tuning control-room** (editing the
magic-number levers). *(Refined 2026-07-23: the original split reserved bans and curation
for admin; in practice a moderator handling a hateful account needs to suspend it without
escalating, so those moved to moderator — while role-granting, PII, and the tuning
surface stay admin so volunteer/external moderators never get the keys to the app's
identity, private data, or safety constants.)* Role-granting is admin-only and audited.
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
**Scope.** Lands in **Phase 7** (the operator/moderation phase — the founder-facing back
office; see `07-roadmap.md`).

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
remain the primary user channel. Wire alongside the D37 admin surface in **Phase 7**.

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

## D41 — Minimum age 16; minors get private profiles and are read-only (interim)
**Decided (mechanics revised 2026-07-15 alongside the D13 "reports are always public" simplification).**
- **Minimum age is 16.** Under-16 accounts are not permitted. **We collect the user's
  date of birth at signup** and *derive* the age gate (≥16) and minor status (<18) from
  it (age math in `@skating/core`; stored as `profiles.dateOfBirth`). 16 lets the
  occasional independent teen skater participate without pulling us into full
  child-directed-service obligations; the realistic user base is overwhelmingly adults.
- **Minors (<18) cannot post public reports — and since all reports are public (D13), minors are
  effectively read-only** (they can read reports and plan; they can't create reports). Enforced at
  the trust boundary: `reports.create` rejects a minor author (server derives minor status from the
  stored DOB), and the client hides the create surface for minors. At 18 posting simply becomes
  available. **This is an interim guardrail (like the age gate + risk ack), not a settled policy —
  it is explicitly revisitable at the Q10 legal review (L2).**
- **Minors' profiles are forced private** (name + photo only, not searchable — D13). Adults default
  public and may switch to private; a former-minor's private profile is **never auto-widened** at 18.
- **Mental model:** "everyone's reports are public and help the community; under-18 users read and
  plan but don't broadcast their location until 18; whether your *profile* is searchable is a
  separate adult choice." **New features must honor existing settings** — never silently widen exposure.
**Why:** The *product* risk of a minor's past-tense report is low (no live GPS — D12; no follow/DM —
D13). But this is a **location** app that *knows* who is a minor, and publicly broadcasting a known
minor's whereabouts is exactly what child-safety regimes (UK AADC, state privacy laws — L2/Q10) scrutinize.
Read-only-until-18 costs almost nothing (tiny population; core value is *reading*) and removes that risk
category by construction. It's a **one-line flip** if the Q10 lawyer greenlights minor posting.
**Note (supersedes the old mechanics):** earlier iterations derived a *default report visibility* from a
persisted "locked profile" flag, then from age. With reports now always public (D13), there is **no report
visibility to derive** — the age check simply gates *whether a minor may post at all*. `requireFollowApproval`,
`deriveDefaultVisibility`, and `maxVisibilityForProfile` are all retired.
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
**The `listed` key (also resolves a Phase-0 latent bug).** This introduces a derived boolean
`listed`, replacing the old `reviewStatus`-only filter on `waterBodies.listInViewport`. It was a
geospatial filter key originally; **since N1 it governs whether the body is spatially indexed at
all**, so an unlisted body is unreachable from the map rather than fetched and dropped. `listed` is
**true** for canonical (`osm`/`nhd`) bodies and for auto-visible/approved user bodies; **false** for
`rejected`, `merged`, or `removed`.
The old `reviewStatus === 'approved'` filter (Phase 0 scaffold) would have (a) **hidden
every canonical body** — they carry no `reviewStatus` — which is the exact opposite of
Phase 1's goal, and (b) contradicted D37's "**user bodies are auto-visible,
review-after**" by hiding freshly-created `pending` bodies. `listed` fixes both.
**Scope.** A **minimal admin `remove`/`restore` mutation lands in Phase 1** — data hygiene
for curating the fresh OSM import the moment we look at it, and cheap given `listed`
already exists. The **takedown *request* intake** (a form → a work queue an admin triages)
rides with the **Phase 7** operator surface (D37), not hand-rolled now.
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

## D50 — Trust score (reputation signal; the asymmetric stand-in for the removed social graph)
**Decided (2026-07-15); built in Phase 6 with bounties.** When the follow/friend graph was
removed (D13), the one benefit worth keeping was **trust** — in a safety-critical, perishable-
information domain, a reporter's track record is real signal. We capture that as a public,
**asymmetric reputation ("trust") score** rather than a symmetric social graph: nobody follows
anybody; the score is earned from the community's reaction to your reports.
**Two positive signals raise a reporter's trust score:**
- **(a) Corroboration within a similar timeframe.** An *independent* report on the **same water
  body within a tunable time window** that **agrees** with yours (similar `skateQuality` /
  `iceTypes` / hazards) raises the trust of both reporters. **Timeframe is essential:** ice changes
  fast, so a *later* report describing *different* conditions is **not** counter-evidence — it just
  means conditions moved on. Corroboration is therefore **boost-only**: divergence never lowers a
  score, so **nobody is punished for conditions changing** (protects the D3 "don't do it" and
  honest-negative reports too).
- **(b) Helpful marks.** Users mark a report **useful/helpful** (`reportRatings`, extending D17's
  requester-thumbs to *any* viewer). Helpful thumbs add to the reporter's score.
**Hard constraints (inherit D17 + D3):**
- **Reputational/cosmetic only.** The trust score is status (points/badges) — it **never** weights
  a report's safety, **never** gates visibility or ranking of *safety* content, and **never** makes
  the app assert ice is safe (D3). A high-trust "ice is great" is still just one peer's observation.
- **Boost-only, no punishment.** No downvote-to-zero dynamics; `unhelpful` marks and non-
  corroboration inform moderation/quality signals, not a public penalty score.
- **Cold-start safe.** With no reports yet, everyone starts flat; the score accrues as the community
  reacts, exactly like the D49 popularity term.
**Why:** This recovers the *"whose judgment do I trust"* value of a social layer without its walled-
garden downsides (D13) — it's public, earned, and one-directional. It also composes cleanly with the
existing model: `reportRatings` (D17) already exists, and corroboration is derivable from `reports`
on the same body within a window (no new social edges). See **Phase 6** (`07-roadmap.md`) and the
`reportRatings` / `pointEvents` notes in `06-data-model.md`.

## D51 — Hazard authoring: geometry-per-type, dual paths, both platforms
**Decided (2026-07-18; built in Phase 9).** The hazard-drawing UX is designed around the fact that
most people **cannot** hand-draw an accurately shaped/sized blob on a phone map from what they see on
the ice. So we never make freeform polygons the default — we **match the drawing primitive to each
hazard's real-world shape**, which happens to also be what a human can produce accurately:
- **Point + adjustable radius** (tap once, drag a circle) — the default for *blob* hazards:
  `open_water`/`lead`, `thin_ice`, `overflow_slush`, `drilled_hole`, `shell_area`,
  `inlet_outlet_current`/`spring`. One tap + one drag; no shape skill.
- **Polyline** (tap a few points along it) — for *linear* hazards: `pressure_ridge`, `wet_crack`, and
  linear leads. Ridges/cracks *are* linear, so the easy input is also the correct shape.
- **Freeform polygon** — an **opt-in, de-emphasized "advanced"** affordance, not offered by default.
  Self-selects to the confident without gating anyone out of the easy primitives.
**Build staging (2026-07-21, founder call at Phase 9 kickoff).** All three `geometryKind` values ship in
the schema and all three **render** in v1, but *authoring* lands in two steps inside the same PR:
1. **Point + radius** first, so the whole pipeline (create → decay → confirm → alert → offline queue) is
   provably green end-to-end against the simplest primitive.
2. **Polyline** immediately after, as its own commit. It is *not* cut: `pressure_ridge` is the
   **second-most-reported hazard type** in the corpus (116 occurrences) and is genuinely linear, so
   representing it as a blob would undercut this decision's entire thesis. Tap-to-add-vertex + undo +
   Done + a `bufferMeters` stepper — no vertex dragging, which is what makes it cheap.
3. **Freeform polygon authoring is deferred** past Phase 9 (schema + render only). It is the expensive
   one precisely because it needs vertex dragging and self-intersection handling, and it is the
   primitive this decision already calls opt-in/advanced.
**Photos are plural (2026-07-21).** Hazards carry `photoIds: ref(photos)[]`, not a single `photoId` —
the research found photos load-bearing (~40% of corpus posts carry them; "folded ridges are hard to see"
is a recurring cause of death), and a ridge or a lead often needs two angles to read. This reuses the
existing multi-photo report pipeline (upload → EXIF strip → partial-failure resume) rather than building
a parallel single-photo path.
**Honest rendering (D3).** Hazards always render with a soft buffer/halo + advisory copy ("open water
reported *around here*"), never a crisp surveyed boundary — imprecision becomes the honest message, not
a bug. A `confidence` notion (below, D54) drives how strongly it draws.
**Two authoring paths, both platforms:** (a) **standalone** — a fast "flag a hazard" flow with no full
report, and (b) **in-report** — drawn as part of a report submission (`reports.hazardIdsCreated[]`).
Both **web and mobile** can author (some skaters report from home off photos/memory), though mobile is
GPS-anchored and optimized for on-ice capture.
**Who:** minors treated the same as everywhere for now — folded into the eventual uniform 16+ pass with
legal (D41); a `TODO(16+)` marker on the create gate is the single place that pass will touch.
**Deferred, designed-for (post-density / Phase 8+):** non-destructive **consensus rendering** (cluster
same-type hazards in the same place into one footprint while keeping the underlying rows so each ages
and confirms independently — never average-and-overwrite, which would break lifecycle and let a wrong
report drag a correct one off-target), and **GPS negative-evidence** (Q11): recent tracks crossing
*through* a reported hazard nudge its *confidence/lifecycle* down (human still confirms removal) — it
must **never** auto-move, shrink, or clear a safety hazard, because a false "all clear" is the worst
outcome (D3).
**Why:** For a safety feature you want to *keep* low-confidence reports (a roughly-placed open-water
warning beats none), so the goal is making imprecise input safe and useful, not filtering to only
precise inputters. Primitive-per-type dissolves most of the accuracy risk by construction.

## D52 — Per-type hazard decay + three-tier "healing" confirmation
**Decided (2026-07-18; built in Phase 9).** Extends **D15** (which set one global 24/72h decay as a
tweakable default). Different hazards stop being trustworthy at very different rates, governed by
whether the hazard **heals** (refreezes/fills) or is **structural** (persists, often grows). Decay is
therefore **per hazard type**, grouped into tiers (all **tunable defaults**, admin-editable in Phase 7
per D49):
**Constants are stored in HOURS** (admin-tunable integers, Phase 7), converted to ms only at the
comparison boundary (`hoursToMs` helper) — so tuning is human-legible and the math stays trivial. Full
calibrated table + evidence in [`phase-9-hazard-research.md`](../plans/phase-9-hazard-research.md).
- **Tier A — Volatile** (`open_water`/`lead`, `thin_ice`, `overflow_slush`, and the new volatile holes
  `drain_hole` / `wind_hole` / `slush_hole`): **fresh <24h / aging 24–72h / stale >72h** (the D15
  default). A cold snap can flip these in a day; refreeze is often overnight.
  - **Very-volatile sub-case (fresh <12h / aging <36h):** `thawed_rotten` and the `ridge_crossing`
    passage marker — same-day information only.
- **Tier B — Semi-persistent** (`wet_crack`, `drilled_hole`, `shell_area`): **<3d / 3–7d / >7d**.
  Re-skins/consolidates but the weak spot lingers.
- **Tier C — Structural** (`pressure_ridge`, `ice_heave`/`buckling`): **<7d / 7–21d / >21d**. Don't
  heal within a season; often grow. **A ridge rarely reaches "fully healed & safe"** — it heals to
  *ice sharks* (a line of refrozen blocks = trip/sail hazard), which is a `healing_unsafe` outcome,
  not removal.
- **Tier D — Effectively permanent** (`inlet_outlet_current`/`spring`, and the new persistent natural
  holes `gas_hole` / `reef_hole`): **<14d / 14–45d / >45d** — and strong candidates to graduate into
  **known seasonal body attributes** (D53) so they don't need re-marking at all.

**Decay = confidence, not safety (invariant, D3).** Decay fades a pin toward "*unverified — may have
changed*," **never** toward "clear/safe." A refrozen lead *is* thin ice; a thawed sheet with a cold
overnight skin *is* still rotten. `hazardDecay.ts` and the copy helpers enforce this in one place —
a stale `open_water` pin reads "*was open, may now be thinly skinned*," and a stale pin still renders
(faded, behind the "show older" toggle), it does not disappear.
**Three-tier confirmation (replaces the binary still-there/gone in D15).** When a skater views a hazard
along their route, "gone" is split so a healing-but-still-dangerous spot doesn't get cleared:
- **"Still here"** → resets `lastConfirmedAt` to fresh (a confirmation).
- **"Healing but unsafe"** → the hazard **stays on the map** (it helps future skaters read the healing
  ice) but is annotated as healing; does **not** count toward removal. A refrozen lead *is* thin ice —
  "healed" never means "safe."
- **"Fully healed & safe"** → the only verdict that accelerates decay / counts toward removal. At the
  removal threshold (**2 independent, tunable, no reputation yet — D54**) the hazard `archive`s (not
  deleted — can resurface on re-report, D15).
**Copy rule (D3):** a decaying/aging open-water hazard must never read as "all clear" — the honest
interpretation is "was open, may now be thinly skinned."
**Weather-driven dynamic decay (built in Phase 10, PR #23, 2026-07-23; corrected 2026-07-21 by the
hazard-research pass).** Phase 10's Open-Meteo "weather-since" data feeds a per-type decay multiplier:
`effectiveAge = elapsed × decayMultiplier(type, weatherSince)`, quantified against lakeice's growth
model (~1" ice per **15 freezing-degree-days**, Ashton 1989) and the fact that **thawing runs ~30%
faster than growth**. Refreeze-healed types (open_water/thin_ice/drilled_hole/overflow/drain_hole/
wind_hole) **accelerate** toward stale with freezing-degree-hours and **decelerate** under warm/sun/rain
(a thaw can even re-escalate a fading thin-ice hazard). **Three counter-intuitive sign-flips the naïve
"colder → safer" multiplier gets dangerously wrong (all found in the research pass):**
1. **Thawed/rotten ice must NOT heal on cold.** A thawed sheet grows a deceptive hard skin overnight and
   collapses when it warms midday (the "overnight-ice trap" — implicated in the 2013 fatalities). So
   `thawed_rotten`'s cold-weather multiplier is **≥1 (never <1)**; only sustained hard freeze *of the
   whole column* clears it, which the model can't assert — a human must.
2. **Ridges escalate in thaws, they don't just persist.** Contrary to the old "structural =
   weather-insensitive (×1)" line, a pressure ridge can **melt into open water in a 2-day windy warm
   spell** (lakeice). So `pressure_ridge`/`ice_heave` get a **thaw multiplier ≥1** (warmth makes them
   *worse*, not stale-in-place). Springs/current/gas_hole remain ≈×1 (genuinely weather-insensitive).
3. **Snow lowers confidence, never heals.** Snow insulates (slows refreeze), hides folded ridges/gas
   holes, and enables under-ice erosion. Snowfall-since-report **reduces** confidence and flags
   "possibly snow-hidden now"; it must never accelerate healing.
Also feeds Phase 10: a **season/solar term** (late-season sun weakens ice even when cold — ~600 W/m²
early March vs ~70 late November) and a body-level **shallow/pond** signal (shallow water melts from the
bottom first). Same D3 caveat throughout — accelerated decay ≠ "safe."
**Why:** A single global rate faded persistent ridges too fast and kept volatile open water too long;
per-type decay + a healing tier matches how the ice actually behaves. The 2026-07-21 research pass
(corpus + lakeice.info) confirmed the tier shape, expanded the type taxonomy (holes, thawed/rotten,
ridge-crossing passage marker), and corrected the weather signs above.

## D53 — Known seasonal body attributes (persistent, not user-re-marked)
**Decided (2026-07-18; schema in Phase 9, admin surface in Phase 7).** Some "hazards" are really
**permanent features of a water body**, present every season regardless of cold, and it's wrong to make
users re-mark them or let them decay: **springs / inlet-outlet current, constrictions and bridges/
narrows between larger areas** (moving water under a constriction is *always* weaker), and **pressure
ridges that reform in the same place annually**. The 2026-07-21 hazard research adds three more
persistent natural sources from lakeice.info: **`gas_hole`** (marsh-gas deltas/river mouths — deroof
every season), **`reef_hole`** (thin ice over the same shallow/reef yearly), and **`delta` /
`shallow_bay_early_thaw`** zones (shallow water melts from the bottom first, goes out well before deep
ice). These graduate into a first-class **`bodyFeatures`**
entity attached to the water body — always-shown with distinct "known seasonal hazard" styling, no
time-decay, no confirmation loop. **Promotion** (a recurring hazard → a body feature) and **demotion**
are **admin actions** (Phase 7 surface, D37/D49). v1 ships the schema + rendering; population is
admin/seed-driven.
**Why:** Re-marking a spring every visit is busywork and a false-negative risk (an un-re-marked spring
looks "gone"); modeling permanent risk as a durable body attribute is both truer and safer (D3).

## D54 — On-ice hazard alerting: client-side proximity evaluation
**Decided (2026-07-18; Layers 0–1 in Phase 9, Layer 2 deferred).** New hazards must reach skaters
**already on that ice** without holding everyone's live location server-side (D12: no live GPS). The
architecture inverts the naïve "server pushes to nearby phones": **the server only syncs hazard *data*
to devices that care about that lake; each phone decides for itself** whether its own on-device GPS
warrants an alert. This is D12-clean (positions never leave the device), needs no server fan-out, keeps
the griefing blast radius naturally local, and — because hazards are already cached on-device — **works
with no cell signal** (the alert is computed and fired locally). Layers:
- **Layer 0 — silent data sync (Phase 9 v1).** A device with a lake cached / subscribed gets new
  hazards automatically (Convex reactivity while open; on next foreground otherwise). No notification.
  True background sync to a *closed* app (silent push) is a nice-to-have deferred to the offline commits.
- **Layer 1 — on-ice proximity alert + confirm-gate (Phase 9 v1).** A co-located skater's client
  evaluates its own recent GPS against each cached hazard's buffer. The **gate and the confirmation
  mechanism are one and the same**: an **unconfirmed** hazard (confirmCount = 0) surfaces as the *soft*
  prompt "Reported hazard nearby — can you confirm?" (which *collects* the confirmation the lifecycle
  needs); once it crosses the **confirm threshold (1 independent, tunable, reporter's own excluded)** it
  **promotes** to the full "⚠ hazard ahead" alert for subsequent co-located skaters. So a troll's fake
  pin reaches only people physically on that same ice, and only as a soft "can you confirm?" — never a
  mass push. Layer 1 alerts are **client-local**, not server `notifications` rows (no new
  `notifications.type` needed in v1; existing `hazard_confirmation` covers the confirm-ask surface).
- **Layer 2 — directional "hazard ahead," 30–60s out, once per approach (deferred; opt-in "on-ice live
  mode" — a conscious, safety-justified exception to D12).** Needs continuous live position + heading
  during an active skate. All client-side (project path forward from heading+speed, test intersection
  with cached hazard buffers, fire at time-to-encounter ∈ [30s,60s]; per-session lap-dedup so laps don't
  re-alert), so it stays private and offline-capable. **Server-push-to-a-sleeping-phone** (reaching a
  skater whose app is fully closed) lives here too — the only variant that needs live location uploaded,
  hence the latest/biggest privacy call. Decide mechanics at build.
**Admin-tunable (Phase 7).** Confirm threshold (1 now) and removal threshold (2 "fully healed" now) are
count/score constants with **no reputation yet**; both must be easily adjustable in `/admin` (D49-style
tuning surface), and reputation-weighting integrates later (D50).
**Why:** Honors D12 and privacy, removes the scary server fan-out, and the on-device cache turns the
"they'll have no signal" problem into a non-issue for already-cached hazards.

### Amendment (2026-07-21, Phase 9 kickoff) — Layer 1 ships **foreground-only**; the watcher moves to Layer 2

**The gap found at kickoff.** Layer 1 as written above assumes a phone that can evaluate its own GPS
while you skate. The mobile app cannot do that today, and the distance is larger than the plan implied:
- **`expo-notifications` is not installed anywhere in the repo.** There are *zero* local or push
  notifications on device — Phase 4's notification work is server-side coalescing into in-app
  `notifications` rows only (`packages/convex/convex/notifications.ts` says push delivery is deferred).
- **`expo-location` is configured when-in-use only** (`apps/mobile/app.config.ts`) — no background
  modes, no `UIBackgroundModes`, no `locationAlwaysAndWhenInUse`, no `expo-task-manager`.
- **There is no GPS *watcher* anywhere** — all four call sites are one-shot `getCurrentPositionAsync`.
- The app uses **CNG/prebuild** (no committed `ios/`/`android/`), so adding any native module requires
  cutting a fresh dev-client build.

**Decided.** Phase 9 v1 ships **Layer 1 foreground-only, with no new native dependencies**: while the map
is foregrounded and GPS resolves to a body, a `watchPositionAsync` watcher feeds the pure
`hazardProximity.evaluateOnIceAlert`, and hits surface as **in-app top banners** — not OS notifications.
This needs no notification permission, no background permission, and no new dev-client build, and it
makes the whole alerting path unit-testable today.

**Consequence, stated honestly:** a foreground-only banner fires when you pull the phone out of your
pocket, not while you are skating. That is a real limitation, not a hidden one — which is exactly why
Layer 2 is a near-term commitment rather than an open-ended "someday" (founder call: *"I'm okay
deferring so long as Layer 2 comes soon."*).

**Layer 2 spec — captured now so nothing is re-derived.** An opt-in **"on-ice mode"** the skater arms
when they start (not an always-on background permission), which adds, in one bundle:
- `expo-notifications` + a local-notification path (no server push, no token registration — the alert is
  computed and fired entirely on-device, so D12 still holds).
- Background/foreground-service location for the duration of the session only, plus keep-awake, with an
  obvious persistent "on-ice mode is on" affordance and a one-tap off.
- **Directional projection** — path forward from heading + speed, intersect cached hazard buffers, fire
  at time-to-encounter ∈ [30s, 60s], per-session lap-dedup (the original Layer 2 content above).
- **Server-push-to-a-sleeping-phone** stays separate and later — it is the only variant needing live
  location *uploaded*, and remains the biggest privacy call in the product.
Everything Layer 2 needs from the client is already built by v1: the pure proximity evaluator, the
per-session `alerted` set, the cached hazards, and the `skating://hazard/<id>?action=confirm` deep link
(added in v1 specifically so the notification tap has somewhere to land).

**Invariant that ships with the feature — silence is not an all-clear.** A proximity system that has
only ever been quiet is the most dangerous signal we could emit, and it gets *more* dangerous with
foreground-only coverage. So the copy layer states it outright wherever alerting is surfaced or
configured: **no alert does not mean the ice is clear** (D3). This is not optional polish; it is the
reason foreground-only is acceptable to ship at all.

## D55 — On-ice hazards auto-bundle into the skater's later report
**Decided (2026-07-21, founder call at Phase 9 kickoff).** A hazard flagged from the ice is a standalone
row (`originReportId: undefined`). When that same skater later writes a report for that same body, the
report form **offers to bundle their own unattached hazards into it** — pre-checked, itemized, one tap to
drop any:
> *You flagged 3 hazards on Shelburne Pond today. Include them in this report?* ☑ Open water ☑ Pressure
> ridge ☑ Thin ice

On submit, the accepted hazards get `originReportId` patched and land in `reports.hazardIdsCreated[]`.
**Candidate window:** the author's own hazards, on that body, not already attached, created inside the
report's skate window (`skateStartTime`→`skateEndTime`) or — when no start time was given — within ~24h
before `skateEndTime`. Tunable alongside the other Phase 7 constants.
**Rules.** Always **visible and dismissible**, never silent: attaching changes how the hazard is
attributed and how it presents in the feed, so it is a shown choice, not a background merge. Gated on
ownership + same body + not-already-attached, and idempotent. Must not double-count toward D50 points
once reputation lands. Works offline — the draft holds local hazard ids and resolves them at flush.
**Why:** On the ice you want the fastest possible capture (two taps, no typing, no report); at home you
want a coherent story. Bundling gets both without asking the skater to re-enter anything, and it turns
the standalone quick-flag path (D51) from a parallel silo into the front half of the report flow.
**Not this:** auto-attaching *other people's* hazards, or attaching silently — both would misattribute
observations, and mis-sourced safety content is a D3 problem.

## D56 — Weather-driven dynamic hazard decay + the expanded weather-since variable set
**Decided (2026-07-22; built in Phase 10).** Extends **D52**. Phase 10's Open-Meteo "weather-since" pull
(D19) modulates hazard freshness instead of relying on elapsed time alone:
`effectiveAge = elapsed × decayMultiplier(type, weatherSince)`, then `deriveHazardFreshness` runs on
`effectiveAge`. Pure logic in `@skating/core`, property-tested (D40), admin-tunable in Phase 7 (D49) like
the D52 tiers.

**Variable set (supersedes the original strip's five vars).** The descriptive strip (peak temp · hours
near/above freezing · sun · precip · wind) misses what the model needs. Added:
- **Derived integrals (model-internal):** `freezingDegreeHours` / `thawDegreeHours` (magnitude, not
  hour-counts — the ~1″/15-FDD backbone; thaw ~30% faster), `longestFreezeRunHours` (a *sustained*
  freeze, the `thawed_rotten` gate), `freezeThawCycles`.
- **Raw variables:** overnight low (`minTempC`), **rain vs snow split** (opposite signs), **shortwave
  radiation** (insolation — subsumes the season/solar-term multiplier), clear-night cloud cover
  (radiational cooling), wind gusts / wind-run. Out of scope: dew point / freezing-rain glaze.

**The three sign-flips (locked in D52 §5), plus two Phase-10 invariants:**
1. `thawed_rotten` cold multiplier **≥1** (a cold skin over rotten ice is not healing — the "overnight-ice
   trap"); 2. `pressure_ridge`/`ice_heave` thaw multiplier **≥1** (ridges escalate in thaws, springs/
   gas/reef holes ≈×1); 3. snow **lowers confidence, never accelerates decay**.
- **Never-hide invariant (answer to the founder's Q2, reinforces D3):** weather can **age** a hazard
  (fresh→aging) but the cold-acceleration direction is **bounded so weather alone can never push a hazard
  past `aging` into hidden/`stale`** — only elapsed time + a human `fully_healed` confirmation fully
  retires a pin. A refrozen lead is still thin ice.
- **Fail-open:** missing/failed weather ⇒ `multiplier = 1` (plain `elapsed`); weather trouble can never
  make a hazard less visible.

**Sampling.** Body **centroid by default** (nearly every body < one Open-Meteo grid cell; town/county is
the wrong abstraction and buys no sub-grid signal), with an optional `weatherSamplePoints[]` escape hatch
for the few genuinely multi-cell bodies (Champlain/Winnipesaukee); a hazard/report picks its nearest
sample point. **Cron:** only the decay precompute needs one — it sweeps **bodies with ≥1 active hazard**
(not the full corpus) at a fixed hourly tick, skipping hazards refreshed within an admin-tunable
`weatherRefreshMinIntervalHours` (Convex crons can't retune their interval at runtime, so the config gates
work inside a fixed tick), and stores the **time-independent `decayMultiplier`** (not a frozen freshness
bucket, which would drift between ticks — online `toView()` recomputes the live bucket). The strip itself
**fetches on drawer-open** via the action (a query can't fetch, so a read-only strip would never fill on
the hazard-free bodies the cron skips), sharing the same `weatherCache`. This precompute
is what makes weather-adjusted freshness available to the **offline on-ice alert** (D54) — a phone on the
ice can't fetch Open-Meteo, so the server bakes the adjusted freshness into the synced hazard payload.

**Also in Phase 10 scope (all waiting on the fetch):** report **conditions auto-fill** (the stubbed
`openmeteo` source — weather *at* the skate time; user entries win); the Phase-6 **corroboration
contradiction *signal*** (weather-since lets a disagreeing later report count as a contradiction *only when
the weather doesn't explain the change* — and even then it **never subtracts trust**: it withholds the
boost, discloses a "conflicting reports" indicator, and escalates *on pattern* to the D57 posting-permission
lever, so honest "the ice changed" reports stay unpenalized — D50/D3/D57); and the Phase-6 **decay-based
bounty-freshness score** (recency × thumbs × trust × weather-since replaces the hard `FRESH_REPORT_HOURS`
cutoff). Both fetch-dependent report-create tasks run as a **scheduled post-insert action** (a mutation
can't fetch — the `isochrones.ts` pattern), so they're eventually-consistent.

**Why:** A single global clock faded persistent ridges too fast and kept volatile open water too long;
weather-modulated decay matches how the ice actually behaves — while the never-hide bound + fail-open keep
it firmly on the safe side of D3 (accelerated decay ≠ "safe").

## D57 — Granular posting permissions (a moderation lever finer than suspend/ban)
**Decided (2026-07-22; fields + enforcement in Phase 10, admin surface in Phase 7).** Adds per-action
posting rights on `profiles` — **`canPostReports`** and **`canPostHazards`** — **default ON for every
adult** (minors are already read-only, D41), revocable **individually** as a moderation action. A user who
abuses one surface loses *that* surface, not the whole app: proportionate, **appealable, and reversible**
without the collateral of a full `status: banned` (D37). Optional booleans ⇒ **migration-free** (absent =
full adult posting rights).

- **Enforcement (Phase 10):** `reports.create` / `hazards.create` gate on the respective permission
  server-side, the same way every function already gates on `status` (D37). The revocation/restore mutation
  writes a `moderationActions` audit row.
- **What feeds it (Phase 10; D56/D50):** the corroboration **contradiction signal** — repeated
  weather-unexplained, *never-corroborated* contradictions auto-file a `/admin` flag; a **human, not the
  system**, decides whether to restrict a right. Trust stays **boost-only** (D50); this lever — not point
  subtraction — is how deliberate false-reporting is actually deterred (a boost-only score can't bite a bad
  actor, and a point penalty is too harsh for an honest "the ice changed" report).
- **Admin tooling (Phase 7):** restrict/restore each right; an **appeals / reinstatement** workflow; and a
  **contributor-trust panel** showing the private, non-scoring **contradiction counter** *alongside* a
  **good-vs-bad reports trend over time** — deliberately **tenure-aware**, so a 10-year contributor and a
  1-month account with the *same* raw contradiction count are clearly distinguishable at a glance (a raw
  count alone hides who's actually trustworthy).

**Why:** whole-app suspend/ban (D37) is too blunt for "posted a bad hazard" — un-appealable in practice
and it drives good-faith users off. A per-action, reversible right matches the offense to the consequence
and keeps the door open for reinstatement, while still giving moderators a real deterrent. Pairs with D56's
contradiction signal and D50's boost-only trust.

**Extending the lever (2026-07-23; first extension shipped 2026-07-24).** The per-capability pattern
generalizes, but the *shape* of each lever must match the abuse it answers — never blanket symmetry:
- **`canPostComments` — ✅ BUILT in Phase 7** *(status corrected 2026-07-24; the "planned" wording below
  described it before it landed. It's on `profiles`, flipped by `moderation.setPostingPermission`, and
  enforced by `assertCanPostComments` in `comments.create`.)* Comments are free-text user content
  (D21) — the classic harassment/spam surface — so a **boolean** revocation fits, exactly like reports and
  hazards. Its distinct payoff: mute a toxic commenter *while preserving their safety contributions* (a bad
  commenter can still be a useful ice reporter), which neither `block` (interpersonal mute, D32) nor a
  whole-app `status` (D37) can express. Enforcement point would be `comments.create` (an `assertCanPostComments`
  mirroring the existing gates); minors are already read-only there. Optional boolean ⇒ migration-free.
- **Bounties: no `canPostBounties` boolean — prefer a nullable `activeBountyPostLimit`, and defer it.** Bounty
  abuse is *volumetric*, not content: a bounty carries no free-text payload, is hard-capped at
  `MAX_OPEN_BOUNTIES_PER_DAY = 3`, expires, and rewards the *fulfilling report author* (no self-dealing
  incentive to spam). The fitting lever is therefore a per-user override of that rolling cap
  (`activeBountyPostLimit ?? 3`; `0` ⇒ effectively can't post), which **subsumes** a boolean and allows a
  graduated response. Since the existing cap already does ~all of the work, this is a **noted seam, deferred**
  until a real spammer earns it — not built speculatively.
- **Shape guardrail:** keep the per-capability-boolean form (plus that one bounty int); do **not** graduate to a
  `postingRestrictions` object/framework for 3–4 fields — that would break the clean `assertCanPost*` pattern
  and is the actual over-engineering risk here.

## D58 — Aggregate-track privacy: publish-is-consent, not k-anonymity (Phase 8)
**Decided (2026-07-24).** With the L7 pivot, cross-user track display is sourced from **our own
native-recorded tracks** (not Strava data), so *our* privacy design — not an upstream ToS — is what
protects skaters (promotes **L14**; see `phase-8-native-capture.md`). The model:
- **Publish-is-consent, no k-anonymity.** A public report is *meant* to be shared, so a single
  skater's public path may render — there is **no contributor-count threshold** gating a cell.
  (Rejected the k-anon design: it would leave the alpha's map empty, and the paths are already public
  on their reports.) The aggregate is built **only** from tracks linked to a **visible, non-minor
  report** — publishing the report *is* the consent. No separate `sharedToAggregate` flag.
- **Minors excluded by construction.** Minors are read-only (D41) and can't post reports, so their
  tracks never link to a public report and never aggregate. (A minor *may* still use the recorder for
  personal use + their own Strava push — their own data, no public surface.)
- **Put-in-gated endpoint clipping.** The report's existing `showPutIn?` opt-out doubles as the
  clipping consent: **put-in shared (`showPutIn !== false`) ⇒ full path** (the put-in is a declared
  public-access point we *want* to surface); **put-in withheld ⇒ clip the first/last ~150 m** before
  the track enters any aggregate, so a skate-from-the-backyard start/stop can't reveal a residence.
  The report's *own* detail view still shows the skater's full path (their choice).
- **Global opt-out** — a per-user `profiles.excludeTracksFromAggregate?` (person-level, so a later
  opt-out retroactively drops all their tracks). Recording / Strava push are unaffected.
- **Paths decay with their report** — opacity fades via D59 (never fully vanishes: a D3 min-opacity
  floor, so a stale path never reads as "all clear").
**Why:** the binding constraint moved from Strava to us; this model matches the app's ethos (public
reports are a safety commons), populates the map from day one, and rests protection on minor-exclusion
+ put-in-gated clipping + publish-consent + opt-out rather than a threshold that would render nothing
at alpha scale. **Deferred:** the crowd-intelligence *derivations* over the aggregate (pressure-ridge /
clearest-side, path-cluster hazard deduction L9/Q11) — legal now (our data) but need volume + a
calibration/privacy pass before they render.

## D59 — Unified report freshness: the report is the unit of decay (Phase 8)
**Decided (2026-07-24).** A GPS path has **no independent freshness** — it is a report's trusted
extent (`reports.activityId → gpsActivities.path`), so its on-map opacity must be a pure function of
the *report's* freshness. Rather than keep parallel copies of the "recency × usefulness ×
weather-since" math, extract a shared primitive:
- **One `core/reportFreshness`** blending `skateEndTime` recency, `netThumbs` (ratings), corroboration
  count (`pointEvents.by_ref`), and `weatherExplainsIceChange` (weather). **Report-aging display and
  path-opacity consume the identical value** → they *cannot* diverge (path opacity = that value +
  a D3 min-opacity floor).
- **Bounties refactor onto the shared *primitives*, not the whole formula.** `bountyFreshWindowHours`
  keeps its genuinely-different policy (trust-window boost up to `BOUNTY_FRESH_MAX_MULTIPLIER = 3`, **no**
  corroboration, weather hard-collapse, D56 reopen thresholds) but calls the shared recency/thumbs/
  weather helpers instead of a private copy. Bounty answers a *different* question than "how faded is
  this path," so identical-formula unification is wrong; sharing the drift-prone primitives is right.
  **Hard gate: every existing Phase 6 bounty test stays green, untouched** — if the extraction can't
  preserve behavior exactly, stop and reassess (do not edit tests to fit); fallback is to unify only
  report+path and leave bounties' private copy.
- **One tunable decay-rate constant** in `reputationConfig.ts`, surfaced as a read-only `ConstantCard`
  in `admin.tuning.tsx` (edit-and-redeploy, Phase 7 posture — no runtime `appConfig` table).
**Why:** "one copy of the math" for the part that would actually drift (the shared primitives), with
each consumer keeping the policy its question demands — the report↔path pair provably can't diverge
because they're one number, and bounties stop carrying a duplicate of the blend.

## D60 — A bay is a named sub-area of one polygon, not a water body (N2)
**Decided (2026-07-26).** The community corpus names big lakes by *arm*, not by lake — Malletts Bay
under ten spellings, the northeast arm of Champlain as "the Inland Sea" (S2). Every name the Phase-2.5
seed failed to match turned out to be a region **inside** an existing polygon. So:
- **New table `waterBodySubAreas`**, one row per named region, always inside a parent body. Reports,
  hazards and bounties keep belonging to the **parent**; the sub-area is the finer name they carry,
  denormalized flat onto each row (`subAreaId` / `subAreaName`) at create. This is the **D4 model**,
  deferred since Phase 1 for rivers-as-named-reaches, instantiated for lakes where the evidence is
  overwhelming. *Rejected:* minting each bay as its own body — that splits one sheet of ice's reports,
  hazards, bounties, favorites and aggregate tracks across a dozen rows and hands the D36 dedup queue
  a permanent stream of parent-vs-child overlap pairs it has no verdict for.
- **Moderators draw them, and this does not breach the path-only doctrine.** That doctrine exists
  because a client-supplied *body* has no proof of presence and no frame of reference. A sub-area has
  neither problem: its geometry is **clipped to an already-trusted official polygon**, its author is
  role-gated, and every write is audited. No body is ever minted from a drawn shape.
- **Clip, don't reject.** A drawn shape is intersected with the parent and the *clipped* result stored,
  so a stored sub-area is inside its parent **by construction** rather than by assertion — and that
  survives the parent changing shape (a canonical re-import re-clips; a bay that no longer fits is
  delisted with a log, never dropped). The write refuses only when too little of the draw survives:
  **0.6** for an interactive trace, **0.35** for a box-seeded row, measured (see the N2 doc).
  *Note the inversion from Phase 9.5:* the hazard clip fails **open**, because hiding a real hazard is
  the direction safety never fails; this one fails **closed**, because failing open would store an
  unconstrained client shape and retire the argument above.
- **A point in two overlapping bays takes the smallest containing one.** Most specific name wins, and
  it's **order-independent** — the answer is a property of the geometry, not of which row an index
  reached first. (First-match would have been N1's whole correction series happening again.)
- **A sub-area is visible only while its parent is.** Cell rows exist on the conjunction, so a
  landowner takedown takes the lake's bays with it; a merge repoints them to the survivor.
- **Full citizens:** labelled (feed card, report detail, hazard lines, through one composition helper),
  searchable by alias, rendered on both clients off their own ladder-grid cell table, and targetable by
  a bounty — narrowed at `attachReportToOpenBounties` and at a sub-area-scoped freshness index, since
  fulfillment begins at auto-attach and an unnarrowed one makes the targeting cosmetic.
- **Deliberately not targeted:** favorites and drive-time. Isochrone bands cache per user against a
  body centroid (D18), and a sub-area centroid sits minutes from its parent's — a multiplied cache for
  a difference below the model's own resolution.
**Why:** the corpus was never asking for more bodies; it was asking for names inside one body. This
gives a skater the name they already use, on their own report, without fragmenting the ice.

## D61 — The operator surface is a per-lake editor, on the same canvas as the map (N2)
**Decided (2026-07-26).** `/admin` was entirely tables and the map lived only in the skater tree, so
curating a lake meant holding it in your head across a queue row, a CSV and an internal mutation.
- **`/admin/water/$id`** — one canvas whose **camera is locked to the body** (`maxBounds` = its bbox
  plus a proportional margin, `minZoom` = the zoom that fits it), carrying every per-body lever:
  prominence with a live zoom preview, sub-area draw/rename/delist, put-ins, weather sample points,
  hazards, aggregate tracks, and this body's review/dedup actions. The lock is the *feature* — the
  server clips a drawn bay to *this* parent regardless, so without it a mistaken pan is silent
  confusion rather than a caught error.
- **One shared map shell**, not a second canvas (founder call over the build's recommendation):
  `lib/mapCanvas.ts` owns creation, theme, bounds, controls, viewport reporting and teardown; callers
  register their own layers. The seam is deliberately low — drawn higher it becomes a shell with a
  dozen conditional props, which is two components wearing one name. **Price: the skater path comes
  out behaviourally identical, evidenced by its suite passing unchanged.**
- **terra-draw, lazy and admin-only** (MIT, first-class MapLibre adapter, own 270 kB chunk). A skater
  never draws anything, so the engine never enters their bundle. **Paste-GeoJSON sits beside it
  permanently** — the way a shape traced elsewhere gets in, and the break-glass path if the import
  fails.
- **Aggregate tracks stay view-only.** The lever on a bad track is hiding the report it belongs to;
  D58's argument — that a second consent flag would let the two disagree and ask people to consent
  twice to one thing — stands unamended. An explicit per-activity exclusion is deferred with a written
  trigger: a real track that is bad on the map but fine as a report.
- **`waterBodies.listCurated`** off a new `by_curated_boost` index. This is the piece whose absence
  was the actual bug: `curatedBoost` was editable per body with no index and no list, so nothing
  anywhere answered "which bodies have I curated?" — which is why five bad matches went unnoticed.
**Why:** the founder *is* the operator, so the tools they use daily are the cheapest way to make what
alpha skaters see materially better. One map, one session, every lever.
