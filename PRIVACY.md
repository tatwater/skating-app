# Privacy notice (interim — friends alpha)

**Last updated: 2026-07-15**

> **Status: interim.** This is a plain-language privacy notice for the small,
> friends-only alpha of this app. It is written to be honest and cover the alpha
> responsibly, but it is **not** a final, lawyer-reviewed policy — a full legal review
> is tracked as **Q10** in [`plans/02-open-questions.md`](./plans/02-open-questions.md)
> and will replace this before any broader launch. It is **not legal advice**.

This app helps ice skaters share peer reports about ice conditions. Because it's a
location-based app, it necessarily handles some location data. This notice explains what
we collect, why, who can see it, and your choices.

## Who this is
The app is operated by its founder. Questions or requests: **teagan@newmoneycompany.com**.

## Age requirement
You must be **at least 16 years old** to use the app. We collect your **date of birth**
at signup to enforce the 16+ minimum and to apply protections for under-18 users; it is
treated as **sensitive personal information** (used only for age/eligibility, and scrubbed
when you delete your account). Users under 18 get a **private-by-default**
posture: their reports default to **"Just me" and can never be made public**, and their
**profile is always private** (see "Who can see your reports"). The app is not directed at
children under 16.

## What we collect

- **Account info** — handled by our auth provider (Clerk): your email and any social
  login you choose, display name, and username.
- **Date of birth** — collected at signup to verify you meet the 16+ minimum and to apply
  under-18 protections. Treated as sensitive data: used only for age/eligibility and removed
  when you delete your account. We do not display it or share it.
- **Your home location** — a single coordinate you set, used **only** to compute your
  drive-time filter. It is **private**: it is never shown to other users and is not part
  of any report. You may optionally show a **town label** (not an address) on your
  profile.
- **Reports you create** — the water body, the time you skated, ice/surface
  observations, optional thickness readings, optional weather snapshot, notes, photos,
  and the visibility level you choose.
- **Photos** — we **strip embedded metadata (EXIF) on your device before upload**. The
  only metadata we may keep is the photo's **timestamp** and **GPS coordinate**, and
  **only if you opt in** to placing that photo on the map. If you don't, the coordinate
  is not retained.
- **Connected fitness/GPS accounts (optional)** — if you connect a provider (e.g.
  Strava, Garmin, COROS, Polar, Apple Health, Google Health Connect), we receive
  detected ice-skate activities and their GPS track so we can prompt you to make a
  report and show your route. You control these connections and can disconnect them.
- **Device & diagnostic data** — for crash and error reporting (Sentry) we collect
  technical data like app version, device model, OS, and error details. Product
  analytics (PostHog) are not enabled in the alpha. If enabled later, this notice will
  be updated; **session replay will never record users under 18**, and where it is used
  it will mask inputs and location data.

## How we use it
- To show peer ice reports on a map and feed, filtered to your drive-time range.
- To let you share reports, comments, and hazards with the community.
- To detect ice-skate activities from connected providers and prompt reports.
- To keep the app working (crash/error diagnostics) and safe (moderation of flagged
  content).

We do **not** sell your data, and we do **not** use it to train AI models. We do not
predict or assert ice safety — reports are peers' observations only.

## Who can see your reports
You set a visibility level on each report. There are **two** levels — the app has **no
follow or friend feature**, so a report is either private to you or public to the community:
- **Just me** — only you (a private log).
- **Public** — contributes to the shared map/feed that nearby users in range see.

Defaults: **adults' reports default to public**; **under-18 users' reports default to "Just
me" and cannot be made public**. You can change the visibility of any individual report
(within those limits). A public report reveals that you (by name) were at that location
around that time — choose the level you're comfortable with.

Separately, your **profile** is either **public** (searchable by name, showing your public
reports) or **private** (not searchable, no public profile page). Adults may choose; **under-18
profiles are always private**. Profile privacy is independent of individual report visibility.

## Sharing with third parties (processors)
We use these services to run the app; they process data on our behalf:
Convex (database & file storage), Clerk (authentication), your connected GPS provider(s),
map/geocoding providers (MapLibre/Protomaps, geocoding, OpenRouteService), Open-Meteo
(weather), Sentry (crash/error), Resend (operator email), and Apple/Google (app
distribution & push). Data shared with a fitness provider is also governed by that
provider's own terms and privacy policy.

## Retention, deletion, and export
- You can **export your data** (a JSON bundle of your own content plus your uploaded
  photos) and **delete your account** at any time.
- On deletion, we **scrub your personal information** (name, home location, town, date of
  birth) and
  **anonymize** your past **public** reports and comments (attributed to a "deleted user")
  so the community's historical ice record is preserved. Reports set to **"just me" are
  removed**. Connected-provider tokens are deleted.

## Security
Provider secrets and access tokens are held **server-side** and are never shipped in the
app. We follow reasonable measures to protect data, but no system is perfectly secure.

## Changes
This interim notice will be replaced by a full policy before any broader launch. Material
changes will be communicated in-app.

## Contact
Questions, data export, or deletion requests: **teagan@newmoneycompany.com**.
