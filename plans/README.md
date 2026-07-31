# Planning docs

> **Where things stand (2026-07-30): every roadmap phase — 0 through 10 — is built**, and the
> post-roadmap run **N1 → N2 → N3/N4 → N5a → N5b** has shipped on dev (read-path durability, sub-areas
> + the lake editor, account lifecycle, seasons, hazard authoring, lake depth).
> Phase 8 was the last numbered phase. Everything still unbuilt is *explicitly* deferred and registered in
> [`07-roadmap.md`](./07-roadmap.md) → *Later / deferred*, each phase doc's *Out of scope / deferred*
> section, [`02-open-questions.md`](./02-open-questions.md), and
> [`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md). Non-feature work still
> outstanding: the **prod cutover** (Convex prod uninitialized), **device verification** of the native
> surfaces, and the **N6a depth ETL run** (written and tested; needs three third-party downloads).
> **N5c, N6c and N6d were scoped 2026-07-30** (hazard identity; lake profiles; access points), and
> **N6e — satellite imagery in the app — was scoped 2026-07-31**; these are the only *unbuilt* phase docs
> — alongside **N6b**, which is designed and deliberately unbuilt.
>
> ⛔ **The N6a depth ETL is gated 2026-07-31 (founder call): do not run it until N6c is complete**, so the
> elevation pass rides the same run. Folding it in costs one column; doing it afterwards costs a second
> full pass over 116,070 bodies. Note there are **two** ETL passes in flight with different cargo — the
> depth run carries elevation, the canonical water re-import carries the geometry stats (D85). The
> inventory is in [N6a's ordering gate](./phase-N6a-lake-depth.md#before-the-etl-runs--the-ordering-gate).
>
> **Every open question in N6a–N6d was answered by the founder on 2026-07-31**, adding decisions
> **D81–D88**. The four that changed a build: **there is no contour toggle** (D81 — contours follow the
> detail view, and satellite becomes the map's only switch); **shoreline is measured on the source
> geometry, not our simplified copy** (D85); **approach distance is routed via OpenRouteService
> `foot-hiking`**, the account Phase 4 already uses (D87); and **the summary card carries a consensus
> quality mark after all** (D86, reversing N6c's own recommendation).

This directory is the design record for the app: the vision, the decisions (with their
*why*), the open questions, and the build sequence. It's meant to be read top-to-bottom
the first time, then used as a reference (decisions are numbered `D#`, open questions
`Q#`, and cross-referenced throughout).

## Read in this order

| # | Doc | What it covers |
|---|---|---|
| 00 | [Vision](./00-vision.md) | The problem, the product, the principles, app structure. **Start here.** |
| 01 | [Decisions log](./01-decisions.md) | ADR-style log of every decision (`D#`) and its rationale. |
| 02 | [Open questions](./02-open-questions.md) | What we're deliberately deferring (`Q#`), with current leanings. |
| 03 | [Tech stack options](./03-tech-stack-options.md) | Service/tooling menu with pros/cons; the locked default stack. |
| 04 | [Integrations](./04-integrations.md) | GPS providers, weather, email — setup + ToS watch-outs. |
| 05 | [Accounts & credentials](./05-accounts-and-credentials.md) | External accounts to register, ordered by lead time. |
| 06 | [Data model](./06-data-model.md) | Conceptual schema for every entity + vocabulary. |
| 07 | [Roadmap](./07-roadmap.md) | Phased build sequence; each phase is independently useful. |
| 08 | [Legal & feasibility checklist](./08-legal-feasibility-checklist.md) | Register of everything deferred behind a legal / ToS / consent / feasibility gate. |

**Phase build plans** (the *how* for a phase, linked from the roadmap):
- [Phase 1 — Water-body data](./phase-1-water-bodies.md) — OSM ETL, import, `listed`
  refactor, read-only map (Vermont pilot).
- [Phase 2 — Map + reports (the MVP)](./phase-2-map-and-reports.md) — interactive map,
  tap-to-detail, report create/read, photos, D49 display scoring. **✅ Complete (2026-07-16):** web
  MVP (§A–§E) + mobile online loop (§F1) + offline draft queue (§F2) + docs (§G).
  *(User-created bodies + dedup moved to Phase 8 — GPS-backed.)*
- [Phase 2.5 — Regional expansion](./phase-2.5-regional-expansion.md) — the ops runbook for
  Workstream H: per-state ETL (NY/VT/NH/ME/MA, NY clipped downstate), a multi-state `.pmtiles` on
  Cloudflare R2, and the (last) map-bounds widening. Pure data + infra, no app features.
  **✅ Complete on dev (2026-07-15); prod deferred.**
- [Phase 3 — Community + safety](./phase-3-community-and-safety.md) — threaded comments,
  public/private profiles + search, block/mute, flag/report, minimal moderator hide/remove.
  **✅ Complete on dev (2026-07-16, PR #17); prod deferred.**
- [Phase 5 — Newsfeed](./phase-5-newsfeed.md) — global cross-body feed by skate-end time,
  point-derived place labels (`adminAreas`), tap-to-drawer, photo carousel.
  *(Brought forward ahead of Phase 4.)* **✅ Complete on dev (2026-07-17, PR #18); prod deferred.**
- [Phase 4 — Drive-time + dynamic filtering](./phase-4-drive-time-and-filtering.md) — favorites,
  read-time isochrone bands, persisted feed filter row, notification coalescing queue + 8pm digest,
  put-ins + directions, mobile offline read-cache. **✅ Complete on dev (2026-07-18, PR #19); prod
  deferred.**
- [Phase 9 — Hazards](./phase-9-hazards.md) — geometry-per-type hazard authoring (point+radius /
  line / render-only polygon), per-type decay + three-tier "healing" confirmation, persistent known
  seasonal `bodyFeatures`, client-side on-ice proximity alerts (offline-capable). *(Pulled ahead of
  Phase 6 — safety content before reputation, 2026-07-18.)* **✅ Merged to `main` (PR #20, 2026-07-21),
  deployed to dev, Android-emulator smoke-tested; prod deferred.** Decisions **D51–D55** locked
  (D51/D54 amended + D55 added at build kickoff). The Layer-3 offline basemap tile-pack was **dropped**
  (native spike; findings in the phase doc).
  - [Phase 9 — Hazard research](./research/hazard-decay-calibration-and-behavior.md) — calibrated `HAZARD_DECAY` table +
    per-type behavior evidence (corpus + lakeice.info), expanded taxonomy, corrected Phase-10 weather
    signs. **✅ Research done 2026-07-21.**
  - [Phase 9.5 — On-ice live alerting](./phase-9.5-on-ice-alerting.md) — the deferred **D54 Layer 2**
    fast-follow: `expo-notifications` (local only) + session-scoped background location + course-over-
    ground directional projection, plus `?action=confirm`, hazard author line, clip-footprint-to-body,
    auto-suggest skate times, and a Layer-3 tile-pack retry. **✅ Merged to `main` (PR #21, 2026-07-22),
    dev deploy + prod deferred.** Layer-3 `file://` pmtiles path built flag-off, awaiting one on-device check.
- [Phase 6 — Bounties + trust score](./phase-6-bounties-and-trust.md) — request-a-report bounties
  (post/browse/fulfill, separate `bountyPoints` currency); the boost-only **trust score** (D50) rendered
  as a cosmetic class chip + `TrustAvatar` ring (never a raw number); polymorphic helpful/unhelpful thumbs
  over reports **and** hazards; badges; and the corroboration-gated **recommended** filter-breaking feed.
  *(Built after Phase 9 — safety before reputation.)* **✅ Complete on dev (2026-07-22); prod deferred.**
- [Phase 10 — Weather-since strips + weather-driven hazard decay](./phase-10-weather.md) — a live
  Open-Meteo **forecast-`past_days`** fetch + `weatherCache` (fetched on drawer-open), the plain-text
  **weather-since strip** on aging reports **and hazards** (D19), **weather-driven hazard decay**
  (`decayMultiplier` + `effectiveAge`, precomputed for the offline on-ice alert — D52/**D56**), and three
  deferred tasks the fetch unblocks (report conditions auto-fill; the Phase-6 corroboration
  **contradiction signal** → conflicting-reports disclosure + the new **D57** granular posting-permission
  lever, never a trust subtraction; and the decay-based **bounty-freshness** score).
  *(Auto-suggest skate times already shipped in Phase 9.5.)* **✅ Merged to `main` (PR #23, 2026-07-23),
  deployed to dev; prod deferred.**
- [Phase 7 — Operator surface](./phase-7-operator-surface.md) — the role-gated `/admin` route tree in the
  web app (D37): moderation work queues (flags with an `unsafe_false_report` priority lane, user admin,
  water-body dedup/review, support inbox), in-context moderation across the app, ban/suspend + granular
  posting permissions (D57) + water-body merge, a read-only **config control-room** pairing every tunable
  magic-number with the chart that tunes it, in-house Convex analytics, and Resend operator alerts (D38).
  Mobile-responsive but web-only. **✅ Complete on dev (2026-07-24)** — PR #24 (operator core) + PR #25
  (analytics & tuning); prod deferred. The config surface shipped **read-only** (constants stay in
  `@skating/core`; edit = redeploy).
- [Phase 8 — Native track capture + Strava push](./phase-8-native-capture.md) — the A→B→C pipeline:
  a native in-app GPS **recorder** (A), **our own** track store + resolve-to-lake + the aggregate
  tracks layer (B), and **Strava push** via `activity:write` (C). Plus user-created water bodies from
  a trusted path + match-on-create dedup (D14/D36, moved here from Phase 2) and unified report
  freshness (**D59**). The old "pull tracks *from* Strava" plan is **dead** — Strava's Nov-2024 terms
  forbid cross-user display (L7). New decisions **D58** (aggregate-track privacy: publish-is-consent,
  not k-anonymity) and **D59**. **✅ Complete on dev (2026-07-24); prod deferred** — still
  **device-unverified**.
**Next-phase candidates** (the post-roadmap register in 07 → *Later / deferred*):
- [N1 — Read-path durability](./phase-N1-read-path-durability.md) — the ladder-grid spatial index
  replacing `@convex-dev/geospatial` (retired entirely), `adminAreas` containment made exact, and a
  full `.collect()` triage including moving the notification fan-out off the report-create write
  path. **✅ Complete on dev (2026-07-26); prod deferred.** Measured against the real 116k-body
  corpus — the numbers live in the doc.
- [N2 — Lake editor + sub-areas](./phase-N2-lake-editor-and-subareas.md) — named bays and reaches as
  first-class sub-areas with alias search, plus the operator lake editor. Decisions **D60**/**D61**.
  **✅ Complete on dev (2026-07-26); prod deferred.**
- [N3/N4 — Account lifecycle](./phase-N3-N4-account-lifecycle.md) — the three-bucket deletion model
  (**D62**), data export, and the hygiene crons that keep both honest. **✅ Complete on dev
  (2026-07-27, PR #29); prod deferred.**
- [N5a — Seasons](./phase-N5a-seasons.md) — seasonal visibility and the per-lake season filter
  (**D63**), the passage-marker lifecycle inversion (**D64**), the `never_existed` verdict and named
  confirmers (**D65**), a departed skater's photos split on evidential value (**D66**), and the
  departed-user redaction that the D62 *second* amendment turned from erasure into redaction.
  **✅ Complete on dev (2026-07-28); prod deferred** — still **device-unverified**.
- [N5b — Hazard authoring UX](./phase-N5b-hazard-authoring.md) — the geometry/input half of the old
  N5 entry, kept separate from N5a on purpose: N5a's risky half is a visibility change, N5b's is an
  authoring change. Freeform areas (the last of D51's three primitives) and snap-to-shoreline
  (**D67**). **✅ Complete on dev (2026-07-29); prod deferred** — still **device-unverified**.
- [N5c — Hazard identity](./phase-N5c-hazard-memory.md) — one clustering primitive read through two time
  windows (**D77**): within a winter it collapses duplicate pins so corroboration stops splitting
  (**D80** — prevent, pool, render, and merge reversibly on D36's tombstone pattern); across winters it
  becomes recurrence, ranked promotion suggestions and body-level "ice history" advisories that stay
  admin-only until they clear a tunable bar (**D78**). Also **D79** (moderators author body features
  directly, which nothing could do before), a **D53 amendment** (supersession is a backlink, not a hiding
  mechanism — a promoted hazard stays visible in every season it was reported), and the
  `shallow_bay_early_thaw` → `shallow_early_thaw` rename. **✅ Built 2026-07-31, both halves** — the
  within-season one as PR #34, the cross-season engine on `phase-n5c-recurrence` (unpushed). The
  skater-facing advisory ships **dark**, by design. Merges two
  founder asks that turned out to be one problem, and answers the old three-season corpus gate rather
  than waiting it out.
- [N6a — Lake depth](./phase-N6a-lake-depth.md) — the body-level depth attribute D56 was designed around
  and never got, as a provenance-carrying precedence ladder (**D68**: operator → LAGOS-US → HydroLAKES →
  GLOBathy), plus the shallow decay consumer that makes it mean something (**D69**: shallowness amplifies
  the thaw response only, never the cold one). **✅ Built + on dev (2026-07-30); prod deferred** — the ETL
  itself is written and tested but **not yet run** — and is now ⛔ **gated on N6c completing** (2026-07-31).
- [N6b — The bathymetry layer](./phase-N6b-bathymetry-layer.md) — measured state-agency isobaths as a
  PMTiles overlay, VT + NH first. **📋 Designed, deliberately unbuilt.** Split from N6 at N6a's
  kickoff; carries the finding that GLOBathy's rasters are a distance transform and must never be drawn.
  **All six open questions answered 2026-07-31**: **D81** (no contour toggle — contours follow the detail
  view, and the map's only switch is satellite), **D82** (bathymetry is context, not counsel — no safety
  copy at all, which dissolves what this doc called its hardest part), **D83** (native intervals and
  units, never resampled).
- [N6c — Expanded lake profiles](./phase-N6c-expanded-lake-profiles.md) — what N6a's depth numbers were
  missing: elevation, long axis, shoreline, a 16-bearing **wind-fetch profile**, a generated per-lake
  caption, reference links that cover all 116,070 bodies *because* they aren't stored (**D70/D71**), and
  — folded in 2026-07-30 out of the deferred register — the **per-body map summary cards**.
  Also **D74** (NWS alerts alongside Open-Meteo, never blended), **D75** (satellite ships as a Copernicus
  deep link — the licence blocker is resolved), **D76** (in-app browser, never a WebView).
  **All five open questions answered 2026-07-31**, adding **D85** (geometry stats measured pre-simplification
  — which moves them onto the *canonical water re-import*, a different pass from the depth run) and
  **D86** (the card's quality consensus ships as a graded mark, never a word). Also in: a short forward
  forecast, free because we already fetch and discard those hours.
  **📋 Scoped 2026-07-30, unbuilt.** ⛔ It now *gates* the unrun N6a depth ETL rather than merely wanting it.
- [N6d — Lake access points](./phase-N6d-lake-access-points.md) — parking modelled apart from put-ins so
  directions stop routing cars to hike-in shorelines (**D72**), named access points derived from a second
  OSM pass, and access blockers as **decaying community alerts rather than notes** (**D73**).
  **All four open questions answered 2026-07-31**: **D87** (approach distance routed via OpenRouteService
  `foot-hiking` — Phase 4's existing account, and it returns elevation gain — plus the Hike-In chip),
  **D88** (photos ride the existing posting permission), and a **D72 amendment** making `parkingAreas`
  many-to-many, because the association radius caps *inference*, never a human's assertion.
  **📋 Scoped 2026-07-30, unbuilt.** Split from N6c at scoping; independent of it.
- [N6e — Satellite imagery in the app](./phase-N6e-satellite-imagery.md) — the map's one layer toggle,
  swapping the base map for a photograph while hazards, skate paths and access points stay drawn
  (**D81**, second half). **D84** splits it into two tiers with different jobs: **public-domain USGS/NAIP
  aerial** (0.6 m, no key, no quota — ships v1, and it's what makes the access points checkable) and
  **Sentinel-2 recent-ice** (10 m, quota-bound, gated on evidence that reads concentrate).
  **📋 Scoped 2026-07-31, unbuilt.** Split from N6c's B3 at the founder's ask; the deep link (D75) ships
  in N6c either way.


## How these fit together

- **Vision (00)** sets the principles. Everything else must serve them — especially
  the **safety-first, non-authoritative** principle (D3).
- **Decisions (01)** is the source of truth. When something is "decided," it lives here
  with a `D#` and a rationale. Other docs *reference* decisions; they don't re-argue them.
- **Open questions (02)** holds what's not yet decided. When a `Q#` is resolved, it
  becomes a `D#` and moves to 01 (02 keeps a pointer).
- **03–06** are the "how": stack, integrations, accounts, and schema.
- **Roadmap (07)** sequences the work into shippable phases.

## Conventions

- **`D#`** = a decision (see 01). **`Q#`** = an open question (see 02).
- These are living documents. If a decision changes, update its `D#` entry (and note
  what changed) rather than deleting the history — the *why* is the point.
- Nothing here is final Convex code; the data model is schema-flavored pseudocode meant
  to be reacted to.
