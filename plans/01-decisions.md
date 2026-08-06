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
> **Amended by [D62](#d62--account-deletion-a-30-day-grace-window-and-three-buckets-rather-than-two-n3-amends-d33) (2026-07-27, N3).** The *decision* below stands; its **premise** does not.
> "There's no private content to selectively remove" was true before Phase 4 added `homeCoord` +
> isochrones and Phase 8 added raw GPS paths + OAuth tokens. Deletion now uses **three buckets**
> (erase private / anonymize the public record / keep-but-sever published tracks), runs after a
> **30-day grace window**, and the export **embeds photo bytes** rather than the URLs implied here —
> a URL into our storage dies at the moment an export-then-delete needs it.

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
calibrated table + evidence in [`research/hazard-decay-calibration-and-behavior.md`](../plans/research/hazard-decay-calibration-and-behavior.md).
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
`shallow_early_thaw`** zones (shallow water melts from the bottom first, goes out well before deep
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
  dozen conditional props, which is two components wearing one name. **The price is that a bug in the
  shell is now a bug on both maps, so the shell has its own suite** (`lib/mapCanvas.test.tsx`) rather
  than resting on the pure-helper tests the refactor never touched. The review pass that established
  that also found what the absence had already cost: `initialCenter` was an array literal in the
  effect's dependency list, so the editor re-created its canvas on every parent render and could draw
  exactly one shape per page load. Two maps sharing one shell is the right call *and* it moves the
  lifecycle from "read carefully" to "tested".
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

## D62 — Account deletion: a 30-day grace window, and three buckets rather than two (N3, amends D33)
**Decided (2026-07-27).** D33 settled *that* users can delete and export, and that public content is
**anonymized rather than erased**. Both still hold. What D33 could not have known is what the app would
later store, so this amends its mechanics.

**D33's premise no longer holds.** It reasoned: *"Since all reports are public (D13), there's no private
content to selectively remove."* **Phase 4** then added `homeCoord` + `cachedIsochrones` (a home address
and three polygons derived from it) and **Phase 8** added `gpsActivities.path` (raw GPS traces) plus
`activityConnections` (live OAuth tokens). Anonymize-don't-erase is right for the community ice record
and wrong for a private location trace, so the rule is no longer uniform.

- **A 30-day grace window, finalized by cron** — not immediate. Reversible-by-default is the posture
  every other destructive path here already takes (D15 hazard archive, D36 merge tombstone, D53
  demotion). During the window the account is **fully functional and Clerk is untouched**: banning
  Clerk on request would lock the user out of the very sign-in they need to undo. Cancelling is an
  **explicit button**, never an implicit side effect of signing in.
- **Three buckets, not two.** *Erase* the private artifacts (OAuth tokens, notifications + queue,
  favorites, blocks, support tickets, home location + isochrones, unattached photos). *Anonymize* the
  public ice record (reports, comments, hazards, ratings, bounties, flags, point events — author
  pointer → tombstone, content untouched). And **keep-but-sever** published GPS tracks.
- **The GPS rule is D58's own predicate, reused: a `gpsActivities` row is kept iff it is linked to a
  visible report.** An unlinked activity is a recording the person never published — private, no
  community value, erased. A linked one is *publish-is-consent* (D58 gate 1) and is already drawn on the
  lake. Provider handles (`providerActivityId`, `photoUrls`) are scrubbed; the path stays.
- **Finalize must NOT set `excludeTracksFromAggregate`.** Stated as a prohibition because the mistake
  is attractive: flipping it on looks like the cautious privacy choice, and would silently delete the
  contribution this decision exists to preserve. D58's four gates all read data that survives deletion,
  so the heatmap keeps working — including honoring `showPutIn` clipping — with no changes at all.
- **Per-row-unique tombstone sentinels.** `username → deleted-<id>`, `clerkUserId → deleted:<id>`. Both
  are read with `.unique()`, so a shared `'deleted'` constant would make the *second* deleted account
  break authentication for the whole app.
- **Export embeds photo bytes, not URLs**, and is **emailed plus listed in settings** until it expires.
  A URL into our storage dies when the account is deleted — worthless at the one moment the export
  exists for (export-then-delete). The in-settings listing is what makes the feature verifiable before
  Resend is provisioned, and stops a spam-filtered email being a dead end.
**Why:** the ice record is the community's, but a GPS trace and a home address are the person's. One
rule couldn't serve both, and the seam that separates them already existed in D58.

## D63 — A season is July 1 → June 30, and it is derived rather than stored (N5a)
**Decided (2026-07-27).** Nothing in the app expired: `reportFreshness` (D59) is an *opacity*
multiplier, not a visibility gate, so a report from two seasons ago still rendered in a lake's drawer
and its GPS path still drew on the aggregate map — at ~0 opacity, but present. The map should show
**this** season's ice; everything else is history you go and look at on purpose.
- **The season boundary is July 1**, labelled `'24/'25` because a skating season spans New Year. July
  is the deadest point of the year in the Northeast, so the boundary never cuts a live season and the
  reset lands when nobody is looking at the map.
- **Season is DERIVED, never stored.** `seasonOf(skateEndTime)`; current season is `seasonOf(now)`.
  There is no `season` column, no backfill, no cron to advance anything and nothing to drift — the
  reset isn't an event, it's the derived value changing and the queries following. The mechanical
  payoff is that `skateEndTime` is already the range field of three existing indexes, so seasonal
  scoping makes those reads **cheaper**, not more expensive.
- **Hazards reset on the same boundary**, and recurrence is **D53's `bodyFeatures` promotion** rather
  than new machinery: a hazard that forms in the same place every winter becomes a persistent body
  feature, which no seasonal reset touches. That makes the pre-first-ice promotion pass a **safety**
  task rather than housekeeping, so the admin surface has to present it as one.
- **Past seasons are browsable per water body**, never globally and never in the map's default state —
  a curiosity ("what was this bay like in December?"), not a safety surface, so it sits where you're
  already asking about one lake.
**Two premises the code check falsified**, both making this decision matter more rather than less:
**reports don't draw on the map at all** (there is no report layer — what reaches the map from a report
is its put-in marker, its track and its photo pins), so the map half is *tracks + hazards* while reports
are scoped in the feed and lake list; and **hazards never age out** —
`deriveHazardLifecycle` archives on community "fully healed" votes only, with no time-based archival
anywhere, so an unvisited hazard stays `active` forever at a deliberate map opacity floor. A ridge
reported in February 2025 is still drawn today. The recurring-hazard case is therefore handled *by
accident* today, by a stale pin that never leaves and asserts a position nobody has evidence for.
**Why:** an app that never forgets shows a skater a two-year-old report next to Tuesday's and asks them
to tell the difference from opacity alone. Hiding is the honest default; a labelled way back is the
honest exception.

**Four things settled at build kickoff (2026-07-28), each a question the decision left open:**
- **A hazard's season is its `firstReportedAt`**, not `lastConfirmedAt`. The boundary is therefore
  **hard**: nothing crosses it except a deliberate `bodyFeatures` promotion, which is exactly what
  decision 3 says the safety cover is. Aging on `lastConfirmedAt` would have let a single confirmation
  carry a pin into the new season with no operator in the loop — a soft reset that quietly re-answers
  the question the promotion pass exists to ask. Note this is the *opposite* field from the one
  `lib/contentPurge` ages hazards on, and deliberately so: redaction asks *"is the community still
  maintaining this?"*, seasons ask *"when was this first seen?"*.
- **The season selector governs the whole lake view** — the report list, the hazards *and* the tracks,
  on the map as well as in the list. "What did this bay look like last December?" is mostly a map
  question, and answering it with a re-listed sidebar over a current-season map would show two seasons
  at once, which is the confusion this decision exists to end.
- **The global feed falls back to last season, labelled.** Seasonal scoping empties the feed on July 1
  and it stays empty until first ice — five months of a dead home screen, not a July curiosity. When
  the current season has no reports the feed shows the previous one under a divider that says so. The
  label is what keeps this from being the thing the decision forbids: nothing is silently mixed.
- **A profile's report list is never season-scoped.** "What has this person contributed?" is not a
  question about the state of the ice, and a seasonal reset must not make a four-year contributor read
  as a new account. It is also the index `lib/contentPurge` sweeps, so the bound must not leak into it.

## D62 amendment — the request *is* the deletion; only the login waits 30 days (N5a)
**Amended (2026-07-27), twice in one day, and the second correction reversed the first's premise.**

> **Round one is superseded by the [D62 second amendment](#d62-second-amendment--erase-the-person-keep-the-observation-n5a) (same day, later).** Everything below about the *person* — the
> immediate profile scrub, the read gates, read-only, the reserved handle, the DOB carve-out — stands
> unchanged and is the load-bearing half. What does not stand is "erased": a departed skater's
> published content is **kept and redacted**, not deleted. Read this section for the ghost; read the
> next one for what happens to what they wrote.

**Round one: a departed user's content is erased at 30 days.** D62 said published GPS tracks are kept,
severed from identity. They still are — **for 30 days past the skate**, and then only for as long as
the report they hang off survives. The report, its GPS activity and path, the hazards they created and
their photos are erased 30 days after `skateEndTime`; **all** their bounties go immediately, including
open ones (a request from someone who left can't be fulfilled *for* them); **put-ins survive** (access
is the corpus's most-discussed concern, S1).

**Round two: a pending deletion is read-only, and the person is already gone** (founder call). D62 said
the account stays "fully functional" for 30 days, reasoning from the *sign-in* problem — banning the
Clerk user would lock someone out of the login they need to cancel with. That reasoning was sound and
its conclusion overshot in both directions.

*Too permissive about content.* A report posted in hour 719 of the window is erased hours later while
it is still the freshest thing on the lake — the window preserving nothing and costing someone the
effort of writing it. Contributing and leaving are contradictory acts; the app should make you pick.

*Too slow about the person.* Someone who asks to be deleted should stop existing on the platform then
and there, not in a month. So **`requestDeletion` really deletes**:

| At the request | At finalization (day 30) |
|---|---|
| profile **scrubbed** — name, avatar, bio, town, `homeCoord`, isochrones | the private side-tables (tokens, favorites, blocks, tickets, notifications) |
| public profile + profile search return **not-found** to everyone but them | `clerkUserId`, `username` and `dateOfBirth` scrubbed; the Clerk user deleted |
| surviving content reads as **"Deleted skater"**, no handle, no trust ring | whatever crossed the 30-day line since |
| everything past 30 days past its skate **erased**, plus every bounty | |

- **Cancelling stops the deletion; it does not restore the person.** The profile stays empty and they
  are routed back through onboarding (`needsProfileSetup`); the purged content is gone. That isn't an
  implementation limit — the data was deleted, and a cancel that pretended otherwise would be the one
  dishonest thing in the flow.
- **The handle is reserved, not released** (founder call). Invisibility comes from the read gates, not
  from mutating the field, so releasing it buys nothing and could cost someone their name to a
  squatter in a window they may well cancel in.
- **`dateOfBirth` is the one PII field that waits for finalization**, and the reason is safety, not
  convenience: scrubbing it means restoring it as the 1900 sentinel, which derives to *adult*, so a
  minor who cancelled would come back with an adult's posting rights.
- **The purge keeps running while the account is pending**, not once at the request: content three
  days old when they left is thirty-three days old three weeks later, and "your old reports are gone"
  has to keep being true rather than describing one instant.
- **Blocked** (`requireContributor`, distinct from `requireProfile` because that one gates *queries*
  too, and reading is most of what "you can still change your mind" means): reports, comments,
  hazards, hazard confirmations, thumbs, bounties, photo uploads, native track ingest, new provider
  connections, skater-created water bodies.
- **Open**: flagging (a hazard is no less dangerous because the person who spotted it is leaving),
  blocking (self-protection outlives the account), support, export, private preferences — including
  `excludeTracksFromAggregate`, a privacy control that must not be collateral damage — and the
  load-bearing one, **cancelling**.
- **The clients hide the affordances, they don't just fail the call.** The point is not to refuse a
  report — it's to never invite one. Both apps drop every closed control and put one line in its
  place, because a button that silently vanishes reads as a broken build. **The rule keeping client
  and server honest: hide exactly what `requireContributor` blocks, no more and no less.** Three
  deliberate exceptions: the mobile draft queue (their own unsent work, and the only screen that can
  delete it), an existing Strava connection (only *connecting* closes — unlinking on the way out is
  what this window is for), and profile editing (its mutation carries the aggregate opt-out).
- **The copy had to be rewritten, not adjusted.** It said "nothing is deleted for 30 days" of an
  action that now clears your profile and erases your older reports on the tap. Copy that promises
  reversibility for an irreversible action is worse than no copy, so the confirm screen leads with
  what can't be undone.
- **The mechanical payoff.** With posting closed, a ghost's newest `skateEndTime` can't postdate their
  request, so everything they hold has aged out by finalization. The purge needs no `contentPurgeDueAt`
  stamp, no second index and no deferred sweep — it's a stage of the existing chain. The grace window
  and the relevance window are the same 30 days *by construction*, a coupling to keep deliberate if
  either number moves.
- **The cost, accepted:** a skater on bad ice during their window can't file the hazard. Cancelling is
  one tap and the error says so, but it's a real trade rather than a free win.

**What the build found:** the decision *"put-ins survive"* was **false in the code**, and invisibly so.
Derived put-in markers aren't stored — `putIns.listForBody` recomputes them from a body's live reports
on every read — so erasing a departed skater's reports silently erases the access points they revealed,
and nothing named `putIn` appears in a purge that only touches `reports`. The purge now materializes
the access point before its report goes (a stored `derived` row, snapped to shore, deduped), and
`listForBody` had to learn to read those rows: they were a row class nothing had ever written, so
nothing read them either.

**Flat 30 days, not the D59 freshness curve.** The curve is more principled — a corroborated report
earns a longer life — but the consequence is irreversible deletion, and a rule verifiable by reading
one field beats one that depends on other people's later votes. N3/N4 shipped a bug caused by a
subtly-wrong predicate on exactly this kind of sweep.

**The governing principle, since two rules in N5a look alike and aren't:** *aging never erases
anything; an intentional account deletion erases everything that isn't of immediate value to the
community.* Staleness and seasons only ever **hide** — for everyone, reversibly, with a labelled way
back. Erasure has exactly one trigger, and it's a person deciding to leave.
**Why:** the ice record belongs to the community and the person doesn't. Their reports keep someone
off bad ice for as long as they're current, and everything that says *who* left goes immediately —
because 30 days is long enough that anything still true has fresher reporting behind it, and holding a
departed person's data past its usefulness is the least respectful option available.

## D62 second amendment — erase the person, keep the observation (N5a)
**Decided (2026-07-27, founder call, later the same day.)** The first amendment erased a departed
skater's content 30 days past its skate. Following that through exposed a seam it had drawn in the
wrong place, and the rule that replaces it:

> **A departed skater's private artifacts are erased. Their published observations are kept,
> anonymized, with every free-text field cleared at 30 days.**

**The distinction the erasure rule missed is between what a person *typed* and what they *observed*.**
A name, a home coordinate, a bio, report notes, a hazard description, a photo caption, a raw
unpublished trace — those are theirs, and erasing them is the respectful default. A coordinate, an ice
type, a thickness reading, a hazard geometry and a date are not facts about anybody once the author
pointer is a tombstone. They are the ice record, and deleting them takes something from the next
skater without giving anything back to the person who left.

| Bucket | What | When |
|---|---|---|
| **Erased** | OAuth tokens, notifications + queue, favorites, blocks (both directions), support tickets, client signal events, unpublished recordings, unattached photos | finalization |
| **Erased** | **every bounty**, open ones included — a standing ask nobody is making any more | **the request** |
| **Redacted** | `reports.notes`, the `note` on each thickness reading, `hazards.description`, photo captions, comment bodies | 30 days past the skate (`createdAt` for comments) |
| **Anonymized** | everything else on the public record — reports, hazards, ratings, confirmations, flags, put-ins, point events, bodies and sub-areas | finalization, by one write |
| **Kept, severed** | GPS tracks linked to a visible report | finalization |

**Three things this fixes that the erasure rule had broken:**

- **Bucket 3 was unreachable.** D62's "kept, severed from identity" existed only on paper: the purge
  deleted every report first — all of a ghost's reports are >30 days old by finalization, by
  construction — and each deletion took its linked activity with it, so `severTracks` could never keep
  anything. The aggregate-map contribution D62 exists to preserve was silently deleted. Every test
  missed it because they all reached finalization through `finalizeNow`, which stamps and finalizes in
  the same instant and therefore never lets content age. There is now a test that advances the clock
  30 days and goes in through the cron.
- **Hazards were aged on the wrong field.** `firstReportedAt`, so a ridge first seen forty days ago
  and confirmed by six other skaters yesterday — the most current thing on that shore — was deleted.
  Now `lastConfirmedAt`, and hazards are never erased at all: a hazard row is a point, a type and two
  dates, and it is exactly the multi-season record N5a's recurrence detection and `bodyFeatures`
  promotion are built on.
- **Comments survived verbatim, forever.** The weakest position in the design: reports were erased at
  30 days as no longer of immediate value while free text a person typed was kept indefinitely. The
  row now survives as a marked shell — the thread is keyed by `reportId`, so deleting it would leave a
  hole in somebody else's conversation — rendered as *"This comment was deleted"* under the tombstone.

**Consequences worth carrying forward:**

- **Put-in preservation is no longer needed, and its removal is the fix rather than a regression.** The
  first amendment discovered that *"put-ins survive"* was false in the code — derived markers are
  recomputed from live reports, so erasing the reports erased the access points — and compensated by
  materializing a `putIns` row before each delete. With reports kept, the report *is* the preservation.
  The stored-row reader in `putIns` stays; rows written by the old path exist on dev.
- **Put-in markers now carry `lastUsedAt`** (founder call). Put-ins are exempt from every ageing rule
  in the app, which is right and has a cost: an access point from three winters ago rendered
  identically to one used last week, while being the kind of fact that *does* go stale — land changes
  hands, a gate goes up, a pull-off gets posted. Saying when it was last used lets the exemption stand
  without the marker overclaiming (D3).
- **A ghost can no longer edit any field** (founder call). `updateProfile`, `setHome`,
  `setFeedFilterPrefs` and `setNotificationPrefs` moved to `requireContributor`: the request *clears*
  those exact fields, and a ghost could type them straight back in, making the wipe read as a
  suggestion. `excludeTracksFromAggregate` split into its own open mutation — it governs the tracks
  that survive the account, so it is the one setting a departing skater must not lose.
- **An emailed export outlives the account.** The TTL moves 7 → 30 days and runs from *ready*; a bundle
  still inside it survives finalization, because export-then-delete is the commonest reason to ask for
  one and `myExports` needs a sign-in there won't be. Only if it was actually **emailed** — otherwise
  nothing can reach it and retaining it is pure cost.
- **The governing principle needs restating**, since the first amendment's version is now wrong:
  *aging never erases anything; an intentional account deletion erases what is private and redacts what
  is personal, and keeps the observation either way.* Staleness and seasons only ever **hide**.

**Why:** the ice record belongs to the community and the person doesn't — and the first amendment
conflated the two. What is disrespectful is holding *their* data: their name, their home, their traces,
their words. A depersonalized observation of what ice was doing on a Tuesday isn't theirs any more, and
erasing it moves a cost onto skaters who had no say. Revisit if the community objects.

## D64 — Suggested crossings decay in the opposite direction from hazards (N5a)
**Decided (2026-07-27).** `ridge_crossing` is a **passage marker, not a danger** (D51), and it
currently inherits the hazard lifecycle wholesale: Tier A\* decay (`freshH: 12`, `agingH: 36`), archival
only on two `fully_healed` votes, and the `hazardLayer` opacity **floor** that means stale never becomes
gone.

For a hazard that floor is conservative — it over-warns, which is the safe direction. For a crossing it
is **anti-conservative**: a marker placed in November still reads "reported crossable" in March with
nobody having looked since. One rule, opposite safety meanings, applied to the one type it doesn't fit.

So passage markers get an inverted lifecycle:

| | Hazard | Suggested crossing |
|---|---|---|
| Absence of evidence | **keeps it alive** — assume the danger is still there | **kills it** — assume the crossing is gone |
| Positive votes | optional; refresh the clock | **required to survive**, and more of them |
| One negative vote | counts quietly toward a 2-vote archive | **shows as disputed**; two still needed to close |
| Past its window | fades to a visible floor, never disappears | **expires — stops rendering** |

- **Several crossings per ridge**, each its own row, authored and rendered as a set belonging to one
  ridge. Downvoting one affects that crossing, not the ridge.
- **A single "closed" vote makes a crossing visibly disputed rather than removing it** (founder
  refinement, 2026-07-27). Closing still takes two. The first vote is currently **invisible** —
  `goneCount` goes to 1, `status` stays `active`, and `healingState` only ever reflects a
  `healing_unsafe` verdict — so one skater saying "you can't cross here" changes nothing on screen.
  It now renders a cautionary state: *"the safety of this crossing has been disputed — be careful."*
  - Removing on one vote, which this decision originally said, was **wrong twice over**: it let any
    single user delete another's contribution with no threshold — a moderation hole that would have
    been caught in review had someone else written it — and removal *destroys information*, where the
    disputed state keeps both facts the skater needs (a crossing was reported here; someone disagrees).
  - **`disputed` outranks `healing_unsafe`** when both apply: "the ridge is closed" is a stronger claim
    than "the crossing is dicey".
  - **Passage markers only.** On a *hazard*, surfacing a below-threshold "gone" vote would invite
    skaters to discount a live warning — the unsafe direction. Same asymmetry as the inverted decay,
    and the reason both belong to the same decision.
- **The copy is "suggested crossing", never "safe crossing"**, and every surface repeats that judging it
  in the moment is the skater's call, not ours — extending the existing verdict relabelling
  (*still crossable / dicey now / ridge closed*) rather than replacing it.
- `isHazardVisibleByDefault` gains a passage-marker branch: the **one** place a pin may leave the map on
  time alone, which needs to be conspicuous in the code precisely because it contradicts the rule beside
  it.
**Why:** the asymmetry falls out of D3 rather than being invented for it. Getting a crossing wrong in
the *remove* direction costs a skater a longer walk; getting it wrong in the *keep* direction walks them
onto ice nobody has checked. Only one of those is recoverable, so the failure has to be biased toward
the recoverable one — which is the opposite bias from a hazard.

**The two constants, settled at build kickoff (2026-07-28).** The decision argued the shape and left
the numbers, and both of them are safety numbers:
- **Expiry is its own window — 72 hours — not the existing `agingH`.** Reusing the freshness tier
  would have made "faded" and "gone" the same instant, so a Saturday-morning crossing would stop
  rendering on Monday evening whether or not anyone had been near the lake. A separate constant lets
  the pin fade first and expire later, and it survives a weekday-quiet lake where nobody is around to
  re-confirm. It is deliberately **shorter** than any hazard's stale threshold and deliberately
  **longer** than a crossing's own `agingH: 36`.
- **Two independent confirmations to stop being provisional**, against `DEFAULT_CONFIRM_THRESHOLD: 1`
  for every hazard type. "More corroboration" is literally double the bar. Any `still_there` vote still
  resets the 72h clock — one person *can* keep a crossing alive — but it takes two before the marker
  reads as corroborated rather than as one skater's suggestion.

**Two things the build had to be told twice** (review pass, 2026-07-28), both because `disputed` and
`expired` were *added* to shapes that existing code already read correctly:

- **The offline optimistic path also has to know about passage markers.** `applyConfirmation` — the
  single-vote model the mobile queue applies before a flush — had no `isPassage` option, so it could
  never produce `disputed`. A skater casting "ridge closed here" saw the pin not change and learned it
  had registered only after the next sync, on the one verdict a crossing most needs shown.
- **An expired marker still has to say so.** Expiry is the one place a pin leaves the map on time
  alone, which makes a permalink the only route to it — and the permalink rendered it as an ordinary
  live pin. It now says it aged out, in wording that does **not** claim the ridge closed: silence
  retired it, nobody reported it, and a confirmation revives it.

## D65 — The confirmation loop gains a "never existed" verdict and named confirmers (N5a)
**Decided (2026-07-28).** Two items folded into N5a from the old N5 entry, both in the confirmation
loop, neither previously designed anywhere.

**1. A fourth verdict: `never_existed`.** Today a skater who arrives at a pin and finds *nothing that
was ever there* — a mis-tapped location, a misidentified shadow, a troll — has only `fully_healed` to
say it with, which records "it was there and it cleared". That is a false entry in the ice record, and
it's the entry the recurrence detection this phase unlocks would later read as evidence.

- **It pools with `fully_healed` toward the same 2-vote archive.** The two verdicts disagree about
  *history* and agree about the *present*, and the map shows the present. Requiring two of a kind
  would leave a genuinely-clear hazard standing because its two witnesses explained it differently.
  The threshold does not get cheaper: two independent non-author votes, exactly as before.
- **It also files a moderation flag at the threshold**, which `fully_healed` does not. "There was
  never anything here" is a claim about the *report*, where "it healed" is a claim about the *ice* —
  and `hazardLifecycle.ts` already keeps moderation and lifecycle as separate axes on purpose. Two
  people saying a pin was bogus is exactly the signal a moderator should see, and archiving it without
  telling anyone would let a pattern of fabricated pins disappear one archive at a time.
- **The archive stays an archive** (D15): never a hard delete, so a re-report resurfaces it.

**2. Confirmers are named, subject to the profile-privacy flag they already set.** A confirmation from
someone whose history you can look at carries weight a bare count doesn't — that is the whole point of
D50's boost-only trust — but a confirmation is sharper than a report: it says a named person stood at a
specific point at a specific time. So the drawer names the confirmers whose `profileVisibility` is
`public` and counts the rest ("confirmed by Alex R., Sam K. and 3 others"). Reusing a consent signal
the user has already given beats inventing a per-confirmation one, and minors are forced private (D41),
so they are never named by construction.

Two amendments from the review pass (2026-07-28), both about *who* the list may contain and *how* it
renders:

- **The hazard's own author is never among the confirmers.** Their vote refreshes the decay clock but
  counts toward no threshold (D54), so naming them printed more names than the count they sat under —
  and printed the reporter as their own corroborator one line below "reported by" them. The vote is
  flagged rather than dropped: a moderator reading the history should still see it.
- **The names must survive the sentence they're rendered into.** Both drawers show this mid-clause
  ("reported 3 days ago by Alex · confirmed by …"), and the obvious way to fit it —
  `confirmerSummary(...).toLowerCase()` — was correct for the old bare-count string and *lowercases the
  names* in the new one. That is the entire feature undone by a call site that never changed. There is
  now a `confirmerClause` that lowers only the leading word, so the fit isn't a convention anyone has
  to remember.

**Why:** the first item closes the only gap in the verdict vocabulary — there was no way to say a pin
was wrong rather than stale — and does it without opening a cheaper removal path than the one D3's
asymmetry sets. The second makes corroboration legible without making it a location-disclosure surface
for anyone who asked not to be found.

## D66 — A departed skater's photos split on evidential value and expire at the season boundary (N5a)
**Decided (2026-07-28).** The one genuinely open question in the deletion walkthrough, and the last
place D62's "what a person typed vs what they observed" seam doesn't cut cleanly.

Under the second amendment a photo on a surviving report is kept whole — bytes, timestamp, coordinate
— and only its caption is redacted. But **the image is the largest identifiability surface in the
system**: faces, a licence plate, a house behind the put-in, the departed skater themselves. It is
*observation*, which is why no bucket ever questioned it, and it is also the richest personal data we
hold.

- **A photo attached to a hazard is kept**, indefinitely and whole. A picture of an open lead is worth
  more than any sentence describing one, and it is precisely what the next skater on that shore needs.
- **Every other photo a departed skater uploaded expires at the end of the season it was taken in** —
  report photos, the beautiful-morning shots, and (a real cost, accepted) the put-in documentation that
  S1 calls the corpus's most-discussed concern.
- **The clock is this phase's season boundary, not a fourth deletion timer.** That is the argument for
  building it here rather than later: the alternative is inventing a per-photo TTL that duplicates a
  boundary the app already computes.
- **It therefore has to outlive finalization.** Finalize lands 30 days after the request, mid-season by
  construction, so the sweep runs off `profiles.by_status` (`deleted`) rather than the pending index
  that the tombstone drops the row out of.

Alternatives weighed and rejected: keeping hazard photos and dropping all others *at finalization*
(simpler, loses more, and takes this season's put-in documentation with it); stripping EXIF and
re-encoding (addresses metadata, not the pixels, so it misses the actual concern); and offering the
choice at delete time (a consent record we would then owe forever, asked at the worst possible moment).

**Why:** the loss falls only on people who chose to leave, and it falls on the photos with the least
evidential value. Holding a departed person's photographs of themselves and their neighbours forever,
because the coordinate attached to them is ice record, is the retention this rule exists to prevent.

**A capped scan escalates; it must never be retried** (Greptile, 2026-07-28). The completion marker
below created a second, subtler starvation, and the fix for it was already written down in this repo.
When the one-shot hazard scan caps, the pass keeps every photo — right, and never in question — but the
first version then left the account *unmarked* so it would be retried. The cap is a property of the
**uploader**, not of the moment, so tomorrow returns the same `null`, and every day after: the photos
are retained forever with no automated path, and — because unmarked accounts sort first — the account
permanently occupies a slot in a bounded page, so enough of them and no other tombstone is ever
reached. That is N3/N4's starved pending sweep arriving by a different road.

`photoReconcile` exists precisely because *"a `null` is not an answer to be retried, it's a method to be
escalated from"* (PR #30). It now runs in two modes: the original `orphan` check, and a `season_expiry`
mode that asks the D66 question — *is this photo named by a **hazard*** — completely, across as many
transactions as it needs. A mode rather than a second file, because two destructive passes over the
same rows must agree exactly on the paging and the fail-safe. **Its phase list omits `reports`, and
that omission is the policy**: a surviving report must not protect a departed skater's photo. Its own
scratch flag, not the orphan job's, so two daily crons can't clear each other's marks.

**The escalating caller claims a lease; only the finishing run writes the marker** (Greptile, second
pass). The first version had the caller stamp `photosExpiredForSeason` at the moment it *scheduled*
the job — claiming the photos had been answered when the work hadn't started — so a reconcile run that
died left the account excluded from every later sweep with its eligible photos undeleted, silently and
permanently. A `photoReconcileStartedAt` lease says *someone is on it* instead; the run refreshes it
each call, and its final phase releases it and writes the marker together. A dead run stops refreshing,
the lease goes stale after a day, and the next tick takes it over — a failure costs a day, not a season.

The lease also closed a hazard that predates this phase: both modes are escalated by daily crons that
had no idea whether a previous run was still going, and two overlapping runs could interleave one's
`sweep` with another's `mark` and delete a photo the second had marked but not yet cleared — a
*referenced* photo, the one mistake this area exists to prevent. One lease per uploader across both
modes, because they mutate the same rows and serializing them is the point.

**The sweep needs a completion marker, which is not an optimization** (review pass, 2026-07-28). As
first built, the daily cron fanned out to every tombstone the app had ever had and re-paginated its
whole photo table, forever — the cost growing with every departure, and nothing in the result looking
wrong. A `profiles.photosExpiredForSeason` stamp makes it one pass per account per season. Two details
worth carrying: the season is resolved **once by the sweeper** and threaded through each account's
continuations, so a July 1 rollover can't mark a pass complete for a boundary its earlier pages weren't
judged against; and a pass whose hazard scan hit its cap deliberately **doesn't** mark the account, so
the next tick retries rather than accepting an unanswered question as finished. The index it reads is
the one place a Convex index on an optional field being **non-sparse** is the behaviour we want —
never-swept accounts have no value, `undefined` sorts before every number, so the range *is* the queue.

## D67 — Freeform hazard areas, and shore bands that come off the lake's own outline (N5b)
**Decided (2026-07-28; built in N5b.)** Completes the third of D51's three primitives, and instantiates
the "snap to shoreline" affordance research §4 logged and Phases 9 and 10 each deferred. Both are
authoring — no lifecycle, no new hazard type, no schema change.

**Snapping is offered for `thin_ice` and `open_water`, and no others.** The N5b plan opened by naming
`thin_ice_shore` and `ice_edge`, which are **not hazard types** — research §4 used them as English
descriptions of a *shape*, and the plan read prose as identifiers. These two are the existing
vocabulary's shore-shaped members: rotten shore ice, and a lead running along the ice edge. *Considered
and rejected:* every line-capable type (snapping a mid-lake pressure ridge to a shoreline is offering
the wrong geometry, confidently), and adding `wet_crack` / `overflow_slush` / `shell_area` — all of
which frequently *occur* near shore without being shore-shaped.

**Areas are drawn with terra-draw on web and tap-to-place on mobile — two UXs for one primitive, on
purpose.** terra-draw has **no React Native adapter**; every adapter it ships targets `maplibre-gl`,
the DOM library, and mobile's map is a native module. So the question the plan asked — *is a ~218 kB
draw chunk acceptable on a phone?* — had no answer, because the chunk can never reach one. What was
really being chosen is per-client mechanism. Web gets real vertex dragging, which is the specific
capability D51 named when it deferred polygons in the first place; mobile gets the close-the-ring step
on the tap-to-place trace that has shipped since Phase 9. The chunk stays **lazy** and is fetched only
by the person who arms the tool.

**No type defaults to a polygon.** `HAZARD_DEFAULT_GEOMETRY_KIND` gains no `polygon` entry, so the
primitive is reached only by switching a draft to it — exactly the "opt-in, de-emphasized advanced
affordance" D51 specified. On the ice this also protects the **two-tap guarantee**: an area needs
three taps and a close, so every type still starts as a circle at the skater's GPS and a mitten-fumble
that hits Done early still files something useful. A **hand-drawn** polygon correspondingly **survives
a re-type** where a line does not: reaching one took a deliberate opt-in plus three placements, and the
type picker must not silently destroy the primitive that costs the most care.

**A snapped band is the exception to that, and only that one** *(amended 2026-07-29, from the review)*.
Re-typing away from a shore band **drops the ring**. The two rules read as contradictory and aren't:
what "survives a re-type" protects is *effort*, and a band cost two clicks, not three placements plus an
opt-in. What it would carry across is worse than nothing — a `pressure_ridge` shaped exactly like a
shoreline, a footprint the on-ice watcher measures against, asserting a geometry derived for a different
type's shape. Web was doing this silently, directly beneath a comment claiming it didn't; mobile already
reset to a circle. The rule is now the same on both.

**A snapped band is stored as an ordinary `polygon`, and `bufferMeters` means what it means
everywhere else.** The geometry is the shore arc buffered by the band half-width; `bufferMeters` is
then the type-aware uncertainty halo `hazardFootprint` applies to any polygon. One rule downstream —
which is the only thing that makes *"snapping is an input convenience, not a stored relationship"*
true rather than merely said. Taken seriously in the UI too: the moment someone drags a corner on web,
the band stops being snapped and becomes an ordinary area, and the copy says so.

**The halo is a second quantity, not the same one twice** *(amended 2026-07-30, from Greptile's review
of PR #32)*. A band derived at half-width `H` and stored with halo `B` warns from `H + B` out: at the
default 25 m with `thin_ice`'s 10 m margin, a skater who said "25 m out" gets a footprint reaching 35 m.
Read cold that looks like the buffer being applied twice, and it isn't. `H` is a claim about the **ice**
— rotten shore ice runs tens of metres out, which is why `SHORE_BAND_DEFAULT_HALF_WIDTH_M` is 25 and not
the type's 10 — and `B` is the type's uncertainty about **where any hazard's edge is**, which every other
hazard in the app also carries. Dropping `B` would make a shore band the only hazard whose footprint is
exactly its author's eyeball estimate, which is D3 read backwards: for a hazard footprint the fail-safe
direction is *out*, and warning 10 m early is the error worth having. *Considered and rejected:* deriving
the band at `H − B` so the total lands on `H` (breaks whenever `B ≥ H`, and quietly makes the number the
skater set not the number the ring uses), and storing the band with `bufferMeters: 0` (no downstream
special case — `hazardFootprint` handles a zero halo — but it strips the one hazard that most needs an
uncertainty allowance of the only one it had).

What the objection *did* land is **disclosure**. A band was the one primitive whose stepper number wasn't
the whole footprint — on a line the buffer *is* the footprint, on a hand-drawn area the number is
explicitly "give around the edge" — and both clients now name `H + B` next to the stepper and say why the
two differ. A geometric test pins the relationship (ring alone reaches `H`, footprint reaches `H + B`, and
the footprint can never reach *less* far than the band) rather than leaving it to be re-derived.

The other obvious objection — a halo around a shore band spills onto land — **needed no new code**. Phase
9.5's `clipFootprintToBody` already intersects a hazard's buffered footprint with the body polygon at
insert, stores the clipped result, and is what the map draws and `distanceToHazard` measures. A shore
band is the exact case it was written for, so the landward half of the band *and* of its halo are
confined to the ice automatically. The band is therefore buffered **symmetrically** and left to that
clip rather than offset one-sidedly here: two places deciding where the ice ends is how they come to
disagree. *Considered and rejected:* storing the band as a `line` whose `bufferMeters` does all the
widening — it reuses more machinery and would have shipped independently of polygon authoring, at the
cost of two geometry kinds downstream for one affordance.

**Only one size stepper is ever on screen.** Two widths exist in the model — the band half-width that
derives the ring, and the halo around it — and never at the same moment. While snapping, ± tunes the
half-width and the ring re-derives live; on a hand-drawn area it tunes the halo.

**"While snapping" means while two shore taps are in hand — including while the band is refused**
*(amended 2026-07-29, from the review)*. Both clients originally keyed the stepper on the band having
come back *valid*, which took the width away at exactly the moment it was the fix. The commonest refusal
is a band wide enough to seal into itself: measured on a ~100 m-radius pond going the long way round, the
default 25 m half-width refuses where 15 m succeeds **at the same two taps**. A refusal is a state of the
band, not the end of snapping, so it keeps every control that could rescue it — narrower, the other way
round, or a different stretch — and the refusal copy names the width first. A safety affordance that
dead-ends someone standing on ice with a hazard to file is worse than one that was never offered.

**The shorter arc is the default, with an explicit "go the other way".** Two taps on a ring define two
arcs; shorter is right almost always and silently wrong on a small pond or a narrow bay, where the band
a skater means is most of the perimeter. A control, not an inference — and specifically not inferred
from the map centre, which is unpredictable in exactly the cases that need predicting. **Taps that
resolve to different rings are refused rather than guessed** (an island's shore and the mainland's, or
two parts of a MultiPolygon), in the same spirit as N2's clip-refusal threshold, as is a tap more than
500 m from any shoreline and a buffer that comes back as two lobes.

**The polygon validator stopped being decorative.** `isValidHazardShape`'s `polygon` branch read
`coordinates[0]` and nothing else — first ring of first part — capped vertices per-ring rather than in
total, never required closure and never checked self-intersection. It was unreachable while no client
could author a polygon; this decision makes it the thing standing between a scripted client and a
footprint the on-ice watcher buffers on every GPS fix. Now every ring of every part, closure required,
one cap across the whole geometry (forty holes of forty vertices cost what one 1,600-vertex ring does),
and `ringSelfIntersects` on each ring. terra-draw refuses a crossing ring on web as a courtesy; the
server refuses it because a client's manners are not evidence.

## D68 — Depth is a best-available number that carries its provenance (N6a)
**Decided (2026-07-29; N6a kickoff.)** No single source gives us lake depth, and the sources differ in
kind — some measured, some modelled — so depth is stored as a **best-available value plus a record of
which rung produced it**. Four rungs, highest first: an **operator override** (a state-agency survey or
local knowledge, typed into the N2 per-lake editor); **LAGOS-US DEPTH** (observed, ~65 compiled agency /
university / monitoring sources, lakes > 1 ha); **HydroLAKES `Depth_avg`** (`Vol_total / Lake_area`);
and **GLOBathy `Dmax`** (random forest over shoreline length / area / volume / elevation / watershed
area).

**Provenance is per measurement, not per body.** The register's N6 entry proposed a single
`depthSource`, which cannot be honest: LAGOS-US holds 17,675 maximum depths and only 6,137 means, so a
body will routinely carry a measured max next to a modelled mean. `meanDepthSource` and `maxDepthSource`
are separate fields.

**HydroLAKES splits into two rungs on `Vol_src`.** `Vol_src` 1 or 2 means `Depth_avg` derives from a
*reported* volume rather than the geostatistical model, so those rows rank above `Vol_src = 3` —
`hydrolakes_reported` and `hydrolakes_modeled` are distinct enum values. Free to honour, and treating all
of HydroLAKES as one modelled rung would discard real measurements.

**The ladder exists because the display depends on it (D3).** Mean and max depth are shown to skaters
(founder call), and a 90 m-DEM-derived estimate must not render like a depth-sounder transect: a measured
depth reads plainly and names its source, a modelled one reads as an estimate. Without per-measurement
provenance that distinction cannot be drawn, and the honest fallback would have been to show nothing —
which would have left ~93% of the corpus blank *and* thrown away the modelled numbers that are perfectly
adequate as a decay input. Provenance is what lets one number serve both purposes at different
confidence.

**The operator rung is never overwritten by an import.** `waterBodies.importCanonical` patches an
explicit field list, so depth already survives a canonical re-import; the depth loader additionally
refuses to write over an `operator`-sourced value. *Considered and rejected:* a single `depthSource`
(dishonest, above); storing every source's value and resolving at read time (a join table for a number
almost nobody will disagree about, and it puts ladder logic on the read path); and inferring shallowness
from surface area alone (Shelburne Pond is 194 ha and about 1.5 m deep — the inference this decision
exists to stop being necessary).

## D69 — Shallowness amplifies the thaw response only, never the cold one (N6a)
**Decided (2026-07-29; founder call at N6a kickoff.)** Shallow water melts from the bottom and goes out
early, which is why D56 wanted a body-level shallow signal — but it *also* freezes earlier, because there
is less stored heat to give up. The physics points both ways, so "shallow ⇒ more weather-volatile" was a
real candidate: scale the multiplier's deviation from 1 in whichever direction it already points.

**Rejected, because its cold half is the unsafe half.** A symmetric amplifier would make cold-side
*healing* faster on small ponds — the class of body where a skater is least protected and where the
consolation "D56's never-hide bound caps it at `aging`" is doing more work than it should have to. The
conservative reading is taken instead: **shallowness scales the `thawTerm` in `weatherDecaySignal` and
never touches the `coldTerm`.**

That lands correctly in every response class without changing a sign. `refreeze_healed` subtracts its
thaw term (a thaw keeps a lead open → persist), so shallow persists harder. `structural` adds its thaw
term (a thaw can melt a ridge out → fade to prompt a recheck), so shallow prompts the recheck sooner.
`rotten` subtracts (a thaw worsens rot), so shallow keeps the warning up longer. `weather_insensitive`
is untouched at m ≡ 1. So all three of D52 §5's locked sign-flips survive by construction rather than by
test, and the never-hide bound is unmodified.

**The guarantee is directional per response class, not "further from 1"** *(corrected during the build,
2026-07-30)*. The plan stated the stronger invariant — shallowness always moves the multiplier further
from 1 — and a property test refuted it in about two seconds: in **mixed** weather where cold wins
narrowly, a deep body reads just above 1 and a shallow one just below, so the shallow multiplier lands
*closer* to 1 and on the other side of it. That crossing is **correct**, not a bug — the same period
genuinely nets "refreezing" for a deep lake and "thawing" for a shallow one, which is the entire content
of the decision. What holds absolutely is per-class: shallow `structural` ≥ deep, shallow
`refreeze_healed`/`rotten` ≤ deep, `weather_insensitive` identical, and with no thaw nothing changes for
any type. Worth recording because the weaker-sounding invariant is the one that is actually true, and a
test asserting the stronger one would have been a test asserting a misunderstanding.

**Shallowness is a boolean, and it has to be.** The manual `shallow_early_thaw` `bodyFeature` carries
no number, and it must feed the same input — a body is shallow if its depth says so **or** a local flagged
it. That flag is *permanent infrastructure*, not the stand-in the register called it: 73% of our corpus is
under 1 ha, below the floor of every global depth source, and small ponds are exactly where the shallow
signal is most predictive. Threshold: mean depth ≤ 3 m, or max depth ≤ 7 m when mean is absent (the common
case; ~0.4 is the usual mean/max ratio). Tunable numbers in the "signs locked, magnitudes refittable"
family, surfaced read-only on the Phase 7b tuning page.

*Considered and rejected:* a continuous depth curve (wants the decay-magnitude refit's corpus, and the
`bodyFeature` can't express it); and a depth-derived **freeze-up prediction** — depth plus degree-days is
the classic Ashton-style estimate, and "this pond usually takes first ice" is a prediction, not history
(D3). Same three-seasons corpus gate as hazard-recurrence promotion.

**Both thresholds are provisional, and the max one is provisional in a specific way** *(founder call,
2026-07-30)*. `SHALLOW_MEAN_DEPTH_M = 3` stays at the limnological convention — the one number here with
outside support — and moves only on real data. `SHALLOW_MAX_DEPTH_M = 7` is the **middle of a defensible
5–9 m band**, not a derived value: Hutchinson's volume development puts mean:max anywhere from ~0.33 to
~0.6, and flat shallow ponds sit at the *high* end, which makes 7 m mildly over-inclusive on its own terms.

It stays high because **the errors are asymmetric**. Shallowness only amplifies the thaw term, so a false
positive makes a `refreeze_healed`/`rotten` warning linger and prompts a ridge recheck sooner — bounded by
never-hide and the map's opacity floor — while a false negative loses the signal outright on a lake that
deserved it. Cheap error against expensive error, so the objection to over-inclusiveness becomes the
argument for it. The remaining false negative has a named shape: a broad shallow sheet with one deep hole
(mean 2 m, max 9 m) reads as not shallow, mitigated by a mean always winning when present and by the
`shallow_early_thaw` flag overriding the number entirely.

**And it gets settled with data rather than argument.** LAGOS-US DEPTH carries ~6,137 lakes with *both* a
mean and a max — a labelled set where `mean ≤ 3 m` is ground truth. **Step 6 of `scripts/lake-depth`'s
runbook** sweeps the cutoff against our own region's matched lakes, minimizing false negatives first, and
tests relative depth on the same set. That check lives in the procedure that produces the evidence, not in
a plan doc, because Phase 7b built a metric *and* an index to decide whether a cron was worth writing and
nobody pointed at either for months.

## D68 amendment — an operator depth carries its evidence, publicly (N6a)
**Decided (2026-07-30; founder call.)** The `operator` rung's public label was *"entered by a moderator"*,
which is attribution in name only — it says a human is responsible without saying what they were reading.
`setDepth` now takes an optional **`sourceNote`**, stored on the body and **shown to skaters in place of
that label**: *"Depth: NH Fish & Game bathymetry, 1998."* rather than *"Depth: entered by a moderator."*
That is the difference between a hand-entered number being trusted and being checkable, and it costs one
text field.

**Optional, not required.** A moderator who simply knows the pond has nothing to cite, and forcing the
field would produce "local knowledge" typed by rote — a citation-shaped string with no citation in it. An
absent note falls back to the generic label, which is honest: it correctly says we don't know the basis.

**One note per body, unlike the sources themselves.** Provenance is per *measurement* (D68 proper) because
mean and max routinely arrive from different datasets; a moderator reading a chart, by contrast, gets both
numbers off the same one. Free text absorbs the rare split — *"mean from the 1998 chart, max from the 2015
DEC survey"* — without a second field nobody fills.

**Two rules that keep it from lying.** The note is **cleared when no depth remains**, so a body can never
assert a 1998 chart beside numbers a global model supplied; and it is attached **only to the `operator`
rung** in the caption, so a note left behind next to a modelled value never reads as a citation for the
model's number. It also goes into the `moderationActions` reason, because the moderation log is where you
ask *"who claimed this, and on what basis"*, and a reason that omits the basis makes you go and diff the
row.

## D68 amendment 2 — an operator edits one measurement, and a rejection is durable (N6a)
**Decided (2026-07-31; N6a review, founder call.)** Two rules about *writing* rung 1, both found by
reviewing the build against D68 rather than by anything failing.

**A moderator's save touches only what they touched.** `setDepth` originally took a plain number per
measurement and stamped `operator` on everything it received, while the editor pre-filled both fields
from the row — so saving a max you knew relabelled the HydroLAKES mean beside it as a survey reading. The
skater-facing caption lost its `~`, and the value became immune to correction by any future import. The
value of provenance is entirely in its being *true*, so a write path that can silently falsify it is worse
than no provenance field at all. Each measurement is now three-state: **absent** leaves the value and its
rung alone, **a number** is the moderator's reading, and **`null`** is a rejection.

**A rejection keeps the rung.** When a moderator clears an imported depth, the number goes and the
`operator` rung **stays** as a tombstone, which is what stops the next ETL run from putting it back.
*"A human read HydroLAKES' 14 m and says it's wrong"* is a durable claim about the lake; if it evaporates
on the next run it was never worth making. This inverts D68's original *never provenance without a
number*, deliberately — that rule was protecting the **caption**, and it still does, because
`describeLakeDepth` renders nothing without a number. A tombstone is therefore invisible to skaters and
legible to the ladder, which is the split we want. It is reversible (`clearDepthOverride`), and the
loader reports it separately from "already had a better source" so the person running an import sees the
collision rather than inferring it from a count.

**Related:** [D68](#d68--depth-is-a-best-available-number-that-carries-its-provenance-n6a), [D3](#d3),
[`phase-N6a`](./phase-N6a-lake-depth.md).

## D70 — Lake-profile content is derived or third-party, never hand-maintained (N6c/N6d)

**Decided (2026-07-30; founder call at N6c scoping.)** Every field in the expanded lake profile must come
from geometry we already store, an ETL source, a user report, or a URL template. **Hand-written per-lake
prose and hand-maintained per-lake notes are out of scope.**

**Because the alternative has a known failure mode, and we can watch it happen.** The clearest example in
our own region is Christopher Boone's **Catamount Hardware Ice Atlas**
(<https://catamounthardware.com/ice/>), surveyed 2026-07-30 — and it should be said plainly that it is
*good*: 36 hand-picked NH and VT bodies, each with coordinates, elevation, surface area, dimensions, mean
and max depth, individually named launches with their parking and facilities, and a curated set of
external references. **Several ideas in N6c and N6d are lifted straight from what it chose to record** —
elevation as a first-class field, per-lake reference links, tying depth to freeze behaviour in prose, and
naming put-ins by compass side. It is also the source of the sharpest one-line framing of D3 any of us has
written: *"This site tells you where to find ice, not whether it is safe."*

**And its public update log runs 21 Dec 2023 → 3 Feb 2024, then stops.** One winter. That is not a
criticism of the author — it is the structural cost of the model. Hand-curation puts the maintenance
burden on one person every season, and the burden never shrinks, so the failure mode is not that the
content becomes *wrong* but that it becomes **unfalsifiable**: the write-ups are all still there, still
plausible, and nobody can tell which sentences are still true. A launch description from 2023 looks
exactly like one from last week.

That is the failure we are designing against, and the reason is not that we would be more diligent. **We
would not be.** The only durable answer is that no sentence on our lake pages should require a human to
keep it true.

The second reason is arithmetic. Curation scales to the ~36 bodies someone cares enough to write about.
**We have 116,070.** Anything requiring a human per body is a feature for 0.03% of the corpus that *looks*
like a feature for all of it — which is worse than not having it, because a skater cannot tell which lakes
got the treatment.

**What this rules in.** Depth (N6a), elevation, long axis, shoreline length and wind fetch are all derived
from a polygon or one free lookup. Access points come from OSM (D72). Access blockers come from skaters
and expire (D73). The lake caption is *generated* from those numbers against per-state deciles — so the
prose is ours, it exists for every body that has the inputs, and no sentence can outlive the number it was
built from.

**What it rules out, specifically:** free-text lake descriptions, free-text seasonal access notes, per-body
archival photos, and any "we'll fill these in as we go" field. *Considered:* letting moderators write
descriptions for the top ~50 bodies. Rejected — that is precisely the 0.03% feature, and once the field
exists nothing stops it filling with text nobody dates or re-reads.

**One deliberate exception, and it proves the rule:** the local lake-association URL (D71), because there
is no algorithm from a lake's name to its association's website.

## D2 amendment — profile-richness weights are fractions of the score, and activity dominates (N6c-1)

**Decided (2026-08-02; the weights were caught by reading `display.ts`, the ordering by a founder
call.)**

N6c's Workstream D2 tabled prominence weights of **+1** for a name, **+2** for contours, **+4** for
an official put-in — summing to +13. **That is roughly thirteen times the score's entire dynamic
range.** `displayScore` is `normalize(log area) ∈ [0,1] + curatedBoost`, and `minVisibleZoom` clamps
the total to `[0,1]` before mapping it onto z14→z6. Measured on dev: **every** curated boost is
exactly `0.3`, and boosted bodies score 0.75–1.30. A `+1` for having a name would have pushed all
~9,000 named bodies to the widest zoom bucket — and nothing would have failed, because no test
asserts what the map looks like.

The weights are therefore the plan's **relative ordering on the real scale**: name `0.02`, depth
`0.04`, contours `0.06`, derived put-in `0.06`, official put-in `0.12`, activity `0.30`. One zoom
level is `0.125`, which is the unit these should be read in.

**Activity dominates, and the caps encode why** (founder call):

> *"I would love for the real-world data of users documenting lakes well… to completely remove the
> need for moderators to hand-curate 'destination' lakes. Curation should exist only as a way to get
> us a good seed, and as a check on our automated system."*

So static metadata caps at **0.15**, *below* `curatedBoost`'s 0.3 — metadata says a body is
documented, not that anyone wants to skate it — while activity alone reaches 0.30 and the total caps
at **0.40**, above it. A genuinely used lake overtakes a hand-seeded one.

**And the retirement path becomes a mechanism**: `curatedBoostIsRedundant` flags a boost the body has
now earned on its own, for the admin surface. **Advisory, never automatic** — clearing a boost on a
body's behalf is a silent prominence change nobody reviewed, and a check that removes itself is not a
check.

**Never a penalty**, which D2 already said and which is now an invariant: an un-enriched body scores
byte-identically to before, and a property test asserts enrichment never moves a body to a *narrower*
zoom bucket. That is the founder's *"I'd hate to not have a body someone cares about"*, mechanised.

**`hasContours` ships live** (founder call, 2026-08-02), via a `bathymetryCoverage` side table keyed
on `externalId` rather than a column on `waterBodies`: coverage is a property of the **tileset**, so
re-tiling replaces ~2,000 rows instead of migrating 116,070, and a dropped lake cannot leave a stale
flag claiming a survey we no longer draw. It records the **2,022** bodies that produced a visible
contour line, not the 2,437 the join merely matched. **The put-in terms still wait on N6d.**

**Related:** [D49](#d49), [D70](#d70--lake-profile-content-is-derived-or-third-party-never-hand-maintained-n6cn6d), [`phase-N6c`](./phase-N6c-expanded-lake-profiles.md).

## D71 — Reference links are generated at render time, not stored per body (N6c)

**Decided (2026-07-30; founder call at N6c scoping — the founder asked whether the ETL could configure
these links for all 116,070 bodies, and this is the answer that actually delivers that.)**

Every outbound reference link — satellite imagery, weather, regional community search, mapping — is a
**pure function of `(centroid, name, states[])`**, all three already on the row. So they are computed in
`@skating/core` at render time and **stored nowhere**.

**This is the version that covers the whole corpus.** Storing them would mean 116,070 rows of derivable
strings, a migration to add them, a backfill to populate them, and a re-backfill every time a provider
changes a query parameter. Generating them means **full coverage on day one**, automatic coverage for
every body imported later, and a provider format change costing one function edit instead of a corpus
rewrite. The stored version is more work for a strictly worse result.

**Corollary — P2: a link is not an integration.** A URL template costs no storage, no quota, no licence and
no legal review. This is what lets the regional-community link ship *now* while forum ingestion stays
behind the Q8/L5 legal gate: the gate is about **republication and consent**, and a link republishes
nothing — the skater arrives at the community's own site under the community's own terms. It is the 5% of
the ingestion feature carrying 0% of its risk.

**The one exception, stored because it cannot be derived:** `referenceLinks[]` on `waterBodies` for local
lake associations. Expect tens of bodies, not thousands. Operator-editable, preserved across re-import
like `curatedBoost`.

## D72 — Parking is modelled apart from put-ins, and directions route to the car (N6d)

**Decided (2026-07-30; founder call.)** `putIns` was one coordinate, and `directionsUrl` sent a car to it.
For a drive-up launch that's right; **for a hike-in pond we hand a maps app a destination it cannot route
to**, and the skater discovers this at the trailhead, in winter, an hour from home.

So: a new **`parkingAreas`** table (coord, name, amenities, source, status); `putIns` gains
`name` / `parkingAreaId` / `approachMeters` / `approachKind`; and **directions target the parking area when
one exists, else the put-in**. `directionsUrl` itself is unchanged — only its call sites get smarter.

**Additive, deliberately.** *Considered and rejected:* generalizing `putIns` into an `accessPoints` table
with a `kind` discriminator. Cleaner on paper, but `putIns` is load-bearing across drive-time bands, the
notification fan-out, N3 deletion and the Phase 5 feed — a metadata phase should not put five other systems
on its critical path for a modelling nicety.

**Names come from OSM, and that is the whole reason this scales.** "Lake Fairlee Boat Ramp" *is* an OSM
`leisure=slipway` with a `name` tag; so are fishing access areas, town beaches and trailhead lots. A second
`osmium tags-filter` pass over the *same* Geofabrik extract we already download yields named put-ins,
parking, toilets and trails corpus-wide, with **no new source, no new download, no new account**. Where OSM
has no name, a **deterministic compass-side label** ("North launch") is derived from the point's bearing off
the centroid — re-derivable on every import, never drifting, and matching how skaters already talk about a
lake's ends.

Derived rows sit on an **`osm` rung below `official`** and never overwrite an operator-set point — the same
precedence discipline as the N6a depth ladder. **Amenity scope:** toilets, trails, parking, boat ramp (kept
for the ice-fishing crossover, and free because it's the same tag we read to find put-ins). Food excluded —
everyone has a maps app for restaurants, and it's the amenity most likely to be wrong.

**Coverage will be patchy** in the rural Northeast, and that must not become an argument for hand-entering
the rest (D70). It is strictly more than the zero we have now.

## D73 — An access blocker is a decaying community alert, not a note (N6d)

**Decided (2026-07-30; founder call.)** *"Road closed south of the gate until repairs are done"* is the most
useful sentence on a lake page and the one most certain to be wrong. It is correct the day it's written and
stale by spring, and **nothing in the system knows the difference**.

So access blockers are modelled on hazards, not on text: an **`accessAlerts`** row against a put-in or
parking area with a typed reason (`road_closed`, `gate_locked`, `not_plowed`, `lot_full`,
`private_no_access`, `other`), confirmed or refuted by other skaters through the Phase 9 confirm/deny
machinery (`pointEvents`, `by_ref`), including N5b's *"never existed"* retraction (D65).

**Decay is weather-insensitive, and this is the part most likely to be got wrong.** The instinct will be to
reuse `HAZARD_DECAY` wholesale. **A locked gate does not thaw.** Applying the D56 weather multiplier would
let a warm week silently expire a road closure — a failure that looks like normal decay and is invisible in
review. So: a plain ~30-day TTL, extended by confirmation, with **no weather term at all**.

**Hard-expires at the N5a season boundary.** Closures often span seasons, but an alert must never outlive
its evidence; the map starts each winter clean and the community re-establishes what's true, which is also
the cheapest possible re-survey. **Never hides the put-in** (the hazards never-hide invariant) — it
annotates and de-prioritizes for directions. Moderators may pin an `official` alert that doesn't decay, the
analogue of an official put-in.

## D74 — One weather physics source; NWS alerts are an advisory layer that never feeds a calculation (N6c)

**Decided (2026-07-30; founder call.)** **Open-Meteo remains the single source for anything that feeds a
calculation** — forecast plus the `past_days` history the D56 decay math runs on. **NWS
(`api.weather.gov`) is added** for what it uniquely has: official winter-storm, ice-storm and wind-chill
**alerts** from the local forecast office. Free, no API key, US-only, one `User-Agent` header.

**Do not blend them.** Two providers disagreeing yields a *worse* number, not a better one, and averaging
them would silently break the reproducibility of hazard decay — which depends on one deterministic input
that can be re-fetched and re-derived. A decay multiplier you cannot reproduce is one you cannot debug or
refit, and the refit is already on the roadmap.

So the boundary is sharp: **Open-Meteo computes; NWS informs.** Alerts render as a labelled, attributed
advisory strip and never enter a formula. Polled **per state on a cron** (alerts are issued over
counties/zones, so one state fetch serves every body in it) — keeping read cost independent of corpus size,
the `listInViewport` lesson applied before it can bite.

*Considered and rejected:* **MerrySky**, which is a frontend over Pirate Weather and Open-Meteo — the same
data we already pull, with a nicer UI and no API to buy. Recorded because it looked like a third source and
isn't one.

**Coverage gap:** US-only. A Québec expansion needs Environment Canada, a different API on different terms.

## D75 — Satellite imagery ships as a link first; the licence blocker is resolved, the cost one isn't (N6c)

**Decided (2026-07-30; founder call.)** The roadmap parked a satellite-imagery layer as *"needs design — and
it needs an imagery source whose terms permit the use."* **The terms question is now answered:** Copernicus
Sentinel data is under the free, full and open Copernicus licence — reproduce, distribute and adapt, with
attribution. What remains is cost, not permission.

**Tier 1, now: a Copernicus Browser deep link.** Centroid, zoom, Sentinel-2 L2A true colour, ~14-day window.
No account, no quota, no licence question. At 10 m with a ~5-day revisit the difference between open water,
black ice and snow-covered ice is visually obvious; cloud cover is the real limiter, which is why the link
opens a *window* rather than a date.

**Availability is derived, not curated (D70).** 10 m pixels cannot resolve a 2-hectare pond, so
`satelliteImagery: 'auto' | 'on' | 'off'` defaults to `auto`, resolved against a surface-area threshold,
with operator overrides for the exceptions. Worth noting for the Phase 7 posture: **this toggle needs no
redeploy** — "constants stay in code" governs *constants*, and per-row data edits through the lake editor
and takes effect immediately. The threshold driving `auto` is the constant; the per-lake override is data.

**Tier 2, deferred with a trigger: imagery in the app.** The Copernicus Data Space free tier is **10,000
requests + 10,000 processing units/month, 300/min**; a full-screen tile view is ~10–20 requests, so raw
that's ~500–1,000 lake views/month. **Server-side tile caching is what makes it viable** — the open licence
permits it, and a body only needs re-fetching once per ~5-day revisit. **Do this when** we know which bodies
get real traffic, since caching only wins if reads concentrate.

**Planet: waited on, not rejected.** Their public catalogue (Sentinel, Landsat, HLS, Copernicus DEM) is the
*same free data*; paying buys **PlanetScope — ~3 m, near-daily**, which is a real difference for ice, since a
lake can go from open to skateable in 48 hours and a 5-day revisit can miss the whole onset. Against that:
quote-based commercial pricing, a pilot with no revenue, and **no evidence yet that anyone opens the imagery
link at all**. Low-regret detail — Planet serves public data from Sentinel Hub endpoints, the same API
surface as Copernicus, so building against Copernicus now is not a lock-out. **Trigger:** real usage of the
free link **and** a case where the 5-day revisit demonstrably missed a freeze event.

**Windy: declined on technical grounds, not price.** Their Map Forecast API is *"a library based on Leaflet
1.4.x"* and tightly coupled to it; **we render MapLibre**, so there is no overlay path — €990/year would buy
a second map engine, not a layer. Their free tiers are unusable anyway (dev-only; the point API returns
deliberately shuffled data). We link out instead (D76), which delivers the same skater-facing result for €0.
Full numbers in [`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md).

## D76 — External links open in an in-app browser on mobile, never a WebView (N6c)

**Decided (2026-07-30; founder call.)** Linking out is fine on desktop; on mobile a skater must not be
ejected into Safari and left to find their way back. So every outbound reference link opens via
**`expo-web-browser`'s `openBrowserAsync`** — SFSafariViewController on iOS, Chrome Custom Tabs on Android:
the page opens *over* our app with a Done button and returns the skater exactly where they were.

**Not a `WebView`, and the reason is legal before it is technical.** Rendering a third-party page inside our
own chrome **frames someone else's site inside our UI**, which many providers' terms prohibit outright. An
in-app browser is unambiguously *a browser* — the provider keeps its URL bar, its branding and its terms, and
there is no framing question to lose. A WebView would also inherit auth walls, cookie banners and consent
flows with none of the system browser's handling for them, for more code and more surface.

**Rule:** a `WebView` is only for content we are licensed to embed (a provider's own documented embed
widget). Everything else goes through the in-app browser; web stays a plain new tab.

**One deliberate exception:** **directions**. `directionsUrl` keeps handing off to the real maps app, because
navigation belongs there — a skater wants turn-by-turn on their lock screen, not a browser tab inside a
skating app.

## D77 — Hazard identity is one clustering primitive read through two time windows (N5c)

**Decided (2026-07-30; founder call at N5c scoping.)** *"Are these the same ridge?"* within a winter and
*"is this the ridge that forms here every winter?"* across winters are the **same geometric judgement**
with a different time bound and a different tolerance. So there is **one** `clusterHazards` function in
`@skating/core`, with two callers and two constant sets:

| | Within-season (duplicates) | Cross-season (recurrence) |
|---|---|---|
| Tolerance | `DUPLICATE_MATCH_METERS` = 25 | `RECURRENCE_MATCH_METERS` = 80 |
| Families | all six | five (the four promotable, plus `volatile` at D78's raised bar) |
| Computed | **at read time** in `hazards.listForBody` | **by a job**, stored in `hazardRecurrence` |

**Matching is footprint-to-footprint, never centroid-to-centroid.** A `pressure_ridge` is a `LineString`
with a buffer that often spans a bay; two ridges overlapping along different segments can have centroids
400 m apart while sharing 300 m of geometry. The tolerance is therefore a **gap**, which makes 80 m a far
tighter claim on a 600 m ridge than "centres within 80 m" would be.

**The tolerances differ in that direction deliberately.** Within a season, two pins 80 m apart may be two
different leads and collapsing them would under-warn; across seasons a ridge re-forming within 80 m *is*
the same feature, because ice does not reassemble to the metre. **Tight for identity, loose for
recurrence.**

**One is derived and one is stored, and that asymmetry is about read bounds, not taste.**
`listForBody` already collects all of a body's active hazards in one bounded read (Phase 9's call 6), so
within-season clustering is free there and can never go stale. The cross-season read is the opposite:
`hazards` has no time index and never ages out — `listPromotionCandidates` had to be capped at 500 rows
mid-review for exactly that reason — so recurrence is precomputed at the season rollover.

**A season contributes at most one observation.** Three skaters pinning the same ridge in one January is
**one** winter of evidence. `seasonsObserved` is a set keyed on `seasonOf(firstReportedAt)`, the clock
nobody can move (D63). Without this, one enthusiastic week becomes "a pattern".

**Why:** building the two separately guarantees they drift into disagreeing about what "the same ridge"
means — this repo already has that scar, in the hazard verdict vocabulary written down in four places
where only three were updated for D65.

> **Built 2026-07-31.** One `clusterHazards`, four callers — the map read, the draw-time nudge, the
> auto-merge bar and the recurrence job — so the primitive earned its keep beyond the two windows this
> decision names. Two guards had to be rebuilt during the build and the corrections are recorded in
> N5c §15.1: the chaining guard is **relative to the largest member** rather than an absolute span (any
> absolute cap tight enough to stop chaining refuses to merge two pins of one 600 m ridge), and it is
> compared **per axis** rather than on a diagonal (two crossing ridges overlap, and a diagonal measure
> refuses them purely because they point different ways).

## D78 — A recurrence claim is history with its denominator attached, and it is admin-only until it clears a tunable bar (N5c)

**Decided (2026-07-30; founder call.)** The corpus gate the roadmap set — three seasons of in-app hazard
rows — cannot fire before roughly 2029, and dev holds **one** hazard row today. Rather than defer, the
engine is built now and **thin patterns stay inside `/admin`**:

- **Operators see everything** from the first winter, including a 1-of-1 cluster. Patterns can be watched
  forming, and the public bar gets set from evidence instead of a guess.
- **Skaters see nothing** until `RECURRENCE_ADVISORIES_PUBLIC` is on **and** the cluster clears
  `RECURRENCE_PUBLIC_MIN_SEASONS` (start **2** of the last 4; raise to 3 if it reads noisy). The same
  constant gates the *timing window* ("late December to February"), so the two can never be set to
  disagree and a raise makes both claims more conservative together.
- **`publiclyVisible` is stored on the row, not filtered client-side** — otherwise "admin-only" means
  "admin-only if you don't open the network tab".

**The claim itself is bounded by D3.** Every public advisory carries **both** numbers ("3 of the last 4
winters", never "most winters"), is written in the past tense with a reporter ("skaters have reported…",
never "there is…"), has no confirm loop, no decay, no pin and no halo, and **never enters the on-ice
payload** — a statement about past winters must not become a live warning about ice underfoot. It also
never feeds `displayScore` (D49), trust, points or the bounty gate.

**The `volatile` family is the one raised bar.** Recurring `thin_ice` / `open_water` / `thawed_rotten`
may propose a **`shallow_early_thaw`** feature, because a spot that goes out early *every* March is a
property of the lake bed rather than of the weather — but only at **3 seasons minimum regardless of the
public constant**, and only where N6a's depth (D68/D69) does not contradict it. Recurrence is how that
flag finally gets *proposed* from observation; depth is how the proposal gets *checked*.

**Why:** the D3 trap is showing a skater a one-winter coincidence dressed as a pattern — which the gate
prevents. Deferring the machinery would instead mean three winters of rows nobody ever looked at as a
series, and a matching radius tuned from scratch in 2029.

> **Built 2026-07-31, shipped dark.** `RECURRENCE_ADVISORIES_PUBLIC` is `false`, so the public read
> returns an empty list whatever the corpus holds and the whole engine feeds `/admin/recurrence` and
> nothing else — the intended state, not an unfinished one. Two build-time corrections worth carrying
> here: the advisory names a **family** rather than a hazard type (a cluster can hold a `pressure_ridge`
> and an `ice_heave`, so naming one would report a detail the record does not carry), and the timing
> clause reads *"first reported late December to February"* rather than *"between…"*, because the label
> collapses a fully-covered month to its bare name and "between January" is not a sentence.

## D79 — A moderator can author a body feature directly, not only promote a hazard into one (N5c)

**Decided (2026-07-30; founder call.)** `bodyFeatures.create` has existed since Phase 9 and has **no UI
anywhere** — `/admin/features` is list-and-demote only — so the only way to hand-create a permanent
feature today is the Convex dashboard or the CLI. Consequently **four of the nine `BODY_FEATURE_TYPES`**
(`constriction`, `bridge_narrows`, `delta`, `shallow_early_thaw`) are unreachable in the product: no
hazard promotes into them and no form creates them.

N5c ships the authoring surface on `/admin/water/$id`, drawing on the lake's own map and reusing N5b's
web authoring (terra-draw, the same primitives hazards use). Web only — `/admin` is a web tree and
terra-draw has no React Native adapter.

**Why:** it is also the answer to "what covers the first three winters". An operator who *knows* a lake
has a spring at the outlet shouldn't wait for the corpus to prove it; the recurrence engine is for the
lakes nobody on the team skates.

## D80 — Duplicate hazards are consensus, not clutter: prevent, pool, render, and merge reversibly (N5c)

**Decided (2026-07-30; founder call.)** Today duplicates stack. The only dedup anywhere is
`idempotencyKey`, which protects one device's offline retry; two people marking the same ridge produce
two rows, two overlapping halos, two list entries and two independent confirm loops.

**The correction to the intuition, worth recording because it is the opposite of what it looks like:**
splitting confirmations does **not** make hazards fade away. There is no time-based archival at all, and
the map opacity **floor** is deliberate — absence of evidence *keeps a hazard alive* (D3). What splitting
actually costs is: the on-ice alert never escalates from the soft `confirm_request` to `warning`; a
`ridge_crossing` **genuinely expires** at `PASSAGE_EXPIRY_H` off its own `lastConfirmedAt` (D64 — the one
pin that leaves the map on time alone, so splitting *deletes* rather than dims); the freshness clock
under-reports what the community knows; and retirement takes two `fully_healed` votes **per duplicate**.

Four layers, cheapest first:

1. **Prevent** — at draw time, a footprint within `DUPLICATE_MATCH_METERS` of a live same-family hazard
   offers *"confirm that one"* as the primary action, with "no, this is a different hazard" one tap away.
   **Never a hard block**: a skater standing on ice looking at something the map has wrong must not be
   argued with. Costs nothing on the server (both clients already hold the body's hazards) and works
   offline, which is where duplicates are most likely.
2. **Pool** — every gate that *decides* something reads **distinct confirming users across the cluster**
   rather than the row: alert escalation, freshness, corroboration credit. **Archival stays per-row,
   deliberately** — pooling "gone" votes would let two people clearing one pin retire an unexamined
   neighbour, which is pooling in the unsafe direction. *Pool the evidence a hazard is there; never the
   evidence it is gone.*
3. **Render** — overlapping same-family pins draw as one **union** footprint, opening to every reporter
   and every confirmation. A consensus footprint is never smaller than any member, so it can only warn
   about more area, never less.
4. **Auto-merge above a high bar** — same family, footprints genuinely **overlapping** (not merely near),
   IoU ≥ `AUTOMERGE_MIN_FOOTPRINT_IOU`, same season, not a passage marker, nothing already merged,
   promoted or moderator-hidden. **No time-window condition:** a ridge marked in December and
   independently marked again in February is the same ridge, and that second reporter is exactly the
   corroboration it was missing.

**Auto-merge is built on D36's water-body merge pattern**, which is what makes automating it acceptable:
the loser is **tombstoned, not deleted** (`mergedIntoHazardId` + a hop-capped `resolveHazardSurvivor`,
mirroring `resolveSurvivor`), the survivor is the **earliest** `firstReportedAt`, and a moderator
`unmerge` restores both pins intact. **Confirmations are never re-pointed** — D65 names confirmers
publicly, so a confirmation is a named person's statement about a *specific* pin, and rewriting its
`hazardId` would edit that statement; the chain is read *through* instead.

**The residual risk, stated plainly:** a wrong merge costs a distinct hazard its separate identity — the
one failure here a skater cannot undo. It is bounded by the union footprint (a merge can never shrink
warned area), by archival staying per-row, and by an admin panel plus an **unmerge-rate chart**, which is
the only empirical test of whether the bar is set right.

## D53 amendment (2026-07-30, N5c) — supersession is a backlink, not a hiding mechanism; and `shallow_bay_early_thaw` → `shallow_early_thaw`

**Founder call at N5c scoping**, in these words: *"A hazard from previous seasons that has been promoted
should still be visible as a reported hazard in all years in which it was reported. A recurring feature
is a pattern, not a real marker — so even in seasons after it's been promoted, users will still report
it."*

That names the seam better than D53 did: **a `bodyFeature` is a standing statement about the lake; a
hazard is a sighting by a person on a date.** Promotion adds the first; it must not delete the second, in
any season, past or future.

D53 as shipped does delete it. `hazards.listForBody` filters out every row with `promotedToFeatureId`
set, across all seasons, and `isUserVisibleHazard` additionally makes a promoted hazard unreachable by
permalink and unconfirmable — so a promotion silently rewrites February 2027 as a month in which nobody
reported a ridge. Under one-hazard promotion that was a small distortion; under N5c's *cluster* promotion
it would erase the whole evidence trail the advisory rests on, one click after an operator agreed it was
real.

**So `promotedToFeatureId` becomes pure provenance.** It stops hiding, stops blocking permalinks, and
stops blocking confirmation. Three consequences:

- **New sightings keep arriving and keep counting**, so a promoted cluster goes on growing and its
  denominator goes on meaning something after promotion.
- **Confirmation still works on the sighting** — *"the ridge is here right now"* is a different statement
  from *"ridges form here"*, and only the first is confirmable.
- **The two never race.** After a season boundary the sighting is hidden by the **season** axis (D63) and
  the feature remains — the desired end state, reached by machinery that already exists. Double-rendering
  is confined to the season of promotion, and the drawer carries one line — *"this spot is also marked as
  a recurring feature"* — so it reads as one story. Features and hazards are already separate map sources
  with distinct styling, so nothing else needs building.

`listPromotionCandidates` is the one reader that keeps filtering on the field: an already-promoted hazard
is genuinely finished *as a suggestion*.

**The rename.** `shallow_bay_early_thaw` → **`shallow_early_thaw`** (founder call, same day): there is no
guarantee the spot is a bay — it may be an island's lee, a sandbar, a reef or a shallow delta — and the
old name narrows the type to one of its cases. **Free today and never again:** dev holds zero
`bodyFeatures` rows, so this is a find-and-replace with no migration, which is the argument for doing it
inside N5c rather than "later".

> ⚠ **The reviewer's diff for this amendment is *every reader of `promotedToFeatureId`***, not just the
> new ones. N5a's review pass named the pattern for a value being *widened*; this is the same hazard from
> the other direction — a value being **narrowed** in meaning, landing on code that was right about the
> broader version.

## D81 — The map has exactly one layer toggle, and it is satellite (N6b/N6e)

**Decided (2026-07-31; founder call answering N6b's open questions 2 and 3, and N6c's satellite ask.)**

Two halves, decided together because they are the same rule seen from either side:

**Contours are a property of the detail view, not a layer the user manages.** When a body's drawer is
open, its bathymetric contours are drawn. When it isn't, they aren't. There is no contour toggle.

**Satellite replaces the base map, not the content.** The one switch swaps the cartographic base —
vector basemap ↔ aerial/satellite raster — and takes contours and water-body fills with it. **Hazards,
skate paths, put-ins and parking stay drawn in both modes.**

**Because the toggle N6b proposed would have been a control for a question the user doesn't have.** A
skater does not arrive at the map wanting to *decide about contours*; they want to look at a lake. Making
the layer follow the thing they already did — opening a body — gets the contours in front of them at the
only moment they're useful, with no affordance to find, no state to persist, and no settings row.

**What this dissolves rather than answers.** N6b's Q2 asked how contours interact with `minVisibleZoom`
and D49 prominence on the browse map. Under D81 contours are *never on the browse map*, so the question
stops existing. Q3 asked whether the toggle is per-session or persisted, and whether it shares an
affordance with satellite — also gone, because there is only one toggle left to persist. **Two open
questions closed by removing a control**, which is the shape of most good simplifications.

**The content/chrome line is the load-bearing part of the second half.** Everything we author or receive
— a hazard someone reported, a track someone skated, a launch someone found — survives the swap.
Everything we drew to help you read the map — fills, outlines, contours — is what the photograph replaces.
A skater who turns on imagery to check a put-in must not lose the hazard pins doing it; that would be a
safety regression delivered by a display preference.

**Consequences to hold:**
- Contour tiles load lazily on drawer-open, so the browse map's tile budget is unchanged.
- Contours are not drawn over imagery — no cartographic base to annotate, and they'd fight a photograph
  for legibility.
- The satellite preference is per-device and persisted, default off (N6e A5). It is the map's **only**
  persisted display state.

**Related:** [D82](#d82--bathymetry-is-context-not-counsel-n6b), [D84](#d84--satellite-imagery-is-two-tiers-with-different-jobs-n6e),
[`phase-N6b`](./phase-N6b-bathymetry-layer.md), [`phase-N6e`](./phase-N6e-satellite-imagery.md).

## D82 — Bathymetry is context, not counsel (N6b)

**Decided (2026-07-31; founder call answering N6b's open question 4 — *"the lines are more for the
aesthetic… we don't have to tell the users anything about the safety or lack thereof with any copy."*)**

**Depth's safety role stays inside the math.** It feeds the D56/D69 decay multiplier, adjusting how fast a
hazard's confidence fades — a computation the skater never reads. **The rendered contour layer carries no
interpretive copy at all.**

**Because saying nothing is strictly safer than saying it carefully, and this is a case where we can.**
N6b called the copy *"the hardest part"*: bathymetry is not ice thickness, and the naïve reading
("shallow = safer") **reverses across the season** — shallow water takes first ice, and shallow water
rots out first. Every careful phrasing of that is still a sentence a skater can act on in the moment they
are deciding whether to drive, which is what **D3** says is not ours to offer. The line we can hold
absolutely is the one with no copy behind it.

**What this settles in the styling**, because a decision like this leaks into pixels:
- **Hazards render above contours.** Contours are decoration; hazards are the product. On any conflict,
  the contour loses — thinner, muted, lower opacity.
- **The contour palette must not resemble the hazard palette.** A blue-to-navy depth ramp a skater could
  read as a severity scale would reintroduce through colour exactly the claim we just declined to make in
  words. This is the one styling rule here that carries real weight.
- **The only copy that remains is provenance** — which agency surveyed this, at what interval (D83).
  Attribution, not interpretation.

**A useful side effect:** because contours make no claim, a lake with no survey data costs the skater
nothing — it renders as a flat shape, exactly as today. So Maine's density gate and every other
coverage gate can be set conservatively with no product argument pushing back.

**Related:** [D3](#d3), [D52](#d52), [D81](#d81--the-map-has-exactly-one-layer-toggle-and-it-is-satellite-n6bn6e), [D68/D69](#d68), [`phase-N6b`](./phase-N6b-bathymetry-layer.md).

## D83 — Contours carry their source's native interval and units, labelled; we never resample (N6b)

**Decided (2026-07-31; founder call — *"we shouldn't invent lines that we don't have true data for. Let's
use the units we're given."*)**

NH and MA publish isobaths in **feet**, VT in metres, at different intervals. We tile each state at its
native interval and unit and label it — *"NH GRANIT, 10 ft contours"* — rather than retiling everything to
a common interval.

**Because resampling a survey's contours means drawing isobaths nobody surveyed**, rendered identically to
the ones that were. That is the GLOBathy error at a smaller scale, and N6b exists as a document because we
refused it once already at the dataset level; refusing it again at the interval level is the same
principle, not a new one.

**The cost, accepted knowingly:** contour spacing visibly changes at a state line. That is honest — the
surveys *are* different — but it puts weight on the label, which has to be legible rather than a footnote.

**The related normalization we do keep:** the vertical-datum rule stands regardless. Lake Champlain
(NGVD 1929) and VT ANR (pool elevation at collection) share no reference, so styling reads
**depth-below-surface**, never absolute elevation, and sources are never silently unioned into one
styled-by-depth ramp. Native intervals make that easier to hold — each set already renders as its own
labelled thing.

**The revisit has a trigger, not a date:** a cross-state comparison surface ("the deepest lakes within 90
minutes") would need common units, and should convert **at read time** from stored native values. The
tiles stay native permanently.

*(A founder aside worth recording because the intuition recurs: 16 fetch bearings were questioned against
18 because 18 "divides evenly into 360°." So does 16 — into 22.5°. Every integer divisor divides evenly;
16 just lands on a fraction, which is nothing to a float. 16 wins because it *is* the compass points, so
every bucket has the name the wind data already uses. See N6c open question 1.)*

**Related:** [D81](#d81--the-map-has-exactly-one-layer-toggle-and-it-is-satellite-n6bn6e), [D82](#d82--bathymetry-is-context-not-counsel-n6b), [`phase-N6b`](./phase-N6b-bathymetry-layer.md).

## D84 — Satellite imagery is two tiers with different jobs (N6e)

**Decided (2026-07-31; scoping N6e out of N6c's B3 at the founder's ask.)**

The word "satellite" was covering two features with different sources, different constraints and different
honesty requirements. They ship in order:

- **Tier 1 — aerial base map.** USGS/NAIP orthoimagery, ~0.6 m, **public domain, no key, no quota**,
  refreshed every 2–3 years, leaf-on summer. Answers *where's the pull-off, where's the point, is that an
  island*. **Ships in v1.**
- **Tier 2 — recent ice imagery.** Sentinel-2 L2A via Copernicus, 10 m, ~5-day revisit, free tier of
  10,000 requests/month. Answers *is there ice on it right now*. **Gated on evidence that reads
  concentrate**, because it only fits the quota with server-side caching and caching only wins if they do.

**Because the quota that deferred in-app imagery is a Sentinel-2 quota, and it says nothing about NAIP.**
The high-frequency use case — read the landscape, find the access — is served *better* by 0.6 m summer
aerial than by 10 m winter Sentinel-2, **and** it is the unconstrained one. Splitting the tiers turns
"blocked on cost" into "ship the valuable half now."

**The second reason is honesty, and it's the one that would have bitten us.** A Sentinel-2 view is a
**dated observation** — a specific pass on a specific day, possibly under cloud — not a base map. Rendered
in the same affordance as a base map, without its date foregrounded, it invites *"the lake looked frozen
in the picture"* about an image from eleven days ago. That is the **D3** trap in raster form. Tier 2's
date stamp is not a caption detail; it is the content, which is also why N6e open question 4 asks whether
Tier 2 belongs in the drawer rather than on the map at all.

**Unchanged by this:** **D75** — the Copernicus Browser deep link ships in N6c regardless, covers all
116,070 bodies at zero cost, and remains the right answer for historical browsing and a date slider. This
decision is the second step of that two-step, not a replacement for it.

**Related:** [D75](#d75--satellite-imagery-ships-as-a-link-first-the-licence-blocker-is-resolved-the-cost-one-isnt-n6c), [D81](#d81--the-map-has-exactly-one-layer-toggle-and-it-is-satellite-n6bn6e), [`phase-N6e`](./phase-N6e-satellite-imagery.md).

## D85 — Derived geometry stats are measured on the source geometry, not the simplified copy (N6c)

**Decided (2026-07-31; founder asked whether there was a better source for shoreline length — *"maybe
we're looking at the wrong source for this."*)**

`shorelineM`, `longAxisM` and `shortAxisM` are computed in the ETL transform from the **full-resolution
OSM geometry**, immediately before `simplify()` runs — not from the Douglas–Peucker-simplified polygon we
store.

**Because the wrong source wasn't a provider, it was our own copy.** Perimeter is resolution-dependent
(the coastline paradox), our stored polygons are simplified to ~5 m, and Lake Champlain is coarsened
further to fit the D48 8,192-element array cap. Measuring the stored polygon systematically under-reports,
and worst on exactly the large crenellated lakes where the number is most interesting. Measuring before
simplification removes that error entirely for the cost of one scalar — the array cap constrains what we
*store as geometry*, not what we *measure in flight*.

> **The general rule: the stored polygon exists for drawing; the stats exist for describing. The tolerance
> that makes the first cheap corrupts the second.**

**The consequence that matters for scheduling:** these stats now ride the **canonical water re-import**
(`scripts/etl`), not the N6a depth run. There are **two ETL passes in flight with different cargo**, and
conflating them is how a field gets missed. Inventoried in
[N6a's ordering gate](./phase-N6a-lake-depth.md#before-the-etl-runs--the-ordering-gate).

**A free cross-check, not a source:** HydroLAKES carries `Shore_len`, and we already download and join it
for N6a's depth rung 3. Its 10 ha floor covers ~7% of our corpus and its polygon is a different water mask
at a different date, so a disagreement doesn't say who's right — but a 2× gap on a known lake means our
join or ring handling is broken, and that is worth catching at load time. **Log the comparison; store
ours.**

**Rounding (founder call): nearest whole mile / kilometre**, taking the softer of the two offers ("nearest"
over "round up") because rounding up systematically overstates a figure a skater might use to judge a lap.
Under a mile renders as *"under a mile of shoreline"* — no decimal on a farm pond. **Even measured at
source it is never presented as authoritative:** OSM's shoreline is a tracing by many hands and still
won't equal a published survey.

**Related:** [D3](#d3), [D25](#d25), [D48](#d48), [D70](#d70--lake-profile-content-is-derived-or-third-party-never-hand-maintained-n6cn6d), [`phase-N6c`](./phase-N6c-expanded-lake-profiles.md).

## D85 amendment — the stats are measured from an interior point, and `centroid` is not one (N6c-1)

**Decided (2026-08-02; found by running A4 against real lakes rather than fixtures.)**

D85 said *measure the source geometry*. It did not say *from where*, and N6c's A4 said "cast a ray
through the centroid" — which cannot be taken literally. **`waterBodies.centroid` is Turf's
`pointOnFeature`**, which returns the bbox centre only when that lands inside the polygon and a point
on the **boundary** when it does not. That is true of any curved or narrow lake: Lake Willoughby's
stored centroid **is ring vertex 199**, and Lake Champlain's sits **30.7 km** from mid-lake.

Nothing caught it because `pointInPolygon` counts the boundary as inside, and it was harmless for
every consumer the field previously had. It was fatal to the fetch profile: **7 of Willoughby's 16
bearings and 8 of Champlain's returned 0.0**, since a ray cast north from a west-shore vertex
correctly finds no water.

**`centroid` is left exactly as it is.** Every other consumer wants it or is indifferent: drive-time
bands measure to it (`notifications.ts`, `reports.ts`) and you drive to a shore rather than to
mid-lake, and a pin-less report inherits it for the `adminAreas` town stamp, where a shore is in the
shore's town. *Checked and worth recording, because it would have changed the answer:* put-ins are
**not** used for drive-time today.

**A new optional `interiorPoint` is stored instead**, derived at import as the midpoint of the
longest water span across 15 scanlines each way — always strictly interior by construction, and
biased toward open water, which is the right bias for an exposure figure. Only `lib/sampling.ts`
reads it, because **weather sampling was the one consumer the offset genuinely hurt**: Open-Meteo's
grid is 2–25 km, so Champlain's error was one to several cells wrong on an input the D56 decay math
is supposed to be reproducible from.

**Related:** [D48](#d48), [D56](#d56), [D85](#d85--derived-geometry-stats-are-measured-on-the-source-geometry-not-the-simplified-copy-n6c), [D90](#d90--wind-exposure-is-frequency-times-fetch-never-fetch-alone-n6c-1).

## D90 — Wind exposure is frequency × fetch, never fetch alone (N6c-1)

**Decided (2026-08-02; founder call, catching a claim the caption had no business making.)**

The caption described Lake Willoughby as *"most open to wind out of the south-southeast"* because
that is where its longest fetch runs. **Founder:** *"I am almost certain Lake Willoughby never gets
wind out of the south… the terrain (mountains) around lakes drastically impact the chance that wind
could come from particular directions."*

**A fetch profile is a claim about geometry. Rendering it as a claim about wind is the error.** A
direction with five miles of open water that wind never blows from is not an exposed shore.

**So we measured it, and the result was more interesting than either position.** NREL WIND Toolkit,
2 km WRF, Willoughby, Dec–Mar: **19.4% SE, 16.1% SSE, 18.6% NW** — a strongly *bimodal* rose along
the NNW–SSE trough, with the E/NE quadrant essentially blocked by Mount Pisgah and Mount Hor. The
specific prediction was wrong; the **reasoning was exactly right**, and the data shows the named
mechanism — terrain funnels wind *along* the valley rather than excluding half of it.

**The rule:** exposure is `winterFrequency[k] × fetchM[k]`, and **a lake with no rose says nothing
about wind at all.** There is deliberately no fallback to fetch-alone: that fallback is the claim
this decision exists to stop making, and its failure mode is a plausible sentence, not an empty one.
`mostExposedBearing` was deleted rather than left unused, because exporting it leaves the bug one
autocomplete away.

**Source: NREL WIND Toolkit (2 km), not the Global Wind Atlas (250 m).** GWA resolves finer and
would see more terrain, but it publishes **no documented public API** — depending on an undocumented
endpoint is the fragility D71 argues against. The question here is valley-scale and the Willoughby
rose shows 2 km answers it; 250 m matters for siting a turbine on a ridge. WTK also gives what GWA
cannot: hourly data, so the rose is **winter only** (Dec–Mar), where GWA publishes an annual
climatology and prevailing December wind is not prevailing July wind.

**Two denominator guards**, the same discipline as D78 and D86: a rose is refused below 4,000 winter
hours, and the caption states the percentage rather than a bare superlative — *"most exposed to the
northwest"* reads identically whether that sector carries 40% of winter hours or 7%.

**Recorded because it moved:** the API's host is `developer.nlr.gov`; `developer.nrel.gov` no longer
resolves. The credential is `WIND_TOOLKIT_API_KEY`, named for the dataset, since the provider has
already moved once.

**Related:** [D3](#d3), [D71](#d71--reference-links-are-generated-at-render-time-not-stored-per-body-n6c), [D78](#d78--a-recurrence-claim-is-history-with-its-denominator-attached-and-it-is-admin-only-until-it-clears-a-tunable-bar-n5c), [`phase-N6c`](./phase-N6c-expanded-lake-profiles.md).

## D86 — Aggregate quality renders as a graded mark, never as a word (N6c)

**Decided (2026-07-31; founder call, reversing N6c's own recommendation to defer — *"maybe instead of
writing the word 'Awesome' or 'Great', we could show some kind of symbol or fill-bar or dots."*)**

The per-body map summary card carries a consensus quality signal, rendered as **filled dots** (first stab:
four), derived from the existing Phase 6 thumbs. No adjective, ever.

**Because the objection to deferring it was an objection to words.** N6c argued that *"a single word
summarising how good the ice is here is a safety claim wearing a summary's clothes."* That is true, and the
founder's answer removes the words rather than the feature. **A word has a referent** — "Great" is a claim
*about the ice*, asserted by the app, on the surface where someone decides whether to drive. **A mark's
referent is whatever the legend says**, and we control the legend: *how recent reporters rated it*. Dots
render our users' ratings, which is a fact about the reports — the same class of content as the count
beside them, which E1 already permits.

**Why dots and not a fill bar:** a continuous bar reads as a gauge, a gauge reads as an instrument
reading. Discrete dots read as a tally, which is what this is.

**The quorum floor is the load-bearing rule.** Below ~3 rating reports in the window: **no dots at all**,
not a low score. One person's opinion rendered as a consensus mark is the worst failure here and it fails
*silently* — the mark looks identical whether it summarises 1 report or 40. Same denominator discipline as
**D78**, for the same reason. Season- and window-scoped like the counts beside it, and the accessible text
alternative (*"rated 3 of 4 by 12 recent reports"*) is usefully the honest long form.

**What stays deferred, and is now clearly separable:** N5c's recurrence line (*"frequently pressure ridges
off the eastern shore"*). These were bundled as "the D3-sensitive half of the card"; the mark-not-word
answer separates them, because a recurrence claim has **no word-free rendering** — its whole content is
the claim.

**Related:** [D3](#d3), [D50](#d50), [D78](#d78--a-recurrence-claim-is-history-with-its-denominator-attached-and-it-is-admin-only-until-it-clears-a-tunable-bar-n5c), [`phase-N6c`](./phase-N6c-expanded-lake-profiles.md).

## D86 amendment — the dots read `skateQuality`, not the Phase 6 thumbs (N6c-2)

**Decided (2026-08-02; found at N6c kickoff by checking what a thumb actually means.)**

D86 says the mark is *"derived from the existing thumbs"*. **Those are the wrong input.** Phase 6's
polymorphic thumbs are `helpful` / `unhelpful` on a **report** — they measure whether the write-up
was useful, not what the ice was like. Rendering them under a legend reading *"how recent reporters
rated it"* would summarise one thing and label it another, on the surface where someone decides
whether to drive. That is precisely the class of failure D86 was written to prevent; it just came in
through the input rather than through the adjective.

**The right field is already in the schema:** `reports.skateQuality` — `great | good | fair | poor`,
a four-value scale, authored by the person who was actually on the ice, and it maps onto four dots
with no arithmetic at all. It is also an existing input, so D86's *"no new user-facing input, which
is most of why this is small"* still holds.

Everything else in D86 is unchanged: mark never word, the quorum floor, season- and window-scoping,
and the accessible long form naming the denominator.

**Related:** [D86](#d86--aggregate-quality-renders-as-a-graded-mark-never-as-a-word-n6c), [D50](#d50), [D78](#d78--a-recurrence-claim-is-history-with-its-denominator-attached-and-it-is-admin-only-until-it-clears-a-tunable-bar-n5c).

## D87 — Approach distance is walked, not flown (N6d)

**Decided (2026-07-31; founder asked whether a trail-routing API exists — *"it could be 800 m as the crow
flies but a full kilometer of weaving trail… and elevation gain is going to affect people just as much as
distance."*)**

`approachMeters` is a routed **OpenRouteService `foot-hiking`** distance from parking area to put-in, with
`approachAscentM` alongside it. Straight-line survives only as an explicitly-flagged fallback.

**Because it's the account we already have.** Phase 4's drive-time isochrones run on ORS; the
`foot-hiking` profile is the same key, same client, same free tier, and with `elevation: true` the
response carries **ascent and descent in metres** — the second half of the founder's question, delivered
by a request parameter rather than a second integration. It is also OSM-routed, so it walks the same
`highway=path` / `route=hiking` ways N6d's Workstream B is already extracting.

*(Considered: GraphHopper — comparable, but a second vendor and key for no capability we lack. Valhalla —
most control, and a server to run. Mapbox — `walking` only, tuned for sidewalks. AllTrails/Gaia/Strava —
trail *content* products with licensed geometry and no general routing API.)*

**The quota is a non-issue because of *when* we call it:** at ETL time, once per put-in, cached on the
row. **Never from a request path** — that's the one rule worth writing at the call site.

**The fallback ladder is part of the decision, not a caveat.** OSM's rural trail coverage is patchy, so:
routed distance + ascent → straight-line **flagged** (it under-reports, so the flag is the difference
between *"about 900 m on foot"* and *"at least 900 m on foot"*) → nothing, for the majority of bodies with
no parking area to route from.

**The `hike_in` chip ships with it** (founder ask), on the map summary card, the lake drawer and the feed
card — derived from `approachKind`, not entered. A skater filtering to "within 60 minutes" is filtering on
**drive** time, and a hike-in lake inside that band is not the trip they think they're being offered. The
two numbers are never summed: a 55-minute drive plus a 25-minute walk is not an 80-minute drive.

**Still out of scope:** routing the walk itself. We report distance, climb and a kind; navigating a trail
is a maps app's job.

**Related:** [D72](#d72--parking-is-modelled-apart-from-put-ins-and-directions-route-to-the-car-n6d), [`phase-N6d`](./phase-N6d-lake-access-points.md), [`phase-4`](./phase-4-drive-time-and-filtering.md).

## D88 — Access-point photos ride the existing posting permission (N6d)

**Decided (2026-07-31; founder call — *"anyone who can post reports or hazards can upload access point
photos (unless we want to add another permissions toggle for this; I'm not convinced)."*)**

No new permission. **D57**'s existing report/hazard posting permission governs access-point photos, with
post-hoc moderation through `contentFlags` like every other user-supplied photo.

**Because the risk profile sits below reports and hazards, not beside them.** A bad ice report is a safety
problem; a bad photo of a parking lot is wrong, not dangerous. And there is no personal information in a
picture of a gravel pull-off — the same reasoning that put these photos under D62's *redact-don't-erase*
rule rather than under deletion, and that exempts them from D66's seasonal purge (infrastructure doesn't
expire the way conditions do).

**The real argument against a separate toggle is drift.** A permission that is always set equal to another
permission is a permission that will one day *not* be, by accident, and confuse someone a year later. Two
knobs for one idea is the same failure D70's `curatedBoost`-not-`isDestination` call avoided.

**The protective work is done by constraints already in the phase:** the ~3-photos-per-access-point cap
bounds any single point's abuse surface, and minors are read-only (Phase 3), so the population that can
upload is already the population trusted with reports.

**Related:** [D57](#d57), [D62](#d62), [D66](#d66), [D70](#d70--lake-profile-content-is-derived-or-third-party-never-hand-maintained-n6cn6d), [`phase-N6d`](./phase-N6d-lake-access-points.md).

## D89 — The contour interval is a fixed ladder, not a per-lake target (N6b)

**Decided (2026-08-01, after comparing our output against Maine IF&W's and VT DEC's own depth charts.)**

Every lake is drawn on the same **5 ft ladder**, and the ladder only ever steps **coarser** — to 10, 25
or 50 ft, each a whole multiple so two lakes' rings always nest. Ring *count* is therefore a readout of
depth: three rings on a 17 ft pond, eleven on a 59 ft one.

> *"I'd rather see contours every 5 ft and therefore only get 3 contours in one lake and 10 in another.
> But I don't want to just make it up and end up with a very inaccurate depiction."* — founder

**What it replaces, and why that was wrong.** The interval used to target ~12 bands per lake from
`maxDepth` alone. Checked against the agencies' charts, that was backwards in the way that matters:
Washington Pond (36 ft, **105 soundings**) got a 2 ft interval and seventeen levels, while Lake Morey
(42 ft, **68,139 soundings**) got 5 ft. The sparse lake was given the fine interval and the dense one
the coarse, because depth is the one input that says nothing about how much structure the survey can
support.

**Two ceilings step the ladder up, and nothing steps it down:**

- **Depth**, so Champlain does not draw 79 rings (`MAX_BANDS` = 20).
- **Data support** — a band needs measurements around it to be traced rather than invented, counted in
  *independent* samples (grid cells surviving `blockmedian`), never raw readings, since a transect log
  of 1,387 points collapsing into 24 cells carries 24 measurements' worth of information.

Refusing to go finer than the base is what keeps it honest: the failure being fixed was too many lines
on too little data, so no lake gets a denser picture than the standard.

**Contour lanes reach the same ladder by subtraction only.** For NH and MA the agency already drew the
isobaths, so we thin their published levels toward the ladder and never move or add one — a source
coarser than the ladder (NH at 10 ft) comes back untouched; a finer one (MassGIS's 2/3/4/5 ft shallows)
collapses toward 5 ft. **The deepest published level is always kept**, because thinning away the
innermost ring is [D82](#d82--bathymetry-is-context-not-counsel-n6b)'s understating-by-omission arriving
by a different road.

**This does not reopen what D82 closed.** The proposal D82 rejected dropped levels *where lines crowd
together on the map*, which would make ring count depend on bed steepness. A fixed **depth** ladder is
uniform in depth and never in map distance, so a deeper lake always shows more rings. **And D83
survives**: its rule was *"don't draw a line where no depth-sounder went"*, not *"don't choose which
surveyed lines to show."*

**Related:** [D82](#d82--bathymetry-is-context-not-counsel-n6b), [D83](#d83--contours-carry-their-sources-native-interval-and-units-labelled-we-never-resample-n6b), [`phase-N6b`](./phase-N6b-bathymetry-layer.md).

## D91 — The canonical corpus has a floor: five acres, or one acre with a name

**Decided (2026-08-02, founder call, from a measurement of the 2026-08-02 five-state transform —
123,940 bodies.)**

A body enters the canonical corpus only if it is **at least 5 acres**, or **named and at least
1 acre** (`meetsAreaFloor`, `@skating/core`'s `osm.ts`). Nothing under an acre survives on any
evidence. Everything else is dropped at transform time and tallied as `droppedByAreaFloor`, distinct
from the classification drop. **Keeps 21,660 of 123,940 — 17.5%.**

> *"If I get user feedback that someone's pond isn't there, then we can relax the rule and re-run the
> import."* — founder. That is the fallback the whole decision rests on, and it is why the rule is
> tuned to be cheap to loosen rather than safe to leave alone.

The rule lives in core, not in the ETL that applies it, because two things enforce it: the transform
(what a future import writes) and `waterBodies.pruneBelowAreaFloor` (what an existing corpus keeps).
Two copies would drift into a prune that deletes rows the next import puts straight back.

**Why there's a floor at all.** 64% of every feature the ETL imports is under one acre, with a median
long axis of **50 m** — farm dugouts, retention basins, widenings in a brook. 84% is under five acres.
Those ~104,000 rows are cell-indexed, searched, tiled and stat-computed, and none of them is a place
anyone drives to.

**Why five, when 25 / 30 / 50 were on the table.** Because the size argument cannot tell those apart
and the cost argument can. All three floors delete ~95% of the corpus — 25 ac keeps 6,966 bodies,
50 ac keeps 4,207, a gap of 2% of the corpus — while the difference between them is 2,759 real lakes.
Above five acres you are no longer deleting junk, you are choosing how many lakes to lose for a
rounding error in row count.

Checked against the only two demand signals we have, and both said the same thing:

- **The Google-Group gazetteer** (`training_data/google_group`, 117 discussed bodies). A 50-acre floor
  deletes **Keiser Pond** (36 ac — and on our own VT curation seed), Boston Lot Lake (44.8), Drew Lake
  (48.2), Ewell Pond (48.2) and Oliverian Pond (32.1). Nothing anyone has been recorded skating is
  under five.
- **State bathymetric surveys** (the N6b ingest, 2,022 lakes an agency paid to sound). **41% are under
  50 acres, 23% under 25.** A 50-acre floor deletes 826 lakes whose contours we had already drawn.

**Area is also the wrong axis, which is the second half of why the floor is set low.** The test being
applied — "you can't skate a full circle" — is about *length*, and we store `longAxisM` (D85). Keiser
Pond is 36 acres and **909 m** long: a 1.8 km out-and-back, better skating than a round 30-acre pond
390 m across. There are 993 named bodies under 30 acres with a long axis over 600 m. At five acres the
question doesn't arise, so no axis clause is needed; **if the floor is ever raised, it must gain one.**

**The name tier is a hedge, and its evidence is thin — deliberately recorded as such.** It rescues
2,398 named bodies between one and five acres, and **none of them is a known destination**: no body
discussed in the Google-Group corpus is under five acres at all. Everything named above as a casualty
of the *higher* floors — Keiser, Boston Lot, Solitude, Profile — clears five acres on size and needs
no name.

It stays because it is a cheap way to be wrong in the recoverable direction. A name in OSM is a human
assertion that a place is a place, and it is the only such signal in the extract; search is name-driven,
so a named pond returning nothing reads as broken rather than curated. It costs ~2% of the corpus
against the 81% the floor removes. **If it is ever dropped, drop it on that trade and not on a belief
that it is protecting known lakes.**

**There is deliberately no "…or an agency surveyed it" tier, and that knowingly costs 5 bodies.**
One was built on 2026-08-03 and removed the same day (founder call), because **agency coverage is
downstream of this rule**: `waterBodies.matchBathymetryLakes` resolves a surveyed lake by looking for
a *listed body in our corpus* at its deepest sounding, with a zero-metre buffer. A lake the floor
excludes therefore can never be matched, contoured, or counted as covered.

The consequence is a ratchet rather than a cycle. The clause could only ever protect lakes that a
**previous, more permissive** corpus had already discovered — and for **any newly imported region it
is a no-op by construction**, since the import runs before the join. Keeping it would have bought
five bodies (3 in Maine, 2 in New Hampshire, all unnamed, 3.6–4.6 acres) in exchange for a permanent
ordering rule nobody could enforce — *import unfiltered → join → build → coverage → prune* — plus a
live trap: `importContourCoverage` **replaces** the coverage set, so pruning first and re-tiling later
would silently drop those lakes from coverage and then delete them.

Five bodies is the right price for deleting a whole class of ordering bug. **They are knowingly
skipped**, and the fallback is the same one the rest of this decision rests on: someone reports a
missing pond, we relax the rule and re-import.

**The name tier stops at one acre**, because that is where a name stops asserting anything. 98% of
sub-acre bodies are unnamed; of the 1,586 that are named, exactly **one** carries a state bathymetric
survey and **one** has a long axis over 300 m. The largest are Quarry Pond (105 m long), Spring Pond
(139 m) and Bog Pond (102 m) — an acre is 64 m across. The naming gradient only becomes informative
above it: 2.0% named under an acre, then 5.6% / 10.4% / 16.1% / 19.7% through the 1–5 acre bands, then
52.1% above five.

Cutting the sub-acre named bodies costs one gazetteer name and it is a **false match**: "Button Bay"
(32 mentions) resolves only to an unrelated 0.62-acre bay in *Maine*. The real Button Bay is on Lake
Champlain and is not a body in the corpus under any rule — OSM models it as part of the lake, so it
belongs to the sub-area layer with Malletts Bay and Dillenbeck Bay. Dropping it fixes a search that
currently returns the wrong lake. Every other discussed name only loses redundant same-name matches
(Beaver Pond drops 9 of 89, Mud Pond 2 of 180, Mill Pond 4 of 87) and keeps the lake itself.

**Three acres for the unnamed tier was weighed and rejected** (same session). It would admit 4,988
more bodies — +23% on the kept set — whose median shape is 235 × 117 m. **81% of them are `other` or
`marsh`**, the buckets for water the classifier couldn't identify, and only **5** carry a state
bathymetric survey: 0.10%, against 0.80% for the unnamed bodies already above five acres, an eightfold
difference in the one independent quality signal available. The gazetteer cannot separate three from
five, because nothing discussed is under five either way. If the worry is a skateable-but-unnamed pond,
the honest lever is an axis clause — unnamed ≥ 3 ac **with a long axis ≥ 300 m** admits 1,174 of those
4,988 and leaves the 3,814 round pockets (1,935 `other`, 1,085 `marsh`) out — not a lower area, which
buys 4 junk rows for every plausible one.

**Scope.** Canonical (OSM) import only. A body a skater creates from a recorded track (Phase 8,
`waterBodies.create`) never passes through the transform and is exempt on purpose — someone skated it,
which outranks any threshold. Sub-areas ([D60](#d60--a-bay-is-a-named-sub-area-of-one-polygon-not-a-water-body-n2))
are untouched, which matters more than it looks: three of the seven most-discussed destinations in the
corpus (Malletts Bay, Button Bay, Dillenbeck Bay) are bays of Champlain, not bodies.

**What this does not do.** The floor alone doesn't remove anything already imported —
`importCanonical` upserts and never deletes. `waterBodies.pruneBelowAreaFloor` is the other half: a
paginated, **dry-by-default** pass that deletes the stored rows the floor would now refuse, and keeps
anything with a claim on it (`source: 'user'`, a `curatedBoost`, a soft-delist, a dedup/merge pointer,
an unknown area, or any attached report / hazard / bounty / favourite / put-in / track / sub-area).
And this isn't a
map-clutter fix: [D49](#d49--zoom-scored-display-prominence-the-zoom-based-rendering-d48-gestured-at)'s
`minVisibleZoom` already bounds what a wide viewport reads, in-index. This buys storage, ETL time and a
corpus that means something.

**Related:** [D48](#d48--water-body-removal-reversible-soft-delist-curation--landowner-takedown), [D49](#d49--zoom-scored-display-prominence-the-zoom-based-rendering-d48-gestured-at), [D60](#d60--a-bay-is-a-named-sub-area-of-one-polygon-not-a-water-body-n2), [D85](#d85--derived-geometry-stats-are-measured-on-the-source-geometry-not-the-simplified-copy-n6c), [`phase-1`](./phase-1-water-bodies.md).

---

## D111 — Rendering a place and covering it are two questions; New York south of I-84 gets one answer each (N7)

**Decided (2026-08-05, founder call.)**

The map draws downstate New York in full. The corpus does not include its water.

These had always been the same question, and only because of an accident: the basemap was a rectangle,
so wherever we stopped drawing was also wherever we stopped claiming to know anything. Giving the map
a world separated them, and once separated they have different right answers. Poughkeepsie and
Brooklyn are real places in one of our five states, and a user driving north deserves to see where
they are starting from — a map that ends in grey at the Bronx is a bug. But we have no basis for
saying anything about skating on water down there: no local knowledge, no sounding coverage, no
reports, and a climate that makes the question mostly moot.

**The cut is I-84, expressed as whole TIGER counties.** Not a latitude, because a straight line
through the Hudson Valley would split counties and put half a reservoir in and half out. The excluded
set is generated by `pnpm --filter @skating/admin-areas build-region` from the **same TIGER counties
the map's mask is cut from**, so the line a user sees and the line the corpus enforces are one
artifact and cannot drift apart.

**A body is judged by its middle, not by its edge** (`inDownstate`), and the asymmetry with
`inRegion` is deliberate. `inRegion` is generous — it keeps a body if *any* sampled point of its
outline falls in the five states, because Beau Lake straddles the Québec border and only its edge
proves it belongs to us. This test asks the opposite question: not whether a body *touches* downstate
but whether it *is* downstate. So a reservoir lying across the Putnam/Dutchess line is decided by
where its bulk sits rather than by whichever inlet reaches furthest south.

**It is counted separately from the region clip**, and that is not bookkeeping. `outOfRegion` is the
state geodatabases spilling over their own state lines — a data artifact, and a number that should
stay roughly constant. `belowI84` is a coverage decision we made. Totalling them would hide the
second inside the first, and the first is large enough (35,637 on the last run) to hide almost
anything.

**What this does not do.** It does not delist anything already stored — `importCanonical` never
deletes, so downstate bodies imported under earlier runs survive until the campaign's re-affirmation
prune removes them. It is not a statement that the water down there is unskateable, only that we do
not claim to know; if that changes, the lever is one file and a re-run. And it does not touch
rendering, admin areas, or drive-time: a user downstate still sees their own town, still gets
isochrones northward, and still searches the whole corpus.

**Related:** [D5](#d5--regions-are-a-data-concern-not-a-code-concern), [D91](#d91--the-canonical-corpus-has-a-floor-five-acres-or-one-acre-with-a-name), [`phase-N7`](./phase-N7-unified-corpus.md).

---

## D92 — OSM draws the lakes, because the bake-off found no reason to prefer NHD (N7)

**Decided (2026-08-06) by measurement, not precedent.** The referee was our own bathymetry: **21.9
million measurements** across 2,359 surveyed lakes, physical, and drawn by neither publisher.

```
metric            OSM wins    NHD wins        tie
containment         235 10.0%   385 16.3%   1,739 73.7%
coverage gap        315 13.4%   297 12.6%   1,747 74.1%
COMBINED            382 16.2%   485 20.6%   1,492 63.2%
medians:  containment 1.0000 / 1.0000 · gap 88 m / 87 m · area 68 ac / 68 ac
```

**They are indistinguishable, and D92 said in advance that this was a legitimate outcome that "must
not be dressed up".** Every median is a tie to three significant figures. On the metric least
confounded by size — the coverage gap, which asks how much of a polygon's own area sits far from any
measurement — it is 13.4% against 12.6%, a coin flip over 2,359 lakes.

So the rule is **OSM by default**, on the tie-break D92 specified: *pick the one with the cheaper
pipeline.* OSM is already ingested, is the identity spine (`Permanent_Identifier` is a field on our
record, not our key), and is the only source for D72's access layer — put-ins, parking, trails are not
in NHD at all. Switching would mean re-importing 27,074 outlines to buy a difference we could not
measure.

### Two metrics, because either alone can be gamed

`containedFraction` punishes a polygon that is **too small** and is blind to one that is too large — a
polygon covering the lake and the field beside it contains every sounding and scores a perfect 1.0.
`probeCoverage` (D98, `@skating/core/bodyProbe.ts`) is the mirror: probe the polygon's *own* area and
measure the distance from each probe to the nearest measurement, so an over-drawn lake has probes in
the pasture. Bounded on both sides.

### What the measurement actually says, stated carefully

**Containment is substantially a proxy for "which catalogue draws larger."** The loser is usually the
smaller polygon, because the survey pokes outside it. NHD runs ~3% larger in Maine and ~6% smaller in
Massachusetts, which is the whole of the apparent state split — **MA 53.7% OSM against ME 24.7% NHD is
a size-convention difference, not a quality difference.** Big area disagreements (>25%) are a flat
5–6% in every state, so it is not segmentation either.

**NHD wins small lakes and OSM wins large ones** — 43.2% NHD under 10 acres, 18.1% OSM above 1,000 —
which is consistent with a 1:24,000 compilation resolving a small pond better than a volunteer tracing
imagery, and worse on a shoreline long enough for that volunteer to have walked it.

**The two metrics disagree on 140 lakes (5.9%)**, counted as ties. Where one outline contains the
survey better and the other describes the water better, picking a winner would mean inventing a
weighting the evidence does not support. Those are the per-lake override candidates.

### The per-lake override stays, and this is what makes D93 worth having

`geometrySource` remains a field. The default is OSM; the override is for named cases where the margin
is large — and it costs a field update rather than a migration precisely because D93 minted our own
key. **Beau Lake is the standing example**: 1,875 acres, absent from OSM entirely because Geofabrik
clips the Québec half, present in NHD at 1,876.6.

### ⚠ The limits of this result, recorded rather than buried

**It cannot measure coverage, only shoreline quality where both catalogues have a polygon.** The
referee set is built from the bathymetry join, which needed an OSM body to exist — so the lakes OSM is
*missing* are excluded by construction. **Beau Lake is not in this sample.** The 15 OSM-only against 7
NHD-only surveys found here are therefore not a coverage measurement, and must not be quoted as one;
the coverage claim rests on the separately-measured 36 Maine surveys with no polygon at all.

**The first run of this bake-off was wrong and the numbers looked fine.** It took the OSM side from
the bathymetry join — which only accepts a body holding ≥ 0.5 of the survey — so every OSM polygon had
already passed the exact test it was about to be scored on. `osmContained` had a hard floor at 0.524
with **zero lakes below 0.5**, against 12 for NHD and 8 at exactly zero, and that tail was where every
"OSM wins" came from. It then picked the NHD counterpart by matching *against the OSM polygon*, so the
second catalogue was selected to resemble the first. Both are fixed by anchoring on the survey's
medoid — a real measurement, so on water by construction — with each catalogue independently supplying
the smallest feature containing it, and neither selection rule reading either scored metric.

**MA and NH contribute contour vertices rather than point soundings.** Checked for the obvious
confound: neither ships a zero-depth shoreline trace (MA's shallowest contour is 2 ft, NH's 1 ft), so
these are in-water measurements and not a re-tracing of the agency's own shoreline.

**Related:** [D48](#d48--water-body-removal-reversible-soft-delist-curation--landowner-takedown), [D91](#d91--the-canonical-corpus-has-a-floor-five-acres-or-one-acre-with-a-name), [D111](#d111--rendering-a-place-and-covering-it-are-two-questions-new-york-south-of-i-84-gets-one-answer-each-n7), [`phase-N7`](./phase-N7-unified-corpus.md).

## D112 — The map is two archives and a mask, and it stops drawing at our border rather than being fenced to it (N7)

**Decided (2026-08-05, founder call.)**

Zoom out and you see the whole world: oceans, continents, borders, a few country names. Zoom in and
detail appears **only inside the five states** — towns, then highways and lakes. Everywhere else keeps
its border and its name over flat, empty fill. And the camera is no longer fenced: you may pan to
Australia, and a control offers the way back.

**The old map was one `.pmtiles` extracted with `--bbox`, and both halves of that were wrong.** A
rectangle cannot know where Connecticut starts, so Ottawa, Toronto and Hartford rendered in full; and
its floor at 41.2°N is why the world ended in a straight line just above Manhattan. One cause, two
complaints.

**So: a whole-planet z0–6 overview beneath a polygon-clipped regional archive.** The overview is 43 MB
and seven seconds to extract, and it is what gives the map an ocean everywhere. The regional archive
is cut with `--region` against the five TIGER states, which also halved it (948 MB → 458 MB). Draw
order and zoom policy live in `packages/core/src/basemapLayers.ts`, shared by both surfaces so they
cannot drift.

**`pmtiles extract --region` clips by *tile*, not by polygon**, so the mask is not optional. A tile
grazing New York survives whole — a 2.4 km fringe at z14, and ~450 km at z6, which overzooming then
drags across Québec at every higher zoom. `--region` is a size optimisation; the mask is what makes
the border crisp.

**The mask covers water as well as land**, in three layers — sea, land over it, then the big lakes.
Land alone leaves the tail of "Madison" lying on Long Island Sound, because a label is wider than the
ground it names. Its hole is our land grown five kilometres seaward, intersected back with the ocean
so it can only ever grow into water and never into Connecticut; without that allowance a mask starting
at Portland's shoreline eats half of "Portland".

**Labels are filtered, not painted over, and this is the part that is easy to get wrong twice.** A
mask cannot tell our labels from anyone else's: "New York" is anchored in Manhattan with half the word
over New Jersey, and Seekonk and Rehoboth are Massachusetts towns whose names overhang Rhode Island.
So the regional archive's **point- and line-sourced** symbol layers sit *above* the mask with a
`["within", outline]` filter — theirs dropped rather than covered, ours legible over the flat fill.
The outline is generated a kilometre **outside** the true border, because the failure modes are not
symmetric: too small silently drops Vermont's own town names, too large shows one border town's name
against flat fill.

**Polygon-sourced labels are deliberately left under the mask**, and that qualifier is load-bearing
rather than fussy — see the third warning below.

### ⚠ Three renderer facts this rests on, all learned the hard way

**An opaque fill cannot hide a label.** MapLibre sends a fill to the *opaque* render pass only at
exactly `fill-opacity: 1`; symbols render in the *translucent* pass, which runs afterwards with depth
testing off. So an opaque mask is drawn *before* the labels beneath it and every town in Québec
rendered straight through it. The mask sits at 0.999 for that reason and no other.

**A filter is judged legacy-or-expression as a whole.** The Protomaps flavour writes eight of its
symbol filters in legacy syntax, so `["all", <legacy>, ["within", …]]` is read as legacy, `within` is
not a legacy operator, and MapLibre rejects **the entire style** — not the layer. The map went blank
on device. Every filter goes through the style spec's `convertFilter` first, and both app suites now
run `validateStyleMin` over the composed style, because a filter-level mistake is a black screen
rather than a wrong-looking layer.

**`within` supports Point and LineString features only.** Handed a polygon it logs
`within expression currently only support Point/LineString geometry type` and evaluates **false** — so
filtering a polygon-sourced label layer does not filter it, it *deletes* it. Decoding real tiles says
`places` and `pois` are Point and `roads` is LineString, while `water`, `earth` and `buildings` are
Polygon. Filtering all symbol layers alike therefore took **every lake name off the map inside our own
region**, which is the one label class this app can least afford to lose: the basemap is the only
thing that draws it, since we label bays and not lakes. The filter is keyed on the *source layer*
rather than the style layer's id, because geometry is a property of the source.

**Related:** [D6](#d6--renderer-maplibre-gl-locked), [D49](#d49--zoom-scored-display-prominence-the-zoom-based-rendering-d48-gestured-at), [D111](#d111--rendering-a-place-and-covering-it-are-two-questions-new-york-south-of-i-84-gets-one-answer-each-n7), [`phase-N7`](./phase-N7-unified-corpus.md).
