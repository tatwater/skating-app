# Native Track Capture + Strava Push

*Scoping doc — 2026-07-24. Extends [`04-integrations.md`](../04-integrations.md) (esp.
"Cross-user map display — our stance") and [`08-legal-feasibility-checklist.md`](../08-legal-feasibility-checklist.md)
(L7/L9). Not yet a numbered phase.*

## Why this exists

Two questions forced a rethink of the Strava plan:

1. **Legal:** Strava's Nov-2024 API terms forbid displaying one athlete's data to *any*
   other user — "Strava Data provided by a specific user can only be displayed or
   disclosed in your Developer Application to that user" — *even if publicly viewable*,
   plus a blanket **AI/ML ban**. That kills every cross-user use we actually want off
   Strava-sourced data: the lake **heatmap**, crowd **pressure-ridge / clearest-side**
   intelligence, and drawing a **path on a public report**. (Full read in the
   2026-07-24 thread; corroborated by Strava's own press release + DCRainmaker/road.cc.)
2. **Adoption:** skaters will prioritize their Strava (fitness stats + kudos) over a
   little reporting app. If recording here means *not* recording on Strava, we lose.

The resolution to both is the same reframe.

## The reframe: feed Strava, don't fight it

Instead of *reading* tracks **from** Strava (legally shackled, adoption-hostile), we
**record the track ourselves** and **push it to Strava** — the Garmin/Wahoo/COROS
model. One recording, two homes:

- **Our app** keeps the track as **our own first-party data** (Developer Application
  Data, *not* Strava Data) → we can heatmap it, aggregate it, and draw it on public
  reports **with none of Strava's restrictions**, because it never touched Strava's API.
- **Strava** receives the same activity as a normal upload to *the user's own account*
  → they keep their stats, kudos, and social graph.

This is squarely **allowed**: writing a user's own activity to their own Strava account
is the canonical complementary integration, explicitly in Strava's "still allowed"
bucket ("tools that help users understand their data"). The display/AI bans constrain
what you do with *other* users' data pulled *from* Strava; they say nothing about a
user uploading their own workout. And it removes the adoption tax entirely: **you don't
have to choose between us and Strava — record once, get both.**

> The GPS path we own is the whole point. The heatmap, the pressure-ridge crossings,
> the path-on-report — all of it becomes legal the moment the data originates in our
> recorder instead of Strava's API. Strava push is the carrot that makes users willing
> to record with us in the first place.

## Piece 1 — the native recorder (the hard part)

We already have **most of the primitive**: Phase 9.5 on-ice mode ships session-scoped
**background location** (`expo-location`), course-over-ground math, and the
`hazardProjection.ts` track-processing plumbing. Track *recording* is the same GPS
stream, retained instead of consumed-and-discarded.

What's net-new:

- **A recording session** (start/pause/resume/stop) with a durable local buffer —
  reuse the Phase 2 **expo-sqlite** offline-queue pattern so a crash/kill never loses a
  skate. Points: `{lat, lon, elevation?, timestamp, accuracy, speed?}`.
- **Foreground-service notification (Android)** + **iOS background-location mode** —
  mandatory for sustained background GPS; also the honest "we're recording" signal.
- **Track post-processing in `core`:** smoothing / accuracy-gating / stationary-point
  culling (reuse on-ice filters), then encode to:
  - **Google encoded polyline** for our own map render (cheap, matches MapLibre).
  - **GPX or FIT** for the Strava upload (see Piece 2).
- **Attach-to-report flow:** a recorded track can back a report (D24: reports *never
  require* a path, so this is additive) and/or feed the aggregate layer.

### Two independent user choices (and why GPS fidelity is one of them)

The user makes **two orthogonal** choices, set separately:

- **(a) "Keep the app watching"** — on-ice hazard alerts + quick-report while skating.
- **(b) "Record / send my skate"** — keep it as my track here and/or push it to Strava.
  This is an *export* intent.

They matter because they demand **different GPS fidelity**, and today we only have (a)'s:

- On-ice mode records at **`Accuracy.Balanced` (~100 m target), one fix per 20 m of
  movement** — chosen deliberately: *"`Balanced` accuracy, not `BestForNavigation`,
  because cold-weather battery matters more than sub-metre precision for a fuzzy hazard
  alert"* (`apps/mobile/src/lib/onIceTask.ts`). Right for "is a hazard coming up in
  30–60 s" — a 10 m hazard-projection sample step over a size-capped footprint doesn't
  need survey precision.
- **It is too coarse for a good Strava activity.** ~100 m fixes every 20 m produce a
  jagged, wandering line → **inflated distance, noisy pace, an ugly map** — a visibly
  degraded activity next to what the Strava app or a watch records. **Your worry is
  real:** a skate recorded at hazard fidelity and pushed to Strava gives worse stats.

**Resolution:** choice (b) raises fidelity for that session; (a) stays battery-friendly.
If both are on, the *record* intent wins the fidelity knob — you can always alert off a
finer stream, but you can't refine a coarse one after the fact. Three GPS profiles:

| Mode | Accuracy | Distance filter | For |
|---|---|---|---|
| Hazard-only (a) | `Balanced` (~100 m) | 20 m | on-ice alerts, battery-first (today) |
| Record (b) | `High` / `BestForNavigation` | ~5 m | export-grade track for Strava + our own data |
| Neither | — | — | no background GPS |

### Battery — the honest section

Your nervousness is correct and worth designing around, not hand-waving. Continuous
high-accuracy GPS is the single biggest drain a phone app can cause — a realistic
budget is **~5–12%/hr** depending on device, screen state, and fix cadence. A long
lake day (3–4 hrs) is a real dent. Mitigations, roughly in ROI order:

- **Record mode (b) costs more than hazard mode (a)** — export fidelity
  (`High`/`BestForNavigation`, ~5 m) keeps the GPS radio on more than `Balanced`/20 m, so
  budget the *upper* end of the ~5–12 %/hr range for a recorded skate. The plumbing is
  reused from on-ice mode, but the draw is genuinely higher — don't let the shared code
  hide that. (Hazard-only mode stays at today's cheaper profile.)
- **Adaptive sampling:** skating is smooth and predictable. 1 Hz is overkill; **1 fix
  every 3–5 s** (or distance-filtered, e.g. every 10–15 m) is plenty for a track and
  cuts radio-on time substantially. Expose as an accuracy/battery toggle.
- **Screen off ≠ stop:** the foreground service keeps recording with the screen dark —
  don't make users keep the app foregrounded (that's the real killer).
- **The Strava push costs ~nothing:** it's a single upload at *session end*, ~2 s of
  processing (below). All the battery is in the recording, which we'd do regardless for
  our own data. Pushing to Strava adds no meaningful drain.
- **Set expectations in copy** (D3 safety-first framing): a "recording" state that's
  honest about battery, with an easy "I forgot to stop it" auto-stop on prolonged
  stationarity.

**Reality check:** we will not beat a dedicated watch on battery, and we shouldn't
pretend to. Users with a Garmin/Apple Watch will record there. Our recorder is for the
**phone-only skater** and for **capturing the report-relevant path** — framed that way,
the battery cost is a deliberate, opt-in trade, not a always-on tax.

## Piece 2 — pushing to Strava

Mechanics (all verified against current Strava developer docs, 2026-07-24):

- **OAuth scope:** `activity:write` (on top of `read`). Standard Strava OAuth; store
  the refresh token server-side (Convex), refresh on expiry.
- **Endpoint:** `POST /api/v3/uploads`, `multipart/form-data`. Params: `file`,
  `data_type` (`fit` | `gpx` | `tcx`, `.gz` variants ok), `name`, `description`,
  `external_id`, `trainer`, `commute`. **Async:** returns an upload id → **poll**
  `GET /uploads/{id}` at ≥1 s until `activity_id` populates (mean processing < 2 s) or
  `error` is set.
- **Sport type:** set the file's activity type to **`IceSkate`** (verify current enum;
  GPX/TCX carry type, or set via a follow-up `PUT /activities/{id}`).
- **Duplicate handling:** Strava rejects duplicates during processing (surfaced in the
  `error` field). This matters — see the double-recording gotcha below.
- **Rate limits:** default **200 req / 15 min, 2000 / day** overall (non-upload:
  100/15min, 1000/day). One upload + a couple of polls per skate — **our load is
  trivial**, orders of magnitude under the cap.
- **Attribution:** **"Powered by Strava"** + **"Connect with Strava"** official button
  assets are mandatory wherever the integration surfaces (already an L13-class build
  criterion in `04-integrations.md`). *Note:* strictly, attribution is required where
  Strava *data* is shown; a pure push shows none — but we'll surface the connection
  state, so honor the brand kit anyway.

### The double-recording gotcha — the watch wins

If a user records on **both** a GPS watch (→ Strava directly, at best fidelity) and our
phone, they'd get two overlapping activities *and* our phone track is almost certainly
the **worse** one — a dedicated multi-band-GNSS watch (Garmin Fenix, Apple Watch Ultra,
COROS) generally beats a pocketed phone. Your hunch is right: **defer to the watch.**

- **Don't push ours to Strava** when a watch already does — kills the dupe, and theirs
  is higher quality anyway.
- **We can drop our native phone recording too** (battery win) — **but then we lose the
  track for B.** We **cannot** legally reuse the watch's Strava copy for our cross-user
  aggregate (that's the forbidden *pull*), so to still benefit we **ingest the watch's
  track through an allowed provider** — HealthKit / Health Connect / Garmin / COROS /
  Polar, whose terms permit cross-user display. That's exactly the A-input extensibility
  below, and it's *why* the watch case still routes through our pipeline.

The clean split:

- **Phone-only skater** → our native recorder (Record mode) → B **and** optional Strava push.
- **Watch skater** → record on the watch → watch pushes to Strava itself → we ingest
  that track for B via a connected watch provider (A-input), and **skip both** our phone
  recording and our Strava push.

v1 can be a **per-session "also upload to Strava?" toggle** (default off when we detect a
connected watch provider, on for phone-only) until auto-detect is solid.

## What we win (the actual product)

Because the track is **ours**, all the originally-blocked features become legal:

- **Lake heatmaps** aggregating recent skaters' chosen lines.
- **Pressure-ridge / obstacle intelligence** — crowd-sourced "where people actually
  crossed / which side was clear."
- **Path drawn on a public report** — no cross-user-display problem, because it's not
  Strava data.
- **Derived analytics / any future ML** — outside Strava's AI ban entirely.

All still gated by **our own** privacy design, which is the substantive work here:
minors are read-only (D41) and should likely be **excluded from aggregate layers**;
home-location privacy (reuse the `sortByHome` privacy-safe pattern); **de-identified,
k-anonymity-style thresholds** before a heatmap cell renders (don't expose a single
skater's line as "the crowd"); geotag/track sharing **opt-in** (D42 class).

## Legal checklist delta

- **L7** (Strava cross-user display / AI / branding): the push model **sidesteps** it —
  we display *our* data, not Strava's. Update L7 to reflect "resolved via native
  capture + push; no Strava data displayed cross-user."
- **New (proposed) L-item:** aggregate/heatmap privacy for **our** tracks — minors
  exclusion, k-anonymity threshold, home-location protection, opt-in sharing consent.
  This is now the binding constraint, not Strava.
- `activity:write` requires the OAuth consent screen to clearly state we upload on the
  user's behalf.

## Architecture: A → B → C, with B as the hub

Reframed as a **pipeline**, not a sequence of features. **B is the invariant core we
always own; A and C are pluggable provider sets on either side:**

```
  A · capture (inputs)         B · our track store (hub)          C · push (outputs)
  ────────────────────         ─────────────────────────         ──────────────────
  native recorder  ─┐          ┌ normalize → resolve-to-lake ┐    ┌ Strava (activity:write)
  Garmin           ─┤          │  (gpsActivities, D44)       │    │
  HealthKit / HC   ─┼────────► │  aggregate + heatmap        ├──► ┤ (future: Whoop, …)
  COROS · Polar    ─┘          │  privacy: minors-out,       │    │
                               │  k-anon, home-protect,      │    │
                               └  opt-in sharing             ┘    └
```

- **A — capture / inputs.** However a track gets *in*. The **native recorder** is the
  first and most important A-input (phone-only skaters, and the source we fully control).
  **Garmin / HealthKit / Health Connect / COROS / Polar** augment A later — each an
  incremental adapter into the same normalized shape (reusing the provider-agnostic
  ingest core already scoped in Phase 8). The watch-user case (above) enters here.
- **B — our track store + aggregate (the hub, always covered).** Normalize any input to
  `gpsActivities`, resolve to `waterBodyId` (D44), and — because this data is **ours,
  not Strava's** — build the heatmap / crowd intelligence / path-on-public-report, gated
  by **our** privacy model (minors excluded, k-anonymity thresholds, home-location
  protection, opt-in sharing). **This is where the app actually benefits, and it's
  provider-independent** — it works no matter which A-input or C-output is connected.
- **C — push / outputs.** However a track gets *out* to where the user keeps their
  fitness identity. **Strava (`activity:write`)** is the first and highest-value C-output
  (the adoption carrot). Others (Whoop, etc.) augment C later as adapters off the same
  normalized track.

**Build all three** so the pipeline is whole end-to-end; then A and C each grow by
adding provider adapters, while **B — our benefit — is covered from day one regardless.**

### Suggested build order (within "all three")

1. **B's spine + the native A-input** — recorder → normalized `gpsActivities` →
   resolve-to-lake → render your *own* path on your *own* report. No provider risk; the
   bulk of the effort (battery + background-mode hardening).
2. **C's first output — Strava push** — small once B produces a clean track; ship early
   as the adoption hook.
3. **B's aggregate layer** — heatmap + crowd intelligence behind the privacy model, once
   there's enough track volume to be meaningful.
4. **Augment A and C** — Garmin / HealthKit / COROS / Polar adapters (also the watch-user
   path for B); additional push targets as demand appears.

## Is Strava worth it now — verdict

- **Pull integration (read tracks from Strava): no.** Legally shackled to single-user
  display, AI-banned, adoption-hostile. Shelve indefinitely.
- **Push integration (write to Strava): yes — it's C's first output.** Cheap, clearly
  allowed, and the lever that makes skaters willing to record with us. But it's worthless
  without a recorder producing a clean track — so **B's spine + the native recorder is
  the real project; Strava push is a thin, high-leverage cap on top.**

The headline: **we don't need Strava's data at all — we need Strava's gravity.** Push
gives us the gravity; our own recorder gives us the data we're legally free to build on.

## Open questions

- **Q (dupe): resolved — watch wins.** When a watch is connected, skip our Strava push
  and our phone recording; ingest the watch track for B via an allowed provider. Open
  sub-Q: the *auto-detect* of "user has a watch" vs. the v1 per-session toggle default.
- **Q (fidelity/battery):** default fix cadence per mode is settled in principle
  (Balanced/20 m for hazards, High–BestForNav/~5 m for record); still needs on-ice
  device tuning + the auto-stop-on-stationary threshold (the Phase 9.5 GPX route-playback
  rig helps).
- **Q (privacy):** k-anonymity threshold + minors handling for aggregate layers — this
  is a **decision-grade** call (new D-number), not an implementation detail.
- **Q (FIT vs GPX):** GPX is trivial to emit; FIT is richer (laps, HR passthrough).
  Start GPX, revisit FIT if users want watch-parity metadata.
- **Q (iOS/Android parity):** background-location UX differs; confirm both against the
  Android-emulator-primary test target (foreground service) + a real iOS device.
