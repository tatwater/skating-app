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
| Access report | The lake, every reporter's note, the prior ruling if disputed; *no public access* (its reason asked in a dialog when chosen) / *confirm accessible* / *clear the accessible ruling* |
| Request (five kinds) | What exists today on Requests: the body or the 3DHP candidate, askers, note, *look up again* (only where no candidate matched); approve/decline; approve performs the verb (D179) |
| Place ask (bay, landmark) | The point on the map, lookalikes (D202), *same place*; **draw** opens the body console in bay-mode or landmark-mode with the ask attached; saving approves and returns |
| Drawn body | The polygon over the basemap and aerial, overlap with known bodies; approve, reject, or *merge into* |
| Content flag | The content in place; dismiss, action, hide, remove, **restore** (new: `setModerationStatus('visible')` exists, no UI does) |
| Flag on a user | Links to the person; posting permission, suspend, ban inline |
| Flag on a photo | **New verb needed** — photos have no moderation axis today (§7, question 9) |
| Support ticket | The ticket with its context, the submitter as a link, **a note and a reply** (new; today assign and resolve leave no trail); **no assignee** — anyone pitches in (founder, 2026-10-19); a reply is sent from `SUPPORT_FROM_EMAIL` (support@gli.app until the domain is bought) |

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

**Added 2026-10-16 (founder: yes to both).** Two pieces of new build work the review-2 mocks drew:
a **per-run record for every cron** (today only the imagery pump and the standing rollover leave
one), so a cron's page can list its runs, their outcomes and their durations; and **Fly machine
logs** for the imagery cutters, fetched per granule, so a cutter run has a log to tail like a
corpus run. The Machinery mode is laid out as **Health** (the landing page: what needs a look,
7-day failures, heartbeats, quotas and spend, every job) plus **one page per pipeline**; whether
Notifications, Analytics, Hygiene and Rollovers each keep a page is decided once they are mocked.

**Added 2026-10-17.** The stalled-run alarm's **Keep waiting** snooze starts at **30 minutes**, a
placeholder. Tune it once the heartbeat (D218) records per-flush times: take the longest quiet gap
between flushes in runs that finished normally and set the snooze to 2–3× that. Consider letting
the alarm clear itself on the run's next flush instead of on a fixed timer.

### §5.6 — Season

`/admin/season` is this season: the watch (A06i's card), imagery state, field dates, and the
numbers — reports and posts, active contributors, most-reported lakes, new accounts, bodies
activated, demoted, removed, admitted, POIs added, landmarks named, inbox throughput, fetch counts
and cost — computed over the season's date range (`seasonOf`), with a **corpus change log** read
from `moderationActions` and `importRuns`. `/admin/season/$season` is any past season with the
same shape, plus the watch replay. Settings and reset stay admin (D213). A season record table
(per-season rollups) is a build choice (§7, question 6).

**Added 2026-11-11 (D246).** The imagery card carries a **bake staleness counter**: active bodies
missing from this season's bake (an *activate*, *admit* or *restore* approved after bake day gets
no imagery until a re-bake), and the reverse — baked bodies since shelved, which keep being cut for
free. Both counts sit beside the bake's date, with the re-bake pair (`bake-masks --upload`,
`publish-search-plan`) named right there; zero-zero draws quiet. D246 holds the why and the read's
open build choice (the bake's member list lives in R2, not Convex).

### §5.7 — People

Search as today, plus browse lists: moderators and admins, suspended (with *until*), banned,
flagged, newest, leaving. The detail renders what `getAdmin` already returns and nobody draws —
the audit history, `suspendedUntil`, comments, bounty points — beside the trend; the levers; the
role card (admin); open inbox items about this person. New levers, if the founder wants them: mute
(a comment-only restriction already exists as `canPostComments`; "mute" may be that), restore
hidden content by this person, and a per-user *flagging* permission (the founder's own note in
`CLAUDE_NOTES`: a lever to stop someone flooding the queue).

**Added 2026-10-17 (D227, refined).** An admin's page carries an **invoice editing** row, drawn
only for a viewer who holds that grant and isn't on their way out — `getAdmin` sends `ledgerEditor`
and `lastLedgerEditor` to that viewer alone, so a non-holder learns neither the row nor who holds it
(founder call, 2026-10-18); `lastLedgerEditor` says why the last holder's switch can't be turned
off. The server half is built (`ledger.grantEditor` / `revokeEditor` / `seedEditor`,
`lib/ledgerEditors.ts`); the row lands with this workstream's screen. **Seed at this branch's first
dev push** (the founder is `@admin1` there, an admin with no grant as of 2026-10-18):
`pnpm --filter @skating/convex exec convex run ledger:seedEditor '{"username":"admin1"}'`; prod's
`@teagan` is a step in `docs/deployment-and-release.md`'s cutover.

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
  **Review 3 (2026-10-18/19).** The founder's third read (184 comments) moved the console to its own
  Paper file, *Gli · Admin console*, one row per rail item (the old file had reached Paper's size
  limit); what changed is in the admin-variants README, *Review 3 in Paper*. The calls that bind the
  build: **keys** — no number keys or J/K; Tab between panels, ↑↓ within one, type-ahead in a list;
  ⏎ or Space on a list item opens it *and moves focus into the right pane*, and single-letter action
  keys act only while that pane has focus, so typing in a list never fires an action; ⌘K and
  G-then-a-letter go anywhere; ⇧⏎ returns to the queue. **Green is sparing** — success stays the
  quiet state. **Ledger editing** covers rates as well as invoices, a backdated rate reprices every
  day since, and every admin reads the ledger (D227, widened). **Changed after posting** lists a
  report when its author edits a claim field (thickness, surface, the where) an hour or more after
  posting, or after anyone else commented, voted or flagged; rewording never lists it, and listing
  never flags or hides. **Expert** stays the derived trust class's tag. Staff in the mocks are
  Sarah Berman and Matt Steinberg. **The Overview splits into two tabs (2026-10-19):** *Home* is what
  needs a person (the stats, the four lane cards, then cost beside the audit feed); *Metrics* is how
  staff are keeping up (open and oldest flags, time to resolve, open support tickets by day) and
  whether people are showing up (the season pulse, accounts, sign-ins, contributors, vantage, the
  most-reported bodies, coverage by state). Its instruments move out of Tuning, which keeps only how
  things are calculated; the sentinel lows leave the Overview (Season has them). Metrics' top stats
  are the last seven days (or now); everything under them is the season. **What Metrics needs that
  doesn't exist yet:** *signed in* and *came back* (on two days or more of the last seven) need a
  one-row-per-person-per-day sign-in record (`pushTokens.lastSeenAt` keeps only the latest open);
  *open support tickets by day* needs a queue-depth rollup like `flag_queue_depth`
  (`support_volume` counts only opened); per-state comments, photos, kudos and contributors widen
  `state_coverage`; and `active_contributors` widens (founder, 2026-10-19) from report and hazard
  authors to anyone who posted a report, hazard, comment or photo — kudos and thumbs are reactions
  and count only as *signed in*. Home's cost reads by service (hosting, Anthropic · TypeSafe summed
  as *AI*, Fly as *compute*, then each free tier against its ceiling), and its by-month bars are
  always the last three full months and this one; the ledger has the rest. The weather-strip coverage figure goes back to Tuning,
  since it tunes the strip's window. "Reports from the email groups" waits on either half of the
  bridge (Q8). **The live mark** (the feed's and the status bar's): hover shows *Last checked* to the
  second, a spinner and *Checking* while a request is in flight; quiet past three times the expected
  interval, it goes hollow, reads *Not live* and offers a refresh. Which Convex signal stands in for
  "checked" is settled in the build. **The Inbox pass (2026-10-19)** set rules for every board:
  filter tabs carry no counts (a filter menu's options keep theirs); a list's filter bar sits 10 px
  in; the action bar floats at its pane's foot, tight to its buttons, 8 px clear of the status bar
  and both sides; a button's key is its label's letter (Admit A, Decline D, Same place S, Draw in
  Body B, Approve as new A, Reject R, Resolve R, Retract R, No public access N; ⌘⏎ still sends); a
  bare age reads "4 d ago"; access rulings say *accessible*, never *open*; the App link moves to the
  rail above the viewer's avatar; a sheet's scrim covers the rail and the status bar; map embeds pan
  and zoom inside their body's reach. A pane head's *History →* named no place: an item's history
  (D226) lives on its own page — the report's in Reports, the body's in the Body console, the
  person's in People — so the link names that page. A lookalike has no outer radius, as built
  (`landmarkAskLookalikes`): the nearest same-named place on the lake that the same-place rule
  doesn't already merge, shown with its distance. **The second pass (2026-10-24)** added: every
  button in an action bar rests alike (none looks primary until focused or armed); a one-action
  bar (Open in Body, Resolve) spans its pane with the button grown to fill it; a pane head never
  repeats what the pane shows (no asker's name over the ask list, no "Flag" or occurrence count
  over the flag and author blocks); a table sorts by clicking a column heading (lit, with its
  arrow; a search ranks by match), not a sort menu; a focused boxed input brightens a step, never
  to white; a support ticket's reply spans the thread column with *Send reply* inside it, under a
  fixed edge-to-edge rule, and *Resolve* is the side column's own bar; an access alert's life is a
  strip map (evenly spaced events, the line's weight the alert's state, days on the line) so any
  number of confirmations fits. A report's vantage is on the ice, from shore or secondhand —
  nothing else. **The third pass (2026-10-25)** added: a pane head writes its age out ("4 days
  ago"; list rows keep "4 d"); whoever took an action goes on its own line under it (a person
  lockup), never after a "·" on the action's line; a link on a list row sits in the row's
  bottom-right corner, clear of its chips; a tooltip's dotted rule hugs its text. Machinery's
  lanes put the Cost ledger second, under Health. **Machinery's first pass (2026-10-25)** added: an
  action bar never carries an explaining line — a button's tooltip says what it does, on hover and
  focus; a run history's foot is Run now with a key or nothing, its strip spans the sheet, and it
  filters to failed runs; the cost ledger lands everyone on its invoices, and a holder edits by
  clicking a month's cell (filled: edit, empty: add); Rates is a sheet over the ledger, with Change
  rate a second, narrower sheet on top. The Body console and the round trip await their
  first read.
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

### The founder's calls before slice one (2026-11-10)

Asked while the branch was readied for the first slice (§12.7). **The calls:**

1. **Transition navigation is rail option (a):** the rail carries the modes as they are built, plus
   a temporary **Legacy** group for the old pages still standing. A mode that lands takes its old
   pages out of Legacy (§12.7's progressive replacement); the group goes with the last of them.
2. **Metrics lands only what can't be backfilled.** B01-1 adds the two write paths whose history is
   lost for every day they don't run — the per-day sign-in record and the support queue-depth
   rollup. The widenings (`state_coverage` per state, `active_contributors` to anyone who posted)
   wait.
3. **Saira and Martian Mono go app-wide**, self-hosted through `@fontsource-variable`, in a
   standalone PR to main ahead of B01-1 — not a console-only load.
4. **The console's map uses the same token system** under `data-surface="admin"`, expressed as
   the boards' look.
5. **Typed console analytics events are deferred.** Pageviews, with the `surface: 'admin'` stamp
   PostHog already applies (D240), suffice for now.
6. **The sweep branch is ported here, then retires.** `fix/standing-putins-summary-sweep`'s three
   commits — a saved put-in keeps a body active through the rollover, the map-card sweep reads only
   the cards that are due, and a failed backfill walk waits six hours — land on this branch. The
   put-in decision, D228 on that branch, is **D245** here: D228–D231 belong to Phase B02.

**Pondered, not decided: Reports may become *Content*** (founder, 2026-11-10 — a direction, not a
decision). The mode now called Reports may be renamed **Content**: the full library of everything
people generate — posts, reports and hazards, comments, photos, and later perhaps events,
announcements and a marketplace — for exploring, grouping, filtering, searching, correcting,
amending and hiding. **The Inbox stays the one place** for flags, contradictions and asks that need
a moderator to act promptly. Slice one builds neither mode, and the rail's Legacy group bakes in no
name for it; the D# is minted when the mode is built and the name firms up.

### The founder's calls of 2026-11-13

The first two were asked by the Overview's Metrics build and govern its read queries when they
land; the third came out of the #108 review. **The calls:**

1. **The Metrics season window starts 1 October.** The data season resets on 1 July, and only for
   data cleanliness; the season as any skater thinks of it starts in late fall — the watch opens
   1 October, and ice rarely comes before November. The dashboard shows the watch, so the Metrics
   charts' season window runs from 1 October, not from the data season's 1 July.
2. **Kudos are positive reactions, and *helpful* counts as one.** Reports keep thumbs up and down
   for helpfulness, and the door stays open for social-style reactions on posts later, kudos being
   the easy starter. A thumbs-up (*helpful*) is a kudos; a thumbs-down is not an anti-kudos and
   never lowers a post's kudos count. So the Metrics kudos strip reads the count of positive
   reactions — today the helpful ratings in `reportRatings`, which needs a by-time index to read by
   day (backfillable, so it waits for the reads) — and the metric is named and shaped for positive
   reactions in general, so later reaction kinds join it without a rename.
3. **A Post is never shown with none of its Reports** (D247; the #108 review). D186 says a Post requires
   a Report; the Report→Post direction already kept that, and the Post→ direction now does too: a
   Post is never stored visible unless at least one member is visible after the same mutation,
   decided before anything is written. A restore that would bring a Post back empty is **refused
   with a message**; an undo that would is refused too and points at Restore — **undo stays a pure
   inverse and never takes choices**. Restore instead takes a **choice of Reports to bring back
   with the Post**, in one mutation, each with its own row naming the Post, so the restore's undo
   is still the exact inverse. The chooser lists the Post's Reports — what each is, why it is down
   — with nothing pre-selected, since each takedown was a decision and bringing one back is a
   conscious override. **Reports their author deleted are never restored through a Post** (the
   2026-09-21 call: people control what they shared); they are shown, not choosable, and a Post
   whose every Report its author deleted can't be restored. (A moderator's per-Report restore of an
   author-deleted Report is untouched by this call — superseded by call 4.)
4. **Author deletions are final, verdicts outlive content, deleted content is erased at 30 days
   unless held, and a filed request can be retracted until it is decided** (D248). "Any
   author-deleted content should not be able to come back, no moderator should be able to restore
   it"; a user "shouldn't be able to delete their comment and thereby remove evidence of their bad
   behavior, which would influence future penalties"; a deletion is honored for real after 30 days
   "if no moderator action is taken during that time", so "people's mistakes don't live on for
   perpetuity"; and a person can retract what they filed "up until the action is determined/taken."
   Part A (final) lands in #108; Parts B (the verdict record), C (the erasure) and D (retraction)
   land together in the next PR.
5. **What an erased Report takes with it** (D248, answering the three calls the erasure waited on):
   the hazards drawn in it stay exactly as they are, only unlinked — "a live warning others
   confirmed" is not the author's to take down by deleting a Report; its linked recording returns to
   the author's private recordings ("they deleted the Report, not the recording"); its point events
   stay — they carry none of its content, and removing them would penalize deleting.
6. **A hazard is the author's to withdraw until someone else has said it is there** (D248): "any
   hazard that has confirmations from other users shouldn't be able to be deleted, only hazards that
   are either disputed or have no interactions at all." And **an alert's author's "it's open" wins**
   over a moderator's pin — a skater reports an unplowed lot, a moderator pins it, the skater later
   sees it plowed; resolved, never retracted, with a history entry so the moderator can re-pin.

### The governor's rulings at the Overview's integration (2026-11-13)

Made while B01-2 integrated Home, Metrics and the shell; the founder may overturn any of them.

1. **"Open flags" counts `reviewing` everywhere.** A flag a moderator has opened but not decided
   is still open — on Home's Inbox card, the heads row, and Metrics' *Open flags* and *Oldest open
   flag*. The server reads that count today in more than one place; unifying them on one
   definition is owed to the server agent (the B01-2 server register, §12.8).
2. **The oldest open flag turns red at 72 hours — provisionally** (`OLDEST_FLAG_BAD_HOURS`), until
   the founder reviews it with real queue data.
3. **A most-reported row clicks through to that body's Body console** (the old lake editor until
   the Body console lands).
4. **The old dashboard lives at `/admin/dashboard`, under Legacy,** until Instruments and Machinery
   are built and carry what it draws (the queue tiles, app health, the base map's provenance, the
   recent actions). The Overview took `/admin`; nothing the old page showed is out of reach.

### The founder's calls on the B01-2 integration (2026-11-13)

Asked by the integration's report. **The calls:**

1. **From 1 July to 1 October the Overview shows the new season, empty.** *"We should show empty
   new season state from Jul 1 -> Oct 1. The user should have to explicitly choose a previous
   season in order to see its data."* The season's identity flips on 1 July with the data season
   (D63); its chart window still starts 1 October (the call above); between the two the window is
   empty and every season-ranged block says when the season's record begins — the watch *Waiting,
   counting nights from 1 Oct*, every other block *Record begins 1 Oct* — and nothing about the
   ice (D3). This reverses the integration's first rule, which kept the previous 1 October through
   the summer. A past season is reached only by choosing it; no chooser is built until the reads
   behind it exist (M10 in the B01-2 server register, §12.8).
2. **B01-2 ships as one PR, its size accepted:** *"this size is fine for the goal we set out to
   accomplish in this PR."* The review boundary is the console shell and its first page.
3. **The dim lamp stands for *not live*** until the kit's live `Badge` and `StatusLamp` have a
   hollow state (the kit extensions owed, §12.8).

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
- **§7 — People.** The person's content record (`contentRecord.personContentRecord`, D248, built
  server-side in B01-1b): the standing verdicts with the content still kept, labeled when its author
  deleted it afterward, and the recently withdrawn list with each item's erasure date; the controls
  to record a verdict on deleted content and to overturn one (`moderation.overturnVerdict`).
  Browse lists; the detail drawing what `getAdmin` returns; the flagging
  permission; the suspension-expiry and lift-on-deleted bugs; D50's trust-score leak closed; no
  mute (D222).
- **§8 — Instruments and the close.** Tuning and calibration re-homed; the operational-health
  charts; the §1 table all 🟢, the redirects, the roadmap entry closed.

Tests land with each (D40): Vitest for the keyboard, palette and capability models, `convex-test`
for every new query, mutation and index, `fast-check` for the rollup's season bucketing.

## Component kit checklist (2026-11-06)

The founder's call (2026-11-06): the kit is tracked here, not in Linear. One row per kit component,
admin-first, in `apps/web/src/components/kit/`. shadcn's raw installs stay in `components/ui/` as
the base; a kit file re-skins one and is what everything imports. Sources: the 57-pattern map in
`skating-mockups/web-stack-research/shadcn-vs-designs.md` (its `#n` and its `R…` rule references
are used below) and `plans/research/web-frontend-stack-2026-10-30.md` §2.

**Rules for every row:**

- **Tokens only** (D232). Semantic tokens from `@skating/design`; no raw color, and px only for
  borders, hairlines, radii and fixed-stroke drawing (D233). Pressable things take
  `radius.control` (admin 0, skater 2 px); containers take `radius.container` (square on both);
  keyboard hints take `radius.key` (3 px); people and dots take `radius.full`.
- **Props, not Convex.** A kit component never calls a Convex hook; routes and surface
  compositions (`components/admin/*`, `components/skater/*`) fetch and pass data down.
- **A four-up story for every component** (all four surface × mode maps), each story a board state
  and a Vitest test. **Junction tests** (`kit/measure.ts`, D234) wherever the component sets space
  between content: a label to its edge, a heading to its content, a key inside its button.
- **Loading states reserve final dimensions**, so nothing shifts as content fills.
- **`prefers-reduced-motion`** honored by every transition, with timing from the motion tokens.
- **Base UI, never Radix**; after every `shadcn add`, swap lucide for FontAwesome Sharp and declare
  any new direct dependency.
- **Status:** ✅ in the kit with its story and tests · 🟡 in progress · ⚪ not started.

### Re-skinned shadcn atoms

| Component | Status | Built from | Surfaces | Rules it breaks or follows |
|---|---|---|---|---|
| Button (+ `nav` chip variant) | ✅ | shadcn Button | both | 10 px caps, tracked; focus and hover = the corner-dot primary look (R3#1); destructive outlined at rest, red on hover or armed (two-press); no underlined link variant (R2#3); no press nudge; equal heights and the arrow pad as variants, not JS (#22, #23; D233, D234) |
| Kbd / KbdGroup | ✅ | shadcn Kbd | both | Mono, `radius.key`; dim, lit and go (ice) states; never makes its button taller (R9#2); an input's ⏎ shows only while it has focus (R14#3) (#7) |
| Badge | ✅ | shadcn Badge | both | Square, not pill; solid dim/amber/red/lit; two states = two badges, never a bullet inside one (R14#4); a live LED has no box; green sparing (#42) |
| Avatar (+ group) | ✅ | shadcn Avatar | both | Circles for people (R1); the top bar's faces never include the viewer; reconcile with `components/Avatar.tsx` (#5, #43) |
| Tooltip | ✅ | shadcn Tooltip | both | Not inverted: g1/g2 plate, g4 edge, kicker title, no arrow, square; **never in navigation** (R11#1); the trigger's dotted rule hugs the text (#27) |
| Tabs | ✅ | shadcn Tabs | both | Joined boxes, the chosen one filled; no pill, no shadow; rich run tabs allowed; no tooltips in a tab row (#16) |
| ToggleGroup (filter tabs, segmented) | ✅ | shadcn ToggleGroup | both | **No counts on filter tabs** (R4–7); a key hint sits on a two-way toggle's inactive option (R9#15); choices are never "A · B · C" text (R2#10) (#14, #17) |
| Switch | ✅ | shadcn Switch | admin | 20 × 10 with a 6 px knob, `radius.toggle`; disabled is dashed with no knob, not faded (R13#4); a layer row is Switch + label + Kbd as one control (#36) |
| RadioGroup | ✅ | shadcn Radio Group | admin | Whole-row items; a chosen cell lights the whole cell (R8); picking moves the pick, only the bar's button applies it (#37) |
| Checkbox (+ Checkbox Group) | ✅ | shadcn Checkbox + Base UI Checkbox Group | admin | Square 14 px, FontAwesome check; "restore all" parent state (#38) |
| Slider | ✅ | shadcn Slider | both | A grippy rectangular thumb, not a ringed knob; ticks drawn by us (Base UI has no marks); align `FreezeUpScrubber` (#39) |
| Select | ✅ | shadcn Select | both | Underline trigger, not boxed (R14#2); FontAwesome Sharp Regular angle-down (#30) |
| Input + InputGroup + Field | ✅ | shadcn Input, Input Group, Field | both | **The underline input is the standard** (R14#2): placeholder g5, white rule on focus, no ring; autosave meta (typing, saving, saved, not saved) (#32) |
| Textarea | ✅ | shadcn Textarea | admin | Boxed; focus brightens the edge to g6, never white, no ring (R4–7) (#33) |
| DropdownMenu | ✅ | shadcn Dropdown Menu | both | Square, g1 plate, g4 edge, 30 px rows, 12 px text; no check or shortcut columns unless used (#29) |
| Popover | ✅ | shadcn Popover | both | Square container; hosts the Bodies lookup (no ice: not a mode), the Filter menu and the month grid (#10, #15, #31) |
| ButtonGroup | ✅ | shadcn Button Group | admin | Joined, shared edge, square: split buttons, the map's zoom pair, a cron's buttons (#24) |
| Table | ✅ | shadcn Table + TanStack Table | admin | No forced overflow wrapper; a row washes only if it's clickable (R3#3); dotted rows under a solid head rule; sort by clicking a heading (R4–7); rules unbroken, in CSS (R8); 20 px outer cells (#19) |
| Resizable | ✅ | shadcn Resizable (react-resizable-panels v4) | admin | Widths in a cookie read on the server, so nothing shifts on load; panes stack below `lg` (research §5) |
| Toast | ✅ | shadcn Toast (Base UI Toast) | both | Bottom-left at the rail's edge, over the status bar; Undo with ⌘Z, a countdown and a 2 px time bar, 10 s (D226); swipe and stack motion subdued (#44) |
| AlertDialog (the reason dialog) | ✅ | shadcn Alert Dialog | admin | **Not Dialog.** A reason only when something is taken away; restore and approve ask nothing (D226, R4–7); armed two-press, typed confirmation, server refusal; ⌘⏎ confirms; no blur, no ×, no zoom; `ReasonDialog` moves onto it (#45) |
| Sheet | ✅ | shadcn Sheet | both | Scrim over `main` only, no blur; no default × (the head carries Close + Esc); fixed width per sheet; stacked sheets; never the floating bar (R8) (#26, #46) |
| Dialog (viewer modal, inset card) | ✅ | shadcn Dialog | admin | Viewer: scrim over everything, ←/→, inset 32 px (#47). Inset card: portaled into the inspector with focus trapped, the map live beside it (R14#10) (#48) |
| Collapsible | ✅ | shadcn Collapsible | admin | FontAwesome chevrons (#49) |
| ScrollArea | ✅ | shadcn Scroll Area | both | Thumb visible in a still render; replaces `trimFades` (#50) |
| Separator | ✅ | shadcn Separator | admin | The status bar's vertical rule (#6) |
| Combobox with chips | ✅ | shadcn Combobox (Base UI chips) | admin | Aliases with free-text create; verify Base UI supports it, else Autocomplete + custom chips (#35) |
| Chart | ✅ | shadcn Chart (Recharts v3) | both | `--chart-*` mapped to the grayscale + meaning accents; hover hairline + plate (R3#6); nothing clips at the edge; unbroken gridlines (R11#9) (#53) |
| Skeleton | ✅ | shadcn Skeleton | both | Holds the final box exactly; no shimmer under reduced motion |
| Drawer | ✅ | shadcn Drawer | skater | The mobile bottom sheet; verify it's Base UI Drawer, not `vaul`, before adding |

### Base UI primitives shadcn doesn't wrap

| Component | Status | Built from | Surfaces | Rules it breaks or follows |
|---|---|---|---|---|
| Meter | ✅ | Base UI Meter | admin | The 4 px quota bar, one height everywhere (R3); amber and red at thresholds; `role=meter`, not Progress (#40) |
| NumberField | ✅ | Base UI Number Field | admin | The input holds only its number, the unit hangs outside (R10#4); steppers hidden, arrow keys kept, scrub off; the saved value shows only on changed rows (R10#5) (#34) |
| Toolbar (the action bar) | ✅ | Base UI Toolbar | admin | `role=toolbar`, arrows between buttons; every button rests alike, the focused or armed one takes the primary look; no explaining line or reason input (R4–7); a one-action bar's button is outlined (R11#4) (#25) |
| Command palette (⌘K) | ✅ | Base UI Autocomplete in a Dialog | admin | Not shadcn Command: cmdk pulls Radix and fights server-side Convex search; always-open list; keys only on the selected row; ⇥ to actions; ice edge (a transient mode, R9#12) (#9) |

### Custom, no primitive

| Component | Status | Built from | Surfaces | Rules it breaks or follows |
|---|---|---|---|---|
| App shell (rail, top bar, status bar, panes) | ✅ | custom: CSS grid + Router layout routes | admin | Not shadcn Sidebar: the rail never collapses and takes no ⌘B (#1) |
| Rail item + count badge | ✅ | custom: Router `<Link>` + Badge + Avatar | admin | No tooltips in navigation (R11#1); the count is a square mono badge, gray/amber/red; on = white edge + glow; app links open a new tab (#2) |
| Top bar parts: season tape, search trigger, colleague faces | ✅ | custom + Tooltip + Avatar | admin | The search is a button dressed as an underline input (R14#2); the tape's marks get real tooltips, not `title` (#3, #4, #5) |
| Status bar + key registry | ✅ | custom + Kbd + Separator | admin | Keys per page and per focus; a key a button already wears isn't repeated (R12); the lamp's pulse respects reduced motion (#6) |
| Go-mode + hotkey layer | ✅ | custom, behind one `lib/keys.ts` | admin | `G` then a letter anywhere; letters act only in the focused pane (R3); no J/K, no number keys; composites' own arrow keys never leak to the page (#8, #56) |
| Lanes sidebar | ✅ | custom: Router links + roving focus | admin | Picks *which list*; facets never go here (R4–7); no tooltips (#11) |
| Selectable middle list | ✅ | custom listbox (roving tabindex) + ScrollArea | admin | Type-ahead; ⏎/Space opens and moves focus to the right pane (R3); the wash only on interactive rows (R3#3); a locked row at half opacity; the decided list 32 px below (#12) |
| List-end tab | ✅ | custom (measured SVG or clip-path) | admin | Not shadcn Empty: an empty list still says what it is (R1); replaces `drawEndMarks` (#13) |
| Section slug (section title) | ✅ | custom typography | both | A heading sits 12 px over its content (junction-tested); the count replaces the square terminal (R14#5) (#18) |
| Stat tile + value-with-unit | ✅ | custom (from `admin/adminUi.tsx` `StatTile`) | admin | Not Card; a unit 7 px from its value with no space character, in the gray slot (R8, R3#5); replaces `unitGaps` (#21) |
| Grid lists (key/value, history with Undo, invoices) | ✅ | custom CSS grid | admin | Rules unbroken across column gaps (R8): dividers are padding, never margin (R9#5) (#20) |
| Plates / cards | ✅ | custom (corner ticks) | admin | Chosen = a 1 px border, never a thick top edge (R9#7); `radius.container` (#55) |
| Notes and banners | ✅ | custom | admin | A 2 px left rule, no fill, gray/amber/red; the "decided while you looked" lock banner (#52) |
| Log + run error block | ✅ | ScrollArea + custom lines | admin | The live line on a white rule; a failing line red-washed; Follow + Copy split (#50, #51) |
| Map controls (layer rack, zoom pair, scale, mode bar, hover plate) | ✅ | custom MapLibre controls + Switch, ButtonGroup, Kbd | admin | Scale on the map (R12#4); UI 56 px up (R13#5); the mode bar in ice; one hover plate per board where hover is the point (R14#1); real geography (R11#5) (#28, #54) |
| Matrix and trace charts (temperature matrix, season traces, sparkbars, LED segments, stage bar) | ✅ | custom SVG / CSS grid | admin | The temperature scale tokens; ice only for water and transient modes (R9#12, D223); translucent marks bound for Paper need `rgba()` fills (#41, #53) |
| Mobile bar | ⚪ | custom nav + ToggleGroup chips | admin | A later phase (#57) |
| Map key (`map-key`) | ✅ | custom; promoted from the skater map (B01-2) | both | A slim bar on the map's bottom edge; lists only what the map draws; a name is a noun for what the mark is, never a word about the ice (D3); scrolls at phone width, never wraps; `MAP_FOOT_ROOM` lifts the foot controls over it |
| Map marks (`map-marks`) | ✅ | custom SVG; promoted from the skater map (B01-2) | both | Put-in, lot, photo and hazard in its three tones — the key's glyphs and the Body boards' marks are one drawing; `HazardTone` is the marks' own type |
| Search parts (`search-parts`) | ✅ | custom on Base UI Autocomplete; promoted from `GlobalSearch` (B01-2) | both | `FootKey` (one dim cap per key), `SearchGroupLabel` (`plate` / `palette` looks, optional count and rule), `SearchStatus` (spinner, else the caller's note); the rows stay each list's own; one popover plate (`POPOVER_PLATE`) so the two can't drift |

**Count:** 54 components: 30 re-skinned shadcn atoms, 4 Base UI primitives, 20 custom. Fifty-three
are done; the mobile bar waits for a later phase.

**The kit review's first batch (§12.7), as integrated in B01-2 (2026-11-13):**

| Candidate | Outcome |
|---|---|
| `useIsPhone` | Moved to `lib/usePhoneLayout.ts` with `useIsMidWidth`, on one media-query store (`lib/mediaQuery.ts`) shared with `useCoarsePointer` — surface-neutral, so `lib`, not the kit |
| `SkaterPair` | One `ThemePair` in `.storybook/theme.tsx`, parameterized by surface, beside the four-up and its one token copy; `SkaterPair` is that pair bound to the skater surface |
| The grouped-autocomplete search | Its shared parts promoted as `search-parts` (above); the lists stay each caller's |
| The map key and its marks | Promoted as `map-key` and `map-marks` (above) — not on §12.7's list; the Body boards draw them |
| `InsetCard` (+ `useCardMechanics`) | **Deferred** to the Body console, whose landmark editor, *Drop a Landmark* and *Link a Lot* are its first console uses |
| `ReportCard` | **Deferred** to the Body console's reports, then Inbox and Reports |
| `CodeInput` | **Deferred** until a console board needs it; none in slice one does |
| `INK_PRIMARY` | **Ruled out:** the surfaces' primaries deliberately differ, so one shared constant would be wrong for one of them |

## §9 — Decisions minted

D216 (organized by intent; Inbox vs. Corpus; one editor, two doors; the shell; mobile), D217 (the
capability map), D218 (where each job runs; scope, heartbeat, event stream; no runner), D219 (the
cost ledger), D220 (nightly season rollup; the statistics are a §10 pick), D221 (outlines trusted;
merge and sub-areas; no split), D222 (discipline: no mute; photos' moderation axis; `canFlag`). **Added 2026-10-14:** D223 (the visual register: a field, not panels; grayscale ink;
blue means a transient mode; go-mode; the temperature scale; *bodies*), D224 (a clouded pass shown
to skaters, per frame, from the Imagery tab). D225 (Reports, a ninth mode; in-context
moderator controls kept) and D226 (undo for every operator action; a reason only when something is
taken away). **Added 2026-10-16:** D227 (invoices edited by named people — Teagan from the start — not a role). **Refined 2026-10-17:** D227's grant is a row on an admin's People page that only a holder sees and changes; never no holder; a demotion clears it. **Ported 2026-11-10:** D245 (a saved put-in keeps a body active through the standing rollover; minted on the sweep branch as D228, §7).

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
2. **An undo registry**, `packages/convex/convex/lib/undoPolicy.ts` (beside `MODERATION_ACTIONS`;
   History rows carry `canUndo` and `needsReason` from the server, so the client needs no copy): for each of the 59 verbs, its
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

### What §1 built (2026-10-14)

`lib/audit.ts` is the only audit writer (`writeAudit`, plus `writeSnapshot`/`readSnapshot` for
`auditSnapshots`); `lib/undoPolicy.ts` is the registry, `lib/undo.ts` the engine, `undo.run` and
`undo.latestOwn` the API, and `lib/undoHandlers*.ts` the handlers; `listActions` rows carry each
row's undo state for the viewer, and `blocked(row, viewer)` hides an undo the viewer could never run
(a change to their own role). Undoable now: content hide/remove/restore (a Post with its members),
ban, suspend, lift, posting rights and the bounty limit, role changes, every body setter
(boost, links, name, depth, satellite link, weather grid, access ruling, included-by-request),
standing, a body's removal (admin), sub-area create/redraw/rename/remove/restore, landmark
create/edit/remove/restore, access pins, approach overrides, posted rules, promotions, recurrence
suppression, hazard merges. Body merges write their change set to `auditSnapshots` (the ETL's merges
too). `undoOwed()` lists what §2–§4 still owe.

**What some undos leave behind** — each is the forward verb's own behavior, kept rather than patched
around:
- Flags a no-public-access ruling closed stay closed after its undo (reopening flags is §2).
- An undone dormancy restarts its clock; a body restore clears any stored dormancy.
- A sub-area redraw's undo puts the outline and mouth back but not `mouthStale`, `mouthReview`,
  `systemDelistReason` or the cleared derived depth; landmarks the redraw retired stay retired.
- Undoing a sub-area create does not reopen the request it answered or restore a promoted landmark.
- Undoing a hazard merge also keeps the pair from auto-merging again (the unmerge verb's rule).
- Rows the engine can't see change — an author's own retraction, an ETL re-route — are checked when
  the undo runs, not when History draws it.
- **Added 2026-10-17 (D227).** Undoing an invoice editor's demotion gives back the admin role, not
  invoice editing: the demotion cleared the grant with its own row first, and that row has no undo
  of its own. A holder gives it again.
- **Added 2026-11-13 (founder call).** A landmark restore records what it cleared (`prev`: the
  removal time, the catalogs' drop, a merge's fold, the moderator stamp), and its undo puts exactly
  that back: a catalog-dropped label returns to the catalogs, a folded one returns folded into its
  twin — and that removal, like the merge's own, comes back only with the merge. A restore from
  before `prev` is refused rather than turned into a person's removal.
- **Added 2026-11-13 (#108 review).** Two writes the audit log can't see are checked against the
  row when the undo runs: a depth undo refuses once the import has rewritten the depth since (each
  `set_lake_depth` row records `after`), and an unpin's undo refuses a claim the community resolved
  or whose clock ran out before the sweep.

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

## §12 — The build model

*Ported 2026-11-07 from B03, which built the skater web app with one governor and parallel agents
(`plans/phases/B03-skater-web.md` on main: §5 the model, §7 the mechanics, §8 what the build
found), with the corrections the founder made after it.* §8 above says what to build; this says how.
Where B03's doc and this one disagree, this one is B01's rule.

### §12.1 — The model

- **One governor thread (Fable): decisions, briefs, reports, the founder.** It reads plans and
  reports, briefs delegates, makes the integration and fork calls, and talks to the founder. It
  **never implements**. B03's governor built the wave-0 foundations itself and the founder corrected
  it mid-phase: every hands-on task goes to an Opus-high delegate, *including* what a plan assigns to
  "the governor" — foundations commits, seam mounts, cherry-picks, suite runs, lint, doc and register
  edits. Two budgets at once: the governor's context has to last the phase, and Fable tokens cost
  more than Opus tokens for work Opus does as well.
- **Builders are Opus 5.5 at high effort, each in its own worktree cut from the phase branch**,
  owning a disjoint file territory (§12.3). An agent starts the moment its "needs" are integrated,
  not in lockstep waves, so the machine stays busy instead of draining between them; 6–8 at once is
  B03's proven ceiling.
- **One writer per push target at a time.** The phase branch has one integrator; a PR branch has
  one pusher. B03's near-miss was a second writer reaching for a PR ref already under review; after
  it, a frozen ref is named in every brief that could touch it.
- **Integration is a cherry-pick by an executor delegate**, one builder's commits onto the phase
  branch at a time, with the full gate after each (§12.6). Every commit carries a trailer naming
  the model that did the work (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, or Fable's
  on a Fable delegate's commit); cherry-pick keeps it, so the phase branch's history says who built
  what.
- **Convex dev is a singleton.** One agent owns `packages/convex` and `packages/core` per slice;
  everyone else proves functions with `convex-test`. Nobody but the deploy executor the governor
  names runs `convex dev --once` (§12.6).

### §12.2 — PR strategy: sequential, each closed on its own branch

B03 shipped as four stacked PRs (#95–#98) and fixed every Greptile finding at the stack's tip. The
founder accepted that once and ruled it out as a pattern: each PR's 5/5 and its resolved threads
are part of the quality record, and Greptile's re-reviews on a moving branch find *new* issues — a
fix landed on a later PR silences them for the lower one and leaves its threads open.

- **Sequential PRs, not a stack.** PR *n* merges before PR *n+1* opens, and PR *n+1*'s base is
  main. Builders keep working on the phase branch while a PR is in review; the PR branch is a cut of
  the phase branch at the slice boundary.
- **Each PR closes at Greptile 5/5 with every comment resolved on its own branch.** A finding is
  fixed on the branch it was raised on, pushed, and re-reviewed there until clean. Fixes never land
  on a later PR. Fix and explain in the commit; never reply to the bot; trust only comments on the
  latest SHA.
- **After each squash-merge, the phase branch moves onto main** with
  `git rebase --onto main <the PR branch's last tip> <phase branch>`, so only the commits past the
  boundary replay, and the review fixes arrive from main. Merging main into the phase branch
  conflicts everywhere; don't.
- **If a stack is unavoidable** (the founder's call, with the reason in the PR): merge bottom-up;
  retarget a child to main *before* its base merges (#90 once landed on an orphaned branch); after
  each squash, `rebase --onto main <old base tip>` for the child; fixes still go on the PR that got
  the comment, and the children absorb them by restacking.
- **Size:** under ~5,000 lines and ~100 files, or the reason stated in the PR — Greptile is metered.
  B03's first PR ran far past it, and its stated reason (half a shell reviews worse than a long PR)
  is the only kind that counts.

### §12.3 — Territory law

- **Every brief names its agent's territory explicitly** — directories and named files — and the
  agent edits nothing outside it.
- **Shared seams are governor-decided and executor-applied:** `routes/__root.tsx`, the route tree
  and its generated file, the admin layout route and `components/admin/AdminLayout.tsx`,
  `AppProviders`, `AuthGate` (its old-shell predicate), `lib/theme.ts` (its init script),
  `lib/posthogOptions.ts`, `package.json` and the lockfile, `vitest.config.ts` and the test setup
  files, `kit/`, `packages/design`, `packages/convex/convex/schema.ts`, and everything under
  `plans/`. The governor installs every dependency up front; agents never run `pnpm install`
  (concurrent installs in one checkout race the lockfile — the kit build's lesson).
- **Two agents that must create the same file get a canonical seam snippet**, written by the
  governor into both briefs verbatim — path, exports, signature. The first to integrate lands it;
  the second's copy is dropped at the cherry-pick. (B03: `RegionBackdrop` was the sign-in agent's
  file, and the shell agent imported it by the agreed `{ className? }` signature.)
- **A needed cross-territory change is a *seam request* in the final report** — the file, the
  change, why — never an edit. The governor decides; an executor applies it at integration.
- **Kit promotions are the governor's.** Agents propose *kit candidates*; the governor decides at
  integration and an executor moves the piece into `kit/` with its four-up stories and tests, so two
  agents never add the same kit piece.

### §12.4 — Brief invariants

Verbatim in every brief, with the placeholders filled:

```
- Never display an env file or a variable's value — not `cat`, `echo`, `env`, `printenv`, nor a
  `grep -v` that keeps values; a transcript is forever, and one such dump rotated five secrets. To
  learn which variables exist: `grep -o '^[A-Z_][A-Z0-9_]*=' <file>`. To load them:
  `set -a; source <file> >/dev/null 2>&1; set +a`.
- Never bare `git stash` / `git stash pop`: the stash stack is shared by every worktree and session,
  and a pop can land someone else's work. Set work aside with a WIP commit. Commit with explicit
  paths, never `git add -A` or `git add .`.
- `pnpm`, never `npx` (the root devEngines blocks npm, and the error doesn't say so). Never
  `pnpm install`; the governor installs up front.
- D3: no copy, score, decay curve or classification may say or imply that ice is safe, skateable,
  or "good to go", or predict it. Decay is confidence, not safety; a stale hazard never reads as
  "all clear".
- D40: tests land with the feature — Vitest for logic, `fast-check` for safety-sensitive math,
  `convex-test` for functions. US spellings in all new text.
- Territory: you own <paths>. Edit nothing else. A change you need outside it is a seam request in
  your report, never an edit.
- Targeted tests only: `pnpm --filter <package> exec vitest run [--project unit|storybook] <files>`.
  The full suite, the Storybook build, `convex dev` and every deploy are the governor's.
- No pushes, no deploys. Work in <worktree> on <branch>.
- Before you report: render your boards beside the mock HTML and fix or name every difference;
  mutation-check the invariants your tests guard (§12.5 of the phase doc).
- Report, compactly: what landed (one line per commit); seam requests; kit candidates; server asks;
  branch + HEAD.
```

### §12.5 — Quality mechanics that caught real bugs

- **Render-compare against the mock HTML before handoff.** Each agent renders its boards beside
  the source HTML in `skating-mockups/admin-variants/` (the board's file and query from the round's
  manifest — `review9/`–`review14/boards.tsv`), at the board's size, in both modes, and fixes each
  difference or names it in the report. B03's agents caught about a dozen real defects this way,
  none of which a test would have.
- **`fast-check` on anything safety-adjacent.** B03's sheet-calendar property test found a DST bug
  in core's `zonedInstantOnDayOf` that had been wrong on mobile too. B01's candidates: the
  rollup's season bucketing (§8), hazard staleness and the season bar on the Hazards tab, the live
  mark's *Not live* threshold (three times the expected interval), every relative age ("4 d ago"),
  and undo's "a later write means no undo" (§11).
- **Mutation-check your own invariants.** After writing the test that guards an invariant, break
  the code it guards — flip the comparison, drop the clause — and watch the test fail. A test that
  stays green under the mutation guards nothing. The report says which mutations were run.
- **The story-flake class.** Every CI-only red in B03 was a read landing mid-flight on a
  frame-starved runner: green locally, red on CI. Its six shapes:
  1. *A node held across an `await`* — Recharts remounts its bars every entrance frame, and a
     detached node computes every property to `''`.
  2. *A transitioning value compared as a string* — a `box-shadow` read at 99.97% of its transition
     is `0.999749px`, not `1px`.
  3. *Focus arriving after the state marker* — Base UI drops `data-open` the instant a close starts,
     but focus returns to the trigger only when the animation ends; a popover's opening focus lands
     a beat after the plate appears.
  4. *A fade read mid-fade* — a tooltip found while still transparent fails `toBeVisible`; a color
     read during a fade is the blend.
  5. *`img.complete` as a proxy* — Chromium loads a lazy, hidden image from memory cache if an
     earlier story fetched it, so the value depends on file order.
  6. *A debounce outrunning `findBy`* — in the jsdom project, a 200 ms debounce on a starved runner
     outran the old 1 s budget.

  The standing fixes: `waitFor` the thing itself (the focus, the attribute), never elapsed frames;
  `await Promise.all(el.getAnimations().map((a) => a.finished))` before measuring; a fresh query and
  one synchronous read, numbers compared with a tolerance; fake timers stepped past a debounce;
  assert the attributes that keep an image off the network, not its load state. Both web setup
  files (`apps/web/src/test/setup.ts`, `storybook.setup.ts`) set `asyncUtilTimeout: 5_000`, so a
  1 s budget is the default nowhere. `kit/measure.ts`'s color probes resolve before a `waitFor`,
  never inside one (they loop forever).

### §12.6 — The cadence

- **Builders report compactly** in §12.4's format; the governor reads reports, not diffs.
- **The governor integrates serially**: one builder at a time, cherry-picked by an executor, then
  the gate — `pnpm check-types`, lint, the full web suite (both Vitest projects), and the touched
  packages' suites. A repo-wide guard runs uncached in `packages/guards` once the branch is on main
  (D236); until then the plan-conventions tests live in `packages/core`, and turbo needs `--force`
  after anything under `plans/`.
- **Before each PR opens: `/code-review xhigh --fix` with an explicit range** (`main...<PR branch>`;
  the default reads the working tree), then the types, the suites and lint again. The goal is one
  round from open to merge.
- **Deploys are governor-gated singletons.** Convex dev is one stream — one worktree's push drops
  another's indexes — so the governor names one executor, which runs `convex dev --once` from the
  phase branch's integrated tip only (codegen first: `convex/_generated` is committed). **Deploy
  before the founder drives dev**, and run the owed backfills and seeds with it: B03's one real
  incident was the founder driving dev before the deploy. Never prod.
- **Founder check-ins are forks only** (a trade-off, a scope question, a surprise in the data).
  The roadmap entry flips 🟡 with the first PR and 🟢 with the last; what the build finds goes in
  this doc, in a section after this one.

### §12.7 — B01 specifics

- **The first slice is Overview and the Body console, with People if it runs fast.** Overview is
  1.1–1.4 (Home, Home in go-mode, Not Live, Metrics); Bodies is the list (5.1–5.3) and the Body
  console's 17-board row (5.4.1–5.4.9, *Gli · Admin console · Review 5*, manifest
  `review14/boards.tsv`), **default views first** — task modes and the map modes wait (founder,
  Review 12); People is 8.1–8.6 (`review10/boards.tsv`). In §8's terms: the client half of
  workstream §1 (the shell, the palette, keyboard routing, the undo toast and History, Overview),
  workstream §3, and workstream §7. Metrics' tiles that need records nothing keeps yet (a per-day
  sign-in record, a support queue-depth rollup — the admin-variants README, *Review 3½*) are a
  server ask, not a blocker for Home.
- **The branch comes first.** This branch forked from main at `d55318c9`, before #89 and #90; its
  design and kit commits reached main squashed in those PRs and have moved since (B03 changed 72 kit
  files). The build runs on a phase branch cut from today's main, carrying only B01's own commits
  (the docs, the capability map, the audit writer and undo, the Overview counts, D227),
  cherry-picked rather than rebased — a rebase would replay the kit commits against their own
  squashes. D216–D227 are not on main yet; they arrive with B01's first PR. **Never run
  `convex dev --once` from this branch:** dev carries B03's server code, and a push from here would
  roll it back.
- **The console mounts at `/admin`** in the same app (founder, 2026-11-07), on its own layout route,
  never under `_skater` (whose validated `?post=` would open the report sheet over the console —
  B03 §1.0).
- **The B01 shell replaces the old admin pages progressively, the way B03's did.** On main,
  `AuthGate`'s `OLD_SHELL_TREES = ['/admin']` wraps every admin path in the old `AppShell`, and
  `routes/admin.tsx` binds `AdminLayout` (the old gate and sidebar) over the whole tree. Each
  integration that lands a mode **narrows the predicate** to the old pages still standing; an old
  route becomes a redirect only when its replacement lands, so the console works at every merge,
  and the old components are deleted at the close, not before.
- **`data-surface="admin"` on `<html>`, per route.** `lib/theme.ts`'s `THEME_INIT_SCRIPT` removes
  `data-surface` under `/admin` today (the old pages don't read the tokens; absent keeps their look).
  The B01 shell takes the attribute over: the init script sets `admin` for the paths the new shell
  owns and keeps removing it for the old pages, and the shell re-states it after hydration, as
  `SkaterShell` does. One predicate decides the shell, the surface attribute and the old-shell
  wrap, with one test over all three, since the init script is a string constant that can't import
  it. The `.dark` class sync (D241) stays until the last old admin page retires. PostHog already
  stamps `surface: 'admin'` on every `/admin` route id (`surfaceForRouteId`, D240).
- **The kit review's first batch** is the skater compositions the console wants, each proposed by
  B03 and promoted only at integration:
  - `InsetCard` (`components/skater/panels/`, with the `useCardMechanics` it shares with
    `PanelDrawer`) — the landmark editor, *Drop a Landmark* and *Link a Lot* are inset cards
    (Review 14).
  - `ReportCard` (`components/skater/cards/`) — the Body console's reports, then Inbox and Reports.
  - `CodeInput` (`components/skater/auth/`) — if the console has a use for it.
  - `INK_PRIMARY` (`components/skater/styles.ts`) — the primary ink, if the console's is the same.
  - The grouped-autocomplete search (`GlobalSearch`, `GlobalSearchView`) — its internals shared with
    the kit's `CommandPalette`, both on Base UI Autocomplete.
  - `SkaterPair` — three copies on main (`skater/storySupport.tsx`, `skater/auth/storyFrame.tsx`,
    `skater/map/mapStill.tsx`), to become one surface-parameterized story helper.
  - `useIsPhone` (`components/skater/phone/usePhoneLayout.ts`) — surface-neutral, so it belongs in
    `src/lib`.

### §12.8 — What the build found

**B01-1 (2026-11-13): the two Metrics write paths** (the founder's call 2, 2026-11-10), so their
history starts on merge day; the reads and the tiles come with the Metrics tab.

- **The sign-in record** is `signInDays`, one row per person per UTC day (`metricDay`), written by
  `profiles.syncFromClerk` — the one call both clients make on every open once a profile exists,
  and again when an app left open comes back to the foreground on a new UTC day (`onceADay`, so a
  resumed tab or phone app is counted without a call on every focus).
  The first open of a day reads one `by_user_day` entry and inserts; every later open finds it and
  writes nothing, and two racing opens conflict under OCC and settle on one row. A suspended account
  counts (it did sign in); a pending or finished deletion records nothing, and finalization erases
  the rows (D33). *Signed in*, *on two days or more* and the season's per-day line read `by_day`.
  **Open:** no retention bound yet. Rows grow with people × days, about a season's worth is what
  Metrics reads, and a per-person record kept forever is a privacy question (`bountyGateEvents`
  keeps 180 days for the same reason) — the founder's call when the reads land, with the day counts
  rolled into `metricSnapshots` first if the rows are to be pruned.
- **The support queue's depth** is `support_queue_depth` on `metricSnapshots`: tickets open at any
  point of the day, by category (the board's *Open support tickets*). It rides the existing 6-hourly
  `roll up operator metrics` cron, beside `flag_queue_depth`, and measures today so far and
  yesterday, so the first tick after midnight closes the day before. Its reads are the open queue
  (`by_status`) and resolutions since yesterday (`by_status_resolved_at`, lower-bounded), each
  capped. It is forward-only even though a rollup writes it — tickets are erased with their
  submitter's account — so the day backfill never replays it. One edge stays: `support.resolve`
  re-stamps `resolvedAt` when a resolved ticket is resolved again, which would count it open on the
  days between; nothing in the console does that today.

**B01-2 (2026-11-13): the shell, Overview Home and Metrics, integrated.** Four builders (kit
promotions, the shell, Home, Metrics) cut from `eb1f7242`, cherry-picked serially onto `b01-2` off
the phase branch at `519cc1c8`.

- **The Overview mounts at `/admin`** in the console shell, Home | Metrics as a validated `?tab=`
  (Home is no param). Home reads what exists — `console.overview` (Inbox, People),
  `waterBodies.reviewQueueCounts` (Corpus's intake rows), `moderation.listActions` (the feed) —
  and every block no read serves is drawn *Not recorded yet*: the season's four tiles, cost (no
  Ledger link), Machinery (no Health link), all of Metrics. The Corpus rows nothing counts yet
  (chord re-fits, place names, the pre-ice pass, enrichment) are left out, never zeroed. No
  fixture reaches the app: `fixturesStayInStories.test.ts` fails on any non-story importer.
- **Links go to the old pages until each mode lands**, as the palette does: every Inbox lane,
  Corpus task, People list and audit target type maps to an old page still standing, and a test
  holds each to the old-shell predicate. The ledger has no page yet.
- **The old dashboard moved to `/admin/dashboard`** (the governor's ruling, §7), in
  `OLD_SHELL_TREES`, the init script's copy and the Legacy menu; the old sidebar's Overview line
  is the way back.
- **Found at integration:** #108's fix round made `appealsOpen` a capped `Count`, and Home was
  built on the bare number (fixed at the pick); `admin.tsx` binding `AdminRoot`, which picks a
  shell and owns no outlet, failed the route-nesting guard, which now follows a shell switch and
  requires an outlet on *every* branch; Metrics runs taller than a 900 px screen and the shell's
  main area doesn't scroll, so the tab scrolls under the page head. **From 1 July to 30
  September** (the founder's call, §7) the page shows the new season, empty: Home's four season
  tiles and Metrics' season-ranged sections say when the record begins, and the now and
  this-week stats are unchanged. The shell's lamp now speaks
  the live mark's words (*Convex live / checking / not live*); *not live* is the dim lamp until the
  kit has a hollow state (below).
- **Seam review of `lib/theme.ts`:** the init script's old-page list is compared to
  `OLD_SHELL_TREES` by importing the real constant and parsing the real script, and the script is
  run over every old tree, a page under each and the near-misses — dropping one tree from the
  script alone fails it, and so does writing `admin` on a skater path. Skater paths behave as
  before: `skater` everywhere outside `/admin`, the `.dark` sync unchanged.

### The B01-2 server register (owed to the server agent)

Every seam request the B01-2 builders raised against `packages/convex` and `packages/core`, and
the two undo fixes the executor's final review of #108 found (U1, U2). Nothing here blocks a merge: each block draws *Not recorded yet* until its read lands, then swaps its
`null` for the read.

| # | Ask | For | Status |
|---|---|---|---|
| S1 | `machinery.overviewJobs` — the jobs that need a look first (stalled, failed, late, retried, then a few ok), how many more and whether they're all ok | Home › Machinery card, the heads row's *needs a hand*, the status bar | ⚪ |
| S2 | `ledger.overviewCost` — this season's total and its invoiced/metered split, each service's amount and free-tier meter, the last three full months and this one by hosting/AI/compute | Home › cost strip, *Cost · this season*, *By month* | ⚪ |
| S3 | `seasonWatch.homeSummary`, moderator-readable — the watch (waiting/open/closed, sentinels), winter region-wide, imagery state, the first skate | Home › the season's four tiles | ⚪ |
| S4 | `console.overview` additions — `inbox.medianAgeMs`; `people.totalUsers`; the Corpus counts no read has (chord re-fits across bodies, place names, the pre-ice pass's date, awaiting enrichment, the last campaign); dedup groups counted as decisions, not rows | Home › Inbox foot, People's *N users*, Corpus rows | ⚪ |
| S5 | The audit feed: a `targetLabel` on each `listActions` row (the body's or person's name), and machine-run events (cron and run outcomes) in the same feed as `system` | Home › audit feed | ⚪ |
| S6 | One definition of *open flags* that includes `reviewing`, used by every count (§7, the governor's ruling 1) | Home, Metrics | ⚪ |
| M1 | Keeping up, now — open flags (all, safety), the oldest open flag (when, which body), open tickets and the oldest | Metrics › Keeping up's stats | ⚪ |
| M2 | Keeping up, the season — `flag_time_to_resolution_h` for the last 7 days and the season, the flag queue per day (`flag_oldest_open_age_h`, `flag_queue_depth`), support's resolution histogram and `support_queue_depth` per day | Metrics › the oldest-flag chart, both histograms, open support tickets | ⚪ |
| M3 | Showing up, the week — reports and their people, accounts added and total, signed in and on two days or more (`signInDays`), contributors and first-timers | Metrics › Showing up's stats | ⚪ |
| M4 | The daily strips — reports, comments, kudos, photos, hazards, new accounts, signed in, contributors per season day (1 October on), each with its total and spread; comments and photos as **backfillable** rollups | Metrics › *Each day* | ⚪ |
| M5 | The vantage rollup — the season's reports by `observedFrom`, and those stating none | Metrics › *Reports by vantage* | ⚪ |
| M6 | Most-reported — via the §10 tier-2 per-body rollup: reports, photos, distinct people, last report | Metrics › *Most-reported* (rows open the Body console, §7 ruling 3) | ⚪ |
| M7 | Coverage by state — listed bodies once each, and per state: bodies, reports, comments, photos, kudos, contributors | Metrics › *Coverage by state* | ⚪ |
| M8 | A moderator-level metrics capability — the tab reads today's admin-only rollups; a moderator sees Metrics without support (PII, D37) | Metrics for moderators | ⚪ |
| M10 | A season chooser in the Overview's own content (not the rail or any sidebar navigation), and every season-ranged read taking the season as an argument (M2, M4–M7, S3; S2's season total). The founder's call (§7): a past season is shown only when chosen. The client is ready: `OverviewView` takes `season`, `metricsWindow(season, now)` draws a past season whole, and Metrics and the season tiles draw whatever window and facts they're handed | The Overview, both tabs | ⚪ |
| M9 | A by-time index on `reportRatings` for kudos (the founder, 2026-11-13: kudos are positive reactions; *helpful* counts; a thumbs-down never subtracts) | M4's kudos strip, M7's kudos column | ⚪ |
| H1 | A moderator-readable season-tape summary — the watch's opening and the day count, so the tape can wear its *Day N* badge and its marks | The shell's season tape | ⚪ |
| H2 | A colleague-presence read — who else is in the console now | The top bar's faces | ⚪ |
| H3 | An optional audit-row id returned by every operator mutation | Undo's toast and History linking a write to its row | ⚪ |
| H4 | Suspend and ban refuse the last ledger holder — D227's *never no holder* holds through discipline as well as demotion (the governor's ruling) | People, D227 | ⚪ |
| U1 | A Post's restore records the auto-hidden state in its `prev` snapshot, and its undo puts it back — today undoing a moderator's restore of an auto-hidden Post (all its Reports hidden) loses that record, and restoring one of its Reports afterwards no longer brings the Post back. The true-inverse rule of the landmark-restore fix (founder-ratified 2026-11-13): a restore records what it clears | Undo (D226), Post moderation | ⚪ |
| U2 | History's *undone by* link on a Post can point at a Report's row instead of the Post's own undo row (`lib/undo.ts`). Nothing reads the link yet; a pre-wiring fix before the History panel does | Undo's History panel | ⚪ |

### Kit extensions owed (B01-2)

Raised by the builders as kit candidates or gaps; each is the governor's to promote (§12.3).

- **A hollow state** for the live `Badge` and `StatusLamp` — the live mark and the status bar's
  *not live* draw it locally (or as the dim lamp) until then.
- **`StatGrid ruled={false}`** — a strip of stats without the column rules.
- **A display-word component** — the page word (*Overview*) and the column heads share its type.
- **`RowLink`'s in-row size** — the 18 px chip that fits a 22 px row, now local to Home.
- **`Chart`'s quiet tone** — the context-bar gray (`--line2`) the kit's tones stop short of.
- **`Sparkbars` shared hover** — one hairline and one plate across a stack of strips.
- **`ChartLegend` and `ChartNote`** — Metrics' legend and empty-chart note, kit candidates (cost's
  spend chart already borrows the note).
- **`AppShell`**: the search label truncates at 1440 (*Jump to a body or a pers…*), and the
  season tape overlaps the search under about 1,000 px.

**Known bug, skater territory (owed, not B01-2):** client-side navigation from a skater page to an
old admin page leaves `data-surface="skater"` on `<html>` — the old page wants it absent, and no
shell on that path takes it off.

**B01-1b (2026-11-13): what a person can take back, and what stays on record** (D248). Server only;
the People page and the skater screens that reach it are owed (the roadmap's register).

- **The verdict record (Part B).** `contentVerdicts`, one row per top-level hide or remove, naming
  whose content it was, written beside the audit row by `lib/contentVerdicts` and ended only by a
  moderator — a restore (a Post restore's chosen member included), an undo, or `overturnVerdict` on
  content its author has since deleted (or a Post its author emptied Report by Report, or a withdrawn
  hazard). A takedown on already-deleted content, history only in #108, is now a verdict; undoing
  one points at the overturn. `contentRecord.backfillVerdicts` rebuilds the record from the audit
  log through the same rules (a property test holds the replay to what the live writers keep under
  any order of deletes, hides, removes, restores, undos and overturns). **The 100-row history bound
  can miss a case only for an item carrying more than 100 audit rows**: the stamp backfill's "not
  restored since" read, the comment backfill's last word and the verdict replay all read the newest
  100. Real items carry a handful, so it is a bound rather than a gap; the verdict replay logs every
  item that reaches it instead of silently replaying part of one. The stamp backfill also now
  withdraws a member a moderator hid after its Post was author-deleted; a member a moderator brought
  back *up* is left live, since taking it down would change what skaters see.
- **The erasure (Part C).** Every withdrawable row carries `eraseAt`, written only by
  `lib/eraseClock` at the writes that move a withdrawal or a hold — the author's delete, a verdict
  recorded or ended, a flag filed, closed or retracted, a retraction — so `by_erase_at`'s bounded
  range is the sweep's whole work list. `erasure.eraseDue` (hourly) re-reads the hold anyway, pages
  with a size seam, and writes one actorless, contentless `erase` row per item. What each kind loses:
  a **comment** its words (a placeholder stays only where replies point at it, and goes with its last
  reply; comments keep no revisions); a **Report** its row, words, revisions, photos (unless the
  uploader's other content still uses one) and bay joins — its hazards stay unchanged and unlinked,
  its recording is unlinked with its prompt settled (`dismissed`, so nobody is asked again to report
  it), an access alert filed from it is unlinked, its point events stay (a delta, a reason, the
  Report's id and a time — no content), and its Post drops it and re-derives its album, sort key and
  search words; a **Post** goes after its last member (held while any member is stored), with its
  words and revisions; a **hazard** its row, photos and its author's own vote; a retracted
  **request** or **flag** its row. **Access alerts** run the clock with no eraser — a founder call
  (the register). The clock is `WITHDRAWN_ERASE_DAYS`, a sibling of the account grace pinned equal
  to it, because the codebase names each promise it states.
- **Other people's content attached to an erased item stays theirs.** Comments on an erased Report
  stay in each commenter's record and export, unreachable in the app (the thread answers empty, as
  for a removed Report today); replies under an erased comment hang from its placeholder; ratings,
  flags and votes others left stay, pointing at an id that no longer resolves (their readers already
  skip a missing target — the flag queue shows "(deleted)"); a bounty another skater posted keeps its
  fulfilled state and its answer list skips the gone Report; notifications already delivered to
  others stay in their inbox. Two things copy a Report's content and stay, per call 5: a hazard
  derived from a located sighting carries the sighting's words in its description ("Seen, not
  skated: …"), and stored put-in rows from the pre-D62 purge (`putIns.originReportId`) carry a
  Report's coordinate — nothing reads that link today.
- **Hazard withdrawal (call 6).** `hazardWithdrawal.withdraw`: the author, while no other skater's
  latest vote is `still_there` or `healing_unsafe` (a property test over any votes). The pin leaves
  as never posted — moderation `removed`, lifecycle untouched, so nothing reads it as healed — and is
  final. Refused, and owed a founder call: a merge tombstone, a survivor that absorbed pins, a member
  of a cross-season pattern; also a pin promoted to a permanent feature (a moderator made it the
  lake's).
- **Retraction (Part D).** Requests (`corpusRequests.retract`, while open; approve and decline then
  say the asker withdrew it), flags (`contentFlags.retract`, while open or picked up; not one the
  system filed or has counted again for others; it leaves the queue and stops holding content), and
  alerts (the author's retraction only while a live community claim; a moderator's unchanged; an
  author-retracted alert can't be pinned back). The author's own `open` resolves their alert, pinned
  or not, releasing the pin with an `author_resolve_access_alert` history row. **No client reaches any
  of these yet**, and both clients hide the vote buttons on a pinned alert, so the author's "it's
  open" there needs a client change too (the register).
- **Found on the way.** `dataExport.collect` carries none of the flags or requests a person filed —
  theirs, and "everything about you" omits them; not changed here.

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
