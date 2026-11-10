# Phase B03 — The skater web app

> **Status:** scoped, 2026-11-07. Nothing built. The scoping pass below was written before any code and
> revised the same day after the founder's review: PRs #90 (the kit) and #91 (PostHog) are merged to main,
> so the build cuts from main (branch `phase-b03-skater-web`, worktree `../skating-b03-skater-web`). The
> open founder questions are §6; the build model (one governor, 6–8 parallel agents) is §5. Mocks: Paper
> *Gli · Web app · Review 3* (157 boards), rules in `skating-mockups/skater-web/README.md`.

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
| `/onboarding` | none | Finish your profile: empty, under 16, ready, username taken, username not allowed (8.5–8.7, 8.16, 8.18, 8.19) |
| `/reack` | none | One quick thing (8.8), with the risk acknowledgment verbatim |
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
  now says to serve it with `serve --cors`. What remains is the upload (the roadmap row).
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

The column and the `BootScreen` skeleton standing in for it now read one `--size-latest-filters`,
the way `BootMapPage` already shares `--size-sidebar` with the real sidebar. They have to agree: a
skeleton a different width from the page it becomes would slide the feed sideways the moment the
first query lands. `Latest.stories` measures both segment rows against the column's edge, so the
next label that outgrows it fails in the browser project instead of on the founder's screen — after
awaiting Saira by name, because Storybook fetches it with `display=swap` and the two faces differ
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

### 8.4 What §8.3 cost the winter imagery, and two CI reds that were nobody's diff

Greptile's read of §8.3 found the one place where publishing `null` is not the same as publishing a
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
take a lane off, forgetting it is the whole job. That is the same correction as §8.3 one level up —
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
