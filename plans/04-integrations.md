# Integrations

> **⚠️ Strategic update (2026-07-24) — read [`research/native-track-capture-and-strava-push.md`](./research/native-track-capture-and-strava-push.md) (and L7 in the legal checklist).**
> The current Strava API Agreement was read: Strava **forbids** displaying one athlete's data to any
> other user (even public data) and **bans AI/ML** use. So the *pull* model below **cannot** feed our
> cross-user map/heatmap/report-path, and the old "Garmin is our fallback for Strava-path display"
> stance is retired. The pivot: a **native in-app recorder** produces tracks *we own* (not Strava
> Data) → legal to aggregate/heatmap/draw-on-reports; and we **push** those tracks *to* Strava
> (`activity:write`) as the adoption lever. Reframed as an **A → B → C pipeline**: A = capture inputs
> (native recorder first; the six providers below augment it), **B = our own track store +
> aggregate/privacy, the always-covered hub**, C = push outputs (Strava first). The provider notes
> below still hold **for the ingest side (A)**, but cross-user *display* now comes from **B (our
> tracks), never from a provider's data.**

## GPS activity providers — all six v1-scoped, shipped fast-follow (D24)

> **⚠️ Superseded for Phase 8 (2026-07-24) — read [`phase-8-native-capture.md`](./phase-8-native-capture.md).**
> The Strava *pull/ingest* model described below is **dead** (L7: Strava forbids cross-user display of its
> data + bans AI/ML). Phase 8 inverted to **native capture + Strava push**: we **record the track
> ourselves** (first-party data we own → legal to aggregate/draw on reports) and **push** it to Strava
> (`activity:write`). The **native recorder** is now A-input #1; the other five providers
> (Garmin/HealthKit/HC/COROS/Polar) are **deferred**, each integrated individually later. Only the **free
> Strava app** is needed now, and only for push. The per-provider setup notes below stay as reference for
> those later adapters; the *cross-user display* stance further down is replaced by **D58**.

All six providers are v1-scoped and the architecture is **provider-agnostic**, so
any skater's device can contribute a **trusted** GPS path. **Apply for every
approval in Phase 0** (Garmin/COROS/Polar reviews take weeks). They then **ship in
a fast-follow order**, not simultaneously:

1. **Strava + Apple HealthKit** — first. Covers most of the US alpha; Strava also
   carries the write-ups + photos, HealthKit covers Apple Watch.
2. **Garmin** — next. Adds Garmin-watch GPS, and is our **fallback for map
   display** if Strava's terms forbid showing a Strava path to other users (below).
3. **COROS · Polar · Google Health Connect** — fast-follow.

**Fitbit is not a v1 provider:** Health Connect doesn't reliably expose Fitbit GPS
routes, and many Fitbit users already sync to Strava (so we capture them there).
Logged as a possible future provider.

Two ingestion patterns:

- **Server-webhook providers** (Strava, Garmin, COROS, Polar): the provider **pushes**
  an activity event to a Convex HTTP endpoint → we fetch the activity → prompt a
  report → ingest the trusted GPS path (+ media where ToS allows).
- **On-device providers** (Apple HealthKit, Google Health Connect): **no server API** —
  the mobile app observes new workouts locally (background delivery) and uploads the
  trusted path to Convex → prompt.

All normalize to our canonical "ice skate" concept + `gpsActivities` (D24). At ingest,
each activity's trusted path is **spatially resolved to the water body it was on** and
that `waterBodyId` is stored (D44) — so a skate is findable by **lake name/ID**, not by
geospatial area ("5 miles on Lake Morey", not "5 miles somewhere near here").

**Canonical activity-type mapping** (verify each against current provider docs):

| Provider | Ice-skate type | Detection | Media |
|---|---|---|---|
| Strava | `IceSkate` (sport_type) | webhook push subscription | photo URLs (ToS-limited) |
| Garmin | `ICE_SKATING` (activityType) | Ping/Push notifications | generally none |
| COROS | skating activity type (verify) | webhook | none |
| Polar | ice-skating sport (verify) | AccessLink webhook | none |
| Apple HealthKit | `HKWorkoutActivityType.skatingSports` | on-device background delivery | none |
| Google Health Connect | `EXERCISE_TYPE_ICE_SKATING` | on-device change reads | none |

Detailed per-provider setup follows (Strava first, as the cold-start priority).

## Strava (priority provider — key to cold-start & fresh data)

Goal: when a user records an **ice-skate** activity on Strava, our app detects it
and prompts them to create a report — optionally pre-filling media/text/time.

### Setup
- Register a Strava API application → obtain **client ID / client secret**.
- Implement **OAuth 2.0** (Expo AuthSession on mobile; standard OAuth on web).
- **Scopes:** `activity:read` (public) or `activity:read_all` (incl. private
  activities). Request the minimum needed.

### Detecting ice skates without polling
- Use the **Strava Webhook / Push Subscription API**: subscribe once; Strava POSTs
  an event when a user creates/updates an activity. On event, fetch the activity
  and check the sport type.
- Strava sport type for ice skating is **`IceSkate`** (verify current enum).
- **Why webhooks, not polling:** rate limits are tight — ~**100 requests / 15 min**
  and **~1000 / day** by default. Polling all users would blow the budget.

### Pulling media / text
- Activity detail includes description and **photo URLs** (`photos` field). We can
  pre-fill a report draft from these.

### ⚠ Terms / compliance watch-outs — Agreement read 2026-07-24 (L7)
- **Nov-2024 API Agreement (confirmed by the read):**
  - **Displaying one user's Strava data to other users is forbidden** — even public
    data ("*may not be displayed or disclosed*"). This **rules out** a Strava-sourced
    path on the shared public map / heatmap / report. **Resolved by the pivot:**
    cross-user display comes from **our own recorded tracks**, not Strava — see
    "Cross-user map display" below and `research/native-track-capture-and-strava-push.md`.
  - **AI/LLM use of Strava data is banned** — kills "auto-summarize Strava text/photos
    via AI" (Q9) over Strava-sourced content.
- **"Powered by Strava"** branding required wherever Strava data appears (and honor the
  "Connect with Strava" button asset on the connect/push surfaces).
- Cannot use Strava data to **train models**; cannot build competing
  segment/leaderboard products; storage/retention constraints; access is a revocable
  privilege with mandatory deletion on termination.
- **Still allowed (and now our plan):** **pushing** a user's *own* activity to their
  *own* Strava via `activity:write` (the Garmin model) — the adoption lever. The
  *ingest/pull* slice remains legal only **single-user** (show a user their own data).

### "Powered by Strava" attribution — UI checklist
Strava's brand guidelines are mandatory wherever Strava data appears. Treat these as
build-time acceptance criteria (verify against current guidelines before launch):
- [ ] **"Powered by Strava"** logo/text shown on any view rendering Strava-sourced data
      (a report/activity ingested from Strava, a Strava path on the map).
- [ ] **"Connect with Strava"** button uses Strava's official connect button asset
      (don't hand-roll it).
- [ ] Strava marks used in **approved colors/clear-space**; no altering or implying
      Strava endorsement.
- [ ] Activity/segment data displayed per the Agreement (no building competing
      segment/leaderboard features; respect storage/retention limits).
- [ ] Attribution persists in **exports** and any shared/deep-linked views.
- [ ] Other providers' attribution requirements checked the same way when their
      integrations land (Garmin/COROS/Polar/Apple/Google each have brand terms).

### Cross-user map display — our stance (D24/D35) — updated 2026-07-24
We *want* to show a skater's trusted GPS path on the shared map. The 2026-07-24 Strava
read (L7) settled how:
1. **Strava is out as a display source** — its terms forbid showing one user's data to
   any other user, even public data. We do **not** display Strava-sourced paths cross-user.
2. **Display comes from tracks we own (B).** The **native recorder** produces first-party
   tracks (not Strava Data) that we're free to aggregate, heatmap, and draw on public
   reports — gated by *our* privacy model (**D58**: publish-is-consent, minors-out,
   put-in-gated endpoint clipping, opt-out — *not* k-anonymity; L14). A **watch skater**
   feeds B by connecting a provider whose terms *permit*
   cross-user display (Garmin/COROS/Polar or on-device HealthKit/Health Connect) — never
   via Strava's copy (that's the forbidden pull).
3. **Native reports never require a GPS path at all** (D24 data model) — so a
   missing/blocked path never stops someone posting a report. We are never blocked
   from shipping; at worst the map shows fewer trusted paths.

Full reasoning + the A→B→C pipeline and Strava **push** (`activity:write`) adoption lever:
[`research/native-track-capture-and-strava-push.md`](./research/native-track-capture-and-strava-push.md).

---

## Garmin (Connect Developer Program — server webhook)
- **Apply to the Garmin Connect Developer Program** for **Health API + Activity
  API** access. **Partner approval required — allow weeks of lead time.**
- **Auth:** OAuth (PKCE). **Detection:** Garmin's **Ping/Push notification** service
  POSTs to your webhook when a new activity is available → fetch activity + FIT/GPS.
- **Activity type:** `ICE_SKATING` (verify). **Media:** not generally exposed.

## COROS (Open API — server webhook)
- **Apply to the COROS developer/partner program** (approval required).
- **Auth:** OAuth2. **Detection:** webhook on new activity → fetch activity + GPS.
- Verify the exact skating activity type in COROS's activity enum. **Media:** none.

## Polar (AccessLink API — server webhook)
- Register at **Polar admin** (<https://admin.polaraccesslink.com>); AccessLink is
  lighter-weight than Garmin's program.
- **Auth:** OAuth2. **Detection:** **webhooks** for new exercises → fetch GPX/TCX.
- Verify the ice-skating sport type in Polar's sport list. **Media:** none.

## Apple HealthKit (on-device, iOS)
- Enable the **HealthKit entitlement** + `NSHealthShareUsageDescription`.
- Read workouts of type **`HKWorkoutActivityType.skatingSports`** and the associated
  **`HKWorkoutRoute`** (GPS). Use **`HKObserverQuery` + background delivery** to be
  notified of new workouts even when backgrounded → upload path → prompt.
- iOS-only; **no partner approval**; **no media**.

## Google Health Connect (on-device, Android)
- Use **Health Connect** (the Google Fit APIs are deprecated). Request permissions
  for **`ExerciseSessionRecord`** (type **`EXERCISE_TYPE_ICE_SKATING`**) +
  **`ExerciseRoute`**.
- **Detection:** read on device (changes API / periodic background read) → upload path.
- Requires Google Play **health-data access review** for sensitive permissions.
- Android-only; **no media**.

---

## Forum / Facebook ingestion (aspirational — see Q8)

Auto-ingesting Google Group + regional Facebook group posts into summarized
in-app reports would dramatically reduce cold-start.

**Blockers to research:**
- Google Groups: no clean API; scraping/ToS + auth (many groups are members-only).
- Facebook: Graph API access to groups is heavily restricted; scraping violates ToS.
- Consent: turning someone's forum post into an in-app report raises attribution
  and consent questions.
- AI summarization of ingested content may collide with source ToS.

**Reply classification (the messy part):** email threads mix *comments* (replies to
a post) and *new reports* (someone answering with their own ice report). Proposed
pipeline: an **AI classifier** reads each threaded message and routes it to either
a `comment` on the original report or a new `report`. This AI operates on
**forum/email content** (not Strava data), so it's **outside Strava's AI terms** —
but the ingestion + AI use must still clear the source's own ToS + consent (Q8).

**Status:** desired; not committed. Requires a feasibility + legal pass.

---

## OpenStreetMap data (ODbL) — attribution + compliance

Water-body polygons (Phase 1 ETL, D5/D14) and the Protomaps basemap (D6) both derive from
**OpenStreetMap**, licensed under the **Open Database License (ODbL)**. Treat attribution as
a **build-time acceptance criterion**, the same class of obligation as "Powered by Strava":

- [ ] **"© OpenStreetMap contributors"** shown wherever OSM-derived data or the basemap is
      displayed (the map view, at minimum) — visible, not buried.
- [ ] The credit links to <https://www.openstreetmap.org/copyright> where practical.
- [ ] Persist attribution in any exported/shared/deep-linked map view.
- [ ] **Share-Alike awareness:** ODbL is share-alike on the *database*. Our derived
      `waterBodies` extract is an OSM-derived database; if we ever *publish* that extract we
      do so under ODbL. (Displaying it in-app is a "Produced Work" — attribution suffices;
      the share-alike bite is on redistributing the data itself.) Full wording is
      legal-gated with the rest of Q10.

## Weather (context, not prediction)

- Provider: **Open-Meteo** — the **forecast API with `past_days`** (up to 92 days back), free, no API key.
  **Not the historical archive** (ERA5-backed, ~5-day lag) — our windows are all recent, and `past_days`
  covers both the strip and the longest decay window (≤45 days); see `phase-10-weather.md` §2.
- Use: annotate aging **reports** (window = since the skate time) **and hazards** (window = a rolling
  recent ~5–7 days, since "first reported" is meaningless for a season-long ridge) with what the weather
  has *done*, to support the skater's own judgment. **Never** used to assert ice safety.
- **Attribution:** show a small "Weather: Open-Meteo" credit wherever the strip appears (legal checklist
  **L13** — same class as "Powered by Strava" / "© OpenStreetMap contributors").

### "Weather since report" spec (derived summary)
Computed over the window **[skate time → now]** from Open-Meteo **hourly** data,
for the water body's coordinates:

| We show / compute | Derived from Open-Meteo hourly vars |
|---|---|
| **Peak temperature** | max(`temperature_2m`) |
| **Overnight low** *(added — "did it freeze last night")* | min(`temperature_2m`) / per-night min |
| **Hours at/near freezing** | count of hours where `temperature_2m` in a band (e.g. -2°C … +2°C) |
| **Hours above freezing** | count of hours where `temperature_2m` > 0°C |
| **Hours of sun** | sum(`sunshine_duration`) or low-`cloud_cover` hours |
| **Rain vs snow** *(split — opposite decay signs)* | sum(`rain`) and sum(`snowfall`)/`snow_depth` separately, **never lumped** |
| **Wind** | max/avg `wind_speed_10m` + `wind_gusts_10m` (+ wind-run) |
| **Insolation** *(added — season/solar term)* | sum(`shortwave_radiation`) — bakes in seasonal intensity |
| **Freezing-/thaw-degree-hours** *(model-internal)* | Σ(0−`temperature_2m`) over freezing h · Σ(`temperature_2m`−0) over thaw h |
| **Sustained-freeze run / freeze-thaw cycles** *(model-internal)* | longest consecutive freezing run · count of 0°C crossings |

- **Fetch vars (hourly):** `temperature_2m, precipitation, rain, snowfall, snow_depth,
  wind_speed_10m, wind_gusts_10m, cloud_cover, sunshine_duration, shortwave_radiation`.
- **Two consumers, one fetch (Phase 10):** the **descriptive strip** (D19) reads the human
  subset; the **hazard decay model** (D52/D56) reads the degree-hour integrals + freeze-run
  counts. See `phase-10-weather.md` for the full variable rationale.
- Present the strip as a compact **plain-text, verdict-free** factual line (e.g. "since this
  report: peak 41°F · low 22°F · 3 nights below freezing · 6h strong sun · ½″ rain"). No
  verdict, no color-coded "safe/unsafe"; degree-hour integrals stay model-internal.
- Cache the fetch per **(sample point, window)** to avoid refetching on every view; windows
  only extend, so results are append-friendly. **Sampling:** body **centroid by default**
  (a body is usually smaller than one Open-Meteo grid cell — *not* town/county), with an
  optional `weatherSamplePoints[]` for the few multi-cell giants (Champlain/Winnipesaukee).

## Transactional email — Resend + React Email (D38)

- Provider: **Resend**; templates authored with **React Email**
  (`@react-email/components`), sharing the design-token package (D7).
- **Send path:** a **Convex action** (Node runtime) calls the Resend SDK; API key in
  Convex env vars, never client-side. A ticket/flag mutation schedules the action.
- **v1 use — operator alerts (D37):** on new `supportTickets`, and on safety-priority
  items (`unsafe_false_report` flags, `category: safety` tickets). Each email
  deep-links into the `/admin` queue.
- **Setup gate:** verify a sending domain (DNS) so alerts don't land in spam
  (see `05-accounts-and-credentials.md` #13).
- **Boundaries:** Clerk owns auth emails (D26) — no duplication. User-facing product
  email (digests) stays deferred; in-app `notifications` (D16) remain the user channel.
