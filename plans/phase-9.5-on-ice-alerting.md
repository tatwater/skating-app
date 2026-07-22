# Phase 9.5 build plan — On-ice live alerting (D54 Layer 2) + deferred hazard threads

> **Roadmap / parent:** the fast-follow to [`phase-9-hazards.md`](./phase-9-hazards.md). Phase 9 shipped
> Layers 0–1 (silent sync + foreground-only proximity banners); this is the deferred **D54 Layer 2** —
> the opt-in **"on-ice mode"** that keeps warning you *while you skate with the phone in your pocket* —
> bundled with the several smaller hazard threads Phase 9 logged as deferred.
>
> **Naming.** `9.5` mirrors `2.5` (the Phase 2 offline fast-follow): a same-phase follow-on, not a new
> roadmap phase.
>
> **Status:** 🔜 **Planned (2026-07-21).** Awaiting founder review of this doc before build.
>
> **Prerequisites — all in place.** Phase 9 is **merged (PR #20), on dev, Android-emulator smoke-tested**.
> The pure proximity evaluator (`hazardProximity.evaluateOnIceAlert`), the per-session `alerted` set
> (`onIce.ts` `AlertSession`), the on-device hazard cache, and the `skating://hazard/<id>` route all
> exist and were built *specifically* so this layer is additive. What's genuinely new: one pure core
> module (directional projection), a fresh native-dep set (`expo-notifications`, `expo-task-manager`,
> background location), and the wiring.

Decisions referenced as D#; see [`01-decisions.md`](./01-decisions.md).

---

## Decisions locked this session (2026-07-21)

Founder calls made while scoping this fast-follow. They **amend D54 a second time** and should be
promoted to `01-decisions.md` as a *D54 Layer-2 amendment* alongside the existing kickoff amendment.

- **No keep-awake, ever.** The screen sleeps at the standard device pace. On-ice mode does **not** hold
  the display on (`expo-keep-awake` is *not* added). Real-world model: the phone is face-down in a jacket
  pocket, screen off. This is the correct design *and* the honest one — we lean on **background location +
  local notifications**, not a lit screen.
- **Background GPS during a session is fine; the OS indicator IS the affordance.** Both platforms force a
  visible indicator for background location — Android a foreground-service notification, iOS the blue
  location pill. That OS-mandated indicator *is* the D54 "on-ice mode is on" affordance, and its
  notification / settings entry is the one-tap off. We get the honesty affordance for free.
- **Course-over-ground for heading, not the magnetometer.** Nobody skates holding the phone out ahead;
  it's pocketed and tumbling, so a compass reading is noise. GPS course-over-ground (`coords.heading`,
  valid only while moving) is the projection's heading source. Below a walking-pace speed floor, heading
  is treated as unknown and directional alerting simply doesn't fire (Layer-1 proximity still does).
- **Re-alert cadence is a user setting** (founder call, 2026-07-21). Two modes, exposed as a toggle in the
  on-ice-mode UI (there is no general settings screen yet, and this is exactly where it's relevant):
  - **Once per session** (**default**) — one alert per hazard for the whole armed session; if you skate
    away and back you're expected to remember. Lowest noise, best against alarm fatigue.
  - **Every approach** — re-alerts each time you genuinely re-approach a hazard, for people who want the
    reminder. This needs an **approach model**, not just a set: a hazard is un-suppressed only once the
    skater has clearly *left* its vicinity (distance > a hysteresis threshold, e.g. `2 ×
    alertBufferMeters`), so "every approach" can't collapse into "every fix" spam. Both modes still share
    the *currently-suppressed* set across the directional + proximity paths, so the two never double-fire
    on a single pass.
  - Default-once-per-session is the safer default (a system that has only ever been quiet is the most
    dangerous signal — D3 — so we bias toward *fewer, heeded* alerts and let the reminder-wanters opt up).
- **Local notifications only; server-push-to-a-sleeping-phone stays deferred.** See scope below.

---

## Scope

### In
1. **D54 Layer 2 — on-ice live alerting** (the headline):
   - `expo-notifications` for **local** notifications (no push token, no server, no credentials — the
     alert is computed and fired entirely on-device, so D12 still holds).
   - **Session-scoped background location** via `expo-task-manager` (`startLocationUpdatesAsync`), armed
     when the skater taps "start on-ice mode," auto-stopped when they leave the lake footprint / tap off.
     No keep-awake.
   - **Directional projection** — new pure core module: project the path forward from course + speed,
     intersect cached hazard footprints, fire at **time-to-encounter ∈ [30 s, 60 s]**, per-session dedup.
2. **`?action=confirm` deep link** — the notification tap opens the hazard drawer *pre-focused on the
   confirm control*. Mandatory: this is the whole point of the deep link the notification lands on.
3. **Hazard reporter/author line** — `hazards.get` / its view returns a block-respecting author, so the
   detail drawer can show "reported by <name>" (the component already supports the prop).
4. **Clip-footprint-to-body** — precompute + store the hazard footprint clipped to the water-body polygon
   so a big circle can't imply danger across land / a neighboring lake. Its own commit (it touches the
   draw-==-measure invariant, so it clips **render, bbox, and the proximity distance** or none).
5. **Auto-suggest skate start/end times** — the on-ice watcher already knows when the device entered and
   left a lake footprint; prefill the report form's skate window from that dwell interval.
6. **"Back to the lake you're on" button** (founder call) — a recenter affordance that appears whenever
   GPS resolves to a body **and** the skater has navigated/panned away from it, tapping which re-selects +
   frames the lake under their feet. Like a map app's "jump to me," but lake-scoped and only while you've
   wandered off. Independent of on-ice mode being armed, and doubles as the way back during an armed
   session.
7. **Layer-3 offline basemap tile-pack — retry** on this same dev-client build (the spike's blocker was
   never resolved; the build is the cheap moment to try it).

### Out
- **Server-push-to-a-sleeping-phone — deferred.** It is the only
  variant that *uploads* live location — the biggest privacy departure from D12, deserving its own
  decision, not a ride-along on a large PR. It needs a whole net-new stack nothing else here touches
  (device push-token registration, **APNs + FCM credentials on both stores**, a server-side sender),
  iOS throttles silent pushes so it's best-effort *by design* (a shaky base for safety content), and the
  on-ice-mode design makes it nearly moot: while a session is armed the app is already alive in the
  background syncing reactively. Local notifications (in scope) need none of that stack. Revisit as its
  own focused decision.
- **Per-body summary cards** and **freeform polygon authoring** — explicitly not needed yet (founder).
- Everything Phase 9 already deferred to Phase 7/8/10 (admin tuning UI, consensus render, GPS
  negative-evidence, weather-driven decay, shore-band snap) stays where it is.

---

## `@skating/core` — the one new pure module

**`hazardProjection.ts` — course-over-ground directional alerting.** Pure, property-tested to the same
bar as the rest of the hazard core (D40), so the "hazard ahead" math is verifiable without a GPS or a map.

```ts
export interface DirectionalFix {
  coord: LatLng;
  /** GPS course over ground, degrees clockwise from north. <0 (or absent) ⇒ heading unknown. */
  headingDeg: number;
  /** Ground speed, m/s. <0 (or absent) ⇒ unknown. */
  speedMps: number;
}

export interface EvaluateDirectionalOptions {
  leadMinSec?: number;   // 30
  leadMaxSec?: number;   // 60
  minSpeedMps?: number;  // ~0.8 (walking pace) — below this, course-over-ground is junk
  sampleStepMeters?: number; // ~15 — path sampling granularity
}

export function evaluateDirectionalAlert(
  fix: DirectionalFix,
  hazards: readonly ProximityHazard[],
  alreadyAlerted: ReadonlySet<string>,
  options?: EvaluateDirectionalOptions,
): HazardAlert[]
```

**Algorithm (chosen to *reuse* the draw-==-measure invariant, not fork it):**
1. **Guard.** If `speedMps < minSpeedMps` or `headingDeg < 0` → return `[]`. Standing still or unknown
   heading means no honest forward path; Layer-1 proximity covers the "you're right on it" case.
2. **Project the forward path.** From `coord`, walk along `headingDeg` out to `speedMps * leadMaxSec`
   metres, **sampling every `sampleStepMeters`** (using `toLocalMetres` / the existing local-metric
   projection in `geometry.ts`).
3. **First contact per hazard.** For each hazard, the first sample with `distanceToHazard(sample, shape)
   === 0` (inside the footprint) is the encounter point; encounter distance → **TTE = distance /
   speedMps**. Reusing `distanceToHazard` is deliberate: the path is tested against *exactly* the same
   buffered footprint that's drawn and that Layer-1 measures — so "warned about" can never drift from
   "drawn." (Sampling, not analytic segment-∩-polygon, matches the footprint's honest fuzziness and keeps
   the module small.)
4. **Window + dedup.** Emit an alert only if `TTE ∈ [leadMinSec, leadMaxSec]` and the hazard isn't in
   `alreadyAlerted`. Passage markers (`ridge_crossing`) never fire — same rule as `evaluateOnIceAlert`.
5. Return nearest-TTE-first, so a single-notification UI shows the most imminent.

The pure evaluator stays **dedup-model-agnostic** — it takes whatever suppressed set the caller hands it.
The *once-per-session vs every-approach* choice (above) lives in the **session layer** (`onIce.ts`),
which owns when a hazard is added to and — in every-approach mode — removed from that set. Keeping the
approach/hysteresis logic in the session fold means the core module has no notion of "a session" and
stays a pure geometry function.

**Property tests:** monotonic (faster speed → same hazard enters the window sooner); a hazard directly
*behind* the heading never fires; a hazard dead ahead at `speed × 45 s` fires, one at `speed × 90 s`
does not (yet); the guard holds (zero/low speed and negative heading → `[]`); passage markers excluded;
one malformed cached row can't throw the loop (mirrors the `evaluateOnIceAlert` defense).

**Session integration stays in mobile, stays pure-ish.** `onIce.ts` gains a directional counterpart that
folds a `DirectionalFix` into the *same* `AlertSession` — same suppressed set, same "a showing
banner/notification is never swapped out from under a moving skater" rule — and owns the re-alert-cadence
rule: once-per-session never clears the set; every-approach clears a hazard from it once distance exceeds
the hysteresis threshold. Unifying the set across the directional + proximity paths is what prevents a
double-fire on a single pass in *either* mode. The clear-on-leave transition is unit-tested (leave →
re-approach re-fires in every-approach mode; never re-fires in once-per-session).

---

## Native deps + config (the dev-client rebuild)

Adding native modules means a fresh `pnpm android` (a full native compile — a JS reload won't include
them). New:
- **`expo-notifications`** — local notification scheduling + a tap handler that routes to
  `skating://hazard/<id>?action=confirm`. No push token, no server.
- **`expo-task-manager`** — the background location task target for `startLocationUpdatesAsync`.
- **`app.config.ts`:**
  - `expo-location` plugin gains **background** capability: `isAndroidBackgroundLocationEnabled: true`,
    `isAndroidForegroundServiceEnabled: true`, and the iOS `locationAlwaysAndWhenInUsePermission` copy.
  - Android permissions: `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
    `FOREGROUND_SERVICE_LOCATION`; foreground-service type `location`.
  - iOS `UIBackgroundModes: ['location']`; `expo-notifications` plugin for the notification icon/sound.
  - **No `expo-keep-awake`.** No `UIBackgroundModes` beyond `location`.
- **Notification permission** is requested lazily *at arm time*, through a small shared singleton mirroring
  `ensureForegroundPermission()` — never on cold launch.

The **course + speed** already come free from `watchPositionAsync`'s `LocationObject.coords`
(`heading`, `speed`); the background task delivers the same shape. `expo-sensors` / magnetometer is **not**
added (course-over-ground decision).

---

## Mobile — "on-ice mode"

- **Arm/disarm.** A control on the map (near the ⚠ flag FAB) toggles on-ice mode. Arming: request
  notification permission → start the background location task → show a "on-ice mode on" state; the OS
  foreground-service notification / blue pill is the persistent indicator, and it (plus an in-app toggle)
  is the one-tap off. Auto-disarm when the watcher reports the device has left the lake footprint for a
  debounced interval, or on explicit off.
- **Delivery.** While armed, each fix (foreground **or** background) folds into the shared `AlertSession`:
  - Foreground → the existing top **banner** (Layer 1, unchanged).
  - Background / screen-off → a **local notification** ("⚠ Open water ~45 s ahead — tap to confirm"),
    tapping which fires `skating://hazard/<id>?action=confirm`.
  - Same `alerted` set → no double-fire when a projected hazard later becomes a proximity hit.
- **Copy — silence is not an all-clear (D3).** The arm control and the notification settings both state
  that no alert never means the ice is clear, and that coverage depends on GPS + the hazard already being
  reported. This is the reason foreground-only was acceptable in v1 and it matters *more* here, where a
  quiet background session can feel authoritative.
- **Battery honesty.** Continuous background GPS in cold drains battery; session-scoped + auto-disarm +
  the visible indicator keep it honest. `Accuracy.Balanced` (not `BestForNavigation`) unless projection
  accuracy in emulator testing demands more.
- **"Back to the lake you're on" button.** Shows when `onIceWaterBodyId !== null` **and** the current
  route isn't already that body (you've navigated/panned to a different lake or the bare map). Tapping it
  `router.navigate`s to `/water/[onIceWaterBodyId]` — reusing the exact select-and-frame path the
  once-per-open auto-select already uses, so the hazard layer follows and the lake frames into the
  drawer's uncovered space. It's the manual sibling of `shouldAutoSelectOnIce`: auto-select fires *once*
  on open, this button is how you get back any time after. Gated on GPS-resolves-to-a-body, **not** on
  on-ice mode being armed (useful while just exploring), and it sits where the on-ice controls cluster so
  it reads as "you're on ice — jump there."

---

## The smaller threads

- **`?action=confirm` (both platforms).** `/hazard/[id]` (mobile) and `/_map/hazard/$id` (web) read an
  `action` param; `action=confirm` scrolls/expands the three-tier confirm control into view. The
  destructive "fully healed" verdict stays de-emphasized + confirmed even when deep-linked (D3).
- **Reporter/author line + "confirmed by N".** `hazards.get` (and its `toView`) resolve the author's
  display name **through the viewer's block list** (a blocked author's name is withheld the same way
  comments handle it), and the container passes `reporterName` the component already supports. **No new
  storage is needed for the confirmer count:** `hazardConfirmations` already stores one row per user per
  hazard (`userId` + `verdict`), and `confirmCount` (distinct non-author "still here / healing" votes,
  author excluded) is already stored on the hazard — so "Reported by John Doe · confirmed by 3 others" is
  just surfacing a field we already keep. **Recommended default: name the reporter, count the
  confirmers** — naming everyone who confirmed would attach identities to "was standing on this ice,"
  a location-privacy exposure the reporter (a content author) has already accepted but a confirmer
  hasn't. `listForHazard` already returns the confirmer rows if we later want a tap-to-expand list; the
  count-only default sidesteps the privacy call for now. Copy stays present-tense-safe (a `fully_healed`
  vote is not a "confirmation"; D3).
- **Clip-footprint-to-body (own commit, safety-critical path).** Add `clippedFootprint?` (a stored
  polygon) to `hazards`, computed at `create` by intersecting `hazardFootprint(shape)` with the resolved
  body polygon (the body is already resolved via `resolveSurvivor`). `hazardLayer`, `hazardBbox`, and
  `distanceToHazard` read the clipped polygon when present, falling back to the live footprint when
  absent — so it's **migration-safe** (existing dev rows keep working, lazily recomputable). This makes
  the watcher *cheaper* (a stored polygon, no per-fix buffer/intersect) — the same "decide the shape once"
  move the layer already makes. `HAZARD_MAX_SIZE_M` stays as the crude backstop for the un-clipped path.
- **Auto-suggest skate times — per-body, earliest-in / latest-out.** The source is the **on-ice watcher's
  own GPS** (not on-ice-mode timing specifically), so this is largely the "already solved" case you asked
  about — but with one important rule. The watcher records enter/leave timestamps **per body**, debounced
  against brief GPS excursions (a lap that clips the shoreline isn't a "left"). When the report form opens
  for body X, it prefills the skate window from **`min(start)` and `max(end)` across *all* of today's
  intervals on body X** — so exiting/re-entering on-ice mode to peek at a neighbouring lake and coming
  back, or a snack break off the ice, collapses to one suggested window (earliest start, latest end), and
  excursions to *other* lakes never fragment X's suggestion (aggregation is per-body). Editable, never
  authoritative.
  - **Accuracy caveat worth stating:** the dwell data is *complete* only when on-ice mode was armed
    (background fixes keep flowing with the screen off); unarmed, the watcher is foreground-only, so a
    pocketed-phone stretch leaves gaps and the suggestion is best-effort. Earliest/latest aggregation is
    the same either way — arming just fills it in. Intervals are on-device only (D12), pruned to the day.
  - Overlaps the D24 activity-detection path; keep the bookkeeping small and local to the watcher.
- **Layer-3 offline basemap tile-pack — retry.** From the Phase 9 spike, the blocker is our `pmtiles://`
  object-built style has no crawlable URL for `OfflineManager.createPack`. On this build, test the three
  logged routes in order of cheapness: (1) confirm whether native pmtiles reads a `file://` archive
  (ship a mini regional `.pmtiles`, point the style at a local URI); (2) `mergeOfflineRegions` with a
  prebuilt sqlite DB; (3) host a crawlable style + tile URLs purely for `createPack`. Timebox again; if it
  resists, it stays dropped and on-ice capture keeps degrading correctly (pin drops at GPS; only map-tap
  Move/Trace needs tiles).

---

## Testing

- **`@skating/core`:** `hazardProjection.ts` to 100% (the properties above) + the shared `alerted`-set
  unification.
- **Mobile logic (Vitest):** the session fold for directional fixes (banner-vs-notification selection,
  no-swap rule, dedup across both paths), arm/disarm + auto-disarm debounce, the enter/leave dwell
  bookkeeping.
- **Emulator functional test (this is how we "fake live skating"):** the Android emulator's
  *Extended Controls → Location* plays back a **GPX route**, moving the simulated GPS over time. Drop the
  location inside a real dev lake that has a hazard to fire the Layer-1 banner; load a GPX track that
  skates *across* a hazard, background the app + lock the screen, and verify the directional **local
  notification** fires ~30–60 s out and its tap deep-links into the pre-focused confirm control.
- **Deferred to the real-device QA pass:** true cold-weather battery draw, real compass/course noise,
  iOS background-location behavior (Android emulator is primary; iOS validated on the QA pass).

---

## PR / commit breakdown (one PR — memory: bundle-prs-by-phase)

1. **Core** — `@skating/core/hazardProjection.ts` (directional evaluator) + property tests.
2. **Native deps + config** — `expo-notifications`, `expo-task-manager`, background-location `app.config`,
   the notification-permission singleton. Fresh `pnpm android`. No UI yet — just the build boots.
3. **On-ice mode (mobile)** — arm/disarm, background task, shared-`AlertSession` fold, the re-alert-cadence
   toggle (once-per-session / every-approach + hysteresis), banner + local-notification delivery, the D3
   copy. The Layer-2 headline.
4. **"Back to the lake you're on" button** — recenter affordance reusing the auto-select path; small, and
   independent enough to land early.
5. **`?action=confirm`** — both routes read `action`, pre-focus confirm.
6. **Reporter/author line + "confirmed by N"** — backend `hazards.get`/view + block-respecting author
   resolve + surface the already-stored `confirmCount`; both detail drawers.
7. **Clip-footprint-to-body** — schema `clippedFootprint?`, compute-at-create, render/bbox/distance read
   it, migration-safe fallback. Own commit (safety-critical).
8. **Auto-suggest skate times** — per-body enter/leave bookkeeping + earliest-in/latest-out report-form
   prefill.
9. **Layer-3 tile-pack retry** — timeboxed; drop again if it resists.
10. Open the PR (Greptile metered — review once, whole fast-follow).

---

## Open questions / risks

- **Directional accuracy on real ice** is the one thing the emulator can't fully vet (GPX playback has
  clean heading/speed; a pocketed phone gliding has noisy course-over-ground). The speed floor + Balanced
  accuracy are the first guesses; the real-device QA pass tunes `minSpeedMps`, `sampleStepMeters`, and
  whether `BestForNavigation` is worth the battery.
- **Background-location store review** (iOS "always"/background scrutiny; Android foreground-service type)
  is a *submission*-time concern, not a build blocker — prod has never been deployed, so it's logged, not
  gating.
- **Silent-push** stays deferred; if the founder wants push-to-closed-app sooner, it's a separate build
  (whole push stack + the biggest privacy call), not a fold-in here.
- **Naming confirmers (deferred micro-decision).** v1 shows a confirmer *count*, not names, to avoid
  attaching identities to "was on this ice." If we later want a tap-to-expand confirmer list (the data's
  already there via `listForHazard`), it wants a deliberate privacy call — likely gated on public profiles
  and never showing `fully_healed` voters as "confirmers."
