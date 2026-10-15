# Phase B01 — The admin console: one surface, organized by what an operator is doing

> **Status:** scoped, 2026-10-12. Nothing built. This doc is the record of the founder's brief, the
> inventory of what `/admin` does today, the diagnosis, the information architecture, the founder's
> calls (§7, minted as **D216–D222**; the look's D223–D224 came 2026-10-14), the workstreams (§8), and the season-statistics pick (§10,
> all of tiers 1 and 2). The raw inventory is
> [`research/admin-surface-inventory-2026-10-12.md`](../research/admin-surface-inventory-2026-10-12.md).
> Next: static wireframes per mode in `skating-mockups/admin-console/`.

Phase 07 built `/admin` as *work queues plus a control room* (D37), and every phase since added a
page for its own feature: the lake editor (A02), body features (A05a), hazard identity (A05c), ice
calibration (A06h), intake review (A07a), standing and requests (A07b), imports (A06c §6.2), seasons
(A06i), place names (D202). Sixteen nav items later the surface is organized by **table**, not by
**task**: an operator who wants to know "what needs me?" reads four pages and still misses eight
queues; an operator fixing a lake bounces between a list page and a 2,900-line editor whose map
scrolls off-screen; an operator watching a corpus campaign has a read-only history with no way to
tell a live run from a dead one. This phase rebuilds the surface around the tasks an operator
actually has, as a dense, keyboard-first console, without losing a single lever that exists today.

## §0 — The brief (founder, 2026-10-12)

Six things an admin needs to do, in the founder's words, condensed:

1. **Watch the corpus machinery** — when runs happened, whether each was a full canonical re-import
   or a gap-fill from one source, how it went, full detail for investigation; trigger runs and
   watch them live, the way a Vercel build log or a GitHub check feels — *watching the machinery
   work*, with the tools to catch a pipeline going wrong.
2. **Read the season** — are we in one; this season and past seasons: when they started, lows,
   record freezes, most popular lakes, reports filed, lakes added, removed or marked
   no-public-access, new put-ins, lots and landmarks; usage and behavior statistics; a log of
   corpus changes; how often weather and imagery were fetched and what it cost (a running-cost
   ledger).
3. **Work the inbox to zero** — everything users submit: new bodies, no-public-access reports,
   POIs, names for unnamed bodies, wrong-polygon reports, safety flags (what are these?), support
   tickets. Each kind gets its own handling UI, but every task completes *from the inbox*.
4. **Improve the corpus** — a searchable queue of what the import could not settle. Today's Intake
   Review / Place Names / Standing / Imports are indistinguishable from the nav; make it clear.
   Separate from the machinery view (§0.1), but open to a better UX.
5. **Edit any body of water** — a console like the report console (`/post`): side panels, a central
   map with toggleable layers, POIs placed, moved, deleted and modified, polygon edges tweaked,
   bodies joined, sub-areas marked; an app, not a long-scrolling page.
6. **Discipline users** — block, mute, ban, restore, promote.

Constraints: **lose nothing** that `/admin` can do (Tuning, Ice calibration, and whatever else is in
there, including things the founder has forgotten); a **high-density, HUD-style power console**
(keyboard-first, command palette, every pixel of a desktop used); **mobile supported, desktop the
focus**; IA first, then wireframes, then the real UI. Inspiration (direction, not detail):
[Military interface HUD](https://www.behance.net/gallery/58307759/MILITARY-INTERFACE-PROJECT-HUD-UI),
[Battlefield 2042 maps interface](https://www.behance.net/gallery/134505091/BATTLEFIELD-2042-MAPS-INTERFACE),
[The Table](https://www.behance.net/gallery/95170531/THE-TABLE),
[Samolevsky futuristic UI kit](https://www.samolevsky.com/products/futuristic-ui-kit-200-design-elements?variant=31461113561185).
The report console's re-skin (A10-6, D206; mockups at `skating-mockups/a10-sheet/`) already set a
register in this family — ink-first, color rationed by meaning, Saira and Martian Mono, 2 px
radius, bracket corners on the thing being edited — and the admin console inherits it rather than
inventing a second one.

## §1 — What exists today, in one table

Every capability the current surface has, where it lives, and where this phase proposes it lands
(§5). This table is the *lose-nothing* check; the build closes when every row's last column is 🟢.

| Capability today | Page | Gate | Lands in |
| --- | --- | --- | --- |
| Queue-depth tiles (4 of ~12 queues), app-health trends, catalog coverage, last 20 audit rows | `/admin` | mod (trends admin) | **Overview** |
| Flags: safety lane, access lane (per lake), standard; resolve, hide/remove, retract or pin an access alert; rule public access | `/admin/flags` | mod | **Inbox** |
| User search; detail with trust tiles, contributor trend, posting permissions, bounty limit, suspend, ban, lift; role grant/revoke | `/admin/users`, `/admin/users/$id` | mod (role admin) | **People** |
| Find a lake by name; curated list; pending user-drawn bodies approve/reject; suspected-duplicate groups merge/dismiss | `/admin/water` | mod | search → **Body console**; pending → **Inbox**; duplicates, curated → **Corpus** |
| The lake editor: name, prominence, sub-areas (chord, freehand, paste), landmarks, depth, weather sample points, put-ins, parking and approach, known features, hazards, recurrence, promotion candidates, aggregate tracks, posted rules, satellite link, reference links, standing, history | `/admin/water/$id` | mod (remove/restore admin) | **Body console** |
| Intake review: six merge reasons, read-only, links to the editor | `/admin/water/review` | mod | **Corpus** |
| Standing: five lanes off the active map + recent activations, read-only | `/admin/water/standing` | mod | **Corpus** (lanes) + **Season** (activations) |
| Requests: seven kinds, approve/decline, admit resolver, preview map | `/admin/water/requests` | mod (restore/takedown admin) | **Inbox** |
| Place names from the emails: set lake, dismiss, reopen, hand off to the editor | `/admin/water/place-names` | mod | **Corpus** |
| Body features: list the newest 100, demote | `/admin/features` | mod | **Corpus** (the pre-ice pass) + **Body console** |
| Hazard identity: recurrence queue (suppress), recent merges (unmerge) | `/admin/recurrence` | mod | **Corpus** (the pre-ice pass) |
| Ice calibration: the fit, the pairs, the Open-Meteo meter | `/admin/ice-calibration` | mod | **Instruments** (meter → **Machinery**) |
| Seasons: the watch, imagery start/pause/retry, versioned thresholds with replay, field dates | `/admin/seasons` | admin | **Season** (imagery → also **Machinery**) |
| Support inbox: tickets by status, assign to me, resolve | `/admin/support` | admin | **Inbox** (admin lane) |
| Tuning: every constant read-only beside its chart; operational-health charts | `/admin/tuning` | admin | **Instruments** |
| Imports: newest 50 runs, campaign tiles, run detail (outcome, coverage, tallies, path, failures) | `/admin/imports` | admin | **Machinery** |
| In-context moderation on skater pages: takedown on report/post/comment/hazard, promote a hazard, rule public access, approve/reject a body, user levers on a profile, edit history | `/water/$id`, `/hazard/$id`, `/report/$id`, `/feed`, `/u/$username` | mod | stays; each gains a link into the console |
| Things only a terminal can do today: `finalizeNow`, the standing rollover, `regionStats.recompute`, analytics backfill, every ETL command, `seedBayRequests` | — | admin | **Machinery** (what is safe to trigger), the rest stays CLI |

Role model unchanged: `member < moderator < admin` (D37). Admin-only stays exactly where D37 drew
it — role-granting, PII (support), the constants — plus what later phases added (imports, seasons).

## §2 — Diagnosis: what the inventory found

Read the research doc for the evidence; this is what it adds up to.

1. **Organized by table, not by task.** Sixteen nav items, four of them `Water bodies` children
   with no visible relationship. The nav comments say why each got its own entry ("burying it one
   click deep is how 2,010 stored rows went unseen") — the fix each time was a *flatter* list, so
   the list grew. The dashboard counts four queues and ignores eight.
2. **Queues that don't act.** Intake review and Standing *list*; Place names triages but the act
   is in the editor; Requests acts for five kinds and hands off for two. Every hand-off lands in
   the editor with no sign of which queue sent you or what you came to do.
3. **The editor is the real workbench and the worst-shaped page.** Nineteen stacked cards beside
   a 70 vh map that scrolls away; one `placing` slot shared by four tools; `window.prompt` for a
   rename; no polygon editing, no class/state/alias editing, no merge, no public-access ruling (the
   Standing card, the Standing page and a server error all say to use "the Access section", which
   does not exist); admin-only buttons shown to moderators; a reason dialog whose text is
   discarded (`RemovalTool`).
4. **Nothing links.** Flags don't link to the content, the lake or the person; features don't
   link to the lake or the hazard; the audit feed drops the target; support tickets don't link to
   the account an appeal is about.
5. **One item, many places.** Bay and landmark asks appear on Requests *and* in the editor; the
   duplicate queue and the intake "duplicate candidates" are two independent flags on the same
   bodies; approve/reject exists on `/admin/water` and in the skater drawer; promote/demote lives
   on four pages.
6. **The machinery is invisible.** Thirty crons; only four (imagery) have a run log with a manual
   trigger, and one (the standing rollover) writes an `importRuns` row. Imports are read-only, no
   run can be started, no event stream exists, a killed loader leaves a row in `running` forever,
   and "full re-import vs. one-source gap-fill" is not a field — it is inferred from `kind`,
   `label` and `campaignId`. Notifications, weather appends and the NWS poll have no record at all.
7. **A season is a date range, not a record.** `seasonOf(now)` is derived; the only stored season
   is the ice watch (A06i). Per-season reports, bodies added or removed, POIs, fetch counts: none
   stored, all computable. Cost is metered for one provider (Open-Meteo, counts only); ORS, Fly,
   Convex, Vercel, Resend, Clerk, R2 and Anthropic are not.
8. **Discipline has the levers and misses the edges.** Suspend, ban, lift, per-action posting
   permissions, a bounty cap, role grant/revoke, all audited; no mute or shadow state; a lapsed
   suspension never resets `status`; *Lift* is offered on deleting and deleted accounts (a real
   bug); no restore for hidden content anywhere; no takedown for photos; a flag *on a user* has no
   action and no link.
9. **Dead and half-wired.** Flag status `reviewing` is never written; `getAdmin` returns the
   user's audit history and nobody renders it; `userSearch` returns `trustClass`, unshown; support
   `createdAt` never shown; `subAreas.setCuratedBoost` has no caller; `RestoreGate` is reachable
   only for rejected bodies and its button fails for them; the raw trust score shows to moderators
   on `/u/$username` against D50.
10. **The inbox is empty on dev.** Every person-filed queue is 0 rows. The corpus backlog is not:
    the intake queue carries ~2,010 rows, place names 237 (pre-#88), and 217 import runs exist.
    The UI will have to be designed against seeded data for the inbox and real data for the rest.

### Safety flags, a refresher

A **safety flag** is a `contentFlags` row with `reason: 'unsafe_false_report'` — someone says a
report (or a hazard, or a person's pattern of reports) claims ice is better than it is. D3 makes
that a safety incident, not spam, so it rides a priority lane at the top of the flag queue and
emails the staff (D38). Three things file one: a skater, from any report, hazard, comment or
profile; the hazard vote, when two people say a pin *never existed* (D65); and the contradiction
check, when a person's report disagrees with the weather too often (D56 §7b, filed against the
*user*, throttled). Resolving one is two audited decisions: the flag's disposition (actioned or
dismissed, which notifies the flagger) and, separately, what happens to the content (hide,
remove) or the person (posting permission, suspend, ban).

## §3 — Goals and principles

- **Organized by intent.** The top level is what an operator is *doing* — reading the state of
  things, clearing what people sent, improving the corpus, fixing one lake, watching the machines,
  reading a season, handling a person, checking the instruments. A new feature adds a lane inside a
  mode, never a nav item.
- **Every task completes where it is found.** A queue row opens its handler in place; a geometry
  task opens the body console *in a task mode* that returns to the queue on save. No dead-end
  hand-offs.
- **Everything links.** A lake, a person, a run, a flag, an audit row — each is a link to its
  console page, and each console page lists what is asked of it ("3 open asks, 1 intake reason").
- **Counts are honest.** The overview counts every lane with the same bounded reads the lanes use.
  A lane that can't be counted cheaply gets an index.
- **The machinery is watchable.** Every job that runs on a schedule or by hand leaves a record with
  a heartbeat; a run that stops reporting reads as *stalled*, never as *running*.
- **Dense, keyboard-first, desktop-first.** One shell for the whole console: locked to the viewport
  like `/post`, resizable panes, a command palette, list navigation from the keyboard, the
  inspector on the right. Mobile gets the lists and read-only views; the map editor is a desktop
  tool.
- **Moderators see what they can do.** A button the server will refuse for this role is not drawn.
- **D3 still binds.** Nothing here reads as *the ice is safe*; the season view reports air lows,
  reports and usage, never a verdict.
- **Nothing lost (§1).** The old routes redirect to the new homes until the register is 🟢.

## §4 — Prior art inside the repo

- **The report console** (`/post`, A10-5/6): `grid-cols-[372px_minmax(0,1fr)_452px]` with a 36 px
  top bar and a 30 px status bar, locked to the viewport, a center *instrument* with modes
  (`ConsoleMode`: where, put-in, place), Escape leaves a mode. The body console is the same shape
  with a MapLibre canvas as the instrument.
- **The shared map shell** (`lib/mapCanvas.ts`, D61) and `LakeEditorMap`: the editor's camera lock,
  layer registration and terra-draw integration already exist; the console re-hosts them.
- **`ReasonDialog`**: the one audited-action dialog. `ModeratorActions` re-implements it badly; the
  console uses one.
- **`ReviewClosedNotice` / `useReviewWatch`**: the colleague-decided-this lock for requests —
  generalize to every inbox item.
- **`ImportRunDetail`**: outcome → funnel → detail → evidence is the right read for a run; it
  needs a live tail and a heartbeat, not a redesign.
- **shadcn on Base UI** is the house kit; the console will add `command` (palette), `resizable`,
  `table`, `tooltip`, `kbd`-style primitives from it rather than hand-rolling.

## §5 — The proposed information architecture

Nine modes (Reports added by D225, 2026-10-14). The left rail lists them with a count where a count means work; `g` then a letter
jumps; `⌘K` opens the palette from anywhere.

| Mode | Route | Gate | What it is |
| --- | --- | --- | --- |
| **Overview** | `/admin` | mod | The HUD: season state strip, inbox depth by lane, corpus backlog by task, machinery health (last run per pipeline, stalls, backoffs), cost meters (admin), the audit feed with links |
| **Inbox** | `/admin/inbox` | mod (support lane admin) | Everything a *person* filed that waits on a person. One list, lanes, a handler per kind in the inspector, Inbox Zero |
| **Reports** | `/admin/reports` | mod | Every report, post, comment and photo, read in full: lanes for flagged, edited, contradicted, hidden; the report with its edit history, flags, thread and author; hide, remove, restore. Flags are decided in the Inbox (D225) |
| **Corpus** | `/admin/corpus` | mod | What the *machines* could not settle, as tasks: duplicates, class and name conflicts, orphan bays, chord re-fits, place names, the pre-ice pass (recurrence, promotion), standing lanes, enrichment gaps; plus a browser over every body including removed and rejected |
| **Body console** | `/admin/body/$id` | mod (remove/restore admin) | One lake, one canvas, every lever: the report-console layout with the map as the instrument |
| **Machinery** | `/admin/machinery` | admin | Pipelines and runs: ETL campaigns, crons, imagery, weather appends, notifications, external calls and cost; live tails; triggers for what is safe to trigger |
| **Season** | `/admin/season`, `/admin/season/$season` | mod (settings and reset admin) | This season and every past one: the watch, imagery, field dates, the statistics (§0.2), the corpus change log |
| **People** | `/admin/people`, `/admin/people/$id` | mod (role admin) | Search and browse (moderators, suspended, banned, flagged, newest); the detail with history; the levers |
| **Instruments** | `/admin/instruments` | admin (ice calibration mod) | Tuning's constants beside their charts; ice calibration; operational health |

### §5.1 — Overview

Not a dashboard of charts — a status board. Top strip: *Winter 2026-27 · watch open since 3 Oct ·
imagery running · 2 staff*. Then four columns of counts that are links: Inbox by lane (safety first,
red when > 0), Corpus by task, Machinery (last run per pipeline, red for failed or stalled, amber
for a cron that has not run inside its window), People (new this week, suspended, open appeals).
Below: the audit feed, every row naming actor, verb, target *as a link*, filterable. The trends
that live on `/admin` today move to Instruments; the catalog-coverage card moves to Machinery.

### §5.2 — Inbox

**Lanes**, in priority order: Safety (`unsafe_false_report`), Access reports (per lake,
corroboration-ranked), Requests (`activate`, `admit`, `restore`, `contest_access`, `takedown`),
Places (`name_bay`, `name_landmark`, skater landmark proposals), Drawn bodies (`reviewStatus:
pending`), Content flags (spam, harassment, inappropriate, low quality, other), Support (admin;
tickets and appeals). One list, `j`/`k`, `e` to resolve, `x` to decline, `o` to open the subject;
filters by lane, kind, age, lake, person; the inspector on the right shows the item and its
handler; a map pane when the item has a place.

**Handlers per kind** (each exists today in some form; the console gives each one home):

| Kind | Handler |
| --- | --- |
| Safety flag | The content (or the person's recent reports), the flagger's note, the weather that night beside the claim, prior occurrences; actions: dismiss, action, hide, remove, restrict posting, suspend, ban — the last three open the person inline |
| Access report | The lake, every reporter's note, the prior ruling if disputed; mark none / confirm open / clear, with a reason |
| Request (five kinds) | What exists today on Requests: the body or the 3DHP candidate, askers, note, *look up again*; approve/decline; approve performs the verb (D179) |
| Place ask (bay, landmark) | The point on the map, lookalikes (D202), *same place*; **draw** opens the body console in bay-mode or landmark-mode with the ask attached; saving approves and returns |
| Drawn body | The polygon over the basemap and aerial, overlap with known bodies; approve, reject, or *merge into* |
| Content flag | The content in place; dismiss, action, hide, remove, **restore** (new: `setModerationStatus('visible')` exists, no UI does) |
| Flag on a user | Links to the person; posting permission, suspend, ban inline |
| Flag on a photo | **New verb needed** — photos have no moderation axis today (§7, question 9) |
| Support ticket | The ticket with its context, the submitter as a link, **a note and a reply** (new; today assign and resolve leave no trail) |

"Colleague decided this" locks every item (generalize `useReviewWatch`). An item leaves the list
on decision; the Decided tab keeps the record.

### §5.3 — Corpus

The backlog of what the import could not settle and what the season's pass needs, as **tasks**,
each with a count, a blurb that says what *done* means, and rows that open the body console in
the right tool:

| Task | Source today | Done means |
| --- | --- | --- |
| Duplicates | `dedupStatus` groups (D36) **and** intake `duplicate-candidate` / `same-source-duplicate` — one lane, one decision | merged or dismissed; the intake reason cleared on decision (today only the next campaign clears it — the register's "small fix blocked on nothing") |
| Name conflicts | intake `name-conflict` | a name chosen (clears the reason) |
| Class conflicts and dissent | intake `class-conflict`, `class-dissent` | a class chosen (**new**: no class editing exists) |
| Orphan bays | intake `bay-without-parent` | a parent assigned (**new**) or demoted to landmark |
| Chord re-fits | `mouthReview` kept/refitted, `mouthStale` (D215) — today visible one lake at a time | the chord saved |
| Place names | `corpusPlaceNames` open | placed, filed as a spelling, or dismissed |
| The pre-ice pass | recurrence queue, promotion candidates, body features | promoted, suppressed, or left; the pass is dated so Overview can say *done for this season* |
| Standing | the five lanes + recently activated | not a queue: a browser with the lanes as filters |
| Enrichment gaps | "awaiting elevation / wind / depth" (today a column on Standing) | the enrichment run (→ Machinery) |
| Curated | `curatedBoost > 0` | not a queue: a browser filter |

Plus **the corpus browser**: search by name, id, external id; filters by state, class, standing,
review reason, source, curated, has-open-asks; every body including removed and rejected (today
unreachable); columns chosen by the operator; a row opens the body console.

### §5.4 — Body console

The report console's frame with the lake as the instrument. Left column: identity (names and
aliases, class, states, ids, standing with its reason, prominence), *what is asked of this lake*
(open inbox items and corpus tasks for it, each a link that arms the right tool), and the history.
Center: the map, full height, camera-locked (D61), with a layer rack — outline, sub-areas and
mouths, landmarks, put-ins, lots, sample points, hazards, features, aggregate tracks, aerial,
bathymetry — each toggled, and a mode banner when a tool is armed (Escape leaves). Right: the
inspector, tabbed by tool:

- **Shape** — the polygon: vertex edit, split, **merge into** (today only from the duplicates
  page), sub-areas by chord and freehand, paste GeoJSON. Polygon editing is **new** (no mutation
  exists) and has consequences — area, bbox, interior point, weather cells, sub-area clipping, the
  D215 re-fit — so it is its own workstream (§8, question 10).
- **Names** — catalog claims, community name, aliases (today uneditable after creation).
- **Places** — landmarks (edit, move, draw-as-bay, remove, restore), the community's email names,
  skaters' proposals.
- **Access** — put-ins (official, hide), lots (**edit and remove**, new), approach links, posted
  rules, and **the public-access ruling** (today only in the skater drawer and the flag lane).
- **Water** — depth with the source ladder, weather sample points, satellite link, bathymetry
  state.
- **Hazards** — this lake's hazards, recurrence, promotion candidates, known features.
- **Standing** — active, dormant with note, removed with reason, restore; the request and ruling
  history.
- **Links** — reference links.

Task modes: opened from the inbox or corpus with `?task=<id>`, the console arms the tool, shows
the ask in the banner, and *Save* returns to the queue. The skater-facing drawer's moderator card
becomes one link here.

### §5.5 — Machinery

Pipelines as rows: **ETL campaigns and runs** (`importRuns`), **crons** (all thirty, with schedule,
last run, outcome, next due), **imagery** (poll, pump, index, the granule ledger), **weather**
(the daily appends, the gap sweep, the cell registry), **notifications** (flush, delivery,
failures), **external calls and cost** (per provider per day: Open-Meteo today; ORS, Fly, Anthropic,
Resend added as they are metered). A run page: outcome → funnel → detail → evidence as today, plus
a **live tail** (an event stream per run with timestamps), a **heartbeat** (a run silent past its
interval reads *stalled*), and *Cancel* where the runner supports it. **Trigger** for what Convex
can run itself — the standing and recurrence rollovers, region stats, the analytics rollup, an
imagery poll, a weather sweep, the catalog measure — each with a dry-run where one exists.
Laptop-bound ETL (osmium over gigabytes of extracts) is watched, not started, until a runner
exists (§7, question 4).

The run vocabulary gains what the brief asks for and the data lacks: a **scope** on every run —
`full-canonical`, `single-source`, `enrichment`, `seed`, `rollover`, `archive` — so the list can
say *full re-import* vs. *gap-fill* without inference.

### §5.6 — Season

`/admin/season` is this season: the watch (A06i's card), imagery state, field dates, and the
numbers — reports and posts, active contributors, most-reported lakes, new accounts, bodies
activated, demoted, removed, admitted, POIs added, landmarks named, inbox throughput, fetch counts
and cost — computed over the season's date range (`seasonOf`), with a **corpus change log** read
from `moderationActions` and `importRuns`. `/admin/season/$season` is any past season with the
same shape, plus the watch replay. Settings and reset stay admin (D213). A season record table
(per-season rollups) is a build choice (§7, question 6).

### §5.7 — People

Search as today, plus browse lists: moderators and admins, suspended (with *until*), banned,
flagged, newest, leaving. The detail renders what `getAdmin` already returns and nobody draws —
the audit history, `suspendedUntil`, comments, bounty points — beside the trend; the levers; the
role card (admin); open inbox items about this person. New levers, if the founder wants them: mute
(a comment-only restriction already exists as `canPostComments`; "mute" may be that), restore
hidden content by this person, and a per-user *flagging* permission (the founder's own note in
`CLAUDE_NOTES`: a lever to stop someone flooding the queue).

### §5.8 — Instruments

Tuning as today (constants read-only beside charts, D37's settled decision 1 unchanged), ice
calibration as today, and the operational-health charts that are about the operator (time to
resolution, support volume) — here, not on the overview. The Open-Meteo meter moves to Machinery.

## §6 — Interaction model and aesthetic direction

- **One shell.** The console takes the viewport like `/post`: a 36 px top bar (mode, breadcrumb,
  search, the season chip, staff presence), a 48 px icon rail on the left (the eight modes, counts
  as badges, expandable to labels), the mode's own split (list | inspector, or list | map |
  inspector), a 30 px status bar (selection, keyboard hints, connection, last sync).
- **Keyboard.** `⌘K` palette: jump to any mode, lake, person, run, or cron; run an action on the
  current selection; recent items. `g i` / `g c` / `g b` / `g m` / `g s` / `g p` / `g t` for the
  modes; `j`/`k` lists, `Enter` opens, `Esc` closes; `?` shows the map. Shortcuts are discoverable
  (a `kbd` hint on every button that has one).
- **Density.** 12–13 px body in lists, Martian Mono for every value that aligns (times, counts,
  coordinates, ids), 2 px radius, 1 px hairlines, no cards-within-cards; raised fill and bracket
  corners mark *the thing being edited*; color rationed as the A10 system does it — ice for
  geography and selection, amber for *needs you*, red for safety and hazards only, inverted ink
  for a selected row.
- **The HUD register, honestly.** Corner brackets, reticles, monospaced readouts, dashed guides
  and thin scan-lines are decoration with a job: they mark focus, bounds, and live state. Nothing
  decorative that doesn't encode something. Dark first (the founder designs dark); light is the
  same ramp inverted.
- **Mobile.** The rail collapses to a bottom bar; lists and inspectors stack; the map in the body
  console is view-only below `lg`; nothing is *unreachable* on a phone, and nothing is optimized
  for one.
- **The visual register (founder calls, 2026-10-12).** The restrained end of the HUD boards,
  with two or three signature devices used consistently, decoration only where it encodes state.
  **Saira, Saira Semi Condensed and Martian Mono** debut on the web here (the A10 reservation is
  lifted for the admin console). **Neutral grayscale ink** — not the boards' blue cast — with the
  A10 accents by meaning only: ice for geography and selection, amber for needs-you, red for
  safety and failure. **Motion** on appearance, interaction and live data; nothing ambient;
  reduced-motion respected. **Type floor:** 14 px body, 12 px assistive, 10 px kickers, labels
  and numerals. The inspiration is one project, *The Table* (Behance 95170531): eleven frames
  saved with the founder's notes in `skating-mockups/admin-console/inspiration/` and indexed in
  that folder's README; the vocabulary taken from it — tracked small-caps labels with a kicker
  above and a hairline or dotted leader beneath, inverted-block section titles, hollow-circle
  bullets with the selected row bright, panels bracketed by L-lines with endpoint dots, hollow
  markers on thin charts, segmented meters, boxed readouts, the map as gray plates with a reticle
  on the target and a dotted track. The pass is the Body console in **three skins over one base**
  (`pass/body.html?skin=a|b|c`: Instrument, Table, Plate) so the founder picks per element; the
  chosen set becomes the token and component sheet, then a decision.
  **Pass 3 (2026-10-13).** The founder restated the brief — simple white, black and grayscale,
  not the boards' blue; take the weights, when a label inverts, the chart and map styles, solid
  versus dotted versus connecting lines, corner ticks, accent color only for data — and asked for
  three or more variations to pick from per element. They are in
  `skating-mockups/admin-variants/` (README: the per-frame notes, the axis table, the open flags):
  **V1 Field** (no filled panels; rules, slugs, brackets, space; white lit), **V2 Plates**
  (corner-marked plates, the wireframes' tables, meters under every value; ice lit), **V3 Trace**
  (corner-dot plates joined by stepped traces that encode sources → machinery → queues; a dashed
  region around what waits on a person; inverted value boxes; sliders), each on the Overview and
  the Body console drawn from the real Mascoma record. Open: white or ice for selection; rail
  names under the type floor; the single display word. **The founder's read, same day:** V1's
  no-filled-panels field is the base; grayscale with white highlights first (a blue comparison
  kept alongside); the circuit belongs on the Season page, not the Overview; V3's navbar lockup
  and lake header; V1's cards with V2's machinery matrix; V3's sentinel chart with an ice-ramp
  matrix; V2's POI squares; the layer menu, the bay-mode to-do and the matrix need deeper work;
  8 px rail names are fine under icons; the big page word lives in the page, never the navbar.
  **V4** (`overview-v4`, `body-v4` + `?blue=1`, `season-v4`, `explore-v4`) is that merge, with
  the aerial layer docking the app's freeze-up stepper and an admin override for clouded passes
  (a product addition; needs a D# if it stays). **The founder's read of V4 (2026-10-14):** blue
  for transient modes (confirmed by the comparison); "bodies", never "lakes", for anything that
  may be a bay or a river; the circuit stays on Season but with uneven columns; the Season page
  keeps every lane and section of the wireframe; the matrix follows the temperature scale (cold
  cyan → neutral → warm orange); no key hints on cards — `G` as a go-mode is the proposal; the
  rail is the FontAwesome set (tachograph-digital, inbox, cabinet-filing, map-location-dot,
  calendar-days, users, engine, sliders); **the clouded-pass override is in scope for B01**.
  **V5** (`overview-v5` + `?go=1`, `body-v5`, `season-v5`, `imagery-v5`) is that read applied;
  the dock has three states and an inspector-card twin. **The founder's read of V5 (2026-10-14):**
  go-mode stays (every G-binding is the ordinary key chip turned blue, the spent G greyed; the
  tape, search, avatars and status bar dim too); the Season page's word stays *Winter 26–27*;
  the admin's thumb lands on skipped passes only with the *Imagery* tab open; machinery colors:
  red = will not recover without a person, amber = late or retrying; the layer menu stays open at
  desktop width (a collapsed state exists for narrow maps and is never used inside a mode). D223 and D224 followed the same day.
  **V5, the other modes (2026-10-14):** the six pages the admin-hud round drew are redrawn in
  the register — `inbox-v5`, `corpus-v5`, `bodies-v5`, `machinery-v5`, `people-v5`,
  `instruments-v5` over `v5-pages.css` — with the display word as the page's *subject* (the
  lane, the task, the campaign, the person, the section), lanes as the Season page draws them,
  one-left-edge rows, inspectors as blocks over dotted rules with the stable action bar (primary
  wears the corner dots; destructive is a hairline box until armed). Four explorations for the
  founder before the build: the ⌘K palette and the *Bodies* lookup (`palette-v5`, `lookup-v5`),
  three more inbox handlers and inbox zero (`handlers-v5`: a drawn body, a support ticket with
  the note and reply, a place ask with a lookalike), the cost ledger with the invoice form
  (`ledger-v5`, D219), and the mobile bar (`mobile-v5`, D216). Open: green for *allowed* on
  People (round three) versus D223's palette (drawn white); the palette's actions in one list
  via ⇥. The Inbox was also rebuilt in **Paper** (the *Gli* file, *Admin Dashboard* page) over a
  token set, as the trial of iterating there instead of by PNG; what ports and what does not is
  in the admin-variants README.
  **The parity pass (2026-10-14):** the mocks checked against today's `/admin`
  (`research/b01-mock-parity-2026-10-14.md`), then the founder's calls — Reports as a ninth mode
  with the in-context controls kept (D225); undo for every action and a reason only when something
  is taken away (D226) — and the mocks the first build workstreams need: the six remaining Body
  console tabs with their map modes (Names; Places in landmark mode; Access in parking mode; Water
  with the sample-point preview; Hazards; Standing), the Reports mode, four more inbox handlers
  (access reports with a dispute, admit, an access-alert flag with unpin, a photo flag), the task
  round trip as four frames, a states sheet (the reason dialog's six states, toasts and undo,
  autosave, colleague locks, standing in every state) and a live sheet (a run going quiet, the
  audit feed arriving, list states, the moderator's console, the `?` key sheet). All 31 V5 pages
  are in Paper; the first import is on an archive page. Corpus, Machinery, Season and Instruments
  are mocked just before their workstreams.
- **Wireframes first.** Before any React, a static HTML mockup per mode in
  `skating-mockups/admin-console/` (the A10 pattern), rendered dark at 1440 × 900 and reviewed.
  **v1 exists (2026-10-12):** eight pages (`overview`, `inbox`, `corpus`, `body`, `machinery`,
  `season`, `people`, `instruments`) over a shared `console.css` + `chrome.js`, with the README
  carrying what each shows and what v1 leaves out. The signature is the **season tape** in the top
  bar of every mode — the console's clock is the winter, not the time of day. **Founder review
  (2026-10-12), folded into v1.1:** the tape stays, centered, one line, the same place and width on
  every page, hover-labeled; the top bar carries an **App** switch back to Map, Latest, Post and
  Settings (`g a`) and a **staff avatar stack** (lit = present), and no clock; the Overview's cards
  take the height they need and the audit feed fills the rest, with a cost meter; the inbox's
  flow-through list (the next lanes follow the current one, so `j` runs to zero) stays, revisited
  if other staff dislike it; the body console's **left column is read-only and every value is a
  deep link** that opens the right tool and lights the row it names (the inspector needs an
  addressable highlight: `?tab=names&lit=alias:Mascoma`); a dead local run can be **marked
  failed** from Machinery, the reason auto-filled from the diagnostics where they can name it.
  Deeper interaction wireframes are not drawn; the novel interactions (the task round-trip, the
  deep-link highlight, the palette) are prototyped first in code.

## §7 — The questions, and the founder's calls (2026-10-12)

The forks that changed the build, asked with a recommendation each. **The calls** (same day):

1. Inbox is what a person filed; Corpus is what a machine found; email place names are Corpus —
   **yes** (D216).
2. Geometry asks open the one body editor through a task door, never an embedded copy — **yes**
   (D216).
3. Audience and the admin-only line as drawn — **yes, and make access easy to adjust going
   forward** → a capability map in core, read by client and server (D217).
4. Run triggers — **no runner now.** Show where each job runs; trigger what the dashboard can;
   for local jobs show instructions with copy-paste commands (D218).
5. Cost ledger — **both** metered and invoiced; where dollars aren't derivable, record the native
   unit (tokens, minutes, requests); **every** third party if possible; a place for Anthropic and
   Zed bills later (D219).
6. Season statistics — **nightly rollup** if it saves money; **which statistics is decided
   together from a list** → §10, still open (D220).
7. Polygon editing — **pushed indefinitely.** Merge and sub-areas are enough until a lake proves
   otherwise (D221).
8. Splits — **no** (D221).
9. Photo takedown — **yes** (D222).
10. Mute — **withdrawn.** Restricting actions or sign-in is enough control (D222).
11. Per-user flagging permission — **yes** (D222).
12. Seeding the inbox on dev — **yes**; the build invents realistic examples (§8 §2).
13. Sequencing as proposed — **yes**.
14. Names as proposed — **yes, for now**.
15. Mobile bar as proposed — **yes** (D216).

The questions as asked, kept for the record:

1. **Inbox vs. Corpus — the split.** Recommendation: *Inbox* is what a **person** filed (flags,
   access reports, requests, place asks, drawn bodies, tickets); *Corpus* is what a **machine**
   found (intake reasons, duplicates, chord re-fits, email place names, the pre-ice pass). The
   email place names are the gray row: the community's words, loaded by the ETL. Corpus, because
   nobody is waiting on an answer.
2. **"Every task completes from the inbox."** For geometry asks (draw a bay, place a landmark,
   approve a drawn body) the handler *is* the body console in a task mode, opened in place and
   returning on save. Recommendation: same route (`/admin/body/$id?task=`), not an embedded copy —
   one editor, two doors.
3. **Who is this for.** The founder, Matt (admin), and possible volunteer moderators. The
   admin-only line stays where D37 drew it plus imports and seasons; Machinery is admin. Confirm.
4. **Triggering runs from the web.** Convex-native jobs (rollovers, region stats, imagery, weather
   sweeps, analytics) can be triggered now. The ETL (`run-corpus.sh`, `run-canonical.sh`) runs on
   a laptop against gigabytes of extracts. Options: (a) *watch only* — a heartbeat, an event log
   and a stalled state, the CLI stays the trigger; (b) a **runner** — GitHub Actions
   `workflow_dispatch` or a Fly machine pulling archives from R2, started from the console, logs
   streamed back. Recommendation: (a) in this phase with the run vocabulary built for (b); (b) is
   its own decision because it moves the ETL's credentials and 100 GB reads off the laptop.
5. **The cost ledger.** What it records: metered estimates (calls × a rate table, for Open-Meteo,
   ORS, Anthropic, Fly machine-minutes), or manual monthly entries (Convex, Vercel, Clerk, Resend,
   R2 invoices), or both. Recommendation: both, in one `costLedger` table — metered rows written
   by the meters, invoice rows typed in on Machinery — and Season reads it. Which providers matter
   for v1?
6. **Season statistics — stored or computed.** Computing over `reports`, `moderationActions`,
   `importRuns`, `externalApiCalls` at read time is bounded by the season's date range but reads
   whole tables; a nightly per-season rollup is a `seasonSnapshots` table keyed by season and
   metric. Recommendation: extend the existing `metricSnapshots` rollup (Phase 07-2) with a season
   key and the new metrics; compute the change log live from the indexed audit table. **Which
   statistics are must-have for v1?** The brief's list is long; the first season's rollup only
   needs the ones that will be read.
7. **Polygon editing.** In scope for this phase, or a follow-on? It is a new mutation with
   consequences (area, bbox, interior point, weather cells, sub-area clipping, D215's re-fit, the
   next import's merge rules — does an operator-edited outline survive a campaign the way a chosen
   name does?). Recommendation: in this phase as the last workstream, behind an *operator outline*
   that the import respects like `setWaterBodyName`.
8. **Merging bodies from the console** ("join bodies") exists as `waterBodies.merge`; it needs a
   home in the Shape tab and in Corpus → Duplicates. Confirm that a *split* (one body into two) is
   not asked for.
9. **Photo takedown.** Flags on photos exist with no verb. Add a moderation axis to `photos`
   (hide/remove/restore, audited)? Recommendation: yes, it is the one flaggable thing without a
   lever.
10. **Mute.** Does the brief's *mute* mean `canPostComments: false` (exists), a new
    comment-and-thumb silence, or a shadow state (content visible only to its author)? A shadow
    state is a bigger lift and a policy question. Recommendation: mute = comments + thumbs,
    labeled *Mute*, audited; no shadow state.
11. **The user flagging permission** (the founder's `CLAUDE_NOTES` item): a per-user `canFlag`,
    default on, switched off from People. In scope? Recommendation: yes, small.
12. **Seeding the inbox on dev.** Every person-filed queue is empty. A seed script that files
    representative flags, requests, tickets, drawn bodies and place asks from the second dev
    account (`sarah`) is how the inbox gets designed against something real. OK to seed dev?
13. **Sequencing.** This is several PRs. Proposed order (§8): the shell and Overview → Inbox →
    Body console → Corpus → Machinery → Season → People → Instruments and the redirects. The
    season is weeks away; the corpus backlog and the body console are where real work is today;
    the machinery view matters most when the next campaign runs. Reorder?
14. **Naming.** *Body console* for `/admin/body/$id` (the code says "lake editor"); *People* for
    users; *Machinery* for runs and crons; *Instruments* for tuning and calibration. Objections?
15. **Mobile.** Confirm the bar: reachable everywhere, optimized nowhere; the map editor view-only
    on phones.

## §8 — Workstreams (firmed up 2026-10-12; order is the founder's call 13)

Wireframes come first (§6, a static HTML mockup per mode, reviewed before React). Then, one PR
per workstream unless two are small enough to share one; the roadmap entry flips 🟡 at the first.

- **§1 — The shell, the capability map, undo, and Overview.** Undo's backbone (§11) lands here,
  because every later workstream's actions go through it. The console frame (rail, top bar, status
  bar, resizable panes), the command palette, keyboard routing, dark and light; the capability
  map in core with `requireCapability` on the server and the same map gating every control on the
  client, plus the test that holds every gated function to it (D217); Overview with honest counts
  for every lane (indexes where a count needs one) and the audit feed with links. Old routes
  redirect. *The register's first 🟢 rows.*
- **§2 — Inbox, and the seed.** Lanes, the list, the inspector, every handler in §5.2;
  `useReviewWatch` generalized to every item; restore for hidden content; photos'
  `moderationStatus` (D222); the support note and reply with an audit target; the `reviewing`
  status used or removed; **a dev seed** that files realistic flags (every reason, a safety flag,
  an auto flag with occurrences), access reports (one disputing a prior ruling), requests of every
  kind, place asks with a lookalike, a drawn body over a known lake, and tickets of every category,
  from the second dev account — invented by the build, run with `CONVEX_RUN_AS`.
- **§3 — Body console.** The frame over `mapCanvas`; the layer rack; every existing tool re-homed
  into the tabs; the public-access ruling, lot editing, aliases, and **merge into** added (D221:
  no outline editing, no split); task modes (`?task=`); moderators see only what they can do; the
  `RemovalTool` reason bug, the doubled History heading, `window.prompt` renames and the
  `RestoreGate` dead end fixed on the way.
- **§4 — Corpus.** The task lanes with *done* semantics (clearing `reviewReason` on decision; the
  chord re-fit lane across lakes; the pre-ice pass dated); the browser over every body.
- **§5 — Machinery.** The job registry with where-it-runs, trigger or instructions (D218); run
  scope, heartbeat and event stream; the cron list with last outcome and next due; the cost
  ledger (D219) with the meters generalized and the invoice form; the catalog-coverage card;
  `imageryRuns` and `importRuns` read through one list; stalled runs.
- **§6 — Season.** The season page, the per-season rollup (D220, the §10 pick), the change log,
  past seasons; A06i's components re-homed; the cost summary from the ledger.
- **§7 — People.** Browse lists; the detail drawing what `getAdmin` returns; the flagging
  permission; the suspension-expiry and lift-on-deleted bugs; D50's trust-score leak closed; no
  mute (D222).
- **§8 — Instruments and the close.** Tuning and calibration re-homed; the operational-health
  charts; the §1 table all 🟢, the redirects, the roadmap entry closed.

Tests land with each (D40): Vitest for the keyboard, palette and capability models, `convex-test`
for every new query, mutation and index, `fast-check` for the rollup's season bucketing.

## §9 — Decisions minted

D216 (organized by intent; Inbox vs. Corpus; one editor, two doors; the shell; mobile), D217 (the
capability map), D218 (where each job runs; scope, heartbeat, event stream; no runner), D219 (the
cost ledger), D220 (nightly season rollup; the statistics are a §10 pick), D221 (outlines trusted;
merge and sub-areas; no split), D222 (discipline: no mute; photos' moderation axis; `canFlag`). **Added 2026-10-14:** D223 (the visual register: a field, not panels; grayscale ink;
blue means a transient mode; go-mode; the temperature scale; *bodies*), D224 (a clouded pass shown
to skaters, per frame, from the Imagery tab). D225 (Reports, a ninth mode; in-context
moderator controls kept) and D226 (undo for every operator action; a reason only when something is
taken away).

## §10 — Season statistics: the options (picked 2026-10-12: all of tiers 1 and 2)

**The call:** every tier-1 and tier-2 statistic below is in; tier 3 waits for PostHog (D29, the
split recorded on D220 — facts about our own records stay in-house, behavior is PostHog's).

D220 rolls the chosen statistics up nightly per season. The list below is every number the brief
named or the data can give, in three tiers by what it costs to have. The recommendation is the
first two tiers for v1, with the third left until the instrumentation it needs exists for another
reason.

**Tier 1 — free: already stored per season, or one indexed read.** No rollup needed; the Season
page reads them directly.

| Statistic | Source |
| --- | --- |
| Watch opened, first imagery-line night, winter region-wide, watch closed, and what opened it | `imageryIngestSeasons` (A06i) |
| Coldest night per sentinel, first freezing night, nights below the imagery line | `seasonWatchSeries` |
| First and last skated (field dates) | `seasonFieldDates` |
| Imagery: granules queued, landed, empty, failed; frames | `imageryCounts`, `imageryFrames` |
| Hazard recurrence clusters by seasons seen | `hazardRecurrence` (already a metric) |
| The standing rollover's scanned / demoted / retained | the `standing_rollover` run row |

**Tier 2 — cheap: one nightly pass over indexed rows, bounded by the season's dates.** The rollup
(D220) writes one row per statistic per season per night; the page reads the latest.

| Statistic | Source | Why it earns its row |
| --- | --- | --- |
| Reports and posts filed; reports by vantage (on the ice / from shore) | `reports`, `posts` by `skateEndTime` | the headline usage number |
| Distinct contributors; new accounts | `reports` authors, `profiles.createdAt` | the second headline |
| **Most-reported lakes** (top 20, with report and contributor counts) | `reports` by body | the brief's "most popular lakes" |
| Bodies activated, demoted, removed, restored, admitted | `moderationActions` by action + `standing` events | the corpus change log's totals |
| Put-ins, lots, landmarks, sub-areas, features added by operators and by the ETL | audit rows + `importRuns` counts | "new POIs for lakes" |
| Hazards filed, confirmed, archived, merged | `hazards`, `hazardConfirmations`, audit rows | the safety picture |
| Inbox throughput: flags filed and resolved, requests decided, tickets resolved, median time to resolution | `contentFlags`, `waterBodyRequests`, `supportTickets` (two of these are metrics already) | "how are we keeping up" |
| Bounties opened and fulfilled | `bounties` | small, already partly rolled up |
| External calls and cost per provider | the ledger (D219) | "how often we fetched weather and imagery, and what it cost" |
| Notifications pushed and emailed | `notifications` stamps | cheap once indexed; says whether the pipeline ran |
| Photos uploaded and bytes | `photos` | storage is a cost line |

**Tier 3 — needs instrumentation that does not exist.** No client analytics (D29 deferred PostHog;
Phase 07-2 allows one narrow authenticated client signal): sessions, map views, lake page views,
search terms, drive-time notifications tapped, the feed read. Each would be a forward-only counter
or a client signal with its own design, and each is a product question before a statistics one.
**Recommendation:** not in B01; revisit when a product decision wants one.

**Record freezes**, from the brief: the coldest night per season at each sentinel is tier 1; a
*record* across seasons is the minimum over the tier-1 rows, computed at read time. Lake-by-lake
freeze dates do not exist — the watch samples sentinels and a sample of lakes, and D3 forbids
saying a lake froze; the page will say *coldest overnight air low*, never *froze*.

## §11 — Undo (D226): the design (2026-10-14; the founder's calls the same day)

D226 says every operator action undoes, from its toast for ten seconds and from History after
that, and asks a reason only when an action takes something away. This is how, from what the
code records today.

### What exists

- **One audit table, 51 writers.** `moderationActions` (`actorId?`, `action` — 59 verbs,
  `targetType`, `targetId`, `reason`, `metadata: any`, `createdAt`) is written by 51 direct
  `insert` calls in 16 files, with four local `audit()` helpers and no shared one.
- **About a third record what they replaced.** `set_public_access`, `set_posted_access`,
  `set_reference_links`, `set_satellite_imagery`, `set_lake_depth`, `set_water_body_name`,
  `set_standing`, `grant_role`, `revoke_role` and the content `hide`/`remove`/`restore` family
  carry the earlier value (`prev`, `priorStatus`, `priorRole`). The rest record the new value or
  nothing: `set_curated_boost`, `set_weather_sample_points`, `set_parking_area`,
  `set_approach_kind`, `suspend` (no prior status), `set_posting_permission`, `edit_landmark`,
  `rename_sub_area`, `redraw_sub_area` (no prior polygon), `dismiss_duplicate` (no prior group),
  `merge_waterbody` (counts of what moved, not which rows).
- **Half the inverses exist.** hide/remove ↔ restore (content, sub-areas, landmarks), pin ↔
  unpin, suppress ↔ unsuppress, merge ↔ unmerge (hazards), ban/suspend → unban, grant ↔ revoke,
  dismiss ↔ reopen (place names), dormant ↔ active. Missing: reactivate a known feature, unhide a
  put-in, reopen a flag, reopen a request, a rejected drawn body back to review, undo a body merge.
- **Messages already wait.** The only operator action that tells someone anything is a flag
  verdict, and it goes through the A08 queue: it settles 60 s (`SETTLE_MS`) and at flush re-checks
  that the flag still has that resolution. Undo inside a minute already silences it. The mocks'
  "the askers are told" for requests is new behavior (question 3).

### The approach: every verb names its inverse

Not a generic snapshot-and-restore. An undo runs the **inverse verb through the same internal
path the forward action uses**, so its side effects run too: a post's restore brings back the
reports it hid (D186), a sub-area redraw re-stamps reports and hazards, a depth change recomputes
shallow-thaw decay, a ban's lift unlocks Clerk, a weather-grid change resyncs cells. A snapshot
patch would skip all of that and leave derived state wrong.

1. **`lib/audit.ts`, one writer.** `writeAudit(ctx, { action, target, reason, prev, next,
   undoes? })` replaces the 51 inserts. `prev` is typed per verb, so a writer whose inverse needs
   it does not compile without it.
2. **An undo registry in core**, `packages/core/src/undoPolicy.ts`: for each of the 59 verbs, its
   `inverse` (a verb, or `none` with the reason), whether it **takes something away** (D226's
   reason rule, which the reason dialog reads too), and the capability it needs (D217). A test
   holds the registry exhaustive over `MODERATION_ACTIONS`, as D217's test does for gated functions.
3. **`moderation.undo({ actionId, reason? })`**, one mutation. It loads the row, checks the caller
   holds the inverse's capability, checks the row is still current, asks a reason only when the
   inverse takes something away, and dispatches to the inverse's internal helper with `prev`. It
   writes the inverse's own audit row with `undoesActionId` set.
4. **Schema, additive.** `moderationActions.undoesActionId: v.optional(v.id('moderationActions'))`
   with index `by_undoes`, so History shows "undone by @x" without scanning. Widen-only, no
   backfill: old rows have no undo.
5. **"Still current."** A row can be undone if no *later* row on the same target exists other than
   its own undo. Checked inside the mutation, so it is transactional. Otherwise History says what
   overtook it ("@sarah redrew this bay at 14:42") and links there instead of offering Undo.

### Per verb

| Class | Verbs | Undo |
| --- | --- | --- |
| **Toggles** — the inverse exists | hide, remove ↔ restore (report, post, comment, hazard, sub-area, landmark); pin ↔ unpin; suppress ↔ unsuppress; merge ↔ unmerge hazards; ban, suspend → unban; grant ↔ revoke role; dismiss ↔ reopen place name; set_standing; set_included_by_request; promote_body_feature, promote_recurrence → demote | the existing inverse |
| **Setters with `prev`** | set_public_access, set_posted_access, set_reference_links, set_satellite_imagery, set_lake_depth, set_water_body_name | set it back to `prev` |
| **Setters missing `prev`**, added in §1 | set_curated_boost, set_weather_sample_points, set_parking_area (edit), set_approach_kind, set_posting_permission (and the bounty limit), suspend (prior status and `suspendedUntil`), edit_landmark, rename_sub_area | set it back to `prev` |
| **Large `prev`** | redraw_sub_area (a polygon), set_weather_sample_points (a point list) | `prev` kept in a side table `auditSnapshots` (actionId, payload) so the audit row stays small |
| **Creates** | create_sub_area, create_landmark, set_put_in (new), set_parking_area (new) | soft-remove what was created |
| **New inverses**, built where their UI lands | demote_body_feature → reactivate (§3); hide put-in → unhide (§3); resolve_flag, dismiss_flag → reopen (§2); approve, decline request → reopen, plus the body-side row's own undo (§2); reject_waterbody → back to review (§2); approve_waterbody → reject (§2); dismiss_duplicate → re-flag the group from `prev` (§4) | as listed |
| **Change sets** | merge_waterbody (moves reports, hazards, bounties, features, put-ins, favorites, sub-areas, landmarks; deletes duplicate favorites) | record every moved and deleted row in `auditSnapshots` from §1; the unmerge lands with the merge UI in §4. Merges made before this ships can't be undone, and the merge dialog says which kind it is |
| **System rows** | activate_body, demote_body, automatic merge_hazards | undoable by an operator through the same inverse; the undo row names the operator |
| **Not operator actions** | author_delete | a moderator restores the content (it is `remove` underneath); the author's row is not "undone" |
| **Permanent** | finalizing an account deletion (CLI today); purging removed photos after their window, if question 4 says so | no undo; the dialog says so before it runs |
| **Outside the audit table today** | support assign/resolve, season settings, reset watch, field dates | get audit rows in their workstreams (§2 support, §6 season) and join the registry then; settings are already versioned, so their undo is "save the previous version" |

### Who, when, and messages

- **The toast** offers undo of your own last action for ten seconds. **History** offers undo of
  anyone's action to anyone holding the inverse's capability: a moderator can undo a moderator;
  only an admin undoes the removal of a body (restore is admin). Undo is never shown to someone
  who could not perform the inverse (D217).
- **Messages.** Anything an action sends a person goes through the settle queue with a re-read at
  flush, so an undo inside the window cancels it. After it has gone out, an undo changes the state
  and sends nothing on its own.

### In §1, and later

§1 builds `lib/audit.ts` (the 51 writers moved onto it), `prev` on the setters that lack it,
`auditSnapshots`, the registry and its exhaustiveness test, `moderation.undo` for the toggle and
setter classes, `undoesActionId` with `by_undoes`, the toast and History undo in the shell, and the
merge change-set recording. The new inverses land with the screens that use them (§2–§4). Tests:
Vitest for the registry and the reason rule; `convex-test` for each class's round trip (act, undo,
state equals before, side effects included), for "overtaken", and for capability refusals.

### The founder's calls (2026-10-14)

1. The simple rule: a later write on the same target means no undo; History links to it.
2. Yes: anyone holding the inverse's capability can undo anyone's action from History, and the
   undo row names both people.
3. Yes: a skater who asked hears the answer — **email, push and the in-app notifications page**
   (which already exists on web and mobile, A08), through the settle queue so an undo inside the
   window cancels it. Built in §2 as a new notification type on the existing pipeline.
4. Removed photos purge after 30 days (permanent, said in the dialog); everything else stays soft.

### The questions as asked

1. **"A later write means no undo."** Keep that simple rule, or try harder (undo when the later
   write touched different fields)? Recommendation: the simple rule; History links to what
   overtook it.
2. **Undoing another person's action** from History, with the capability check: yes? It is the
   same power as acting, but a different social act. Recommendation: yes, and the undo row names
   both people.
3. **Telling askers about request decisions.** Nothing does today; the mocks assumed it does. Add
   it (through the settle queue, so undo cancels it), or leave requests silent? Recommendation:
   add it in §2; a skater who asked for a lake should hear the answer.
4. **Do removed things ever purge?** Today nothing removed is deleted. The photo-flag mock says
   removed photos leave storage after 30 days (D222). Recommendation: photos purge after 30 days;
   everything else stays soft forever.

## Ruled out

- **A second app or a separate deployment for admin** — D37 stands; the Convex function is the
  boundary, and the console reuses the app's components and map shell.
- **Editable constants in the console** — Phase 07-2's settled decision 1 stands; the instruments
  make the effect legible, the code is where a constant changes.
- **An ETL runner in this phase** — D218; a hosted runner is its own decision, and the run
  vocabulary is built so it can land without a redesign.
- **Polygon editing and splitting a body** — D221; deferred indefinitely, trigger: a lake that
  merge and a sub-area cannot express.
- **Mute and shadow states** — D222; restricting actions or sign-in is enough.
- **Computing season statistics at read time** — D220; a nightly rollup is cheaper.
