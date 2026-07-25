# Vision

## The problem

Nordic (wild) ice skating is a niche but passionate sport, concentrated in the
northern US (New England, New York, Alaska). Ice conditions are extremely
time- and place-sensitive: ice that is perfect today can be ruined tomorrow by
sun, snow, rain, or temperature swings — and ice that was too thin two days ago
can be great today.

The community currently coordinates almost entirely over **Google Group email
forums** (plus some per-state Facebook groups). Email is a poor fit for this:

- Time-sensitive, location-specific info is buried in and around unrelated email.
- Easy to miss; hard to search.
- Overwhelming — threads about far-away lakes flood inboxes with irrelevant info.
- No structure: no map, no filtering by distance, no freshness signal.

## The product

A **map-first** app for sharing peer ice reports, built as:

- **Mobile app (primary)** — iOS + Android via React Native / Expo. Optimized
  for live/just-finished reporting from the field.
- **Web app (secondary)** — TanStack Start, for people who prefer a keyboard/big
  screen for planning and longer reports.

The primary view is a **map centered on the user's home**, themed wintery/icy,
with bodies of water as the focus (roads shown only for reference/scale). Tap any
water body to see its name, surface area, and a feed of past reports (sorted by
**skate time, not report time**).

## Product principles

1. **Safety-first, never authoritative.** The app helps skaters make *their own*
   smart decisions. It never tells anyone ice is "safe" or "good to go." Every
   report is a **named peer's observation at a specific time and place**. The
   decision to step on ice is always the individual's.
   - We *contextualize* aging reports (e.g. "3 days of sun + rain since this
     report") to help judgment — without predicting or promising anything.
   - A report that says **"don't do it"** is as valuable as a positive one.
   - Because a dangerously false "the ice is great!" report is a *safety* risk, not
     just spam, users can **flag/report** content and **block** users, with a
     moderator takedown path (D32).
2. **Fast and low-friction in the cold.** Reporting and confirming hazards must
   be near-instant. Cold + wind drains phone batteries fast; minimize taps,
   minimize battery use, support offline capture with later sync.
3. **Respect the existing community & its safety culture.** Don't lecture experts.
   Reference guides live elsewhere — e.g. the **Nordic Skater** sites
   (<https://nordicskaters.squarespace.com/> and <http://lakeice.squarespace.com/>),
   whose terminology this app adopts
   (see `06-data-model.md` vocabulary) — so we link out and let people jump straight
   to reading/submitting reports. Recruit and bridge, don't replace-by-force.
4. **Privacy by default where it matters.** Home address is private to the user
   (a filter input only). **Reports are always public** (D13) — the app is a community
   commons, not a private log; the privacy control is at the **profile** level (public
   & searchable, or private = name + photo only). Users can **delete their account and
   export their data**; deletion anonymizes (doesn't erase) their past reports (D33).

## Who it's for / rollout

- **Alpha (first ~20 users):** the founder + close skating friends. Squash bugs
  in a real friend group before any broader push.
- **Then:** expand region-by-region (likely NH/VT/ME first — where the community
  and existing FB groups are), rather than thin nationwide coverage.

## Core value loop

A skater hunting for good ice tomorrow opens the map, pans around what's within
their willing **drive time** from home, taps candidate water bodies, and reads
the freshest peer reports for each — then makes their own call.

Reports are seeded and kept fresh via:
- Native in-app reporting (live or just-finished).
- **The in-app GPS recorder** — record the skate here, and stopping it offers to file the report
  with the real path attached. *(Amended 2026-07-24: this used to read "Strava integration —
  auto-detect ice-skate activities"; Strava's terms forbid the pull direction, so we record it
  ourselves and **push** to Strava instead — see D24's amendment and L7.)*
- (Aspirational) **Bridging** existing Google Group / Facebook posts into
  summarized in-app reports.

## Feature pillars

- **Map** — home-centered, water-focused, drive-time filtered, custom icy/FUI style.
- **Reports** — per-water-body feed; ice quality, hazards, photos, weather, time.
  Always **public** (D13) — post to the community or not at all.
- **Hazards** — users draw points/lines/shaded areas *within* a water body to mark
  specific dangers; Waze-style "is this still there?" confirmation loop.
- **Community (no social graph — D13)** — threaded comments on reports; **searchable
  profiles** (public or private) that coalesce a skater's reports; a **trust score**
  earned from corroboration + helpful marks (D50); town (not address) optionally public
  on profile. Deliberately **no follow/friend graph** — a report is a report regardless
  of who made it, and any private coordination belongs off-platform.
- **GPS tracks — recorded here, pushed out** *(reframed 2026-07-24, D24 amendment / L7)*. A native
  in-app **recorder** produces the trusted path; a track that's ours is legal to draw on a public
  report and aggregate into a lake's community map (a Strava-sourced one never would be). It
  **pushes** to Strava (`activity:write`) so you keep your stats — record once, get both. Garmin /
  COROS / Polar / Apple Health / Google Health Connect stay planned **input adapters** into the same
  store, deferred. Each skate is **resolved to the water body it was on** (D44), so you can find
  "skates on Lake Morey" by name, not by drawing a box on the map. Where a path came from is also
  what lets a skate on unmapped water **create** that water body — a track is evidence, a drawing
  isn't (D14).
- **Bounties** — request a report for a water body; skaters who were recently
  there get prompted; honest reports (esp. with photo evidence) earn reputation.
- **Newsfeed** — reports/conversations within the user's drive radius, sorted by
  most recent **skate time** first.

## App structure & navigation

Two primary top-level pages — **Map** (default) and **Newsfeed** — plus
create/detail/profile flows. They're two lenses on the same reports: Map is
**spatial**, Newsfeed is **chronological**.

### Mobile (Expo Router — tab navigation)
- **Map** (default tab) — home/water framing on open (D20); tap a water body → detail.
- **Newsfeed** (tab) — cross-water-body, in-range feed (above).
- **＋ Report** (center action) — create a report (offline-capable, D9).
- **Bounties** (tab) — browse / request bounties.
- **You** (tab) — profile, reputation, GPS connections, settings, notifications.

### Web (TanStack Start routes) — see D47
- `/` — Map (default). **Create-a-report** and **bounties** are surfaced *here*, not as
  separate pages (D47).
- `/feed` — Newsfeed, with **create-a-report** surfaced here too (D47).
- `/u/:username` — profile (including the current user's own) — its own page.
- `/settings` — settings + GPS provider connections.
- `/notifications` — notifications.
- **Detail child routes** — `/report/:id` (+ threaded comments), `/bounties/:id`,
  `/water/:id` (water-body view) — are reached *from* `/` and `/feed`; there are **no
  top-level `/report` or `/bounties` browse pages** (D47). Added as the summary-in-place
  content outgrows the top-level pages — deferred, not built up-front.
- Auth handled by **Clerk** (D26), with the same **profile-provisioning + risk-ack gate**
  as mobile (onboarding / re-ack).

Both surfaces read the same Convex data; mobile and web share logic/types/tokens,
not UI components (D7).

## Explicitly deferred

- AI predictions of ice condition (liability-heavy — see open questions; at most,
  *summarize/contextualize* human reports, never predict actionable go/no-go).
- In-app group-skate organizing.
- In-app safety guides (link out to existing resources instead).
- Monetization (passion / open-source project; lean on free tiers).

## Aesthetic & accessibility

FUI ("fantasy UI" / sci-fi / spy-movie) — techy and reserved, **never at the
expense of usability**. Explored later; foundation and features come first.

Two first-class themes (D34): a **high-contrast / bright outdoor mode** for
readability in glare on sunny ice (readability outdoors is a safety feature), and
a **dark mode** for evening planning on the sofa. Baseline accessibility — WCAG AA
contrast, dynamic type, screen-reader labels — is a requirement, not a polish item.
