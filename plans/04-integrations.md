# Integrations

## GPS activity providers — all six v1-scoped, shipped fast-follow (D24)

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

### ⚠ Terms / compliance watch-outs
- **2024 API Agreement tightened rules**:
  - Restrictions on **displaying one user's Strava data to other users** (3rd
    parties) — this is the **biggest risk to our core mechanic** (D24): showing a
    Strava-sourced GPS *path* on the shared public map is exactly cross-user
    display. See "Cross-user map display" below.
  - Restrictions on using Strava data with **AI/LLMs** — directly conflicts with
    "auto-summarize Strava text/photos via AI" (see Q9). Verify before building.
- **"Powered by Strava"** branding is **required** wherever Strava data appears.
- Cannot use Strava data to **train models**; cannot build competing
  segment/leaderboard products; storage/retention constraints.
- **Action:** read the current Strava API Agreement + brand guidelines before
  implementing media ingestion or any AI over Strava-sourced content.

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

### Cross-user map display — our stance (D24/D35)
We *want* to show a skater's trusted GPS path on the shared map. Plan:
1. **If Strava's terms allow it**, display the Strava-sourced path (with "Powered
   by Strava" attribution).
2. **If not**, we do **not** show the Strava path to others — instead we source the
   same path from a provider whose terms permit display (Garmin/COROS/Polar or the
   on-device HealthKit/Health Connect track) and nudge users to connect that too.
3. **Native reports never require a GPS path at all** (D24 data model) — so a
   missing/blocked path never stops someone posting a report. We are never blocked
   from shipping; at worst the map shows fewer trusted paths.

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

## Weather (context, not prediction)

- Provider: **Open-Meteo** — forecast + **historical archive**, free, no API key.
- Use: annotate aging reports with what the weather has *done since the skate time*
  to support the skater's own judgment. **Never** used to assert ice safety.

### "Weather since report" spec (derived summary)
Computed over the window **[skate time → now]** from Open-Meteo **hourly** data,
for the water body's coordinates:

| We show | Derived from Open-Meteo hourly vars |
|---|---|
| **Peak temperature** | max(`temperature_2m`) |
| **Hours at/near freezing** | count of hours where `temperature_2m` in a band (e.g. -2°C … +2°C) |
| **Hours above freezing** | count of hours where `temperature_2m` > 0°C |
| **Hours of sun** | sum(`sunshine_duration`) or low-`cloud_cover` hours |
| **Total precipitation** | sum(`precipitation`) (+ split rain vs snow) |
| **Wind** | max / avg `wind_speed_10m` (+ gusts) |

- Present as a compact factual strip (e.g. "since this report: peak 41°F · 18h
  above freezing · 6h sun · 0.3in rain"). No verdict, no color-coded "safe/unsafe".
- Cache the fetch per (water body, window) to avoid refetching on every view;
  windows only extend, so results are append-friendly.

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
