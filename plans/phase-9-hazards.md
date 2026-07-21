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
> **Status:** 🔨 **In build (started 2026-07-21).** Decisions settled 2026-07-18 (**D51–D54**), calibrated
> by the 2026-07-21 research pass, and six build-kickoff gaps resolved 2026-07-21 (see *Calls made at
> build kickoff* below) — which amended **D51** and **D54** and added **D55**. Schema deltas are in
> [`06-data-model.md`](./06-data-model.md). Prior phases are on dev; prod deferred.
>
> **Prerequisites already in place.** The F2 offline substrate hazards depend on is **built**: the
> "Layer 2" body-reference cache (`apps/mobile/src/lib/offlineBody.ts` pure resolver +
> `bodyCache.ts` sqlite glue) is factored as a reusable module *explicitly for Phase 9 hazard capture*,
> and `bodyCache.ts` is already "designed to gain a tile-pack column later." `adminAreas`
> (place labels, Phase 5) and the `@convex-dev/geospatial` machinery (Phase 1/5) are live. Only the
> **Layer 3 offline basemap tile-pack** is genuinely unbuilt (a native spike; ships in the offline
> commits, online-first degrade mirrors F2 report capture).

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
  proximity evaluator runs against that same cached set). A third `@convex-dev/geospatial` instance
  would re-enter the read-cap fragility that took two PRs to fix on `listInViewport` (#10/#11) for no
  v1 benefit. Cross-viewport aggregation lives with the deferred **summary cards** roadmap entry.
- **Moderation plumbing:** `FLAG_TARGET_TYPES += 'hazard'`, `MODERATION_TARGET_TYPES += 'hazard'`, and
  new `MODERATION_ACTIONS` for `promote_body_feature` / `demote_body_feature` (the D53 admin actions).
- **No new `notifications.type`** in v1 — Layer-1 alerts are client-local (D54).

Dev's `hazards`/`hazardConfirmations` tables are empty (feature never shipped), so the verdict-enum and
new-column changes are effectively greenfield; migrations are trivial no-ops but written anyway (D30 idiom).

---

## `@skating/core` (pure logic first, 100% coverage — D40)

The safety-sensitive math lives here, property-tested, before any UI:

- **`hazardDecay.ts`** — the `HAZARD_DECAY` table (type → `{ tier, freshH, agingH }`, Tiers A–D + the
  A\* very-volatile sub-case; **stored in HOURS**, converted via `hoursToMs` at compare time so the
  Phase-7 admin surface tweaks human-legible integers) + `deriveHazardFreshness(type, lastConfirmedAt,
  now) → 'fresh' | 'aging' | 'stale'`. **Calibrated table + evidence:**
  [`phase-9-hazard-research.md`](./phase-9-hazard-research.md) §1. Property tests: monotonic in elapsed
  time; tier boundaries; a "still here" reset returns to fresh. **Invariant (D3):** decay = confidence,
  not safety — a `stale` pin still renders (faded) and its copy never implies "clear."
- **`hazardLifecycle.ts`** — pure reducers over confirmations: `applyConfirmation(hazard, verdict)` →
  new `{ lastConfirmedAt?, confirmCount, goneCount, healingState, status }`; `shouldArchive(goneCount,
  removalThreshold)`; `isProvisional(confirmCount, confirmThreshold)`. Encodes: only `fully_healed`
  increments `goneCount`; `healing_unsafe` sets `healingState` without archiving; author's own confirm
  excluded.
- **`hazardGeometry.ts`** — `pointRadiusToPolygon` (buffer a point, for bbox + render), `hazardBbox`,
  and `distanceToHazard(coord, hazard)` reusing `geometry.ts` (`pointInPolygon`, buffered distance).
- **`hazardDraft.ts`** — the *authoring* state machine, shared by both platforms: the `HazardDraft`
  union (a circle awaiting a centre / a polyline collecting vertices), `draftForType` +
  `retypeDraft` (primitive and default size follow the hazard's real-world shape),
  `applyDraftMapClick` / `undoDraftPlacement` / `resizeDraft` / `switchDraftKind`, and
  `draftToShape` — the **single** gate deciding a draft is storable, delegating to
  `isValidHazardShape`. A half-drawn line and an unplaced circle are deliberately representable and
  deliberately not submittable: a polyline is captured one tap at a time, so "half a line" is a
  normal intermediate the UI must hold and render, not a crash.
- **`hazardProximity.ts`** (Layer 1, client-consumed) — `evaluateOnIceAlert(coord, hazards, alerted)` →
  the set of hazards within alert buffer, split provisional (→ "confirm?") vs confirmed (→ "ahead"),
  minus already-alerted-this-session. Pure so it's testable and identical on web/mobile.
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
  stamps bbox via `@skating/core`; `TODO(16+)` minor gate mirrors `reports.create`),
  `listForBody(waterBodyId)` (active + non-stale by default, `includeStale` flag), `getInViewport` (bbox
  prefilter for the map), `flag` (writes `contentFlags` with `targetType: hazard`), moderator `hide`.
- **`hazardConfirmations.ts`** — `confirm(hazardId, verdict, atCoord?, via)`: append the vote, run the
  `@skating/core` lifecycle reducer, patch the hazard (reset clock / bump counts / set healingState /
  archive at threshold), and write a `pointEvents` `hazard_confirmed` row (D50 prep — boost-only). One
  confirmation per user per hazard per window (idempotent-ish; re-confirm updates `lastConfirmedAt`).
- **`bodyFeatures.ts`** — `listForBody`, and **admin-gated** `promote(hazardId)` / `demote(id)` /
  `create` (role check + `moderationActions` audit row; the UI is Phase 7, but the mutations land here so
  hazards can already be promoted by an admin during Phase 9).
- **Data-sync for Layer 0 (D54):** `listForBody`/`getInViewport` are ordinary reactive queries — a
  subscribed client gets new hazards live; the mobile cache upserts them alongside the body polygon it
  already caches. No push infra in v1.
- All mutations gate correctly (author/role), write audit rows where moderation-relevant, and are
  `convex-test`ed (auth gating, lifecycle transitions, archive threshold, flag→hide).

---

## Web UI (`apps/web`)

- **Map hazard layer** — render active hazards on the lake map with **fuzzy** styling by freshness
  (fresh full / aging lighter / stale faded behind a "show older" toggle) and by `geometryKind`
  (circle for point+radius, line uses `bufferMeters` as its rendered half-width, polygon). `bodyFeatures`
  render always, distinct "known seasonal hazard" styling. **`ridge_crossing` renders as a distinct
  positive-but-cautious *passage* marker**, not a danger halo (research §4).
- **Authoring** — a "Report a hazard" control (standalone) + a hazard step inside the report form
  (in-report). **Three big one-tap presets** (open water / pressure ridge / thin ice ≈ 80% of real
  reports — research §6) with the rest behind "more." Type picker → primitive auto-selected per D51:
  **point+radius** (click to place, stepper/drag to size) then **polyline** (click to add a vertex,
  undo, Done, plus a `bufferMeters` stepper) — both hand-rolled on raw `maplibre-gl`, no draw library
  needed since neither requires vertex dragging. **Freeform polygon is not authorable in v1** (call 5) —
  it renders, but authoring it needs vertex dragging + self-intersection handling and is the primitive
  D51 already calls opt-in/advanced. **Optional photos** (`photoIds[]`, plural) — reuse the report photo
  pipeline (D31/D42) directly.
- **Hazard detail** — type, age/freshness, confirmCount, description, **photos**, author (respecting
  blocks), and the **three-tier confirm control** (Still here / Healing but unsafe / Fully healed & safe;
  relabeled for `ridge_crossing`) + flag. The "fully healed" verdict is de-emphasized and confirmed —
  it's the only destructive one (D3).
- **Auto-bundle prompt (D55)** — when the report form opens for a body where the author has unattached
  hazards from the matching skate window, it offers to include them (pre-checked, itemized, dismissible).
- Advisory, non-authoritative copy throughout (D3); a11y + dark mode (D34).

## Mobile UI (`apps/mobile`) — the on-ice experience

Designed at kickoff (2026-07-21) against one governing constraint: **cold hands, gloves, bright sun, one
hand, possibly moving, no signal, phone in a pocket.** Two rules fall out and are non-negotiable:
**no required typing anywhere in the flow**, and **the hazard is committable after two taps** — a
mitten-fumble that hits Done early must still produce a useful pin.

### The "on-ice" state
`geolocateOnMount` is extended: when GPS resolves to a body within the existing 300 m
`AUTOSELECT_BUFFER_M` (via `resolveCachedBody`, so it works offline), that lake is **auto-selected and
framed**. The only chrome that changes is a large persistent **⚠ Flag a hazard** FAB in the bottom-right
thumb zone, floating above the drawer peek; off-ice it doesn't exist and the action lives as an ordinary
button in the lake drawer. Founder call: keep it at just the FAB — **no auto-opening sheets, no modal
"you're on the ice!" state**. There should be nothing you can be confused about being *in*.

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
lake/report detail) with type, freshness copy, photos, reporter, and three stacked full-width buttons —
**Still here** / **Healing — still unsafe** / *Fully healed & safe*. The third is deliberately
de-emphasized and gets a confirmation step: it is the only destructive verdict (2 votes archive the pin),
and the asymmetry is the point (D3 — a false all-clear is the worst outcome). Relabels to *Still
crossable / Dicey now / Ridge closed* for `ridge_crossing`. Confirmations queue offline like drafts.

### Deep link (built in v1, used by Layer 2)
`skating://hazard/<id>?action=confirm` routes into the hazard drawer with the three-tier control focused.
There is no notification to tap yet — it's added now precisely so Layer 2's notification tap has
somewhere to land, at near-zero cost today.

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

- **Layer 2 — the full on-ice alerting bundle. Near-term commitment, not open-ended** (founder:
  *"I'm okay deferring so long as Layer 2 comes soon"*). Adds `expo-notifications` + local
  notifications, opt-in session-scoped background location + keep-awake, and the directional
  "hazard ahead" projection (30–60s out, per-approach dedup). Full spec in the **D54 amendment**.
  v1 deliberately builds everything it needs from the client side (pure evaluator, `alerted` set,
  cached hazards, deep link) so this is additive. **Server-push-to-a-sleeping phone** stays separate
  and later — the only variant needing live location *uploaded*, hence the biggest privacy call.
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
  deferred, and it is much larger than its one-line entry suggests** (assessed 2026-07-21). It is not
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
- **Layer-3 offline basemap tile-pack** — dropped from Phase 9 with findings recorded above; revisit
  alongside the device-build pass.

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
