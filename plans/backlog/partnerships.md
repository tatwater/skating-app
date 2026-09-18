# Next-gen — GPS-provider partner applications: the longest pole nobody has confirmed is in

> **Jotted 2026-09-16 at the founder's ask, as a reminder rather than a scope.** The roadmap has said
> *"apply for Garmin / COROS / Polar partner programs now"* since Phase 00, and `05-accounts-and-
> credentials.md` still records the answer as **❔ unknown whether applied**. Approval takes weeks;
> everything downstream (watch capture adapters, the watch-wins ingest path) is gated on it. This is
> a backlog note that will most likely become a `B`-era phase; until then it exists so the
> reminder outlives the roadmap rewrite that removes the "Start now" block it used to live in.

## The reminder

**Start the applications.** Each is a form and a wait, not engineering:

| Provider | Program | Gate | Notes |
| --- | --- | --- | --- |
| Garmin | Garmin Connect Developer Program (Health / Activity API) | partner review, weeks | the one skaters ask for first |
| COROS | COROS Open API developer / partner application | partner review | |
| Polar | AccessLink API — <https://admin.polaraccesslink.com> | registration, lighter than Garmin | webhooks |
| Google Health Connect | Android permissions + Play **health-data access review** | needs a **Play account** ($25) first | the review is the slow part |
| Apple HealthKit | HealthKit entitlement + dev build | **no partner approval** | unblocked today; shares the iOS device-verification dependency |
| Whoop | its own API access | — | an additional *push* target, not capture |

## What it unblocks, and where that's written

- **Phase 08's deferred list** — third-party capture adapters (Garmin / HealthKit / Health Connect /
  COROS / Polar) and the **watch-wins ingest path**, each integrated individually. The A-input side of
  the A→B→C pipeline; the native recorder is A-input #1 and these are #2 onward. See
  [`phases/08-native-capture.md`](../phases/08-native-capture.md).
- **L8** in [`08-legal-feasibility-checklist.md`](../08-legal-feasibility-checklist.md) — per-provider
  ToS / brand / health-data review at integration time (D24).
- **`05-accounts-and-credentials.md`** — the account table, ordered by lead time; update the ❔ once
  the applications are in.

## When it becomes a phase

Once at least one approval lands, this is a `B`-era phase: the shared adapter shape (normalize any
track → `gpsActivities`, resolve to water body, link to report — the B spine Phase 08 already built), one
provider at a time, HealthKit first because it needs no approval. Not before — building adapters
against APIs we can't call is the speculative work the register exists to hold back.

## Per-provider setup notes

> Moved here verbatim from `04-integrations.md` on 2026-09-17, when that doc became the data-source
> register. These are the pre-build notes for each adapter — written before Phase 08, so every
> "verify" is still a verify. All six normalize to the canonical "ice skate" concept + `gpsActivities`
> (D24), and each activity's path is resolved to the water body it was on (D44).

**Canonical activity-type mapping** (verify each against current provider docs):

| Provider | Ice-skate type | Detection | Media |
|---|---|---|---|
| Strava | `IceSkate` (sport_type) | webhook push subscription | photo URLs (ToS-limited; single-user only, L7) |
| Garmin | `ICE_SKATING` (activityType) | Ping/Push notifications | generally none |
| COROS | skating activity type (verify) | webhook | none |
| Polar | ice-skating sport (verify) | AccessLink webhook | none |
| Apple HealthKit | `HKWorkoutActivityType.skatingSports` | on-device background delivery | none |
| Google Health Connect | `EXERCISE_TYPE_ICE_SKATING` | on-device change reads | none |

Two ingestion patterns:

- **Server-webhook providers** (Strava, Garmin, COROS, Polar): the provider **pushes** an activity
  event to a Convex HTTP endpoint → we fetch the activity → prompt a report → ingest the trusted GPS
  path (+ media where ToS allows).
- **On-device providers** (Apple HealthKit, Google Health Connect): **no server API** — the mobile app
  observes new workouts locally (background delivery) and uploads the trusted path to Convex → prompt.

### Strava — the single-user ingest slice (L7)
The pull model is dead for cross-user display, but showing a skater *their own* Strava activity is
still allowed, and this is how it would work:
- OAuth 2.0 (Expo AuthSession on mobile; standard OAuth on web) — the app already holds a Strava
  OAuth flow for push (`convex/http.ts`, `oauthStates`). **Scopes:** `activity:read` (public) or
  `activity:read_all`; request the minimum.
- **Webhook / Push Subscription API**: subscribe once; Strava POSTs on create/update; fetch and check
  the sport type (`IceSkate`). Rate limits are tight — ~100 requests / 15 min, ~1,000 / day — so never
  poll.
- Activity detail includes description and **photo URLs**; a report draft could be pre-filled from
  them, for the *author only*.

### Garmin (Connect Developer Program — server webhook)
- **Apply to the Garmin Connect Developer Program** for **Health API + Activity
  API** access. **Partner approval required — allow weeks of lead time.**
- **Auth:** OAuth (PKCE). **Detection:** Garmin's **Ping/Push notification** service
  POSTs to your webhook when a new activity is available → fetch activity + FIT/GPS.
- **Activity type:** `ICE_SKATING` (verify). **Media:** not generally exposed.

### COROS (Open API — server webhook)
- **Apply to the COROS developer/partner program** (approval required).
- **Auth:** OAuth2. **Detection:** webhook on new activity → fetch activity + GPS.
- Verify the exact skating activity type in COROS's activity enum. **Media:** none.

### Polar (AccessLink API — server webhook)
- Register at **Polar admin** (<https://admin.polaraccesslink.com>); AccessLink is
  lighter-weight than Garmin's program.
- **Auth:** OAuth2. **Detection:** **webhooks** for new exercises → fetch GPX/TCX.
- Verify the ice-skating sport type in Polar's sport list. **Media:** none.

### Apple HealthKit (on-device, iOS)
- Enable the **HealthKit entitlement** + `NSHealthShareUsageDescription`.
- Read workouts of type **`HKWorkoutActivityType.skatingSports`** and the associated
  **`HKWorkoutRoute`** (GPS). Use **`HKObserverQuery` + background delivery** to be
  notified of new workouts even when backgrounded → upload path → prompt.
- iOS-only; **no partner approval**; **no media**.

### Google Health Connect (on-device, Android)
- Use **Health Connect** (the Google Fit APIs are deprecated). Request permissions
  for **`ExerciseSessionRecord`** (type **`EXERCISE_TYPE_ICE_SKATING`**) +
  **`ExerciseRoute`**.
- **Detection:** read on device (changes API / periodic background read) → upload path.
- Requires Google Play **health-data access review** for sensitive permissions.
- Android-only; **no media**.

**Fitbit is not a v1 provider:** Health Connect doesn't reliably expose Fitbit GPS routes, and many
Fitbit users already sync to Strava. Logged as a possible future provider.
