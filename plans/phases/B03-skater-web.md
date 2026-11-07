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
| `/latest` (`/feed` redirects) | `report?: reportId` (4.5–4.7: the report opens in the center column) · `q?: string` (debounced 300 ms; 4.9, behind the text-search gap) · `skater?: username` (4.8, behind the author-filter gap) · `view?: 'map'` (4.4) | Filters on the left · feed in the center · Recommended and *Wanted near you* on the right |

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
  - Hazard: `hazards.create`, `hazards.listBundleCandidates` (3.8), `photos.generateUploadUrl`/`create`
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
