# Phase 9 — Hazards

> **Roadmap:** [`07-roadmap.md`](./07-roadmap.md) → Phase 9. This is the detailed build plan, in the
> style of the Phase 1/2/2.5/3/4/5 docs.
>
> **What this phase is.** The safety-content surface the MVP has been missing: skaters can mark
> *localized dangers* (open water, pressure ridges, thin ice, springs, …) on a water body, those
> hazards **age per type** and can be **confirmed/cleared** by later skaters, permanent risks become
> durable **body features**, and skaters actually on that ice get a **client-local alert** — all
> honoring "no live GPS server-side" (D12) and "never assert ice is safe" (D3). It completes what a
> report/lake *looks like* before Phase 6 layers reputation on top (sequencing call, 2026-07-18).
>
> **Status:** ✅ **Merged to `main` (PR #20, 2026-07-21), deployed to the dev Convex deployment, and
> smoke-tested on the Android emulator.** Tests green. Live-skating features (the on-ice watcher, Layer-1
> banners) are not yet exercised on a real device — that waits for a deeper QA pass after more phases
> land. Decisions settled 2026-07-18 (**D51–D54**), calibrated by the 2026-07-21 research pass, and six
> build-kickoff gaps resolved 2026-07-21 (see *Calls made at build kickoff* below) — which amended
> **D51** and **D54** and added **D55**. Schema deltas are in [`06-data-model.md`](./06-data-model.md).
> Prior phases are on dev; prod deferred. **The Layer-3 offline basemap tile-pack was dropped** during
> the build (native spike — findings recorded below); it was **retried in Phase 9.5** via a `file://`
> pmtiles path, built flag-off and awaiting one on-device confirmation.
>
> **Fast-follow — ✅ done.** The deferred **D54 Layer 2** on-ice live-alerting bundle (plus the smaller
> deferred threads: `?action=confirm`, the reporter/author line, clip-footprint-to-body, and auto-suggest
> skate times) shipped as its own build plan — **[`phase-9.5-on-ice-alerting.md`](./phase-9.5-on-ice-alerting.md)**,
> ✅ **complete 2026-07-22** (branch `phase-9.5-on-ice-alerting`; pending PR + dev deploy). The deferred
> items below are annotated inline with what 9.5 delivered; **silent-push stays deferred** even so.
>
> **Prerequisites already in place.** The F2 offline substrate hazards depend on is **built**: the
> "Layer 2" body-reference cache (`apps/mobile/src/lib/offlineBody.ts` pure resolver +
> `bodyCache.ts` sqlite glue) is factored as a reusable module *explicitly for Phase 9 hazard capture*,
> and `bodyCache.ts` is already "designed to gain a tile-pack column later." `adminAreas`
> (place labels, Phase 5) and the spatial-index machinery (Phase 1/5 — then `@convex-dev/geospatial`,
> since N1 the ladder-grid cell tables) are live. The
> **Layer 3 offline basemap tile-pack** was the one genuinely-unbuilt piece — a native spike — and it
> was **timeboxed and dropped from this phase** (findings below); the online-first degrade mirrors F2
> report capture, and on-ice capture never depended on the basemap in the first place.

Decisions referenced as D#; see [`01-decisions.md`](./01-decisions.md).

---

## Decisions locked this session (2026-07-18)

These were resolved in the Phase 9 planning discussion and promoted to `01-decisions.md` as **D51–D54**.
Short form here; full rationale in the decisions doc.

- **D51 — Authoring: geometry-per-type, dual paths, both platforms.** Point+radius (default blobs),
  polyline (linear), polygon (opt-in advanced). Standalone quick-flag **and** in-report; web **and**
  mobile. Fuzzy/advisory render (D3). Minors treated uniformly for now (`TODO(16+)` on the create gate,
  D41). Consensus-render + GPS negative-evidence designed-for but deferred (post-density / Phase 8+).
- **D52 — Per-type decay + three-tier healing confirmation.** Tunable `HAZARD_DECAY` tiers A–D;
  confirmations are *still here / healing but unsafe / fully healed & safe* (only the last removes;
  "healing but unsafe" keeps the pin). Weather-driven dynamic decay documented for Phase 10.
- **D53 — Known seasonal body features.** Springs/current, constrictions, bridges/narrows, recurring
  ridges → persistent `bodyFeatures` (always-shown, no decay). Promotion/demotion is an admin action
  (Phase 7).
- **D54 — On-ice alerts, client-side.** Server syncs hazard *data*; each phone evaluates its own GPS.
  Layers 0–1 (silent sync + on-ice proximity alert whose confirm-gate *is* the confirmation) ship in
  v1; Layer 2 (directional, opt-in live "on-ice mode") + server-push-to-sleeping-phone deferred.
  Confirm/removal thresholds (1 / 2) are admin-tunable, no reputation yet.

---

## Calls made at build kickoff (2026-07-21)

Six gaps surfaced when the plan was audited against the actual codebase. All resolved with the founder
before any code was written; each is folded into the sections below and promoted to `01-decisions.md`
where it amends a decision.

| # | Gap found | Call |
|---|---|---|
| 1 | `hazards.type` shipped as `v.array(...)`, but per-type decay/geometry/copy all assume one type | **Single `type`.** Ambiguity exactly where safety math must be exact (D52 / `06-data-model.md`) |
| 2 | Research `HAZARD_DECAY` keys ≠ shipped `HAZARD_TYPES` — `Record<HazardType,…>` wouldn't compile | **Collapse slash-pairs to 16 canonical keys** with two-part display labels (`06-data-model.md`) |
| 3 | Hazards had only `status: active\|archived` — no moderation axis, so a mod-hide looked like "healed" | **Add `moderationStatus`** as a separate axis (D3: a mod action must never read as a safety verdict) |
| 4 | Layer-1 alerts need `expo-notifications` + a GPS watcher + background location — **none exist** | **Foreground-only in-app banners in v1**, no new native deps; watcher + notifications move to Layer 2 (D54 amendment) |
| 5 | Neither app has any drawing capability | **Point+radius, then polyline, both in this PR**; freeform polygon = schema + render only (D51 amendment) |
| 6 | A hazard geospatial index would repeat the `listInViewport` read-cap fragility | **Hazards render only on the selected/focused body**; no third geospatial instance. Cross-viewport summary cards deferred to the roadmap |

Plus two additions: **multi-photo hazards** (`photoIds[]`, D51) and **D55 — on-ice hazards auto-bundle
into the skater's later report**.

---

## Schema changes (all migration-aware; deltas already in `06-data-model.md`)

- **`hazards`** — change `type` from `v.array(literals(...))` to a **single** `literals(...)` (call 1);
  add `geometryKind: enum(point_radius, line, polygon)`, `radiusMeters?`,
  `bufferMeters?` (line/polygon uncertainty half-width — ridge » crack; 2026-07-21 research),
  `photoIds: ref(photos)[]` (optional, **plural** — highest-value future-skater aid; research),
  `moderationStatus: enum(visible, hidden, removed)` (call 3 — a **separate axis** from the
  `active|archived` lifecycle `status`, so a moderator hiding a bad pin is never mistakable for the
  community clearing a hazard),
  `healingState?: enum(none, healing_unsafe)`. `confirmCount` excludes the author's own confirm;
  `goneCount` counts **only** `fully_healed` verdicts. Confidence (provisional/confirmed) is **derived**
  from `confirmCount ≥ confirmThreshold`, not stored. Per-type decay derived from `type` +
  `lastConfirmedAt` via `@skating/core`.
- **Canonical 16-key `hazards.type` (call 2).** The slash-pairs that shipped as *separate* keys collapse
  to one key each with a two-part display label: `open_water` ("Open water / lead"), `ice_heave`
  ("Ice heave / buckling"), `spring_current` ("Spring / inlet-outlet current", replacing both
  `inlet_outlet_current` and `spring`). Full table in [`06-data-model.md`](./06-data-model.md). This is
  what makes `Record<HazardType, HazardDecay>` typecheck against the research table. `types.test.ts`'s
  enum snapshot lock is updated deliberately as part of the change.
- **Expanded `hazards.type` (2026-07-21 research → [`phase-9-hazard-research.md`](./phase-9-hazard-research.md)).**
  Added volatile holes `drain_hole` / `wind_hole` / `slush_hole` (Tier A), the `thawed_rotten` zone
  (Tier A\*, the #1 fatality cause), persistent natural holes `gas_hole` / `reef_hole` (Tier D →
  bodyFeatures), and the **`ridge_crossing`** passage marker (Tier A\*, positive-but-cautious render,
  relabeled verdicts). `drilled_hole` is now explicitly *man-made only*.
- **`hazardConfirmations.verdict`** — three-tier `enum(still_there, healing_unsafe, fully_healed)`
  (replaces the old binary `still_there | gone`).
- **`bodyFeatures`** (new) — persistent per-body known hazards (D53): `type` (now also `gas_hole` /
  `reef_hole` / `delta` / `shallow_bay_early_thaw` — persistent natural sources, research), `geometry`,
  `radiusMeters?`, `bbox`, `note?`, `addedByUserId`, `promotedFromHazardId?`, `active`.
- **`contentFlags.targetType`** — add `hazard` (mods can hide a bad pin).
- **Indexes:** `hazards` by `waterBodyId + status` (list active per lake); `bodyFeatures` by
  `waterBodyId + active`. **No geospatial instance for hazards (call 6)** — the originally-planned
  bbox-center geospatial index is dropped, because hazards are only ever queried *per body* (the map
  renders them for the selected/focused lake, the mobile cache stores them per cached body, and the
  proximity evaluator runs against that same cached set). *(N1 removed the read-cap fragility this
  reasoned from, but the call stands on its own: hazards are only ever asked for per body.)* A third
  `@convex-dev/geospatial` instance
  would re-enter the read-cap fragility that took two PRs to fix on `listInViewport` (#10/#11) for no
  v1 benefit. Cross-viewport aggregation lives with the deferred **summary cards** roadmap entry.
- **Moderation plumbing:** `FLAG_TARGET_TYPES += 'hazard'`, `MODERATION_TARGET_TYPES += 'hazard'`, and
  new `MODERATION_ACTIONS` for `promote_body_feature` / `demote_body_feature` (the D53 admin actions).
- **No new `notifications.type`** in v1 — Layer-1 alerts are client-local (D54).

Dev's `hazards`/`hazardConfirmations` tables are empty (feature never shipped), so the verdict-enum and
new-column changes are effectively greenfield — **no migration was written or needed**, because there are
no existing rows to migrate. (`packages/convex/convex/` ships zero migration files for Phase 9.) The
implication carries to the eventual **prod cutover**: prod (`diligent-guanaco-965`) has never been
deployed at all, so the schema simply lands with the first deploy; a data migration only becomes a
concern once real hazard rows exist under an older shape, which they never will pre-launch.

---

## `@skating/core` (pure logic first, near-total coverage — D40)

The safety-sensitive math lives here, property-tested, before any UI. **Coverage:** the intent is D40's
100% on the safety math. After the review-remediation pass the package sits at **99.8% statements /
98.19% branch globally**; every hazard module is at **100% statements/functions** and ≥90% branch
(`hazardLayer` 100/90, `hazardGeometry` 100/92 — the residual branches are `?? []` defensive guards on
already-validated input). The `hazardColorExpression` arm order (the D3 "passage never falls through to
danger" invariant) and the `HAZARD_DECAY` table (a literal 16-row snapshot against the research §1
values) are now both explicitly locked by tests. The vitest thresholds remain **global (90 stmts/lines,
90 funcs, 85 branch)**, not per-file.

The modules:

- **`hazardDecay.ts`** — the `HAZARD_DECAY` table (type → `{ tier, freshH, agingH }`, Tiers A–D + the
  A\* very-volatile sub-case; **stored in HOURS**, converted via `hoursToMs` at compare time so the
  Phase-7 admin surface tweaks human-legible integers) + `deriveHazardFreshness(type, lastConfirmedAt,
  now) → 'fresh' | 'aging' | 'stale'`. **Calibrated table + evidence:**
  [`phase-9-hazard-research.md`](./phase-9-hazard-research.md) §1. Property tests: monotonic in elapsed
  time; tier boundaries; a "still here" reset returns to fresh. Also exports **`isHazardVisibleByDefault(
  freshness)`** (the fresh/aging-vs-stale split that decides what shows without "show older") and
  **`hazardTypesInTier(tier)`** (the inverse lookup, used by tests and any tier-scoped copy). **Invariant
  (D3):** decay = confidence, not safety — a `stale` pin still renders (faded) and its copy never implies
  "clear."
- **`hazardLifecycle.ts`** — pure reducers over confirmations. The **authoritative** one is
  `deriveHazardLifecycle(votes, { authorId, createdAt, priorStatus })`, which recomputes a hazard's
  `{ lastConfirmedAt, confirmCount, goneCount, healingState, status }` from the **entire vote set** by
  counting **distinct non-author users' latest verdicts**. This is a Phase 9 review fix: the earlier
  per-vote `applyConfirmation` incremented a stored counter and so couldn't tell two rows came from the
  *same* account — one person could vote `fully_healed` twice (past the re-confirm window, or via an
  offline replay) and hit the removal threshold alone, a single-skater false all-clear, the worst D3
  outcome. Deriving from distinct users makes that impossible by construction *and* makes the confirm
  mutation idempotent (a replayed offline confirmation recomputes the same state). `lastConfirmedAt` is
  the **max** over creation + all votes (monotonic — a late offline "still here" can never age a pin a
  newer vote already refreshed); archival is a **ratchet** (`priorStatus === 'archived'` stays archived).
  `applyConfirmation` remains as the property-tested single-vote *meaning*, `shouldArchive` /
  `isProvisional` unchanged. Encodes: only `fully_healed` counts toward `goneCount`; `healing_unsafe` sets
  `healingState` without archiving; the author's own vote refreshes the clock but moves neither threshold.
- **`hazardGeometry.ts`** — the footprint math. Shipped as `hazardFootprint(shape)` (grow the raw
  geometry by its radius/buffer into the one polygon that is the **single source of truth** for the halo
  drawn, the bbox indexed, and the distance the proximity alert measures — so what a skater *sees* and
  what the app *warns about* can never drift), `pointRadiusShape` / `lineShape` / `defaultShapeForType`
  (construct a shape), `hazardBbox`, `isValidHazardShape` (reject a zero-area footprint), and
  `distanceToHazard(coord, shape)` reusing `geometry.ts` — 0 when inside, and point+radius short-circuits
  to haversine-minus-radius so the watcher loop doesn't buffer a polygon on every GPS fix. *(Named
  `hazardFootprint` / `pointRadiusShape`, not the plan's earlier `pointRadiusToPolygon`.)*
- **`hazardDraft.ts`** — the *authoring* state machine, shared by both platforms: the `HazardDraft`
  union (a circle awaiting a centre / a polyline collecting vertices), `draftForType` +
  `retypeDraft` (primitive and default size follow the hazard's real-world shape),
  `applyDraftMapClick` / `undoDraftPlacement` / `resizeDraft` / `switchDraftKind`, and
  `draftToShape` — the **single** gate deciding a draft is storable, delegating to
  `isValidHazardShape`. A half-drawn line and an unplaced circle are deliberately representable and
  deliberately not submittable: a polyline is captured one tap at a time, so "half a line" is a
  normal intermediate the UI must hold and render, not a crash. Sizing runs off two coarse, non-linear
  **ladders** — `HAZARD_RADIUS_STEPS_M` (`[5, 10, 25, 50, 100, 200, 400]`) and `HAZARD_BUFFER_STEPS_M`
  (`[2, 4, 8, 15, 25, 40, 60]`, bottoming and topping lower because a wide band on a polyline covers a
  *lot* of ice) — stepped by `stepSize` / `resizeDraft`. **This is a real design decision, not an
  implementation detail:** a short discrete ladder is what makes the size control a pair of **−/+
  buttons rather than a slider** — sliders are miserable with gloves on — and it matches the honesty of
  the estimate (an eyeball guess on a lake, not a survey; D3). The rule currently lives only in the code
  comments, so it's recorded here.
- **`hazardProximity.ts`** (Layer 1, client-consumed) — `evaluateOnIceAlert(coord, hazards, alerted)` →
  the set of hazards within alert buffer, split provisional (→ "confirm?") vs confirmed (→ "ahead"),
  minus already-alerted-this-session. Pure so it's testable and identical on web/mobile.
- **`hazardLayer.ts`** — the render transforms, lifted into core rather than mirrored per-app the way
  the water-body layers are: these are the **safety** layers, and a hazard is drawn as the *same
  buffered footprint the proximity evaluator measures*, so "what gets drawn" is decided once and can't
  drift from "what gets warned about." `hazardsToFeatureCollection` / `bodyFeaturesToFeatureCollection` /
  `hazardDraftToFeatureCollection` emit GeoJSON; `hazardFillOpacityExpression` / `hazardColorExpression`
  emit the MapLibre data-driven expressions. The opacity constants live here: **`FRESHNESS_FILL_OPACITY`**
  (`fresh 0.45 / aging 0.3 / stale 0.18` — a stale hazard fades but never drops below a **floor that
  stays legible on a bright screen outdoors**; the fade says "nobody has checked recently," not "probably
  gone") and **`PROVISIONAL_OPACITY_SCALE` (0.6)** (unconfirmed hazards render softer — one person's
  unverified report). Only the palette stays per-app (it comes from each app's design tokens).
- **Copy helpers** — freshness/verdict labels centralized so the D3 "never implies skateable" rule is
  enforced in one place ("was open — may be thinly skinned", not "clear"). **Per-type relabeling:** the
  `ridge_crossing` marker maps the three verdicts to *still crossable / dicey now / ridge closed*, and
  the harvested lakeice vocabulary (*overnight ice, ice sharks, splash-out, meringue ice, ice edge*;
  research §7) makes honest labels easy — "healed" must never read as "safe."
- **`thawed_rotten` special rule (research §5).** Its decay must **not** accelerate on cold (the
  "overnight-ice trap"): a thawed sheet grows a deceptive skin overnight and collapses midday. Encoded
  as a very-short base decay (12h/36h) with a cold-weather multiplier floored at ≥1 for Phase 10.

---

## Convex backend

- **`hazards.ts`** — `create` (standalone **and** in-report; validates `geometryKind`/`radiusMeters`;
  stamps bbox via `@skating/core`; `TODO(16+)` minor gate mirrors `reports.create`) and
  `listForBody(waterBodyId)` (the map layer's query and the set the mobile client caches for offline
  proximity; returns **stale hazards too, annotated not filtered**, so "nobody confirmed lately" never
  reads as "gone" at the API boundary; `includeArchived` flag off by default). Plus what actually
  shipped beyond the plan:
  - **`get(hazardId)`** — a single hazard for its detail drawer, `null` when missing or
    moderator-hidden. *(The plan's map query `getInViewport` was **not built** — there is no
    bbox/viewport hazard query and neither app calls one. Hazards render strictly **per body** via
    `listForBody` (call 6), which is why no third geospatial instance was ever added.)*
  - **`listBundleCandidates`** + exported **`DEFAULT_BUNDLE_LOOKBACK_MS`** (24h) — the D55 auto-bundle
    query: the author's own hazards on a body that aren't attached to any report yet, windowed to the
    skate (or `lookbackMs` of its end when no start is given).
  - **`attachHazardsToReport`** (helper, called from `reports.create`) + `insertHazard` — the two write
    paths that land in a report's `hazardIdsCreated[]` (freshly-created in-report hazards, and the D55
    bundled-in standalone pins), both re-checking ownership server-side.
  - **Moderation is the shared `moderation.setModerationStatus`** (Phase 9 review fix — an earlier
    hazard-only `hazards.setModeration` was removed). `targetType` now accepts `'report' | 'comment' |
    'hazard'`, so the Phase 7 takedown queue has **one** entry point that composes with `resolveFlag`
    rather than a parallel per-entity mutation. It touches only `moderationStatus`, never the
    `active|archived` lifecycle, so a mod hiding a bad pin never reads as the community clearing it
    (D3); hazards skip the contribution-counter bump reports/comments carry.
  - **Flagging is not a `hazards.flag` mutation** (the plan's shape). It goes through the existing
    **`contentFlags`** path with `targetType: 'hazard'` (one line added to `contentFlags.ts`). This is
    the better idiom — a hazard flag is the same moderation object as a comment or report flag, sharing
    one queue and one set of moderator actions, rather than a parallel per-entity flag surface.
  - **Input bounds** (Phase 9 review fix — reports go through `validateReportInput`; hazards had no
    equivalent): `insertHazard` rejects a `description` past `HAZARD_MAX_DESCRIPTION_LEN` (1000) and any
    shape past the `@skating/core` size ceiling; `reports.create` caps `hazards.length +
    attachHazardIds.length` at `HAZARD_MAX_PER_REPORT` (25) so one create can't fan out unboundedly.
- **`hazardConfirmations.ts`** — `confirm(hazardId, verdict, atCoord?, via, observedAt?)`: **upsert this
  skater's single vote** (one row per user per hazard — an invariant), then **recompute** the hazard's
  lifecycle from the whole vote set via `deriveHazardLifecycle` and patch it. The `pointEvents`
  `hazard_confirmed` boost (D50 prep) is awarded **once per user per hazard** — on their first vote, not
  every re-confirm — so laps, verdict changes and offline replays can't farm points. **`CONFIRM_WINDOW_MS`**
  (exported, 12h) now only governs whether a re-vote refreshes the existing row vs. logs a fresh audit
  row; it is **no longer a correctness gate**, because counts derive from distinct users regardless of the
  window (this is what closed the same-account / offline-replay archival holes). **`observedAt` argument:**
  when the skater actually *stood there*, passed in rather than read from the clock and clamped to
  "not in the future," so an offline confirmation flushed hours later still stamps the moment they were
  on the ice (not the moment the queue drained) — the freshness math depends on it. Also exports
  **`listForHazard(hazardId)`** — the confirmation history for a hazard's detail drawer.
- **`bodyFeatures.ts`** — `listForBody`, and **admin-gated** `promote(hazardId)` / `demote(id)` /
  `create` (role check + `moderationActions` audit row; the UI is Phase 7, but the mutations land here so
  hazards can already be promoted by an admin during Phase 9). **Promotion supersedes, it does not
  archive** (Phase 9 review fix): a promoted hazard gets a new `promotedToFeatureId` — a **third axis**,
  distinct from both `status` and `moderationStatus` — so it drops off the map (the feature carries the
  warning now) *without* its lifecycle `status` reading as a community all-clear (D3). `demote` clears
  the supersession, so the source hazard resurfaces intact and the round-trip is lossless.
  `create`/`promote` also validate geometry through the same `isValidHazardShape` gate hazards use.
- **`photos.ts`** — gained **`getHazardUrls`**, the hazard-scoped sibling of `getUrls`: it resolves a
  hazard's photo serving URLs but gates them on the *hazard's* visibility, so a URL (and any coord on it)
  never outlives the viewer's access to the thing that references it.
- **Shared `lib/` extractions (Phase 9 became the second photo-bearing, lake-attached entity, so two
  helpers were lifted out of `reports.ts`/`photos.ts` rather than duplicated):**
  - **`lib/photoAccess.ts`** — `assertOwnedPhotos` (no attaching someone else's photo) +
    `resolvePhotoUrls`. Every photo-bearing entity now shares the *resolver* while keeping its **own**
    visibility gate — which is what makes "a serving URL must never outlive the viewer's access" easy to
    get right and to audit.
  - **`lib/bodies.ts`** — `resolveSurvivor` (follow a D36 dedup-merged body to its surviving row,
    hop-capped against cyclic merge chains), so a hazard and the report it was drawn in can never land on
    two different rows for the same lake.
- **Data-sync for Layer 0 (D54):** `listForBody` is an ordinary reactive query — a subscribed client
  gets new hazards live; the mobile cache upserts them alongside the body polygon it already caches. No
  push infra in v1. *(There is no `getInViewport` — see above; the sync is strictly per-body.)*
- All mutations gate correctly (author/role), write audit rows where moderation-relevant, and are
  `convex-test`ed (auth gating, lifecycle transitions, archive threshold, flag→hide).

---

## Web UI (`apps/web`)

- **Map hazard layer** — render active hazards on the lake map with **fuzzy** styling by freshness
  (fresh full / aging lighter / stale faded) and by `geometryKind` (circle for point+radius, line uses
  `bufferMeters` as its rendered half-width, polygon). **Deliberate deviation from the plan:** stale
  hazards render **unconditionally on the map, at the `FRESHNESS_FILL_OPACITY.stale` floor** — there is
  no map-level "show older" toggle. The show-older affordance lives **only in the `HazardList`** (the
  drawer's textual list, where `isHazardVisibleByDefault` splits current from older). This is the better
  call: hiding a hazard from the *map* because nobody confirmed it lately is exactly the D3 confusion —
  a faded pin still means "someone saw open water here," not "gone" — so the map never removes it, and
  the list (where the distinction is legible in text) is where you choose to expand older markers.
  `bodyFeatures` render always, distinct "known seasonal hazard" styling. **`ridge_crossing` renders as a
  distinct positive-but-cautious *passage* marker**, not a danger halo (research §4).
- **Authoring** — a "Report a hazard" control (standalone) + a hazard step inside the report form
  (in-report). **Three big one-tap presets** (open water / pressure ridge / thin ice ≈ 80% of real
  reports — research §6) with the rest behind "more." Type picker → primitive auto-selected per D51:
  **point+radius** (click to place, stepper/drag to size) then **polyline** (click to add a vertex,
  undo, Done, plus a `bufferMeters` stepper) — both hand-rolled on raw `maplibre-gl`, no draw library
  needed since neither requires vertex dragging. **Freeform polygon is not authorable in v1** (call 5) —
  it renders, but authoring it needs vertex dragging + self-intersection handling and is the primitive
  D51 already calls opt-in/advanced. **Optional photos** (`photoIds[]`, plural) — reuse the report photo
  pipeline (D31/D42) directly.
- **Hazard detail** — type, age/freshness, confirmCount, description, **photos**, and the **three-tier
  confirm control** (Still here / Healing but unsafe / Fully healed & safe; relabeled for
  `ridge_crossing`) + flag. The "fully healed" verdict is de-emphasized and confirmed — it's the only
  destructive one (D3). **Not shipped: the reporter/author line.** The component *supports* a
  `reporterName` prop (rendered "… by \<name\>" when present), but the backend's `hazards.get` `toView`
  returns **no reporter**, so the container leaves it undefined and the author line is simply omitted —
  the block-respecting author display is a remaining thread, not a shipped feature.
- **Auto-bundle prompt (D55)** — when the report form opens for a body where the author has unattached
  hazards from the matching skate window, it offers to include them (pre-checked, itemized, dismissible).
- Advisory, non-authoritative copy throughout (D3); a11y + dark mode (D34).

## Mobile UI (`apps/mobile`) — the on-ice experience

Designed at kickoff (2026-07-21) against one governing constraint: **cold hands, gloves, bright sun, one
hand, possibly moving, no signal, phone in a pocket.** Two rules fall out and are non-negotiable:
**no required typing anywhere in the flow**, and **the hazard is committable after two taps** — a
mitten-fumble that hits Done early must still produce a useful pin.

### The "on-ice" state
The `(map)` layout owns **one** GPS watcher (Phase 9 review fix — three separate bugs left the original
version essentially never activating: a permission race with the map's framing request, a one-shot check
that never re-ran, and a body cache only ever populated by opening a lake's drawer). The single watcher
publishes each fix as `onIceCoord` and resolves it to a lake two ways: the **server** `resolveBodyForCoord`
query (read-cap-safe, covers *any* listed lake including one never opened on this device), falling back to
the offline `resolveCachedBody` when the query hasn't answered (offline / first paint). Permission is taken
through a shared `ensureForegroundPermission()` singleton so the watcher and the map's framing request
can't race onto two prompts. It seeds from the last known fix, re-arms on `AppState` `active`, and
`MapView` now also seeds the offline body cache from on-screen bodies when zoomed in — so on-ice detection
no longer depends on having previously tapped that lake.

**On app-open, the resolved lake is auto-selected** (founder call, 2026-07-21): the layout navigates to
its detail, which frames it into the space the half-height drawer doesn't cover — you land looking at the
lake you're standing on, can flick the drawer down for more, and **closing the sheet to pan away lets the
hazards fall off naturally** (the hazard *layer* follows the *selected* lake, `highlightWaterBodyId`, not
the on-ice body). Auto-select fires **at most once per open** and only while still on the bare map, so it
never yanks someone out of somewhere they deliberately navigated. The pure decision (`shouldAutoSelectOnIce`,
`resolveOnIceBody`) lives in `onIce.ts`, unit-tested. This supersedes the interim "no camera movement"
call — moving the camera *once, on open, to the lake under your feet* is exactly what you want; the failure
mode we avoid is re-framing you on every fix or mid-interaction, which the once-per-open guard prevents.

The resolved body drives the **⚠ Flag a hazard** FAB (bottom-right thumb zone, above the drawer peek) and
the proximity banner. Off-ice the FAB doesn't exist and the flag action lives as an ordinary button in the
lake drawer. Founder call: **no auto-opening capture sheets, no modal "you're on the ice!" state** — the
auto-*selection* is just a normal lake drawer, nothing you can be confused about being *in*.

### Flagging — three taps, offline, no typing
1. **FAB** → sheet of big tiles: **Open water · Pressure ridge · Thin ice** (≈80% of real reports —
   research §6), a distinct green **Crossing point** tile (`ridge_crossing`), and **More…** for the rest.
2. **Tap the type** → the pin is *already dropped at current GPS*, the type's default radius renders as
   a translucent circle, and the sheet collapses to a compact adjust bar. **The hazard is now valid and
   submittable.**
3. **Done.** Everything between 2 and 3 is optional: **− / +** steppers to resize (steppers, *not* a
   slider — sliders are miserable with gloves), drag-to-move, and 📷 photos.

**Drop-ahead is first-class** (research §6): you usually *see* a hazard before you reach it and must not
have to skate onto it to mark it — so the GPS-dropped pin is freely draggable and the copy says so.
**Photos are encouraged, plural, and skippable** (founder call) — straight onto the existing multi-photo
pipeline. On Done: written to the draft queue immediately, flushed if online, haptic + brief toast —
**never a blocking modal**, because the skater may be moving.

Per call 5, point+radius ships first and **polyline follows in the same PR**, so `pressure_ridge` and
`wet_crack` get their true linear primitive rather than standing in as blobs.

### Being warned — Layer 1, foreground-only in v1 (D54 amendment)
While the map is foregrounded and GPS resolves to a body, a `watchPositionAsync` watcher feeds the pure
`hazardProximity.evaluateOnIceAlert` against cached hazards. Hits surface as **top banners, never
modals** — blocking the map of someone moving on ice is unacceptable.
- **Confirmed hazard:** `⚠ Open water reported ~120 m away · 3 h ago, confirmed by 2 skaters`. Tap to
  frame it; auto-dismiss; the per-session `alerted` set means skating laps doesn't re-fire it.
- **Provisional hazard (`confirmCount` = 0)** — softer, and **the gate _is_ the confirmation**:
  *"Someone flagged open water near here — can you see it?"* with inline **[ Yes, it's there ]** (writes
  a `still_there` confirmation in one tap, no navigation) and **[ Not seeing it ]**.
- **"Not seeing it" must NOT clear anything** — it opens the three-tier control. *"I can't see it"* is
  not *"fully healed & safe"*: whiteout, snow cover, and a hidden folded ridge all look identical to
  not-seeing-it. Collapsing those is precisely the D3 failure mode.
- **`ridge_crossing` never fires a warning banner** — it's a positive passage marker, and "⚠ hazard
  ahead" on it would be actively wrong.
- **"Silence is not an all-clear"** appears wherever alerting is surfaced or configured (D54 amendment).

### Confirming
Two entry points: the banner above, or tapping the pin → a hazard drawer (the same bottom sheet as
lake/report detail) with type, freshness copy, photos (no reporter line yet — `hazards.get` returns no
reporter; see the web detail note above), and three stacked full-width buttons —
**Still here** / **Healing — still unsafe** / *Fully healed & safe*. The third is deliberately
de-emphasized and gets a confirmation step: it is the only destructive verdict (2 votes archive the pin),
and the asymmetry is the point (D3 — a false all-clear is the worst outcome). Relabels to *Still
crossable / Dicey now / Ridge closed* for `ridge_crossing`. Confirmations queue offline like drafts.

### Deep link (built in v1, used by Layer 2 — ✅ `?action=confirm` shipped in Phase 9.5)
`skating://hazard/<id>` routes into the hazard drawer (`/hazard/[id]` on mobile, `/_map/hazard/$id` on
web). Both the route and the URL scheme were built in v1 precisely so Layer 2's notification tap had
somewhere to land, at near-zero cost then. The one v1 gap — the **`?action=confirm` behaviour** (deep-
focusing the three-tier confirm control) — **shipped in Phase 9.5 (2026-07-22)**: both routes now read the
`action` param and scroll/pre-focus the confirm control, while the destructive "fully healed" step stays
gated behind its own second tap even when deep-linked (D3).

### Offline
Hazards and confirmations queue through the existing F2 draft/flush substrate (`draftStore` gains a
`kind` discriminator; `draftQueue.ts` already anticipates this). The pin degrades to "drop at my GPS"
when there's no basemap, until Layer 3 tiles land.

---

## Testing (lands with the feature — D40)

- **`@skating/core`:** example + `fast-check` property tests at 100% — decay monotonicity + tier
  boundaries, lifecycle reducer invariants (only `fully_healed` removes; healing keeps the pin; author
  self-confirm excluded), proximity/dedup-per-session, bbox/geometry near boundaries.
- **Convex:** `convex-test` — create (standalone + in-report), confirm transitions, archive at
  threshold + resurface on re-report, flag→hide, admin promote/demote gating, provisional vs confirmed
  derivation.
- **Web:** component tests for the hazard layer, authoring primitive selection, three-tier confirm.
- **Mobile:** logic/hooks via Vitest (proximity/alert dedup, offline resolve); the on-ice alert flow
  via Maestro as it stabilizes.

---

## PR / commit breakdown (one PR — memory: bundle-prs-by-phase; **online-first then offline**)

Per the founder's call (2026-07-18): **all in one PR**, online-first commits first, offline added after.

1. **Core logic** — `@skating/core` hazard modules (canonical enum, decay, lifecycle, geometry,
   proximity, copy) — property-tested, zero UI/platform dependencies.
2. **Schema + Convex** — table deltas (single `type`, `moderationStatus`, `photoIds[]`, `bufferMeters`,
   `geometryKind`, `healingState`), enum plumbing, migrations, then hazards / confirmations /
   bodyFeatures functions + `convex-test`.
3. **Web — point+radius** — map layer + authoring + three-tier detail (online).
4. **Polyline** — tap-to-add-vertex authoring for `pressure_ridge` / `ice_heave` / `wet_crack`
   (call 5; explicitly *not* cut, just sequenced after the pipeline is green). The whole authoring
   state machine lands in **`@skating/core/hazardDraft.ts`** (draft union, map-click/undo/resize/
   switch-primitive transitions, `draftToShape` as the single "done enough" gate), with web wiring it
   to MapLibre. **The mobile half moves into commit 5**, where the hazard capture UI is actually
   built — there was nothing in `apps/mobile` for a polyline to attach to at this point, and the
   shared reducer is the part that had to exist first. Mobile inherits the transitions rather than
   reimplementing them, which is what keeps "what counts as a valid hazard" from drifting per platform.
   Either primitive is offered for any type (you may only know the one spot on a ridge you crossed).
5. **Mobile online** — on-ice FAB + flag flow + hazard drawer + Layer-0 sync + Layer-1 foreground
   proximity banners + the `skating://hazard/<id>` deep link, **plus the mobile polyline** deferred
   from commit 4. Notes from the build:
   - The hazard **layer transforms** moved into `@skating/core/hazardLayer.ts` rather than being
     mirrored per-app the way the water-body layers are. These are the safety layers — a hazard is
     drawn as the same buffered footprint the proximity evaluator measures — so "what gets drawn" is
     decided once. Only the palette stays per-app (it comes from each app's design tokens).
   - On-ice capture starts **every** type as a circle (`pointDraftForType`), including the linear
     ones, because one GPS fix is one vertex and a one-vertex line isn't storable — the two-tap
     guarantee outranks primitive purity. Tracing is an opt-in upgrade via `switchDraftKind`.
   - **Tap-to-move, not drag-to-move.** Drop-ahead is still first-class (the copy tells you to put
     the pin where you *saw* it rather than skating onto it), but it's a Move button that arms a map
     tap — same outcome, no draggable-native-marker machinery, and easier with gloves.
   - `HAZARD_CONFIRM_VIA` gains **`proximity_alert`**: a confirmation cast from an on-ice banner
     means the skater was standing within alert range, which is much stronger evidence than one cast
     from a list. Folding it into `app_open_nearby` would discard that signal before D50 can weigh it.
   - The alert **session** logic (which alert becomes a banner, when it may be replaced, per-session
     dedup) is pure in `apps/mobile/src/lib/onIce.ts` and unit-tested; a showing banner is never
     swapped out from under a moving skater.
6. **Auto-bundle (D55)** — report form offers the author's unattached on-ice hazards. Web's half
   shipped early (with commit 3); this adds the mobile half and lifts the shared selection rule into
   **`@skating/core/hazardBundle.ts`**. The rule is stored as the author's **opt-outs**, not their
   selections: the candidate list is a live query, so an opt-in set would silently drop a hazard that
   finished syncing after the form opened. Online-only — a coord-only offline capture has no resolved
   lake to query candidates for, so bundling a *drafted* report belongs with the offline commit.
7. **Offline** — ✅ hazard draft/flush reuse (`draftStore` `kind` discriminator);
   ⛔ **Layer-3 offline basemap tile-pack — dropped for this phase** (see the spike findings below).
   - Queue logic in **`@skating/core/hazardQueue.ts`**, reusing the F2 contract (same `DraftStatus`
     machine, same transient-vs-permanent classification, same persist-after-every-advance rule) so
     one flush loop drains reports, hazards and confirmations. `draftQueue`'s `PermanentFlushError`
     is now **exported and shared** — a parallel marker class would have been classified `transient`
     and retried forever.
   - **`hazards.create` gained `idempotencyKey`** (+ index). Without it a lost ack on flush drops a
     second pin metres from the first, and duplicate *hazards* are worse than duplicate reports: two
     overlapping footprints read as two dangers and the confirm loop has to retire both.
   - **There is no "save for later" button.** On the ice, "am I online?" isn't a question the skater
     should have to answer, so Done always means Done: a transient failure falls through to the queue
     and flushes on reconnect, and only a real server rejection surfaces as an error.
   - **Hazards flush before report drafts** — safety content another skater may be about to need, and
     a photo-laden report queue can take a while to drain on a weak connection.
   - `QueuedHazard.photos` exists but is never populated yet: **on-ice photo capture is still
     unbuilt** (see *Out of scope* below). The field ships now so adding the camera is a UI change
     rather than an on-device schema migration.

### Layer-3 offline basemap tile-pack — spike findings (2026-07-21), deferred

Timeboxed per the founder's call, and **not built**. What's now known, so the next attempt starts from
evidence rather than re-deriving it:

- `@maplibre/maplibre-react-native@11.3.6` **does** ship an offline API: `OfflineManager.createPack`,
  `getPacks`, `deletePack`, `invalidatePack`, `mergeOfflineRegions(path)`.
- **The blocker is our tile source, not the API.** `createPack` takes `mapStyle: string` — a style
  *URL* the native downloader resolves and crawls for individual tile resources. Our basemap is (a) a
  `StyleSpecification` **object built in JS** (`buildMapStyle`), with no hosted URL, and (b) sourced
  from `pmtiles://…`, a single archive read via HTTP range requests rather than a `{z}/{x}/{y}` tile
  template the crawler can enumerate. Native pmtiles support covers *rendering*; whether the offline
  *downloader* can crawl a pmtiles archive is unverified and unknowable from the JS typings.
- **Three candidate routes, none cheap:** (1) host a style JSON + serve the region as ordinary tile
  URLs purely so `createPack` can crawl it — abandons pmtiles for the offline path; (2) build a mini
  regional `.pmtiles` and ship/download it to device storage, pointing the style at a local file URI
  — needs confirmation that native pmtiles reads `file://`; (3) generate a MapLibre offline sqlite DB
  in the build pipeline and sideload it via `mergeOfflineRegions` — a build-tooling project.
- **Resolving this needs a device build**, which is also what the rest of the native Phase 9 UI is
  waiting on. Sequencing it with that emulator/device pass is the cheap version.
- **What already degrades correctly:** on-ice capture never depended on the basemap. The pin drops at
  GPS, sizing and Done work, and the whole flow queues offline. What's lost without tiles is *tapping
  the map* — Move and Trace — so a no-basemap capture is a GPS-anchored circle. That is the documented
  degrade, and it is the common case working.
8. **Hazard photos** — the camera step on both platforms, closing the gap logged during commit 5.
   Web extracts `usePhotoDrafts` (the checkpointed upload + reclaim-on-abandon sweep) out of
   `ReportForm` so both forms share one copy of that delicate lifecycle; mobile persists picked
   photos to disk *at pick time*, so the same records feed the online upload and the offline queue.
   Neither platform offers `placeOnMap` on a hazard photo: the hazard already has a location, and a
   photo's EXIF coord contradicting the footprint the alert measures against would be worse than
   useless — so the coord is dropped, not carried.
9. Then open the PR (Greptile metered — review once, whole phase).

---

## Out of scope / deferred (logged so it isn't lost)

- ✅ **SHIPPED in Phase 9.5 (2026-07-22). Layer 2 — the full on-ice alerting bundle. Near-term
  commitment, not open-ended** (founder: *"I'm okay deferring so long as Layer 2 comes soon"*). Adds
  `expo-notifications` + local notifications, opt-in session-scoped background location, and the
  directional "hazard ahead" projection (30–60s out). Full spec in the **D54 amendment**. v1 deliberately
  built everything it needs from the client side (pure evaluator, `alerted` set, cached hazards, deep
  link) so this was additive. **Shipped deltas from this sketch:** **NO keep-awake** (founder call
  2026-07-21 — screen sleeps; rely on background location + local notifications), heading is
  **course-over-ground not magnetometer**, and re-alert cadence became a **user setting** (once-per-
  session default vs every-approach, the latter gated on an enter-then-leave `approached` model, not plain
  distance-hysteresis). **Server-push-to-a-sleeping phone** stays separate and later — the only variant
  needing live location *uploaded*, hence the biggest privacy call.
- **Freeform polygon authoring** (call 5) — schema + render ship in v1; the vertex-dragging editor does
  not. Revisit if real usage shows people wanting shapes neither a circle nor a polyline can express.
- **Per-body summary cards on the map at zoom** — deferred to the roadmap's "Later / deferred" with a
  design sketch (needs cross-viewport aggregation + a denormalized per-body summary; call 6).
- **Consensus rendering** (non-destructive cluster of same-type hazards) + **GPS negative-evidence**
  (Q11 — tracks through a hazard lower its confidence, never auto-clear). Post-density / Phase 8+.
- **Weather-driven dynamic decay** — Phase 10 (documented there; extends D52).
- **Admin tuning surface** (per-type decay durations, confirm/removal thresholds, bodyFeatures
  promotion/demotion, `hazard` flag queue) — Phase 7 (D49-style); Phase 9 ships tuned constants + the
  admin *mutations*, Phase 7 adds the UI.
- **Silent background sync to a closed app** (content-available push to refresh the cache) — **still
  deferred even after Phase 9.5.** Phase 9.5 shipped D54 Layer 2 with **local** notifications only (no
  push token, no server); silent push remains its own future decision (the biggest privacy departure from
  D12, and iOS throttles it — a shaky base for safety content), so the recommendation below stands. It is
  not
  a Phase 9 loose end; it's the first user of a push stack this project has deliberately deferred
  twice. Concretely, the repo has **no push infrastructure at all**: `expo-notifications` isn't
  installed (build-kickoff call 4 explicitly kept new native deps out of v1), there are no device
  push tokens, no APNs/FCM credentials, and `notifications.ts` says outright that "push delivery
  itself is deferred" — Phase 3 and Phase 4 both land **in-app rows only**, and Phase 4's
  `coalesceKey` is described as seeding a collapse-id for "a later push layer". Delivering a
  content-available push would mean building that whole layer: the dep + native config, token
  registration and storage, credentials on both stores, a server-side sender, and a background
  handler — plus iOS throttles silent pushes at its own discretion, so the resulting refresh is
  best-effort by design and can't be relied on for safety content. **Recommendation: build it with
  the push layer (D54 Layer 2, which needs `expo-notifications` anyway), not as an offline tweak.**
  Nothing in Phase 9 depends on it: hazards for a lake sync reactively whenever the app is open, and
  the offline queue covers the capture direction.
- ~~On-ice hazard photos~~ — ✅ **BUILT 2026-07-21** (see the commit below); no longer deferred.
- **Layer-3 offline basemap tile-pack** — dropped from Phase 9 with findings recorded above; **retried in
  Phase 9.5 (2026-07-22)** via route (1) (`file://` pmtiles, no crawlable server), built flag-off
  (`EXPO_PUBLIC_OFFLINE_BASEMAP`) and awaiting its one on-device confirmation.
- ✅ **SHIPPED in Phase 9.5 (2026-07-22). Clip a hazard footprint to the water body boundary (founder idea, 2026-07-21).** A large point+radius
  centred in a small bay currently renders as a circle that can spill across land onto a peninsula or a
  neighbouring lake. The ask: intersect the footprint with the body polygon so a hazard can never imply
  danger on water it isn't on. **Deferred deliberately, not dismissed** — it's a genuine safety-*visual*
  improvement, but it touches the one invariant the layer is built around ("what's drawn IS what the
  proximity evaluator measures," `hazardLayer.ts`), so it must clip **both** the render and the alert or
  neither. The clean design is to **precompute and store the clipped footprint polygon** on the hazard at
  create time and have render, bbox and `distanceToHazard` all read it — which also makes the watcher
  cheaper (a stored polygon, no per-fix buffer/intersect) and is the same "decide the shape once" move the
  layer already makes. It's a schema + core + both-render-paths + cache change on the safety-critical path,
  so it wants its own focused commit and device verification rather than riding in the review-remediation
  PR. The `HAZARD_MAX_SIZE_M` ceiling shipped now is the crude backstop against the absurd case until then.
- ✅ **SHIPPED in Phase 9.5 (2026-07-22). Auto-suggest skate start/end times from the on-ice watcher (founder idea, 2026-07-21).** The single
  GPS watcher now knows when a device entered and left a lake's footprint; that dwell interval is a strong
  prior for the report form's skate window, which today is manual entry. Natural fit, but it needs a small
  amount of session bookkeeping (enter/leave timestamps, debounced against brief GPS excursions) and a
  form pre-fill, and it overlaps the D24 activity-detection path — so it belongs with the report-form /
  activity work, not the hazard PR. Logged in the roadmap under Phase 10 / activity.

---

## Research follow-up — ✅ DONE (2026-07-21)

Completed in a dedicated session. Full writeup + calibrated `HAZARD_DECAY` table + per-type evidence +
Phase-10 notes: **[`phase-9-hazard-research.md`](./phase-9-hazard-research.md)**. Corrections fed back
into **D52** ([`01-decisions.md`](./01-decisions.md)) and the schema
([`06-data-model.md`](./06-data-model.md)). Sources: the regional corpus (`training_data/google_group/`,
1,197 posts) + **lakeice.info** (Bob Dill's ice-safety reference).

**What changed as a result** (all folded into the plan above):
1. **Calibrated `HAZARD_DECAY`** — tiers confirmed; stored in **hours** (admin-friendly) not ms.
2. **Expanded type taxonomy** — `drain_hole` / `wind_hole` / `slush_hole` (Tier A), `thawed_rotten`
   (Tier A\*, #1 fatality cause), `gas_hole` / `reef_hole` (Tier D → bodyFeatures), `ridge_crossing`
   passage marker; `drilled_hole` narrowed to man-made.
3. **`bufferMeters`** on line/polygon hazards (folded ridge » hairline crack) + **`photoId`** on hazards.
4. **`ridge_crossing`** passage marker shipped in v1 (positive-but-cautious render, relabeled verdicts).
5. **New `bodyFeatures` types** — `gas_hole` / `reef_hole` / `delta` / `shallow_bay_early_thaw`.
6. **Decay = confidence, not safety** invariant + two corrected Phase-10 weather signs (thawed ice must
   not heal on cold; ridges escalate in thaws) + a snow-lowers-confidence rule.

Still no code assertion of safety (D3) — the harvested lakeice vocabulary powers the honest copy layer.
