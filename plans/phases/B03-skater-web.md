# Phase B03 — The skater web app

> **Status:** complete, 2026-11-07; **reopened 2026-11-24** for the onboarding and the season check, §9
> (with the 18+ change, D294). PRs #95–#98 built it; #100–#104 are the close-out and the live-test
> fixes that followed, and §8 is their record. The build model held: one governor and parallel agents in
> their own worktrees, cut from main on `phase-b03-skater-web`. The deferred and owed rows live in the
> roadmap entry (`07-roadmap.md`, Phase B03). Mocks: Paper *Gli · Web app · Review 3* (157 boards), rules
> in `skating-mockups/skater-web/README.md`.

It covers the seven route pages of *Gli · Web app · Review 3* (157 boards,
`skating-mockups/skater-web/boards-all.tsv`), built on the kit (`apps/web/src/components/kit/`, merged with
PR #90) and the tokens (`packages/design`, `data-surface="skater"` × `data-mode`).

Sources read: `CLAUDE.md`, `plans/README.md`, `plans/research/web-frontend-stack-2026-10-30.md` (untracked in the
b01-admin worktree), `skater-web/README.md` (Reviews 2–4 and the founder's calls after Review 4), `BRIEF.md`, every
`boards-*.tsv`, `chrome.js`, `lat.js` and the page HTML, `web-stack-research/skater-web-audit.md` §1–§2 and §9,
`apps/web/src` today, the public Convex surface, the B01 kit checklist, D24 (with its 2026-11-06 amendment), D29,
D166, D199, L12, `PRIVACY.md`, and **PR #91 (merged 2026-11-07), which already wires PostHog and mints
D235.** That PR changed §4 of the brief: PostHog isn't a greenfield job anymore. This build extends what #91
set up — §4.0 lists what the merged version already covers.

---

## 0. What the interrogation found, before the plan

These are the facts that shape the build. The calls the founder still has to make are in §6.

1. **PostHog is merged (PR #91, D235), and it settled more than this plan's first draft assumed:** US cloud,
   **direct cross-origin ingestion at `us.i.posthog.com`** — the `/rink` same-origin proxy was built and then
   *reversed on the branch itself*: `posthog-js` sets no `credentials` option, so the browser attached Clerk's
   `__session` cookie to every same-origin event, and a Vercel rewrite would forward it to PostHog. `env.ts`
   records the reasoning; a cookie-stripping hop can restore a proxy later with no code change. Also merged:
   `disable_session_recording: true` (test-enforced), `capture_exceptions: false` and `capture_performance:
   false` **stated, never left absent** — in posthog-js an absent option defers to the dashboard's remote
   config — surveys, product tours, conversations, web experiments, heatmaps and clipboard capture all pinned
   off, `person_profiles: 'identified_only'`, a deploy-environment property stamped in `before_send`, query
   strings stripped from every URL property, identity = the Clerk `userId` only (reset on sign-out and account
   switch), autocapture on (founder call), `capture_pageview: 'history_change'`, ten typed events in
   `lib/analytics.ts`, and the empty `useFeatureFlag(flag, fallback)` harness. Env: **only `VITE_POSTHOG_KEY`
   needs a Vercel value**; `VITE_POSTHOG_HOST` is an unset-by-default override of the ingestion host, and
   there is no `VITE_POSTHOG_UI_HOST`. The six old skater components #91 touched are main's now, so the
   rewrite starts from them and no merge-ordering question remains.
2. **What the merged #91 leaves for the skater routes' URL grammar (§3 below):**
   - Query strings are *already stripped* (`stripUrlQuery` in `before_send` covers `$current_url`, `$referrer`
     and the `$set_once` initials), so a debounced `?q=` leaks no search text. What remains is **volume**:
     `history_change` fires a pageview on every search-param change, so `?q=`, a tab switch or `?post=` would
     each spam pageviews and wreck the funnels. §4.1 dedupes them by route id.
   - `$pathname` carries `/u/<username>` — another person's handle. Path segments are otherwise kept **on a
     recorded founder call** (`posthogOptions.ts`: "which lakes and reports draw traffic is a question worth
     being able to ask"), so the fix masks the username segment alone and never touches lake or report ids.
3. **The 7-day report limit is already the server rule.** `packages/core/src/endTimeChips.ts` (D199) caps an end
   time at seven days before now, and the same predicate covers the picker, the queue flush, an imported track
   and `posts.create`. The "14 days" was only in the mock. Nothing to build; the calendar just draws two rows
   with the last 7 days live.
4. **GPX import had no *labeled* server path — but it was already live.** The build (agent S, 2026-11-07)
   found A10-7's `TrackImport` ingesting GPX files on both surfaces, stored as `provider: 'native'` — so
   D239's trust level had been de facto live since A10-7, unlabeled. What S added: the `gpx` provider label
   (so the D239 revert can find those rows, plus a backfill for the old ones), shared validation for both
   providers (bounds, point cap, timestamps — native's checks were thinner than this doc assumed), and the
   D199 7-day rule enforced at ingest, which it previously wasn't. **Answered (founder, 2026-11-07): fully
   trusted for now** — a temporary D24 exception, to be reverted later (Q5, D239).
5. **Feed filters live in two homes today.** D166 keeps one persisted filter store (`lib/feedFiltersStore.ts`:
   localStorage plus `profiles.feedFilterPrefs`), which **the map also reads** (weather and drive time dim
   non-matching bodies). The research doc's §4 puts "filters" in the URL. Applied to Latest, that would cut the
   map off from the filters. That's a contradiction to settle (§6, Q3).
6. **The whole app is signed-in only today** (`lib/authZone.ts`): signed out, you can reach `/sign-in`,
   `/sign-up` and `/about` and nothing else. The boards draw only About signed out (7.17). D229 makes the first
   store listing **iPhone only**, so at launch the web *is* the Android path. That bears on Q1 and Q2.
7. **New server scope the boards assume** (each one is its own call; none is built by a UI agent):
   - Latest text search over reports (4.9). There's no search index on post text, and the README already calls
     it "new scope".
   - Latest skater filter (4.8). `FeedFilters` has no author field.
   - A geocoder for typing a home address (7.18, "typed address with geocoder suggestions"). Nothing does forward
     geocoding today; `setHome` takes coordinates.
   - The GPX provider (item 4).
   - A bounty-fill rule (Review 3, c-td43kf): a report whose skate time is before a bounty opened must not fill
     that bounty. I haven't checked this server-side yet; it's the first thing the report-flow agent verifies.
8. **Contradictions between docs, resolved by the newest one** (recorded here so no agent builds the old
   version):
   - BRIEF's "points on a bounty label" → Review 2's "no points anywhere". The label is an outline badge, and the
     count reads "3 open bounties".
   - BRIEF's and the audit's (§9.3) "every hazard list ends with the no-alert line" → Review 4's call: an (i) by
     the *Known hazards* title with the tooltip "It's possible there are unreported hazards on this ice.", and the
     empty state keeps its full sentence. This changes a D3-adjacent copy rule, so it gets a D# (§7).
   - The audit's "Fully healed is destructive" → Review 4: the second confirmation **stays**, but it's drawn in ice,
     not red.
   - The research doc's resizable, cookie-persisted panes are an admin pattern. The skater sidebar is a fixed
     440 px (27.5 rem) on the boards, so no resize. The theme cookie still applies (§2).
   - The proposal's top bar had a theme button; the theme picker lives in the **avatar menu** (founder,
     2026-11-07), with the phone's three-way picker in the menu sheet (9.5).
9. **Sign-in is Clerk's prebuilt `<SignIn>` today.** Boards 8.1–8.4 draw a custom email → code flow over the
   regional map, so this means a Clerk custom flow (`useSignIn` / `useSignUp`, email-code only, as dev already
   is). The ticket-based headless test path (`__clerk_ticket`) keeps working.
10. **Kit gaps are few and all compositions**, so nothing new goes into `kit/` at the start — and the kit
    already covers more than the first draft noticed: `CellLoader` (in `meter.tsx`) *is* the seven-cell
    middle-out loader, so `Splash` is rebuilt on it and no `GliLoader` exists. §1.0's promotion rule governs
    what moves into `kit/` mid-build.
11. **D3 copy has one home.** The hazard-caveat strings live in `packages/core/src/hazardCopy.ts`, shared with
    mobile; D237's tooltip sentence is added *there*, and both surfaces' hazard lists render it.
12. **Depth draws as banded lines, not filled bands, and is now a switch** (the §2 build, 2026-11-07). The
    bathymetry archive holds contour lines, which MapLibre cannot fill between, so the skater map ships
    banded contour lines with a shallowest-band fill on the focused lake — real bands wait on polygons from
    the pipeline and a re-tile (the roadmap's *Filled depth bands* deferred row); board 3.16's Depth switch
    is the newer founder call, so D81 is amended to make depth a viewer toggle while hazards stay locked on.
    **Real bands are built** (2026-11-07): the pipeline traces band polygons into the contour archive's
    second layer, `bathymetry_bands` (`scripts/bathymetry/BANDS.md`), and a web fill layer draws them on the
    water, under the contour lines, off the same source and filter (`bodyId` is the lines' key). The
    shallow-band ground stays under it, so a lake without bands draws exactly the look above. Region zoom
    draws no bands, as it drew no contours: depth belongs to the open lake. Only the upload is left (§8).
13. **Dev Clerk disagrees with the boards twice** (the §8 build, 2026-11-07). The instance requires a
    password at sign-up, so the email → code sign-up stops at `missing_requirements` until the founder turns
    that requirement off in the dashboard; the flow shows an honest failure state, pinned by a test. And
    Google, Apple and Microsoft sign-in are enabled on the instance while the boards draw email only, so the
    rebuilt web drops those buttons — an account created with Google can still receive an email code.

---

## 1. Route map

**Grammar rule: keep every path the outside world already links to.** That covers notification targets
(`lib/notificationTargets.ts`: `/water/$id`, `/report/$id`, `/hazard/$id`, `/bounty/$id`), email links, mobile's
`skating://` mirror, `/u/$username`, `/post?body=`, and `/hazard/$id?action=confirm`. New views become search
params on those paths, never new paths that break old links. Every search schema is a `zod` object passed to
`validateSearch`, with `.catch()` defaults so a bad link degrades to the default view instead of an error.

The shell (every signed-in route): `SkaterShell` sets `data-surface="skater"` and `data-mode` (from the theme
cookie), then renders `SkaterTopBar` (logo · Explore · Latest · search · New report · bell · avatar). Below
`md` it switches to `PhoneTopBar` + `PhoneTabBar` (Explore · New report · Latest). It also keeps the old shell's
side effects: `profiles.setTimezone` and `syncFromClerk` on every app open.

**Root search params** (validated on the skater layout route — §1.0 — so they work from any skater page):

| Param | Values | Meaning |
|---|---|---|
| `post` | `new` · `<reportId>` | the New report sheet open over the current page (new, or editing that report) |
| `postBody` | water-body id | which lake a new report starts on (from a lake, a notification, or "Add a report?") |

`/post?body=&edit=` becomes a redirect into `?post=new&postBody=` / `?post=<id>` over Explore, so old links keep
working.

### 1.0 Two surfaces, one app

The admin console mounts on **`/admin`**, as today (founder, 2026-11-07), in the same TanStack app. The rules
that keep the two surfaces one system:

- **The root search params (`post`, `postBody`) are validated on a pathless *skater layout* route, never on
  `__root`** — otherwise `?post=new` opens the report sheet over the admin console. `/admin`, `/sign-in`,
  `/sign-up`, `/onboarding`, `/reack` and `/google-photos/callback` sit outside that layout.
- **The theme cookie (D241) is shared infrastructure.** Each shell reads the same cookie; `SkaterShell` sets
  `data-surface="skater"`, and the console shell (B01's, later) sets its own. Until the console rebuild
  retires the old `/admin` pages, wave 0 keeps the `.dark` class in sync with `data-mode` so next-themes'
  consumers keep theming — the moderation pages must not break mid-phase.
- **Telemetry never mixes the surfaces.** Each shell registers a `surface` super-property in PostHog and a
  `surface` tag in Sentry from day one; a moderator living in the console must not sit in a skater funnel.
- **Compositions are built only from kit components and design tokens** — no raw colors, no hand-rolled
  controls; bespoke CSS is layout only. Anything a second surface plausibly wants is flagged to the lead, and
  the lead runs a **promotion review at each integration**: the piece moves into `kit/` with four-up stories.
  Candidates already visible from the admin mocks: `InsetCard` (the Body console wants inset cards, and the
  kit Dialog already has viewer/scoped modes), `ReportCard` (the console's Inbox and Body reports tabs show
  reports), and `GlobalSearch`'s grouped-autocomplete internals (shared with `CommandPalette`).
- The avatar menu's **Moderation ↗** opens `/admin` in a new tab (the standing rule); the skater build
  touches nothing else under `/admin`.

### 1.1 Explore (rows 1–3, 48 boards)

| Path | Search params (zod) | What renders |
|---|---|---|
| `/` | `act?: 'request'` · `layers?` → **no**, layers aren't in the URL (they're chrome, §2) | Nothing chosen: the *In view* lake list in the sidebar, the map beside it (1.1, 1.4/1.5) |
| `/water/$id` | `tab: 'reports'\|'weather'\|'access'\|'about'` (default `reports`) · `sub?: subAreaId` (bay, 1.10) · `act?: 'hazard'\|'bounty'\|'imagery'\|'access-problem'` · `band?: 'tc'\|'vh'` (imagery) · `frame?: yyyy-mm-dd` (imagery) | The lake sidebar: header, (alert), the four tabs (1.2–1.14); actions open as views over it (3.1–3.16) |
| `/report/$id` | none | The report as an **inset card** over its lake's sidebar ("‹ Back to Mascoma Lake · Esc"), 2.4/2.5 |
| `/hazard/$id` | `action?: 'confirm'` (kept from today) | Hazard inset card, 2.1–2.3 |
| `/bounty/$id` | none | Bounty inset card, 2.6/2.7 |

Never in the URL: map camera, click coordinates (request-a-lake from a map click), and the hazard-drawing
geometry. Coordinates in a URL would leak into history, referrers, Sentry and PostHog. The camera stays in the
map store. Sharing a view means sharing the lake link.

**Regions.** Sidebar 27.5 rem (header with silhouette, name, slug, star, Directions icon, the one primary *New
report* plus *Report a hazard* · *Post a bounty*; NWS alert strip above the tabs; tab bodies; the attribution
pinned to the sidebar's foot) | map (labels with a leader, put-ins, hazard marks, depth bands and legend,
favorites' stars and bounty badges on labels, inactive bodies in gray, a dock of map controls: zoom, locate,
layers, imagery, return to the region).

**Tab contents:**
- **Reports:** *Known hazards* (i) → reports → bounties line.
- **Weather:** "What's coming", past days, wind rose (reuse the shipped one), "Weather at" only when there are 2 or
  more sample points.
- **Getting there:** public access, put-ins (6), parking, hike-in kept separate from drive time, "Report an access
  problem".
- **About:** shape, depth "31 / 79 ft", wind exposure, ice history with its disclaimer, links (new tab),
  moderator card (1.14).

**Kit used:** `Tabs`, `Section`/`SectionSlug`, `Badge`, `Button`, `ButtonGroup`, `Tooltip` (the hazard (i)),
`Note` (alert, standing notice), `Plate`, `ScrollArea`, `Skeleton` (2.8), `Dialog` inset-card mode, `Avatar`,
`Chart`/`TraceChart`/`MatrixChart` (weather), `MapPane`/`MapDock`/`MapZoom`/`MapLayerRack`/`MapScaleBar`/
`MapHoverPlate`/`MapModeBar` (drawing modes), `SwitchRow` (layers), `Slider` (imagery scrubber), `AlertDialog`
(Fully healed confirm), `Popover` (access problem), `Toast`.

**Actions (row 3):**
- **Hazard flow (3.1–3.8):** what you saw → place a spot, trace a line, draw an area, or follow the shore (with
  the "Long way around" / "Shortest distance" toggle) → size, photos and note → confirm the nearby one.
- **Bounty (3.9–3.11):** which part of the lake, and a "refused" state.
- **Request a lake (3.12/3.13):** a left-click on unlisted water.
- **Imagery (3.14/3.15):** the narrow hollow thumb timeline; radar has no short ticks.
- Layers (3.16), return to the region (3.25).
- Search (3.17–3.20), notifications (3.21–3.23) and the avatar menu (3.24) belong to the shell.

### 1.2 Latest (row 4, 17 boards)

| Path | Search params | What renders |
|---|---|---|
| `/latest` (`/feed` redirects) | `report?: reportId` (4.5–4.7: the report opens as a drawer from the right, over a scrim on the page — founder, 2026-11-07) · `q?: string` (debounced 300 ms; 4.9, behind the text-search gap) · `skater?: username` (4.8, behind the author-filter gap) · `view?: 'map'` (4.4) | Filters on the left · feed in the center · Recommended and *Wanted near you* on the right |

Filters (drive time, posted, quality, ice type, thickness, weather match) depend on Q3. My recommendation is that
they stay in the persisted D166 store and out of the URL, with the URL carrying only the transient view state
listed above.

- **Empty states:** 4.10, 4.11, 4.12, 4.13, 4.18.
- **Loading:** 4.15. **Wanted:** 4.16/4.17 (hidden when there are none).
- **Kit:** `ToggleGroup` (posted, quality), `Select`, `NumberField` (thickness), `Checkbox` group (ice types),
  `Input` (search), `Section`, `ListEnd`, `Skeleton`, `ScrollArea`, `Avatar`, `Badge`.
- **4.4 "on the map":** reuses the Explore map in a Latest frame, which needs the shared `SkaterMap` composition
  (§1.8).

### 1.3 New report (row 5, 31 boards)

There's no path of its own. It's the `?post=` sheet over whatever page you came from (5.1), two panes: the
instrument on the left (the lake on the map, the day's ruler, the weather you had) and one sheet on the right
(your words and photos, then the questions in fixed order, minimum-set ones open, the rest folded).

**Boards and states:**
- Which Lake? (5.2/5.3), with the Strava/GPX/Garmin cards: Garmin disabled and marked "Coming soon", GPX working
  once Q5 is settled, official marks from `assets/brands/`.
- From a lake (5.4), remove a lake (5.4.1).
- Sections in order: sightings (5.5), when / end-time ladder / after dark (5.6/5.7), snow (5.8), thickness
  (5.9), hazard verdicts (5.10), access (5.11), anything else (5.12).
- Report a hazard *stacked* inside it (5.10.1), which reuses the Explore hazard flow as a stacked `Sheet`.
- Where mode and area (5.13/5.13.1/5.14), put-in mode (5.15).
- Another report (5.16/5.17), photos from several lakes sorted into tabs by EXIF (5.17.1), two reports (5.18).
- Photos tile menu (5.19/5.20), Google Photos (5.21), correcting the weather (5.22).
- Minimum set refused (5.23/5.24), posting with everything faded (5.25), sent with no answer (5.26), offline
  (5.27).
- Editing (5.28–5.30), leaving without posting (5.31).

Inner sub-modes (where, put-in, stacked hazard) are component/store state, not URL: one Esc per screen, and a
sub-mode is left by a click.

**Kit:** `Sheet` (stacked; covers the header of the sheet under it), `Collapsible` (folded questions),
`ToggleGroup`/`RadioGroup`, `NumberField`, `Textarea`, `DropdownMenu` (tile menu, another report), `Tabs` (lakes
and days), `AlertDialog` (leave, remove a lake), `Toast`, `Note`, `Meter` (the sections count, which never says
"ready"), map controls.

### 1.4 Profile (row 6, 9 boards)

- **Path:** `/u/$username`. No search params; block and flag are dialogs, so component state.
- **Regions:** header (circle avatar, name, handle, bio, stats), *Your bounties* (own profile only), the
  person's reports, and the moderator panel (6.8).
- **States:** yours (6.1/6.2), someone else (6.3), block (6.4), flag (6.5), private (6.6), leaving (6.7),
  unavailable (6.9).
- **Kit:** `Avatar`, `Section`, `GridList`, `AlertDialog`, `Dialog`, `Button`, `Badge`, `ListEnd`.

### 1.5 Settings & About (row 7, 17 boards)

| Path | What renders |
|---|---|
| `/settings` → redirects to `/settings/account` | |
| `/settings/$section`, where section is `account`, `profile`, `home`, `notifications`, `reporting`, `blocked`, `support` or `data` (validated in `params.parse`) | A left list of sections and the section body |
| `/settings/home` with `edit?: true` (7.18) and `travel?: true` (7.19) | Change home / traveling are views, so URL |
| `/about` (public) | 7.16; signed out 7.17 |

**Sections:**
- **Account:** change email by code (7.3), sign out with an unsent draft (7.15).
- **Your profile.**
- **Home and drive time:** set or unset; change home by typed address (the geocoder, agent S) or current location;
  traveling until a date.
- **Notifications.**
- **Reports and tracks:** connected accounts. Strava's official "Connect with Strava" button and "Powered by
  Strava" lockup, push only; Garmin disabled, "Coming soon"; GPX.
- **Blocked people.** **Contact support.** **Data and account:** export, delete with confirmation, deletion
  pending.

The old components re-skin into these: `ChangeEmail`, `AccountLifecycle`, `AggregateTracksSetting`,
`PutInSetting`, `SwitchSetting`, `ContactSupport`, `ProfileEdit`.

**Kit:** `SwitchRow`, `Input`, `Select`, `RadioGroup`, `AlertDialog`, `Note`, `GridList`, `Button`.

### 1.6 Sign-in & System (row 8, 17 boards)

| Path | Search params | What renders |
|---|---|---|
| `/sign-in` | none (email → code → wrong code are component steps) | A custom Clerk flow over the regional map (8.1–8.3, 8.15) |
| `/sign-up` | none | 8.4 |
| `/onboarding` | none | Finish your profile: empty, under 18 (D294), ready, username taken, username not allowed (8.5–8.7, 8.16, 8.18, 8.19) |
| `/reack` | none | One quick thing (8.8), with the risk acknowledgment verbatim — retired by §9 (D295); both rows are superseded by §9.6 |
| `/google-photos/callback` | none | The pop-up's four states (8.9) |
| root `notFoundComponent` | | 404 under the top bar when signed in, with the region beneath it (8.14) |
| root `errorComponent` / `Sentry.ErrorBoundary` fallback | | Something broke (8.11) |
| `Splash` | | The loader (8.10), rebuilt on the kit's `CellLoader` — already seven cells, middle-out |
| offline: first load (8.12) and over Explore (8.13/8.17) | | |

**The region background** is one static picture per theme (`basemap/region-dark.png` / `region-light.png`),
copied into `apps/web/src/assets/`, set to `object-fit: cover` and positioned so the NY/MA line sits just below
the canvas. It's never a single lake. The slow-pan video is a later idea, not in scope.

### 1.7 Phone (row 9, 9 boards, 390 wide)

These aren't separate routes. They're the same routes below `md`:
- Explore list (9.1), the lake in a `Drawer` at half or full snap (9.2–9.4).
- The avatar menu as a bottom sheet with the three-way theme picker (9.5), search (9.6), Latest (9.7).
- New report: the true blank with Garmin "Coming soon" (9.7.1), blank from Mascoma (9.8), filled in (9.9).

**Kit:** `Drawer` (`DRAWER_SNAP_POINTS`), plus everything above.

### 1.8 New compositions in `components/skater/` (nothing new in the kit)

| Composition | Built from | Why the kit doesn't cover it |
|---|---|---|
| `SkaterShell` | CSS grid + Router layout | The kit's `AppShell` is the admin rail shell |
| `SkaterTopBar` (logo, nav, search, New report, bell, avatar) | `Button` nav variant, `SearchTrigger`, `Avatar`, `Kbd` | The kit's top-bar parts are admin (season tape, colleague faces) |
| `GlobalSearch` (lakes · bays · skaters; recent; nothing found → "click it on the map") | `Popover` + Base UI Autocomplete (as `CommandPalette` uses) | The skater layout of groups and results; centered under the input |
| `NotificationsMenu` | `Popover`, `Avatar`, `Button` | Unread wash, New / Earlier groups, empty state, settings gear |
| `AvatarMenu` (profile, settings, about, Moderation ↗ for mods, theme System·Light·Dark, sign out) | `DropdownMenu`, `ToggleGroup` | Composition |
| `PhoneTopBar`, `PhoneTabBar`, `PhoneMenuSheet` | `Drawer`, `Button` | Composition |
| `SkaterMap` (one MapLibre instance, re-skinned) | existing `MapView` / `mapCanvas` / `waterMap` + kit map controls | The labels with a leader (`mapLabel`), put-in and hazard marks with a halo, bounty outline badge, star, inactive gray, depth bands; a mode bar for drawing |
| `LakeLabel` (the lockup: slug over name, leader, mirrors near the right edge) | DOM markers for the visible, bounded set | MapLibre symbols can't draw a fixed 45° leader with a mirrored lockup |
| `LakeSidebar` + `LakeHeader` + the four tab bodies | `Tabs`, `Section` … | Composition |
| `LakeRow` / `LakeSilhouette` (the In view list, search results) | existing `BodySilhouette` | Composition |
| `InsetCard` (report, hazard, bounty, with "‹ Back to … · Esc") | `Dialog` inset mode | Composition |
| `ReportCard` / `FeedCard` (Latest, lake Reports, profile) | `Avatar`, `Badge`, `Plate` | Composition; re-skins the old `FeedCard`/`PostCard` |
| `HazardRow`, `HazardList` (the (i) title, empty sentence) | `Tooltip`, `Badge` | Composition, plus the copy rule |
| `BountyBadge` / `BountyCard` ("3 want a report" with avatars) | `Badge`, `Avatar` | Composition |
| `ReportSheet` + section panels | `Sheet`, `Collapsible` … | Re-homes `components/sheet/*` |
| `WhichLakeCards` (Strava / GPX / Garmin "Coming soon") | `Plate`, `Button`, brand SVGs | Partner marks follow Strava's brand rules |
| `RegionBackdrop` | `<img>` per theme | System screens |
| `ThemeMenu` | `ToggleGroup` | Writes the theme cookie |

**Map instances — two, never portaled.** The region map is **one persistent instance owned by the skater
layout**: it never unmounts across `/` ↔ `/water/$id` ↔ the panels ↔ Latest's `?view=map` (none of those draw
two maps at once). Each view declares a small **map spec** — which layers are on, which interactions are
allowed, what to fit — and `SkaterMap` diffs and applies it on route change, so no view reaches into the map
and no view inherits the last view's layers. The report sheet's instrument pane is a **second, short-lived
instance** created when the sheet opens: the sheet floats over pages that may themselves show the region map
(a dimmed Explore behind the scrim is two maps legitimately on screen), and a portaled single instance would
have to swap camera, layers and drawing modes both ways on every open and close. The instrument's init cost
hides behind the sheet's opening transition and one lake's tile set; style, glyphs and sprites come from HTTP
cache after the first load. Never more than two GL contexts live at once.

**Navigation mechanics the URL grammar demands:**
- The browser's back button closes a `?post=` sheet, bypassing 5.31's leave dialog — the draft guard is a
  router **`useBlocker`**, not just the × button.
- Esc on a *deep-linked* sheet or inset card has no history entry to pop: Esc navigates with the param
  removed (`replace`), never `history.back()`.
- An inset card is a route, so Base UI's focus return doesn't come free: focus moves into the card on open
  and returns to the triggering element (or the sidebar) on close, by hand.

---

## 2. State plan

The four-homes rule (research §4), with Zustand as the only library. **New direct dependencies, declared in
`apps/web/package.json`:** `zod`, `zustand`, and `convex-helpers` if any helper is used (none is needed yet).

### 2.1 Zustand stores to create (`apps/web/src/stores/`)

| Store | Holds | Persist? | Notes |
|---|---|---|---|
| `useSkaterMapStore` | camera (center, zoom) for this session; layer toggles (depth, hazards, put-ins, imagery overlay, labels); hovered body; pending map click (lng/lat, request-a-lake); "away from the region" flag | layer toggles → localStorage (a per-viewer convenience); camera → sessionStorage only | Map and hotkey handlers read it without a hook. The camera is never in the URL |
| `useHazardDraftStore` | the hazard flow's step, type, geometry kind and geometry, size, photo handles, note, nearby-candidate choice; the stacked-in-report flag | owner-bound localStorage for words and geometry (photos can't survive a reload) | Survives a tab switch and the stack inside a report (5.10.1) |
| `useSearchStore` | open state (so `/` opens it from anywhere), recent picks (body id, bay id, username; up to 6) | recents → localStorage, **owner-bound** like `sheetStore` (a shared browser) | The query text is component state; results are Convex |
| `useChromeStore` | the one open top-bar overlay (`search` · `notifications` · `avatar` · null); phone drawer snap (half or full); the Latest phone column | no | One overlay at a time; Esc closes the outermost |
| (no new filters store) | today's `lib/feedFiltersStore.ts` (D166) **stays as it is** — the same "wrap, don't rewrite" standard `sheetStore` gets: a working persisted store with reconcile semantics isn't churned for uniformity | yes (as today) | If Q3 keeps filters out of the URL, new consumers use a thin hook over the existing store; a Zustand migration happens only if it ever blocks something |
| `sheetStore` (existing, `lib/sheetStore.ts`) | the report sheet: owner-bound, the attempt record | scalars stay in localStorage as today; **photos move to IndexedDB** (Blobs keyed by the draft, garbage-collected with it), plus resend-on-reconnect built on the attempt record (Review 3, c-ccmx4j) | The pure model stays in `@skating/core` (shared with mobile); the hand-written `useSyncExternalStore` holder stays. Only the persistence layer grows. Restore becomes async (a restoring state), and every IndexedDB failure path degrades to today's behavior: sheet restored, photos lost, the sheet says so. Its own early commit series (agent P, §5) with `fast-check` on the owner, age and GC invariants — **before** the new sheet UI lands on top |

Toasts use the kit's `toastManager`, so no store. Online/offline is a `useConnection()` hook over
`navigator.onLine` plus Convex's `connectionState()`, so no store either.

### 2.2 Per route

| Route | URL | Convex | Zustand | Component state | Cookie |
|---|---|---|---|---|---|
| Shell | `post`, `postBody` | `profiles.current`, `notifications.unreadCount` | `useChromeStore`, `useSearchStore` | search text (debounced), menu hover | **theme** (`system`·`light`·`dark`), read by a Start server function so SSR paints the right `data-mode` with no flash; replaces next-themes' localStorage, keeping the `.dark` class synced until the old `/admin` UI retires (§1.0) |
| Explore `/` | `act` | viewport lists, label counts, favorites, open bounties | `useSkaterMapStore`, `useFeedFiltersStore` (dimming, D166) | list scroll, hover | |
| Lake `/water/$id` | `tab`, `sub`, `act`, `band`, `frame` | lake, reports, hazards, bounties, weather, access, … | `useSkaterMapStore`, `useHazardDraftStore` | inset popovers, the bounty form's fields (small, short-lived), the access-problem text | |
| Panels `/report|hazard|bounty/$id` | `action` (hazard) | the item, comments, ratings, confirmations | | comment draft text, the Fully healed arming | |
| Latest `/latest` | `report`, `q`, `skater`, `view` | feed (paginated), recommended, wanted, weather discovery | `useFeedFiltersStore` | the filter popover open | |
| New report (`?post=`) | `post`, `postBody` | create/update, photos, putIns, hazards, weather actions, Google Photos | `sheetStore` (IndexedDB), `useHazardDraftStore` (stacked) | which section is open, sub-mode (where, put-in), photo tile menu | |
| Profile | | public profile, blocks, bounties | | the block and flag dialogs, flag reason | |
| Settings | `edit`, `travel` (home); section in the path | prefs, blocks, exports, deletion, Strava status | | form fields (each saves on change, the autosave meta) | |
| Sign-in / onboarding / reack | | `profiles.upsertFromClerk`, `acceptCurrentRiskAck` | | Clerk flow step, code input, field errors | |

---

## 3. Data plan (existing names; gaps in **bold**)

- **Shell:**
  - `profiles.current`, `profiles.setTimezone`, `profiles.syncFromClerk`
  - `notifications.list`, `notifications.unreadCount`, `notifications.markRead`
  - Search: `waterBodies.searchByName` (lakes and bays: it already returns sub-areas, `bodiesOnly` off),
    `profiles.searchProfiles`, and `reports.recentCardsForBodies` for "3 reports today" on results
- **Explore, nothing chosen:** `waterBodies.listInViewport`, `subAreas.listInViewport`,
  `reports.recentCardsForBodies` (label sub-lines), `bounties.listOpen` (badges; bounded),
  `waterBodyFavorites.listForUser`, `weatherDiscovery.matchedCells` (dim, D166). Request a lake:
  `waterBodies.resolveBodyForCoord`, then `corpusRequests.create`.
- **Lake sidebar:**
  - **Header and lists:** `waterBodies.get`, `waterBodyFavorites.isFavorite`/`toggle`,
    `weatherAlerts.listForBody`, `hazards.listForBody`, `reports.listByWaterBody`, `bounties.listForBody`,
    `subAreas.listForBody`, `landmarks.listForBody`, `corpusRequests.openCountsForBody`/`listMineForBody`
  - **Weather:** `weather.getForecastForBody` (action), `weatherArchive.getWeatherDaysForBody` (action),
    `weatherArchive.getSubAreaSpread`
  - **Getting there:** `accessPoints.accessForBody`, `listParkingForBody`, `listPhotos`, `putIns.listForBody`,
    `accessAlerts.listForBody`/`create`/`vote`/`retract`
  - **About:** `bodyFeatures.listForBody`, `recurrence.listForBody` (ice history),
    `gpsActivities.listTracksForBody`, `regionStats.list`
  - **Moderator (1.14):** the existing `waterBodies.set*`, `standing.setStanding` controls (re-skinned,
    capability-gated per D217)
- **Panels:**
  - Report: `reports.get`, `posts.getForReport`, `comments.listByReport`/`create`/`update`/`remove`,
    `ratings.rate`/`summaryForTarget`, `photos.getUrls`, `contentFlags.flag`, `gpsActivities.getForReport`
  - Hazard: `hazards.get`, `hazardConfirmations.listForHazard`/`confirm`, `photos.getHazardUrls`
  - Bounty: `bounties.getDetail`, `cancel`, `answeredByMyReport`
- **Actions:**
  - Hazard: `hazards.create`, `hazards.listForBody` with core's `findDuplicateCandidate` (3.8's "is this the
    one already here?" — corrected at close-out: `hazards.listBundleCandidates` returns only the author's own
    unattached pins, the sheet's D55 bundle list, not anyone's nearby hazard), `photos.generateUploadUrl`/`create`
  - Bounty: `bounties.create` (action), `bounties.myBountyLimit` (3.11)
  - Imagery: the archive comes from `env.imageryArchiveUrl` plus the satellite fields on `waterBodies.get`;
    `imageryLive.activity` is admin-only, so not used
- **Latest:**
  - `posts.listFeed` (paginated, filters), `reports.recommended`, `bounties.listOpen` (Wanted near you)
  - `weatherDiscovery.status`/`matchedCells`/`listBodyResults`, `profiles.setFeedFilterPrefs`
  - **Gap: an author filter on `listFeed`** (4.8)
  - **Gap: text search over reports** (4.9): a Convex `searchIndex` on post or report text, respecting blocks,
    private profiles and moderation
- **New report:**
  - `posts.create`/`update`/`remove`/`getForReport` (a post already carries several reports, which fits
    "another report" and two reports), `photos.*`, `waterBodies.searchByName`/`resolveBodyForCoord`,
    `putIns.listForBody`
  - `hazards.listForBody` + `hazardConfirmations.confirm` (verdicts), the weather actions via the existing
    `useSkateWeather`
  - `googlePhotos.available`/`begin`/`status`/`list`/`photo`/`close`/`abandon`/`complete`
  - `gpsActivities.listMine`/`setPromptState`, `strava.connectionStatus`/`pushActivity`
  - **Gap: GPX ingest** — a `gpx` provider beside `native`; fully trusted for now (Q5's answer, D239)
  - **Verify: the bounty-fill rule** against the skate time (c-td43kf)
  - Copy note: the D199 7-day window is already the server rule
- **Profile:** `profiles.getPublicProfile`, `blocks.block`/`unblock`, `contentFlags.flag`,
  `bounties.myBounties`, the moderation levers already used by `ProfileModeratorPanel`.
- **Settings:**
  - Profile and prefs: `profiles.updateProfile`/`setHome`/`setNotificationPrefs`/`setChannelPrefs`/
    `setShowPutInDefault`/`setAggregateTracksOptOut`, `blocks.myBlocks`/`unblock`, `support.create`
  - Data and account: `dataExport.requestExport`/`myExports`, `accountDeletion.requestDeletion`/`cancelDeletion`
  - Strava: `strava.beginConnect`/`connectionStatus`/`disconnect`; Clerk email change (existing `ChangeEmail`)
  - **Gap: forward geocoding** for a typed home address (7.18) — in scope (Q6's answer); the provider choice
    with its ToS and quota is agent S's first task, since nothing else hangs on which one
- **Sign-in & system:** Clerk `useSignIn`/`useSignUp`, `profiles.upsertFromClerk`, `acceptCurrentRiskAck`,
  `regionStats.list` (About).

Server gaps are their own workstream, never folded into a UI agent's batch — and **the founder approved all of
them (2026-11-07)**: the author filter, text search, GPX ingest, the forward geocoder, and checking the
bounty-fill rule. Agent S in §5 — the only agent that touches `packages/convex` or dev — lands them as one
commit series (with `convex-test` per D40) ahead of the UI that needs them. The UI builds behind a flag in
the meantime.

---

## 4. Observability plan (PostHog on the merged #91, and Sentry)

### 4.0 What the merged #91 already settles — keep all of it

- `AnalyticsProvider` outside Clerk, `PostHogIdentity` inside it (Clerk `userId` only; resets on sign-out and
  account switch); `person_profiles: 'identified_only'`.
- **Direct cross-origin ingestion at `us.i.posthog.com`** — the same-origin proxy was reversed because it
  forwarded Clerk's `__session` cookie (the reasoning is in `env.ts`). Env: **`VITE_POSTHOG_KEY` is the only
  value to set in Vercel** (an empty key makes PostHog inert); `VITE_POSTHOG_HOST` stays unset — it's the
  override for a future cookie-stripping proxy or a region move. Never displayed; only the
  `grep -o '^[A-Z_]…='` pattern.
- **The asymmetry, enforced from the PostHog side:** `capture_exceptions: false` and
  `capture_performance: false` — *stated*, because in posthog-js an absent option defers to the dashboard's
  remote config. Sentry owns errors and latency; PostHog captures neither (an exception message would bypass
  `@skating/core`'s redaction). If `sentryIntegration()` is ever wired for person links, its
  `sendExceptionsToPostHog` default of `true` hands PostHog un-redacted `$sentry_exception` — it stays off.
- Replay off at init (test-enforced; the L12 line); surveys, product tours, conversations, web experiments,
  heatmaps and clipboard capture all pinned off; query strings stripped from every URL property in
  `before_send`; a deploy-environment property on every event; `capture_pageview: 'history_change'`; the ten
  typed events (`useAnalytics().capture`) and the empty `useFeatureFlag` harness.
- **Path segments kept, ids included** (founder call recorded in `posthogOptions.ts`): which lakes and reports
  draw traffic is a question worth being able to ask. This plan does not reverse it.

**Placement in the new shell:** unchanged. The provider stays in `AppProviders` above the skater layout, so
the sign-in, onboarding and system screens are covered too. Each shell registers the `surface`
super-property (§1.0).

### 4.1 What this build adds to PostHog

1. **Pageview dedupe, not URL rewriting.** The router's matched `routeId` becomes a super-property set on
   each navigation, and `before_send` **drops a `$pageview` whose `routeId` didn't change** (a
   search-param-only navigation) — so a debounced `?q=`, a tab switch or `?post=` don't spam pageviews. Tabs
   and sheets get their own events instead. The only URL surgery is `/u/<username>` → `/u/:username` in the
   URL properties (a person's handle; lake and report ids stay, per the founder call in §4.0). Tests beside
   `posthogOptions.test.ts`.
2. **Autocapture text (Q4b):** autocapture stays on (founder call), but clicked-element text on skater pages
   means usernames, report text and lake names. Recommended: mask autocapture text on skater surfaces, with
   `data-attr` names on the controls worth knowing ("new-report", "report-hazard", "directions", …), and
   `ph-no-capture` on the report body, comments, profile header and map pane regardless.
3. **The event taxonomy, extended.** Same contract and rules: countable shape only; no text, name, id or
   coordinate; nothing about the ice. Names are `object_verb`, past tense:

   | Area | Events (props) |
   |---|---|
   | Navigation | `water_body_opened` (`source`: map, list, search, notification, latest, deep_link) · `water_body_tab_viewed` (`tab`) · `report_viewed` / `hazard_viewed` / `bounty_viewed` (`source`) |
   | Search | `search_opened` (`surface`: top_bar, phone, hotkey) · `search_result_opened` (`result_kind`: water_body, sub_area, skater; `rank` 1–6; `query_length_bucket`: 1-2, 3-5, 6-11, 12+, or `recent` for a pick from Recent with no query) · `search_no_results` (`query_length_bucket`, never `recent`) |
   | Latest | `latest_filter_changed` (`filter`: drive_time, posted, quality, ice_type, thickness, weather_match, snow_cover) · `latest_report_opened` · `wanted_bounty_opened` |
   | Report flow | `report_sheet_opened` (`entry`: top_bar, water_body, notification, phone_tab, edit, recorded_skate, deep_link) · `report_sheet_refused` (`missing_count`) · `report_sheet_abandoned` (`sections_answered`; fired on `pagehide` plus next-open reconciliation — `beforeunload` is unreliable) · `report_draft_restored` · `report_post_retried` (`offline`) · `report_photos_added` (`source`: device, google_photos; `count`) · `gpx_import_started` / `gpx_import_completed` (`point_count_bucket`) — `report_posted` / `report_updated` exist already |
   | Hazards | `hazard_flow_started` (`entry`: water_body, report_sheet) · `hazard_verdict_submitted` (`verdict`: still_there, crossed_here, healing, fully_healed, never_was, didnt_look) — these are the author's own claims, as labeled in the UI; `hazard_reported` / `existing_hazard_confirmed` exist |
   | Map | `map_layer_toggled` (`layer`, `on`) · `imagery_opened` (`band`) · `return_to_region_used` · `directions_opened` (`target`: put_in, parking) |
   | Account | `notifications_opened` (`unread_bucket`) · `notification_opened` (`kind`) · `theme_changed` (`mode`) · `strava_connect_started` · `sign_in_code_sent` / `sign_in_completed` (`method`: email_code) |

4. **D3 enforced by a test:** `analytics.test.ts` asserts that no event name and no enum value matches
   `/safe|skateable|good_to_go|all_clear|ok_to|go_no_go|conditions_(ok|good)|recommend(ed)?_ice/`. The verdict
   values are the UI's own labels for a skater's claim, and the test allowlists those exact strings.
5. **The flags surface:** `useFeatureFlag(flag, fallback)` as is, with flag keys registered in a typed
   `FEATURE_FLAGS` const instead of `string[]`.
   - Candidates: `latest-text-search`, `latest-skater-filter`, `gpx-import`, `phone-layout` (if the founder wants
     narrow web held back).
   - Flags render their fallback first and update on load, so **never flag the shell layout or anything above
     the fold**. Server-evaluated flags need `posthog-node` and are out of scope.
   - Same rule as D235: no flag guards anything a skater's safety rests on.

### 4.2 Session replay: the flag for the founder

On a map app, a replay records **where people look for ice, which lake they open, their home area in
Settings, and the map itself**. That's location data for a population that includes 16- and 17-year-olds.

**Recommended posture: replay stays off at launch** (L12 ⛔ and D29 as written; #91's test keeps it so). If the
founder wants it after the L12 legal pass:
- Adults only: `startSessionRecording()` only after the profile resolves and `isMinor === false`.
- **Sampled at 10%**, plus event-triggered on `report_sheet_refused` or an exception (to debug the report flow,
  not to watch browsing).
- `maskAllInputs: true` and **all text masked** (`maskTextSelector: '*'`).
- **The whole map pane blocked** (`blockSelector` on the `SkaterMap` root: DOM labels name lakes, and canvas
  recording stays off).
- Photos blocked; network and console capture off.
- Excluded on `/settings/*`, `/sign-in`, `/sign-up` and `/onboarding`.
- `PRIVACY.md` revised before it's enabled.

What's left then is clicks and layout in gray boxes. That's enough to find UX dead ends, and it can't say where
anyone skates.

### 4.3 Sentry

The posture is already right (deny-by-default `dataCollection`, the shared privacy hooks in `@skating/core`,
tests proving what leaves the browser and the server), so this is wiring, not policy:

- **Error boundaries at the right altitude.** 8.11 is the root fallback, but a crash in a report inset card
  must not take down Explore and the map: the panel routes and Latest's columns get route-level
  `errorComponent`s that report to Sentry, with the root boundary as last resort. "Convex disconnected" is
  not an error — the offline states (8.12/8.13/8.17) render from `useConnection`, and nothing is captured.
- **The custom Clerk flow is new error surface.** Replacing the prebuilt `<SignIn>` with `useSignIn` means
  Clerk API errors now pass through our own code; a test proves no email address and no code value reaches a
  Sentry event or breadcrumb from that flow.
- **Route-template transaction names** come from the router integration; verified once against the new route
  tree after wave 0, not per-agent.
- **The `surface` tag** (§1.0) on every event, so console errors and skater errors separate cleanly.
- PostHog captures no exceptions and no performance — already enforced in the merged options (§4.0); nothing
  to add, and nothing to be tempted into.

---

## 5. Build order: a governor and parallel agents

**Branch:** `phase-b03-skater-web` (token confirmed by the founder, 2026-11-07), **cut from main** — #90 and
#91 are both merged, so there is no stacking on `b01-web-kit` and no merge-ordering precondition left.

**The model.** One governor thread orchestrates; 6–8 sub-agents (Opus, high) run in parallel, each in its
**own worktree off the phase branch**, owning a disjoint file territory. Parallelism is bounded by file
ownership and the dependency graph below, not by lockstep waves: an agent starts the moment its "needs"
column is integrated, so the machine stays at 6–8 agents for the duration instead of draining between waves.

**Governor rules:**
- Owns the shared seams — `routes/__root.tsx`, the route-tree registration, `AppProviders`,
  `package.json` — and the foundations commit series below. Agents never edit a file outside their
  territory; a needed seam change is a request to the governor.
- Owns `kit/` promotions: agents propose, the governor lands them at integration, so two agents never add
  the same kit piece (§1.0's promotion review).
- **Integrates serially** — one agent branch rebased onto the phase branch at a time — running
  `pnpm check-types`, lint and the touched suites at each integration, and the full suite at each PR
  checkpoint (`--force` after anything under `plans/**`: turbo caches the repo-wide guards).
- **Convex dev is a singleton.** Only agent S touches `packages/convex` and runs `convex dev --once`;
  everyone else proves functions with `convex-test`. One worktree's push drops another's indexes.
- Every brief carries the env-value rule verbatim, the no-stash rule, and explicit paths for commits.
- Agents run targeted Vitest; the full suite and the Storybook build are governor-only, so 6–8 agents don't
  thrash the machine.

**The dependency graph** (an agent starts when its "needs" column is integrated):

| Agent | Scope (owns) | Needs | Starts |
|---|---|---|---|
| **Gov** | foundations: deps (`zod`, `zustand`); the skater layout route + root search schema; route grammar and redirects (`/feed`→`/latest`, `/post`→`?post=`, `/notifications`→the bell); the theme cookie + server read + `.dark` sync; store skeletons; the `routeId` super-property, pageview dedupe and `/u/:username` masking; taxonomy types; region backdrop assets | main | T0 |
| **S — server gaps** (all approved, founder 2026-11-07) | `packages/convex`: the text-search index, the author filter, the `gpx` provider (fully trusted, D239), the forward geocoder (the provider pick first — ToS and quota), the bounty-fill verify | nothing | T0 |
| **P — sheet persistence** | `lib/sheetStore*`, `lib/sheetPhotos`: the IndexedDB photo store, resend-on-reconnect, `fast-check` invariants | nothing | T0 |
| **A — shell** | `SkaterShell`, `SkaterTopBar`, `GlobalSearch`, `NotificationsMenu`, `AvatarMenu`/`ThemeMenu`, `Splash` on `CellLoader`, 404, crash, offline | Gov | T1 |
| **B — map** | `SkaterMap` + the per-view map specs, `LakeLabel`, marks, badges, depth bands, dock, `useSkaterMapStore` | Gov | T1 |
| **F — sign-in & system** | the Clerk custom flow, onboarding, reack, the Google Photos pop-up, `RegionBackdrop` | Gov (it sits outside the shell) | T1 |
| **E — panels** | `InsetCard`; `ReportCard`/`FeedCard` (E owns the report rendering — C, G and H consume it); the report, hazard and bounty cards, comments, ratings, Fully healed | A | T2 |
| **C — Explore sidebar** | the In view list, the `LakeSidebar` frame and header, Reports tab (hazard (i)), About, bay, inactive, alert, moderator card | A (B loosely — it renders beside the map) | T2 |
| **D — lake Weather + Getting there** | the two tab bodies, the wind-rose reuse, the "Weather at" rule, the access problem | C's frame (C lands the frame first) | T2 |
| **G — profile + settings + about** | `/u/$username`, `/settings/*`, `/about`, the re-skinned old settings components | A | T2 |
| **H — Latest** | filters, feed, Recommended, Wanted, report open, empties, `?view=map` (4.4); behind flags for the §3 gaps | A, E (the cards) | T2–T3 |
| **I — report sheet core** | the `?post=` sheet over any page, Which Lake? (brand cards), sections, posting, refused, error, offline, edit, leave (`useBlocker`) | A, P | T3 |
| **J — Explore actions** | the hazard flow (spot, line, area, shore, size, nearby) built so it can stack; bounty; request a lake; imagery | B, C | T3 |
| **K — sheet, second half** | where and put-in modes on the instrument map, photos (tile menu, Google Photos, EXIF sort into lake and day tabs), another report and two reports, the stacked hazard (5.10.1), GPX behind its flag once Q5 is answered | I, J | T4 |
| **L — phone** | row 9 across Explore, Latest and New report (`Drawer` snaps, tab bar, menu sheet) | A, B, C, H, I | T4 |
| **Gov close** | D3 copy sweep, every event wired, the a11y verification pass (one Esc per screen, `/` for search), delete the superseded old components, coverage, `/code-review xhigh --fix`, `pnpm check-types`, tests, lint, the roadmap entry and phase-doc findings | everything | T5 |

Concurrency stays in budget: T0 runs three (Gov, S, P); T1 runs five or six (S and P continue beside A, B,
F); T2 peaks at 6–8 (E, C, G, then D behind C's frame, then H); T3–T4 narrow to the flows. **The critical
path is Gov → A → I → K → L**; the governor protects it by staffing I the moment A and P integrate, and L
moves earlier if Q2 makes narrow web launch-critical.

**PR checkpoints** (Greptile is metered; the stack merges bottom-up, and a child is **retargeted before its
base merges** — the #90 lesson):
- **B03-1:** foundations, shell, map, sign-in & system, sheet persistence (Gov, A, B, F, P).
- **B03-2:** the server gaps at the head, then Explore and the panels (S, C, D, E).
- **B03-3:** Latest, Profile, Settings (G, H).
- **B03-4:** the report flow, Explore actions, the phone pass, deletions, the roadmap close (I, J, K, L).

Each aims under ~5,000 lines; stories and tests inflate counts, so where one runs over, the stated reason is
the review boundary — half a shell or half a report flow reviews worse than a long PR.

Every agent lands its stories (four-up skater dark/light only where it's a composition; the kit owns the
admin maps) **with the keyboard path asserted in the story** — a11y is built per composition and the close-out
pass verifies rather than retrofits. Vitest per D40, `fast-check` for anything safety-sensitive (hazard
staleness, the 7-day window display), and each agent renders its boards side by side with the Paper board
before handoff.

---

## 6. Founder questions (only the calls the docs don't answer)

1. **Signed-out visitors — answered (founder, 2026-11-07): gated at launch** (D238). Everything but
   `/about` and the auth pages keeps redirecting to `/sign-in`: no new consent path for the risk
   acknowledgment, and it matches mobile. Public read returns later as its own decision.
2. **What the web doesn't do — answered (founder, 2026-11-07): the web never records a skate** (D238) — no
   on-ice alerting, no push, no offline capture beyond the draft (all native). **The phone pass stays the
   last wave**, not launch-critical and not flagged: row 9's scope (Explore, Latest, New report at 390 px)
   lands with T4 as planned.
3. **Filters — answered (founder, 2026-11-07): a saved preference** (D242). D166's store stays as it is
   (wrapped, not rewritten); the Explore map keeps reading the same filters to dim non-matching bodies, and
   Latest's URL carries only `report`, `q`, `skater` and `view`. Shareable filtered links are given up.
4. **PostHog on top of the merged #91 — answered (founder, 2026-11-07), both recorded in D240:**
   - (a) **Replay stays off at launch.** D29, L12 and the D235 init-lock all stand; §4.2's posture is what a
     future L12 pass would enable.
   - (b) **Yes — autocapture text is masked on skater surfaces**, with `data-attr` names on the controls
     worth knowing and `ph-no-capture` on the report body, comments, profile header and map pane regardless.

   (The host question is settled and merged: direct cross-origin to the US cloud, the proxy reversed for the
   Clerk-cookie reason recorded in `env.ts`.)
5. **What an imported GPX is worth — answered (founder, 2026-11-07): (c), fully trusted, as a temporary
   stop-gap.** The options were (a) GPX only seeds the report's lake, day and time and draws for the author
   alone; (b) a track but never a public path; (c) fully trusted. The founder's reasoning: right now the
   imported track is a big wow factor, and the early test users are not prone to meddling with it. This is a
   deliberate, temporary exception to D24's "a trusted extent comes only from real device GPS" — **revert to
   (a) once Garmin or another native import path lands** (the deferred row in the roadmap entry; D239). The
   server change (a `gpx` provider beside `native`) is agent S's either way.
6. **New server scope the boards assume — answered (founder, 2026-11-07): all three.**
   - Text search over reports (4.9)
   - A skater filter on Latest (4.8)
   - A forward geocoder for typing a home address (7.18) — the provider (with its ToS and quota) is agent
     S's first pick; "Use my current location" stays as the fallback either way.
7. **Phase shape — answered (founder, 2026-11-07):** it's **B03 — The skater web app**, this doc is the phase
   doc, and the ⚪ roadmap entry is written.

Answered by the docs, so not asked: the 7-day limit (already D199 on the server); Garmin disabled with "Coming
soon" and Strava push-only with official marks (the D24 amendment and Review 4); the regional map behind sign-in
and system screens (static per-theme PNGs; video later); the theme in the avatar menu (confirmed by the
founder, 2026-11-07); the notifications dropdown; bounties with no page; old URLs kept; the console mounted
on `/admin` as today (founder, 2026-11-07).

---

## 7. Phase mechanics

This doc is the phase doc. The ⚪ roadmap entry was written at scoping (2026-11-07); it flips to 🟡 at wave 0
(part of B03-1's PR) and 🟢 at the last merge (B03-4's).

**Workstreams (with `§` sigils):**
- §1 Foundations and the shell
- §2 The map
- §3 Explore
- §4 Latest
- §5 New report
- §6 Explore actions
- §7 Profile, Settings and About
- §8 Sign-in and system
- §9 Narrow screens
- §10 Analytics
- §11 Server gaps (if approved)

The onboarding addition (2026-11-24) is written up as this doc's section 9 and cited as `§9.N`; the
narrow-screens workstream above keeps its name, and the roadmap's pointers to it now cite §1.7, the phone's
route map, so no `§9` means two things.

The build's findings go in the phase doc, not the roadmap. Deferred-register rows: the slow-pan region video,
Garmin (already deferred under D24), and replay (L12).

**The phase's D#s** (minted 2026-11-07 at wave 0; D236 had meanwhile gone to #92's turbo-guards
decision, so the route grammar took D242 instead — gaps never close, tokens never shift):
- **D237:** the hazard-list caveat moves from a standing line to the title's (i) tooltip; the empty state
  keeps the full sentence. Amends the audit's §9.3 rule (which traces to D3); the sentence lives in
  `packages/core/src/hazardCopy.ts` so mobile and the console render the same words.
- **D238:** the web stays gated at launch (Q1) and never records a skate (Q2): no on-ice alerting, no push,
  no offline capture beyond the draft; the phone pass stays the last wave.
- **D239:** GPX import ships **fully trusted** — a deliberate temporary D24 exception, reverted to
  seed-and-author-only once Garmin or another native import path lands (the roadmap entry's deferred row
  keeps the obligation).
- **D240:** the skater analytics posture on top of merged D235: URL-deduped pageviews (the §4.1 sketch said
  routeId; that would have dropped `/water/a` → `/water/b`, so the dedupe keys on the stripped URL);
  `/u/:username` masked while lake and report ids stay; `route_id` + `surface` super-properties with a
  resolver stamping pageviews; the D3 test over names *and* enum values; the typed `FEATURE_FLAGS`
  registry; replay off at launch (Q4a) and autocapture text masked on skater surfaces (Q4b).
- **D241:** the theme moves to a cookie, replacing next-themes' localStorage; `data-mode` absent means
  follow-the-OS (the token sheet's contract), and the `.dark` class stays synced until the old `/admin` UI
  retires (§1.0). First paint is settled by a blocking init script rather than an SSR read — this Start
  version exposes no server cookie helper; the promise is "no flash, one store", not the mechanism.
- **D242:** the skater route grammar and URL state. Old paths are kept; tabs, actions and New report are
  search params (`?post=`, `?tab=`, `?act=`), validated on the skater layout route, never `__root` (§1.0);
  `/feed` → `/latest`; no coordinates or camera in any URL; filters stay the saved D166 preference (Q3).
- **D294–D298** (2026-11-22 to 2026-11-24): the onboarding addition — the 18+ minimum, the terms
  acceptance, Know Before You Go, the consent record and the onboarding itself (§9).

## 8. What the build found

Recorded at close-out (2026-11-07). Telegraphic; the commits carry the detail.

- **GPX was already live.** A10-7's `TrackImport` had ingested GPX on both surfaces since that phase, stored as
  `provider: 'native'`; D239 labels an existing behavior (`gpx`, plus `gpsActivities:backfillGpxProvider` for
  the old rows) rather than enabling a new one. §0 item 4 has the scoping note's correction.
- **3.8 needed a different query.** `hazards.listBundleCandidates` is the author's own unattached pins (the
  sheet's D55 bundle list); the "one already here?" step reads `hazards.listForBody` through core's
  `findDuplicateCandidate`. §3's data list is corrected in place.
- **The bounty-fill rule was missing.** Before §11, any new report on a body attached to every open bounty
  there, whenever it was skated — a Monday write-up of a Saturday skate could fill a Sunday bounty.
  `reportAnswersBounty` now compares the skate's end with the bounty's opening, at attach and again at
  fulfill and on every read.
- **A DST bug in core's `zonedInstantOnDayOf`.** Found by the sheet calendar's property test: it stepped
  `dayDelta × 24 h` of elapsed time, so near a clock change "two days back" landed on the wrong date (and so
  did extraction's "yesterday at h:mm"). Now calendar arithmetic on the local date, with core tests of its own.
- **Board 4.8 draws no feed filter.** The author filter on `posts.listFeed` is built behind a flag and off.
- **Clerk's instance settings matter to the custom flow.** Sign-up can finish only if the instance doesn't
  require a password (else the code verifies and stops at `missing_requirements`, shown as a dead end); the
  instance's enabled social providers have no button in the email-code flow. Both are dashboard settings to
  confirm before launch.
- **The gpx-dedup review finding was moot.** It needed an inbound Strava track, and none can exist: Strava is
  push-only by its API terms (`strava.ts`), so every stored track came from our recorder or a file. Only the
  legacy-`native` GPX row needed the fix (`198de63d`).
- **`sightings[].note` escaped the purge.** Added by D210 after `reportRedaction` was written, a departed
  skater's sighting prose survived the D62 purge until §11; it clears like every other note now.
- **The close-out's own finds.** The report sheet's empty hazard hint read as an all-clear ("No open hazards
  on this lake right now"); it now shows core's `NO_KNOWN_HAZARDS`. Mobile's sheet still carries the old
  string (`apps/mobile/src/components/sheet/HazardsSection.tsx`). The weather chart's fixed gradient id
  painted a second chart in the first one's theme, and the floated imagery plate covered the map's zoom and
  layer buttons on a phone.
- **The geocoder is Geoapify (founder, 2026-11-07).** Agent S built `geocode.suggest` behind an adapter and
  left it off, since ORS — the zero-new-vendor option — has a terms clause against transmitting personal data,
  and a typed home address is personal data even with no name on it; the same account also feeds the drive-time
  bands. The founder picked a new vendor with clean terms over that risk: Geoapify, on its own free account
  (3,000 credits/day). The flip is safe before the account exists: with no `GEOAPIFY_API_KEY` the action answers
  `off`, as it did with no provider. The ORS adapter is deleted rather than kept one line from use.
  `04-integrations.md` § Geocoding has the terms; `PRIVACY.md` the disclosure.
- **Hazards over a satellite picture: on, with a peek (founder, 2026-11-07).** The marks stay locked on at
  full strength over imagery; the one a mouse rests on fades to 35% so the ice under it shows, and comes back
  on pointer-out. Keyboard focus and a touch never fade one — focus is inspecting the mark itself.
- **Latest's report is a drawer (founder, 2026-11-07).** The build had opened `?report=` over the center column;
  the boards (4.5–4.7) draw a 500 px drawer from the right over a scrim on the whole page under the top bar, and
  the founder picked the boards. It is the kit Sheet with a new `md` width (the `sheet-md` size token, 500);
  `PanelDrawer` shares the inset card's mechanics (`useCardMechanics`) — deep-link Esc drops the param with
  `replace`, a feed-opened one steps back, focus returns to the row, and the feed keeps its scroll under the
  scrim. On a phone the same drawer takes the full width.
- **Filled depth bands: built in two halves, joined on the pipeline's contract.** The map layer was written
  ahead of the pipeline and guessed a third archive with a `bands` layer; `BANDS.md` put the bands in the
  contour archive as `bathymetry_bands`, so the layer was reconciled to it and the extra env var dropped.
  Edges land only on contours a lake really has (founder, accepted): Mascoma, contoured every 10 ft, has no
  band 1, so color comes from `bandIndex` and the legend over an open lake prints each band's real
  `minDepthFt`–`maxDepthFt` ("0–10 ft", "70+ ft"), never the ramp's edges. Unmeasured coves on fitted lakes
  ship unclipped (founder); every band carries `lane` for a provenance treatment nothing draws yet. Bands
  exist z9–14; the layer keeps the contours' z11 floor. The ramp's edges and band math have one home,
  `@skating/core`'s `contourLayer.ts`. A local archive can't be tried through the web dev server — its
  Nitro static handler answers a Range request with the whole file, which pmtiles rejects — so BANDS.md
  now says to serve it with `serve --cors`. The upload followed on 2026-11-09:
  `dev/bathymetry-20261109.pmtiles`, with both apps' env vars pointed at it.
- **Waiting on the founder:** the "Weather at" default (whole lake or the bay in view); whether a reading's
  coordinates are redacted on a public report.

### 8.1 After the merge: the restack dropped ten fixes (#100)

The founder's two hands-on passes on 2026-11-07 produced fifteen fix commits on the local
`phase-b03-skater-web` branch, *after* #98's tip. The stack was then restacked onto
`phase-b03-skater-web-4`: that branch took the When-section rework and the report-flow batch and left the
other ten behind, on a branch the notes had by then marked STALE. #95–#98 merged without them, so the dev
deployment ran the pre-test build. #100 replays them onto main.

- **The one that showed: Explore drew no map.** `maplibre-gl.css` declares `.maplibregl-map { position:
  relative }` and rides the lazy canvas chunk, so it loads *after* the app's sheet — one class against one
  class, later wins. A container asking for `absolute inset-0` returns to normal flow with its insets
  ignored, measures zero tall, and MapLibre sizes its canvas from `height || 300`: a 300 px strip at the
  top of an 840×744 pane. The map still loads, still fires `load`, still reports a viewport, so the sidebar
  list populates normally and nothing errors. Both B03 canvases carried it; the console's two did not.
  All four now take one exported `MAP_CONTAINER_CLASS`, and `MapContainer.stories.tsx` measures it in a
  browser with MapLibre's stylesheet loaded — jsdom has neither a cascade nor layout, so no unit test can
  see this. Flip the constant back and it fails at height 0.
- **Three of the ten needed a real merge**, because main had moved under them: `MapMarksLayer` had gained a
  hazard-pin *peek* (the fade under imagery) where the lost commit added the *hover plate* — both are kept;
  `LakeSidebar`'s story still asserted the credits at the sidebar foot after main moved them to the map
  chip; and `EndTimePanel`'s extra `Math.min(ms, floorToMinute(now))` was redundant once `clampToWindow`
  absorbed the minute floor.
- **Reviewing recovered commits is not reviewing merged ones.** These were written against a tree that no
  longer exists, so they were reviewed again as a batch against the main they now land on — ten further
  findings, each fixed with a test. Two were real: the returning-load hold (`BootScreen`) never escalated
  to the offline screen the way `FirstLoadSplash` did, so a load with no socket held on skeletons forever;
  and `refileToFootprintBody` moved `waterBodyId` while leaving `subAreaId`/`subAreaName` stamped from the
  lake the pin had just left, so a card could read "Mascoma — Far Bay".
- **The map palette redesign is held back as one unit** (the roadmap's deferred row). Its second half
  conflicts in nine places with the filled depth bands that landed in #98, and three founder calls are
  open. Its first half is tokens-only, so shipping it alone would add four unused keys to
  `packages/design` — a package the kit thread owns.
- **The lesson for the next restack:** a branch that is about to be abandoned should be diffed against its
  replacement by *content*, not by commit count. `git cherry` is useless once a branch has been
  squash-merged (every patch-id differs), which is what hid this; what found it was grepping main for each
  fix's own marker — `MAP_CONTAINER_CLASS`, `--size-sidebar`, `gli-boot`, `orderAccessPutIns`.

### 8.2 Latest's filter column was a segment too narrow

The founder's live test found "Great" cropped off the right edge of the Quality row. The column was
the boards' 17 rem (272 px). A `ToggleGroup` segment is `whitespace-nowrap`, so `flex-auto` cannot
shrink one below its own label — `min-width: auto` floors it at the text — and the row therefore
does not compress, it spills, which the aside's `overflow-y: auto` turns into a sideways scrollbar
nobody goes looking for. The column is now 18.5 rem (296 px).

**Chasing the number found a second thing: the web app never fetches its typeface.** The first
measurement said the row wanted 285.3 px; a measurement with the webfont loaded said 273.5. Both
were right. `--family-sans` is `Saira, system-ui, sans-serif`, and the only place Saira is fetched
for web is `.storybook/preview-head.html`. The app's root links one stylesheet, `app.css`, and
neither it, `kit.css` nor the design package's generated CSS carries an `@font-face` — so the
skater web app has been rendering in `system-ui` since B03 shipped, while every story renders in
Saira. That is why the founder's screen cropped the row harder than a story does, and it means
every measurement story in the kit has been validating a face the app does not serve. Whether the
app should load Saira is the founder's call (it is a visual change on every screen, and a Google
Fonts dependency); 296 px was chosen to clear both faces so this fix does not depend on the answer.
*Settled 2026-11-10 (founder): the app self-hosts both faces through Fontsource's variable
packages, imported by `app.css`, and Storybook now loads the same files — no Google fetch remains.*

The column and the `BootScreen` skeleton standing in for it now read one `--size-latest-filters`,
the way `BootMapPage` already shares `--size-sidebar` with the real sidebar. They have to agree: a
skeleton a different width from the page it becomes would slide the feed sideways the moment the
first query lands. `Latest.stories` measures both segment rows against the column's edge, so the
next label that outgrows it fails in the browser project instead of on the founder's screen — after
awaiting the segment's own face, because Saira loads with `display=swap` and the two faces differ
by 12 px on this row, which is the whole margin under test (Greptile, #101).

Same shape as the `--size-sidebar` widening recorded above: a row of nowrap boxes in a fixed column
is a measurement, not a judgment, and jsdom has no layout to make it.

### 8.3 The map palette: light has no headroom (#102)

The map's water and shore were Phase 01's `#3a6ea5` and `#9ecae1` in *both* modes, neither a token.
The founder settled it on 2026-11-09: a listed body is drawn in the bathymetric ramp rather than in
ice — band 0 is the water, band 0's index line is the shore — so an unchosen lake and a chosen
lake's shallows are the same color and opening a lake *reveals* depth instead of repainting the
water. Ice is left to the things that aren't water. Three things the build found:

**Protomaps' `white` earth is `#ffffff`, which is the skater light field exactly.** The map pane had
no edge against the sidebar at all; the lakes floated on the page. The land became a token,
`map-earth`, placed a fraction of the way in lightness from the field to band 0 — `MAP_EARTH_SPLIT`,
the founder's rule, and the single number the whole basemap hangs on. It was the midpoint on
2026-11-09, which put it at `#1d2022` dark and `#eff3f6` light; **the founder's live read on
2026-11-10 was that the midpoint is muddy in both themes**, so the split is a quarter and the land
resolves to `#0f1114` dark and `#f6f9fd` light — darker in dark, lighter in light. What that buys is
a map that reads as one surface with the page; what it spends is the pane's own edge, which falls
from 1.24:1 to 1.08:1 against the field in dark (1.11:1 → 1.06:1 in light). `primitives.test.ts`
derives the four literals from the fraction, so a third pass is one number and an edit to the field
or to band 0 can't quietly leave the land behind.

**The flavor has a `background` field as well as `earth`.** Protomaps keys its viewport-wide
background layer on the former, so overriding `earth` alone left light painting `#ffffff` behind
everything — invisible to every test (nothing rendered a basemap), visible on first paint and on
every pan past the tiles, in the one mode the token was added for. A background layer ignores its
source and covers the viewport: it is the first thing you see and the last thing a unit test knows
about.

**A softening sized for one palette is a hazard in the next.** The shore's zoom curve faded it to
.55 below z7 so a region of lakes wasn't a region of outlines — correct when the shore was bright
ice. Against band 0's index line on the new land it measured 1.43:1 in light and 1.71:1 in dark,
under the file's own floor, and the app opens at `INITIAL_ZOOM` 6.5 — *below* `farZoom` — so that
dim value is what the region view actually paints. The guard missed it by measuring the shore
undimmed, an opacity the region map never uses. `far` is .9 now, which is all light can afford.

**Still open.** Light's band 0 (`#dde8f0`, L 0.925) sits a hair under the field (L 1.0), so the
midpoint land lands between two near-identical values: the water reads 1.11:1 against the land, and
a mark's ground halo over water reads the same — and that halo exists under D34 to lift a pin off
whatever it lands on, which is usually water, not land. Dark is comfortable throughout (1.56 /
2.50 / 1.56). Closing it means moving a founder-signed color — light's band 0, or the land off the
midpoint — so it is a call, not a fix.

### 8.4 CI was red every evening, and it was pointing at a product bug (D243, D244)

#102 failed CI at 00:18 UTC on five tests in `GlobalSearch`, `latestViews` and `ProfilePage` — none
of them in the map-palette code that PR touched, and all five green on the laptop that pushed them.
The three runs before it, at 22:42, 23:03 and 23:10 UTC, had passed.

The cause is that the cards' clock words are calendar-based, not elapsed-based. `panelTime`'s
`daysBetween` floors both instants with `setHours(0, 0, 0, 0)`, so a fixture backdated N hours from
a live `Date.now()` falls off "Today" once the runner's clock reads earlier than N:00:

| fixture | reads "Today" until the local hour is |
| --- | --- |
| `NOW - 2 * HOUR` (the `Today` assertions) | 00:00–01:59 |
| `NOW - 5 * HOUR` (`Also from … · 5 h`) | 00:00–04:59 |

Which makes the window **00:00–05:00 UTC** — and 7 PM–midnight Eastern *is* 00:00–05:00 UTC. The
founder's working hours were the broken window, every night, on any branch. It reproduced exactly:
at 03:21 UTC only the five-hour fixture failed; under `TZ=America/Sao_Paulo` at 01:01 local, three
failed on #102's head and none after the fix.

Three things the build found while fixing it:

**The convention already existed, six times.** `lakeModel`, `reportCalendar`,
`PhoneInstrumentStrip`, `panelTime`, `profileModel` and `SignOutGuard` each re-derived "Saturday 16
January 2027 — the boards' today" as a local constant. Only the files that missed it broke. It is
now `apps/web/src/test/boardNow.ts`, and the date has to stay **frozen** rather than "today at
noon": `profileModel` asserts `dayKicker(NOW - 3 * DAY, NOW)` is `'Wednesday'`, which holds only
when today is a Saturday.

**Pinning fixtures is not enough.** `GlobalSearch.tsx:185`, `SkaterMapCanvas.tsx:147` and
`InViewList.tsx:178` each read the clock themselves rather than taking `now` as a prop, so a pinned
fixture disagrees with the component by months. Two bigger hammers were tried and rejected with
numbers: pinning the clock in `setup.ts` for every unit test failed **118** of them (the sheet's
IndexedDB, photo-pipeline and reconnect suites drive real async work that a faked clock starves),
and faking the timers rather than just `Date` cost a debounce flake in `GlobalSearch` that passed in
isolation and failed under full-suite load — the same green-here-red-on-CI shape as §8.2.
`pinBoardClock()` fakes `Date` alone, per file, only where a calendar label is asserted.

**`SkaterMapCanvas` was already faking its timers — without an instant.**
`useFakeTimers({ shouldAdvanceTime: true })` and no `now` leaves `Date.now()` on the runner's real
clock, so that file had the identical latent bug behind a fake that looked like a fix. Pinning is
the instant, not the fake, and the guard refuses to accept the one for the other.

And the flake was pointing at something real (D244): because `ageLabel` demanded the same calendar
day, a report that ended at 11 PM read "Fri" to anyone looking at 12:30 AM — ninety minutes old. It
now counts hours across midnight, with the boundary pinned deliberately in `panelTime.test.ts`
rather than sampled at whatever hour CI runs.

**A pinned fixture is not a pinned test (Greptile, #103).** The first cut of this fix pinned
`ProfilePage`'s fixtures and left the component reading the clock at `ProfilePage.tsx:73`. It went
green — because `dayLabel` treats a future instant as "Today" by design (clock skew), and a 2027
fixture is two months ahead of the present. The assertion was testing the skew branch, not "today",
and would have started failing on **17 January 2027**. Proved by moving the anchor six years into
the past, where the test fails, and again after pinning, where it passes.

Checking for others the same way turned up none: `SignOutGuard` and `latestViews` inject `now` and
hardcode their fixture instants, so they are deterministic already. It did show that four files
mix the shared anchor with hardcoded `2027` literals (`panelTime`'s `at()` helper,
`reportCalendar`, `sheetParts`, `SignOutGuard`'s `openedAtMs`) — correct today, but coupled to the
anchor's year, so moving the anchor would break them confusingly. Left as follow-up.

**What the coverage review added.** Three gaps, found by asking what the existing tests *don't*
discriminate:

1. **Nothing exercised the zone argument.** `recentReportsLabel` and `labelSlug` take a
   `timeZone` so the viewer's zone decides the day, and every test of both sat mid-afternoon,
   where New York and UTC agree on the date — so the argument did no visible work and dropping it
   would not have failed anything. Now one instant (9 PM Saturday in New York, already Sunday in
   UTC) reads `1 report Sat` with the zone and `1 report today` without. Verified by deleting the
   `timeZone` pass-through: both new tests go red.
2. **The 25-hour day.** On the Sunday the clocks go back, two reports a full 24 hours apart share
   a local date. The labels group by date, so both count — `2 reports today` in New York, `1` in
   UTC, from the same two instants. A 24-hour window would have split them silently.
3. **The clock-skew branch, pinned on purpose.** `dayLabel` reads a future instant as "Today",
   which is deliberate for a fast device clock and is also exactly how an unpinned test looks
   pinned — the ProfilePage trap above. Pinned now in `panelTime.test.ts` with that failure named.

And the static guard got a dynamic half: CI re-runs the web unit project in a zone **computed from
the current UTC hour** so local time is always ~01:00, inside the window that broke #102, instead
of hoping a run lands there. 35 s, and verified to catch the original bug: restoring
`latestFixtures`' live clock turns that step red at local 01:46.

**What the dynamic half found nine hours later (2026-11-10).** The step above went green on its own
PR at local 01:57 and then turned main red at `f5d070a0` — on two `accessModel` tests neither #103
nor #102 touched. The cause is a *second* way a clock word goes wrong, and it is not the live clock
this section is about: `ACCESS_NOW` was a fixed UTC instant, and `accessModel` calls `reportWhen`
without a `timeZone`, so the weekday is formatted in the **runner's** zone. `Date.UTC(2027, 0, 16,
16, 52)` is Saturday in Hanover and Sunday 3:52 AM at UTC+11, so `reported Thu` read `reported
Fri`. It predated the anchor; #103 pointed the fixture at `BOARD_NOW_NH` and so carried it
forward. The fix is one line — the local-parts `BOARD_NOON`, per D243's amendment — and it was
verified in six zones from UTC+14 to UTC−11.

The lesson is about the probe, not the fixture. **One zone per run cannot show both classes**, and
which class it shows depends on the hour CI happens to run:

| Zone | Picked when | Live clock (class 1) | Date-line shift (class 2) |
| --- | --- | --- | --- |
| UTC−3 (`Etc/GMT+3`) | CI at 05:00 UTC | caught | **missed** |
| UTC+11 (`Etc/GMT-11`) | CI at 14:00 UTC | caught | caught |

#103 merged at 04:57 UTC and drew UTC−3, which shifts no dates at all; the push to main ran at
14:03 UTC, drew UTC+11, and failed. So the step now runs three zones: the computed 01:00 one for
class 1, and `Etc/GMT-14` / `Etc/GMT+11` — UTC+14 and UTC−11, which bracket every real zone — for
class 2. Both brackets are load-bearing, and each was shown to be: with the bug reintroduced, the
16:52 UTC instant fails only at UTC+14, while the mirror case (a 02:00 UTC Saturday) fails only at
UTC−11. Three runs, about 105 s.

### 8.5 A theme switch crashed the app: readiness is state, the map is a ref

The founder's live test: in light mode, pick **Dark** from the account menu and the app lands on the
crash screen. Pressing either *Try again* or *Reload the page* completes the switch, so the theme
itself was never the problem — the transition was, exactly once.

A theme switch re-creates the MapLibre instance (the basemap style is built per flavor; `useMapCanvas`
has done it that way since A02) and the skater canvas derives `palette` from the same flavor. So one
render changes both, and the paint effect that follows `palette` has its dependencies changed in the
*very commit* where the shell's cleanup removes the old map and the shell's body builds the new one.
That effect gated on `mapRef.current` and `loaded` — and those two disagree in that window:

- `mapRef.current` is mutated *during* the commit, so by the time the effect body runs it is already
  the new map, whose style has not loaded.
- `loaded` is React state, so the body reads the value from the render that scheduled it: `true`,
  about a map that no longer exists.

The guard therefore passed and `setPaintProperty` landed on an unloaded style. MapLibre's
`_checkLoaded` **throws** there — `Style is not done loading.` — rather than no-opping, the throw came
out of a passive effect, and `Sentry.ErrorBoundary` turned it into the crash screen. A retry re-rendered
after `load` had fired, which is why both buttons "worked".

The fix is one accessor, `MapCanvas.liveMap()`: the live map if its style can take a write, else `null`,
with readiness held in a ref the same commit updates so it can never be stale about the map it answers
for. Every imperative effect in all four canvases now gates on it — a style write is never guarded by
state — and the accessor *replaces* `loaded` in their dependency lists rather than joining it: it takes
a fresh identity whenever readiness changes, so listing it alone is what re-runs them (and so re-applies
the whole spec) once the new map is ready. `loaded` keeps only the job it is safe for, the React gate on
what *renders* over the map.

Readiness itself is keyed on the loaded map rather than on a boolean, so a `load` that ever landed in
the same React batch as the teardown's reset cannot settle back on `true` and leave the accessor holding
its old identity — which would hand the new instance no spec, no filters and no sources, silently. Two
instances are never the same object.

The admin lake editor had the same pair one layer out: it handed `useImageryReveal` `mapRef.current` and
`loaded` as props, and that hook adds and removes its own source and layer. There the two disagreed a
commit later rather than sooner — the render that saw `loaded` drop also saw the *new* map in the ref, so
the reveal's teardown ran against the instance the shell had already removed. It takes `liveMap()` now,
which is also what leaves `loaded` with no imperative caller at all.

**Why no test caught it:** `SkaterMapCanvas.test` already had *re-applies everything on a theme switch*,
but its fake map's `setPaintProperty` silently no-opped on an unknown layer, so the one call that
mattered was swallowed. The fake now models `_checkLoaded` — every style write throws before `load` and
after `remove` — and that existing test fails without the fix. `mapCanvas.test` pins the contract
itself: across a flavor change a caller is handed `null`, never the new map before it has loaded.

The general shape, worth remembering past this phase: **a React-state flag is never a safe guard for a
ref that the same commit rewrites.** Where a ref and a flag describe one object, the flag belongs in a
ref beside it.

### 8.6 What §8.5 cost the winter imagery, and two CI reds that were nobody's diff

Greptile's read of §8.5 found the one place where publishing `null` is not the same as publishing a
map nobody may write to. `useFreezeUpFrame` keeps its lanes — a raster source and layer per date —
in refs that deliberately **outlive** the effect that mounted them, because tying a lane's lifetime
to a cleanup is the remove-then-add shape that blanked the map. Its own comment named the contract:
*"a map that is genuinely re-created arrives here as `loaded` going false, which the reconciler
already handles."* It did handle it — by dropping every lane — but the first line of the reconciler
was `if (!map) return`, so once the shell stopped publishing an unloaded instance, a re-created map
arrived as no map at all and that was the single path that *kept* its bookkeeping. The replacement
map then matched the unchanged frame key against a lane recorded on the dead instance, `show()`
found no layer there and returned, and the February photograph was simply gone until the skater
scrubbed to another date. No error.

`drop()` now takes the map optionally and the drop-all branch covers `!map`: with no instance to
take a lane off, forgetting it is the whole job. That is the same correction as §8.5 one level up —
bookkeeping about an instance is only true of that instance.

**The red CI on #104 was not #104's.** Two tests on main fail on a loaded or oddly-zoned runner, and
the second was hidden behind the first (the time-zone step runs three zones in one loop and stops at
the first non-zero exit):

- `GlobalSearch`'s *once per query* asserted an analytics **effect** immediately after a `findBy*`.
  Testing Library's `asyncWrapper` turns the act environment *off* for that wait, so the debounce's
  state update commits outside `act` and React flushes its passive effects in a scheduler task that
  the single `setTimeout(0)` drain after the wait is not guaranteed to outlast. Pure load decides
  it: green alone, red under a full suite, which is why it hit the normal step here and the
  zone-shifted step on main. It waits for the event itself now, then holds it to one across a
  further render of the same term — stronger than what it replaced, not weaker. `pinBoardClock`'s
  comment blamed fake timers for this; corrected, since leaving them real never fixed it.
- `sheetSlotFills` anchored its fixtures to 16:52 **UTC** while `PhotoSorter` groups a pool by each
  photo's **local date** and its line names the result ("on two lakes" against "over two days"). On
  a UTC+9 runner that instant reads 01:52 local, which put the 3-hours-ago photo on the previous day
  and changed the copy. It is `BOARD_NOON` now — the zone-naive constant `boardNow.ts` prescribes
  for exactly this, with half a day of headroom either side.

Both are the same lesson as the one above in a different register: a test that reads a clock, or a
flag, from somewhere other than the thing it is asserting about will be right until something else
decides the timing.

### 8.7 The resend property's red was the model; its neighbors found a second tab

CI's third web run on an unrelated server-only PR failed *only ever sends what the author pressed
Post on* (seed 1236490619, path `21:3:12:16`): pick a photo, the browser drops its blob, pick a second,
a send fails offline, a visitor reloads, the author comes back, the connection returns. The model
said the first photo was lost for good, so the Post must wait; the store had it waiting to send.
The rule is the store's header (§5's resend, built at Review 3): a resend goes out only while the
author still wants exactly what they pressed *Post* on, and a restore that **lost** a photo disarms
it. Nothing was lost. Picking the second photo changed the claim, and the reconcile writes every
claimed photo the tab still holds (`sheetPhotos.reconcile`), so the dropped blob was back before the
reload and the restore found both. The model was too strict; it now clears its lost-blob flag on
that rewrite and checks the restore's own count against it. Zone and hour play no part — the seed
replays the same failure in every zone, and the random seed is the only reason it surfaced on that
run.

Walking the rule through its neighbors — a visitor at the reconnect, another account signing in on
the tab (and while the resend is out), a lapsed session and the author's return, the sign-out,
blobs lost before and after the failed send, an edit since, the tab reopened — found the store
right in each, and one gap: **two tabs**. They share the record, not their memory, so an edit made
in another tab left this tab's resend armed with the old words, and the server's idempotent create
would have kept those and silently dropped the edit; a draft thrown away in the other tab would
still have gone out from this one. A `storage` event now disarms the resend unless the record still
says armed for this draft and this account (another draft of the same author's, started in the
other tab, leaves it alone). It reads what the other tab wrote (the event's new value), not the
store, which a write of this tab's own could have overtaken. A send already out when the change
lands comes back disarmed too: its refusal no longer re-arms the resend, and it leaves the record as
the other tab wrote it unless the create went out, whose lock a reload must find — and so do the
checkpoints the send saves on its way. A reload still reading its photos back when the other tab's
change lands returns the words without the resend. Disarming sends nothing; *Post* stays the
author's to press.

Every property in `sheetStore.properties.test.ts` now runs four pinned seeds (the first is this
one) and one random seed on every build, the same policy as `erasure.test.ts` (B01 §12.8);
`SHEET_PROPERTY_SEED` replays a seed and `SHEET_PROPERTY_RUNS` widens the run, locally. The model
still cannot see a sign-out in one tab reaching the other through Clerk (only the record's change),
two tabs editing the same draft at once (the record is last-writer-wins, as it was), a send already
in flight when the other tab's change lands (named cases in the same file cover it), or a blob store
that fails while a lost photo is being rewritten. The other fast-check suites in the web app pin no
seed (listed in the PR).

**Open, for the founder:** the record is one slot per browser, last writer wins. A draft waiting to
resend in one tab, while the author starts another draft in a second tab, stays armed (a different
draft is not a change to this one); when it goes out, its refusal writes it back over the second
tab's draft, and its Post clears the slot and every stored photo. The same happens today when the
author presses *Post* in the first tab. It costs a draft's stored copy, never sends anything the
author did not press, and predates this fix; the cure is per-draft records or one tab owning the
resend.

### 8.8 A lake's X removed it, and the photo sort put it back

The founder (2026-11-15): the X on a lake's tab didn't remove it, so a tab opened by accident could not
be closed. The X did remove it — `removeLake` takes the Report out and moves its photos to the Post's
pool, unplaced, as the dialog says — and then `PhotoSorter` opened it again. The sort remembered only
the ids the pool held, so a removed Report's photos looked new; it looked their place up and laid them
onto a tab for their lake and day. Every lake whose photos have a place came back, which is every tab
the sort opens on its own. The sort's memory now notes every photo the sheet has shown on a Report
(`photoSort.openSortMemory` / `photosToSort`): a photo is sorted once, when it first reaches the pool,
and a removed lake stays removed across closing the sheet and reloading — unless the author picks a
new photo there, which opens a tab for that photo alone.

The class, checked: a removed lake's photos go back to the Post, where the day's rule may put one on
another lake already on the sheet whose visit holds its time (`removeLake`'s written design, unpinned)
and the rest wait in the pool, which the flush refuses until each is placed or left out — so none
posts as a Report of its own, and the dialog now says exactly this; removing the only lake starts it over on *Which lake?* with its photos kept; a photo's X and
its menu's *Leave out* release the file only once the sheet has taken the removal (a sent Post refuses
it, and the photo kept its record but lost its file). `sheetRemoval.properties.test.ts` drives picks,
removals, reopens and reloads against the real store and blob store, on the shared seed policy now in
`sheetStore.propertyRuns.ts`; with the fix taken out it fails on the founder's sequence.

### 8.9 A track after the lake, and a caret that says its minute

**No track could be added once a lake was chosen** (founder, 2026-11-15). The console B03 replaced drew
*+ Add your track* on the instrument, and board 5.1 draws *Add your GPS track* at the end of the map
key (9.8 in the phone's strip); the re-skin mounted the GPX import only on the *Which lake?* card, which
gives way to the instrument the moment a lake is picked. `AddTrack` puts the same import back on the
instrument and the phone strip for every create Report without a track — a second Report, after a
failed send, after a reload — behind the same `gpx-import` flag. The docs seed a track's lake and
times only where the sheet is blank (`seedFromTrack`) and do not say what a track that disagrees should
do, so the conservative reading: a track on another lake, off every known lake, or from another day
than the author's chosen end is refused with a sentence and not linked (`trackRefusal`); the author's
lake and day stand and nothing is re-sorted. The track stays in their activities (the server ingested
it to resolve its lake). Garmin is not built anywhere — the card and Settings say *Coming soon* (D24) —
so there is no Garmin connection to restore, before the lake or after.

**A dragged caret read "END …" until it settled.** It now shows the minute a release would save, by
core's `caretLabel` — the settled caret's own rule, in the lake's zone — in a fixed box of tabular
figures; each caret is a slider with arrow, page and Home/End steps and an `aria-valuetext`.

---

## 9. The onboarding and the season check (added 2026-11-24)

> **Status:** built 2026-11-24, all three stages integrated on `phase-b03-onboarding`; the PR waits on
> review. An addition to this phase, not a new one (founder, 2026-11-24): one PR, carrying the
> already-committed 18+ change (D294) and this build. Where the build departed from the plan, the plan
> below is corrected in place; §9.17 records what the build found. Decisions: D295 (the terms acceptance, retiring the risk acknowledgment), D296 (Know Before
> You Go and its season rule), D297 (the consent record and its six years), D298 (the onboarding's order,
> defaults and reach). Mocks: the *Onboarding* page in *Gli · Web app · Review 3* (rows 10 and
> 11, 26 boards), from `skating-mockups/skater-web/sys-welcome.html` (every word of copy is there; `RULES`
> and `TERMS` are the quiz and the terms as drawn) and `boards-onb.tsv`; the founder's calls are the
> README's *Onboarding*, *First review* and *Second review*.

A new skater's way in is five steps — **Account → Terms → Know Before You Go → Home → Profile** — on the
web and in the Android/iOS app. Every existing account passes through the terms and the questions at its
next sign-in, and every skater answers the questions again at their first sign-in after the Ice Watch
(the A06i season watch) opens a new season. The one-checkbox risk acknowledgment (D45, `riskAckVersion`,
`/reack`) retires in favor of the terms acceptance. What the skater accepted, and when, is kept in a
sealed record that outlives a deleted account by six years.

The founder's calls this plan builds on (2026-11-22 to 2026-11-24, not re-opened here): the order, with no
Garmin step; 18+ (D294, built); terms read to the end before the box unlocks, the line *"I have read and
agree to the Terms of Use and the Privacy Notice."*, the Privacy Notice a link and never scroll-gated, an
*Open in full-screen* reader on a desk whose end counts, *Record acceptance*, server-stamped moments that
are never shown on screen, then *Acceptance recorded* with the emailed copy; the quiz named **Know Before
You Go** (never "ground rules": "you know this, we're just making sure"), seven questions one at a time,
two first-person answers each, a miss explains and waits for the right pick, wrong picks never stored, the
questions in one versioned source the founder edits each summer; the season rule with its 30-day early
window; Public profile and Show my town on by default, everything in Profile optional; the six-year
retention (Maine's limitation period, the longest in the coverage area); existing accounts through terms
and questions; mobile built now on its existing tokens. The standing skater-UI rules hold: relaxed, human
copy; US spellings and the Oxford comma; no decision numbers, `§` or phase tokens on a screen; every
server refusal a toast (D268), a client-side field problem the amber inline message as drawn; PostHog
gets the Clerk user id only, counts and never content.

### 9.1 What the interrogation found in the code

1. **Today's gate.** `packages/core/src/authRoute.ts` (`resolveAuthRoute`, five states, shared by
   `apps/web/src/components/AuthGate.tsx` and `apps/mobile/app/_layout.tsx`) routes on `profiles.current`
   alone: no row → `onboarding`; `needsProfileSetup` (a canceled deletion's emptied row) → `onboarding`;
   `isCurrentRiskAckVersion(riskAckVersion)` → `app`, else `reack`. The web maps states to paths in
   `lib/authZone.ts` and remembers the zone in a boot cookie (`lib/boot.ts`, `BOOT_ZONES` names `reack`);
   mobile swaps `Stack.Protected` groups. The server never gates a write on the acknowledgment —
   `requireProfile` checks only status, suspension and lock (`lib/auth.ts`) — so a stale ack is
   client-routed today, and stale terms and questions can be too.
2. **Where a profile is born.** Only `profiles.upsertFromClerk` creates a row (it requires the current
   `RISK_ACK_VERSION`, the 18+ gate, a valid name and a free username, and server-stamps `riskAckAt`).
   It also re-onboards a canceled deletion in place (same row, `assertMayRename` applies) and silently
   returns an inactive or ghost row unchanged. `acceptCurrentRiskAck` is `/reack`'s mutation. Tests insert
   `profiles` rows directly 247 times in 181 files, none of them through either mutation, and no test or
   server read depends on `riskAckVersion` beyond the two mutations, the tombstone's scrub and the inbox
   seed (`inboxSeed.ts` stamps it). `checkUsername` and the create defaults are private to `profiles.ts`.
3. **The pieces that exist to reuse.** `profiles.usernameAvailable` already answers before a row exists
   (identity only). `geocode.suggest` (Geoapify, identity only) feeds the web's `AddressField` +
   `geocoder.ts` lookup; its suggestion carries `label`, `lat` and `lng` only — **no town**, which the
   Profile step's "Taken from your home address" needs. `profiles.setHome`, `profiles.updateProfile`
   (bio, `homeTownLabel`, visibility) and the web's `ProfilePhoto` (Clerk avatar) cover Home and Profile.
   **There is no "Show my town" setting**: a public profile shows `homeTownLabel` whenever it is set
   (Settings' own copy says so). Mobile has no typed-address field (its You tab sets home from the
   phone's location only), no avatar upload, and no toast.
4. **Mail.** `lib/resend.ts`'s `sendEmailOutcome` reports `accepted | rejected | unknown` and never throws;
   `lib/emailBlocks.ts` renders typed blocks (`**bold**` inline) to HTML and text from one source. The
   module header still says *"All Resend env vars ship unset … on dev this logs and returns"* — stale:
   `05-accounts-and-credentials.md` has `RESEND_API_KEY` and `RESEND_FROM_EMAIL` set on dev since
   2026-09-11, and the founder receives the season emails through it. Stage one corrects the comment.
5. **IP.** Convex gives a mutation no caller IP. Clerk's Backend API does: a session's
   `latest_activity.ip_address` (`SessionActivityJSON` in `@clerk/backend`), on `GET /v1/sessions/{id}` and
   `GET /v1/sessions?user_id=…&status=active`. **The session id is not in our token**: the apps reach Convex
   through `ConvexProviderWithClerk`, which asks for the JWT template `convex` unless the instance runs
   Clerk's Convex integration (`auth.config.ts` names `applicationID: 'convex'`, the template), and Clerk's
   docs say session-bound claims (`sid`) cannot be put in a custom JWT. Both Clerk SDKs expose `sessionId`
   on `useAuth()`, so the client can name its session and the server can check it belongs to the caller.
   `clerkAdmin.ts` is the server-to-server pattern (`CLERK_SECRET_KEY`, timeout, no-op without the key);
   the key is set on dev (the register).
6. **The Ice Watch's opening.** `imageryIngestSeasons` holds one row per season (`season: 'winter-YYYY-YY'`,
   `by_season`), written once by `imageryIngest.recordSeasonOpen`. Two times sit on it: `opensOn`, the
   *observed* date the gate opened (a date string, read back from the weather series, so often days
   before anyone knew), and `detectedAt`, the instant the system recorded the opening. An admin's
   `seasonWatch.resetSeason` moves the row whole to `imageryIngestSeasonsSuperseded` and deletes it — a
   reset is how a too-early opening is *postponed*, so until the next tick re-opens it the season is not
   open. The row exists only once a season has opened; before that the newest row is last winter's.
7. **Deletion and export.** `requestDeletion` scrubs the identity at once (email included);
   `finalizeAccount` runs `lock → redact → erase → tracks → photos → tombstone`, each a transaction, and the
   tombstone clears `riskAckVersion`/`riskAckAt`. `dataExport.collect` deliberately leaves out the email and
   the Clerk subject. Purges elsewhere run as hourly or daily crons over an index.
8. **Analytics.** Web only (the phone sends none, `PRIVACY.md`). `lib/analytics.ts` has
   `onboarding_completed` ("a profile row was provisioned"). Autocapture is on with skater text masked
   (D240), but a click's on-screen label is what autocapture records — a month picked in the date of birth
   or a quiz answer clicked would otherwise reach PostHog.
9. **Two things the mock says that the rules have to reconcile.** The mock's `TERMS` is a shortened
   rewrite of `TERMS.md`: it drops *keep your login secure*, *don't post what you don't have the right to
   share or interfere with the app*, the license's *according to the visibility settings you choose*,
   *you're responsible for what you post (including photos)*, *the operator may remove content or suspend
   or ban accounts*, the named third-party services, the Code of Conduct and the contact address — some of
   that is substance, not wording (a founder call, §9.15). And board 10.13 shows *"Last answered Nov 16,
   2026"*: a stored completion's day, on screen. The no-times rule is about the terms' stamps; this plan
   draws 10.13 as the founder reviewed it (day only).

### 9.2 The governor's rulings, checked against the code

- **R1 — confirmed.** The profile is born at *Record acceptance*; the Account step validates with
  `usernameAvailable` and core's `meetsMinimumAge` and writes nothing; the fields ride in client memory to
  the Terms step. The invariant holds as "a profile exists ⇒ some acceptance was recorded" — every row
  today carries a risk acknowledgment (`upsertFromClerk` requires one) — so `requireProfile` and the
  fixtures need no sweep. Two cases the ruling has to name: a canceled deletion's row already exists and
  is re-introduced in place (as `upsertFromClerk` does now), and a username free at Account can be taken
  by Terms (the acceptance refuses, the skater is sent back to Account with a toast).
- **R2 — confirmed, with three additions.** (a) A **pending deletion** goes to `app` before any consent
  check: it is read-only and its cancel button lives in Settings; forcing a departing skater through the
  questions to reach it would be absurd. (b) The routing rule needs the watch's opening as a second input,
  read by a small query beside `profiles.current`. (c) A **receipt hold**: *Record acceptance* flips the
  route at once (the profile reactively gains its terms), which would redirect past board 10.5. Both
  gates honor a client hold set on a successful acceptance and cleared by the receipt's button. Built as
  a new `resolveEntryRoute` beside the old function in stage one, so nothing moves until the apps switch.
- **R3 — confirmed, with additions.** The pre-acceptance stamps live in their own table
  (`termsReadings`), so the record is written once and whole. Severing at finalize clears the Clerk
  subject as well as the profile pointer. The record is indexed by the snapshot's email so a deleted
  person's record can still be found when it is needed (internal, CLI only). A guard holds the "sealed"
  part (§9.12).
- **R4 — changed in mechanism.** The JWT carries no `sid` (item 5). The capture: the client sends its
  Clerk `sessionId` with the write; a scheduled internal action reads `GET /v1/sessions/{id}`, uses it
  only if its `user_id` is the caller's subject, else falls back to the caller's most recently active
  session (`GET /v1/sessions?user_id=…&status=active`); a `sid` claim, if the instance ever moves to the
  Convex integration, is preferred over both. *As built:* only a named session that exists and is
  someone else's falls back; a Clerk error on the named session records `error` and does not, so a
  failed lookup is never papered over with a different session's address. The IP stored is the session's *latest activity* IP read
  within seconds of the write — evidence of where the session was, not the HTTP request's own address —
  and the record says which match was used. No key, no session, no activity, or any error: the record
  says `unavailable` with the reason; the acceptance never waits on it and never fails for it.
- **R5 — confirmed, with a fork on the text.** Terms and questions live in core as versioned data with a
  committed SHA-256 each — *as built,* in an append-only ledger keyed by version (`TERMS_HASHES`,
  `KNOW_BEFORE_YOU_GO_HASHES`, `legal/hashLedger.ts`), so every version ever published keeps its hash
  and a version missing from its ledger matches nothing a client can send (a core test recomputes the
  current one, so an edit without a version bump fails with instructions); `TERMS.md`'s body is exactly core's rendering (a `packages/guards` test). The Privacy
  Notice's version and hash are also committed in core and held to `PRIVACY.md` by the same guard, so the
  record can say which notice the line agreed to. Which text the terms are is the founder's (item 9).
- **R6 — confirmed.** Stage one adds and changes no route; stage two switches both apps; stage three
  deletes the old paths and narrows nothing. One consequence to say out loud: after the merge deploys, an
  Android build from before it cannot onboard a new account (its mutation is gone), so the owed device
  pass installs the new preview build first.
- **R7 — confirmed, made precise.** The anchor is `detectedAt` on the live `imageryIngestSeasons` row with
  the greatest `season` — the instant the system knew, which is what "the first sign-in after the watch
  opens" can honestly mean (`opensOn` is a backdated observation). Superseded rows never anchor: a reset
  postpones the opening, and a completion counts if it falls on or after the re-detected opening minus
  30 days. The rule is pure, takes every instant as an argument, and its tests pin their clocks
  (D243): no `Date.now()` in a fixture or story.
- **R8 — confirmed.** The copy is sent by a scheduled action after the commit, with the record id as
  Resend's idempotency key, and its outcome lands on the record. Board 10.5's line shows while the send is
  pending, accepted or `unknown` (it may have gone); it changes only when the send is known not to have
  happened (`rejected`, or no address at all).

### 9.3 The state machine

`resolveEntryRoute({ isLoaded, isSignedIn, profile, watch })` in `packages/core/src/entryRoute.ts` (*as built,* also
`hold`, `now`, the instant a suspension is judged at, and `cannotActAt`, when the server last refused this account as
unable to act), first match wins:

| # | Condition | Route | Web path | Mobile group |
|---|---|---|---|---|
| 1 | Clerk not loaded, or signed in and `profile` or (past row 5) `watch` still `undefined` | `loading` | hold | `null` |
| 2 | signed out | `auth` | `/sign-in`, `/sign-up`, `/about` | `(auth)` |
| — | `hold === 'receipt'` (*as built:* the hold is an input to the rule) | `receipt` | the page the skater is on | the group the acceptance was on |
| 3 | `profile === null` | `account` | `/onboarding` | `onboarding` |
| 4 | `profile.deletionRequestedAt` set, or *(as built)* the account can't act — banned, finalizing, deleted, or suspended (core's `canActNow`, the rule `requireProfile` applies, judged `SUSPENSION_CLOCK_MARGIN_MS` back from `now`: `entryCanAct`), or the server refused it as unable to act less than that margin ago (`cannotActAt`) | `app` | as today | `(tabs)` |
| 5 | `needsProfileSetup(profile)` | `account` | `/onboarding` | `onboarding` |
| 6 | `profile.termsVersion !== TERMS.version` | `terms` | `/terms` | `terms` |
| 7 | `knowBeforeYouGoDue(profile.knowBeforeYouGoAt, watch) !== null` | `questions` | `/know-before-you-go` | `know-before-you-go` |
| 8 | `profile.welcomeStep` set | `welcome` | `/welcome?step=` | `welcome` |
| 9 | otherwise | `app` | as today | `(tabs)` |

`knowBeforeYouGoDue(lastAt, watch)` (`packages/core/src/knowBeforeYouGoSeason.ts`) answers `'never'` when
`lastAt` is undefined, `null` when `watch` is `null` (no season has opened: only the never-answered are
asked), `null` when `lastAt ≥ watch.openedAt − KNOW_BEFORE_YOU_GO_EARLY_MS` (30 × 24 h, elapsed), and
`'season'` otherwise. Its answer is the screen's flavor: `'never'` opens straight on the first question
(after a receipt, if one is held); `'season'` opens on board 10.13 — except straight from the receipt's
*Start the questions*, which opens on the first question on both apps (the governor's ruling: the
receipt has just said what comes next, and the card would say it again). The step counter (*N of 5*) shows only
when the account is new this session (the Account step was seen); a returning account's terms and questions
carry no counter.

The receipt hold: on a successful acceptance the client sets `entryHold = 'receipt'` (*as built,* both apps
set it **before** the mutation is sent and release it on a refusal: Convex shows the new profile no later
than it resolves the call, so a hold set on the answer can lose the race to the redirect); while it is
set `resolveEntryRoute` answers `receipt` and both gates stay on the screen the skater is on; *Start the questions* (questions due) or *Continue* (none due)
clears it and the route takes over. A sign-out clears it. The questions need no hold: the last answer shows
board 10.9 locally, and the completion is written by its *Continue*.

Who sees what:

| Who | Steps |
|---|---|
| New account | Account → Terms → receipt → 7 questions → All seven → Home → Profile → app |
| Canceled deletion (row emptied) | Account → Terms → receipt → questions only if this season's are not answered → Home → Profile |
| Existing account, first sign-in after merge | Terms → receipt → 7 questions → All seven → app (never Home or Profile) |
| Terms version bumped | Terms → receipt → app, or the questions if they are also due |
| First sign-in after the watch opens | 10.13 → 7 questions → All seven → app |
| Pending deletion | app (read-only, as today) |
| Banned, finalizing, or suspended now (*as built*) | app (read-only, with the support screen to appeal from); when a suspension lapses the gate wakes and the rows past 4 apply again |

*As built,* `now` is the device's clock and the server's is the one that counts. A device running ahead would send a
still-suspended account to the terms early, where the acceptance is refused on every press. So a suspension still holds
`SUSPENSION_CLOCK_MARGIN_MS` (five minutes) past `suspendedUntil` by the device's clock, and a clock further ahead is
caught by the server itself: the profile gate's two refusals ("Account is suspended", "Account is not active" — core's
`ACCOUNT_SUSPENDED_MESSAGE`/`ACCOUNT_NOT_ACTIVE_MESSAGE`, which `lib/auth.ts` throws, read back by `isCannotActRefusal`)
heard on any way-in step set the client's `cannotActAt` (the web's entry store, the phone's entry session), and row 4
sends the skater to the app for the same margin after it, then the steps apply again. `entryRouteRecheckIn` wakes both
gates for either end, and each gate re-arms its timer on every wake, so a timer that fires a hair early sets another.

### 9.4 The data model

All widen-only; nothing narrows (the old `riskAckVersion`/`riskAckAt` stay, optional, on every row that has
them). Every new table gets its row in `plans/06-data-model.md` in the same commit (`dataModelRegister`).

**`profiles`, five optional fields** — the routing denormalization, written only by `consent.ts`:
`termsVersion` and `termsAcceptedAt` (the latest acceptance), `knowBeforeYouGoAt` and
`knowBeforeYouGoVersion` (the latest completion), and `welcomeStep: 'home' | 'profile'` (set only when an
acceptance creates or re-introduces an account; cleared by the Profile step). None is indexed. The
tombstone clears all five.

**`termsReadings`** — the reading stamps before an acceptance, keyed by the Clerk subject because no row
may exist yet: `clerkUserId`, `termsVersion`, `openedAt`, `reachedEndAt?`, `reachedEndVia?: 'inline' |
'fullscreen'`, `surface: 'web' | 'android' | 'ios'` (client-reported). Indexes `by_clerk_version
[clerkUserId, termsVersion]` and `by_opened [openedAt]`. Deleted by the acceptance that consumes it, by the
finalize `erase` stage, and by a daily prune of rows opened more than 30 days ago.

**`consentRecords`** — sealed, append-only:

| Field | What |
|---|---|
| `kind` | `'terms' \| 'questions'` |
| `profileId?`, `clerkUserId?` | the pointers; both cleared at finalize |
| `identity` | `{ fullName, email?, dateOfBirth }` as attested: the Account step's values for a new or re-introduced account, the profile's for a returning one; `email` from the token, else the profile's mirror, else filled once by the send action's Clerk lookup |
| `version`, `contentHash` | what was accepted or answered (core's committed version and SHA-256) |
| `privacyVersion?`, `privacyHash?` | terms only: the notice the line agreed to |
| `context` | `'first_run' \| 'reintroduced' \| 'returning' \| 'version_change'` for terms; `'first_run' \| 'season'` for questions |
| `openedAt`, `reachedEndAt`, `reachedEndVia` | terms only, copied from the reading row (server stamps of what the client reported) |
| `recordedAt` | server `now`: the acceptance, or the completion |
| `season?` | questions only: the newest opened season at `recordedAt`, or `null` before any; which seasons a completion satisfies is always derivable from the times and the watch history, so nothing else is claimed |
| `surface`, `userAgent?` | client-reported, labeled so (`{ value, source: 'client_reported' }`, capped at 512 characters) |
| `ip?` | `{ address, source: 'clerk_session_activity', match: 'token_sid' \| 'client_session' \| 'most_recent_session', fetchedAt }` |
| `ipStatus` | `'pending' \| 'captured' \| 'unavailable'`, with `ipUnavailable?: 'no_key' \| 'no_session' \| 'no_activity' \| 'error'` |
| `copyEmail?` | terms only: `{ status: 'pending' \| 'accepted' \| 'rejected' \| 'unknown', at? }` |
| `severedAt?`, `purgeAt?` | set together at finalize; `purgeAt` = the finalize instant plus six calendar years, UTC (29 February lands on 1 March) |

Indexes `by_profile [profileId, kind, recordedAt]`, `by_email [identity.email]`, `by_purge [purgeAt]`.
Every range on `by_purge` starts `gte('purgeAt', 1)`: the field is optional and `undefined` sorts first, so
a bare `lte(now)` would match every live record. Wrong picks have no field anywhere.

Writes after the insert are fill-once and named: `ipStatus`/`ip`/`ipUnavailable` once, `copyEmail` once
(from `pending`), `identity.email` once if absent, and the finalize sever. Nothing else patches a record;
the purge is the only delete.

### 9.5 Server functions (`packages/convex/convex/consent.ts`)

Every refusal is a `ConvexError({ code, message })`; the message is skater copy (the founder's copy pass
owns the words), and the clients show it as a toast.

| Function | Gate | Contract | Refusals |
|---|---|---|---|
| `watchAnchor` (query) | none | `{ season, label, openedAt } \| null` from the newest `imageryIngestSeasons` row (`label` "Winter 2027–28") | — |
| `openTerms` (mutation) | identity; *as built,* a banned, finalizing or deleted profile is refused (a reading written after `erase` would outlive the deletion) | `{ termsVersion, termsHash, surface }`; upserts the reading row, keeping the first `openedAt` | `client_outdated`, "Account is not active" |
| `reachTermsEnd` (mutation) | as `openTerms` | `{ termsVersion, termsHash, via }`; sets `reachedEndAt` once | `client_outdated`, `terms_not_opened`, "Account is not active" |
| `acceptTerms` (mutation) | identity | `{ termsVersion, termsHash, privacyVersion, privacyHash, surface, userAgent?, clientSessionId?, account?: { displayName, username, dateOfBirth } }` → `{ recordId, repeat }` (*as built,* `repeat: true` only when the call recorded nothing). No row: `account` required, the 18+ gate, name and username rules, then the row is created with the new-profile defaults (`lib/profileIdentity`, which `upsertFromClerk` used until stage three deleted it) and the Clerk mirrors, plus the terms fields and `welcomeStep: 'home'`. A canceled deletion's row: `account` required, patched in place (rename cooldown applies), **its visibility kept** (private after the request; a minor forced private), `welcomeStep: 'home'`. Any other row: `account` must be absent; *as built,* one that has already accepted this version gets its newest acceptance back and nothing is written (no record, no email, no Clerk lookup — before the reading is asked for, so a retry after a lost answer gets the same answer). Then the record, the reading deleted, the profile's terms fields, `refreshPersonRow`, and two scheduled actions. | `client_outdated` (version or hash, either document: this build's bundled words aren't the server's), `terms_not_read` (no reading with `reachedEndAt`), `account_required`, `account_unexpected`, `underage`, `name_invalid`, `username_invalid`, `username_taken`, `username_cooldown`, the inactive and suspended refusals of `requireProfile`, `deletion_pending` |
| `completeKnowBeforeYouGo` (mutation) | `requireContributor` | `{ version, hash, termsVersion, termsHash, surface, userAgent, clientSessionId? }` (*as built,* the client's bundled terms too) → `{ season, repeat }`; the record, the profile's two fields, the IP action. *As built:* any **published** version of the questions is taken (core's `isPublishedKnowBeforeYouGo`, over the ledger), and the record and `knowBeforeYouGoVersion` name the version answered — an older phone keeps working after the yearly edit. When the questions aren't due (`knowBeforeYouGoDue`, the gate's own season rule, read here) the call returns the newest completion's season with `repeat: true` and writes nothing; that replaced the 60-second repeat rule and covers it. | `account_required` (*as built:* a canceled deletion's emptied row, which must be re-introduced first), `terms_first` (*as built,* only when the client's terms claim is the server's: its gate routes by that version and will take it to the terms), `client_outdated` (a version or hash nobody published, or — when the profile hasn't accepted the server's terms — a terms claim that isn't the server's: an old build that routed itself here by its own old version, which the terms screen can't help), the contributor refusals |
| `advanceWelcome` (mutation) | `requireContributor` | `{ from: 'home' \| 'profile' }`; home → profile → cleared; a `from` that isn't the current step is a no-op | contributor refusals |
| `latestTermsReceipt` (query) | profile | `{ email, copy: 'pending' \| 'sent' \| 'not_sent' }` for board 10.5 (`accepted`/`unknown` read `sent`; `rejected` or no address read `not_sent`) | — |
| `captureIp` (internal action) | — | the R4 lookup through `lib/clerkSessions.ts`, then `setIp` (internal mutation, fill-once). Never throws. | — |
| `sendTermsCopy` (internal action) | — | renders core's terms through `lib/emailBlocks` (version line, no times), `sendEmailOutcome` with `idempotencyKey: recordId`, then `setCopyOutcome` (fill-once). | — |
| `pruneReadings`, `purgeDue` (internal mutations, daily crons) | — | each deletes at most 256 rows through its index and re-schedules itself when the page was full; *as built,* `purgeDue` also requires `severedAt` on each row and re-schedules only after a full page that deleted something (a page it skipped whole would re-read itself forever) | — |
| `recordsFor`, `recordsByEmail` (internal queries) | CLI only | the evidence lookup, newest first; past the cap of 200 it is the newest that come back (each range read from its newest end); nothing on any screen reads them | — |

Shared pieces move out of `profiles.ts` in stage one so both writers use one rule: `checkUsername`,
`USERNAME_MESSAGES`, `assertMayRename` and the new-profile defaults go to `lib/profileIdentity.ts`.
`accountDeletion.ts` gains a `consent` stage between `photos` and `tombstone` (it needs the profile id the
tombstone keeps but the index must still find), severing each record and setting `purgeAt`, and `erase`
deletes the subject's reading rows. `dataExport.collect` adds `consentRecords` without `identity.email`,
`clerkUserId` or `profileId`, by the bundle's existing rule. `lib/geocoder.ts`'s Geoapify parse adds an
optional `town` ("Hanover, NH": the result's city, else town or village, then `state_code`); the clients
offer it as the Profile step's Town.

### 9.6 Web: routes and boards

Desk at 1440 is rows 10; below `md` the phone layout is rows 11 (390 wide). All four routes render on
`SystemStage` over the region, outside the skater shell, with the *Signed in as … · Sign out* foot except
10.13 (its second button is the way out).

| Board (10.x desk · 11.x phone) | Route and state |
|---|---|
| 10.1 / 11.1 Account | `/onboarding` (`?step=account`, the zod `.catch` default): full name, `@`username (live `usernameAvailable`), date of birth as a month `Select` by name, day and year typed; *Continue* |
| 10.2 Account · Under 18 | same; amber inline under the date of birth ("You must be at least 18 to use Gli."), *Continue* off — a client-side field problem |
| 10.3 / 11.2 Terms · Locked | `/onboarding?step=terms` (a new account; with no carried fields it falls back to `account`) or `/terms` (an existing one); the reader at its top, the box locked, `openTerms` on first render |
| 11.3 Terms · Reading (phone only) | the page is the reader; the hairline under the bar fills with the scroll |
| 10.4 / 11.4 Terms · Read to the End | the end marker has been on screen: `reachTermsEnd`, the meta line gains "· Read to the end", the box unlocks |
| *(not drawn)* Open in full-screen | the kit `Dialog` at full size over the step, the same text and end marker; reaching its end calls `reachTermsEnd({ via: 'fullscreen' })`; Esc returns with the box unlocked |
| 10.5 / 11.5 Terms · Recorded | the same path under the receipt hold: "Acceptance recorded", the sent-to line from `latestTermsReceipt`, the *Next: Know Before You Go* block only if the questions are due, then *Start the questions* (else *Continue*, no block — not drawn) |
| 10.6 / 11.6 Question | `/know-before-you-go`: seven cells, the question, two picks in the data's order, keys 1 and 2 on a desk, the feedback line's room kept |
| 10.7 / 11.7 Correct | the pick outlined, "Correct." and the why; *Next question* (*Finish* on the seventh) |
| 10.8 / 11.8 Not Quite | the miss amber with a cross, "Not quite." + why + "Pick the correct answer to continue."; the button stays off until the right pick |
| 10.9 / 11.9 All Seven | local after the seventh; the seven `say` lines; *Continue* calls `completeKnowBeforeYouGo` |
| 10.13 / 11.13 New Season | `/know-before-you-go` when the flavor is `season`: the season label, "Welcome back, <first name>", the two rows (terms "Unchanged since" the version's date; the questions' last-answered day in the skater's zone), *Start the questions*, *Not now — sign out* |
| 10.10 / 11.10 Home · Typing | `/welcome?step=home`: `AddressField` with the geocoder's list open; "or" and *Use my current location* step aside while it is |
| 10.11 / 11.11 Home | the picked address; "or"; *Use my current location*; *Save and continue* (`setHome`, then `advanceWelcome`) and *Skip for now* (`advanceWelcome` alone) |
| 10.12 / 11.12 Profile | `/welcome?step=profile`: `ProfilePhoto`, Bio, Town (prefilled from the picked suggestion's `town`), Public profile showing the row's own visibility (on for a new account, off for a re-introduced one), Show my town on; *Open the map* saves what changed with `updateProfile` then `advanceWelcome`; *Skip* only advances |

**Show my town** stores nothing of its own: on, the Town field is saved as `homeTownLabel`; off, it isn't
(a founder confirmation, §9.15). Public profile shows the row's visibility and writes `profileVisibility`
only when the skater changes it (the governor's ruling: a re-introduced account stays private, D298).
`authZone.ts` maps the new routes; `boot.ts`'s zones become the new names (an old cookie's `reack` or
`onboarding` is ignored, as unknown values already are); `/reack` and `/onboarding`'s old form are deleted
in stage three; `skaterSearch.ts`'s comment follows.

Refusals from `acceptTerms` and `completeKnowBeforeYouGo` are toasts (the skater toaster); every refusal of
the Account fields (`underage`, `name_invalid`, `username_invalid`, `username_taken`, `username_cooldown`,
and `account_required`: core's `isAccountRefusal`, read by both apps) also returns a new account to the
Account step with its fields as typed — `username_taken` with the field marked — `terms_not_opened` starts the reading
again at its top, `terms_not_read` re-arms the end marker. *As built,* what each code does beyond its toast is one table in
core (`CONSENT_REFUSAL_ACTIONS`: `account`, `reopen`, `rearm`, `outdated`, `say`), and each app's handling is a `switch` over
it with a `never` default, so a new code is a type error until both apps answer it. `client_outdated` — the tab's or the
build's bundled terms, Privacy Notice or questions aren't the server's — can't be fixed by reading the same text again, so
it stops the step on a blocking screen (*Time for an update*: the web offers *Reload the page*, the phone says to update
the app) and nothing re-arms after it; its words never say the terms changed (a notice-only change is one). A failed end
stamp is said once and tried again only after the marker has left the screen and come back, on both apps. *As built,* a
reading the server doesn't have — the open failed, or `terms_not_opened` — is said, opened anew from the top of whichever
reader is open (the web's full-screen reader scrolls to its top too), and its end counts only once the marker has left the
screen and been reached again, on both apps: never re-stamped in the same breath as the new opening (the record would say
the terms were opened and finished in one instant), never a loop against a server that keeps refusing. `terms_first` is
`say`: the gate takes the skater to the terms once its profile catches up. The profile gate's can't-act refusals on any
way-in step also set `cannotActAt` (§9.3). The web counts `terms_accepted`, `onboarding_completed` and
`know_before_you_go_completed` only when the call says it recorded something (`repeat: false`). On the Home step, *Save and
continue* and *Skip for now* never wait on a location read (`currentPosition` gives up after 30 seconds, and either press
drops a fix that lands later), and a skip or a location save takes the picked address off the field with its town.

### 9.7 Mobile: the same screens on the existing tokens

Expo Router screens, `Stack.Protected` per route in `app/_layout.tsx`, the receipt hold in the root
navigator's state. Built on Tamagui and `ThemedInputs` as an approximation of rows 11; the re-skin waits.

| Route | Screen | Notes |
|---|---|---|
| `account` | `app/onboarding.tsx` (rewritten): Account then Terms as internal steps | the month by name — *as built,* a modal list (`MonthPicker`), not a Tamagui `Select`; the terms read on the page (`onScroll` against content height) with the hairline; ack and *Record acceptance* in the foot |
| `terms` | `app/terms.tsx` | the Terms step alone, for an existing account |
| `questions` | `app/know-before-you-go.tsx` | 10.13's card for the season flavor; picks as full-width pressables; no number keys |
| `welcome` | `app/welcome.tsx` | Home: a new typed-address field over `geocode.suggest` (with the provider's attribution) and the existing location path; Profile: Bio, Town, the two switches; **no photo row** (no avatar upload exists on mobile, deferred) |

The phone shows refusals in a small toast (`src/components/Toast.tsx`, new, mobile-owned). The Privacy
Notice link opens `links.ts`'s URL. No product analytics on mobile (`PRIVACY.md`).

### 9.8 What is reused, and what is new

- **Web kit and compositions:** `SystemStage`/`SystemCard`/`FormLine`, `AuthField`, kit `Input`,
  `InputGroup`, `Select`, `CheckboxRow`, `Switch`/`SwitchRow`, `Button`, `Dialog`, `Kbd`, the meter's cell
  ramp (the seven cells), `toast`; Settings' `AddressField`, `geocoder.ts` and `ProfilePhoto`; `useSignOut`.
  New compositions in `components/skater/onboarding/`: `TermsReader` (scroll window, rail, end detection
  by `IntersectionObserver` on the end marker), `AgreeLine`, `QuestionCard`, `SeasonCard`, `DobField`.
  Kit candidates go through §1.0's promotion rule.
- **Core:** `meetsMinimumAge`, `parseDateOfBirth`/`dob.ts`, the username and name rules, `needsProfileSetup`.
- **Convex:** `usernameAvailable`, `geocode.suggest`, `setHome`, `updateProfile`, `lib/clerkEmail`,
  `lib/emailBlocks`, `sendEmailOutcome`, the `clerkAdmin.ts` request pattern.

### 9.9 Where the words live

- **Legal text and the questions are core data, edited in one place.** `packages/core/src/legal/terms.ts`
  (`TERMS = { version, sections: [{ heading, blocks: [{ kind: 'p' | 'li', text }] }] }`, inline `**bold**`
  only — the email renderer's markup), `TERMS_SHA256`, `renderTermsMarkdown`; `legal/privacyNotice.ts`
  (`PRIVACY_NOTICE_VERSION` = `PRIVACY.md`'s *Last updated*, `PRIVACY_NOTICE_SHA256`);
  `knowBeforeYouGo.ts` (`KNOW_BEFORE_YOU_GO = { version, questions: [{ id, prompt, right, wrong, why, say,
  rightFirst }] }`, `KNOW_BEFORE_YOU_GO_SHA256`). The answer order is the data's `rightFirst` per question,
  fixed and editable — the mock's `flip` — so boards, tests and keys stay stable. Its header tells the
  founder how to edit: change the words, bump `version`, update the hash the failing test prints. A version
  bump never re-asks anyone mid-season; the next season's asking picks it up.
- **The screens' words** (headings, ledes, buttons, the receipt's lines, the refusal messages' client
  fallbacks) live in `packages/core/src/onboardingCopy.ts`, so the two apps say the same thing (the
  `hazardCopy.ts` precedent). The name is **Know Before You Go** in title case everywhere it is a name.
- The founder's copy pass owns every string; two lines are not drawn and are this plan's drafts: the
  receipt when no copy went ("We couldn't email you a copy. You can read the terms any time in Settings,
  under About.") and the receipt's *Continue* when no questions are due. *As built,* the apps needed more
  undrawn lines, all drafts and all in core so the two apps say the same thing (the governor's ruling):
  the taken handle, the full-screen reader's way back, the Home step's location and address states, the
  two not-saved toasts, the typed-address field's own words (`ADDRESS_FIELD_COPY`, shared with the web's
  Settings), the refusal toasts, and the delete screens' sentence (`CONSENT_RECORD_RETENTION`). Only a
  platform's own words stay in its app: the phone's month picker ("Pick a month", "Cancel") and its
  user-agent format.

### 9.10 Observability

PostHog (web only), typed in `lib/analytics.ts`, countable shape only:

| Event | Properties | When |
|---|---|---|
| `onboarding_completed` | — | unchanged meaning: an acceptance created a profile row |
| `terms_read_to_end` | `via: 'inline' \| 'fullscreen'` | `reachTermsEnd` succeeded |
| `terms_accepted` | `context` (the record's four values) | `acceptTerms` succeeded |
| `know_before_you_go_completed` | `flavor: 'first_run' \| 'season'` | the completion succeeded |
| `welcome_step_finished` | `step: 'home' \| 'profile'`, `outcome: 'saved' \| 'skipped'` | either button |
| `season_check_signed_out` | — | *Not now — sign out* |

No miss count and no per-question event: wrong picks are not stored, in our tables or anyone's.
`ph-no-capture` on the date of birth, the name and username fields, the quiz picks and the receipt's email
line, so autocapture's labels can't carry a birth month or a wrong answer. The D240 test over event names
and enum values covers the new ones. Sentry: confirm `sentryPrivacy` strips `dateOfBirth`, `email`,
`userAgent` and `ip` at any depth of a breadcrumb's args (the account object nests the date of birth).
*As built,* it did not strip `userAgent` or a bare `ip`; both joined its exact-match list, with the
record's `fullName`.

### 9.11 Deletion, retention, export, and the documents

- **The six years.** At finalize the `consent` stage severs each record and sets `purgeAt`; `purgeDue`
  deletes it then. Nothing earlier deletes a record — a pending deletion, a cancel and a re-onboarding
  leave the old records as they are and add new ones. A live account's records are kept while it lives.
- **The disclosures**, written in stage one so the PR's documents say what it makes true: `PRIVACY.md` (a
  section on the record — what it holds, IP read from the sign-in provider's session, client-reported
  device details, six years past a deletion then deleted, never public, in the export; the retention bullet;
  Clerk's role in the IP), `TERMS.md` (§7 and §9 as the mock words them: the record, and re-acceptance on
  change), `docs/account-deletion.md`. The **delete screens** in both apps (web Settings' account section,
  mobile `AccountLifecycle`) add one plain sentence on the six years, in stage two — *as built,* one
  sentence for both, core's `CONSENT_RECORD_RETENTION`: what the record holds (the name, email and date
  of birth given, which terms and when, when the questions were answered), that it is kept privately
  for six years after the deletion and then deleted, and that the Privacy Notice has the details.
- **Export:** the records as above.

### 9.12 The test plan

- **Core (Vitest, `fast-check`):** `resolveEntryRoute`'s table row by row plus properties — never `app`
  while terms are stale unless a deletion is pending, never `account` for a live complete row, priority
  order total; `knowBeforeYouGoDue` properties — monotone in `lastAt`, exact at the 30-day edge, `null` for
  every `lastAt` once no watch exists except `undefined`; the hashes recomputed (node `crypto`), the quiz's
  shape (seven, distinct ids, `right ≠ wrong`, every `why` and `say` present), `renderTermsMarkdown`
  deterministic, the Geoapify `town` parse. Instants pinned, never `Date.now()` (D243).
- **Guards (`packages/guards`):** `termsDocument.test.ts` — `TERMS.md` between its markers equals
  `renderTermsMarkdown(TERMS)`, `PRIVACY_NOTICE_VERSION` equals `PRIVACY.md`'s *Last updated* and its hash
  the file's; `consentWriters.test.ts` — only `consent.ts`, the finalize stage and the purge write the two
  tables, and every `patch` on a record names only the fill-once fields.
- **Convex (`convex-test`, the suite's harness limits):** every `acceptTerms` refusal; create,
  re-introduce, re-accept; the reading consumed; a username taken between steps; the 18+ edge (the
  D294 property, through this mutation); the two actions scheduled; `captureIp` with stubbed fetch — no
  key, a foreign session id falling back, no session, an error, never throwing, fill-once; `sendTermsCopy`'s
  three outcomes and the receipt's mapping; `completeKnowBeforeYouGo` with no watch, a live row, a reset
  (superseded) row, the 30-day edge, `terms_first`, a repeat while not due (*as built,* replacing the 60-s repeat); finalize severs and dates `purgeAt`
  (a 29 February case); `purgeDue` deletes due rows and never one without `purgeAt` (the optional-index
  trap, seeded with both); `pruneReadings`; the export's shape.
- **Web:** stories for all 26 boards (four-up dark and light, the keyboard path asserted — 1/2, Enter,
  Esc out of the full-screen reader), the hold in `AuthGate` tests, `authZone`'s new table, the
  `?step=` fallbacks, the analytics no-capture attributes, `BOARD_NOW` for the season card's dates.
- **Mobile:** no render harness exists, so each screen's logic is a plain hook or function with Vitest
  tests (the reading's end detection, the step machine, the hold), and the screens get the device pass.

### 9.13 The build: three stages and who owns what

Every commit green (`pnpm check-types`, the touched suites, lint); `/code-review xhigh --fix` and the full
suites before the PR opens. Nobody runs `convex dev` or `convex deploy`; codegen is
`pnpm --filter @skating/convex codegen`.

**Stage one — the foundation, additive (one agent, then the governor reviews before stage two starts).**
Owns `packages/core/**`, `packages/convex/**`, `packages/guards/**`, `TERMS.md`, `PRIVACY.md`,
`docs/account-deletion.md`, `plans/06-data-model.md`. Delivers: core's terms, notice, questions, copy,
`resolveEntryRoute` and the season rule beside the untouched `resolveAuthRoute`; the schema widening and
the two tables; `consent.ts`, `lib/clerkSessions.ts`, `lib/profileIdentity.ts`, the finalize stage, the
export, the crons, the geocoder's `town`, the resend comment fixed; both guards; codegen. The old
`upsertFromClerk` and `acceptCurrentRiskAck` keep working untouched. The founder's text call (§9.15) is
settled before this stage commits the terms.

**Stage two — the apps, in parallel (two agents, own worktrees off the stage-one commit).**
- **Web agent** owns `apps/web/**` only: the four routes, `components/skater/onboarding/**`, `AuthGate.tsx`,
  `lib/authZone.ts`, `lib/boot.ts`, `lib/entryHold.ts`, `lib/analytics.ts`, `routeTree.gen.ts`, the
  Settings delete copy, stories and tests.
- **Mobile agent** owns `apps/mobile/**` only: `app/_layout.tsx`, `app/onboarding.tsx`, `app/terms.tsx`,
  `app/know-before-you-go.tsx`, `app/welcome.tsx`, `src/components/onboarding/**`,
  `src/components/Toast.tsx`, `AccountLifecycle`'s copy, logic tests.

Neither touches `packages/*`; a needed change there is a request to the governor, who lands it on the
stage-one line and both rebase. The two never share a file.

**Stage three — the cleanup (the governor's delegate, after both integrate; done 2026-11-24).** Deletes
`profiles.upsertFromClerk`, `profiles.acceptCurrentRiskAck`, core's `riskAck.ts` and `resolveAuthRoute`
(and their exports and tests), the web's `/reack`, `ReackForm`, `RiskAck`, `OnboardingForm`, `lib/riskAck.ts`,
the mobile `reack.tsx`, `RiskAckConsent`, `src/lib/riskAck.ts`; moves the tests that named them; the inbox
seed stamps the new fields instead. The schema keeps `riskAckVersion`/`riskAckAt` (narrows nothing). Then
this section's findings, the roadmap entry, `/code-review`, the PR.

### 9.14 Deferred and ruled out

Deferred: a console view of the records (and any staff read of them beyond the CLI queries); a legal hold
that pauses one record's purge; a minimum reading time before the box unlocks; an in-app Privacy Notice
page (the link opens the repository's file today); the phone's profile photo step; product analytics on
mobile; the mobile re-skin to the mocks' look; the receipt and season card's undrawn variants getting
boards. Ruled out: storing wrong picks, anywhere; showing the terms' stamps on any screen; scroll-gating
the Privacy Notice; a Garmin step.

### 9.15 The founder's calls this build waits on

1. **The terms text.** The mock's ten sections drop clauses of `TERMS.md` that are substance (item 9 of
   §9.1). Options: (a) the mock's text as drawn; (b) the mock's voice with every dropped clause put back,
   in its section; (c) `TERMS.md` as it stands plus the mock's two new sentences. **Recommended: (b)** —
   the voice the founder reviewed, nothing the current terms promise given up without a decision. Settled
   before stage one commits `terms.ts`.
2. **Show my town without a setting of its own** (§9.6). Recommended: yes — on saves the town, off doesn't;
   a stored switch would be a Settings and public-profile change for one onboarding toggle.
3. **A Privacy Notice change does not re-ask.** The record pins the notice's version and hash; only a
   terms version bump re-prompts. Recommended: yes, with counsel's view (the next section's items).
4. **10.13's "Last answered" day stays as drawn** (§9.1 item 9). Recommended: yes — it is the skater's own
   day, not one of the terms' stamps.

**Ruled (the governor, 2026-11-24), and built that way:** (1) option (b) — the mock's voice with every
dropped clause put back in its section; (2) Show my town stores nothing of its own; (3) a Privacy Notice
change does not re-ask; (4) "Last answered" stays. Counsel's view on (3) is still owed (§9.16).

### 9.16 Owed after merge

- `convex dev --once` on dev **before the device pass or any use of the app against dev** (two tables,
  five optional fields, indexes, two crons; widen-only, no backfill): both apps' root gates now query
  `consent.watchAnchor`, which dev doesn't have until the push. `CLERK_SECRET_KEY` and the Resend keys
  confirmed present on the dev deployment (names only).
- On dev, one real acceptance checked end to end: the record's IP against the session in Clerk's dashboard,
  and whether the web's server-side Clerk handshake ever makes Vercel's address the session's latest
  activity (if it does, the web sends its session id from the browser only and the record's `match`
  says so); the copy received.
- The Android pass on a fresh EAS `preview` build (the pre-merge build cannot onboard: `upsertFromClerk`
  is gone): a new account through all five steps, an existing account through terms and questions, a
  canceled deletion set up again (Public profile off).
- The founder's browser pass, desk and 390; the copy pass on every string and every drafted line (§9.9's
  list, the refusal toasts, the delete sentence, the copy email's intro).
- Counsel's questions (L1, L3): agreeing to a privacy notice in the terms' line, the six years and tolling,
  IP as evidence, keeping the record through a deletion request.

### 9.17 What the build found

Recorded at integration (2026-11-24). Telegraphic; the commits carry the detail.

- **Hashes are ledgers, not one constant.** A single committed SHA-256 per text would have made every
  earlier version's records unverifiable the day the text changed; each text keeps an append-only ledger
  keyed by version (R5 is corrected).
- **The hold belongs in the rule.** Each gate holding the receipt its own way would have let them differ;
  `resolveEntryRoute` takes `hold` and answers `receipt` (§9.3's table gains the row). Both apps set it
  before the send — a hold set on the answer lost the race to the redirect.
- **`userAgent` is optional.** A browser can report none, and an empty one is stored as none.
- **A Clerk error doesn't fall back.** Only a named session that exists and is someone else's falls back
  to the most recent one; an error records `error` (R4 is corrected).
- **The sweeps and the readers needed edges.** `purgeDue` also requires `severedAt` and re-schedules only
  after a page that deleted something; `openTerms` and `reachTermsEnd` refuse a banned, finalizing or
  deleted profile, so no reading outlives `erase`; the CLI lookups returned the *oldest* 200 past their
  cap, and now return the newest.
- **The terms as built.** Section 9 is headed "When these terms change"; a few of the risk phrases are
  bold (the email renderer's `**…**`, the one markup the data allows).
- **The two apps drifted, and were brought back.** The web sent only `username_taken` back to the
  Account step, opened the season card straight after the receipt, and kept "or" and the location
  button under the open suggestion list (the phone did too); each now matches the phone or the board,
  and the refusal set is core's. Both apps wrote the Public switch only when it was switched off, so a
  private account could not be made public from the step; both now write only a change. Each app had put the undrawn lines in a file
  of its own; they moved to core, one wording each.
- **A re-introduced account was being made public.** `acceptTerms` reset a canceled deletion's emptied
  row to the new-account default; it now keeps the row's visibility (D298), as `upsertFromClerk` did.
- **The web's phone layout keys on the card, not the viewport.** The way in's screens switch to rows 11
  at the entry card's own width (a container query), so a narrow pane on a desk gets the phone layout.
- **The month list's plate is the kit's.** One screenshot made the date of birth's month list look
  see-through: it sits on `--plate-solid`, the token every Select and menu shares, which is 96% opaque by
  design, so the form under it shows at 4% (as in Settings). A story holds the plate and the finished
  fade; whether the token should be fully opaque is a design call, not this build's.
- **Sentry kept two of the record's fields.** `userAgent` and a bare `ip` passed `sentryPrivacy`; both are
  withheld now, with `fullName`.
- **Nothing `upsertFromClerk` did was lost.** Its every behavior — the defaults, the server's stamps, the
  18+ gate, the name and username rules, the Clerk mirrors (the first of the three writers), the inactive
  and deleted rows left alone, the minor forced private and the grown-up kept private, the People row —
  is now held by tests against `acceptTerms`; the inbox seed stamps the routing fields instead of the
  acknowledgment.
- **The review's eleven (2026-11-24).** A banned, finalizing or suspended account with stale consent
  was routed to the terms, which its own gate refuses: it lost the app and the appeal; the rule now
  sends an account that can't act to `app` (`canActNow`, shared with `requireProfile`), and the gates
  wake when a suspension lapses. A client whose bundled words weren't the server's was told
  `terms_changed`/`questions_changed` and re-read the same text forever; the questions now take any
  published version, and the terms and notice answer one `client_outdated` that stops on a blocking
  screen. The `'unpublished'` sentinel matched itself, so a build mid-edit could record an acceptance
  (`claimMatches` refuses it). Repeat acceptances and completions sealed new records and sent new
  emails; they now return the first. An emptied row could complete the questions under the scrubbed
  name. The web counted the end without a scroll (an observer rooted at a window that clips nothing,
  chosen once at mount), re-ticked the agreement after a reset, retried a failing end in a tight loop,
  kept an abandoned address's town, and let a late location fix overwrite the home; the phone's
  reading never recovered from `terms_not_opened` (a cached opening). Each is fixed and tested.
- **The second review's eight (2026-11-24): gaps the first round's fixes left.** The Home step held
  Skip and Save while a location read was out, and a permission prompt nobody answers never ends one
  (`currentPosition` now gives up after 30 s; neither button waits; either press drops a late fix). An
  old build bundling the terms a profile last accepted routed itself to the questions and was told
  `terms_first` forever: the completion now carries the client's terms claim and answers such a build
  `client_outdated`. The web's restart re-armed its end at once and scrolled only the inline reader,
  so a failing open looped in the full-screen reader; a restart now scrolls every reader to its top and
  stays disarmed until the end leaves and comes back. The web's wake-up timer was keyed on its instant
  alone, so one that fired a hair early set no new one (the wake count is a dependency now, as on the
  phone). The town went before a failed save had kept the address it belonged to (the address now goes
  with it). The phone patched up a lost reading by opening and stamping in one breath, a record of
  terms opened and finished in the same instant; it now does what the web does. The rule judged a
  suspension by the device's clock (a five-minute margin, and a can't-act refusal sends the skater to
  the app). A second tab counted one sealed record twice in analytics (`repeat` on both returns).
