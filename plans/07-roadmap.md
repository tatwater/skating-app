# Roadmap

Phased build sequence. Each phase is independently useful and ends in something the
alpha crew can test. Decisions referenced as D#; see `01-decisions.md`.

> **Start now (lead-time gates, in parallel with Phase 0):** Apple Developer
> enrollment; Strava API app; **Garmin / COROS / Polar partner applications**
> (approval takes weeks — apply for *all* GPS providers now even though they ship
> fast-follow, D24); Clerk, Convex, Vercel, Expo, **Sentry** accounts. See
> `05-accounts-and-credentials.md`.

## Phase 0 — Foundations
- Monorepo with shared packages: design tokens, Convex client, types/validators (D7).
- Convex project + schema from `06-data-model.md`.
- **Clerk** auth wired to Convex (D26), on both Expo + web.
- App shells: **Expo** (Expo Router tabs) + **TanStack Start** (deployed to
  **Vercel**, D27).
- FUI design tokens consumed by Tailwind (web) + Tamagui (mobile) (D7), with
  **high-contrast + dark themes** scaffolded (D34).
- **Sentry** wired on both surfaces from day one (D29).
- **Done:** sign in on both apps; empty Map + Newsfeed pages render; deploy is green;
  crashes report to Sentry.
- Needs: Convex, Clerk, Vercel, Expo, Apple (dev build), Sentry.

## Phase 1 — Water-body data
- OSM ETL for one **pilot region**: clip + simplify polygons; load `waterBodies`
  (name, type, polygon, bbox, centroid, area) (D5/D14).
- **Done:** water bodies queryable by bbox and rendering on the map.
- Needs: OSM extract tooling (GDAL/QGIS), Convex.

## Phase 2 — Map + reports (the MVP)
- MapLibre map (D6) with wintery style; home/water framing on open (D20).
- Tap a water body → detail view (name, area, report feed by **skate time**).
- Create + read a **report** (ice types, surface tags, coarse quality, structured
  thickness, photos, conditions, visibility) — **offline-capable** (D9/D30), with
  **client-side image optimization** on upload (D31).
- Report `visibility` is stored now, but only **just_me / public** are meaningful
  until the follow graph lands (Phase 3) — fine for the earliest builds.
- **User-created water bodies (D14)** with **match-on-create dedup** (D36): steer the
  user onto a nearby existing body (bbox + IoU + name) before creating a new one.
- **Done:** friends can post and read reports on real lakes. *This is the usable MVP.*
- Needs: MapLibre + tiles (Protomaps), Convex file storage.

## Phase 3 — Social graph + comments + moderation
*(Moved ahead of Drive-time/Newsfeed so `friends`/`followers` visibility is real
before feeds filter on it.)*
- Follows (mutual = friends), optional follower approval, full **visibility
  resolution** for all four levels (D13).
- Friend search/discovery. Threaded **comments** on reports (D21/D25).
- **Safety/moderation (D32):** block/mute users, flag reports/comments/photos/users
  for abuse (incl. `unsafe_false_report`), moderator hide/remove path.
- **Water-body dedup review queue (D36):** moderator view of `suspected_duplicate`
  bodies with a manual **merge** (re-point children → survivor, soft-tombstone loser).
- **Done:** follow friends; comment threads work; visibility + blocks enforced
  everywhere; content can be flagged and taken down; duplicate lakes can be merged.

## Phase 4 — Drive-time filtering
- Isochrone from home (**hosted ORS**), cached per user (D18/D35); radius fallback.
- Filter map + feeds to the user's range.
- **Done:** map/feed show only in-range water bodies/reports.
- Needs: OpenRouteService key.

## Phase 5 — Newsfeed page
- Cross-water-body feed within range, newest **skate time** first (D28) — now
  correctly **visibility-filtered** (depends on Phase 3).
- **Temporarily expand radius** (session-only) to browse wider.
- **Done:** browse recent community activity without going lake-by-lake.

## Phase 6 — GPS providers (fast-follow order — D24)
- **Strava + Apple HealthKit first** (covers most of the US alpha; Strava carries
  write-ups/photos, HealthKit covers Apple Watch).
- **Garmin next** (watch GPS + fallback for cross-user map display if Strava's terms
  forbid it — see `04-integrations.md`).
- **COROS · Polar · Google Health Connect** fast-follow.
- Detect ice-skate activities → prompt report → ingest **trusted path** (+ media
  where ToS allows). Normalize to `gpsActivities`.
- **Done:** logging an ice skate on a supported device prompts a report with the
  real path prefilled.
- Needs: provider approvals/keys (all applied for in Phase 0).

## Phase 7 — Hazards
- Draw hazards (point/line/area) within a water body; typed vocabulary.
- Lifecycle (fresh/aging/stale) + "still there / gone" confirmations, triggered
  opportunistically (app-open nearby, report flow, post-hoc GPS path) (D12/D15).
- **Done:** hazards appear, age, and can be confirmed/cleared.

## Phase 8 — Bounties + reputation
- Request a report for a water body; notify eligible recent skaters; fulfill;
  helpful/unhelpful thumbs → cosmetic points/badges (D10/D17).
- **Done:** end-to-end bounty loop with reputation.

## Phase 9 — Weather-since strips
- Open-Meteo "what the weather has done since this report" factual strip (D19).
- **Done:** aging reports show peak temp / hours above freezing / sun / precip / wind.

## Later / deferred (see 02-open-questions)
- Forum/Facebook ingestion + AI comment-vs-report classification (Q8).
- Strava-path hazard *deduction* (Q11); user-location dedup (Q12).
- AI report summarization beyond weather facts (Q9); ToS/legal (Q10).
- In-app guides; group-skate organizing; Fitbit as a GPS provider.

## Cross-cutting (every phase)
- Notifications with per-type toggles (D16).
- Safety-first, non-authoritative framing in all copy (D3).
- Metric internal / imperial display (D25).
- **Accessibility + dark mode** honored as UI is built (D34).
- **Sentry** crash/error hygiene; **PostHog** analytics/flags added once there's
  usage to measure (D29).
- **Account deletion + data export** wired as auth/profile matures (D33).
