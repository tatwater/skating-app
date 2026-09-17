# Roadmap

Every phase with its status, what it was, and what it left behind. Each entry links to its phase doc for more detail. Decisions are `D#` in
[`01-decisions.md`](./01-decisions.md). The conventions (phase names, workstreams, statuses) are in
[`README.md`](./README.md).

**Nothing is in production.** Convex prod has never been initialized; every 🟢 below means *on dev*.
The prod cutover is one item in the [deferred register](#deferred-register) at the bottom, not a
per-phase caveat.

<!--
ENTRY TEMPLATE — copy this, keep the section names and order, omit a section when it's empty.
`packages/core/src/roadmapShape.test.ts` checks the heading, the status line, and that every phase
doc has an entry. Write the entry at scoping (⚪), flip it at build start (🟡), close it at merge (🟢);
it's part of the phase's own PR.

## Phase <token> — <title>
<🟢|🟡|⚪|⚫> **<Complete|In progress|Scoped|Withdrawn>** <YYYY-MM-DD> · PR #n · [plan](./<doc>.md) · D# D#

<One paragraph, ~120 words (up to ~180 for a big phase), concise and direct: what it is, why, the one or two
calls that shaped it, ending with what a skater or operator can now do.>

#### Data runs
- **<YYYY-MM-DD> — <what ran>:** <the numbers>

#### Deferred
- <🟢|⚪> **<item>** — <resolved where / what it waits on → pointer>

#### Ruled out
- **<item>** — <why>

#### Owed
- <verification, credentials, or follow-through still open>
-->

## Phase 0 — Foundations
🟢 **Complete** 2026-07-12 · PRs #1–#6 · [plan](./phases/00-foundations.md) · D7 D26 D29 D34 D37 D39 D40 D41 D43 D45 D46

The monorepo (Turborepo + pnpm, `apps/mobile` on Expo, `apps/web` on TanStack Start, shared
`packages/*`), Biome + Vitest + CI from day one, Clerk auth wired to Convex on both surfaces with the
16+ age gate and the assumption-of-risk acknowledgment enforced *server-side* — the server contract is
the trust boundary, and the ack is stamped there, never client-supplied. A profile-provisioning gate
admits a signed-in user only once their row records a current ack, with onboarding and re-ack screens
for the other states, sharing one pure `resolveAuthRoute`. Design tokens bridged into Tailwind and
Tamagui with a drift-guard test; Sentry on both apps; AGPL licence plus the store exception. The first
deploy took a chain of fixes recorded in the plan doc. *Both apps sign in, render empty Map and
Newsfeed pages, and crash-report.*

#### Owed
- Apple dev-build distribution for the mobile alpha crew

## Phase 1 — Water-body data
🟢 **Complete** 2026-07-13 · PRs #7–#11 · [plan](./phase-1-water-bodies.md) · D5 D6 D14 D48

The OSM ETL (`scripts/etl`) filters water features, maps tags to our `type` enum, simplifies to
~5 m, computes bbox, an on-water point and area, and emits NDJSON keyed by OSM id; an idempotent
`importCanonical` upserts on `source + externalId` and preserves removed state across re-imports.
The `listed` filter-key refactor replaced the Phase 0 `reviewStatus`-only filter, and the two-tier
`listInViewport` made a real corpus queryable at all. A read-only MapLibre map on a self-hosted
Vermont `.pmtiles` basemap confirmed the data, with OSM attribution as a build-time acceptance
criterion. Rivers were deferred — reaches are hard, and pilot skating is still-water. *Vermont's
lakes render on a map and an admin can remove or restore one.*

#### Data runs
- **2026-07-13 — Vermont OSM import:** 9,967 bodies (PR #9)
- **2026-07-13 — Vermont basemap:** `pmtiles extract` z0–14, ~280 MB, hosted on Convex file storage (PR #11); moved to R2 in Phase 2.5

#### Deferred
- 🟢 **Basemap off-ramp to Cloudflare R2** — done in Phase 2.5
- 🟢 **Curation / request-intake UX** — Phase 7 and N2
- ⚪ **Rivers as named reaches (D4)** — validate still-water with users first → register

## Phase 2 — Map + reports (the MVP)
🟢 **Complete** 2026-07-16 · PRs #12 #13 #16 · [plan](./phase-2-map-and-reports.md) · D9 D13 D20 D30 D31 D41 D42 D49

The usable MVP: an interactive MapLibre map with the D49 zoom-scored prominence (a small-but-beloved
lake can show at state zoom while clutter drops), tap-to-detail with deep-linkable drawers, and report
create/read — multi-reading thickness, conditions, a put-in pin, photos with HEIC decode, EXIF strip
and geotag opt-in. Web shipped first to prove the shared backend, then the mobile online loop on
native MapLibre, then the offline draft queue: a buffered `pointInPolygon` GPS→lake resolver and a
checkpointed, idempotent flush state machine in `@skating/core`, backed by an `expo-sqlite` body-polygon
LRU and draft queue. Reports are always public (D13 — a visibility selector shipped and was removed).
*Friends can post and read reports on real lakes, with or without signal.*

#### Deferred
- 🟢 **User-created water bodies + dedup** — moved to Phase 8, where a GPS path makes them trustworthy
- 🟢 **Offline basemap tiles ("Layer 3")** — deferred to Phase 9, dropped there, built flag-off in 9.5
- 🟢 **Photo-orphan GC** — folded into N3

## Phase 2.5 — Regional expansion
🟢 **Complete** 2026-07-15 · PR #14 · [plan](./phase-2.5-regional-expansion.md)

Data and infra only: the Vermont pilot widened to the Northeast lake-skating states — NY north of the
metro, VT, NH, ME, MA, deliberately not the whole Geofabrik "northeast" dump — via per-state extracts
through the Phase 1 ETL. The multi-state basemap blew past Convex's storage tier, so tiles moved to
Cloudflare R2 (zero egress; an env-var swap for the apps), map bounds widened only after the data
landed, and the corpus size made a lake name-search box near-essential, so it shipped here in both
apps. The `curatedBoost` seed mechanism landed with a flat +0.3 for 21 Vermont bodies. *A skater
anywhere in the five states opens the app and sees their lakes.*

#### Data runs
- **2026-07-15 — five-state OSM import:** ~116,070 bodies (NY clipped downstate); replaced by the N7 unified corpus in August
- **2026-07-15 — five-state basemap on R2:** 948 MB, z0–14

#### Deferred
- 🟢 **Per-body curation and the bays OSM lacks** — N2 (and "add the bays" turned out unbuildable as asked)

## Phase 3 — Comments + profiles + user-facing safety tools
🟢 **Complete** 2026-07-16 · PRs #15 #17 · [plan](./phase-3-community-and-safety.md) · D13 D21 D25 D32 D50

Threaded comments on reports, public/private profiles searchable by name, block (which is also mute)
and flag for reports, comments, photos and users, and a minimal moderator hide/remove path so flagged
content can come down before the full operator surface existed. The social graph was removed the day
before (D13): no follows, no friends, reports always public, minors read-only. The load-bearing call:
**a block never hides a report** — it hides the person's profile, comments and interaction, but a
safety observation stays on the map with a de-emphasized author line, because an interpersonal block
must never pull ice conditions off the map (D3). *Comments work, profiles respect privacy, users can
block and flag, and content can be taken down fast.*

#### Deferred
- 🟢 **Trust score computation** — rendered `0` here; built in Phase 6
- 🟢 **Full operator surface** — Phase 7

## Phase 4 — Drive-time + dynamic filtering
🟢 **Complete** 2026-07-18 · PR #19 · [plan](./phase-4-drive-time-and-filtering.md) · D11

Reframed at scoping from a hard distance gate to a **soft, quality-weighted signal that behaves
differently per context**: browse is permissive (show all, filters narrow, favorites boosted),
notifications are conservative (favorites on, distance and quality opt-in). Favorites are the
strongest signal and the stand-in for place-based curation — you subscribe to lakes, not people.
Three drive-time bands are read-time isochrone polygons on `profiles` (30/60 from hosted ORS, 90 a
crow-flies fallback), the feed filter row persists local-first with server LWW sync and includes
unknown values by default so a thickness floor can't hide the 84% of reports without a reading, a
coalescing notification queue drains into an 8pm digest, put-ins derive from report points, and a
mobile offline read-cache keeps recent reports readable on the ice. *Feed, map and notifications
scope by favorites and drive-time; put-ins and directions are on the map.*

#### Deferred
- 🟢 **Push delivery** — flush wrote an in-app row only; transports built in N8
- 🟢 **Notification fan-out scanning every profile on `reports.create`** — moved to a paged job in N1
- 🟢 **"Recommended" filter-breaking posts** — Phase 6, gated on corroboration
- ⚪ **Self-hosted ORS for a true 90-minute band** → [`backlog/self-hosted-ors.md`](./backlog/self-hosted-ors.md)
- ⚪ **Reverse spatial index for fan-out (D172)** — trigger ~1,000 profiles → N8

## Phase 5 — Newsfeed
🟢 **Complete** 2026-07-17 · PR #18 · [plan](./phase-5-newsfeed.md) · D28

A global cross-body feed, newest skate-*end* time first — a project-wide rename of `skateTime` to
`skateEndTime` ("when the skater left the ice" is the freshest read), with `skateStartTime` stored
optionally and duration derived. Each card carries the body name plus a point-derived town/county and
state label from the report's put-in pin, backed by a new `adminAreas` boundary table resolved at
report create — no per-read geocode, no corpus backfill — which GPS and hazards reuse. Tap a card and
the report opens in a drawer, preserving scroll; photo carousel, empty state, pull-to-refresh. Built
ahead of Phase 4, whose drive-time filters became an additive clause on the same `listFeed`. *Recent
community activity is browsable without going lake by lake.*

## Phase 6 — Bounties + trust score
🟢 **Complete** 2026-07-22 · PR #22 · [plan](./phase-6-bounties-and-trust.md) · D10 D17 D44 D50

Request-a-report bounties (post, browse on the bounded `by_status_expires` index, fulfill, thumbs)
and the **trust score** that stands in for the removed social graph: boost-only, window-bounded
corroboration plus helpful marks, so nobody is penalized for conditions changing — which protects
honest "don't go" reports (D3). It renders as a cosmetic class chip and avatar ring, never a raw
number, and never weights safety content. Polymorphic thumbs over reports *and* hazards, badges, and
the corroboration-gated "Recommended" feed post that breaks a user's distance/quality/thickness
filters for exceptional corroborated ice — never recency, blocks or moderation. Built after Phase 9:
safety content before reputation. *A working bounty loop, and reporters accrue a public trust
class from corroboration and helpful marks.*

#### Deferred
- 🟢 **GPS-skate half of bounty eligibility (D44)** — lit up with Phase 8
- 🟢 **Contradiction signal and weather-aware bounty freshness** — Phase 10
- ⚪ **Server-tracked recommended caps** — trigger: real data showing it feels spammy → [`backlog/low-urgency-items.md`](./backlog/low-urgency-items.md)
- ⚪ **A dedicated bounties geospatial instance** — only past the 200-scan cap → register

## Phase 7 — Operator surface
🟢 **Complete** 2026-07-24 · PRs #24 #25 · [plan](./phase-7-operator-surface.md) · D35 D37 D38 D57

The founder-facing back office: a role-gated `/admin` route tree in the web app organized as work
queues (flags with an `unsafe_false_report` priority lane, user admin with ban/suspend/role, dedup
review with merge, a support inbox), in-context moderation across the app, per-action posting
permissions finer than a ban (D57, appealable), and every mutation audited to `moderationActions`.
Analytics are in-house: `metricSnapshots` daily rollups and forward-only `bountyGateEvents` — charts
never scan the corpus — feeding a **read-only tuning control-room** where every magic number pairs
with the chart that tunes it. The call that shaped it: constants stay in `@skating/core` and edit
means redeploy; only per-row data is editable in-dash. The bounty gate had to *stop throwing* to be
observable. *Operators triage flags and support, moderate in place, and see the numbers behind
every tunable.*

#### Deferred
- 🟢 **`activeBountyPostLimit` lever** — N2
- 🟢 **`weatherSamplePoints` writer** — Phase 10 shipped a reader; N2 shipped the mutation
- **`appConfig` runtime-override table** — a documented seam, deliberately not built

## Phase 8 — Native track capture + Strava push
🟢 **Complete** 2026-07-24 · PR #26 · [plan](./phase-8-native-capture.md) · D14 D36 D58 D59

The phase inverted before it started: Strava's 2024 terms forbid showing one athlete's data to
another, so the "pull tracks from Strava" plan died and became **record in-app, push to Strava** —
first-party data we may aggregate, and *record once, keep your Strava stats* as the adoption lever.
Modeled A→B→C: a native GPS recorder over a durable buffer (A), our own `gpsActivities` store with
resolve-to-lake and a decaying aggregate tracks layer under publish-is-consent privacy with put-in-
gated endpoint clipping (B), and Strava `activity:write` via the repo's first HTTP router and OAuth
state nonce (C). User-created bodies finally landed here, **path-only at the trust boundary** — no
freehand drawing, ever — with match-on-create dedup feeding Phase 7's queue. Unified report freshness
(D59) drives path opacity. *A phone-only skater records a skate, sees the path on their report and
the lake, pushes it to Strava, and new water gets a body from the track.*

#### Deferred
- ⚪ **Watch adapters (Garmin / COROS / Polar / Health Connect) + watch-wins ingest** — partner approvals → [`backlog/partnerships.md`](./backlog/partnerships.md)
- ⚪ **HealthKit adapter** — needs no approval; needs an iPhone → [`backlog/low-urgency-items.md`](./backlog/low-urgency-items.md)
- ⚪ **Path-cluster hazard deduction (Q11 / L9)** — volume plus a privacy pass → register
- ⚪ **Additional push targets (Whoop)** → register

#### Ruled out
- **Pulling GPS from Strava** — L7; cross-user display and ML are forbidden by Strava's terms
- **k-anonymity for the aggregate layer (D58)** — a public report is meant to be shared; one skater is enough
- **`@mapbox/polyline` transport** — both maps draw GeoJSON directly

#### Owed
- Device verification: Android GPX playback, and an iPhone for background/battery parity
- A real Strava sandbox upload (callback domain is set)

## Phase 9 — Hazards
🟢 **Complete** 2026-07-21 · PR #20 · [plan](./phase-9-hazards.md) · D12 D15 D51 D52 D53 D54 D55

Hazard authoring with the geometry matched to the hazard — point-plus-radius by default, polyline for
ridges and cracks, polygon stored and rendered but not yet authorable — over a 16-key taxonomy the
research pass expanded to include the volatile holes and `thawed_rotten`, the top fatality cause.
Rendered fuzzy and advisory, never a surveyed boundary. Per-type decay with a three-tier healing
confirmation where only "fully healed" counts toward removal; recurring features graduate to a
persistent `bodyFeatures` entity; and client-side on-ice alerts that evaluate the phone's own GPS
against cached hazards, so they fire with no signal (D54 Layers 0–1). On-ice hazards auto-bundle into
the skater's later report (D55). Pulled ahead of Phase 6 — safety before reputation. *Hazards draw
with the right shape, age per type, and warn a skater standing near one.*

#### Deferred
- 🟢 **Layer 2 directional on-ice mode** — Phase 9.5
- 🟢 **Freeform polygon authoring** — N5b
- 🟢 **Consensus rendering and auto-merge of same-type pins** — N5c
- 🟢 **Weather-driven decay** — Phase 10
- 🟢 **Hazard-tuning admin surface** — Phase 7
- ⚪ **GPS negative evidence (Q11)** — tracks through a hazard nudge confidence, never auto-clear → register

#### Ruled out
- **The Layer-3 offline basemap tile-pack, in this phase** — a native spike needing a device build; on-ice capture degrades correctly without it (findings in the plan doc)

## Phase 9.5 — On-ice live alerting
🟢 **Complete** 2026-07-22 · PR #21 · [plan](./phase-9.5-on-ice-alerting.md) · D54

The D54 Layer 2 fast-follow: an opt-in "on-ice mode" that keeps warning you with the phone in your
pocket — `expo-notifications` (local only) plus session-scoped background location and a
course-over-ground projection giving 30–60 s of warning, the one conscious exception to D12. The
re-alert is gated on an approached set (enter, then leave) rather than plain distance hysteresis,
which spammed. Bundled with the smaller threads Phase 9 logged: `?action=confirm` deep links, the
hazard author line, footprints clipped to the body so what's drawn is what the alert measures,
auto-suggested skate times from the on-ice dwell, and the Layer-3 tile-pack built flag-off. *A
skater in motion gets a directional warning before reaching a confirmed hazard.*

#### Ruled out
- **Keep-awake and magnetometer heading** — course-over-ground, not compass; no wake lock
- **Silent server push to a sleeping phone** — a privacy decision plus iOS throttling; deferred, not designed

#### Owed
- One on-device check of the Layer-3 `file://` pmtiles path
- Real cold-weather battery and course-noise behavior

## Phase 10 — Weather-since strips + weather-driven hazard decay
🟢 **Complete** 2026-07-23 · PR #23 · [plan](./phase-10-weather.md) · D19 D56 D57

A live Open-Meteo fetch (forecast API with `past_days`, on drawer-open, into `weatherCache`) feeding
the plain-text, verdict-free **weather-since strip** on aging reports and hazards, and
**weather-driven hazard decay**: `effectiveAge = elapsed × decayMultiplier(type, weatherSince)`, with
refreeze-healed types accelerating on freezing-degree-hours and `thawed_rotten` *never* accelerating on
cold — the overnight-ice trap. The never-hide invariant (D56): weather can age a hazard but only
elapsed time plus a human confirmation retires one; fail-open when weather is missing. Also the three
tasks that had waited on the fetch — report conditions auto-fill, the corroboration **contradiction
signal** (withholds a boost, never subtracts trust, escalates a pattern to the D57 lever), and
weather-aware bounty freshness. *Aging reports say what the weather has done since; hazards decay
by what actually happened.*

#### Deferred
- 🟢 **Lake depth as a decay input** — the `isShallow` scalar this plan described never existed; N6a built the signal
- 🟢 **Multi-cell giants** — `weatherSamplePoints` reader here, writer in N2
- ⚪ **Decay-magnitude refit** of `HAZARD_DECAY` and `decayMultiplier` — needs a real in-app corpus; `bountyGateEvents` is the input → register

#### Ruled out
- **The archive API** — ~5 days lagged, so the forecast API's `past_days` was used; N6h later widened this past 92 days (D153)

## Phase N1 — Read-path durability
🟢 **Complete** 2026-07-26 · PR #27 · [plan](./phase-N1-read-path-durability.md)

The crash class: `@convex-dev/geospatial` reads roughly in proportion to `maxResults`, not results,
so a wide sparse viewport hit Convex's 4,096-read cap — and the 256-row clamp meant to contain it had
already been silently dropping lakes in dense Maine. The fix wasn't expressible in that component
(one point per key), so it was **retired entirely** for an own ladder-grid cell index: one row per
grid cell an object's bbox covers, at a rung no finer than the zoom it first draws at, so a viewport
read is bounded by geometry. Two unscoped finds: `adminAreas` had the same bug with a worse symptom
(Adirondack towns wider than the search box lost their labels), and `reports.create` was scanning every
profile to fan out notifications — now a paged scheduled job. *The map can't crash by panning, and
257 lakes that were missing are back.*

#### Data runs
- **2026-07-26 — cell backfill:** 116,070 bodies indexed; the off-data pan that crashed costs 22 reads, the heaviest real viewport 1,771, eastern Maine returns 513 where the clamp returned 256 (`waterBodies:viewportReadStats`)

#### Deferred
- ⚪ **Reverse spatial index for notification fan-out** — N1 bounded the walk, didn't remove it → N8 (D172)

## Phase N2 — Lake editor + sub-areas
🟢 **Complete** 2026-07-26 · PR #28 · [plan](./phase-N2-lake-editor-and-subareas.md) · D60 D61

Named sub-areas (D60): a bay is a region *inside* one polygon, not a lake beside it, so one sheet of
ice keeps one set of reports, hazards, bounties and favorites while carrying the name skaters use.
Labelled on cards and detail surfaces, searchable by alias, drawn from a third ladder-grid table,
targetable by a bounty. And the per-lake editor (D61) at `/admin/water/$id` with the camera locked to
the body — including the `weatherSamplePoints` writer Phase 10 shipped a reader for and never a
mutation, auto-flag bundling, and `activeBountyPostLimit`. `MapView` became a shared shell so the
editor and the skater map are one canvas. What the register had asked for — "add the bays OSM lacks"
— was unbuildable (`waterBodies.create` is path-only) and the wrong shape anyway. *Malletts Bay is
a place with a name, and an operator can curate a lake in place.*

#### Data runs
- **2026-07-26 — curation session:** the seeded sub-areas and the bay re-parenting recorded in the plan doc

## Phase N3 / N4 — Account lifecycle + storage hygiene
🟢 **Complete** 2026-07-27 · PRs #29 #30 · [plan](./phase-N3-N4-account-lifecycle.md) · D33 D62

Two register entries that were one phase: the crons exist to clean up what the lifecycle creates.
Deletion under D62's three buckets — erase the private (`homeCoord`, isochrones, OAuth tokens),
anonymize the public record, keep-but-sever published GPS tracks under D58's own consent predicate —
plus data export and the hygiene crons (export TTL, orphaned blobs, the finalize sweep). A deletion
request makes you a ghost immediately; only the login waits 30 days, so it's reversible; free text is
cleared at finalize, hazards are never erased (the multi-season record depends on them). Found along
the way: `showPutIn` was bypassed on the report-detail map. The bug worth carrying: **a Convex index
on an optional field is not sparse** — the finalize cron's first tick would have queued every
account. *A user can export or delete their account, and the record stays honest.*

#### Deferred
- ⚪ **Policy wording for deletion/retention (L3)** — mechanism built; copy waits on the legal pass → register

## Phase N5a — Seasons
🟢 **Complete** 2026-07-28 · PR #31 · [plan](./phase-N5a-seasons.md) · D63 D64 D65 D66

Nothing in the app expired before this: freshness was an opacity, not a gate, so a 2024/25 report
still rendered and a ridge from February was still on the map. A season is July 1 → June 30 (D63),
derived and never stored; reports are season-scoped in the feed and lake list, tracks and hazards on
the map, with a deliberate way to browse a past season. Hazards reset on the boundary, and recurrence
is D53's promotion — which makes the pre-first-ice promotion pass a safety task. Suggested crossings
decay the *opposite* way from hazards (D64): faster, needing more corroboration, one "closed" vote
making them visibly disputed. Plus the "never existed" verdict with named confirmers (D65) and a
departed skater's photos split on evidential value (D66). *Last winter's map doesn't masquerade as
this winter's.*

#### Owed
- Device verification of the native surfaces

## Phase N5b — Hazard authoring UX
🟢 **Complete** 2026-07-29 · PR #32 · [plan](./phase-N5b-hazard-authoring.md) · D67

The last of D51's three primitives: **freeform areas** with real vertex dragging on web (terra-draw)
and close-the-ring on mobile's existing tap-to-place trace — terra-draw ships no React Native adapter,
so the plan's "same lazy chunk on both clients" was unbuildable, and the Phase 9 polyline trace turned
out to be the mobile path already. And **snap-to-shoreline** (D67): two taps near a shore produce the
band of ice along it, straight off `waterBodies.polygon`, with a refused band offering narrowing
rather than a dead end. The pass fixed two pre-existing bugs outside its scope: every admin detail
page was a dead link (a TanStack outlet-less leaf), and favorite paint drifted between lakes on pan.
*A skater can draw the shape a hazard actually has.*

#### Owed
- Device verification
- Whether 25 m is the right default band half-width for a small pond

## Phase N5c — Hazard identity
🟢 **Complete** 2026-07-31 · PRs #34 #35 · [plan](./phase-N5c-hazard-memory.md) · D77 D78 D79 D80

Two founder asks that were one problem: "which hazards were on this lake in '24/'25?" and "if three
people pin the same ridge, do their confirmations split?" are the same geometric judgement at two time
scales. One `clusterHazards` primitive, two windows (D77): within a season it prevents, pools, renders
as consensus and auto-merges reversibly on the D36 tombstone pattern (D80); across seasons it becomes
recurrence, ranked promotion suggestions, and body-level "ice history" advisories. The three-season
corpus gate was answered rather than waited out — the engine ships now with thin patterns
**admin-only**, the skater-facing advisory dark behind a constant (D78), because the D3 trap is
showing a skater a one-winter coincidence and nothing does. Moderators can author body features
directly (D79); supersession is a backlink, never a hiding mechanism. *Duplicate pins stop splitting
corroboration, and operators watch recurrence form.*

#### Deferred
- ⚪ **Flip `RECURRENCE_ADVISORIES_PUBLIC`** — after operators have read the queue across two rollovers; a judgement, not a date

## Phase N6a — Lake depth
🟢 **Complete** 2026-07-30 · PR #33 · [plan](./phase-N6a-lake-depth.md) · D68 D69

The body-level depth D56 was designed around and never got — the `isShallow` scalar Phase 10 described
never existed; the manual `bodyFeature` was wired to nothing. Depth arrives as a provenance-carrying
precedence ladder (D68: operator → state agency → LAGOS-US observed → HydroLAKES → GLOBathy modelled)
because mean and max come from different sources and one `depthSource` couldn't be honest, plus the
shallow decay consumer that makes it mean something (D69: shallowness amplifies the thaw response
only, never the cold one). The data reaches ~7% of the corpus and ~100% of what a skater browses at
regional zoom; the manual flag is permanent infrastructure for the ponds no source reaches. *A
shallow pond's hazards thaw faster in the model, and the drawer says where its depth came from.*

#### Data runs
- **Never run as scoped** — the ETL here was gated on N6c and then **superseded by the N7-3 campaign** (2026-08-09), which loaded depth for 24.2% of the corpus, 83–90% above 50 acres

#### Deferred
- 🟢 **The ETL run** — via N7-3
- 🟢 **`state_agency` rung had no producer** — N7-3 wrote 3,033 measurements
- 🟢 **OSM `depth`/`maxdepth` tags** — rides the water ETL (`--depths`), built in the review pass

## Phase N6b — The bathymetry layer
🟢 **Complete** 2026-08-01 · PRs #36 #37 · [plan](./phase-N6b-bathymetry-layer.md) · D81 D82 D83 D89

Measured state-agency isobaths as a PMTiles overlay drawn inside the open lake: five sources archived
and normalized, joined at 98%, gated, contoured, tiled on the Phase 2.5 upload lane, and rendered by
both clients on drawer-open with no toggle (D81 — contours follow the detail view) and no safety copy
at all (D82 — bathymetry is context, not counsel, which dissolved the doc's hardest part). Vermont
publishes soundings, not isobaths, so it was the hardest lane: `gmt surface` with the shoreline as a
depth-0 constraint on an axis-compressed grid, after five interpolators failed on a render. The
finding that governs it: **every input-side quality gate we tried was falsified by a render**, so it
ships with none. A fixed 5 ft ladder (D89) makes ring count read as depth. *Open a lake and see
its basin.*

#### Data runs
- **2026-08-01 — bathymetry archive:** 5 agencies, 298 MB mirrored → 2,437 of 2,491 lakes joined → 2,042 contoured into 49,742 lines → 15 MB z9–z14 `dev/bathymetry-20260801-2.pmtiles`
- **2026-08-09 — re-keyed under N7 (D95):** 2,298 lakes → 52,522 lines → 2,287 bodies (+232 net-new)

#### Deferred
- ⚪ **A curving anisotropy axis** — mitigated by capping at each lake's elongation; revisit only when a user complains about a named lake
- ⚪ **Contour crowding on steep beds** — the obvious fix understates depth by omission
- ⚪ **NY has no statewide source** — covered only via Champlain; the PDF digitisation path is costed in the plan doc

#### Ruled out
- **Contours from GLOBathy rasters, permanently** — a linear distance-from-shore transform; an authoritative-looking rendering of a guess
- **Reusing a third party's prebuilt Vermont tiles** — every state goes through our own pipeline

## Phase N6c — Expanded lake profiles
🟢 **Complete** 2026-08-10 · PRs #38 #42 · [plan](./phase-N6c-expanded-lake-profiles.md) · D70 D71 D74 D76 D85 D86 D90 D138–D142

What N6a's depth numbers were missing — split at kickoff into **N6c-1** (derived numbers: geometry
stats measured on the source geometry, elevation, a 16-bearing wind-fetch profile made honest by wind
*frequency* from NREL's toolkit (D90), a generated caption, profile richness feeding prominence) and
**N6c-2** (reference links generated not stored so they cover the whole corpus (D71), NWS alerts on a
15-minute cron alongside Open-Meteo never blended (D74), the forward forecast the fetch was already
discarding, per-body map summary cards with D86's graded consensus dots, the per-lake timeline). Four
of the plan's claims were false and caught by running the code against real lakes, not fixtures —
including that `waterBodies.centroid` is a point *on the shoreline*, which would have opened Windy
30 km off Champlain. *A lake page says how big, how deep, how exposed, and where else to look.*

#### Data runs
- **2026-08-09 — the campaign passes (N7-3):** elevation 99.5% · wind roses 11,114 bodies (completed 2026-08-15) · `regionStats` 5 states × 5 metrics
- **2026-08-14 — `backfillCells`:** the D2 re-score N6c-1 had held since 2026-08-02 ran under N6d

#### Deferred
- 🟢 **Everything satellite** — N6e, at the founder's ask, so the imagery story lands in one piece (D138)
- ⚪ **`PROFILE_REVEAL_ALL`** — the reveal flag (D142) is still on; flip it to `false` before the season

## Phase N6d — Lake access points
🟢 **Complete** 2026-08-13 · PR #43 · [plan](./phase-N6d-lake-access-points.md) · D72 D73 D87 D88 D143 D144

Parking modelled apart from put-ins so directions stop routing cars to hike-in shorelines (D72,
many-to-many after the amendment — a trailhead lot serves three ponds), named access points from a
second OSM pass over the same extract, and access blockers as decaying community alerts that reuse the
hazard confirm machinery but *not* its weather decay — a locked gate doesn't thaw (D73). Approach
distance is routed via ORS `foot-hiking` with ascent (D87), never summed with drive time, and shown as
a Hike-In chip. The load found `amenity=parking` yields 95,294 lots, 92,384 of them supermarkets and
fire departments, so a water-relevance gate went in. Split out of N6c at scoping because it was the
size of everything else there combined. *A skater can see where to park, how far the walk is, and
whether the gate is locked.*

#### Data runs
- **2026-08-13 — access ETL:** 3,588 put-ins · 11,375 parking areas · 4,209 bodies with access (16.7%), routing 99.4%
- **2026-08-14 — `backfillCells`:** 24,961 bodies re-scored in 84 batches; D2's put-in terms fire for the first time
- ⚠ **The parking load cost 104.95 GB of database I/O and disabled the dev deployment** — `listedBodiesNearCoord`'s fixed candidate box read 1,377× the area a 30 m gate needed; fixed with `marginMeters`

#### Deferred
- 🟢 **Trail-connectivity pairing** — shipped inside N6e Workstream 0 (69 pairings; the ~6% yield estimate held) → [`backlog/trail-connectivity-pairing.md`](./backlog/trail-connectivity-pairing.md)
- 🟢 **Route geometry never stored** — recovered in N6e Workstream 0 (262 legs re-routed, 254 recovered)
- ⚪ **The 1,376 unmatched slipways** — an afternoon's sample, not a phase → [`backlog/unmatched-slipways.md`](./backlog/unmatched-slipways.md)
- ⚪ **`matchBathymetryLakes` (51 GB) and `coveringBodyForPoints` (21 GB)** — the same unbounded-read shape as the parking load, unfixed

## Phase N6e — Imagery, scoped to a lake
🟡 **In progress** 2026-08-26 · PRs #44 #45 #46 #47 · [plan](./phase-N6e-satellite-imagery.md) · D75 D84 D146–D151

Not a base map you switch to: a photograph of *this lake*, clipped to its shape and the way in, with a
date on it (D146 — a founder review falsified the map-wide toggle the first scoping specced, and the
doc was rewritten rather than patched); behind it, a season of Sentinel passes to scrub through and
watch the ice arrive, stored as one masked raster PMTiles per pass on our first owned infrastructure
(a Fly granule job → R2, D148). The constraint was never quota but physics (D147): NAIP is mid-summer
aerial and will never show ice; 10 m Sentinel can't show a 1–3 m ridge. Ingest is weather-gated and
the archive turns over on a frame, not a date (D149). Workstream 0 recovered the ORS route geometry
N6d never stored and drew the approach on both clients. *A lake can be revealed as a photograph and
its freeze-up scrubbed, on both clients.*

#### Data runs
- **2026-08-21 — Workstream 0:** 262 hike-in legs re-routed, 254 lines recovered; 30 approaches that were never walks (up to 99 km) demoted
- **2026-08-26 — winter 2025-26 season cut:** 14,149 objects in R2, index published; the only season archived

#### Deferred
- ⚪ **PR 4 — phenology (derived, dark)** and **PR 5 — the charts and the freeze-up notification** — both want the nine-season backfill, a deliberate separate spend
- ⚪ **Radar geocode is not terrain-corrected** — islands bounce between dates (open question 8)
- ⚪ **One number can't describe two surfaces** — Mascoma read 27% ice on a day the north half was ready (deferred question 7)
- ⚪ **Ice classification (D150)** → N6g

#### Ruled out
- **Tasked commercial imagery** — ~$200–400 per lake per capture; we buy neither end
- **Skia on mobile** — PR 2's baked alpha made the reveal an `ImageSource`

## Phase N6f — No public access
🟢 **Complete** 2026-08-16 · PRs #44 #56 · [plan](./phase-N6f-no-public-access.md)

The third map state: **on the map, and marked.** `isListed` was binary; `waterBodies.publicAccess`
adds a corroborated community claim — `contentFlags`' existing dedup *is* the vote count — that only a
moderator's ruling turns into a 50% dim and a two-zoom-level demotion, the D2 ladder's first and only
penalty, safe because `minVisibleZoom` clamps. `open` is a stored verdict whose whole job is to make
re-reporting cost one sentence. Taken straight into the N6e branch with no plan doc and no D-number;
the doc was written after the fact. Under the same prefix: the 164-function audit that armed eleven
unreachable mutations, the first edit-a-report UI, and the You tab's unreported-skates list. *A lake
you can't legally reach stays visible and says so.*

#### Deferred
- ⚠ **Six scoring sites must read the verdict** — or `importCanonical` silently un-demotes while preserving the ruling
- 🟢 **A mobile report control** — PR #56

## Phase N6g — What nine seasons of imagery might know
⚫ **Withdrawn** 2026-09-16 · [plan](./phase-N6g-imagery-research.md)

Three research lanes that read N6e's archive — single-frame ice identification, corpus shrinking by
observed freeze behavior, and the phenology derivations — none of which can start before the
nine-season backfill exists. Assigned a number at N6e's scoping, never built, and now a backlog item;
the number stays vacant. *(The doc moves to `backlog/imagery-research.md` in the renumbering pass.)*

## Phase N6h — The weather panel
🟡 **In progress** 2026-09-12 · PRs #48 #49 #50 #51 #54 · [plan](./phase-N6h-weather-detail.md) · D152–D166

Grew out of a costing question whose answer moved the design: the expensive half wasn't the data but
the **cache key**, which produced one fetch per lake (24,832 keys for 24,948 bodies) against models
that resolve at 3–13 km. Two keys replace it — Tier A for browse, Tier B for a corpus-wide cron on
3,043 cells (D152). Past weather became a durable archive rather than a cache, lazily backfilled 92
days on first open (D153). The drawer got three sub-tabs; the past panel and hourly timeline; a seven-
day planner off the fetch already paid for; and **weather-first discovery** (D159) — filter cells,
then bodies — which makes 25,000 lakes findable for the first time and turns the Newsfeed into
"Latest". An admin-only ice-thickness instrument ships dark to collect a season of paired
observations (D160). *A skater asks "do I get in the car?" against a lake with a visible history.*

#### Deferred
- ⚪ **Workstream F — radar** — MRMS with its Radar Quality Index, drawing where it *can't* see (D156/D157); cut on the Fly→R2 pattern, ~$5/mo
- ⚪ **Multi-season climatology** — unlocked by D153
- ⚪ **Paying Open-Meteo (D158)** — season two, with a written trigger; no request counter exists yet

#### Ruled out
- **True-sunset digest timing** — sunset runs opposite to the season; 8pm local stays
- **An always-on LibreWXR** — ~$760/yr for what cutting costs ~$5/mo

## Phase N7 — The unified corpus
🟢 **Complete** 2026-08-09 · PRs #39 #40 #41 · [plan](./phase-N7-unified-corpus.md) · D92–D105 D109–D137

The corpus was OSM-only, per-state, and a lake split across two features was two rows. N7 merges
OSM + NHD + 3DHP + GNIS into one record per lake with our own minted key (D93), best-of-both per field
(D94), and one admission floor applied *once* to the merged body (D109/D110): 178,095 groups in,
24,958 bodies out. Then the audit and the referee (three open questions settled by measurement; OSM
draws the lakes because the bake-off was a dead heat), then the enrichment campaign that ran every
loader N6a–N6c had been waiting on. Four findings to carry: a ladder rung with no producer, no
`osm→osm` matching lane, one constant doing two jobs, and *denominators lie by default, and so do
instruments*. Provenance is the default: every loader replays the merge's path. *One record per
lake, with the numbers the profile page needed.*

#### Data runs
- **2026-08-07 — corpus load:** 178,095 merged groups → 24,958 bodies + 120 sub-areas, in the order bodies → sub-areas → prune
- **2026-08-09 — campaign `n7-3-20260809`:** elevation 22.8% → 99.5% (3DEP, 98.2% at 1 m LiDAR) · depth 24.2% (`state_agency` 0 → 3,033) · bathymetry re-key · `regionStats` 24,953 × 5 × 5
- **2026-08-15 — wind:** 47,765 cell-years archived (9,553 cells × 5 winters, 418.4M rows, hash-verified on R2) → 11,114 wind roses at the 250 m gate

#### Deferred
- 🟢 **Corpus by request / lifecycle** — N7b
- ⚪ **1,353 downstate NY bodies still unpurged on dev** — the map draws five whole states, the corpus stops at I-84

## Phase N7b — Corpus lifecycle and the request path
🟢 **Complete** 2026-09-16 · PRs #61 #63 · [plan](./phase-N7b-corpus-by-request.md) · D106–D108 D176–D179

Split out of N7 as a product feature, not a data campaign, and widened at kickoff into the whole
lifecycle: the 25,000-body corpus should settle toward the few hundred that are actually reached and
skated. A body has a **standing** — `active` · `dormant` · `removed` · `unlisted` — derived from
four fields by one function (D176). Only `active` is pushed (notifications, discovery, bounties, the
weather registry, enrichment); everything reachable still draws when zoomed in, and the drawer says
why. Evidence re-activates a machine-shelved body, while a person's dormancy, a `none` ruling and a
removal need a person (D177); the prunes demote, never delete (D178). A seed partitions the stored
corpus by evidence of use and a July cron shelves three idle seasons. Then requests (D179): five
kinds by standing — activate, admit, restore, contest access, takedown — asked from the drawer or
by long-press on unheld water, `admit` resolved live against the 3DHP catalogue, and a moderator
queue whose approve performs the act. *A skater can vouch a lake into the corpus, and an operator
can stand one down.*

#### Deferred
- ⚪ **Cap open asks per lake per kind at create** — the sibling set is unbounded by construction, so a decision drains it in scheduled pages snapshotted at decision time (five review passes to get right); a cap of ~100 would delete `closeSiblings` and the snapshot outright. Trigger: the next defect in that code

#### Owed
- Dev deploy, the seed run (`seed-destinations`), device verification of the request flows

## Phase A07c — Lake corrections
⚪ **Scoped** 2026-09-16 · [plan](./phases/A07c-lake-corrections.md) · D180–D183

The skater says *"this is wrong"* — the lake is two polygons, the boat ramp is a private driveway,
the aerial is off, the lot has no toilets — and today only "no public access" has anywhere to go.
One *Report a problem* sheet in the drawer, launched with context from the put-in row, the amenity
line or the imagery control, files a correction into `contentFlags`, where A06f's dedup already
makes the open-row count the corroboration count; a corrections lane on `/admin/flags` groups by
(target, reason) and puts a lever button on every row that has one. Two calls shaped it: a
correction dedups per *reason* where a flag on content dedups per target (D180), and an operator's
outline sets `geometrySource: 'user'` so the campaign import stops overwriting it (D182) — the first
outline writer being a **union** that draws both halves and offers each original as a bay (D183),
because `merge` was built for duplicates and would delete half the lake. Three of the categories
first scoped turned out to be A07b requests and are not re-built. *A skater can say what is wrong
about a lake, and a moderator can fix it in place and have it stay fixed.*

#### Deferred
- ⚪ **Split** — one row that is really two ponds; most "split" reports are a bay that wants a name → D183, a feat if it outgrows PR 2
- ⚪ **Outline editing (§4.3)** — scoped at build; the union is the only outline writer PR 2 commits to

#### Ruled out
- **A separate `corrections` table** — `contentFlags` already carries the dedup, the queue, the purge, the resolution notification and the rollups; a second table would re-implement all five to keep "moderation" and "data" apart, and the lane split does that

#### Owed
- The five founder calls in the plan's *Open questions* before build

## Phase N8 — The notification pipeline
🟢 **Complete** 2026-09-15 · PRs #52 #53 #55 #57 · [plan](./phase-N8-notification-pipeline.md) · D167–D174

The scoping pass found the real problem: **nothing in the app could read a notification** — six types
were being written and had never been seen. So: the inbox first (web `/notifications`, mobile bell and
tab dot), every declared type gets a producer, every actor-triggered type settles 60 s in the queue and
is re-checked at flush so a retracted thumb never sends (D169), `bounty_answered` to the requester
replacing a misdirected type (D170), `activity_detected` from un-prompted skates with a dedup ladder,
a per-user digest zone, and the season-boundary purge. Then the transports (D174): Expo push with
receipt handling, email via Resend with a one-click unsubscribe, and an offline inbox cache. PR 4
fixed the Clerk mirrors that had never refreshed, with change-email and the `user.updated` webhook.
*A skater hears about the things they asked to hear about, on the channel they chose.*

#### Deferred
- ⚪ **Reverse reach index (D172)** — filters candidates, never replaces the polygon test; trigger ~1,000 profiles
- ⚪ **Web push** — no service worker; web is inbox + email

#### Ruled out
- **True-sunset digest timing** — dropped (D173)

#### Owed
- An install of the APK, a real change-email run
- Prod: the webhook endpoint and secret need their own registration

## Phase N9 — A bay is a place
🟢 **Complete** 2026-09-16 · PRs #58 #59 · [plan](./phase-N9-subareas-as-places.md)

Sub-areas become destinations rather than labels: favoritable, with their own put-ins, lots, bounties,
hazards, reports, wind rose and access section, findable in search and drive time, and borrowing what
they don't store from the parent on demand — derive from the parent and the polygon, store only what
is expensive. A report on a bay is a report *on* the bay and a member of the lake; a put-in hidden on
a bay is a separate `hidden` row, not a status. PR 2 clipped bay max depths from the bathymetry
archive. Greptile's pass on PR 1 found bay-scoped features leaking lake-wide, a hidden launch still
drawing, and a cross-page cell dedup gap. *Malletts Bay has its own page, its own depth, and its own
launches.*

#### Data runs
- **2026-09-16 — bay depths:** clipped from the bathymetry archive for every sub-area with coverage (PR #59)

#### Deferred
- ⚪ **Weather shelter index and station-bias study** — scoped at kickoff, post-alpha → [`backlog/weather-shelter-index.md`](./backlog/weather-shelter-index.md), [`backlog/weather-stations.md`](./backlog/weather-stations.md)
- ⚪ **US spellings sweep** → [`features/us-spellings.md`](./features/us-spellings.md)

## Deferred register

Everything deliberately not done, in one place, with what it waits on. When an item ships, mark it 🟢
with a pointer rather than deleting the row; when a blocker clears, it moves into a phase. Verify
against code before trusting a row — two entries in the old register had quietly shipped. The
long-form register this table replaced is archived verbatim in
[`backlog/deferred-register-archive.md`](./backlog/deferred-register-archive.md).

| Item | Status | Blocked on | Where |
| --- | --- | --- | --- |
| **The prod cutover** — Convex prod init, Clerk prod vars, the corpus and tile URL into prod, Vercel/EAS env, Resend key, the N8 webhook | ⚪ | a founder task; Clerk prod env vars first | [`docs/deployment-and-release.md`](../docs/deployment-and-release.md) |
| Device verification — Phase 8 recorder, 9.5 on-ice mode, N5a/N5b native surfaces, the Layer-3 tile-pack's one on-device check | ⚪ | device access; no owned iPhone | the phases' *Owed* lines |
| Silent background push to a sleeping phone (D54) | ⚪ | a privacy decision + iOS throttling | 9.5 |
| Legal engagement — ToS, privacy, risk-ack enforceability, minor-data posture, deletion wording, the AGPL store exception, takedown wording (Q10 / L1–L4, L11) | ⚪ | a lawyer; one engagement clears most of it | [`08`](./08-legal-feasibility-checklist.md) |
| Forum / Facebook / Google-Group ingestion (Q8 / L5) · AI summarization beyond weather facts (Q9 / L6) · PostHog session replay (L12) · ODbL share-alike (L10) | ⚪ | legal, per item | `08` |
| GPS-provider partner applications — Garmin / COROS / Polar / Health Connect | ⚪ | founder: submit them; weeks of review | [`backlog/partnerships.md`](./backlog/partnerships.md) |
| Watch capture adapters + the watch-wins ingest path (L8) | ⚪ | partner approval | `backlog/partnerships.md` |
| HealthKit adapter · server-tracked recommended caps · a CI GPS replay rig · first-class avatar upload | ⚪ | a trigger each; none urgent | [`backlog/low-urgency-items.md`](./backlog/low-urgency-items.md) |
| N6e PR 4 (phenology) + PR 5 (charts, freeze-up notification) | ⚪ | the nine-season backfill spend | N6e |
| N6g imagery research lanes | ⚪ | the same backfill | N6g |
| N6h Workstream F — radar | ⚪ | nothing; next in N6h | N6h |
| Multi-season weather climatology · paying Open-Meteo (D158) | ⚪ | D153 unlocked it; season two | N6h |
| `centroid` → `representativePoint` stage 2 — the ~100-site code sweep | ⚪ | nothing, and it shouldn't linger | [`features/representative-point-rename.md`](./features/representative-point-rename.md) |
| Phase renumbering — the mechanical PR and the PR-title pass | ⚪ | nothing — N7b landed 2026-09-16 | [`features/phase-numbers.md`](./features/phase-numbers.md) |
| US spellings sweep | ⚪ | same window | [`features/us-spellings.md`](./features/us-spellings.md) |
| Reverse spatial index for notification fan-out (D172) | ⚪ | ~1,000 profiles | N8 |
| Web push | ⚪ | a service worker | N8 |
| GPS-path hazard deduction (Q11 / L9) · pressure-ridge / clearest-side crowd intelligence | ⚪ | path volume + an L14 privacy pass | Phase 8, 9 |
| Decay-magnitude refit — `HAZARD_DECAY`, `decayMultiplier` | ⚪ | a real in-app corpus; `bountyGateEvents` is the input | Phase 10 |
| A dedicated bounties geospatial instance | ⚪ | past the 200-scan cap | Phase 6 |
| Self-hosted ORS — a true 90-min band | ⚪ | a cost/ops call, ~$15–50/mo | [`backlog/self-hosted-ors.md`](./backlog/self-hosted-ors.md) |
| Trail-connectivity widening beyond N6e §0 | ⚪ | the launch side is the ceiling | [`backlog/trail-connectivity-pairing.md`](./backlog/trail-connectivity-pairing.md) |
| The 1,376 unmatched slipways | ⚪ | an afternoon | [`backlog/unmatched-slipways.md`](./backlog/unmatched-slipways.md) |
| `matchBathymetryLakes` (51 GB) / `coveringBodyForPoints` (21 GB) unbounded reads | ⚪ | nothing; the N6d fix pattern applies | N6d |
| 1,353 downstate NY bodies unpurged on dev | ⚪ | a prune run | N7 |
| Gli internal identifiers — `scheme`, `slug`, `@skating/*`, the remote | ⚪ | ride the Clerk Core 3 migration; the scheme is live OAuth | [`backlog/gli-identifiers.md`](./backlog/gli-identifiers.md) |
| `@clerk/clerk-expo` → `@clerk/expo` Core 3 migration | ⚪ | nothing; the package is deprecated outright | `backlog/gli-identifiers.md` |
| `PROFILE_REVEAL_ALL` → `false` before the season | ⚪ | first ice | N6c |
| `RECURRENCE_ADVISORIES_PUBLIC` → `true` | ⚪ | two rollovers of operator reading | N5c |
| Deletion / retention policy copy (L3) | ⚪ | the legal pass | N3/N4 |
| In-app guides · group-skate organizing · rivers as named reaches (D4) | ⚪ | design | — |
| Bathymetry: a curving anisotropy axis · contour crowding · NY statewide coverage | ⚪ | a user complaint about a named lake; a NY source | N6b |
| N6e: radar terrain correction · two-surface ice fractions | ⚪ | the backfill | N6e |
| Strava: a real sandbox upload | ⚪ | a session | Phase 8 |
| The Apple / Play / TestFlight distribution track | ⚪ | the accounts, with the prod cutover | `05` |

**Ruled out, project-wide** (the per-phase reasons are in the entries above): pulling GPS from
Strava (L7) · k-anonymity contributor gating (D58) · Fitbit as a provider · the `appConfig`
runtime-tuning seam · encoded-polyline transport · contours from GLOBathy rasters · true-sunset digest
timing (D173) · tasked commercial imagery · an always-on radar server.
