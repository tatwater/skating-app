# Data model — the map

**The schema is the source of truth:** [`packages/convex/convex/schema.ts`](../packages/convex/convex/schema.ts),
55 tables, with a docblock on nearly every table and field saying what it is and why. This doc is
the **map** over it — the domains, what each table is *for*, how they relate, where the vocabulary
came from, and the modeling rules that bite — so a reader can find the right table before reading
3,500 lines. It does not repeat fields; when a field matters, the schema comment is where it's
explained.

**Kept current by a test.** `packages/core/src/dataModelRegister.test.ts` fails the build if a
`defineTable` in the schema has no row here, or if a vocabulary key in `packages/core/src/types.ts`
isn't mentioned. Add a table → add its line.

## Guiding constraints

- **Safety framing (D3).** No field asserts ice is safe. Reports are observations; `skateQuality`
  and the surface tags describe the *skating surface*, never a verdict; decay fields are confidence.
- **Reports attach to whole water bodies** (D4) — a bay is a member of its parent (A09), hazards
  carry in-polygon geometry.
- **One table for every water body, however it arrived** (D14): OSM/NHD merge, a GPS track, a
  request. We mint the key (D93); every catalog is a claim on it.
- **Reports are always public; no social graph** (D13). The only privacy switch is the profile's.
- **A body has a standing** — `active` · `dormant` · `removed` · `unlisted` — derived from four
  fields by one function, and only `active` is pushed (D176).
- **Nothing is hard-deleted** where a skater could have depended on it: bodies tombstone into
  survivors (`mergedIntoId`), reports anonymize (D62), hazards decay but never vanish.

---

## The map

One line per table: what it's for, and the decision or phase that made it. Grouped by domain.

### People

| Table | For |
| --- | --- |
| `profiles` | one row per person: Clerk mirrors, visibility, role, status, DOB (minor status derived at read), the private home coordinate and its cached isochrones (D11, D18), notification prefs, reputation points, the aggregate opt-out — D41, D50, D58 |
| `pushTokens` | one row per (person, device) that registered for Expo push — A08 |
| `blocks` | a block is also a mute; it never hides a report, only the person — D32, D3 |
| `dataExports` | one row per export request; the bundle lives in file storage — D33/D62 |
| `clientSignalEvents` | per-user rate-limit bookkeeping for the client analytics signal — 07-2 |

### Water bodies and the corpus

| Table | For |
| --- | --- |
| `waterBodies` | the corpus: outline, our key + every catalog's claim, class, name + aliases, area, depth with provenance (D68), elevation, wind rose (D90), display score (A06c §4.2), public-access verdict (A06f), standing fields (D176) — D14, D93–D137 |
| `waterBodyCells` | the ladder-grid spatial index: one row per (body, cell) — the read path every viewport and "near" query walks — D5 as rebuilt in A01 |
| `waterBodySubAreas` | a named region inside one polygon — a bay, an arm — with aliases for the ten spellings of Malletts Bay; a place in its own right since A09 — D60 |
| `waterBodySubAreaCells` | the same cell index for bays — A09 |
| `waterBodyRequests` | a skater asking for a body: activate, admit (resolved live against 3DHP), restore, contest access, takedown — D179 |
| `adminAreas` · `adminAreaCells` | town / county / state polygons and their cells, for the place a point resolves to — Phase 05 |
| `regionStats` | per-state deciles of area, depth, elevation — the comparison basis for generated captions — D70 |
| `bathymetryCoverage` | which bodies have contour tiles and whose credit line to render — A06b |
| `imageryIngestSeasons` | which seasons of Sentinel passes exist in the archive, per body — A06e |
| `importRuns` | one row per ETL run — match rates, rejects, coverage — the durable version of a terminal summary; `/admin/imports` — A06c §6.2 |

### Access

| Table | For |
| --- | --- |
| `putIns` | where you get on the ice: official (OSM slipway, operator) or derived from report points; a hide is a separate row, not a status (A09) — Phase 04, D72 |
| `parkingAreas` · `parkingAreaBodies` | where the car goes, many-to-many with bodies — the join table has to exist because Convex can't index an array — D72 |
| `accessAlerts` · `accessAlertVotes` | "temporarily inaccessible" as a decaying community claim, with each skater's latest word — D73 |
| `accessPhotos` | "is this the right dirt road" — photos of an access point — D88 |

### Reports and the conversation around them

| Table | For |
| --- | --- |
| `reports` | the center of the app: author, body (+ bay memberships), skate window, ice types, thickness readings with method, surface tags, quality, conditions, put-in pin, notes; always public — D4, D13, D21–D25 |
| `reportSubAreas` | one row per (report, bay) — the indexable copy of `reports.subAreaIds` — D175 |
| `photos` | EXIF-stripped on upload, geotag only on opt-in, `placeOnMap` gates pinning — D42 |
| `comments` | threaded, arbitrary depth in data, capped in UI — D21, D25 |
| `reportRatings` | helpful thumbs on reports and hazards → reputation — D17, D50 |
| `waterBodyFavorites` | place-based curation, the D13 stand-in for a follow graph; bays favoritable since A09 — Phase 04 |
| `bounties` | "someone please go look"; a gate decides whether one may open (freshness, weather since) — D10, D17, D44, D56 |
| `bountyGateEvents` | one row per create *attempt*, verdict included, append-only — the analytics input the gate would otherwise throw away — 07-2 |
| `pointEvents` | the reputation ledger: every point, with its reason, so trust is explainable — D17, D50 |

### Hazards

| Table | For |
| --- | --- |
| `hazards` | typed (16 keys), geometried (point / line / area, freeform or a shore band — D67), lifecycled by per-type decay and weather (D52, D56), authored per D51; identity across re-reports (D77–D80) |
| `hazardConfirmations` | the Waze-style votes — still there / gone / can't say — D52 |
| `bodyFeatures` | known seasonal hazards of a body — the ridge that forms off the same point every year; persistent, not decayed — D53 |
| `hazardRecurrence` | precomputed cross-season recurrence: what was reported here, in how many of the last N winters — D77, D78 |
| `recurrenceQueue` | the recurrence job's scratch queue, one body per step — A05c §3.4 |

### Tracks

| Table | For |
| --- | --- |
| `gpsActivities` | a recorded skate — ours (`native`); one day an imported GPX (backlog) or a watch adapter's — resolved to the body it was on (D44), linked to a report, the substrate of the aggregate layer (D58) — Phase 08 |
| `activityConnections` | a person's link to a provider, tokens included; Strava push today — D24 |
| `oauthStates` | short-lived OAuth `state` nonces — Phase 08 |

### Weather

| Table | For |
| --- | --- |
| `weatherCells` · `weatherCellSyncs` | the registry of the grid cells the corpus actually occupies, two tiers (browse / filter), and the memory of each tier's last materialization — D152, D161 |
| `bodyWeatherCells` | which filter-tier cell each body and bay sits in — the reverse lookup discovery needs — D159 |
| `weatherDays` | daily observations — an **archive**, not a cache; lazily backfilled 92 days on first open — D153 |
| `weatherHours` | hourly, for the timeline chart only — A06h §4 |
| `weatherCellDigests` | one rolling digest per filter cell — what weather-first discovery reads, so it never scans the report table — D159, D165 |
| `weatherCache` | the per-window "weather since" reduction the strip and the decay multiplier read — Phase 10, D56 |
| `weatherForecastCache` | the short forward forecast for the drive decision — D140 |
| `weatherAlerts` | cached NWS active alerts — the advisory layer, never a physics input — D74 |
| `externalApiCalls` | outbound calls per provider per UTC day — the counter D158's paid-plan trigger reads |

### Notifications

| Table | For |
| --- | --- |
| `notifications` | the inbox — every type a person can hear about, read state, the thing it points at — D167 |
| `notificationQueue` | the coalescing + settle queue: actor-triggered types wait 60 s and are re-checked at flush so a retracted thumb never sends — D169 |

### Moderation and operations

| Table | For |
| --- | --- |
| `contentFlags` | abuse and safety reports on any target; dedup per target *is* the corroboration count (A06f); corrections dedup per reason (D180) — D32 |
| `moderationActions` | the audit log: who did what, why — D37 |
| `supportTickets` | the in-app support inbox, emailed to the operator — D37 |
| `metricSnapshots` | pre-aggregated numbers every `/admin` chart reads, one row per (metric, day) — charts never scan the corpus — 07-2 |

---

## Relationships

- A **profile** authors reports, comments, hazards, bounties, ratings, flags, requests, and
  records tracks; favorites bodies and bays; holds tokens, connections, and prefs.
- A **water body** has cells, sub-areas (each with cells), put-ins, parking (via the join),
  access alerts and photos, features, recurrence, bathymetry coverage, imagery seasons, one
  weather cell per tier, and a standing. Reports, hazards, bounties, favorites, and tracks point at
  it — or at a bay, which is also a member of it.
- A **report** belongs to one body (+ any bays it touches via `reportSubAreas`), has photos,
  comments, ratings, an optional track, and bundles the hazards filed from the ice (D55).
- A **hazard** has confirmations, may be promoted to a body feature, and is matched to prior
  seasons' hazards by identity; its decay reads the body's weather.
- **Weather** hangs off cells, not bodies: a body → its cell → the cell's days, hours, digest.
- **Notifications** point at whatever they're about; the queue feeds the inbox; tokens deliver it.
- **Moderation** targets anything by (type, id); actions log every ruling.

---

## Vocabulary

The constants are code — `packages/core/src/types.ts` (`ICE_TYPES`, `SURFACE_TAGS`,
`HAZARD_TYPES`, `WATER_BODY_CLASSES`, `SKATE_QUALITIES`, `THICKNESS_METHODS`) and
`hazardDecay.ts` (`HAZARD_DECAY`, the per-type tiers) — and the UI labels sit beside them. What
this section keeps is **where the words came from and why they are what they are**.

**The terms are the community's.** Ice types and surface tags use the vocabulary of the Nordic
Skater reference sites, which the alpha crew uses colloquially, and were validated against 1,197
real posts from the regional groups (L5a, 2026-07-13): every ice type and surface tag in the list
appears in the corpus, `black_ice` and `snow_covered` dominate, and the corpus supplied the
hazard additions of 2026-07-21.

- **Ice types** (what the ice *is*): `black_ice` · `snow_ice` · `white_ice` · `gray_ice` ·
  `shell_ice` · `sandwich_ice` · `crust_ice` · `pack_ice` · `plate_ice` · `candled_ice`.
- **Surface tags** (how it *skates*): `glass` · `smooth` · `rough` · `bumpy` · `orange_peel` ·
  `rubble` · `cracked_surface` · `snow_covered` · `drifted` · `slushy` · `wet` · `overflow` ·
  `frozen_chop` · `windswept`.
- **Skate quality**: `great` · `good` · `fair` · `poor` — the coarse rating alongside the tags
  (both kept, D25). **Thickness method**: `measured` · `estimated`, and the estimate is
  lower-trust by construction.
- **Water body class** (stored): `lakePond` · `reservoir` · `bay` · `river` · `wetland` ·
  `unclassified` — the D109 vocabulary; the earlier eight-value list (`lake`, `pond`, `stream`,
  `marsh`, `other`…) was migrated one-way, and `lake` + `pond` → `lakePond` was its only lossy
  step. Skaters can pick five of the six; `unclassified` is the corpus admitting it doesn't know.
- **Hazard types — exactly one per hazard, 16 canonical keys**, each with a decay tier in
  `HAZARD_DECAY` (calibration in
  [`research/hazard-decay-calibration-and-behavior.md`](./research/hazard-decay-calibration-and-behavior.md)):
  `open_water` · `thin_ice` · `overflow_slush` · `drain_hole` · `wind_hole` · `slush_hole` ·
  `thawed_rotten` · `ridge_crossing` · `wet_crack` · `drilled_hole` · `shell_area` ·
  `pressure_ridge` · `ice_heave` · `spring_current` · `gas_hole` · `reef_hole`.
  - **Canonicalized 2026-07-21 (09a):** the earlier enum stored slash-pairs as separate keys
    (`open_water` *and* `lead`, `ice_heave` *and* `buckling`, `inlet_outlet_current` *and*
    `spring`), so `Record<HazardType, HazardDecay>` couldn't typecheck and two keys could disagree
    about their own tier. Each pair is one key with a two-part label; the alias lives in the UI.
  - Terms worth knowing: `wet_crack` is a *working* crack (dry cracks are normal); `drilled_hole`
    is man-made only (augers re-skin overnight and stay weak for days); `thawed_rotten` is the
    thawed *zone* — about half of ice fatalities involve thaw — and **cold weather must not
    auto-heal it** (the overnight-skin trap; shortest decay of all); `gas_hole` and `reef_hole`
    recur at the same spot every year, so they're the natural `bodyFeatures` candidates (D53);
    `ridge_crossing` is a *passage* marker that reuses the hazard machinery but renders as
    positive-but-cautious (*still crossable / dicey now / ridge closed*), and is the most volatile
    thing on the map.
- **Standing**: `active` · `dormant` · `removed` · `unlisted` (`STANDINGS`, D176), with dormancy
  and removal reasons alongside.

---

## Derived, not stored

Values the app shows that no table holds raw — each computed at read time from the tables above,
so they can't go stale:

- **Minor status** from `dateOfBirth` (D41); the 18th birthday needs no job.
- **Standing** from four fields in one order (`standingOf`, D176).
- **Trust class** — the cosmetic chip, never the number — from reputation points
  (`trustClassFor`, D50); the number itself is a sum over `pointEvents`.
- **Drive-time band** (`30 | 60 | 90 | null`) by point-in-polygon against the profile's cached
  isochrones (D18); notification fan-out is the reverse walk, paged and scheduled (A01).
- **Display score and minimum visible zoom** from area, boost and the access verdict (A06c §4.2,
  A06f) — the prominence ladder, clamped.
- **Hazard confidence** from the last confirmation, the type's decay curve, and the body's
  weather since (D15, D52, D56) — never to zero (D3).
- **Weather since** — the one reducer over `weatherDays` / `weatherCache` that the strip, the
  decay multiplier, the bounty gate and the contradiction signal all read
  ([`docs/weather-since.md`](../docs/weather-since.md)).
- **Derived put-in markers** — clustered report points, snapped to shore, merged with official
  put-ins minus hidden ones (Phase 04, A09).
- **Latest** — global, newest event first, distance-weighted from home; a block de-emphasizes,
  never hides (D165, D3).
- **Corroboration** — reports on the same body in a window whose ice descriptors agree; no
  stored edges (D50). **Contradiction** is a signal, never a subtraction.

---

## Modeling rules that bite

The ones this schema learned the hard way; each has a longer story in the phase doc it came from.

- **Spatial reads walk our own cell index** (`*Cells` tables), never a component — the geospatial
  component's reads scaled with result size and one load read 105 GB (A01, A06d). **Bound every
  corpus-wide read** at the write or the query, and pass `marginMeters` to `listedBodiesNearCoord`.
- **An index on an optional field is not sparse**: `undefined` sorts first, so a bare `lte()`
  range matches every row lacking the field. Filter the presence explicitly.
- **Schema changes go widen → deploy → backfill → narrow** — a push validates existing rows.
  Field names are ASCII.
- **Convex can't index an array**, so a many-to-many gets a join table (`reportSubAreas`,
  `parkingAreaBodies`, `bodyWeatherCells`) — and the join is written in the same mutation as the
  array, or they drift.
- **Precompute what discovery reads** (`weatherCellDigests`, `hazardRecurrence`,
  `metricSnapshots`); a query that scans the report table to answer a filter is the read-path
  failure this repo has had twice.
- **Archive vs. cache is a decision, not a name**: `weatherDays` is kept forever and backfilled;
  `weatherCache` expires. Say which in the docblock.
- **Append-only event tables keep the negative cases** (`bountyGateEvents` records the refusals;
  the gate had to stop throwing for that to be possible) — you can't analyze what you discarded.
- **Merges tombstone, imports never delete**: a duplicate becomes `mergedIntoId`, and a separate
  explicit step moves reports, tracks, favorites and hazards to the survivor.
- **Offline drafts are the client's** (`expo-sqlite`), idempotency-keyed; the server sees a report
  once, however many times the flush retries (D9, D30).

*Every modeling question the original draft listed as open has been decided; the decisions are the
`D#`s cited above. Product-level open questions are [`02-open-questions.md`](./02-open-questions.md).*
