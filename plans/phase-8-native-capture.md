# Phase 8 — Native track capture + Strava push (the A→B→C pipeline)

*Detailed build plan — scoped 2026-07-24. Supersedes the original "GPS providers (pull/ingest)"
framing of Phase 8 in [`07-roadmap.md`](./07-roadmap.md). Built on the reframe in
[`research/native-track-capture-and-strava-push.md`](./research/native-track-capture-and-strava-push.md)
and the Strava legal read ([`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md) L7).
New decisions this phase: **D58** (aggregate-track privacy) and **D59** (unified report freshness).*

## The reframe (why this phase looks nothing like the old Phase 8)

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
  native recorder  ─┐         ┌ normalize → resolve-to-lake ┐   ┌ Strava (activity:write)
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
- **The recorded path renders on the individual report detail view** (a lake map showing the track,
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
  iPhone, but iOS record-mode/background verified on friends' devices.
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
  a Record-grade GPS profile) reusing the Phase 9.5 on-ice primitives.
- Track **post-processing in `core`** (smoothing / accuracy-gating / stationary-culling) + **GPX**
  and **encoded-polyline** emitters.
- **B**: normalize a recorded track → `gpsActivities`, **resolve-to-lake** (D44), link to a report.
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
- A code-level GPS **replay rig** for CI (Phase 9.5 uses the Android emulator's GPX playback; a
  fixture-driven replay module remains a nice-to-have, not scoped).
- Runtime-editable tuning constants (the `appConfig` seam is still deferred — the D59 decay rate is
  an edit-and-redeploy `ConstantCard`, matching Phase 7).

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
     **Acceptance gate: every existing Phase 6 bounty test stays green, untouched.** Bounty and
     path/report are *not* the same final formula (that's correct — different questions); they share
     the primitives that would otherwise drift.
   - New tunable decay-rate constant in `reputationConfig.ts`, surfaced as a **read-only
     `ConstantCard`** in `admin.tuning.tsx` (Display & map section), paired with a metric chart —
     the Phase 7 pattern. (Edit-and-redeploy; no runtime `appConfig` table.)

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
  `dedupStatus: 'clean'` with a "Phase 8 TODO") to run **match-on-create**: call a new
  **`findMatchCandidates`** query (bbox + geospatial-nearest prefilter → score with `core/dedup.ts`),
  stamp `dedupStatus` / `duplicateCandidateIds`, and require an explicit `confirmedNew` when strong
  matches exist. This is the **producer** the Phase 7 dedup queue has been waiting for
  (`listDedupCandidates` today "expects ~zero rows until Phase 8"). The **merge mutation, moderator
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
  linked report). Scoped **per selected body** (like Phase 9 hazards) — **not** a cross-viewport
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

## Mobile — the recorder (reusing Phase 9.5 on-ice primitives)

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
- **Aggregate opt-out** in profile settings ("Don't use my paths in community lake maps").

## Testing (lands with the feature — D40)

- **`core` pure logic** (high coverage): `track.ts` (accuracy-gate/cull/smooth/stats/GPX/GeoJSON),
  `pathToBody.ts`, `dedup.ts` (D36 threshold table — property tests over synthetic polygons),
  `reportFreshness.ts` (decay monotonicity, opacity floor, signal blending).
- **The D59 refactor gate:** run the **existing Phase 6 bounty suite unchanged** and require green;
  add tests that report-aging and path-opacity read the *same* freshness for the same report.
- **`convex-test`:** `gpsActivities` ingest idempotency (`by_provider_activity`), D44 resolution +
  create-or-attach fallback, `findMatchCandidates` scoring + `dedupStatus` stamping (feeds the Phase
  7 merge queue), `listTracksForBody` privacy (minor-excluded, put-in clip, opt-out), Strava upload
  action against a mocked `fetch` (upload → poll → activity_id / error / duplicate).
- **Device/manual:** Android-emulator **GPX route-playback** (the Phase 9.5 rig) to exercise
  record → buffer → stop → resolve → render; a friend's iPhone for iOS background + battery parity;
  a real Strava sandbox upload on the founder's own account.

## PR / commit breakdown

This phase is large enough to warrant **multiple PRs** (a native spike + a shipped-code refactor +
external OAuth + a new map layer) — a deliberate exception to the usual one-PR-per-phase rule
(memory: bundle-prs-by-phase), because each has a distinct review + verification surface (Greptile is
metered, but device testing and the bounty-refactor gate want isolation). Sub-workstreams are commits
within each PR.

1. **PR 8a — Unified report freshness (D59).** Extract shared primitives → `core/reportFreshness.ts`;
   adopt in report-aging display; **refactor `bounties.ts` onto it (existing tests green, untouched)**;
   add the decay-rate `ConstantCard`. *De-risks the shipped-code refactor first, standalone.*
2. **PR 8b — Native recorder + B spine.** `core/track.ts` (+ GPX), Record GPS profile, recording
   session + sqlite `track` kind, foreground service / background, `gpsActivities.ingestTrack` +
   `resolveToBody` (D44), report-detail path render. *Device-tested; produces the tracks everything
   downstream needs.*
3. **PR 8c — User bodies + dedup (D14/D36).** `core/dedup.ts` + `core/pathToBody.ts`,
   `findMatchCandidates`, `create` match-on-create, create/attach UX. *Feeds the Phase 7 merge queue.*
4. **PR 8d — Strava push (C).** `convex/http.ts` + OAuth `activity:write` + token refresh +
   `uploadActivity` (upload/poll) + watch-wins toggle + brand kit. *Needs the free Strava app
   registered.*
5. **PR 8e — Aggregate tracks layer + privacy (D58).** `listTracksForBody`, the decaying tracks
   overlay (opacity from 8a), put-in-gated clipping, minors-out, profile opt-out. *Depends on 8a+8b.*

**Order:** 8a → 8b → (8c ∥ 8d) → 8e. 8a and 8b are the backbone; 8c/8d are independent adapters off
B; 8e needs B producing tracks + 8a's opacity.

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
- **`appConfig` runtime-tuning seam** — the D59 decay rate stays edit-and-redeploy (Phase 7 posture).
- **Encoded-polyline transport** — only if a client render path needs it; default is GeoJSON.
- **Code-level GPS replay rig for CI** — the emulator GPX playback covers manual QA today.

## Open questions / risks

- **Bounty-refactor behavior preservation.** If extracting the shared primitives can't reproduce
  `bountyFreshWindowHours` exactly (float ordering/rounding), **stop and reassess** — do not edit the
  Phase 6 tests to fit. Fallback: keep bounties on their private copy and unify only report+path
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
