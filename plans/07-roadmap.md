# Roadmap

Phased build sequence. Each phase is independently useful and ends in something the
alpha crew can test. Decisions referenced as D#; see `01-decisions.md`.

> **Seasonal context:** first ice is ~November; planning is happening in summer. The
> alpha crew won't lean on the app until most phases are in place, so it's fine to
> build core plumbing early even when a user-facing headline feature lands later.

> **Start now (lead-time gates, in parallel with Phase 0):** Apple Developer
> enrollment; Strava API app; **Garmin / COROS / Polar partner applications**
> (approval takes weeks — apply for *all* GPS providers now even though they ship
> fast-follow, D24); Clerk, Convex, Vercel, Expo, **Sentry** accounts. See
> `05-accounts-and-credentials.md`.

## Phase 0 — Foundations
- **Turborepo + pnpm** monorepo (D39): `apps/mobile`, `apps/web`, shared `packages/*`
  (design tokens, Convex client, types/validators, logic) (D7).
- **Biome** lint/format + **Vitest + CI from day one** (D40/D46): GitHub Actions
  running `pnpm lint` + `turbo check-types test`, coverage reporting wired even while
  suites are small. Test scaffolding is boilerplate — stand it up now so every later
  phase lands with tests. *(`@skating/core` is the first package: pure logic at 100%
  coverage with example + property tests.)*
- Convex project + schema from `06-data-model.md`.
- **Clerk** auth wired to Convex (D26), on both Expo + web, with the **age gate (16+)**
  and **assumption-of-risk acknowledgment** at signup (D41/D45).
  - **Shipped:** the server contract is the trust boundary (D37) — `profiles.upsertFromClerk`
    enforces the 16+ DOB gate and **requires + records** a current risk acknowledgment
    (`RISK_ACK_VERSION` single-sourced in `@skating/core`). Mobile sign-up UI collects DOB +
    shows the blocking acknowledgment.
  - **⏳ Remaining Phase 0 (auth-provisioning PR):** wire the mobile client to actually
    **call `upsertFromClerk`** (today it only stages DOB + ack in Clerk `unsafeMetadata`),
    which also needs the **username/displayName collection UI**. Until then the client
    gates are UX-level. Passing DOB + ack must go through the enforced mutation, never
    `unsafeMetadata`. See D41/D45 status notes.
- App shells: **Expo** (Expo Router tabs) + **TanStack Start** (deployed to
  **Vercel**, D27).
- FUI design tokens consumed by Tailwind (web) + Tamagui (mobile) (D7), with
  **high-contrast + dark themes** scaffolded (D34).
- **Sentry** wired on both surfaces from day one (D29).
- **License hygiene:** `LICENSE` (AGPL-3.0) + `LICENSE-EXCEPTIONS.md` (App Store /
  Play exception, D43) present and referenced from README + each app's about screen.
- **Done:** sign in on both apps (age-gated, risk ack recorded); empty Map + Newsfeed
  pages render; CI is green with coverage reporting; deploy is green; crashes report
  to Sentry.
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
  **client-side image optimization + EXIF stripping** on upload (D31/D42).
- **Photo geotag opt-in** (D42): default off; if on, photos pin at their coord within
  the water body.
- Report `visibility` is stored now with the **derived default** (D41), but only
  **just_me / public** are meaningful until the follow graph lands (Phase 3) — fine
  for the earliest builds.
- **User-created water bodies (D14)** with **match-on-create dedup** (D36): steer the
  user onto a nearby existing body (bbox + IoU + name) before creating a new one.
- **Done:** friends can post and read reports on real lakes. *This is the usable MVP.*
- Needs: MapLibre + tiles (Protomaps), Convex file storage.

## Phase 3 — Social graph + comments (+ user-facing safety tools)
*(Split from the old combined phase, and moved ahead of Drive-time/Newsfeed so
`friends`/`followers` visibility is real before feeds filter on it.)*
- Follows (mutual = friends), optional follower approval, full **visibility
  resolution** for all four levels (D13), honoring the derived defaults (D41).
- Friend search/discovery. Threaded **comments** on reports (D21/D25).
- **User-facing safety tools (D32):** block/mute users; flag reports/comments/photos/
  users for abuse (incl. `unsafe_false_report`). These must ship *with* the social
  graph — public UGC + follows without block/report is unacceptable.
- A minimal moderator **hide/remove** path (founder) so flagged content can be taken
  down immediately, even before the full operator surface (Phase 4).
- **Done:** follow friends; comment threads work; visibility + blocks enforced
  everywhere; content can be flagged and quickly taken down.

## Phase 4 — Operator surface (admin, moderation, dedup review)
*(The founder-facing back office — the second half of the old combined phase.)*
- **Admin/moderator surface (D37):** a role-gated **`/admin` route tree in the web app**
  (not a separate app), organized as **work queues** — flag queue (with
  `unsafe_false_report` in a **priority lane** per D3), user admin (search/history,
  **ban/suspend/unban**, grant role), and a **support inbox** (`supportTickets`, D35 —
  not Zendesk). Role model expands to `member | moderator | admin` (admin ⊇ moderator).
- **Water-body dedup review queue (D36):** moderator view of `suspected_duplicate`
  bodies with a manual **merge** (re-point children → survivor, soft-tombstone loser),
  plus **approve/reject** of user-drawn bodies (`reviewStatus`, D37).
- Every admin mutation gates on `role` server-side and writes a **`moderationActions`**
  audit row.
- **Operator alerts (D38):** Resend + React Email — email the founder on new
  `supportTickets` and safety-priority items, deep-linking into `/admin`.
- **Done:** operators can ban/unban users, approve/reject user-drawn water bodies, and
  triage flags + support from `/admin`, with every action audited and safety items
  alerted by email.
- Needs: Resend (domain verified).

## Phase 5 — Drive-time filtering
- Isochrone from home (**hosted ORS**), cached per user (D18/D35); radius fallback.
- Filter map + feeds to the user's range.
- **Done:** map/feed show only in-range water bodies/reports.
- Needs: OpenRouteService key.

## Phase 6 — Newsfeed page
- Cross-water-body feed within range, newest **skate time** first (D28) — now
  correctly **visibility-filtered** (depends on Phase 3).
- **Temporarily expand radius** (session-only) to browse wider.
- **Done:** browse recent community activity without going lake-by-lake.

## Phase 7 — GPS providers (fast-follow order — D24)
- **Strava + Apple HealthKit first** (covers most of the US alpha; Strava carries
  write-ups/photos, HealthKit covers Apple Watch).
- **Garmin next** (watch GPS + fallback for cross-user map display if Strava's terms
  forbid it — see `04-integrations.md`).
- **COROS · Polar · Google Health Connect** fast-follow.
- Detect ice-skate activities → prompt report → ingest **trusted path** (+ media
  where ToS allows). Normalize to `gpsActivities` and **resolve each to its
  `waterBodyId`** (D44) so skates are findable by lake.
- **Done:** logging an ice skate on a supported device prompts a report with the
  real path prefilled, and the skate shows up in that lake's history by name.
- Needs: provider approvals/keys (all applied for in Phase 0).

## Phase 8 — Hazards
- Draw hazards (point/line/area) within a water body; typed vocabulary.
- Lifecycle (fresh/aging/stale) + "still there / gone" confirmations, triggered
  opportunistically (app-open nearby, report flow, post-hoc GPS path) (D12/D15).
- **Done:** hazards appear, age, and can be confirmed/cleared.

## Phase 9 — Bounties + reputation
- Request a report for a water body; notify eligible recent skaters (report *or*
  resolved GPS skate on that body, D44); fulfill; helpful/unhelpful thumbs →
  cosmetic points/badges (D10/D17).
- **Done:** end-to-end bounty loop with reputation.

## Phase 10 — Weather-since strips
- Open-Meteo "what the weather has done since this report" factual strip (D19).
- **Done:** aging reports show peak temp / hours above freezing / sun / precip / wind.

## Later / deferred (see 02-open-questions)
- Forum/Facebook ingestion + AI comment-vs-report classification (Q8).
- Strava-path hazard *deduction* (Q11); auto-merge dedup + community confirmations (D36).
- AI report summarization beyond weather facts (Q9); full ToS/legal review (Q10).
- In-app guides; group-skate organizing; Fitbit as a GPS provider.

## Cross-cutting (every phase)
- **Tests land with the feature** — Vitest unit/logic + property tests for
  safety-sensitive math; `convex-test` for functions; coverage ratchets up (D40).
- Notifications with per-type toggles — every type toggleable (D16).
- Safety-first, non-authoritative framing in all copy (D3); assumption-of-risk ack (D45).
- Privacy by default: derived report-visibility defaults (D41); EXIF stripped, geotag
  opt-in (D42).
- Metric internal / imperial display (D25).
- **Accessibility + dark mode** honored as UI is built (D34).
- **Sentry** crash/error hygiene; **PostHog** analytics/flags added once there's
  usage to measure (D29) — session replay masked/off where location or minors are
  involved (revisit before enabling).
- **Account deletion + data export** wired as auth/profile matures (D33).
