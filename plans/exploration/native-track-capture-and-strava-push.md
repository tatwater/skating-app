# Native Track Capture + Strava Push

*Scoping doc — 2026-07-24. Extends [`04-integrations.md`](./04-integrations.md) (esp.
"Cross-user map display — our stance") and [`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md)
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

### Battery — the honest section

Your nervousness is correct and worth designing around, not hand-waving. Continuous
high-accuracy GPS is the single biggest drain a phone app can cause — a realistic
budget is **~5–12%/hr** depending on device, screen state, and fix cadence. A long
lake day (3–4 hrs) is a real dent. Mitigations, roughly in ROI order:

- **This is the same GPS cost on-ice mode already pays** — we're not introducing a new
  battery class, we're *retaining* a stream we already sample. A user recording a skate
  is not *also* running on-ice alerting for free, but the ceiling is known, not new.
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

### The double-recording gotcha

If a user records on **both** their watch (→ Strava directly) and our app (→ Strava
push), they get **two overlapping activities**. This is the one real UX landmine.
Options:

- **Detect + defer:** if a Strava activity for the same time window already exists,
  skip our push (we still keep our own track). Requires a read + heuristic.
- **User choice:** an explicit "also upload to Strava?" per session, default off for
  users we know have a watch, on for phone-only.
- **Mark as ours:** name/description tags ("Recorded with <app>") so the user can tell
  them apart and delete the dupe.

Simplest v1: **per-session opt-in toggle**, default off, with a one-time explainer. Get
smarter later.

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

## Recommended scope & phasing

Split cleanly; each stage ships value alone.

- **Stage A — native recorder + own-map path (no Strava at all).**
  The recorder, the sqlite-backed session buffer, track post-processing in `core`,
  attach-to-report, and rendering *your own* recorded path on *your own* report. No
  Strava dependency, no partner risk, no branding work. **This is the foundation and
  the bulk of the effort (mostly battery + background-mode hardening).**

- **Stage B — the aggregate layer.**
  Heatmap + crowd intelligence off our own tracks, behind the privacy model above
  (minors exclusion, k-anonymity, opt-in). Independent of Strava.

- **Stage C — Strava push.**
  OAuth `activity:write`, GPX/FIT encode, upload+poll, dedup toggle, branding. Small
  and self-contained *once Stage A produces a clean track*. This is the **adoption
  carrot** — sequence it early enough to help onboarding, but it depends on A.

**MVP cut if we want signal fast:** Stage A recorder + Stage C push, *skip B initially*.
That ships the "record with us, it lands in your Strava" hook (adoption) and the
report-path feature, and defers the heavier aggregate/privacy work until there's enough
track volume for a heatmap to mean anything anyway.

## Is Strava worth it now — verdict

- **Pull integration (read tracks from Strava): no.** Legally shackled to single-user
  display, AI-banned, adoption-hostile. Shelve indefinitely.
- **Push integration (write to Strava): yes, but as Stage C, not first.** It's cheap,
  clearly allowed, and it's the lever that makes skaters willing to record with us. But
  it's worthless without a recorder producing a clean track — so **the recorder (Stage
  A) is the real project; Strava push is a thin, high-leverage cap on top.**

The headline: **we don't need Strava's data at all — we need Strava's gravity.** Push
gives us the gravity; our own recorder gives us the data we're legally free to build on.

## Open questions

- **Q (dupe):** best default for the double-recording case — detect-and-defer vs.
  per-session opt-in? (Lean: opt-in v1.)
- **Q (battery):** acceptable default fix cadence + the auto-stop-on-stationary
  heuristic threshold — needs on-ice device testing (the GPX route-playback rig from
  Phase 9.5 helps).
- **Q (privacy):** k-anonymity threshold + minors handling for aggregate layers — this
  is a **decision-grade** call (new D-number), not an implementation detail.
- **Q (FIT vs GPX):** GPX is trivial to emit; FIT is richer (laps, HR passthrough).
  Start GPX, revisit FIT if users want watch-parity metadata.
- **Q (iOS/Android parity):** background-location UX differs; confirm both against the
  Android-emulator-primary test target (foreground service) + a real iOS device.
