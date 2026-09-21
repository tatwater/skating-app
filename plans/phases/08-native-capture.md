# Phase 08 — Native track capture + Strava push (the A→B→C pipeline)

> **✅ COMPLETE on dev (2026-07-24); prod deferred.** All five workstreams (08-1–08-5) shipped; suites
> green (core 752 / convex 540 / web 157 / mobile 76), lint + typecheck clean. **Still
> device-unverified** — see "Build outcome" below. This was the last unbuilt phase in the roadmap.

*Detailed build plan — scoped 2026-07-24. Supersedes the original "GPS providers (pull/ingest)"
framing of Phase 08 in [`07-roadmap.md`](../07-roadmap.md). Built on the reframe in
[`research/native-track-capture-and-strava-push.md`](../research/native-track-capture-and-strava-push.md)
and the Strava legal read ([`08-legal-feasibility-checklist.md`](../08-legal-feasibility-checklist.md) L7).
New decisions this phase: **D58** (aggregate-track privacy) and **D59** (unified report freshness).*

## The reframe (why this phase looks nothing like the old Phase 08)

The old plan **pulled** GPS tracks *from* Strava and showed them on the shared map. Strava's
Nov-2024 API terms kill that outright: **cross-user display of Strava data is flatly forbidden**
(even publicly-viewable data, even to no one but its owner) and there's a **blanket AI/ML ban**
(L7). So the whole cross-user mechanic — heatmap, crowd intelligence, path-on-a-public-report —
is illegal off Strava-sourced data.

The resolution inverts the flow: **we record the track ourselves and push it to Strava.** One
recording, two homes.

- **Our app** keeps the track as **first-party Developer Application Data** (never touched Strava's
  API) → we may aggregate it, draw it on public reports, and (later) heatmap it with **none of
  Strava's restrictions**.
- **Strava** receives the same activity as a normal `activity:write` upload to the user's *own*
  account → they keep their stats/kudos. This is the canonical complementary integration, squarely
  in Strava's "still allowed" bucket, and it removes the adoption tax: **record once, get both.**

Modeled as a pipeline — **B is the invariant hub we always own; A and C are pluggable provider
sets:**

```
  A · capture (inputs)        B · our track store (hub)         C · push (outputs)
  ───────────────────         ─────────────────────────        ──────────────────
  native recorder  ─┐         ┌ normalize → resolve-to-body ┐   ┌ Strava (activity:write)
  (Garmin/HealthKit │         │  (gpsActivities, D44)        │   │
   /HC/COROS/Polar) ─┼───────►│  aggregate tracks layer      ├──►┤  (future: Whoop, …)
   — deferred        │        │  privacy: minors-out,        │   │
                     ┘        └  put-in-gated, opt-out (D58)  ┘   └
```

## Decisions locked this session (2026-07-24)

- **Build the whole A→B→C spine now** — native recorder + B store/resolve + user-body creation +
  Strava push + the aggregate tracks map layer. (Founder call: heads are already in it; not much
  more than the spine alone — the one genuinely-bigger piece is the aggregate layer, see below.)
- **Paths are a trust signal from legitimate sources only.** The recorded GPS path is the *only*
  way a path enters the system. **No freehand path drawing, ever, anywhere.** (Later provider
  adapters are the only other legitimate source, and they're deferred.)
- **The recorded path renders on the individual report detail view** (a water body map showing the track,
  display-only — no user "draw" action) **and** on the aggregate tracks layer.
- **Body creation is path-only gated (D14/D36).** A skate that resolves to no known body can create
  or attach one **only from a trusted GPS path** — no path ⇒ no proof of presence and no
  scale/shape/location frame of reference ⇒ meaningless. This drops the manual-draw / Terra Draw
  option entirely.
- **The report is the unit of decay; the path inherits it (D59).** A path has no independent
  freshness — it renders its report's. Report-aging and path-opacity consume **one identical**
  `reportFreshness`; bounties refactor onto the **shared primitives** (keeping their own policy).
  One tunable knob.
- **Aggregate-track privacy = publish-is-consent, not k-anonymity (D58).** A public report is
  *meant* to be shared, so a single skater's public path may render (no contributor-count gate).
  Protection rests on: **minors excluded by construction**, **put-in-gated endpoint clipping**,
  **publish-is-consent** (only report-linked public paths aggregate), and a **global opt-out**.
- **Minors may use the recorder** for personal recording + their own Strava push (their own data,
  no public surface). They can't post reports (D41), so their paths never link to a public report
  and never aggregate — automatic.
- **iOS + Android both**, this cycle. Founder is enrolled in the Apple Developer Program; no owned
  iPhone, so iOS record-mode/background is to be verified on a friend's device *(never done — no iOS
  build has ever been made; the register's iOS row)*.
- **GPX (not FIT) for the Strava upload**, and a **per-session "also upload to Strava?" toggle**
  (default off when a watch provider is connected — deferred detection, so v1 default = on for
  phone-only) — both are the research doc's v1 calls.
- **Deferred (design-for, don't build):** third-party A-input adapters (Garmin / HealthKit / Health
  Connect / COROS / Polar) — each integrated individually later; the "watch wins" ingest path;
  additional C-outputs (Whoop); path-cluster **hazard deduction** (L9/Q11); the tuning-heavy
  crowd-intelligence derivations (pressure-ridge / clearest-side) — need real volume + calibration.

## Scope

### In
- A native GPS **track recorder** (session start/pause/resume/stop, durable buffer, background,
  a Record-grade GPS profile) reusing the Phase 09b on-ice primitives.
- Track **post-processing in `core`** (smoothing / accuracy-gating / stationary-culling) + **GPX**
  and **encoded-polyline** emitters.
- **B**: normalize a recorded track → `gpsActivities`, **resolve-to-body** (D44), link to a report.
- **Report-detail path render** (own path on own report) on web + mobile.
- **User-created bodies + match-on-create dedup (D14/D36)**, path-only.
- **Strava push (C)**: OAuth `activity:write`, `convex/http.ts` router, token exchange/refresh,
  upload + poll, watch-wins toggle, brand kit.
- **Aggregate tracks map layer (D58)**: decaying public-track overlay on web + mobile, put-in-gated
  clipping, minors-out, opt-out.
- **Unified report freshness (D59)**: shared `reportFreshness` primitive; bounties refactored onto it.

### Out
- Reading/ingesting tracks *from* Strava (pull) — legally dead, shelved indefinitely (L7).
- Third-party capture adapters (Garmin/HealthKit/HC/COROS/Polar) + the watch-wins ingest path.
- k-anonymity contributor-count gating (dropped by D58; publish-is-consent instead).
- Crowd-intelligence derivations over tracks (pressure-ridge/clearest-side, L9 deduction).
- A code-level GPS **replay rig** for CI (Phase 09b uses the Android emulator's GPX playback; a
  fixture-driven replay module remains a nice-to-have, not scoped).
- Runtime-editable tuning constants (the `appConfig` seam is still deferred — the D59 decay rate is
  an edit-and-redeploy `ConstantCard`, matching Phase 07).

## `@skating/core` — new pure modules (pure-logic first, high coverage — D40)

1. **`track.ts` — recording + post-processing (net-new).**
   - `TrackPoint` = `{ lat, lng, elevation?, t (ms), accuracy?, speed?, heading? }` (a superset of
     `hazardProjection.ts`'s `DirectionalFix` — reuse the same `LatLng`).
   - `appendPoint(buffer, point, opts)` — accuracy-gate (drop fixes worse than a threshold) and
     stationary-cull, reusing the **NaN-safe motion gate** pattern from
     `hazardProjection.ts` (`!(speed >= min) || !(heading >= 0)`) and `haversineMeters` from
     `geometry.ts` for the distance filter.
   - `smoothTrack(points, opts)` — light smoothing (e.g. accuracy-weighted / median window); no new
     geodesy, reuse `haversineMeters`.
   - `trackStats(points)` — distance (Σ `haversineMeters`), moving vs elapsed time, so we can derive
     `endTime` and `elapsedSeconds` and **trim a watch-left-recording tail** (the schema comment on
     `gpsActivities.elapsedSeconds` already anticipates this).
   - `toGeoJsonLineString(points)` → the `path` we store on `gpsActivities` (GeoJSON, matching the
     repo's "geometry is GeoJSON, never encoded-polyline" convention).
   - `toGpx(points, meta)` — GPX 1.1 emitter for the Strava upload (net-new; no encoder exists).
   - `toEncodedPolyline(points)` — **only if** a client render path wants it; default render is the
     GeoJSON `path` straight onto MapLibre, so this may not be needed. Decide at build.

2. **`pathToBody.ts` — GPS-path → water-body polygon (net-new, for D14/D36).**
   - `pathToBody(path, opts)` → `{ polygon, centroid, bbox, surfaceAreaSqM }`. Build the polygon by
     **buffering the track LineString** (the only buffering primitive we have, `@turf/buffer`, is
     already imported in `geometry.ts`) and taking a concave/convex hull; centroid via
     `representativePoint`, area via `surfaceAreaSqM`, bbox via `polygonBBox` (already accepts a
     `LineString`). This is the "derive bounds from the trusted path" step (D14) — a real skated
     track is far better evidence than a freehand blob.

3. **`dedup.ts` — match-on-create scoring (net-new; nothing like it exists).**
   - `nameSimilarity(a, b)` → 0..1 normalized string similarity (the D36 name booster).
   - `classifyDedup(candidate, existing)` → `'clean' | 'suspected_duplicate' | 'near_certain'`
     applying the **D36 thresholds** (point-in-polygon → strong; polygon IoU ≥ 0.5 suspected, ≥ 0.9
     near-certain; centroid < ~75 m suspected; name ≥ 0.8 bumps a tier), composing the *existing*
     `geometry.ts` metrics — `polygonIoU`, `pointInPolygon`, `bboxIntersects`, `bufferedLineOverlap`
     (rivers-as-reaches, D4), `nearestBodyForPoint`. **No new geometry** — dedup is pure orchestration
     over primitives that already ship.

4. **`reportFreshness.ts` — the shared decay primitive (net-new; D59).**
   - Extract the **recency-decay curve, netThumbs normalization, and weather-change detector** that
     `bounties.ts` `bountyFreshWindowHours` currently owns privately, into shared helpers.
   - `reportFreshness(signals, now)` → `0..1`, where `signals = { skateEndTime, netThumbs,
     corroborationCount, weatherExplainsIceChange }`. Recency off `skateEndTime`; `netThumbs` from
     `ratings.tallyThumbs`; `corroborationCount` from `pointEvents` `by_ref` (`report_corroborated`);
     `weatherExplainsIceChange` from `weather.ts`. **This is the identical number report-aging and
     path-opacity both consume.**
   - `pathOpacity(freshness)` → clamps `reportFreshness` to a **min-opacity floor** so an old path
     never fully vanishes and reads as "all clear" (D3 — mirrors the never-hide invariants for
     hazards/reports).
   - **Bounty refactor:** `bountyFreshWindowHours` keeps its own formula (trust-window boost up to
     `BOUNTY_FRESH_MAX_MULTIPLIER = 3`, no corroboration, `weatherExplainsIceChange` hard-collapse,
     D56 reopen thresholds) but now calls the **shared primitives** instead of a private copy.
     **Acceptance gate: every existing Phase 06 bounty test stays green, untouched.** Bounty and
     path/report are *not* the same final formula (that's correct — different questions); they share
     the primitives that would otherwise drift.
   - New tunable decay-rate constant in `reputationConfig.ts`, surfaced as a **read-only
     `ConstantCard`** in `admin.tuning.tsx` (Display & map section), paired with a metric chart —
     the Phase 07 pattern. (Edit-and-redeploy; no runtime `appConfig` table.)

## Schema changes (all migration-aware — see `06-data-model.md`)

The two stub tables already exist with the right shape and indexes — **no migration** to add them:

- **`gpsActivities`** (schema ~173): `path?`, `waterBodyId?`/`waterBodyIds?`, `linkedReportId?`,
  `promptState`, `providerActivityId` (+ `by_provider_activity`, `by_water_body`, `by_user`). Fill
  in the read/write code (zero today). `provider` for the native recorder = a new
  `ACTIVITY_PROVIDERS` value (**`native`**) alongside `strava` (add to `lib/enums.ts`).
- **`activityConnections`** (schema ~162): already shaped for OAuth token storage — `accessToken`,
  `refreshToken`, `scopes`, `tokenExpiresAt`, `externalUserId` (SERVER-ONLY). Strava fills it in.
- **`reports`** (schema ~278): `source: 'activity'` + `activityId` already exist; `showPutIn?`
  already exists and **doubles as the D58 clipping consent** (see below). No new report field needed
  for the path — the path lives on `gpsActivities`, linked via `reports.activityId`.

New/added fields (all optional ⇒ migration-free):
- **`activityConnections`** — nothing new; the columns suffice.
- **A per-user aggregate opt-out** (D58): a boolean, cleanest on **`profiles`**
  (e.g. `excludeTracksFromAggregate?`), read at aggregate-build time. (Not on `gpsActivities` —
  it's a person-level preference, and putting it on the profile means a later opt-out retroactively
  drops all their tracks.)
- **`gpsActivities.sharedToAggregate?`** is **not** added — publish-is-consent means "linked to a
  public (non-minor) report" *is* the eligibility predicate; a separate flag would contradict D58.

## Convex backend

- **`gpsActivities.ts` (net-new).** `ingestTrack` (mutation: store a recorded track, dedup by
  `provider`+`providerActivityId` via `by_provider_activity` — reuse the offline-idempotency
  discipline), `resolveToBody` (D44 — bbox prefilter → `nearestBodyForPoint`/`pointInPolygon` over
  the path; sets `waterBodyId` + optional `waterBodyIds[]` for spanning skates; falls back to the
  D14/D36 create-or-attach flow), `promptState` lifecycle (`pending → prompted → converted /
  dismissed`), `linkForReport` (wire `activityId ↔ linkedReportId` at report create).
- **`waterBodies.ts` (extend).** Teach the **existing** `create` (line ~269, currently hardcodes
  `dedupStatus: 'clean'` with a "Phase 08 TODO") to run **match-on-create**: call a new
  **`findMatchCandidates`** query (bbox + geospatial-nearest prefilter → score with `core/dedup.ts`),
  stamp `dedupStatus` / `duplicateCandidateIds`, and require an explicit `confirmedNew` when strong
  matches exist. This is the **producer** the Phase 07 dedup queue has been waiting for
  (`listDedupCandidates` today "expects ~zero rows until Phase 08"). The **merge mutation, moderator
  queue, and `admin.water.tsx` UI already exist** — this just feeds them.
- **`strava.ts` + `http.ts` (net-new — the whole HTTP layer is greenfield).**
  - `convex/http.ts`: `httpRouter()` with the Strava **OAuth callback** and (future) webhook routes.
    First `httpRouter` in the repo — model the outbound calls on `isochrones.ts` `fetchOrsBands`
    (authenticated third-party POST, `process.env`, graceful no-op when unset) and `operatorAlerts.ts`
    (`Authorization: Bearer`).
  - OAuth: exchange code → tokens, store per-user in `activityConnections`, **refresh-on-expiry**
    (net-new — no integration does token refresh today; all others use static keys).
  - `uploadActivity` (action): `POST /api/v3/uploads` multipart (`data_type=gpx`, `IceSkate` sport
    type), **poll** `GET /uploads/{id}` at ≥1 s until `activity_id` or `error`; surface Strava's
    duplicate-rejection error. `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` as Convex env vars.
- **Aggregate tracks query (net-new; D58).** `listTracksForBody(waterBodyId, window)` — read
  `gpsActivities` by `by_water_body`, keep only those `linkedReportId`-ed to a **visible, non-minor**
  report, **clip endpoints** unless the report's `showPutIn !== false` (put-in-gated), drop tracks
  from opted-out users, and stamp each with its `pathOpacity` (from D59's `reportFreshness` of the
  linked report). Scoped **per selected body** (like Phase 09a hazards) — **not** a cross-viewport
  geospatial scan — to sidestep the `listInViewport` read-cap fragility (roadmap "Later/deferred").

## Native deps + config (the dev-client rebuild)

- **`expo-location` background is already wired** (`app.config.ts` ~44-59):
  `isAndroidBackgroundLocationEnabled`, `isAndroidForegroundServiceEnabled`,
  `isIosBackgroundLocationEnabled` all true; Android foreground-service + iOS `UIBackgroundModes:
  location` generated from the plugin. The recorder reuses this — **no new native permission plumbing**
  for background GPS. (CNG: no committed `ios/`; the committed `android/` manifest already carries the
  perms.)
- **New deps:** possibly `@mapbox/polyline` *only if* we emit encoded polylines (default: none — we
  render the GeoJSON `path` directly). GPX is a hand-rolled string emitter in `core` (no dep).
- A **dev-client rebuild** is required (new task registration + record-mode profile); this is an EAS
  dev build, tested on the **Android emulator** (primary) and a **friend's iPhone** for iOS
  background/battery parity.

## Mobile — the recorder (reusing Phase 09b on-ice primitives)

- **Extend the GPS profiles.** Today `onIceTask.ts` `startOnIceLocationUpdates` uses
  `Accuracy.Balanced` + `distanceInterval: 20` (a deliberate cold-weather battery choice for fuzzy
  hazard alerts). Add a **Record profile** — `Accuracy.High`/`BestForNavigation`, ~5 m distance
  filter — selected when the user is *recording*. The two user choices are **orthogonal** (research
  doc): (a) "keep the app watching" = on-ice hazard alerts at Balanced; (b) "record my skate" =
  export-grade track. If both are on, **record fidelity wins the knob** (you can alert off a fine
  stream; you can't refine a coarse one).
- **Recording session** (net-new): start/pause/resume/stop over a **durable expo-sqlite buffer** —
  add a **`track` kind** to `apps/mobile/src/lib/draftStore.ts` (already a `kind`-discriminated table
  with `ensureSchema` migration guard) and a `TrackQueueItem` in `core` modeled on
  `draftQueue.ts`/`hazardQueue.ts` (`createDraft`/`flushDraft`, `DraftFlushEffects`,
  `PermanentFlushError`, `idempotencyKey`). A crash/kill never loses a skate.
- **Foreground-service notification** ("Recording your skate") — the honest "we're recording" signal
  and what keeps GPS alive with the screen off. **Auto-stop on prolonged stationarity** ("I forgot to
  stop it").
- **Battery honesty (D3 copy).** Record mode is genuinely the upper end of ~5–12 %/hr; the recording
  UI says so plainly. We do **not** pretend to beat a watch — the recorder is for the **phone-only
  skater** and for capturing the report-relevant path. Adaptive sampling (1 fix / 3–5 s or / 10–15 m)
  is the main lever; the Strava push itself costs ~nothing (one upload at session end).

## Web + Mobile UI

- **Report-detail path render.** Add a **`tracks` GeoJSON source + line layer** to both maps — web
  imperative (`apps/web/src/components/MapView.tsx`: `addSource('tracks', {type:'geojson'})` +
  `addLayer` line, alongside `water`/`hazards`/`put-in-markers`) and mobile declarative
  (`apps/mobile/src/components/MapView.tsx`: `<GeoJSONSource id="tracks"><Layer/></GeoJSONSource>`).
  On a report detail, feed it the single linked `gpsActivities.path`. No track layer exists today —
  net-new on both.
- **Aggregate tracks layer (D58).** Same source/layer, fed by `listTracksForBody` for the selected
  body; **line opacity = each track's `pathOpacity`** so paths fade as their report ages (renders as
  density where many overlap — a single public track is enough, no k-anon gate). Surface public
  **put-ins** more prominently here (ties into the existing `putIns` markers).
- **Create/attach a water body (D14/D36).** When a recorded skate resolves to no known body, the
  "attach here?" steer: show ranked `findMatchCandidates`; creating new requires explicit "None of
  these" (`confirmedNew`). **No manual-draw entry** — path-only.
- **Connect with Strava + "also upload?" toggle.** Official **"Connect with Strava"** button asset +
  **"Powered by Strava"** attribution wherever the connection surfaces (L7 / brand kit; the
  attribution helper already noted in `apps/web/src/lib/waterMap.ts`). Per-session upload toggle.
- **Aggregate opt-out** in profile settings ("Don't use my paths in community water body maps").

## Testing (lands with the feature — D40)

- **`core` pure logic** (high coverage): `track.ts` (accuracy-gate/cull/smooth/stats/GPX/GeoJSON),
  `pathToBody.ts`, `dedup.ts` (D36 threshold table — property tests over synthetic polygons),
  `reportFreshness.ts` (decay monotonicity, opacity floor, signal blending).
- **The D59 refactor gate:** run the **existing Phase 06 bounty suite unchanged** and require green;
  add tests that report-aging and path-opacity read the *same* freshness for the same report.
- **`convex-test`:** `gpsActivities` ingest idempotency (`by_provider_activity`), D44 resolution +
  create-or-attach fallback, `findMatchCandidates` scoring + `dedupStatus` stamping (feeds the Phase
  7 merge queue), `listTracksForBody` privacy (minor-excluded, put-in clip, opt-out), Strava upload
  action against a mocked `fetch` (upload → poll → activity_id / error / duplicate).
- **Device/manual:** Android-emulator **GPX route-playback** (the Phase 09b rig) to exercise
  record → buffer → stop → resolve → render; a friend's iPhone for iOS background + battery parity;
  a real Strava sandbox upload on the founder's own account.

## PR / commit breakdown

This phase is large enough to warrant **multiple PRs** (a native spike + a shipped-code refactor +
external OAuth + a new map layer) — a deliberate exception to the usual one-PR-per-phase rule
(memory: bundle-prs-by-phase), because each has a distinct review + verification surface (Greptile is
metered, but device testing and the bounty-refactor gate want isolation). Sub-workstreams are commits
within each PR.

1. **PR 08-1 — Unified report freshness (D59).** Extract shared primitives → `core/reportFreshness.ts`;
   adopt in report-aging display; **refactor `bounties.ts` onto it (existing tests green, untouched)**;
   add the decay-rate `ConstantCard`. *De-risks the shipped-code refactor first, standalone.*
2. **PR 08-2 — Native recorder + B spine.** `core/track.ts` (+ GPX), Record GPS profile, recording
   session + sqlite `track` kind, foreground service / background, `gpsActivities.ingestTrack` +
   `resolveToBody` (D44), report-detail path render. *Device-tested; produces the tracks everything
   downstream needs.*
3. **PR 08-3 — User bodies + dedup (D14/D36).** `core/dedup.ts` + `core/pathToBody.ts`,
   `findMatchCandidates`, `create` match-on-create, create/attach UX. *Feeds the Phase 07 merge queue.*
4. **PR 08-4 — Strava push (C).** `convex/http.ts` + OAuth `activity:write` + token refresh +
   `uploadActivity` (upload/poll) + watch-wins toggle + brand kit. *Needs the free Strava app
   registered.*
5. **PR 08-5 — Aggregate tracks layer + privacy (D58).** `listTracksForBody`, the decaying tracks
   overlay (opacity from 08-1), put-in-gated clipping, minors-out, profile opt-out. *Depends on 08-1+8b.*

**Order:** 08-1 → 08-2 → (08-3 ∥ 08-4) → 8e. 08-1 and 08-2 are the backbone; 08-3/8d are independent adapters off
B; 08-5 needs B producing tracks + 08-1's opacity.

## Out of scope / deferred (logged so it isn't lost)

- **Third-party A-input adapters** (Garmin / Apple HealthKit / Google Health Connect / COROS /
  Polar) + the **watch-wins ingest path** (when a watch already pushed to Strava, skip our record +
  push and ingest the watch track via an allowed provider). Each is an incremental adapter into the
  same normalized `gpsActivities` shape; **apply for Garmin/COROS/Polar partner programs now**
  (weeks of review) so they don't gate the later fast-follow. Per-provider ToS/brand at integration
  time (L8).
- **Crowd-intelligence over tracks** — pressure-ridge / clearest-side, and **path-cluster hazard
  deduction** (L9/Q11). Now legal (our own data) but needs real volume + calibration; L14/D58
  privacy pass already covers the aggregate substrate.
- **Additional C-outputs** (Whoop, etc.) — adapters off the same normalized track.
- **`appConfig` runtime-tuning seam** — the D59 decay rate stays edit-and-redeploy (Phase 07 posture).
- **Encoded-polyline transport** — only if a client render path needs it; default is GeoJSON.
- **Code-level GPS replay rig for CI** — the emulator GPX playback covers manual QA today.

## Build outcome (2026-07-24) — ✅ complete; what shipped, and where it differs from this plan

All five PR slices are built on `phase-08-native-capture` (merged as PR #26 on 2026-07-26 and on
dev; device verification still owed — roadmap Phase 08 § Owed). Suites green: core 752 / convex 540 / web 152 / mobile 76.

**Founder calls taken at kickoff:**
1. **Freshness is internal in v1** — it drives path opacity and the shared bounty primitives; report
   cards keep their existing relative-time labels. Adding a visible freshness meter was rejected as
   the closest thing here to an authoritative safety verdict (D3).
2. **Recorder lives on the map beside on-ice mode** — the two are orthogonal choices about the same
   skate, so adjacency is what makes that legible.
3. **Full offline record→report linkage** — a report draft carries the track's *local* id and the
   flush resolves it to an `activityId`.
4. Strava app registered; **callback domain still to be set** to the Convex `.site` host (the record
   disagreed with itself on this until 2026-09-20; treated as unset until confirmed on the dashboard).

**Deltas the build found (this section supersedes the plan above where they conflict):**
- **§`reportFreshness` — D59's premise was partly wrong.** `bounties.ts` has **no recency-decay curve**
  to extract; it computes a window in hours and compares. The shared surface is the netThumbs clamp
  (`clampedNetThumbs` / `netThumbsBoost`); the decay curve is net-new. The refactor is therefore
  smaller and far safer than the plan implied — **every Phase 06 bounty test passes untouched.**
- **Two bounty↔report divergences are now explicit, not accidental.** Net-unhelpful thumbs *shorten* a
  bounty window (safety-positive: it summons fresh eyes sooner) but are **boost-only** for report
  freshness, where they would let downvotes fade a person's path off the map. Weather collapses a
  bounty window to 0 but only *multiplies* report freshness down.
- **Range is `[0,1]`, not `(0,1]`** — freshness underflows to a true 0 past ~1000 half-lives. The
  never-hide guarantee lives in `pathOpacity`'s floor, which holds at any age.
- **§`pathToBody` — buffer, don't hull.** A hull swallows land, islands and the next bay over on any
  track that doesn't circumnavigate. It **does** fill interior rings (a lap around a pond otherwise
  stores a donut, and a hole at the water body's center is where later reports fail to resolve) and refuses
  a track with no real extent (turf buffers a motionless phone into a perfect circular "pond"). No
  `@turf/convex`/`@turf/concave` dependency was added. Accepted cost: an out-and-back yields a
  corridor, so a later report from the far shore may create a near-certain duplicate — which is
  exactly what the D36 queue is for, and widening a shape is safer than shrinking an over-claimed one.
- **§`waterBodies.create` is path-only at the trust boundary.** It takes `activityId`, **not a
  polygon** — the server derives the geometry — so "no freehand drawing, ever" is a server contract,
  not a UI convention. The pre-existing tests were migrated to the new contract rather than relaxed.
- **`near_certain` added to `DEDUP_STATUSES`.** D36 always had three tiers; the schema had two, so the
  top tier had nowhere to go. `listDedupCandidates` surfaces both, near-certain first. A flagged body
  stays **listed** — hiding it would pull reports filed against it off the map on a machine's guess (D3).
- **§Strava — a new `oauthStates` table was required.** The plan didn't cover it: an OAuth callback is
  an *unauthenticated* browser redirect, so without a single-use state nonce a replayed callback could
  bind a Strava account to the wrong profile. Nonces are burned on read (even when expired) and swept
  by a cron. **Token refresh is net-new** for this codebase — every other integration uses a static key.
- **§`toEncodedPolyline` — not built.** Both maps draw the GeoJSON path directly, so encoded-polyline
  transport (and `@mapbox/polyline`) buys nothing.
- **§Aggregate layer caps at 200 tracks per body** and returns the dropped count — a silently
  truncated map reads as "this is everything".
- **A failed Strava push never fails a flush**, and a failed track never blocks its report (D24). The
  activity is ours the moment it's ingested; Strava is a courtesy copy and the path is enrichment.

**Still outstanding:** device verification (Android-emulator GPX playback; a friend's iPhone for iOS
background/battery parity), a real Strava sandbox upload, prod cutover.

## Post-build follow-ups (2026-07-25)

Both came out of a full read of `plans/` against the code after the phase was called done.

- **✅ FIXED — the D58 opt-out was mobile-only.** `apps/web` had no way to set
  `excludeTracksFromAggregate`, so a web user whose paths were already aggregating couldn't withdraw
  them — and unlike the recorder (reasonably phone-only), a *consent control over data already
  collected* has to work wherever you signed in. Shipped as
  `apps/web/src/components/AggregateTracksSetting.tsx` on the settings page, saving immediately like
  the notification toggles rather than behind the profile editor's Save (a privacy switch shouldn't
  have a second step you can abandon). The copy moved to **`packages/core/src/trackPrivacy.ts`** and
  both surfaces now read it: two surfaces wording one privacy promise differently means one of them is
  describing behavior the app doesn't have. **Connecting Strava stays mobile-only** — it's an adjunct
  to recording, and the settings page says so.
- **✅ FIXED — `ingestTrack` accepted a `distanceMeters` it never stored.** `processTrack` derives
  distance from the very points it emits as `path`, so the value was exactly
  `trackStats(path).distanceMeters` — no information, but an argument that let a client assert a number
  contradicting the stored geometry, and a signature implying a persisted distance. Dropped from the
  mutation, `TrackFlushEffects`, and the mobile adapter; the recorder's live readout keeps its own
  (display state). If a read ever needs distance without loading paths, denormalize it *then*, with
  the consumer that justifies it.

## Open questions / risks

- **Bounty-refactor behavior preservation.** If extracting the shared primitives can't reproduce
  `bountyFreshWindowHours` exactly (float ordering/rounding), **stop and reassess** — do not edit the
  Phase 06 tests to fit. Fallback: keep bounties on their private copy and unify only report+path
  (still solves the stated report↔path divergence worry).
- **iOS background/battery parity** without an owned device — friends'-iPhone testing is real but
  intermittent; budget for a QA gap and be conservative on the iOS background-mode copy.
- **`pathToBody` polygon quality.** Buffer + hull off a single track can produce odd shapes for
  out-and-back or looping skates; tune buffer width / hull concavity and lean on the moderator
  review-after (D37 `reviewStatus`) as the safety net. A body is auto-visible then reviewed.
- **Aggregate render at scale.** Per-body scoping avoids the `listInViewport` read-cap trap now; if
  a giant body (Champlain) accumulates many tracks, page/limit `listTracksForBody` and lean on the
  opacity decay to bound what's worth drawing.
- **Watch-wins default** before auto-detect exists — v1 per-session toggle defaults on for
  phone-only; a user with a watch could double-record until they toggle off. Acceptable for alpha.


---

## Relocated from the roadmap (2026-09-16)

*The roadmap entry for Phase 08 as it stood before the 2026-09-16 rewrite, kept verbatim so nothing it said is lost. The roadmap now carries a one-paragraph summary; this is the long form.*

### Phase 08 — Native track capture + Strava push (the A→B→C pipeline) ✅ Complete (dev; prod deferred) (2026-07-24)
> **Status: ✅ complete — all five workstreams shipped.** Suites green: core 752 / convex 540 /
> web 157 / mobile 76. **Still device-unverified** (Android-emulator GPX playback + a friend's iPhone
> for iOS background/battery parity) — the one outstanding item that isn't the prod cutover.
> 08-1 unified freshness (D59) → 08-2 recorder + B spine → 08-3 user bodies + dedup (D14/D36) →
> 08-4 Strava push (C) → 08-5 aggregate layer + privacy (D58).
>
> **Key build deltas vs this plan** (the phase doc's "Open questions" resolved, plus what the code found):
> - **D59's premise was partly wrong.** `bounties.ts` had **no recency-decay curve to extract** — it
>   computes a *window in hours* and compares. The genuinely shared surface is the netThumbs clamp; the
>   decay curve is **net-new**. Every Phase 06 bounty test passes untouched (the D59 acceptance gate).
> - **Two deliberate bounty↔report divergences, now documented rather than accidental:** net-unhelpful
>   thumbs *shorten* a bounty window (shortening summons fresh eyes — safety-positive) but are
>   **boost-only** for report freshness, where they'd let downvotes fade someone's path off the map;
>   and weather collapses a bounty window to 0 but only *multiplies* report freshness down.
> - **Freshness has no visible report-aging consumer in v1** (founder call): it drives path opacity +
>   the shared bounty primitives; report cards keep their relative-time labels. Least D3 risk.
> - **`pathToBody` buffers but does NOT hull** — a hull swallows land/islands on any non-circumnavigating
>   track. It *does* fill interior rings (a lap around a pond would otherwise store a donut with a hole
>   at the water body's center where reports fail to resolve) and refuses a track with no extent (turf happily
>   buffers a motionless phone into a perfect circular "pond"). No `@turf/convex` dep added.
> - **`waterBodies.create` is now path-only at the trust boundary** — it takes an `activityId`, **not a
>   polygon**, so "no freehand drawing, ever" is a server contract rather than a UI convention. Existing
>   tests were migrated to the new contract, not relaxed.
> - **`near_certain` added to `DEDUP_STATUSES`** — D36 always had three tiers and the schema had two.
>   `listDedupCandidates` now surfaces both, near-certain first. A flagged body stays **listed** (D3).
> - **New `oauthStates` table + `convex/http.ts`** (first HTTP router in the repo): an OAuth callback is
>   an unauthenticated browser redirect, so a single-use state nonce is what binds it to a user.
>   **Token refresh is net-new** for this codebase (every other integration uses a static key).
> - **No `toEncodedPolyline`/`@mapbox/polyline`** — both maps draw the GeoJSON path directly.
> - **Aggregate layer caps at 200 tracks/body** and returns the dropped count (no silent truncation).
>
> **Follow-ups after the build (2026-07-25):** the D58 aggregate opt-out shipped **mobile-only** and was
> added to the web settings page (copy single-sourced in `core/trackPrivacy.ts` so a privacy promise
> can't drift between surfaces); `ingestTrack` stopped accepting a `distanceMeters` it never stored
> (derivable from `path` exactly).
>
> **Outstanding:** device verification (Android-emulator GPX playback + a friend's iPhone for iOS
> background/battery parity), a real Strava sandbox upload (the callback domain first — see §Strava
> above), and the prod
> cutover.

> **Detailed build plan:** [`phases/08-native-capture.md`](./08-native-capture.md) (scoped
> 2026-07-24). Reframe write-up:
> [`research/native-track-capture-and-strava-push.md`](../research/native-track-capture-and-strava-push.md)
> + Strava legal read (`08-legal-feasibility-checklist.md` L7). New decisions: **D58** (aggregate-track
> privacy), **D59** (unified report freshness).

> **⚠️ The old "pull GPS from Strava" plan is dead.** Strava's Nov-2024 terms **forbid** displaying one
> athlete's data to any other user (even public data) and **ban AI/ML** over it — killing the cross-user
> map/heatmap/report-path off Strava data. **The whole phase inverted:** we **record the track in a native
> in-app recorder** (first-party data we own → legal to aggregate + draw on public reports) and **push** it
> to Strava (`activity:write`, the Garmin model — clearly allowed, the adoption lever: *record once, keep
> your Strava stats*). Modeled as **A → B → C**: A = capture inputs (**native recorder** first;
> Garmin/HealthKit/COROS/Polar deferred), **B = our own track store + resolve-to-body + aggregate, the
> always-owned hub**, C = push outputs (**Strava** first). No provider keys exist yet; only the **free
> Strava app** (instant, no review) is needed, and only for the push slice.

- **Native recorder (A-input #1)** — session record/pause/resume/stop over a durable expo-sqlite buffer,
  a Record-grade GPS profile, background/foreground-service, reusing the **Phase 09b on-ice primitives**.
  Track post-processing (smooth/gate/cull → GPX + GeoJSON) in `@skating/core`. Phone-only skater's source;
  battery is an honest, opt-in trade (D3 copy). **Paths only ever come from legitimate recorded sources —
  no freehand drawing, ever.**
- **B — our track store + resolve-to-body (D44)** — normalize any track → `gpsActivities`, resolve to its
  `waterBodyId`, link to a report. **The recorded path renders on the report detail view** (display-only)
  **and** on the aggregate tracks layer.
- **User-created water bodies (D14) + match-on-create dedup (D36)** *(moved here from Phase 02a — needs a
  trusted path)*. A skate resolving to **no** known body creates/attaches one **from the trusted path only**
  (buffer + hull → polygon; new `core/dedup.ts` + `pathToBody.ts`; `findMatchCandidates` steer; stamp
  `dedupStatus`/`duplicateCandidateIds`; auto-visible then review-after, D37). **Path-only gated — no manual
  draw** (no path ⇒ no proof of presence, no scale/shape reference). **Feeds the already-built Phase 07 merge
  queue** (which has had nothing flowing into it).
- **Strava push (C-output #1)** — new `convex/http.ts` router (first in the repo), OAuth `activity:write` +
  per-user token refresh, `POST /uploads` + poll, per-session "also upload?" toggle (watch-wins deferred),
  "Powered by Strava" / "Connect with Strava" brand kit (L7).
- **Aggregate tracks layer (B, D58)** — decaying public-track overlay per selected body (opacity fades as
  the linked report ages, D59). Privacy = **publish-is-consent** (only report-linked, non-minor paths), **no
  k-anonymity** (a public report is meant to be shared — one skater is enough), **put-in-gated endpoint
  clipping** (`showPutIn` withheld ⇒ clip first/last ~150 m, protecting a skate-from-home), **minors excluded
  by construction**, global **opt-out**. The tuning-heavy crowd-intelligence derivations (pressure-ridge /
  clearest-side, L9 deduction) are **deferred** — need volume + calibration.
- **Unified report freshness (D59)** — one `core/reportFreshness` primitive; report-aging and path-opacity
  consume the *identical* value (the path is the report's extent — can't diverge); **bounties refactor onto
  the shared primitives** (keeping their own window/trust/reopen policy; existing Phase 06 tests stay green).
- **Done:** a phone-only skater records a skate in-app, sees the real path on their report and on the water body
  map (fading as it ages), can push it to their Strava, and a skate on **new** water creates/attaches a body
  from the trusted path (dedup-steered).
- **Deferred:** third-party capture adapters (Garmin/HealthKit/HC/COROS/Polar) + the watch-wins ingest path
  — each integrated individually later (**apply for Garmin/COROS/Polar partner programs now**, ~weeks of
  review); additional push targets (Whoop); path-cluster hazard deduction (L9/Q11).

