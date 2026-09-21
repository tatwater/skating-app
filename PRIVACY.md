# Privacy notice (interim — friends alpha)

**Last updated: 2026-09-20**

> **Status: interim.** This is a plain-language privacy notice for the small,
> friends-only alpha of this app. It is written to be honest and cover the alpha
> responsibly, but it is **not** a final, lawyer-reviewed policy — a full legal review
> is tracked as **Q10** in [`plans/02-open-questions.md`](./plans/02-open-questions.md)
> and will replace this before any broader launch. It is **not legal advice**.

This app helps ice skaters share peer reports about ice conditions. Because it's a
location-based app, it necessarily handles some location data. This notice explains what
we collect, why, who can see it, and your choices.

## Who this is
The app is operated by its founder. Questions or requests: **desk@teaganatwater.com**.

## Age requirement
You must be **at least 16 years old** to use the app. We collect your **date of birth**
at signup to enforce the 16+ minimum and to apply protections for under-18 users; it is
treated as **sensitive personal information** (used only for age/eligibility, and scrubbed
when you delete your account). Because all reports on the app are public and we don't
broadcast a minor's location, **users under 18 are read-only**: they can read reports and
plan, but **cannot post reports**, and their **profile is always private** (see "Who can see
your reports"). The app is not directed at children under 16.

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
  observations, optional thickness readings, optional weather snapshot, notes, and photos.
  **All reports are public** — they're shared with the community by design.
- **Photos** — we **strip embedded metadata (EXIF) on your device before upload**. The
  only metadata we may keep is the photo's **timestamp** and **GPS coordinate**, and
  **only if you opt in** to placing that photo on the map. If you don't, the coordinate
  is not retained.
- **Recorded skates (optional)** — the app can record your GPS track while you skate,
  using the phone's own location. Recording is something you start and stop; it never runs
  on its own. A recorded track is stored with your account, is used to work out which water
  body you skated and to prompt you to make a report, and is shown on your report and on the
  water body's page. If you publish a report from a track, that track can also appear —
  without your name — in a faded **community skate-paths layer** on that water body, so others
  can see where people have been going. A path is shown whole, including where you got on and
  off the ice, so if you skated from private property, don't publish that track, or turn the
  community layer off for your own tracks in Settings. Users under 18 are never included in it.
- **Device location while the map is open** — with your permission, the app reads the phone's
  location to frame the map, work out which water body you are on, and warn you near a
  reported hazard. To work out the water body it sends that position, rounded to roughly
  300 m, to our server; the lookup is not stored.
- **On-ice mode (optional)** — if you turn on on-ice mode during a skate, the app keeps
  reading your location in the background for that session only, so it can warn you as you
  approach a reported hazard with the phone in your pocket. Those location readings stay on
  the phone, are used only for the warning, and are not uploaded. The mode turns off when the
  session ends, and the phone's own location indicator shows while it is on.
- **Connected fitness accounts (optional)** — if you connect Strava, we can **push** a
  recorded skate to your Strava account on your behalf. We never read activities or data
  from Strava. You control the connection and can disconnect it, which deletes the token we
  hold. Other providers (Garmin, COROS, Polar, Apple Health, Google Health Connect) are not
  connected in the alpha.
- **Device & diagnostic data** — for crash, error, and performance monitoring (Sentry)
  we collect technical data like app version, device model, OS, and error details, plus
  timing information about how the app performs: how long screens and pages take to
  load, and how long the app's network requests take (to our backend, the weather and
  map services, and sign-in). Performance data is labeled by screen or route type
  (e.g. "lake detail"), and any web address in it has its query string removed before
  it leaves your device. We **do not** send your IP address, cookies, request bodies,
  or the contents of any form to Sentry, and before anything is sent we remove
  location fields (coordinates, your home location, and everything derived from it),
  your date of birth, bio, and connected-account credentials. Product analytics
  (PostHog) are not enabled in the alpha. If enabled later, this notice will be
  updated; **session replay will never record users under 18**, and where it is used
  it will mask inputs and location data.

## How we use it
- To show peer ice reports on a map and feed, filtered to your drive-time range.
- To let you share reports, comments, and hazards with the community.
- To turn a recorded skate into a prompt for a report, and to show where people have skated.
- To send you the notifications you choose (in-app, push, or a daily email digest) about the
  water bodies you follow; every email carries a one-click unsubscribe.
- To keep the app working (crash/error diagnostics) and safe (moderation of flagged
  content).

We do **not** sell your data, and we do **not** use it to train AI models. We do not
predict or assert ice safety — reports are peers' observations only.

## Who can see your reports
**Every report is public.** The app is a community reporting resource, not a private log or a
social network — there's no "friends," no "followers," and no private-report option. When you post
a report it goes on the shared map/feed that other skaters in range see, attributed to your name.
If you don't want to share an observation with the community, don't post it. A public report
reveals that you (by name) were at that location around that time — so post only what you're
comfortable sharing. (Adults 18+ can post; **under-18 users are read-only and cannot post**.)

Your **profile** is a separate privacy choice:
- **Public** — searchable by name; shows your name, photo, town/state, bio, report/comment counts,
  reputation, and your report history.
- **Private** — your name and photo only; not searchable, no public profile page.

Adults may choose either; **under-18 profiles are always private**. Note that even with a private
profile your individual reports are still public and show your name — a private profile means
*you're not a browsable, searchable person on the platform*, not that your reports are hidden.

## Sharing with third parties (processors)
We use these services to run the app; they process data on our behalf:
Convex (database & file storage), Clerk (authentication), Cloudflare (map tiles and the
satellite-imagery archive), OpenRouteService (drive-time and walking routes), Open-Meteo and
the US National Weather Service (weather), Sentry (crash/error), Resend (email notifications
and operator email), Expo and Apple/Google (app distribution & push), and — only if you
connect it — Strava. Data you push to a fitness provider is also governed by that
provider's own terms and privacy policy.

## Retention, deletion, and export
- You can **export your data** (a JSON bundle of your own content plus your uploaded
  photos) and **delete your account** at any time.
- When you ask to delete your account, your name, photo, bio, town, home location and email
  are **erased immediately** and your profile disappears from the app. Every bounty you posted
  — open ones included — is **removed** at the same time, since it is a standing request nobody
  is making any more. **Canceling does not bring any of that back.** Your sign-in stays usable
  for **30 days** so you can change your mind about the account itself; after that the deletion
  is final: your date of birth, connected-account tokens, notifications, favorites and
  unpublished recordings are erased and your login is removed.
- Your past reports, comments, hazard reports and published skate paths are **kept, detached
  from your identity**, so the community's historical ice record is preserved. They show as
  "Deleted skater". This is **pseudonymization, not full anonymization**: each of those
  contributions stays linked to a single anonymous placeholder for your former account rather
  than being scattered, so they can still be recognized as the work of one departed person, and
  a distinctive pattern of places and dates could in principle be recognizable to someone who
  already knew it was yours.
- The free text you wrote (report notes, thickness-reading notes, hazard descriptions, photo
  captions, comment bodies) is cleared **once it is 30 days past the skate it describes** (30
  days past posting, for comments). In practice that means older text comes off right away when
  you ask, text newer than that stays visible until it reaches 30 days, and whatever is left is
  cleared when the deletion is finalized — so free text can remain public for up to 30 days after
  your request. Published skate paths stay in the community layer only if you had left that on;
  the links back to you (your Strava activity id, provider photo links) are removed either way.

## Security
Provider secrets and access tokens are held **server-side** and are never shipped in the
app. We follow reasonable measures to protect data, but no system is perfectly secure.

## Changes
This interim notice will be replaced by a full policy before any broader launch. Material
changes will be communicated in-app.

## Contact
Questions, data export, or deletion requests: **desk@teaganatwater.com**.
