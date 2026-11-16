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

1. **The Metrics season window starts 1 October** (D249). The data season resets on 1 July, and only for
   data cleanliness; the season as any skater thinks of it starts in late fall — the watch opens
   1 October, and ice rarely comes before November. The dashboard shows the watch, so the Metrics
   charts' season window runs from 1 October, not from the data season's 1 July.
2. **Kudos are positive reactions, and *helpful* counts as one** (D250). Reports keep thumbs up and down
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
7. **What the build held, ruled** (D248): a hazard joined to others' records — merged, counted in a
   cross-season pattern, or made a permanent feature — is a shared record and stays up; and **a
   past pin counts as acted on**: once a moderator pinned an alert, its author can't retract it even
   after the pin is released, though their "it's open" always stands. A verdict or open flag on a
   Post holding its member Reports is accepted as built. And **an alert its author retracted is
   erased after 30 days**: "we should go with your recommendation here to follow the 30-day
   pattern" — a moderator's own retraction is not on that clock, and a moderator can keep a
   withdrawn alert as evidence with a verdict.

### The governor's rulings at the Overview's integration (2026-11-13)

Made while B01-2 integrated Home, Metrics and the shell; the founder may overturn any of them.

1. **"Open flags" counts `reviewing` everywhere** (D251). A flag a moderator has opened but not decided
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

1. **From 1 July to 1 October the Overview shows the new season, empty** (D249). *"We should show empty
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
   hollow state (the kit extensions owed, §12.8). *Resolved in B01-3:* both have it, and the live
   mark and the lamp wear it (the kit extensions table, under the component kit checklist).

### The founder's call on the console's mark (2026-11-13)

**The console rail wears the Gli logo** (the kit's `Logo`) instead of the text wordmark the boards
draw — a deliberate deviation from the boards, by the founder's call. It sits 16 px tall in the
wordmark's old 32 px head with the same bottom gap, so nothing below it moved.

### The governor's rulings at the Bodies integration (2026-11-13)

Made while B01-3 built the Bodies list and the Body console; the founder may overturn any of them.

1. **Completeness is the founder's ten** — outline, name, access, depth, elevation, wind, put-ins,
   lots, landmarks, bathymetry, in that order — one rule in `@skating/core` (`bodyCompleteness`),
   which the list and the console both read. A fact no read serves yet is *unknown*: drawn dashed,
   never counted, never named in the *Missing …* note.
2. **"Opened recently" is this browser only**; **"Changed this week"** is any moderator action on
   the body or its bays, landmarks or put-ins.
3. **The Class facet offers "Lake or pond" as one option**, as the class is stored. **F** opens the
   filter from the list's tools, never from inside the rows (where letters type ahead).
4. **Add-a-bay tiles hand off to the old editor** until the console's bay mode exists.
5. **A mapped launch's "where" is the nearest landmark's real name.**
6. **Remove on the landmark card stays "Not available yet"**, as does every tool entry point not
   built: it says so on hover, focus and press, and does nothing else.
7. **The Standing tab keeps the saved put-ins lane** (D245).
8. **The Hazards tab opens on the current season even when empty**; a past season is shown only
   by choosing it (the Overview's rule). The chosen winter lives in the lit address
   (`winter:<year>`, `hazard:<year>.<id>`), so the map and the list show one winter.
9. **Bodies is gated on `body.read`**, the capability map's line for reading a body; the list's
   standing lanes are served by `standing.listLane` (`corpus.read`), the same moderator line.
10. **The skater app's `InsetCard` stays unmerged** with the kit's for now (owed, below).
11. **`/admin/water/$id` stays standing, with no redirect,** until the tools that still say *Not
    available yet* exist; the console's empty slots and the bay tiles link to it.

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
- **§7 — People.** The person's content record (`contentRecord.personVerdicts` and `personWithdrawals`, D248, built
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
| Meter | ✅ | Base UI Meter | admin | The 4 px quota bar, one height everywhere (R3); amber and red at thresholds; `role=meter`, not Progress (#40); the white gate tick (`markTone="lit"`) and `value={null}` for *not measured* — an empty track, no fill, no meter role (B01-3: Imagery's gates; ThresholdMeter folded in) |
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
| Map controls (layer rack, zoom pair, scale, mode bar, hover plate) | ✅ | custom MapLibre controls + Switch, ButtonGroup, Kbd | admin | Scale on the map (R12#4); UI 56 px up (R13#5); the mode bar in ice; one hover plate per board where hover is the point (R14#1); real geography (R11#5) (#28, #54); the plate's `caption` line (B01-3) |
| Matrix and trace charts (temperature matrix, season traces, sparkbars, LED segments, stage bar) | ✅ | custom SVG / CSS grid | admin | The temperature scale tokens; ice only for water and transient modes (R9#12, D223); translucent marks bound for Paper need `rgba()` fills (#41, #53); `LedStrip` is the one segment strip — the Bodies list's and the Body console's candidates folded in (B01-3): a 5 px `row` size, a `tall` size, per-segment `on / off / unknown` (unknown dashed, never counted) |
| Mobile bar | ⚪ | custom nav + ToggleGroup chips | admin | A later phase (#57) |
| Map key (`map-key`) | ✅ | custom; promoted from the skater map (B01-2) | both | A slim bar on the map's bottom edge; lists only what the map draws; a name is a noun for what the mark is, never a word about the ice (D3); scrolls at phone width, never wraps; `MAP_FOOT_ROOM` lifts the foot controls over it; every landmark kind, sample points and proposals as kinds (B01-3) |
| Map marks (`map-marks`) | ✅ | custom SVG; promoted from the skater map (B01-2) | both | Put-in, lot, photo and hazard in its three tones — the key's glyphs and the Body boards' marks are one drawing; `HazardTone` is the marks' own type; `PlaceMark` for each landmark kind, a sample point and a proposal (B01-3: the frame's place marks and the Places tab's landmark mark folded in); `fade` for a hover elsewhere (`opacity-fade`), a hazard never below half (D3) |
| Map graticule (`map-graticule`, `graticule`) | ✅ | custom SVG + a pure layout | admin | True parallels and meridians at a round step, faint, labeled at the pane's edges clear of the chrome (Review 13 #5) (B01-3, from the Body console) |
| Filter chips (`filter-chip`) | ✅ | custom | admin | `FilterChip` (the facet as a kicker, the option, its own ×), `FilterChipRow`, `FilterCount` — a list's applied filters (B01-3, from Bodies 5.2) |
| Facet menu (`facet-menu`) | ✅ | custom, inside a kit Popover | admin | Facets as rows of square options with counts (a filter *menu* keeps its counts); two-way keys, one tab stop (B01-3, Bodies 5.2) |
| Search mark (`search-mark`) | ✅ | custom | both | What matched, marked in place: the ice mark ground and a 1 px ice underline; case- and accent-blind (B01-3, Bodies 5.3) |
| Table group row (`table-group-row`) | ✅ | custom on Table | admin | A divider row inside a table: a kicker and its count over a `line2` rule, never washed (B01-3, Bodies 5.3) |
| Record lockup (`record-lockup`) | ✅ | custom | admin | A record's kind over its name, folding to one line over a rule once the panel scrolls (Review 12 #8) (B01-3, the Body console) |
| Bullet list (`bullet-list`) | ✅ | custom listbox | admin | A short list of things to open on hollow bullets, the open one lit; one tab stop, type-ahead (B01-3, *Asked of this body*) |
| Inset card (`inset-card`) | ✅ | custom | admin | A task over the inspector, the pane dimmed behind it and the map live (Review 14's `.icard`); the head is one Back control with its Esc (B01-3, Places' landmark card). The skater app's own `InsetCard` is not merged yet (owed) |
| Person lockup (`person-lockup`) | ✅ | custom on Avatar | admin | A person's circle, real name, then @handle (B01-3) |
| Unavailable button (`unavailable-button`) | ✅ | custom on Button + Tooltip + Toast | admin | A tool's entry point not built yet, drawn as the board draws it: *Not available yet* on hover, focus and press, nothing else; focusable (B01-3) |
| Entry tile (`entry-tile`) | ✅ | custom | admin | The way-in tile: a glyph (square, or a `wide` gesture), its name in caps, a sub-line, its key; `what` makes it a not-yet entry point; disabled for a viewer without the capability. Access's tile and Shape's bay ways are this one piece (B01-3) |
| Radio cell (`radio-cell`) | ✅ | custom on Base UI Radio | admin | A value you can pick as a boxed table cell; the one in use wears *Now*; the unit on `gap.unit` (B01-3, Water's depth ladder) |
| Lane timeline (`lane-timeline`) | ✅ | custom | admin | One lane per thing that holds, on a time axis, each span with its arrowhead or stop (B01-3, Standing) |
| Sortable rows (`sortable-rows`) | ✅ | custom | admin | Rows that reorder by a grip, by pointer or keys (B01-3, Links' staff links) |
| Day strips (`day-strips`) | ✅ | custom SVG | admin | A few series on one day axis, stacked, each a baseline with its days (B01-3, Hazards' winters) |
| Search parts (`search-parts`) | ✅ | custom on Base UI Autocomplete; promoted from `GlobalSearch` (B01-2) | both | `FootKey` (one dim cap per key), `SearchGroupLabel` (`plate` / `palette` looks, optional count and rule), `SearchStatus` (spinner, else the caller's note); the rows stay each list's own; one popover plate (`POPOVER_PLATE`) so the two can't drift |

**Count:** 70 components: 30 re-skinned shadcn atoms, 4 Base UI primitives, 36 custom (B01-3 added
sixteen). Sixty-nine are done; the mobile bar waits for a later phase.

**Kit extensions (B01-3, 2026-11-13)** — the B01-2 owed list, built on `b01-3-kit` and carried with
B01-3, and what the Overview adopted:

| Piece | Status | What it is | Adopted by |
|---|---|---|---|
| Badge `variant="live" tone="off"` | ✅ | The hollow LED: not live | `LiveMark` (its local hollow class is gone) |
| StatusLamp `state="off"` | ✅ | The status bar's hollow lamp | `OverviewLamp` (was the dim lamp, a stand-in) |
| StatGrid `ruled={false}` | ✅ | A bare strip of stats on the grid's gap | Home's season strip |
| Chart `quiet` tone | ✅ | The context gray (`--line2`) under a lead series | `KeepingUp`'s open-flag and *other*-ticket bars (overrides gone) |
| `SparkbarSet` + Sparkbars `tone="muted"` | ✅ | One hairline and plate across a stack of strips, keyboard stepping; a `null` day is an empty slot, out of the scale, and the plate says *Not recorded yet* | Metrics' *Each day* strips (the pulse's own hover, plate and chart strips are gone) |
| `ChartLegend`, `ChartNote`, `StatusDot` | ✅ | Promoted from the console into the kit | Their importers |
| `DisplayWord` (`page`, `column`) | ✅ | The page word and a column's head | `OverviewPage`, Metrics' `ColumnHead` |
| Button `size="row"` | ✅ | The 18 px chip that fits a 22 px row | `RowLink` |
| `Logo` | ✅ | The Gli mark | The console rail (§7, the founder's call) |
| Avatar `xl`, the page head's tone | ✅ | — | — |
| Meter's gate tick and dim fill | ✅ | — | — |
| `LifeStrip` | ✅ | An item's life as a strip map | — |
| The top bar's search and tape | ✅ | Never truncate the search or run the tape over it | The shell |
| Tokens: `btn-row`, `avatar-xl`; the gaps `section`, `unit` (7 px), `segment` (3 px); the fade opacity; a token catalog story read off the registry | ✅ | — | — |

**Owed to the kit, found reviewing the adoption (2026-11-13) — all four settled the same day:**

- **`DisplayWord` lost its `leading-none`** (tailwind-merge drops a leading set before a font size):
  each size now carries it after the size class, and the Overview's caller-side restatements are
  gone. Its stories hold the line height to the font size.
- **`Logo` ignored the system mode** (white on white on a light OS): the nearest `data-mode` wins,
  and with none the page's `.dark` — how the app resolves *system* (`lib/theme.ts`: the attribute
  removed, `.dark` kept in step by the before-paint script and the provider). Precedence rides
  specificity, not rule order; `EveryTheme` covers explicit light and dark, system on a light and
  a dark OS, and a scope of each mode inside each.
- **`Sparkbars` had no *not recorded* day:** a `null` day is an empty slot (never a zero stub), out
  of the scale, and the set's plate says *Not recorded yet*; the Metrics strips adopted it.
- **Chart tones' colors** are exported (`chartToneColor`), and the Metrics legends read them.

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
taken away). **Added 2026-10-16:** D227 (invoices edited by named people — Teagan from the start — not a role). **Refined 2026-10-17:** D227's grant is a row on an admin's People page that only a holder sees and changes; never no holder; a demotion clears it. **Ported 2026-11-10:** D245 (a saved put-in keeps a body active through the standing rollover; minted on the sweep branch as D228, §7). **Added 2026-11-13:** D249 (the season flips on 1 July, its Metrics window opens on 1 October, empty between), D250 (kudos are positive reactions), D251 (a flag under review is open), D252 (discipline never leaves the ledger without an editor), D253 (what a contribution is), D254 (the sign-in record keeps the current season and one past), D255 (a body's completeness is ten things). **Added 2026-11-14:** D257 (People reads a light row per person; flagged means the person or their content; a staffer's figures, defined once). **Added 2026-11-15:** D266 (a body is in a town when 25 m of its shoreline is; states and region follow; one rule for the merge, the import and the facts). **Added 2026-11-15:** D267 (the record sheet's levers and lists: one rule, each item once).

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
  frame-starved runner: green locally, red on CI. Its shapes (six from B03, a seventh from B01):
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
  7. *A list sampled once, judged later* (B01, "Legend Matches Bars" on #111, "Quiet Tone" on
     #119) — a helper waited until *some* bars were drawn, returned their fills, and the
     assertions ran on that sample; a chart's series don't all draw on the same frame, so CI caught
     six gray bars and neither red one. The read and its assertion belong in one retry.

  Which overlay reads must wait (B01-3's audit of every kit story's `getComputedStyle` read): the
  overlays animate only opacity on open and close (sheet, drawer and toast translate too), so a
  background, border, shadow or text color read right after one opens is safe; an opacity or
  translate read waits for the animation's end. A control's own state change is different: the
  buttons, rows and menu items transition `color`, `background-color` and `box-shadow`, so a read
  after a focus, highlight or hover retries until the end state — and asserts that state exactly,
  since a retry passes on the first frame that meets it: an outline button's inset ring is a
  `box-shadow`, so `not.toBe('none')` holds at rest; the ring is `focusRing()`.

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
  **Settled (D254):** the current season and one past season are kept; earlier days are swept daily. **Was open:** no retention bound. Rows grow with people × days, about a season's worth is what
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

**B01-1b (2026-11-13): what a person can take back, and what stays on record** (D248). Server only;
the People page and the skater screens that reach it are owed (the roadmap's register).

- **A verdict outlives its content (D248's heading; found by the erasure property on CI, #114, seed
  1947312279).** Erasure takes the author's item and leaves every verdict row on it — a standing one
  can't be there (it would hold the item), and an ended one stays on the person's record as history,
  pointing at an id that no longer resolves, the way other people's votes on an erased item do. The
  backfill follows the same rule for every kind: it replays an item that is gone like any other, and
  names the person from a verdict row the item left, its author's own deletion in the history, or the
  person the action recorded. Every moderator action that can put a verdict on the record now records
  it: an author's retraction of their alert leaves no row of their own, and neither does a Post a
  moderator removed and its author then emptied one Report at a time, since the clients delete Reports,
  never a whole Post (found by the code review, 2026-11-14). An item whose history names nobody, on
  rows from before that record, is left unrebuilt and logged (on each page that skipped one), never
  guessed. The property runs four pinned seeds and one random seed on
  every build, its found counterexamples run first as examples and as named cases, and
  `ERASURE_PROPERTY_RUNS` / `ERASURE_PROPERTY_SEED` widen or replay it locally.
- **The verdict record (Part B).** `contentVerdicts`, one row per top-level hide or remove, naming
  whose content it was, written beside the audit row by `lib/contentVerdicts` and ended only by a
  moderator — a restore (a Post restore's chosen member included), an undo, or `overturnVerdict` on
  content its author has since deleted (or a Post its author emptied Report by Report, or a withdrawn
  hazard). A takedown on already-deleted content, history only in #108, is now a verdict; undoing
  one points at the overturn. `contentRecord.backfillVerdicts` rebuilds the record from the audit
  log through the same rules (a property test holds the replay to what the live writers keep under
  any order of deletes, hides, removes, restores, undos and overturns). **Every history is read
  whole** (Greptile #110, round 3: a fixed read of the newest 100 rows, and a fallback that guessed
  from it, put a reversed hide back on a person's record): the verdict replay, the stamp backfill's
  "not restored since" and the comment backfill's last word each hand one item at a time to a job
  that reads its history a charged page per transaction, carrying the replay's two-field state
  between them, and hands the audit walk back where it left off — so no history is too long, nothing
  is left unknown, and nothing is guessed. The verdict replay runs twice per item: first it makes what
  the history leaves standing stand (only ever adding a hold), then it brings every other row to the
  history, so the item is never less held mid-replay than its history leaves it. The stamp backfill also now
  withdraws a member a moderator hid after its Post was author-deleted; a member a moderator brought
  back *up* is left live, since taking it down would change what skaters see.
- **The erasure (Part C).** Every withdrawable row carries `eraseAt`, written only by
  `lib/eraseClock` at the writes that move a withdrawal or a hold — the author's delete, a verdict
  recorded or ended, a flag filed, closed or retracted, a retraction — so `by_erase_at`'s bounded
  range is the sweep's whole work list. `erasure.eraseDue` (hourly) re-reads the hold anyway, pages
  with a size seam, and writes one actorless, contentless `erase` row per item. **Nothing an item
  carries is capped away** (Greptile, #110): its revisions (one per edit, unbounded), joins, links
  and the author's own votes go a per-tick write budget at a time, through indexes on each link
  (`accessAlerts.by_report`, `waterBodyRequests.by_report`, `putIns.by_origin_report`), and the item's
  own row goes last, so a pass that runs out leaves it whole and still due for the next; the
  `erase` row is written only when it is really gone. **Every read is charged** (Greptile #110, three
  rounds; `lib/readBudget`): each transaction of the sweep, the photo settlement, the Post jobs and
  the backfills charges every read it makes — page rows, `get`s, `first()` existence checks, and a
  second touch of a row it patches or deletes — at its table's worst case against a 12 MiB budget
  (Convex's 16 MiB less headroom), and a read past the plan throws. The worst cases come from the
  real caps — a comment's 2,000 characters, a Post's 120 + 20,000 — and from the 1 MiB document limit
  wherever a field has no cap (**a Report's notes, a flag's note, a photo's caption, a request's
  polygon, a hazard's or an alert's client-sent `idempotencyKey`, a put-in's name, a moderator's
  reason**). The sweep takes the head of the due range one item at a time and starts an item only
  when the budget covers its hold check, its fixed reads and one drained row (`ITEM_NEED`, under a
  fresh budget for every kind — a test holds it), so every pass erases an item, clears a clock that
  should not run, or deletes a row. A Report's Post is re-derived after it in a job of its own
  (`dropErasedMember`: the Post and its ≤ 9 other members, each read once, one write), and a Post's
  hold reaches its members' clocks a few a transaction (`refreshMemberClocks`) — until either runs,
  nothing is unsafe, because the sweep re-reads every hold before it erases. The D248 suites run under
  Convex's real transaction limits (`convexTest({ transactionLimits: true })`) with rows near the
  document limit, and `packages/guards` holds every read in the erasure and record modules to a charge.
  **A photo is erased only when nothing of its uploader's uses it** — an unknown is never "unused":
  `erasure.settleStep` reads the uploader's Reports and hazards a charged page per step, and
  deletes a photo only in a transaction that has itself read to the end of their hazards (resuming
  after the last one read, so one filed mid-settlement is seen), beside the photo's back-link and
  access-photo checks, as many as the budget affords; the rest carry on, the list only shrinking.
  **What is owed is a row**: the transaction that erases an item with photos writes a
  `photoSettlements` row (the uploader and the item's photo ids), the settlement takes an uploader's
  rows and deletes them only after it has finished, and every sweep run's end starts `settleOwed`,
  which walks the oldest debts one uploader at a time — so a pass that throws never leaves an erased
  item's photos with nothing coming back for them. One row per erased item rather than per uploader:
  an insert reads nothing and is bounded by the item's own list, where a per-uploader list would be
  read and rewritten whole at every erasure and could outgrow a document. A
  photo whose blob outlives the delete is kept as the orphan sweep's pointer, stripped and marked
  `erasedAt`, and leaves the uploader's export. **What is left** is in the read table below: reads
  outside the erasure and record jobs whose weight is the live write's or the page's own, not this
  build's to rebound. Two ticks' settlements for one uploader can run at once and each read their
  history (correct, metered); and the orphan sweep that retries an `erasedAt` photo's blob reads the
  oldest photos first and can starve behind referenced ones.
  **What was withdrawn before the clock** gets one from the clocks backfill: content through Part A's
  stamps; an alert its author retracted before `retractedAt` existed (no time on the row, none in the
  history) is stamped at the backfill — never in the past — and so is one its author retracts again.
  Flags, requests and hazards have no withdrawals older than this branch. What each kind loses:
  a **comment** its words (a placeholder stays only where replies point at it, and goes with its last
  reply; comments keep no revisions); a **Report** its row, words, revisions, photos (unless the
  uploader's other content still uses one) and bay joins — its hazards stay unchanged and unlinked,
  its recording is unlinked with its prompt settled (`dismissed`, so nobody is asked again to report
  it), an access alert filed from it is unlinked, its point events stay (a delta, a reason, the
  Report's id and a time — no content), and its Post drops it and re-derives its album, sort key and
  search words; a **Post** goes after its last member (held while any member is stored), with its
  words and revisions — and a verdict or an open flag on a Post holds its members too, since it
  judged what the Post showed; a **hazard** its row, photos and its author's own vote; a retracted
  **request** or **flag** its row; an **access alert its author retracted** its row and the author's
  own vote (other skaters' votes stay theirs; a moderator's retraction of a live alert is not on the
  clock). A moderator keeps a withdrawn alert as evidence by retracting it again with a reason: on an
  alert its author already retracted that records a verdict (`contentVerdicts`, kind `retracted`)
  instead of moving the row, holds it, shows on the People record, and is ended by
  `overturnVerdict` (under the alert lever, `access.alert`). The clock is `WITHDRAWN_ERASE_DAYS`, a
  sibling of the account grace pinned equal to it, because the codebase names each promise it
  states.
- **Other people's content attached to an erased item stays theirs.** Comments on an erased Report
  stay in each commenter's record and export, unreachable in the app (the thread answers empty, as
  for a removed Report today); replies under an erased comment hang from its placeholder; ratings,
  flags and votes others left stay, pointing at an id that no longer resolves (their readers already
  skip a missing target — the flag queue shows "(deleted)"); a bounty another skater posted keeps its
  fulfilled state and its answer list skips the gone Report; notifications already delivered to
  others stay in their inbox. Two things copy a Report's content and stay, per call 5: a hazard
  derived from a located sighting carries the sighting's words in its description ("Seen, not
  skated: …") — the hazard's own words now, withdrawable with it; and a put-in the pre-D62 purge
  made from a Report's point keeps that coordinate as an access point, its link to the Report cleared
  at erasure.
- **Hazard withdrawal (call 6).** `hazardWithdrawal.withdraw`: the author, while no other skater's
  latest vote is `still_there` or `healing_unsafe` (a property test over any votes). The pin leaves
  as never posted — moderation `removed`, lifecycle untouched, so nothing reads it as healed — and is
  final. Refused for good (call 7): a merge tombstone, a survivor that absorbed pins, a member of a
  cross-season pattern, and a pin promoted to a permanent feature — each a shared record now, and
  the refusal says so.
- **Retraction (Part D).** Requests (`corpusRequests.retract`, while open; approve and decline then
  say the asker withdrew it), flags (`contentFlags.retract`, while open or picked up; not one the
  system filed or has counted again for others; it leaves the queue and stops holding content), and
  alerts (the author's retraction only while a live community claim no moderator ever pinned — read
  from the history, bounded, an undone pin not counting; a moderator's of someone else's alert
  unchanged, but on their own alert a moderator is its author and follows the same rule; an
  author-retracted alert can't be pinned or released back). The author's own `open` resolves their
  alert, pinned or not, releasing the pin with an `author_resolve_access_alert` history row; **both
  clients show the author "It's open" on their own pinned alert** (one rule in core,
  `accessAlertVoteControls`; web has a render test, the phone has no render harness and was not
  device-tested). Which alerts are the viewer's comes from its own small query
  (`accessAlerts.myAlertIdsForBody`, read by author, live status and, for `active`, the clock —
  `by_author_status_expires_at` — so its cap bounds their live alerts, not a history no row ever
  leaves; which lake an alert is on is the shared read's own rule; the clients ask it only once the
  lake has an alert), never from `accessForBody` or
  `listForBody`: those are the lake page's shared reads, and reading the viewer there would cache a
  copy per person and re-run per person on every alert change. **No client reaches the retractions
  yet** (the register).
- **The export carries what a person filed.** `dataExport.collect` now includes their flags (only
  ones a person filed — a system flag names someone who filed nothing; a flag from before `origin`
  existed reads as the system's, the rule the flag notifications use) and their requests (the
  catalog's polygon named, not copied), leaving out which moderator decided either; access alerts,
  their votes and hazard confirmations were already in. A retracted one erased at 30 days leaves
  nothing there.
- **No pointer to an erased Report.** A put-in the pre-D62 purge made from a Report's point keeps its
  place and coordinate on the community record and loses only its `originReportId`; a landmark
  proposal the Report's `where` filed stays the author's request and loses its `reportId`.

**B01-1b: every read, weighed (2026-11-13, after Greptile's third round on #110).** Every database
read in the files D248 touched, with what one row can weigh and what rests on the answer. *R* is the
1 MiB document limit (any row with an uncapped field), *F* a flag (its note is uncapped, so *R*),
*V* a verdict row (ids and numbers, ≤ 8 KiB), *C* a comment (2,000 characters, ≤ 16 KiB), *S* a row of
ids, numbers and literals (≤ 8 KiB). "Charged" means the read goes through `lib/readBudget` and the
transaction holds at most 12 MiB of charged reads; the guard in `packages/guards/src/readBudget.test.ts`
holds the first four modules to that. Two tests apply to each row — **weight** (can the transaction
pass 16 MiB with valid data?) and **completeness** (is a capped, `null` or partial answer used to
erase, hide from the export, restore, record or clear a verdict, or start or stop a clock?) — and a
third to each continuing job: **progress** (does every pass erase, stamp or advance something?).

| Where (at the PR's head) | Table · index | Bound | Row | Rests on it | Weight · completeness · progress |
| --- | --- | --- | --- | --- | --- |
| `erasure.ts` `dueHead` (7 tables) | erasable table · `by_erase_at` `gt(0).lte(now)` | 1 row a step | R (C) | which item is erased next | charged; exact due range; each step erases, clears or moves the head's clock, or drains a row — **fixed** (was a page of up to half the budget, with an item's fixed reads uncounted) |
| `lib/eraseClock` `directHold` | `contentVerdicts` · `by_target_standing` | `first()` | V | holds erasure | charged; an existence check on an exact prefix is complete |
| `lib/eraseClock` `directHold` | `contentFlags` · `by_target_status_reason` ×2 | `first()` each | F | holds erasure | charged; complete; a Report reads its Post's too (`HOLD_COST`) — **fixed** (was uncounted, and re-read the Report and its Post) |
| `lib/eraseClock` `refreshEraseClock` / `holdMoved` | the item; a Post | one `get` | R | the clock | charged; a caller holding the row passes it (`refreshClockOf`); a Post's members follow in `refreshMemberClocks` — **fixed** (ten members inline read ~70 MiB at worst) |
| `erasure.ts` `eraseComment` | `comments` · `by_parent` ×2, `get` | `first()` / one | C | placeholder kept or deleted | charged; complete |
| `erasure.ts` `eraseRevisions` | `contentRevisions` · `by_target` | drained by budget | R (Post: 84 KiB) | erased before the row | charged read + touch; the row goes last |
| `erasure.ts` `eraseReport` links | `reportSubAreas`, `putIns`, `accessAlerts`, `waterBodyRequests`, `hazards`, `photos` · `by_report` / `by_origin_report` | drained by budget | S / R | unlinked or deleted before the row | charged; a drain runs to a short page or stops the pass with the item whole |
| `erasure.ts` `eraseReport` recording | `gpsActivities` `get` | one | R | returned to private | charged (kept back in `TAIL`) |
| `erasure.ts` `eraseHazard` / `eraseAlert` own votes | `hazardConfirmations` · `by_hazard_and_user`; `accessAlertVotes` · `by_alert_user` | drained | S | erased before the row | charged |
| `erasure.ts` `eraseHazard` origin Report | `reports` `get` | one | R | Report stops listing it | charged |
| `erasure.ts` `dropErasedMember` (new job) | `posts` `get`; members `get` | 1 + ≤ 9 | R | the Post's album, sort key, search words, clock | charged, 11 MiB; one write — **fixed** (ran in the sweep, three helpers re-reading ten members: ~33 MiB) |
| `erasure.ts` `refreshMemberClocks` (new job) | `posts`, members, holds | a few members a pass | R, F | members' clocks | charged; the first member always fits, so every pass advances |
| `erasure.ts` `settleStep` reports | `reports` · `by_author` | paginate by budget | R | strikes photos in use | charged |
| `erasure.ts` `settleStep` hazards | `hazards` · `by_author` `gt(_creationTime)` | take by budget | R | strikes photos in use | charged; resumes after the last hazard read, so one filed mid-settlement is seen — **fixed** (a paginate cursor at the end of a range reads nothing new) |
| `erasure.ts` `settleStep` deletes | `photos` `get`, `accessPhotos` · `by_photo` | as many as the budget affords | R, S | **a photo is erased** | charged; only in a transaction that read to the end of the hazards; the rest carry on, the list only shrinking — **fixed** (Greptile #110: every remaining photo in one transaction) |
| `erasure.ts` debts (`photoSettlements`, `photoSettlementQueue`) | the erasing transaction inserts debts of ≤ 500 photo ids and reads the uploader's queue row (`by_uploader` `first()`) to add one; `settleOwed` · `by_parked_queued` `take(1)` a turn; `settleStep`'s place `first()`, take · `by_uploader` ≤ 16 debts, clear: each debt `get` + delete | 1 a turn; ≤ 16; while the budget lasts | 64 KiB (≤ 500 ids) | **erases photos later; a debt cleared only after its settlement finished; a failing uploader parked, never in anyone else's way** | charged — **fixed** (the list rode the sweep's arguments, then a claim by re-stamping let a failing uploader with more debts than one take starve everyone: Greptile #110). Each step is its own nested transaction; failures are counted on the queue row and park the uploader after three |
| `accountDeletion.ts` `erasePrivate` debts | `photoSettlementQueue` · `by_uploader` `take(size)` (one row); `photoSettlements` · `by_uploader` `take(size)` | 200 rows a pass | R (an item's photo ids) | drops a deleted person's place in the queue and their debts; their photos go with the `photos` stage | not charged, as no read of `erasePrivate` is; realistically under 1 KiB a row (an item's few photo ids), but an item's list has no cap below Convex's 8,192 values, so 200 rows at worst could pass 16 MiB — **not changed**, like the stage's other drains |
| `erasure.ts` `backfillClocks` | each erasable table · `by_creation_time` `gt(after)` | rows by budget, a withdrawn row's stamp, hold and clock kept back | R | **starts a clock** | charged; resumed by creation time (erasure deletes rows mid-walk) — **fixed** (each row's hold re-read the Report and its Post uncounted: ~24 MiB on a page of eight) |
| `contentRecord.ts` `backfillVerdicts` | `moderationActions`, paginate; newest row · `by_target` desc; the item `get` | sized by budget | R | which item to replay, once | charged; an item is replayed at its newest row — **fixed** (200 audit rows a page) |
| `contentRecord.ts` `replayVerdictHistory` (new job) | `moderationActions` · `by_target` asc, paginate; `contentVerdicts` · `by_action` | sized by budget | R, V | **records, ends or drops verdicts** | charged; the whole history, a page a pass, two passes; no fallback — **fixed** (Greptile #110: the newest 100 rows, and a guessed standing verdict) |
| `contentRecord.ts` `personVerdicts` / `personWithdrawals` | `contentVerdicts` · `by_subject_standing`; action and item `get`; each kind · `by_author_deleted` | paged by budget | R | the People page (display) | charged — **fixed** (100 verdicts × action + item, and 5 × 100 rows, in one query) |
| `authorDeletions.ts` `backfillFromAudit` | `moderationActions`, paginate; the item `get` | sized by budget | R | hand-off | charged — **fixed** (200 rows a page) |
| `authorDeletions.ts` `stampWithdrawal` (new job) | `moderationActions` · `by_target` `gt(_creationTime)`; `by_undoes` `first()`; members `get` | sized by budget | R | **"restored since" → stamps (finality, and later a clock)** | charged; read to the first standing restore or the end — **fixed** (the newest 100 rows; longer left unknown) |
| `authorDeletions.ts` `backfillCommentDeletions` / `commentLastWord` | `comments`, paginate; `moderationActions` · `by_target` desc | sized by budget | C, R | **the last word → stamps** | charged; read to the first deciding word or the end — **fixed** (as above) |
| `lib/contentVerdicts.ts` `endStanding` | `contentVerdicts` · `by_target_standing` | 16 a page, until none | V | **ends verdicts** | complete: ends every standing one — **fixed** (`take(10)`, the rest left standing) |
| `lib/contentVerdicts.ts` `recordUndoneVerdict` | `contentVerdicts` · `by_ended_by` | `first()` | V | an undo re-records | complete |
| `lib/authorDeletion.ts` `authorDeletedAtOn` | the item `get` | one | R | refuses a restore | complete |
| `hazardWithdrawal.ts` `othersSayItIsThere` | `hazardConfirmations` · `by_hazard_and_verdict` + filter | stops at the first other person's | S | **allows a withdrawal (starts a clock)** | complete: skips only the author's own rows (one per person by the upsert) |
| `hazardWithdrawal.ts` `isJoined` merges | `hazards` · `by_merged_into` | `first()` | R | **refuses** | complete |
| `hazardWithdrawal.ts` `isJoined` patterns | `hazardRecurrence` · `by_water_body` | `MAX_BODY_CLUSTERS + 1` | R | **allows a withdrawal** | completeness **fixed** (a 1,001st pattern was never read; now unknown → refused); weight **not changed**: up to 1,001 rows a lake, realistically tens — past the limit the mutation fails, which refuses |
| `hazardWithdrawal.ts` `withdraw` | the hazard `get`; `recomputeBodySummary` (200 Reports + 200 hazards) | — | R | the lake card | the card helper is A06c's, shared by every hazard and Report write; **not changed** |
| `accessAlerts.ts` `everPinned` | `moderationActions` · `by_target` desc, paginate | 200 rows and 6 MiB **as the rows really weigh** (`maximumBytesRead`) | R | **refuses an author's retraction** | weight **fixed** (200 rows of uncapped reasons in one read); a history the read can't finish is unknown and refused with its own words (`historyTooLong`), never "a moderator confirmed this" |
| `accessAlerts.ts` `retract` | profile, the alert `get`; its clock | — | R | the clock | the clock reads the row as written — about 13 MiB at worst |
| `contentFlags.ts` `retract`; `corpusRequests.ts` `retract` | the flag / request `get`; target hold; clock | — | R, F | **starts a clock; releases a hold** | bounded (a Post's members via the job) |
| `contentFlags.ts` `flag` dedupe | `contentFlags` · `by_target` + two filters | every flag on the target | F | a duplicate open flag | pre-existing (A02); unbounded by weight; **not changed** |
| `contentFlags.ts` `myAccessFlags` | `contentFlags` · `by_flagger` `collect()` | all of a person's | F | display | pre-existing (A06f); **not changed** |
| `accessAlerts.ts` `recomputeAlert` | `accessAlertVotes` · `by_alert` `collect()` | every vote | S | the alert's lifecycle | pre-existing (A06d); small rows, unbounded count; **not changed** |
| `accessAlerts.ts` `loadLiveAlertsForBody`, `myAlertIdsForBody`, `create`, `vote`, `setOfficialImpl`, `expireLapsedAlerts` | `accessAlerts`, `parkingAreaBodies`, `putIns` | 64 / 500 / 512 / 200 | R | display; the lifecycle | caps bound counts, not bytes: every alert row is *R* only because the client-sent `idempotencyKey` is uncapped. Not erasure or record; **not changed** (capping the key — not user text — would bound them) |
| `dataExport.ts` `collect` | 17 tables · by person, `take(5000)` each | 5,000 a table | R | **what the export holds** | pre-existing (D33/A03): one query over every table, so a heavy contributor's export can pass 16 MiB, and a 5,001st row is silently left out; D248 filters only complete rows (`erasedAt`, `origin`); **not changed** — it needs the export built in pages, its own change |

**B01-1b: every chained job, sized (2026-11-14, after Greptile's fourth round on #110).** The budget made
every read safe and opened a new way to fail: a job whose full page did not fit at its worst case
threw `OverBudget`, and its chain stopped (Greptile: the verdict walk's page was sized for a row and
its item's newest row, but every newest row also looks its item up, found or gone). Every job that
charges the budget now does one of two things: **(a)** sizes its page with `sizePage` from a row's own
read plus `work`, everything any branch may charge for it, with what follows the loop kept back; or
**(b)** asks the budget for the next row's worst case before starting it, and saves its position when
the budget can't cover it. Either way each row's work (an `eraseDue` item aside: its drains size themselves
by what is left) runs inside `ReadBudget.row(work)`, which throws on
the first row whose branch charges more than declared, in any test that reaches that branch. A pass
that makes no progress throws instead of rescheduling, and every pass runs in `traced`, which logs the
position to re-run from (every job is idempotent from it) before Convex records the failure. Sizes
below are at the 12 MiB budget; *R* 1 MiB, *V* 8 KiB, *C* 16 KiB, *F* a flag (*R*).

| Job | Design | Page | One row's worst case (own read + work), every branch | Worst-case pass |
| --- | --- | --- | --- | --- |
| `contentRecord.backfillVerdicts` | a | 4 audit rows | R + newest row R + item R (found → hand-off; gone → continue) | 12 MiB |
| `contentRecord.replayVerdictHistory` | a | 4 rows, the finish (≈ 7 MiB) kept back | R + stray lookup and delete 2V + ended verdict lookup and write 2V; finish: item R + standing verdict 2V + clock (R + 4F + 2V + R) | ≤ 12 MiB |
| `authorDeletions.backfillFromAudit` | a | 6 audit rows | R + item R (`author_delete` rows; gone or live → continue) | 12 MiB |
| `authorDeletions.stampWithdrawal` history | a | 5 rows, item read and stamp kept back | R + an undo's lookup R (restores) | ≤ 12 MiB |
| `authorDeletions.stampWithdrawal` members | b | members until the budget ends | member R + stamp R | Post R + 5 members |
| `authorDeletions.backfillCommentDeletions` | a | ≤ 200 comments | C (a match hands off, no more reads) | ≤ 3.2 MiB |
| `authorDeletions.commentLastWord` | a | ≤ 11 rows, the stamp kept back | R | ≤ 12 MiB |
| `erasure.eraseDue` | b, each item nested | one item at a time while `PASS_NEED` fits (the due row, the item's `ITEM_NEED`, a failure's record; ≤ 11 MiB + 80 KiB for a Report) | the due row R; the item in `eraseOne` (its hold, its eraser's fixed reads, one drained row, its uploader's queue row); a failure: the item's row touched | ≤ 12 MiB; a pass that stops part-way on an item carrying a failure count clears it inside the eraser's unspent `TAIL` |
| `erasure.settleStep` reports | a | 11 Reports, its place kept back | R | ≤ 12 MiB |
| `erasure.settleOwed` (each sweep run's end, and its own hourly cron) | b, each step nested | turns while a turn fits (its place, a step's least `MIN_STEP`, a failure's record) | a place 64 KiB; the step gets the rest of the budget and spends what it charges; a failure: the place touched | ≤ 12 MiB |
| `erasure.retryParkedDaily` (its own daily cron) | b, each nested | **every** parked settlement, then every parked item of each kind, a pass at a time, chained: oldest tried first and only what was parked or tried before the run began, each while a turn or a `PASS_NEED` fits; a held item is walked past (its position carried); a pass that moves nothing throws (unreachable on a fresh budget) | as the hourly walks: a place, a step, a failure's record; a due row (two probes past a held item, at most one charged), `ITEM_NEED`, and either the failure's record or the un-park write (never both) | ≤ 12 MiB |
| `erasure.settleStep` take | a | ≤ 16 debts (≤ 500 ids carried) | 64 KiB | ≤ 1.2 MiB |
| `erasure.settleStep` clear | b | debts while one fits | 64 KiB + delete 64 KiB | ≤ 12 MiB |
| `erasure.settleStep` hazards + deletes | a then b | 9 hazards, one photo kept back; photos while one fits | R; a photo R + access check V + delete R | ≤ 12 MiB |
| `erasure.backfillClocks` | a then b | 5 Reports (more of lighter kinds), one row's work kept back; withdrawn rows while their work fits | R; a withdrawn row: stamp R + hold (4F + 2V) + clock R | ≤ 12 MiB |
| `erasure.dropErasedMember` | a (fixed) | the Post and ≤ 10 members (9 when the erased one is listed) | — | ≤ 12 MiB with the Post's write; more members than a Post can hold throws, traced |
| `erasure.refreshMemberClocks` | b | members while one fits | member R + hold (2F + V) + clock R | Post R + its hold + 2 members |
| `lib/contentVerdicts.endStanding` | — | 16 standing verdicts a read, until none | V (not budget-charged: a live writer's loop over rows the writers keep to one) | the writers' invariant |

Each job has a test on its dearest page under Convex's real limits (`chains.test.ts`). **No lint
holds this line.** A static check could insist page sizes go through `sizePage`, but the bug class is a
`work` that understates a branch, and only running the branch shows that. `ReadBudget.row` is that
check, at runtime, on every branch a test reaches.

**B01-1b: one failing item never starves the rest (2026-11-14, after Greptile's fifth and sixth rounds on #110).**
Greptile found the settlement could starve (a claim by re-stamping six debts let an uploader with
seven, whose settlement kept failing, be chosen again every time), then that a large item's failures
counted though progress came between them. The property now held by construction, for both
recurring jobs: **one item failing — any pass, any reason, every time — never stops, delays past the
run, or reorders anyone else's.** Each item's work is its own nested transaction (`eraseOne` for a
due item, `settleStep` for a step of an uploader's settlement), so a failure rolls back only that
item; the walk records it and goes on.

**Parking is one rule, read by both walks** (`lib/attempts`, a fast-check state machine):
- **Only a failure counts**, with the error's class (never its message). Three failures in a row park
  it: out of the due range (an item) or skipped by the walk (an uploader).
- **Progress clears the count, the class and any parking.** For the sweep, progress is an item erased,
  or anything it carries erased or unlinked in a pass that stops part-way; for the settlement, any step
  that goes through (taking debts on, a page further, a photo settled, a debt cleared). The clearing
  write happens only when there is something to clear, so the common path writes nothing, and fits by
  construction: a part-way stop always leaves the eraser's reserve (`TAIL`, never less than the row)
  unspent; a settlement step clears in the write it makes anyway.
- **Held is neither**: an item a verdict or an open flag keeps is not attempted and not written.
- **One attempt a run.** Each run reads only what is due by the moment it started; a failure moves the
  item's clock, or the uploader's turn, just past that cutoff — so three failures in a row take three
  runs, and a healthy settlement (whose turns stay at the cutoff) still finishes in its run.
- **Parking heals itself.** `erasure.retryParkedDaily` (its own daily cron) tries every parked
  settlement and every parked item of each kind, a pass at a time and chained (the cap of three a kind
  a day went in the follow-up to #110, so a backlog clears the day its fix deploys), least recently tried first, each
  in its own nested transaction and never in the hourly walks' way, each once a run (it reads only what
  was parked or last tried before it began). A held item is not tried and stays as it is; the walk goes
  on past it, so it never takes another's turn. A success un-parks it and the walks carry on with it
  when the run ends; a failure keeps it parked, re-stamped as just tried — behind every other
  parked piece next day, so one that never works can't keep another from its turn — and noted as
  retried. A deployed fix frees what it parked within a day with nobody remembering to;
  `erasure.retryParked` still releases everything at once. `erasure.parked` (`machinery.read`) lists
  each with its attempts, class, when last tried and whether the daily retry has run.
- **Parking never clears a debt, deletes a photo or erases anything.**

Where the state lives: **on the item's own row** for the sweep (`eraseAttempts`, `eraseErrorClass`,
`eraseParkedAt`, `eraseRetriedAt`, with `by_erase_parked`) — the item already carries its clock, the
sweep already reads the row, and the state goes when the item does; and **one row per owed uploader**
for the settlement (`photoSettlementQueue`) — the settlement succeeds or fails per uploader, an
uploader has no row of their own to carry it, and the same row holds the settlement's position, so a
run that dies resumes where it was. A new debt does not release a parked uploader: what fails is
reading their history, which a new debt does not change; the daily retry does. Fast-check properties
hold both walks over any outcomes across runs, any subset failing (`erasure.test.ts`, "fairness under
failure, under any mix").

**The other recurring jobs, and whether one poison item can block them** (read, not run; none
changed here — they are outside D248 and go to the follow-up with the text caps). The one-time,
hand-run backfills (`authorDeletions.*`, `contentRecord.backfillVerdicts`, `erasure.backfillClocks`)
may fail loudly and stop; each logs where to re-run from (`traced`).

| Cron | Blocks forever? | Why |
| --- | --- | --- |
| flush notification queue | yes | oldest due rows in one transaction, no per-row isolation; a throw rolls back the pass and the next starts at the same row |
| prompt unreported skates | yes | oldest 50 pending activities in one transaction; its own comment says a throwing tick re-reads the same rows forever |
| sweep body summaries (due mode) | yes | oldest 50 due cards in one transaction; only a success moves a card past now |
| watch for the imagery season to open | yes, by design | one site's fetch failing fails the whole tick; the site list is fixed |
| sweep orphan photos | yes, without any failure | the oldest 500 photos past grace, in-use ones skipped unmarked: once 500 in-use photos are old, it re-reads them forever |
| refresh hazard weather | partially | per-hazard try/catch, but a failed one stays at the head; ~1,000 such freeze it |
| finalize account deletions | partially | a job per account, but a failing one stays in the oldest-first 20 |
| sweep expired exports | partially | an undeletable bundle stays at the head of 500 |
| pump live satellite imagery | partially | a granule stuck in flight holds one of 100 slots |
| reconcile weather cell registry, repair weather archive gaps, demote inactive bodies at the rollover | partially | a page that throws ends the walk; the next run starts over and dies at the same page |
| recompute hazard recurrence at the rollover | partially | attempts saved and a body skipped after three, but a failure ends the day's chain inside a 7-day window |
| refresh nws alerts | partially | a state whose write throws skips the states after it while that alert is live |
| expire bounties, expire access alerts, the prune and purge jobs, roll up operator metrics, sweep water-body coverage, append daily (bay) weather archive, expire departed skaters' photos, poll for new satellite imagery, rebuild the live imagery index | no | per-item isolation, a cursor that moves past failures, deletes or status patches only, or no per-item work |

**B01-1d (2026-11-14): the recurring jobs, fixed** (D258). Every job the table above marks *yes* or
*partially*, read against the code first, then changed so one failing item never stops, delays past
its run, or reorders anyone else's work. The shared pieces are `lib/recurringWork` (an item in its own
nested transaction under limits of its own, the walk asking the transaction's real metrics before each
item, `jobFailures` for work with no row of its own, `jobPositions` for a walk that laps its table) and
`lib/attempts`, the rule the erasure already used. `recurringJobs.health` (`machinery.read`) is the one
read Machinery will draw: per job, failing and parked counts, the oldest parked time and oldest
failure, and the error classes — counts only, from small rows only (`jobFailures`, where the
queue-shaped jobs mirror the state they keep on their own rows, and where the finalize sweep counts an
account more than a day past its date and the export sweep a bundle whose blob would not delete),
every count capped and saying so.

**Where the audit's list was wrong or short:**
- *Sweep orphan photos* was worse than stuck: its read of 500 photos at up to a document each (the
  caption is uncapped) and its one-transaction reference scan (4,000 Reports and 4,000 hazards per
  uploader) could each fail the same page every day by weight alone, with no item throwing.
- *Prompt unreported skates* could also fail by weight: fifty due recordings and fifty windows of fifty
  recordings each, a path per row, in one transaction.
- *Demote inactive bodies at the rollover* was understated as "partially": a run that fails is retried
  only through 14 July, so a page that always throws left every body past it undecided for the season.
- *Refresh hazard weather*: a fetch that comes back empty is deliberately left un-stamped and is not a
  poison item (Open-Meteo down leaves them all at the front, and they all go when it returns); only a
  throw was. Its list read of 1,000 hazards at up to a document each is unbounded by weight (owed).
- *Finalize account deletions*: the ghost redaction beside it had the same shape (the oldest 200
  pending, re-read every hour).
- *Flush notification queue*: a new event coalesced into whatever row held its key, so once a row is
  parked a new event would have landed in it and never been sent (found while fixing; now a parked row
  is passed over by a new index).
- The *no* row was spot-checked, not re-read in full (the departed-photo sweep and the season purge
  hold up); the Bodies library's three crons came after the audit and park on their own.

| Cron | Was | Now | Parked means | Test |
| --- | --- | --- | --- | --- |
| sweep orphan photos | the oldest 500 past grace, re-read for ever | a lap from a saved place (`jobPositions`), a chain owning it by run and lease; the photos the settlement would keep without reading history (a back-link, an access point) passed, the rest owed to the settlement (`erasure.owePhotos`), whose complete check is the one rule; an erased photo's blob retried directly | a marker: the daily lap is the retry | `storageHygiene.test.ts` "600 old photos in use…", "…a hazard filed mid-walk…", "sweepOrphanPhotos under failure" (fast-check) |
| flush notification queue | one transaction, a throw re-ran first | the batch whole, then a row at a time if it fails; a failure counted on the row, moved past the run's cutoff; twelve-hour freshness on every row | out of `by_parked_flush`; retried hourly, expired past the window | `recurringJobs.test.ts` "flush notification queue, under failure" (fast-check), "the freshness rule…", "…never coalesces into a parked row" |
| prompt unreported skates | fifty rows, one transaction | each skater's due rows in their own nested transaction; the run walks forward from a position it carries | out of `by_prompt_parked_detected`, still on the skater's list; retried daily | "prompt unreported skates, under failure" (fast-check) |
| sweep body summaries (due mode) | fifty cards, one transaction | each card in its own nested transaction; a failure moves it past the run's cutoff | out of `by_parked_refresh_at`, its card left as it was (hazards included); retried daily | "sweep body summaries (due mode), under failure" (fast-check) |
| demote inactive bodies at the rollover | a page that threw ended the run | the page whole, then a body at a time; the rule is one helper (`rolloverBody`), unchanged | the body stays active; the daily retry decides it, parked or not, since the walk runs once a season | `standing.test.ts` "a page that throws…" |
| reconcile weather cell registry | a page that threw ended the walk | pages bounded by weight; a write whole, then a row at a time; a run with failures prunes nothing and is not marked complete | never parked; the next walk retries | `weatherArchive.test.ts` "a page whose write throws…" |
| repair weather archive gaps | a cell that threw ended the walk | each cell an item; counted, the walk goes on | a marker: the daily run is the retry | "one cell that throws no longer ends the walk…" |
| refresh hazard weather | a throw stayed at the front | a throw is stamped to the back, its last multiplier kept, counted | never parked: the cadence gate spaces its tries | `hazardWeather.test.ts` "a hazard whose refresh throws…" |
| refresh nws alerts | a state's failed write skipped the rest | each state's write an item; it keeps what it had | never parked | `weatherAlerts.test.ts` "a state whose write throws…" |
| watch for the imagery season to open | a failed tick was silent past the logs | all or nothing kept (a shrinking sample opens seasons); each failed day counted with its class | never parked | `imageryIngest.test.ts` "an Open-Meteo failure throws…", "a tick that goes through clears…" |
| finalize account deletions (and the redaction) | the oldest twenty (two hundred), every hour | a turn after the last tick's, wrapping | never parked; overdue accounts on the read | `accountDeletion.test.ts` "accounts whose chains keep failing…" |
| sweep expired exports | the oldest five hundred | a turn after the last tick's, wrapping | — | `storageHygiene.test.ts` "bundles whose blob will not delete…" |

Each queue-shaped job's property holds, over any set of items and any subset that always fails: every
healthy item goes through in its first run, a failing one is tried once a run and parked after exactly
three failures in a row, the walk does not try it again, the retry frees it once it heals with nobody
releasing anything, and no item is delivered twice. The lap walk's version: every photo once a lap,
counted while it fails, cleared by the lap after it heals. One seam makes any item fail in a test:
`lib/recurringWork.asItem`, which every isolated item runs through.

**Sized, under Convex's real limits** (`recurringChains.test.ts`, every row near the document limit):
these walks use design (b) with real metrics — before each item the walk asks whether the transaction
can still pay the item's own limits and a reserve past it, so a light item leaves room for many and a
heavy one for few, and the item runs under those limits.

| Job | Item's own limits (read · docs · queries · writes) | Reserve past it | Worst-case test |
| --- | --- | --- | --- |
| `storageHygiene.sweepOrphanPhotos` | 2 MiB · 20 · 20 · 10 | 3 MiB, for the next photo and each owed uploader's queue place | thirty photos near the limit, half in use: the lap ends, the orphans go |
| `notifications.flushNotificationQueue` | the batch 8 MiB · 8,000 · 3,200 · 4,000 (above its own 3,000-read soft stop); a row 3 MiB · 2,000 · 200 · 500 | 1 MiB | twenty recipients near the limit: the batch fails as a batch, every row lands one at a time |
| `gpsActivities.sweepUnpromptedActivities` | a skater 8 MiB · 3,000 · 300 · 300 | 1 MiB, plus 1 MiB per due row read | twelve skaters and recordings near the limit: each is asked |
| `waterBodies.refreshDueBodySummaries` | a card 8 MiB · 2,000 · 100 · 50 | 1 MiB | cards with four Reports near the limit each: several batches, every card refreshed |
| `recurringJobs.retryParkedDaily` | 8 MiB · 3,000 · 300 · 300 | 1 MiB | (covered by the three properties' retries) |
| `recurringJobs.health` | small rows only: `jobFailures`, to 200 a job | — | fourteen parked queue rows near the limit: counted from their mirrors |
| `standing.demoteInactiveBodies` | a body 8 MiB · 2,000 · 200 · 500 | 1 MiB | twelve outlines near the limit: pages sized from them, every body decided |

**The jobs #118 added (B01-3b), read against the same question** (merged into this branch 2026-11-14):

| Cron | Blocks forever? | Why |
| --- | --- | --- |
| compute body geometry facts | no | each due body computed on its own (`Promise.allSettled`), a failure recorded on its facts row by `lib/attempts` and parked at the third; a run passes what it already tried; the unparked range leaves parked rows out |
| retry parked body geometry | no | the same walk over parked rows, least recently tried first; a failure re-stamps the row to the back |
| repair body geometry drift | in principle | one transaction over the 40 longest-unchecked rows, stopping by the real read budget; a row whose check *throws* (not one that is merely behind) would fail the tick, and the next tick reads the same rows. Nothing throws on valid data today; owed — isolate each row's check |
| find bodies missing geometry | partially | a page of library rows that throws ends the chain, and the next weekly run starts over and dies at the same page — the "same page" shape; the page reads small rows and probes one index each, so nothing throws today; owed |

Their parked count is not on `recurringJobs.health`: a geometry facts row carries the computed lists
and can be heavy, so counting them would load heavy documents; owed — a small mirror, as the queues
have, or the geometry module's own parked read.

**First read and fallback, worst case — and a fallback never repeats the read that failed** (Greptile
#116). Every walk with a "page failed" path, what its first read can weigh, and what its fallback reads:

| Walk | First read, worst case | Fallback, worst case | Every-document-at-the-limit test |
| --- | --- | --- | --- |
| rollover | a page sized from the heaviest outline: each body charged at 1 MiB (`lib/readBudget`), one body's decision (9 MiB) kept back — at most three bodies; each body then decided in its own nested transaction under 8 MiB | the same page at half the size it really read (three, whatever was asked for — so 3, then 1), from the same position; one body that still fails is read alone (1 MiB, always fits), recorded and passed; a body that is not active is passed without a nested transaction or a second read of its outline | twelve heavy outlines: reaches its end |
| registry reconcile | a page of bodies (and of bays) read by `maximumBytesRead` 6 MiB — at most 6 MiB and one document past it | the page's writes a row at a time (each one small registry row); the page is never re-read | twelve heavy outlines: every body registered |
| archive gaps | a page of registered cells by `maximumBytesRead` 6 MiB; each cell its own item | none — a cell that fails is recorded and the walk goes on | forty heavy cells: reaches its end |
| orphan photos | one photo a step (`first()`, at most 1 MiB), each examined in its own nested transaction under 2 MiB | none — a photo that fails is recorded and the lap goes on | thirty photos with captions near the limit: the lap ends |
| flush notification queue | a batch read by `maximumBytesRead` 2 MiB (at most 250 rows) under the batch's 8 MiB | one row at a time (`first()`, at most 1 MiB), each under 3 MiB — a smaller read than the batch, never the batch again | forty queue rows near the limit: every row lands |
| prompt sweep | one due row at a time (`first()`, at most 1 MiB) while a skater's prompt still fits | none — a skater that fails is recorded on their rows | twelve heavy recordings and recipients: each asked |
| card sweep | one refresh row at a time (small), each card in its own nested transaction under 8 MiB | none — a card that fails is recorded on its row | cards with heavy Reports: every card refreshed |

**What "latest" means, and every comparison that orders by a timestamp** (Greptile #116, P2: the
digest picked its report by a row's `createdAt`, which a later event joining the row does not move —
after a zone change and back, two rows flushed together and the older report won). The class is a
decision made from a proxy timestamp the thing it stands for can drift from. Each comparison, its
field, and why:

| Where | Decides | Field | Why it is the right one |
| --- | --- | --- | --- |
| the digest (`flushRows`) | which report a lake's line links | `latestAt`: the linked report's own creation time, moved only forward by a join (`createdAt` on a pre-D258 row, which is never joined and drains within the day) | follows the content, not arrival order — a fan-out page for an older report can land after a newer one's; the fix |
| freshness (`isStaleQueueRow`) | expire or deliver | `dueClockOf`: `firstDueAt`, or a pre-D258 row's earliest clock | a deadline, and it must never move |
| joining (`coalescingRow`) | whether an event may join a row | `firstDueAt` after now; `flushAfter` after now and no later than the event's | the row's clock has not started, and joining never delays the event |
| a failure (`recordQueueFailure`) | when the row is tried next | `flushAfter` moved past the run's cutoff | delivery time only; the clock (`firstDueAt`) is left alone |
| the flush and retry order | which row first | `flushAfter`; `parkedAt` (least recently tried) | order only — no decision about content |
| the Machinery read | oldest failure, oldest parked | `firstFailedAt`, `parkedAt` | `firstFailedAt` is written once per failing stretch, so it is how long something has been stuck; `parkedAt` is re-stamped by every retry that fails (`lib/attempts`), so "oldest parked" reads as least recently tried, never as how long parked |
| forgetting a failure, "failed since" (`forgetFailuresBefore`, `failedSinceAt`) | whether a walk saw a failure again | `lastFailedAt` against the walk's or lap's start | re-written on every failure, so one from before the walk began is one the complete walk did not see fail again |
| the lap walks | where to resume | photo `createdAt`, export `expiresAt`, account `deletionRequestedAt`, recording `detectedAt` | positions in an index; a value that changes (a re-requested deletion) only moves an item within the lap, which wraps |

**A dry run writes nothing** (Greptile #116). The only dry mode among these jobs is the rollover's
(`apply` false). It now records no failure and clears none — a failure is cleared only by an applied
decision — and the purity property found one more write: the dry run's success scheduled a weather
registry reconcile (`importRuns.finish` fires one for `standing_rollover`); `finish` now takes
`applied: false` and schedules nothing. The property: over any corpus, any bodies whose decision
throws, any pages that shrink to the single-body path, and any failures already recorded (parked or
mid-retry), every table is unchanged but for the dry run's own `-dry` run row — kept, since it is how
a dry run's counts are read — and nothing is scheduled.

**The freshness rule, by construction** (Greptile #116): a notification row's due clock (`firstDueAt`)
is written with the row and nothing moves it, nor its due time; a new event joins only a row that is
unparked, still settling and due no later than the event would be alone (an event stamped earlier — a
digest for a recipient who changed zone — starts a row of its own), otherwise it starts a row of its own; a row written before D258 is read by its earliest clock
(`createdAt` for an actor row, `flushAfter` for a report notice), never as fresh, and never takes a new
event — a fresh event on it gets its own row, so it can never expire undelivered with the old one
(Greptile #116's legacy-row case; a backfill would only stamp the same guess, and old rows drain
within a day). The actor path's old
"a due row takes the incoming deadline" branch was the moving deadline, and is gone: a re-thumb after a
row fell due is its own notification. Review found the one deadline still moving: a failure moves a
row's due time just past its run's cutoff, so to an event at that cutoff a failed row read as still
settling — and a pre-D258 row's first failure stamps its old clock, so the "no clock of its own" guard
let it through, to expire the fresh event with it. The join now asks that the row's clock has not
started (`firstDueAt` after now), which keeps out both. And since one key can now hold several rows
(a pre-D258 one, a parked one being retried, a zone change, a late flush), a digest names each body
once, its counts summed.

**Owed, with the reason:**
- *Pump live satellite imagery*: a Machine that stays live keeps its granule in flight and one of a
  hundred slots; every other failure already counts attempts, fails the granule and alerts. Bounded by
  how long a cut can run; not changed.
- *Recompute hazard recurrence at the rollover*: already saves attempts and skips a body after three;
  a failure ending the day's chain inside the seven-day window is the remaining shape, and its retry
  is the next day. Not changed here.
- *Refresh hazard weather*'s list read (1,000 hazards and their bodies at up to a document each) is
  unbounded by weight.
- *The Bodies library queue* keeps its own copy of the park rule (`lib/bodyLibrary.recordRefreshFailure`):
  it keeps the first `parkedAt` where `lib/attempts` re-stamps it, and has no daily-retry stamp, so the
  switch is not behavior-neutral — left as it is.
- *A parked map card* keeps its last counts and quality dots past their window. Clearing it would drop
  its hazards, which reads as all-clear, so it stays; drawing it as stale needs the clients.
- *The orphan walk owes every in-use photo with no back-link every lap* (hazard photos, pre-A10 Report
  photos): the settlement then reads that uploader's history once a day. Correct and bounded; a cost
  that grows with hazard photos.
- *Found in review and left:* a
  hazard-weather or weather-gap failure whose work goes away (the hazard resolves, the cell leaves the
  registry) keeps its row until cleared by hand — neither walk has a complete pass that proves the work
  gone, as the orphan lap's end and the registry's complete walk do; four indexes the new ones replace
  (`notificationQueue.by_flush`, `.by_coalesce`, `bodySummaryRefreshes.by_refresh_at`,
  `gpsActivities.by_prompt_state_detected`) are unread now and wait for the narrow step after deploy;
  the orphan walk reads each photo's failure row to clear it (a query a photo); and the position walk
  (same value and a later creation time, then a greater value) is written in four places.
- *The rollover's pages are small*: sized from a heavy outline with one decision kept back, a page
  holds at most three bodies, so a season's pass is several thousand page calls (once a year). The
  action walks at most 400 of them, or four minutes, and continues itself with its position and
  tallies, so the pass never nears the action limit; one run row records it at the end.
- *Overdue deletions are counted by the finalize sweep itself*: if that hourly tick fails outright,
  its count rolls back with it, and Machinery shows nothing overdue exactly when nothing is being
  finalized. A signal that survives the sweep's own failure needs a read of its own (owed).
- *A re-thumb after a row fell due is its own notification* (the moving deadline it replaces is
  gone): the actor can be named twice, minutes apart.
- *The mirrors* (`jobFailures` rows for the queue-shaped jobs) can briefly outlive a row erased some
  other way (an account's erasure, the season purge) until a retry's background check forgets it, a few
  a run.
- *A registry walk with a row that always fails* never prunes or completes until it heals: the
  registry keeps vacated cells (a few Open-Meteo calls), and the import debounce sees an hour-old
  in-flight claim as dead and walks again.

**B01-3 (2026-11-13): the Overview's server reads, and the page reading them.** Server and web on
one branch (`b01-3-server`).

- **The reads:** `console.overview` (the median open item as an instant the client ages, total users
  from a rollup), `console.corpusCounts` (duplicates as the dedup queue's own total, chord re-fits, place
  names, the last run — its own query so a flag filed doesn't re-read body outlines), `machinery.overviewJobs` (only
  the jobs a record can tell; the untracked crons are counted in *more* and never called ok),
  `console.systemFeed` (the machine's rows, actor-less), `seasonWatch.tape` and `.homeSummary`
  (moderator-readable; no site sampling), `metrics.keepingUp` / `.showingUp` / `.coverage` (every
  one taking the season), `console.heartbeat` and `.colleagues`.
- **The season's distinct figures** come from a walk (`seasonReach`), one page per transaction,
  writing `season_reach` and `most_reported` once at the end. Its tally travels as a scheduled
  function's arguments, so it is bounded (8,192 ids a set, 15,000 in all, 1,000 bodies); a figure past
  that reads as not recorded. A season whose sign-in rows retention erased (D254) can't be counted
  again: a re-walk keeps the signed-in figure the reads were showing, and says not recorded only
  when none was.
- **This week's contributors** stand whenever their reads were whole; *first-timers* alone reads as
  not recorded when someone's first contribution can't be told, or past 300 people.
- **What still says *Not recorded yet*:** cost (no invoice or rate rows exist), the pre-ice pass (no
  record of when it was done), enrichment (nothing indexes what a body lacks), a strip before the walk
  has run, a figure whose read stopped short, new accounts until every day of the season has a
  rollup row, and *signed in* for a season the sign-in record never reached (it began after the
  season's last day). A past season with no watch record says it for the watch, winter and imagery
  alike, and a past season's imagery reads *Ended* even when its record never closed.
- **Contract:** a job's time and the season's dates arrive as instants and record days and are written
  on the client in the reader's zone; first skated is the first on-ice report, a staff date only for a
  season without one and marked as staff's (the founder's call); imagery reads *Ended* once the
  watch's own close is recorded. A read whose answer turns on the time takes the page's clock as an
  argument, held near the server's (`callerNow`, `@skating/core`): Machinery and the faces by the
  minute, Metrics and the season tiles by the UTC day, the tape by its season — a cached read
  otherwise keeps its old answer while no row it read moves.
- **Open on the next server round:** H4's call sites in `moderation.ts` and its undo (D252's rule is
  built), the feed's target names, H3, U1, U2 — all in files the author-deletion PR is rewriting.
- **Found in review (#111):**
  - *Duplicates* counted rows by intake review reason, while the merge queue reads `dedupStatus`, so a body a skater drew over a known one (`waterBodies.create` stamps no review reason) sat in the queue and never reached the Overview. Both now share one read and one grouping (`lib/dedupQueue`), so the Overview's figure is the queue's `total` by construction. The count fetches only the candidates that can change it (an unflagged body named by two or more flagged rows), not every candidate's outline. A group past six bodies is one card, cut along its links: a breadth-first walk from its first flagged row, a body's candidates before the rows that name it. Every shown body links to one shown before it, and the card says how many it leaves out (*and N more*). *Not duplicates* clears the links among the bodies shown, never a pairing with a live body the moderator wasn't shown (links to deleted or merged bodies drop, as they always did), and the rest come back as their own card. The queue sorts by the whole group's size, not the cut's. A merged tombstone a one-way flag still names is never offered to keep or merge. **Open for a ruling:** merging from a cut card can clear the flag on a body not shown, if it was flagged only against the merged ones (`merge` drops a link to the loser rather than moving it to the survivor). The card warns about this, and merge is unchanged by instruction. Greptile caught the first cut, which listed the flagged rows first: six flags naming one lake hid the lake, and dismissing that card cleared nothing. A property test now drains arbitrary queues a card at a time and checks three things at every step: what is left to decide strictly shrinks, the count equals the queue total, and no card of two or more bodies lacks a link. **Open for a ruling:** an intake review reason alone is no longer counted, but the Corpus table above defines the Duplicates lane as both flags, one lane. Counting the union means the old water page's queue holds intake-only rows too, and nothing there clears an intake reason on a decision yet.
  - A day pulse count whose read hit its scan cap was saved as a whole number. It is now saved with no number, and the rest of the day still saves. That covers all eight strips: the five the pulse rollup counts and the day rollup's reports, hazards and new accounts. The strip draws that day *Not recorded yet*. The season totals come from the walk, except new accounts, which add up their days and so show no total while a day is missing. A day's rows only grow, so a re-run under the same cap stays not recorded; only a higher cap fills the gap.
  - The stat skeleton was sized `calc(n * 1ch)` on an empty box, and Chromium left that `ch` on the fallback face after Martian Mono loaded. That made it 13 px short in about one cold run in five, in the app as well as the story. It is now laid out from invisible mono glyphs.
- **Owed, left as is (the governor's ruling, 2026-11-14):**
  - *Signed in*'s season total counts from the day the sign-in record began (about 7 November 2026), and the page doesn't say so. An honest *since* label needs the record's first day from `showingUp`; the strip's first recorded day can be later than that when a day rollup is missing.
  - Splitting the reads in `seasonWatch.homeSummary` and `metrics.showingUp` so a row change re-runs less.
  - The caller clock's five-minute slack around midnight.
  - The kit `Logo` keys its dark ink on the old `.dark` class until the old pages retire.
  - Cost (S2): no ledger rows exist.
  - A strip with no record still draws its full-height hairline on hover.
- **Founder rulings (2026-11-14):**
  - A write refused for its length is not counted by the server; the "at the cap" band is the
    signal that writes are meeting the cap.
  - The audit feed shows an actor's "Name via script-name" in full on hover; the Actor column
    stays as it is for now.

**B01-1c (2026-11-14): the server follow-up that waited on #110.** One branch,
`b01-1c-server-followup`, opened after #112.

- **A write made through a script names the person and the script (D256).** `moderationActions.via`,
  written only by `lib/audit.ts` from the caller identity's `via` claim, and only when it passes
  `isAuditVia` (core). `convexRun` requires a `via` for every call made as a person and puts it beside
  the `subject` in `convex run --identity`, which needs the deployment's admin credentials, so no
  client can set it. It is a label, never a permission. History and the audit feed read "Teagan via
  seed-destinations", the name in mono. Old rows stay unmarked.
- **Discipline never strands the ledger, wired (D252).** `banImpl` and `suspendImpl` refuse the last
  ledger editor who can act, and an undo that puts a ban or suspension back runs through them.
- **A lift is refused on an account being deleted, or deleted** (`unbanImpl`, and so its undo).
  **Owed to the People server PR:** the other direction, a ban or suspension on an account `deleting`
  or `deleted` (the finalization lock, the tombstone), which overwrites that status, and whose lapsed
  suspension window would unlock an account mid-deletion. Found in this PR's review; left out of its
  scope.
- **Text caps at the write.** Report notes 5,000 characters (core's `validateReportInput`, on create
  and edit), photo captions 500, flag notes 1,000 (a person's and the automatic flags'), the
  access-alert `idempotencyKey` 128. No client sets a limit on any of them. Longer rows stay as they
  are. `lib/readBudget` charges a photo, a flag and an alert at their capped worst. That holds because
  every writer is capped and no existing row exceeds a cap: dev has none, prod has no data. A Report and
  its revision stay at the document limit, for their other fields.
- **The lengths are recorded, for a screen beside each cap (the founder, 2026-11-14).**
  - Each write of one of the three texts inserts a `textLengthEvents` row (counts only, never the
    text), folded per day into a `text_lengths` snapshot by band against the cap in force. An insert
    reads nothing, so writes never contend.
  - An edit counts its new length; the old one stays counted.
  - `metrics.textLengths` reads a season, with a day nothing recorded as `null`. The record has begun
    once an event or a folded day exists, so a quiet day after a quiet week (every event pruned) is a
    measured zero, not a gap.
  - **Refusals can't be counted:** a refused mutation commits nothing, so the server can't tally
    them. **Owed before launch:** a backfill of existing rows' lengths.
- **The daily retry walks all parked erasure work** (no longer three a kind), chained, each piece once
  a run; a pass that moves nothing throws.
- **Undo (U1, U2).** Any verdict on a Post down only because its Reports were (a restore, or a
  removal) records the member that took it down, and its undo puts the Post back marked
  `rederivedFromReportId`, so restoring a member later brings the Post back. A redo of that undo
  records what it clears in turn, so undo → redo → undo lands in the same place. "Undone by" names the
  undo's own row on the target.
- **A Post goes on the next hourly run after its last Report.** Its clock is set by the job the
  Report's erasure schedules, after that run's cutoff. With lighter charges the sweep no longer runs a
  second pass, so the tests that expected the same run now take the next one. That was always the
  production behavior: the tests freeze the clock.
- **Raw trust points stay visible to moderators — an accepted deviation** from the admins-only rule
  (D50; the founder, 2026-11-14, "at least for now"). `profiles.getPublicProfile` is unchanged; not a
  bug.
- **Waiting:**
  - H3: no console write calls the undo toast yet; `undo.latestOwn` serves it until one does.
  - S5's target names: a body's name needs #112's stored library row, not the body's outline.
  - `listActions`' verb filter in the index: it needs #112's `by_target_action`.

**B01-4 (2026-11-14): the People server** (boards 8.1, 8.2, 8.5, 8.6; the founder's rulings of the
same day, D257). Server only; the page is *The People pages (B01-4, the page)*, below.

- **The list reads a stored row per person** (`peopleRows`, `lib/peopleRows`), not `profiles`: a
  profile can weigh a whole document (two cached isochrone polygons), so a page of fifty could pass
  the read limit, and the lanes need indexes `profiles` doesn't have. The row is derived from the
  profile alone and written at every write that moves a fact it carries — the profile's creation and
  renames, the avatar mirror, every discipline and role write, the deletion request, its cancel, the
  finalization lock, the tombstone, the lapsed-suspension sweep; trust points take a light path (they
  move on every rating and no lane reads them). A drift repair re-derives the rows refreshed longest
  ago, ten every ten minutes, so a write that missed its refresh heals within days. The restriction
  marker and the suspension's end therefore live on the row, not on `profiles` (the brief's
  "restriction marker on profiles" became the row's `restricted`).
- **Counts, one rule per lane** (`lib/peopleFigures`, read by `people.lanes` and the Overview's
  People card alike): Everyone, Staff (admins + moderators), Banned, Restricted, Leaving and Deleted
  are `peopleCounts`, moved by the row writer in the row's own transaction — exact once the rows
  backfill marks itself done, and until then named in the read's `pending` (never `capped`); Suspended (still running at the page's clock)
  and Newest (the last seven days) are counted from the very index range the list pages, to 200;
  Flagged and Appeals open group the open queue their list pages (open flags; waiting account
  tickets), to 200. A property test drives random histories of writes and holds every lane's count
  to the rows its own list yields.
- **Orders, as the boards state them:** Everyone by name; Staff admins first, each by name;
  Suspended soonest to lapse first, an open-ended one last, a lapsed one gone at once; Banned and
  Deleted most recent first (a ban older than the row's record last); Restricted most recently
  restricted first; Flagged and Appeals oldest first; Newest newest first; Leaving the window that
  ends soonest first. A search ignores the lane and orders by match.
- **`can` is the write's answer** (`lib/peopleCan`): one function per lever family decides both the
  refusal a write throws and the `can` `people.person` returns, and undo state refuses through it too.
  A property test tries every lever as every viewer on every state a person can be in.
- **A deletion is never overwritten** (found by #113's review, owed here): suspend, ban and lift are
  refused on an account in its deletion window, being finalized or deleted; a restriction is refused
  only once it is being finalized or deleted. Every undo that would put a status back goes through the
  same writers and is shown unavailable first (undo state reads the light People row, which carries no ledger grant, so only the last-editor refusal waits for the write). **Detecting a row already broken on dev:** a tombstone
  a discipline write overwrote has `deletedAt` set and a status other than `deleted`; the rows
  backfill logs each it meets (`peopleJobs.backfillRows`), and `peopleJobs.restoreTombstoneStatus`
  puts one back. An overwritten finalization lock (`deleting`) heals on its own: the hourly
  finalization sweep re-drives any account past its window that isn't deleted, and re-locks it.
- **Flagged means the person or their content** (D257): `contentFlags.subjectUserId`, stamped at
  filing by both writers (a person's flag, `lib/autoFlag`), `null` for a body; `by_subject_status`
  reads a person's flags; `backfillFlagSubjects` stamps the rest. Until it has run, the flagged
  figures name it in their `pending`.
- **Give-backs ask no reason** (D226 at the writes): a lift, a restored right (flagging included), a
  raised or cleared bounty limit and a promotion take an optional reason and otherwise get a default,
  marked `reasonDefaulted` so History can leave it out (`reasonGiven: false` on the row); a demotion
  and every take-away still require one, and an undo asks one exactly when it takes something away (a
  role undo by rank, a bounty-limit undo by the limit in force).
- **`canFlag`** joins the posting-permission family (`setPostingPermission`, `permission:
  'flagging'`): the same shape (one boolean right, off with a reason, on without), so it shares the
  verb, its undo and History's words. `contentFlags.flag` refuses a member whose flagging is off;
  staff are exempt, and switching it off on a staffer is refused.
- **The lapsed-suspension sweep** (D222, ruling 10): `peopleJobs.sweepLapsedSuspensions` every 15
  minutes, over `profiles.by_suspension_due` (suspended, not parked, not in the deletion window, a
  lower-bounded range on the end); each reset is its own nested transaction writing an actorless
  `unban` ("The suspension ran its course"); a failure is counted on the profile (`lib/attempts`), the
  walk moves past it, three runs park it; `retryLapsedDaily` tries every parked one once a day, least
  recently tried first; `peopleJobs.parkedLapses` lists them (`machinery.read`). A new suspension, ban
  or lift starts the record over. A fast-check property holds fairness over any mix of outcomes.
- **Time to decide** reads when the item was filed from the decision's own row: the flag, request and
  drawn-body decisions now record `filedAt`. A drawn-body decision from before that can't be timed
  without reading its outline, so a week holding one reads *not recorded* until it passes.

**B01-4: every read, weighed.** *P* a profile (1 MiB, its isochrones), *R* a row with an uncapped
field, *F* a flag (its note capped), *S* a row of ids, numbers and short strings (≤ 8 KiB): a People
row is *S* (its reason line is cut to 280 characters).

| Read | Table · index | Bound | Row | Capped or partial says so |
| --- | --- | --- | --- | --- |
| `people.lanes` | `peopleCounts`; `peopleRows` ranges; open flags · `by_status` ×2; account tickets · `by_status_category` ×2; a queue lane's rows (`by_user`, one per person it names) | 64; 201 ×2; 201 ×2; 51 ×2; one each | S, S, F, S, S | `reasons` (the table below); `capped` exactly when there are any |
| `people.listPage` | one lane's range (`paginate`), or `search_people`; the queues as above; a queue lane's rows | ≤ 100 a page | S | `partial` and `reasons` (the table below) |
| `people.person` | the profile; `by_target_action` 1 row (its actor from the People row); flags · `by_target_status_reason` and `by_subject_status`; tickets · `by_clerk_user_created`; `by_flagger`; verdict counts; the last-editor check (admins' rows, once a request) | 51 / 101 a status; 201; 201; 501; 200 rows | P, R, F, S, F, S, S | `onUser`, `onContent` (also before the subject backfill), `flagsFiled`, `appealsCapped`, `hidden.capped` |
| `people.history` | `by_target` (user); verdicts · `by_subject_standing` ×2 and `by_subject_ended`, each its action row; flags · `by_subject_status` ×2, each its decision rows | `limit + 1` each (≤ 101) | R | a capped source keeps only rows newer than what it didn't read; `capped` |
| `people.decisions` | `by_actor`, filtered in the query, `paginate` | 100 a page, 2,000 scanned | R | `isDone` |
| `people.staffStats` | `by_actor` + `_creationTime` (`paginate`, nine weeks); per row this week its chain's first row (`lib/undoChains`) and its filing; grant rows; revoke rows | 2,000; 1 a row; 50; 50 | R | a week the read didn't cover; `undoneByOthers.capped`, `timeToDecide.capped`; `tenureCapped` when a role walk stopped short or read its last row without the entering grant |
| `people.staffSeason` (new) | `by_actor` + `_creationTime` over the season's own range (`paginate`); per decision its chain's first row; per takedown its verdict (`contentVerdicts.by_action`), the row that ended it and that row's chain | 2,000 rows, 4 MiB as they weigh; ≤ 600 decisions checked | R | `overturned.capped`; `overturned: null` and `empty` while the season's record hasn't opened |
| `people.reportTrend` | `reports.by_author_skate_end_time`, `paginate` | 3,000 rows, 8 MiB as they weigh | R | `capped`; `monthsCapped` only when the read stopped inside the window |
| `contentRecord.personVerdicts` | adds the comment's or Post's Report and the body's library row | charged (`ROW_MAX.bodyLibraryRow`) | R | a short page is not the end |
| `peopleJobs` sweep / retry | `by_suspension_due` / `by_suspension_parked` `first()` a step; nested reset | while a step fits (head *P* + nested 2*P* + a failure's touch *P*) | P | each pass logs its position (`traced`) |
| `peopleJobs.backfillRows` / `backfillFlagSubjects` / `repairDrift` | `profiles` / `contentFlags` · `by_creation_time`; `peopleRows.by_refreshed_at` | sized by budget (*P* + 2*P* nested; *F* + a target at *R*; 10 rows) | P, F, S | not marked ready after any failure |

**B01-4: every read that loads profiles** (Greptile on #115, P1 — a profile can weigh a whole
document, its cached isochrone polygons, so a read that loads many can pass the 16 MiB limit). The
caller's own profile (`requireCapability`) is one more in every row.

| Read | Profiles it can load, at worst | Worst bytes | Shape |
| --- | --- | --- | --- |
| `people.lanes`, `people.listPage` (and search) | none | — | light `peopleRows` only |
| Overview's People card (`lib/peopleFigures`) | none (the `accounts_total` snapshot aside) | — | counts, light rows, the queues |
| `people.person` | the target | 1 MiB | **reshaped:** the status note's actor from the People row; the last-editor check reads admins' light rows once a request, where it read every admin's profile once per lever |
| `people.history` | none | — | **reshaped:** each row's actor from the People row (`PersonRef`, names `null` only before the rows backfill); undo state reads the target's light row (and at most the last-editor check above, once a read) — it read one profile per row |
| `people.decisions` | none | — | **reshaped:** as History |
| `people.staffStats`, `people.reportTrend` | the target | 1 MiB | one `get` |
| `peopleJobs.parkedLapses` | a page: profiles until 8 MiB as they really weigh (`maximumBytesRead`) | 8 MiB | **reshaped:** paged with a cursor — it read 51 profiles in one go |
| `peopleJobs` sweep / retry | the head, and the nested reset's two reads, a step at a time | charged by `lib/readBudget` per step | the nested call's limit is now the budget left (`nestedAllowance`): a fixed limit is measured from what the caller already read, so a heavy head left the reset nothing and every heavy reset failed — which the old test, its profiles half the weight it meant, never reached; and, as in the erasure sweep, a nested call that fails is charged its whole allowance (its reads count though it rolled back), which ends the pass |
| `backfillRows`, `repairDrift` | a profile and its nested refresh (two reads) a step | charged per step | as the sweep |
| `backfillFlagSubjects` | a flag's target when it is a person | charged at the limit | one at a time within the budget |
| `restoreTombstoneStatus`, `lapseOne` | one (read twice) | 2 MiB | one person |
| `lib/ledgerEditors.otherLedgerEditors` (every revoke, demotion, suspension or ban of a holder, and every question about one) | a read: none once the rows exist; a write: ≤ 4 counted editors confirmed from their profiles; before the rows backfill, ≤ 6 admins under the check's own allowance | 0 for a read; 4 MiB for a write | **reshaped twice:** read from admins' light rows — role, grant, status, suspension and window are all on the row — **once per request** and shared by every question, forgotten when the request writes a People row; a write confirms what it counted, so a stale row only ever refuses |

**Per-row callers** (Greptile's second review of #115: a helper that loads profiles, called once a
row inside a paged read, had escaped the table above). Every helper here that can load a profile, and
each caller that runs it per row:

| Helper | Loads | Per-row callers | Worst case per page |
| --- | --- | --- | --- |
| `isLastLedgerEditor` / `otherLedgerEditors` | no profile in a read once the rows exist (the editors set, light rows, once a request); a write confirms ≤ 4 | `writeRefusal` for suspend, ban, a demotion and a ledger revoke — so `people.person`'s `can`, and undo state on every History and Decisions row | one light read of ≤ 200 admin rows a page, however many rows ask |
| `writeRefusal` (the `can` helper, `loadModeratableUser`, undo's refusal) | none of its own; the target's facts come from the caller (a profile in a write; the light row in undo state) | undo state per History / Decisions row | as above |
| undo state's person facts (`lib/undo`) | the People row; a person without one (before the backfill) read once per request, charged to `requestBudget` | every History and Decisions row on a person | in History and Decisions, what the request's one budget has left (the page's own reads charge it too); in a request that charges none of its own reads (the audit feed, a body's History, the toast) ≤ 4 profiles (`REQUEST_PROFILE_BUDGET`); then the undo says it can't be checked yet (`UNDO_NEEDS_ROWS`) |
| History and Decisions actor naming (`personRef`) | the People row only | every row | none |
| `withoutLedgerGrantsFor` | none (the viewer's own profile, already read) | every row | none |
| main's `undoState` → `authorDeletedAtOn` | the content item a row is on | every content row in History | pre-existing engine behavior; a content row's weight is its own (a report's notes capped at 5,000 characters) |
| main's `moderation.listActions` → `toActionView` | each row's actor's profile | every audit-feed row | **outside this PR** and unchanged: up to 100 actor profiles a page; worth moving onto People rows when the feed is next open |

`requestBudget` (`lib/readBudget`) is the guard: the helpers above that can still load a profile
charge it at a profile's worst, so a helper that starts loading profiles once a row throws in a test.
Worst-case tests under Convex's real limits (`peopleHeavy.test.ts`): a Decisions page where every row
is a ban or a lift of a different ledger holder at the document limit, and a Decisions page of rows
on sixteen heavy people without rows.

**B01-4: every read of every People query and job, on every limit** (Greptile's third review of #115:
the count of reads per row, the third axis in three reviews). Convex limits a transaction to 16 MiB
read, 32,000 documents, 4,096 database calls, and a query to one second; `lib/readBudget` now counts
calls and documents beside bytes (`TX_CALLS` 3,500, `TX_DOCS` 28,000, `TX_BUDGET` 12 MiB, headroom
left for what no helper charges) and every People query and job reads through one budget, asked
before each read (`affordsRead`); a row with no worst case below the document limit (an audit row, a
request) is read **as it really weighs** with its worst case reserved first (`measured`), and a
paged read under its own real-weight cap is charged that cap (`capped`). `packages/guards`'
read-budget lint now covers `people.ts` and `peopleJobs.ts`: a read there outside a charging call
fails the build.

| Function | Reads (direct and through helpers) | Loop · bound | Worst calls · documents | Worst bytes | When a bound is hit |
| --- | --- | --- | --- | --- | --- |
| `people.lanes` | counts (64); open flags ×2 (201); account tickets ×2 (51); two lane ranges (201, reserved); each queue lane's People rows | per person a queue names · ≤ 200 + 100 | ≈ 310 · ≈ 1,300 | ≈ 10.7 MiB charged at every cap, within the request's 11 MiB | `count.capped` with `reasons` |
| `people.listPage` | as above for the queues; one lane page (`page`, ≤ 100 rows) or search | per queue person · ≤ 200 | ≈ 410 · ≈ 1,400 | ≈ 9 MiB | `partial` with `reasons` |
| `people.person` | target; counts; status row (`measured`); flags ×4 (`takeCapped`, 51/101); tickets (51); filed (101); verdict counts (501, reserved); editors (200 rows, reserved, once) | none per row | ≈ 15 · ≈ 1,200 | ≤ 12 MiB by the budget | each figure's `capped`; a take the budget can't afford reads fewer and says capped |
| `people.history` | target; counts; the person's rows (`capped` 2 MiB real); verdicts ×3 (`takeCapped`), each its action row (`measured`); flags ×2, each its deciding row (`measured`); per merged row: actor and target name (People rows, memoized), undo state (main's engine: `undoRowOf` ≤ 16, the newest row, the content's author stamp, the person's row) | per item · ≤ `limit` (≤ 100) a source; per merged row ≤ 100 | sources ≤ 7 + 500 measured; rows ≈ 6 a row → ≤ 1,100 · ≤ 3,000 | sources within the budget; **the undo engine's per-row reads are main's, unbudgeted** (audit rows uncapped; a report at its worst) | a source cut keeps its horizon; `capped` |
| `people.decisions` | one `paginate` (`capped` 2 MiB real, 2,000 scanned); per row as History | per row · ≤ 100 | ≤ 700 · ≤ 3,600 | the page within its cap; the engine's per-row reads as above | `isDone: false` |
| `people.staffStats` | target; marker; role rows walked one at a time first (`measured`, ≤ 50 a verb); one `paginate` of the nine weeks' decisions (`capped` 4 MiB real, 2,000); per decision its chain's first row when not in the page (`measured`); per filed decision its filing (`measured`, older rows only) | per decision · ≤ 2,000, budget-stopped | ≤ 3,500 · ≤ 28,000 by the budget | ≤ 12 MiB by the budget | `undoneByOthers.capped`, `timeToDecide.capped` / `medianMs: null`, `tenureCapped` — never a throw. **Reshaped:** chains are read from stored facts (no walk); the season moved to its own query |
| `people.staffSeason` (new) | target; marker; one `paginate` of the season's own range (`capped` 4 MiB real, 2,000); per decision its chain's first row when not in the page; per takedown its verdict, the ending row and that row's chain (`measured`) | per decision · ≤ 600 checked (the query's time bound), budget-stopped | ≤ 2,403 · ≤ 4,402 | ≤ 12 MiB by the budget | `overturned.capped` — never a throw; a season no one can name is this season (`resolveSeason`) |
| `people.reportTrend` | target; one `paginate` (`capped` 8 MiB real, 3,000) | none | 2 · 3,001 | 9 MiB | `capped`, `monthsCapped` |
| `contentRecord.personVerdicts` | as before (charged by `lib/readBudget`, guarded) | — | — | — | a short page is not the end |
| `peopleJobs.parkedLapses` | one `paginate` (`capped` 8 MiB real) | none | 1 · 50 | 8 MiB | `isDone: false` |
| sweep / retry | per step: due head (≤ 2 `one`), nested reset (its own transaction under the budget left) | steps while `STEP_NEED` fits | per pass ≤ 10 calls | ≤ 12 MiB | the pass ends and reschedules from its position |
| `backfillRows` / `repairDrift` / `backfillFlagSubjects` | as before, each step charged | steps while a step fits | — | ≤ 12 MiB | reschedules; not ready after a failure |
| `backfillUndoChains` (new) | one `paginate` (`capped` 4 MiB real, 200); per undo row its parent and first row (`measured`) | per row · ≤ 200, budget-stopped | ≤ 401 · ≤ 600 | ≤ 12 MiB | the page again from its start (placed rows passed over); not ready after a failure |

**Undo chains are stored, not walked.** `lib/audit.ts` — the one writer of audit rows, which already
tags every row an undo writes — now also records each undo row's chain first row and depth and stamps
the chain's newest depth and its writer on the first row (two point reads and a patch in the write
that undoes). A row stands while the undos above it are even in number, so "did this stand?" is a
property of the row and its first row, at any chain length (Greptile's P2: a ninth undo is no longer
past a truncation). `peopleJobs.backfillUndoChains` places chains written before; until it has run
the undo figures name it in their `pending`.

**Owed:** the lapsed-suspension sweep's parked count in `recurringJobs:health` (D258's one place to
look). That read counts small `jobFailures` rows and never loads a profile; the sweep keeps its
attempts on the profile, so joining it means mirroring a parked lapse into `jobFailures` at the
sweep's failure write — not a one-line change, so it waits; `peopleJobs.parkedLapses` lists them
meanwhile. #116's turn-taking finalization sweep leaves the never-touch rule as it was: the sweep's
due range excludes a deletion window, a lock and a tombstone by index, and the reset re-reads the
profile (the tests re-run after the merge).

**Open for a ruling:** an audit row's `reason` and `metadata` are uncapped, so no audit read has a
worst case below the document limit; everything here reads them by count and by real weight. The undo
engine's per-row reads on main (History and Decisions shape each row through `undoState`, and
`moderation.listActions` does the same for the feed) can't be held to a budget until audit rows have
one. Recommendation: cap `reason` at the write (2,000 characters, refused past it, like the other text
caps) and make the engine's per-row reads part of a budget — a change to main's audit writer and undo
engine, so it waits for the founder's word.

**One reading of undo chains** (`lib/undoChains`, Greptile's second review). An undo can be undone, so a
chain is change → undo → undo of the undo → … . Its net effect: pairs cancel from the newest end, so a
change undone once is gone and undone twice is back, with its own time — decided by the chain's links,
never by the rows' times. Every reader that asks "did this stand?" asks it: staff tenure
(`canceledRows` over the role rows), "later undone by someone else" and "overturned this season"
(`standingUndoOf`, which reads the chain forward from a row, each link the engine's own `undoRowOf`; a
restore that ended a verdict and was itself undone no longer counts). History's undo state is main's
engine (an undone row shows *undone*, an undo shows its own state) and the status note names whoever
wrote the row that set the status — both read the newest row, not a chain. A fast-check property
replays arbitrary grants, revokes, moves and undos of any depth through the real writes and holds the
reported dates to a plain replay (`peopleTenure.test.ts`); grant, undo, undo-the-undo is its first
shrunk counterexample under the old reading.

Each reshaped read has a test at the worst a profile weighs, under Convex's real limits
(`peopleHeavy.test.ts`): twenty heavy parked profiles, twenty heavy admins five of them holders, sixty
History rows by thirty heavy moderators and a holder banned and lifted twenty times, a heavy staffer's
decisions and figures, and the per-row cases below.

**B01-4: what each lane depends on, and how a cap shows** (Greptile on #115, P2). A lane's count and
its list read the same upstreams, and any cap among them is named in both: `lanes` returns each
count with `reasons` (and `capped` exactly when there are any), `listPage` returns `partial` and the
same `reasons`. A list also carries every row's open flags and appeals, so a list's `reasons` include
the flag and ticket queues whatever the lane. A backfill not yet finished is not a cap: it is the
lane's and the page's `pending` (round 4, below).

| Lane | Upstream reads and their caps | Reasons | Pending |
| --- | --- | --- | --- |
| Everyone, Staff, Banned, Restricted, Leaving, Deleted | `peopleCounts`; the lane's `peopleRows` range | — | `rows` |
| Suspended, Newest | the lane's range, counted to 200 | `count_capped` (the count only; the list pages on) | `rows` |
| Flagged | open flags · `by_status` per status to 200 (+1); each flag's subject; each person's row | `flags_capped`, `rows_missing` | `rows`, `flagSubjects` |
| Appeals open (admins) | waiting tickets · `by_status` per status to 200 (+1); each person's row | `tickets_capped`, `rows_missing` | `rows` |
| Search | `search_people` | — | `rows` (and `flagSubjects`, as every list's rows carry open flags) |

A queue lane's count is the people its list can show — those with a row (`listablePeople`, ≤ 200 light
reads, read whole by the count and by every page) — so the two never disagree, and someone the queue
names without a row is `rows_missing` in the count and on every page. The Overview's flagged figure
counts through the same function. One test at cap + 1 for each upstream
of each lane (`peopleTruth.test.ts`).

**B01-4: the backfills, and the one procedure that runs them** (Greptile's fourth to sixth reviews of
#115: the roadmap listed two of the three backfills; the documented recovery passed an argument one
backfill refused, and the documented completion check left one out; then a delayed pass of an old run
could finish on a failure count a recovery had zeroed, and mark a backfill ready with a row missing).
Every one-time job a People read rests on is one entry in `PEOPLE_BACKFILLS` (`lib/peopleRuns`), in
run order. The operator starts the first and each run starts the next backfill when it ends, whatever
its outcome; on a database with nothing to backfill each ends at once, ready, so a fresh deployment
takes the same procedure. All three take the same arguments with the same meaning (`BACKFILL_ARGS`):
`run` and `pass` (the run a pass belongs to and its token; left out, the call starts a new run),
`cursor` (where a pass resumes, opaque) and `alone` (a new run that doesn't start the ones after).
The check reads the three backfill rows only, so the sweep's frequent writes don't touch a People
read.

| Job | Started by | Reads that say `pending` until it is ready |
| --- | --- | --- |
| `peopleJobs:backfillRows` | the operator (step 2) | `people.lanes` (every lane, and the top level), `people.listPage` (every lane and search), `console.overview` → `people` (every figure but *N users*) |
| `peopleJobs:backfillFlagSubjects` | `backfillRows`, when a run ends | `people.lanes` (Flagged, and the top level), `people.listPage` (every page: rows carry open flags), `people.person`, `people.history`, `console.overview` → `people` |
| `peopleJobs:backfillUndoChains` | `backfillFlagSubjects`, when a run ends | `people.staffStats`, `people.staffSeason` |
| `peopleJobs:backfillVerdicts` | `backfillUndoChains`, when a run ends | `people.person`, `contentRecord.personVerdicts`, `personReversed`, `personDeleted`, `recordCounts`, `item` (B01-4d) |

The ledger's "never no editor" check also reads whether the rows are ready (through the same
reading), but it isn't a figure: before the rows exist it reads admins' profiles under its own
allowance and only ever refuses (safe).

**A run has an identity** — for every chained People job: the three backfills, the lapsed-suspension
sweep and its daily retry (`lib/peopleRuns`, table `peopleJobRuns`, one row per job).

- **A lease.** Starting a job — by the operator, by another backfill's end, by the recovery, by a cron
  tick — mints the next run number and makes it the job's current run, in the same transaction, so
  every older run is non-current before the new one does anything. Every pass carries its run and a
  pass token, and takes the lease first; a pass whose run isn't current, or whose token was already
  spent (its arguments replayed by hand), returns at once: it writes no progress, no failures, no
  `ready`, and schedules nothing. Each pass moves the token on, so a run is one chain. At most one run of a job can make progress or declare
  completion, so "the old run finishes later" is harmless by construction — the stalled recovery
  included. For the sweep and the retry it also means two cron ticks never walk the same range at
  once, so no lapse takes two attempts in one run.
- **Failures belong to the run.** The row's `failed` is the current run's own count; only the start
  that makes a new run current zeroes it, and the old run can no longer write.
- **`ready` is a conclusion, and correctable.** It is written only when the current run reaches the
  end of its range: true exactly when that run recorded no failures, false otherwise (a run with
  failures takes back an earlier conclusion). A new run given a `cursor` begins part-way and never
  sees what lies before it, so it can keep an earlier clean conclusion but never reach one (the
  documented re-run starts from the start). A later run that finds what the backfill exists to fix —
  a profile whose row is missing or stale, a flag without its subject, an undo without its place —
  clears it in that pass, so reads go back to "not ready" honestly until a run ends clean. That was
  chosen over a check that verifies the fact on every read: verifying "every profile has a row" means
  reading every profile, which no read can afford.
- **What finds a gap after `ready`.** Nothing can open one: every write that creates what a backfill
  fixes does the backfill's work in its own transaction — the one profile insert refreshes the
  person's row, both flag writers stamp the subject, the one audit writer places the chain — and
  `packages/guards` holds the first two to it (`auditWriters.test.ts` already holds the third). A row
  that goes stale is caught by the drift repair (the oldest-refreshed rows, every ten minutes); a run
  of the backfill (the documented re-run) meets any gap left by a bug and says so.

**The check** — `peopleJobs.preparation` (internal: only the deployment's key can call it), `{}` →
`{ ready, pending: PeopleBackfill[], rerun: string[], backfills: [{ backfill, job, run, ready, running,
stalled, cursor, failed, updatedAt }] }`, each backfill as its current run has it. `ready` is every
backfill ready. `rerun` is the jobs to run again: not ready, not running (or running but `stalled` —
nothing recorded for ten minutes, so a pass threw or was delayed), and not about to be started by an
earlier backfill whose chain is still running. The documented re-run starts a new run, which
supersedes any old one.

**Three answers, three fields** — for the web builders:

- **Not ready** — `pending: ('rows' | 'flagSubjects' | 'undoChains' | 'verdicts')[]`, on `people.lanes` (top level
  and each lane), `people.listPage`, `people.person`, `people.history`, `people.staffStats`,
  `people.staffSeason` and the Overview's `people` card. Non-empty means the figures resting on it may
  be *wrong*, not merely short: say "still being prepared", never a number with a "+".
- **Capped** — `capped: true` on a `Count` (and `tenureCapped`, `flagsCapped`, `appealsCapped`), or a
  lane's `reasons` / a page's `partial`: a read stopped at its cap, so the figure is a floor ("200+").
- **Not recorded** — `null` (`contradictions`, `timeToDecide.medianMs` with an unrecorded filing,
  `staffSince` with no role row, `overturned` in a season not yet open): nothing on record to show.

A dependent figure is never folded into `capped` while a backfill is pending.

**Tests.** `peopleRuns.test.ts` is a fast-check property, run for each of the five chained jobs: run
A (delayed) and run B (the recovery, or the next tick, started once A reads as stalled) through
arbitrary interleavings of their passes, with failures and items added mid-run. It holds that a
superseded run's pass changes nothing and schedules nothing, that the job terminates, and that the
conclusion is true: a backfill is `ready` exactly when its last run ended with no failures, and never
while an item is unfixed; a lapse run with no failures left none it began with. Greptile's sequence is
a named case. `peopleBackfills.test.ts` performs the procedure below literally, including a recovery
issued while an old pass is still scheduled.

**After merge, on dev** — word for word the same in the roadmap's Owed list and the PR body. The text
is `AFTER_MERGE_PROCEDURE` in `lib/peopleRuns`, which `peopleBackfills.test.ts` performs literally:
its `convex run` commands are parsed out of the text and run with exactly those names and argument
objects, on an empty database and on seeded ones, a failure and a stalled run included.
`packages/guards`' `peopleBackfills.test.ts` holds this doc and the roadmap to it, and this table to
the registry. Each `convex` command runs as `pnpm --filter @skating/convex exec convex …` from main.

(1) `convex dev --once`. (2) `convex run peopleJobs:backfillRows '{}'` — it runs the four People backfills in turn (rows, flag subjects, undo chains, the content record — which ends by giving withdrawn content its erasure clocks). Estimate: unmeasured. (3) `convex run peopleJobs:preparation '{}'` until it returns `ready: true`. (4) For each job in its `rerun`: `convex run <job> '{"alone":true}'` (a new run, which supersedes any older one), then step 3 again. (5) For each id `backfillRows` logs as an overwritten tombstone: `convex run peopleJobs:restoreTombstoneStatus '{"userId":"<id>"}'`. (6) Only if steps 2–5 ran before the People follow-up (B01-4b) was deployed: `convex run peopleJobs:backfillRows '{"alone":true}'` once, which stamps each staffer's tenure on their row, then step 3 again.

**B01-4: one rule for what is offered** (Greptile on #115, P2). An undo is a write of the previous
state, so its refusal is computed by `lib/peopleCan.writeRefusal` on the write the undo's handler
runs (`personWrite`, which `run` dispatches on too) — every person verb: each posting right, flagging,
the bounty limit, suspend, ban, lift, role grant and revoke, ledger grant and revoke. The forward
writes refuse through the same function, and `people.person`'s `can` asks it (with `needsReason`, the
take-away rule). A fast-check property drives arbitrary sequences of person actions, role and ledger
changes and account states, and holds every offered undo to succeeding and every refused one to not
being offered, and every lever `can` draws to its write (`peopleUndo.test.ts`); the reported case — a
member's flagging off, promoted, flagging given back, its undo — is pinned as an example.

**B01-4: staff since** (Greptile on #115, P2). `grant_role` also records moves between moderator and
admin, so *staff since* is the grant that moved them in from member (`priorRole: 'member'`) after the
latest revoke; when that entry isn't on record the answer is `null`, never a later move's date. A grant
with no `priorRole` — rows from before it was recorded — can't be told from an entry and counts as not
recorded. *Role since* is the newest role row when it gave the role held now, else `null`. Undo
chains read as `lib/undoChains` reads them (below).

Reads whose rows are audit rows (*R*) are bounded by count, not charged: an audit row's reason and
metadata are uncapped, so a page of them is weighed by its real size where a `paginate` can say so
(`maximumBytesRead`) and otherwise by count — realistically under 2 KiB a row. One `paginate` per
query is Convex's rule, so `history` and `staffStats`' season read use `take`.

**What is *not recorded* (`null`) and what is capped.** `null`: contradictions never counted; raw
trust points for a viewer without `people.trustScore`; the status note's actor and time when no audit
row set the status; Time to decide with no decision, or with one whose filing time isn't known;
Overturned while the season's record hasn't opened (1 July to 1 October); Staff since and role since
without a grant row (the first admin); a list row's status time and restriction time when the row
first met that state in the backfill. Capped (a floor): everything in the table's last column.

**Open for a ruling:** the Overview's *N users* still reads the 6-hourly `accounts_total` rollup,
shared with Metrics' total, while the Everyone lane counts live — the same definition (every account
but a tombstone), refreshed differently; and the Overview's *open appeals* counts tickets where the
lane counts people. Both were left as they were (the brief: the Overview's numbers change only where
a ruling changes a rule).

**Owed to the record sheet's PR** (ruling 1): the verdict and withdrawal lists' mock round and any
read solely for them; overturn on the sheet. **Owed to the web builders:** `RestorePost.tsx` names
the person by `@username` in its "why down" line (the rule is real names) and is a Dialog where the
boards draw a sheet. **Deferred:** the decisions' target names (S5), and bounty asks this season on
the Bounties lever.

**B01-4b (2026-11-15): the People server's follow-up** (stacked on #115; the list and person pages'
requests, and the founder's rulings of the same day — D261, and the Overview's figures as the lanes').
Every shape change is additive except where noted.

- **One rule for the Overview and the lanes.** `lib/peopleFigures.laneCounter` counts every lane as its
  list is read, and both `people.lanes` and the Overview's People card count through it: *N users*
  (`totalUsers`) is now the live Everyone lane, *open appeals* (`appealsOpen`) counts people with a row,
  not tickets, read from the account-ticket range (so a page of other tickets can't hide one). The
  6-hourly `accounts_total` rollup is no longer read here; Metrics' *total* and its history still read
  it (`lib/metricReads.accountsTotal`). Shapes unchanged; the values follow the lanes.
- **The list page.** `people.listPage` takes `endCursor` and reads exactly `(cursor, endCursor]`, as
  Convex's own reactive pagination does, returning `splitCursor` / `pageStatus` past 200 rows. The
  queue lanes and the Staff lane are read whole (≤ 200 and ≤ 500 light rows) and keyed by their own
  order (a JSON key: oldest open item and id; rank, name and id), so a person who leaves or joins an
  earlier page moves nothing on a later one; a bare-offset cursor from before is still read. Rows add
  `oldestOpenAt` (Flagged and Appeals: the oldest open flag or waiting ticket — the very key they sort
  by) and `staff` (Staff lane only: `lastSeenInConsoleAt`, `lastSeenCapped`, `roleSince`,
  `roleSinceCapped`, `decisionsThisWeek: Count`). The Staff columns are two reads for the whole page —
  the presence rows within the record's retention, and the week's audit rows under a one-document
  real-weight cap (a function gets one `paginate`, which is why the Staff lane is read whole; a support
  viewer's queues, charged ahead, leave room for no more) — never one a row. A lane read whole is cut
  by its key, sorted by it, so a tie the index breaks by creation time can't be skipped or repeated;
  a page given an `endCursor` returns it as its `continueCursor`. The Staff page's `pending` names
  `undoChains` while a role since can't be told yet.
- **Last seen in the console.** `consolePresence` keeps one row per staffer — the last instant a
  console page heartbeat, replaced in place, erased with the account — and nothing about skaters. The
  lane shows it only within the current season and the one before (`signInRetentionFromMs`, the sign-in
  record's own rule, D254); older is `null`, not recorded, and a read stopped at its cap says
  `lastSeenCapped` rather than `null`. The row itself follows the same rule (the coordinator's ruling,
  2026-11-15): the daily sign-in prune (`analyticsRollup.pruneSignInDays`) removes presence rows last
  seen before the previous season's 1 July, a page per transaction beside the days, each its own delete.
- **A staffer's tenure, defined once** (`lib/staffTenure`): the strip's undo-aware staff since and role
  since, now one function. `people.staffStats` reads it live; every role write stamps it on the
  person's row (`roleSince`, `staffSince`, `tenureCapped`, `tenureAt`), as do the rows backfill (in
  its own nested call, for each staffer) and the undo-chain backfill when it places a role undo; a
  refresh keeps the stamp while the role holds. The Staff lane's `roleSince` is that stamp, so the lane
  and the strip give one date — and one reason for none: `tenureCapped` only for a read that stopped
  short; an undo not yet placed is the readers' `pending`. The undo-chain backfill un-places a role
  undo whose stamp failed, so its re-run stamps the person again.
- **The person page.** `person` adds: `rightsSince` (when each right now off was last turned off, from
  one capped read of the person's `set_posting_permission` rows; `rightsSinceCapped`), `ledger.since`
  (holders only), `publicProfile: { opens, private, path }` (the profile read's own `profileAccess`,
  whose block check is now two point reads on a new `blocks.by_blocker_blocked` index, never either
  person's whole block list),
  `bountySeason` (this season's asks, over-limit and recent-report counts from `bountyGateEvents` via a
  new `by_requester_created` index; `null` when the season began before the gate's 180-day record),
  `open.flags[].targetLabel` (the person's own name, or the body the flagged thing is about by the
  Inbox's rule, `lib/openFlags.flagBodyId` — a Post, comment or photo through its Report — each body's
  name read once; at most 20 distinct, then `open.flagLabelsCapped`), appeals' `body` (admins only,
  as appeals already are), and explicit `can` entries for every give-back: `restore.{reports, hazards,
  comments}`, `flaggingOn`, `bountyRaise` (no reason), `bountyLower` (a reason), `extend` (a new window
  for a running suspension; refused when not suspended). Each is the write's own answer
  (`lib/peopleCan.writeRefusal`).
- **The last-editor sentence is a holder's to read.** A read's `can` (and History's undo state) gives a
  viewer who doesn't hold ledger editing `This isn’t available for this account right now.` where it
  gave `They are the last person who can edit the ledger; give another admin ledger editing first`;
  holders still read the sentence, and the write's own refusal is unchanged.
- **Every person write returns its audit row** (H3): `{ userId, undoable: true, actionId,
  undoNeedsReason }` — or `{ userId, undoable: false }` when the caller can't undo it now — from the
  five discipline writes, the two role writes and the two ledger writes (they returned the id, or
  nothing; no client read it). `undoNeedsReason` is `lib/undo.undoNeedsReason` — the rule `undoState`,
  and so `undo.latestOwn` and `undo.run`, answers by: the undo of a give-back takes something away and
  asks; the undo of a take-away gives back and doesn't. One test holds the three to one answer for every
  person verb, so the toast needs no lookup. The offer is read for the caller **as the write left
  them** (`personWriteResult` re-reads them, in one place): a holder stepping down while another holds
  the ledger loses the grant its undo needs, so it is offered none. Every other person write is
  refused on the caller themselves — the discipline writes and the role writes by their own rules, a
  ledger grant because the caller already holds it — so stepping down is the one write that changes
  its own caller's standing. A property holds "what a write returns is what `undo.latestOwn` and
  `undo.run` give that caller right after" over sampled states, writes, targets (the caller included)
  and one or two holders (pinned seeds plus a fresh one); every write on the caller, with one holder
  and with two, is checked by name.
- **Ids at the edge.** The People queries take the person's id as a string and normalize it once:
  anything that isn't a profile id is `null` — no such person — rather than a validator error.
  `people.decisions` can now return `null` for that case.
- **`staffStats.decisions.undoneByOthers`** adds `by` (up to three undoers, most first, named from their
  rows, with counts) and `byMore`.
- **The audit-reason cap (D261).** 2,000 characters, refused at `lib/audit.writeAudit` — the one insert
  site of the log (the `auditWriters` guard holds that) — so no lever, undo, script or job is missed;
  rows from before are left alone. `readBudget`'s worst case for an audit row is **left at the document
  limit**: whether any row on dev exceeds 2,000 characters can't be known without a dev query, and an
  undo's metadata copies a status reason already on a profile, which no cap reaches back to.
- **The parked-lapse count in `recurringJobs:health`.** The sweep's attempt state stays on the profile
  (its due range must leave a parked lapse out); each change is mirrored into `jobFailures` (job
  `lapses`, keyed by profile id, the queue-shaped jobs' pattern) and cleared wherever the state is
  cleared (a reset, a suspend, ban or lift); the daily retry forgets mirrors whose lapse went another
  way, a few a day. Machinery counts small rows only.
- **Bounds.** The ledger check before the rows backfill reads admins' profiles under the smaller of
  six documents and what the transaction really has left, and a write confirms an editor from their
  profile only while a whole one still fits — either way a shortfall undercounts and refuses (safe).
  `staffStats` makes at most 400 database calls across its per-row loops (Convex gives a query one
  second); past it the figures say capped. An avatar URL past 2,048 UTF-8 bytes is not stored (the
  person shows initials) rather than refusing the Clerk sync, keeping a People row light.
- **The undo engine's per-row worst case** (main's, unchanged): shaping one History or Decisions row
  reads up to 16 undo-tagged audit rows, the newest row on the target, the content's author stamp, the
  person's row and a rowless profile — about 19 documents at the document limit each in theory, since
  an audit row's reason was uncapped and its metadata still is — and, since #127, its verb's refusal
  hook (a launch's: up to 201 documents, see below). Its calls and documents are counted ahead; its
  bytes are not.
- **The page's two assumptions, checked.** Suspending a banned account replaces the ban (the status
  becomes `suspended` and the Clerk lock is lifted) — right. An open-ended suspension, or one that ran
  its course but isn't reset yet, can only be lifted — **wrong**: the suspend write accepts a new
  window on any suspended account (`can.extend` says so). Ruled 2026-11-15: the server stays as it is,
  and the page draws what `can.extend` allows.
- **After merge, on dev:** the People procedure above, step 6 included — if #115's backfills ran
  before this deployed, `peopleJobs:backfillRows '{"alone":true}'` once stamps each staffer's tenure
  (tested literally in `peopleBackfills.test.ts`). The two new indexes (`blocks.by_blocker_blocked`,
  `bountyGateEvents.by_requester_created`) build with the deploy.

**B01-4b, after Greptile's review of #125** (each fixed as its class):
- **Fixed needs before variable reads.** The person page takes its fixed reads (the public profile's
  block checks, the ledger grant time, the status setter's row) before the first read that sizes
  itself by what is left; a test holds every People read to an answer for one person at the cap on
  every axis at once.
- **A bounded page holds the cap.** `listPage` with `endCursor`, on every lane, returns and charges at
  most 200 rows and says `SplitRequired`, with a `splitCursor` where one can be made (the keyed lanes,
  and Convex's own on paginated lanes; a search index gives none, so the client re-reads that range
  unbounded).
- **Walks lap.** The parked-lapse mirror check laps from a saved place (`jobPositions`, job
  `lapseMirrors`), so kept mirrors never hold a stale one behind them; the daily retry mirrors a lapse
  parked before the mirror existed, so Machinery's count is whole within a day of deploy. The other
  walks this PR adds were checked: the presence prune deletes what it reads (no kept rows), the sweep
  and the retry walk their whole range a run.
- **The time axis is owed, in its own PR.** A query has one second, and `people.decisions` still awaits
  its rows one after another: about 480 ms for a page of 50, measured on dev, from roughly three point
  reads a row. So do History, the person page's flag labels, staffStats' and staffSeason's per-row
  checks and a queue lane's rows. The fix builds on the shared reservation B01-3i landed (#128:
  `ReadBudget.measured` reserving a read's worst case and handing back the difference, and
  `undoStates` reading a page's undo states in waves), so one budget has one rule. It comes next as
  `b01-4c-people-rounds`, with a round bound per page and a guard test.
  The concurrency first built here is parked on a local branch to be redone on that rule.
  `staffStats` keeps its time bound in the meantime: at most 400 reads across its per-row loops, counted
  as they are made.
  The per-row plan is charged, not just declared: Decisions and History count each row's calls and
  documents ahead, and a page the budget can't shape whole shapes fewer and says capped. #127's
  refusal hook (a launch reads up to 200 hidden launches) is not in that plan since #131: it reads
  through the share `undoStates` reserves for its row, and a row with no room for one says "check
  elsewhere" (a test runs a page of launch lines at that peak).
- **A "since" is the start of the current unbroken state** (Greptile's 5/5 note on 88c0cdd6:
  "repeated restrictions reset their date"). One rule, `lib/stateSince.startOfCurrentState`: walking
  a run of audit rows newest first, a write that changed nothing (its `prev` equals what it set) is
  passed over, and the answer is the first real change if it led to the current state; if the rows read
  end first, "can't say" (`capped`) when more were unread, "not recorded" when the record ends. It
  serves each right's restriction (`rightsSince`) and the status note's start (`statusNote.at`, with
  `atCapped`, walking up to ten rows of the verb and one document's weight; a suspension whose window
  had run out before the next one, which the sweep hadn't reset yet, counts as over, so the next one
  starts a new run, and the list row's `statusSince` counts it the same way; the note's who, via and
  reason come from the same write as its date — the one that began the status — so no moderator is
  credited with another's date or words; with no start found, the reason on file stands alone). The ledger grant and the tenure dates were already starts: a grant to a holder is refused
  (since the grant was built, #108), and so is a move to the role held — but only since #115; before
  that `grantRole` recorded a regrant, so dev's older role rows can hold a no-op that `staffTenure`'s
  role since would take as the move (prod has none). A fast-check property holds the rule over
  random sequences of real changes and repeats by different staff. Person writes that accept a no-op and still write a row (for the founder's call on whether
  they should): a right set to the value it has (`setPostingPermission`), a bounty limit set to the one
  in force (`setBountyPostLimit`, recorded with the give-back's default reason), a ban of a banned
  account (`banUser`), a lift of an active account (`unbanUser`), and a suspension of a suspended
  account to the same end (`suspendUser`). Role and ledger writes refuse their no-ops.
- **Tagged reasons at the type.** The People writers take only a tagged reason (`writePersonAudit`):
  `typed()` (refused past the cap) or `composed` (shortened to fit), each a branded shape no literal
  can spell. The other writers keep a compatible type (a string is held to the cap as typed). The
  composed-reason guard is the backstop, and now covers the Bodies writes #126 brought.
- **A sweep's run record carries no `ready`.** Only a backfill's does.
- **The newest audit row on a busy target, read for undo state:** it is read whole and its bytes are
  not charged (the undo engine counts its calls and documents only — the same holds for the rows an
  undo tagged and the content's author stamp; #127's refusal reads are the exception, charged their
  real weight through `undoRead`, all but a snapshot and a launch's hidden neighbors, which B01-3f
  owes). For rows written since D261 the
  reason is at most 2,000 characters, but metadata is uncapped and older rows' reasons are too, so the
  worst case is still the document limit per line in a page (read once a line, as on main — reading it
  once per target waits on the rounds PR). A fix belongs with the metadata ruling below (or a
  per-target "latest action" row the undo engine could read instead).

**Owed: audit metadata, writer by writer** (the coordinator's ask, 2026-11-15 — facts for the ruling,
from the code, not from dev; nothing capped in this PR). Every audit row passes through
`lib/audit.writeAudit`; its `metadata` is free-form. By the largest each writer can produce today:

| Writers (verbs) | Metadata | Largest today | Near the document limit? |
| --- | --- | --- | --- |
| Content status (hide, restore, remove, author_delete, overturn; the hazard and alert retractions) | statuses, ids, a subject id; a Post's `cascaded` list | ≤ `POST_MAX_REPORTS` (10) cascade entries — under 2 KB | no |
| Flag and request decisions, drawn-body approve/reject, sub-area create/redraw/restore, curated boost, imagery mode, included-by-request, standing, recurrences' promote, body features | ids, enums, numbers, `filedAt`, a fraction | a few hundred bytes | no |
| `merge_waterbody` | survivor id, per-table **counts**, `changeSet: true` | under 1 KB — **the moved-rows list, the deleted favorites and the sub-area and landmark snapshots already go to the snapshot table** (`writeSnapshot`), not metadata | no |
| `set_weather_sample_points` | counts, `snapshot: true` (the points are in the snapshot table) | under 100 bytes | no |
| `dismiss_duplicate` | `waterBodyIds` | ≤ `DEDUP_GROUP_CAP` (6) ids — under 1 KB | no |
| `set_reference_links` | the links, before and after | ≤ 2 × `MAX_REFERENCE_LINKS` (8) links, labels ≤ 80 characters; URLs uncapped | only through a URL no writer caps |
| `set_parking_area` | coord, the bodies a lot serves, its name, `prev` | the lot's body list (uncapped at the write) and an uncapped name | in theory |
| Status writes (suspend, ban, lift, the lapse sweep's reset) | `prev` with the profile's `statusReason` | a reason from before D261 is uncapped; from now on ≤ 2,000 characters | old rows only, in theory |
| Names (`set_water_body_name`, landmarks' create/edit, `corpusPlaceNames`) | the name, before and after; a landmark edit also its spellings, before (`prev`) and after (`aliases`, #127) | body and place names are uncapped at their writers, and a landmark's spellings in number too | in theory |
| `suppress_recurrence` / `unsuppress_recurrence` | `prev` with the suppression reason | uncapped (as `ROW_MAX.hazardRecurrence` notes) | in theory |
| `set_lake_depth` | the depth source's before and after | ids and numbers | no |

**Proposal:** cap the three free texts that leak into metadata at their own writers (a body or place
name at 200 characters, a lot's body list at the link cap the lot's History already uses, 64; reference
URLs at 2,048), and copy a status or suppression reason into `prev` cut to the D261 cap. The snapshot
table — the merge's own pattern — stays the place for any payload that is a list of rows. With those,
the largest metadata is a few KB, and an audit row's worst case could come down from the document
limit to the reason cap plus about 16 KB.

**Composed reasons are shortened, never refused** (the coordinator's ruling, 2026-11-15, closing the
risk D261 opened). D261's cap is for what a person types. A reason the system builds from fixed words
and stored names or text is written with the `composed` tag (`lib/audit.composed`); `writeAudit` keeps
its fixed words and trims the quoted values — the longest first, each cut marked with an ellipsis —
until it fits 2,000 characters, and the write goes through. A plain string is still refused past the
cap with its plain message; a writer that quotes a person's typed reason inside a composed one checks
it first (`checkedReason`). `packages/guards`' `auditWriters.test.ts` fails on a raw template with a
value passed to an audit writer. The composing writers:

| File | Writers | Fixed words around |
| --- | --- | --- |
| `subAreas.ts` | auto-delist (with an actor), create (drawn and by chord), redraw, redraw by chord, rename / aliases, delist, restore, curated boost, the A02 seed, the A07a campaign | a bay's and its lake's names, the delist reason |
| `landmarks.ts`, `lib/landmarkRows.ts` | add, edit, remove, restore; drawn as a bay; folded into / removed by a merge | a landmark's and its twin's names |
| `corpusPlaceNames.ts` | dismiss (with the moderator's note), reopen, spelled as a landmark's alias | a place name, the dismissal reason and note |
| `waterBodies.ts` | remove from map, merge (operator default and the catalog campaign's absorption), satellite mode, sample points, name override cleared, community name, display name, curated boost, reference links, depth override released, aliases, class, the depth source chosen or handed back | a body's names, a campaign id, counts, modes, a class and a source |
| `putIns.ts` | set official put-in, made official in place | the put-in's name |
| `imageryOverrides.ts` | a pass cleared, shown, hidden (the person's reason kept whole, checked first) | the pass id |
| `corpusRequests.ts` | admit from the catalog | a catalog id |
| `lib/requestDecisions.ts` | a request's default decision line | the decision and the request kind |
| `postedAccess.ts` | the posted-access change, with the person's reason quoted | the change, and the typed reason (checked first) |

No recurring job composes a reason from stored text today: the lapse sweep, the standing rollover,
the hazard auto-merge and the erasure write fixed reasons; the auto-delist and the catalog absorption
that do compose run from the ETL and operator writes. A composed reason can't fail its write, so none
could be parked by it.

**B01-4d (2026-11-15): the People record sheet's server** (boards 8.7–8.9; stacked on #125). Server
only; the sheet itself is the web's next pass. Every shape change is additive except where noted.

- **One rule for the four levers** (`lib/recordRules`): Restore (`setModerationStatus`, `visible`),
  Hide again (`hidden`), Overturn (`overturnVerdict`) and Keep on the record (`keepOnRecord`, new).
  Each write refuses through `recordRefusal` over the item as it read it, and every read's `can` is
  `recordLevers` — the capability (`content.moderate`, `access.alert` for an alert) and the viewer's
  own deletion window first, then the same function — so a lever is never drawn that its write turns
  down. An item offers one lever at most: a decision standing on content still its author's →
  Restore; on content they deleted since → Overturn; content they deleted that nothing holds → Keep;
  content that is up → Hide again; erased → none. A Post whose author didn't delete it answers
  Restore with *Open it to see what can be done with it* on a list (its members decide between
  Restore and Overturn, and a page can't read ten Reports a row); the item pane reads them and answers
  exactly, `needsChoice` when its Reports each went down on their own. A pure fast-check property holds
  the rule over every state and viewer; a model property (below) holds the writes to it.
- **The rules this build set — D267** (the coordinator's rulings, 2026-11-15): Restore and Overturn take a
  reason only if one is given — otherwise a default the row marks `reasonDefaulted`, which the sheet
  shows as no reason (D226's give-back); Keep on the record is a removal on the record (an alert's,
  a retraction) marked `keptOnRecord`, a takeaway with a required reason, refused on an item a decision
  already holds (no second row for nothing); Reversed shows each item once, as its newest decision.
- **Each item once, by a stored flag.** `contentVerdicts.superseded` is `false` on an item's newest
  verdict and `true` once a later one is minted — a hide that became a removal is the removal, never
  also a Reversed hide; restored, hidden again and restored again, the item shows its last restore.
  Every writer keeps it (`lib/contentVerdicts`, and the replay, which `contentVerdicts.test.ts` now
  compares flag for flag against the live writers); `packages/guards`' `verdictWriters.test.ts` holds
  every verdict insert and ending to it. `isReversed` is the one predicate, and a test holds the
  index range the reads take to it both ways. (A flip constant was built and removed untested: showing
  superseded decisions too — the founder's open question — changes the predicate and the range
  together, and the range over every ended verdict would want a kind index of its own.)
- **The reads** — `contentRecord.personVerdicts` (Standing, widened: `decidedBy`, `can`,
  `reportAuthor`, `postReportCount`, `pending`), `personReversed`, `personDeleted` (all five kinds,
  merged), `recordCounts` and `item`. Cursors are positions in the list's order (JSON), not Convex
  page cursors: a page reads its rows by index with `take` (two parts after a cursor inside a tie) and
  can end anywhere the budget does. People are named from their People rows (`RecordPerson`, the shape
  of `people.PersonRef`). A short page is not the end; `isDone` is.
- **Counts are a sibling read**, not `people.person.record`: Reversed to 500 (4 MiB of verdict rows
  at their declared worst) and Deleted beside it don't fit in the person page's budget without
  shrinking its other figures. Standing stays `person.hidden`. `person.pending` now names `verdicts`.
- **A restore of what is already up writes nothing** (refused, *This is already up.*): a restore needs
  no reason now, so a second press would otherwise write a second row. Before this build a restore of
  a visible item wrote a row (its reason a re-assertion); a hide of a hidden item still does.
- **The item pane names every decision's end**: `endedHow` is `restore`, `undo`, `overturn` — or, in
  the pane, which shows superseded decisions too, `superseded` (a later hide, removal or retraction).
- **Known and left:** an erased comment that had replies stays a shell with its `authorDeletedAt`, so
  it stays in the `by_author_deleted` range the Deleted list and count read: the list passes over it
  (a page can come back empty with `isDone: false`, and the next moves on), and a person with 30 or
  more such shells has a Deleted count that is always a floor. Clearing the field at erasure, or the
  stored withdrawal row below, would fix it.
- **The content record is a People backfill** (`peopleJobs:backfillVerdicts`, fourth in
  `PEOPLE_BACKFILLS`): its run's lease rides the walk (`contentRecord.backfillVerdicts`), every item's
  replay and the clocks (`erasure.backfillClocks`), each pass taking the lease and moving the token
  (`chainedLease`, `handOn`); the clocks' last pass hands it back to conclude. A pass that rewrote a
  verdict or set a clock found a gap. A run by hand without a lease still works and concludes nothing.
  The two-runs property (`peopleRuns.test.ts`) covers it; the procedure's step 2 now runs four.

**B01-4d: every read, weighed.** Each page reserves its rows' worst cases in waves (`ReadBudget.waves`)
over the request's budget (11 MiB after the caller's profile) and hands back what didn't come; a row
whose reads the budget can't reserve ends the page there. Rounds measured on fifty rows of the dearest
kind (`recordRounds.test.ts`, which states each worst case from the budget):

| Read | Rows · documents per row (declared worst) | Rows a wave | Worst rounds, a page of 50 |
| --- | --- | --- | --- |
| `personVerdicts` | 51 verdicts; decision R + item (≤ 1 MiB); comment/Post → its Report; library row and People rows once a page | 5 (a Report) | 13 |
| `personReversed` | 51 verdicts; decision R + ending R + item; a gone item → its erasure row; then the undo engine's first step (main's: calls and documents counted, bytes not) | 3 | 23 |
| `personDeleted` | report 2, post 1, comment 50, hazard 1, alert 50 a merged page (narrowed to one kind: 4, 2, 50, 4, 50); each row's hold check and Report | 10 | 8 |
| `recordCounts` | Reversed 501; Reports by real weight (512 KiB, one `paginate`); comments 30, alerts 30; Posts and hazards by real weight in doubling steps (1, 2, 4, … rows, each step its share of what is left, at most 7); each row's hold check | — | 13 |
| `item` | the item, ≤ 51 decisions (each R, ending R), its Report, a Post's ≤ 10 members (Report + newest row) | — | a fixed few |

**What the budget can't count.** Convex has no index-only count. Reports count by their real weight
(the read's one `paginate`, 512 KiB); Posts and hazards — a whole document each at their declared
worst, a few KB in fact — count in doubling steps (`countHeavy`: 1 row, then 2, 4, … after the last,
each step reserving its rows' worst case and handing back what they weighed, never more than its share
of what is left), so they count exactly well past one worst case; comments and alerts to 30 each. So
`deleted` is exact while a person has deleted (and nothing holds) fewer than 100 Reports within 512 KiB,
29 comments and 29 alerts not yet erased, and as many Posts and hazards as seven steps reach — at
least 15 of each at the worst the budget allows, typically about 40; past any of those it says `capped`
(a floor). The Deleted list pages on regardless, a heavy kind a few rows a page. **Owed:** a small stored
row per withdrawal (ids and times, written by the clock's one writer, removed by the eraser) would make
the list one range and the count exact to 500 at 4 MiB — not built here (a new stored fact, its writers
and a backfill).

**Open for the founder:** nothing refuses a moderator acting on their own record (restoring their
own hidden report, overturning a decision on their own content) — not before this build, and not now;
the levers only follow the writes. A self rule would belong in `lib/recordRules`, beside a matching
refusal in `setModerationStatus`.

**After merge, on dev:** the People procedure above. Where its backfills already ran before this
deployed, the check names `peopleJobs:backfillVerdicts` in `rerun` (step 4 runs it alone); until it
concludes, the record's reads say `pending: ['verdicts']`. The new indexes (`contentVerdicts`
`by_subject_reversed`, `by_subject_reversed_type`, `by_target_superseded`; `accessAlerts`
`by_author_retracted`) build with the deploy.

### The B01-2 server register (owed to the server agent)

Every seam request the B01-2 builders raised against `packages/convex` and `packages/core`, and
the two undo fixes the executor's final review of #108 found (U1, U2). Nothing here blocks a merge: each block draws *Not recorded yet* until its read lands, then swaps its
`null` for the read.

| # | Ask | For | Status |
|---|---|---|---|
| S1 | `machinery.overviewJobs` — the jobs that need a look first (stalled, failed, late, retried, then a few ok), how many more and whether they're all ok | Home › Machinery card, the heads row's *needs a hand*, the status bar | 🟢 B01-3 |
| S2 | `ledger.overviewCost` — this season's total and its invoiced/metered split, each service's amount and free-tier meter, the last three full months and this one by hosting/AI/compute | Home › cost strip, *Cost · this season*, *By month* | ⚪ no ledger rows yet |
| S3 | `seasonWatch.homeSummary`, moderator-readable — the watch (waiting/open/closed, sentinels), winter region-wide, imagery state, the first skate | Home › the season's four tiles | 🟢 B01-3 |
| S4 | `console.overview` additions — `inbox.medianAgeMs`; `people.totalUsers`; the Corpus counts no read has (chord re-fits across bodies, place names, the pre-ice pass's date, awaiting enrichment, the last campaign); dedup groups counted as decisions, not rows | Home › Inbox foot, People's *N users*, Corpus rows | 🟢 B01-3 (pre-ice pass, enrichment: no record) |
| S5 | The audit feed: a `targetLabel` on each `listActions` row (the body's or person's name), and machine-run events (cron and run outcomes) in the same feed as `system` | Home › audit feed | 🟡 B01-3: machine rows; target names wait on #112's stored body row |
| S6 | One definition of *open flags* that includes `reviewing`, used by every count (§7, the governor's ruling 1) | Home, Metrics | 🟢 B01-3 (D251) |
| M1 | Keeping up, now — open flags (all, safety), the oldest open flag (when, which body), open tickets and the oldest | Metrics › Keeping up's stats | 🟢 B01-3 |
| M2 | Keeping up, the season — `flag_time_to_resolution_h` for the last 7 days and the season, the flag queue per day (`flag_oldest_open_age_h`, `flag_queue_depth`), support's resolution histogram and `support_queue_depth` per day | Metrics › the oldest-flag chart, both histograms, open support tickets | 🟢 B01-3 |
| M3 | Showing up, the week — reports and their people, accounts added and total, signed in and on two days or more (`signInDays`), contributors and first-timers | Metrics › Showing up's stats | 🟢 B01-3 |
| M4 | The daily strips — reports, comments, kudos, photos, hazards, new accounts, signed in, contributors per season day (1 October on), each with its total and spread; comments and photos as **backfillable** rollups | Metrics › *Each day* | 🟢 B01-3 |
| M5 | The vantage rollup — the season's reports by `observedFrom`, and those stating none | Metrics › *Reports by vantage* | 🟢 B01-3 |
| M6 | Most-reported — via the §10 tier-2 per-body rollup: reports, photos, distinct people, last report | Metrics › *Most-reported* (rows open the Body console, §7 ruling 3) | 🟢 B01-3 |
| M7 | Coverage by state — listed bodies once each, and per state: bodies, reports, comments, photos, kudos, contributors | Metrics › *Coverage by state* | 🟢 B01-3 |
| M8 | A moderator-level metrics capability — the tab reads today's admin-only rollups; a moderator sees Metrics without support (PII, D37) | Metrics for moderators | 🟢 B01-3 |
| M10 | A season chooser in the Overview's own content (not the rail or any sidebar navigation), and every season-ranged read taking the season as an argument (M2, M4–M7, S3; S2's season total). The founder's call (§7): a past season is shown only when chosen. The client is ready: `OverviewView` takes `season`, `seasonRecordWindow(season, now)` (`@skating/core`) draws a past season whole, and Metrics and the season tiles draw whatever window and facts they're handed | The Overview, both tabs | 🟡 B01-3: reads take the season, ?season= routes it; no chooser yet |
| M9 | A by-time index on `reportRatings` for kudos (the founder, 2026-11-13: kudos are positive reactions; *helpful* counts; a thumbs-down never subtracts) | M4's kudos strip, M7's kudos column | 🟢 B01-3 (D250) |
| H1 | A moderator-readable season-tape summary — the watch's opening and the day count, so the tape can wear its *Day N* badge and its marks | The shell's season tape | 🟢 B01-3 |
| H2 | A colleague-presence read — who else is in the console now | The top bar's faces | 🟢 B01-3 |
| H3 | An optional audit-row id returned by every operator mutation | Undo's toast and History linking a write to its row | ⚪ waits on a console write that calls the toast (B01-1c: none does yet) |
| H4 | Suspend and ban refuse the last ledger holder — D227's *never no holder* holds through discipline as well as demotion (the governor's ruling, D252) | People, D227 | 🟢 B01-1c (the rule in B01-3) |
| U1 | A Post's restore records the auto-hidden state in its `prev` snapshot, and its undo puts it back — today undoing a moderator's restore of an auto-hidden Post (all its Reports hidden) loses that record, and restoring one of its Reports afterwards no longer brings the Post back. The true-inverse rule of the landmark-restore fix (founder-ratified 2026-11-13): a restore records what it clears | Undo (D226), Post moderation | 🟢 B01-1c |
| U2 | History's *undone by* link on a Post can point at a Report's row instead of the Post's own undo row (`lib/undo.ts`). Nothing reads the link yet; a pre-wiring fix before the History panel does | Undo's History panel | 🟢 B01-1c |

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

- **The skater app's `InsetCard`** (`components/skater/panels/`, with `useCardMechanics`) and the
  kit's console `InsetCard` (B01-3) are two pieces for one idea; merging them is owed (the
  governor's ruling at the Bodies integration, §7).

**Known bug, skater territory (owed, not B01-2):** client-side navigation from a skater page to an
old admin page leaves `data-surface="skater"` on `<html>` — the old page wants it absent, and no
shell on that path takes it off.

### The Bodies library on the server (B01-3, the design)

The library lists about 25,000 bodies; a lane, a state tab, seven facets and eight sortable columns
cannot be answered from `waterBodies` (a polygon per row, no index on most of what the list shows).
So the list reads a **stored row per body**, written where the facts change.

**The row** (`bodyLibraryRows`): exactly what the list shows, sorts by and filters on — name, the
aliases and a `searchText` of name, aliases and every id (ours, `waterBodyKey`, OSM, NHD, 3DHP,
GNIS); class; states; area and its size option; standing and its lane; completeness as core's
`bodyCompleteness` stores it (`have`, `of`, `missing`, and its facet option); open asks and whether
one waits on a skater; reports this season (with the season they count) and whether the body was
ever reported; the outline's origin, put-ins, curation, an intake reason and awaiting enrichment;
and when a moderator last changed the body or its bays, landmarks or put-ins.

- **One row per body per scope**: `*` and each state it touches, so a state tab is an index prefix
  and a border body (Champlain) is listed under both states. Merged bodies have no row.
- **Indexes**: each sort column twice — `[scope, key, nameKey]` for *All bodies* and
  `[scope, lane, key, nameKey]` for a standing lane. Every sort key is a required number or string;
  an unknown area or change date is stored as two keys (`-1` for the descending order, the largest
  number for the ascending one), so an unknown sorts last both ways and no index ranges over an
  optional field. *Changed this week* is a lower-bounded range on the change key.
- **Search** is a search index over `searchText`, filtered by scope and lane: a body is found by any
  name or id; while searching the order is the match.
- **Facets** narrow inside the index read (`filter` before `paginate`, with `maximumRowsRead`), never
  after a page: a page is the true next run of matches in the index's order, and a narrow facet costs
  more pages, never a wrong one. Seven facets times eight columns cannot each be an index; this is
  the one place the list's filter is evaluated in the query rather than ranged by an index.
- **Counts** (`bodyLibraryCounts`) — lane totals, the corpus, the state tabs and every facet option,
  per lane and scope — move with the rows: the one writer of a row applies the difference between
  its old and new options in the same transaction, so a count is the tally of the rows by
  construction. A facet's counts are exact while no other facet is applied (the menu's rule: what
  an option would leave with the others as they are); otherwise the read says it has none.

**Kept current at the writes.** One writer (`lib/bodyLibrary.ts`) recomputes a body's rows from the
records and applies the count differences:

- **Every audited action** (`writeAudit`): a row whose target is a body, a bay, a landmark, a put-in,
  a lot (each body it serves), a corpus request or a place name refreshes that body in the same
  transaction; a moderator's action on the body, its bays, landmarks or put-ins stamps *Changed*,
  and so does a merge, on its survivor. One rule decides a body's *Changed* on every path — the
  latest of the write's, the rows' and the queue entry's (`changedDateOf`).
  Writers that audit before they write call the refresh again after. A transaction runs at
  most four of these refreshes; a bulk writer's further rows (a request's siblings, a rollover or
  prune page, a seed's bays) stamp *Changed* and queue the body instead, so each page keeps the
  read budget it was sized against. **A transaction's fifth refresh and on lands through the queue,
  within a minute** (the governor's ruling, 2026-11-14).
- **Every report write and report moderation** (`recomputeBodySummary`, which each of them already
  calls): reports this season, ever reported, and the put-ins reports derive.
- **The machine's bulk writes with no audit row** (the canonical import, depth, elevation, wind,
  contour coverage, the access join, the landmark and place-name loads, the prunes and duplicate
  resolution) queue the bodies they touched (`bodyLibraryQueue`); a cron drains the queue each
  minute, bounded, and a hard-deleted body's rows go with its queue entry.
- **The season turning** (1 July) re-counts the rows still counting the last season's reports, ten
  bodies an hour. The rows and the *reported this season* filter read honestly at once — a row
  counted for an earlier season reads as zero reports this season — while the stored counts behind
  the facet's number and the reports sort lag until the turn finishes: a body an hour per ten
  reported last season, about 30 hours for 300. It happens on 1 July, when nobody is skating
  (accepted by the governor, 2026-11-14). A parked body, which can't be re-counted, has its rows
  closed on the new season (zero in its empty record, the counts moved with them), so the turn
  always finishes. While the turn runs, `listSummary` gives no counts for the reports facet (and no
  total with it applied), since rows still counted for last season are filed under *reported this
  season* in the counts while every row and the page's filter read them as zero.
- **A body whose refresh throws never blocks the rest.** Every refresh outside the writer runs in
  a nested transaction of its own (`refreshBodyLibrary`), so a failure rolls back only that body's
  work — never the moderator's write, the report, or the rest of a drain, repair or backfill page.
  The failure goes on the body's queue entry with an attempt count — one per transaction, however
  often a writer refreshes it — and its error's class (never its message), at the back; after three
  attempts the entry is **parked**: skipped by the drain, the drift repair and the season turning,
  counted in `bodyLibrary:state`, and listed by `bodyLibrary.parked` (Machinery,
  `machinery.read`). A parked body is tried again by its next audited write — success clears the
  entry, and one past the inline cap releases it to the queue — or released by
  `bodyLibrary:retryParked`. Each nested refresh runs under its own read limits (6 MiB, 4,000
  documents, 1,000 queries — far past any real body), so one that reads too much fails as itself;
  and a drain, repair, turn or backfill page stops when it can no longer fund another full refresh,
  leaving the rest queued, so a healthy body is never starved into failing. A *Changed* stamp a
  failed or deferred refresh owes rides on the queue entry until the drain lands it.
- **A drift repair** walks the oldest-refreshed rows a few at a time — only rows a day old or more,
  since a refresh marks an unchanged row read at most daily and a younger one would be re-read every
  tick. Nothing a moderator does depends on it; it catches what is deferred below.
- **The contour coverage** knows a body only by its catalog id, and resolving one reads its polygon:
  the bodies whose coverage moved are queued by a job of their own (`bodyLibrary.queueByExternalId`)
  that reads as many as a transaction affords and schedules the rest, since a replacement's first
  batch clears the whole set.
- **Deferred, in files the author-deletion PR rewrites:** a skater's new corpus request
  (`corpusRequests.ts`) and a new flag on a body (`contentFlags.ts`) change its asks without an
  audit row; each needs one line (`queueLibraryRefresh`) at its insert. Until then the drift repair
  picks them up.
  The hazard writes (`hazards.ts`, `hazardConfirmations.ts`, `lib/hazardMerge.ts`, and the hazard
  hide in `moderation.ts`) call `recomputeBodySummary`, which refreshes the library; no library fact
  counts hazards, so each could pass `library = false` — one argument per call site, deferred with
  them. Until then a hazard write pays a refresh that writes nothing.

**A figure a read stopped short on says so.** A row's reports this season come from its newest 300
reports and its asks from up to 100 of each kind; when either read stopped inside what it counts,
the row says `reportsCapped` or `asksCapped` and the number is a floor, never presented as whole.

**Reads** (`bodies.ts`, gated on `body.read`): `listPage` (lane, state, search, facets, sort, paged
— a starting page up to the library's most, so a return reloads as many rows as were showing; a
page that came back short because its scan budget ran out says so, `scanBudgetSpent`, and is not
done — the list keeps loading and draws no end, the governor's condition on facets in the read);
`listSummary` (lane counts, the corpus, the state tabs, the list's total and facet counts, and what
the read can honor); `preview` (reports this season by vantage and all time, the open asks, the
towns). **Backfill**: `bodyLibrary.backfill`, paged by body and resumable, then
`bodyLibrary.backfillChangedAt` over the audit log.

**What the Bodies server built (B01-3), against the register.** Where a page's prop type and the
register's shape differ, the prop type won; where the page draws words, the read returns facts.

| # | Built | Notes |
|---|---|---|
| BS1 | `bodies.listPage` | The stored row above; facets in the paged read, capped at 2,000 rows scanned a page |
| BS2 | `bodies.listSummary.laneCounts` | Exact from the counts; *Changed this week* counted from its range to 500 |
| BS3 | `bodies.listSummary.facetCounts` | Exact while at most one facet is applied (`servedCounts`); none while searching |
| BS4 | `bodies.preview` | Reports this season by vantage and all time (capped at 1,000), the open asks as facts, the towns (sampled) |
| BS5 | Stored as `have`, `of`, `missing` and the facet option | Core's `bodyCompleteness`, with every count served — nothing unknown on the server |
| BS6 | `LIBRARY_PAGE_SIZE` 50, `LIBRARY_MAX_START` 400 | The read clamps a first page; the page keeps how many rows were showing in its return address |
| BS7 | `bodyConsole.consoleExtras` | Towns sampled; the outline trusted since a person's approval, else its campaign's run; touching bodies among the 12 most prominent nearby, within 30 m, `null` above 20,000 vertices |
| BS8 | `subAreas.listForBody.createdAt`, `bodyConsole.bayProvenance`, `bodyConsole.history` | How a bay was made comes from its creating audit row (new rows say `via`); History covers the body's whole family, the targets `bodiesOfTarget` files under it — its bays, put-ins and landmarks whatever their state, the lots that serve it, its known features, and the requests, corpus place names and flags on it — and the same family of every body merged into it, through the merge chain (up to 50 bodies, each family taken in only while the read can afford it) — by relation, never by which fields a row carries; `capped: false` means every row; by verb as an index range |
| BS9 | Deferred | `setAliases` and `setClass` need audit verbs, whose undo rows live in `lib/undoPolicy.ts` (the author-deletion PR rewrites it); an alias also needs a call on how it is stored beside the user claim that already means *a moderator picked the display name*. Per-catalog name and class claims are not stored — the import keeps one source per spelling and only a class confidence — so they are `null` until the ETL keeps them |
| BS10 | `bodyConsole.places`, `landmarkProvenance`, `landmarkProposers` | Places sampled; the proposer read is gated on `inbox.read` |
| BS11 | Bathymetry in `consoleExtras.hasBathymetry` | Depth candidates are not stored (the depth loader keeps each measurement's winner), so `null`; choosing a source and filing a survey need verbs (as BS9) and a call on what a survey filing records |
| BS12 | Index `moderationActions.by_target_action`; `bodyConsole.history` takes `action` | `moderation.listActions` still filters after its page — one line, deferred to after the author-deletion PR |
| BS13 | Deferred | A pass override needs a table and an audit verb (as BS9) |
| BS14 | `standing.retentionForBody` | The newest use and its kind, the boost and when it was set, favorites (to 1,000), saved put-ins |
| BS15 | `bodyConsole.dailyHazards` | Each day's `count` is the hazards established on the lake (from the first report; an active one through today) and its `unknown` the archived ones that may have been — an archived hazard's end isn't stored and its votes can't establish it (edited in place, still taken after the archive), so its later days are unknown, never clear, and a vote cast today changes no past day. An honest end needs the hazard writers to stamp when a hazard left the lake: deferred until #110 merges |
| BS16 | Deferred | Editing a feature's shape needs an audit verb (as BS9) |

**Every capped read's order (Greptile on #112, "cap, then sort").** A capped read takes its rows in
the order it presents them, or says it is capped. Read order is the index's; "drop" asks whether a
cap can cut an item the returned order says belongs.

| Read | Index order read | Order returned | Can a cap drop a row that belongs? |
|---|---|---|---|
| `bodies.listPage` | The sort column's index (ties by name), or the search's match | The same | No: a page ends at a cursor; `scanBudgetSpent` says when the scan, not the list, ended it |
| `bodies.listSummary`: state tabs | `bodyLibraryCounts` by lane, key, scope (64) | Most bodies first | No: at most one scope per state plus `*`, inside the bound |
| `bodies.listSummary`: facet counts, total | One range of a lane and scope's keys | — | No: every key fits; *Changed* is counted to 500 with `capped` |
| `bodies.preview`: asks | **Fixed:** each request kind, each flag status and reason, and the place names newest first (20 each) | Newest first, 20 | No, after the fix: each source keeps its newest, so their merge holds the newest overall. `askCount` (all open asks, by the row's rule) and `asksListCapped` say when the list is "20 of N" |
| `bodies.preview`: reports | A body's reports by skate end, newest first (1,000) | Counts | No: `season.capped` and `allTime.capped` say when the read stopped |
| `bodyConsole.history` | Each target's rows newest first (one past the page) | Newest first, merged | No: each target keeps its newest; past any bound, `capped` |
| `bodyConsole.bayProvenance` | **Fixed:** the same bays `subAreas.listForBody` lists | A lookup by bay | No, after the fix: every bay the tab shows has its provenance (it read only the first 100 before) |
| `bodyConsole.landmarkProvenance` | The same landmarks the editor lists (`landmarksForBody`) | A lookup by landmark | No: the same set as the list it annotates |
| `bodyConsole.landmarkProposers` | **Fixed:** the same range, order and cap as `openLandmarkRequestsForBody` (oldest first, 200) | A lookup by request | No, after the fix: every proposal the tab shows has its proposer (it read 100 before) |
| `bodyConsole.places`, `consoleExtras` towns | Sampled points | — | Sampled, said in the read's description; touching bodies among the 12 most prominent, with `capped` |
| `bodyConsole.dailyHazards` | A winter's hazards by first report, oldest first (500) | Per day | Yes, past 500 in one winter on one body: `capped` says so |
| `standing.retentionForBody`: favorites | A body's favorites (1,000) | A count | No: `favoritesCapped` |
| `standing.retentionForBody`: saved put-ins | A body's stored put-ins (1,000, probing one past) | A count | **Fixed:** `savedPutInsCapped` now says when the body has more rows than the read took, so the count is of the rows read (an unread hidden coordinate could suppress one counted, so not a floor) |
| Library row: asks, reports | Each ask source (100 each); reports newest first (300) | Counts | No: `asksCapped`, `reportsCapped` |
| `bodyLibrary.parked` | Parked entries, oldest parked first (50) | The same | No: `capped` |
| `recurrence.listForBodyAdmin` | **Fixed (B01-3d):** a body's patterns, highest priority first (`by_water_body_priority`, 1,000) | Highest priority first | No, after the fix: the cap keeps the top 1,000 (it read the first 1,000 stored, then sorted). The array says nothing past 1,000; `waitingCountForBody` is the figure that does |
| `recurrence.waitingCountForBody` | A body's patterns (1,000, probing one past) | A count | No: `capped` (B01-3d) |
| `recurrence.listForBody` (skaters) | **Fixed (B01-3d):** a body's public patterns, highest priority first (`by_water_body_public_priority`, 1,000), then those a live sighting stands down | Highest priority first | No, after the fix. **Owed:** its read of the body's active hazards is an unbounded `.collect()` |
| `recurrence.listQueue` | The cross-lake queue by season and priority, paged | Highest priority first | No: genuinely paginated, filters per page |
| `recurrence.recomputeBody` | A body's stored patterns to match against (1,000) | Not presented | Matching only; unreachable in practice (a body holds tens) — a body past it would re-insert its unmatched patterns |
| `bodyFeatures` demote, `hazardWithdrawal` | A body's patterns to find a promotion's or a pin's (1,000) | Not presented | The withdrawal says `unknown` past the bound; the demote's walk-back is bounded the same way |
| `recurrence` discovery | Stale queue rows (200 a page), and a paged body walk | Not presented | No: each re-runs until a page comes back short |

**The governor's rulings on the deferred items (2026-11-14).** A moderator's aliases are their own
bounded field on the body, `moderatorAliases` — at most 20, each at most 120 characters, trimmed,
de-duplicated case-insensitively against the display name and each other — never name claims: a
`user` claim keeps meaning *a moderator picked the display name*. The library row's aliases and
search text fold them in. **Built after the author-deletion PR (#110) merges**, with the four
deferred writes (BS9's `setAliases` and `setClass`, BS11's choosing a depth source and filing a
survey, BS13, BS16), since their verbs and undo rows land in files it rewrites — and with the
one-line call sites waiting on the same files: `queueLibraryRefresh` at a skater's new corpus
request (`corpusRequests.ts`) and new flag on a body (`contentFlags.ts`), `library = false` at the
hazard callers of `recomputeBodySummary`, and `moderation.listActions` filtering by verb through
`by_target_action`.

### The Bodies list (B01-3, the page)

The library at `/admin/bodies` (boards 5.1–5.3), on the server's reads above; the rail's Bodies
mode (G then B) lights for it. The first of four Bodies page PRs — the Body console's frame and
Shape, its Names/Places/Access/Water tabs, and its Imagery/Hazards/Standing/Links tabs follow.

- **What it reads.** `bodies.listPage` through Convex's paginated hook: lane, state tab, facets,
  search and order are the server's, and the page sorts and filters nothing itself. It starts at
  `LIBRARY_PAGE_SIZE`, or as many rows as it was showing when left (to `LIBRARY_MAX_START`); a page
  its scan budget cut short keeps the list loading, and the end is drawn only once the read is done.
  `bodies.listSummary` counts the lanes, the corpus, the state tabs, the total and the facets; the
  total and the menu's counts are only ever this query's — no number while loading, failed,
  retrying, searching, with two facets, or for the reports facet while the season turns — and
  *Changed this week* reads "500+" at its cap. Both read against the list's clock (the minute it was
  opened), so a new minute never restarts the paging. The preview words `bodies.preview`'s facts:
  reports this season by vantage (empty before 1 October, saying when the record begins) and all
  time, floors marked "+", every open ask counted (`askCount`) with "Newest 20 of N" when its list
  is partial, the town and the others, and completeness as stored (core's ten); its history is
  `bodyConsole.history`. A rejected body, which `waterBodies.get` doesn't serve, is drawn from its
  row with a line that the full preview isn't available.
- **Where a body opens.** In the list's own PR, before the Body console exists, the preview's action
  (and ⏎) opens the body in the old editor, *Open in the editor →* — never a link to a page that
  isn't there. The console's frame points it at the console (*Open in Body*, below).
- **Every read's states.** Skeletons while on their way; a failure said in its own place with *Try
  again* (the kit `RetryNote`: a live region mounted before its words, so it is announced;
  *Trying again…* until the fresh answer; focus kept in the note when it empties). The counts and the
  preview go through the console's one read layer (`components/admin/reads/consoleReads.ts`: one
  registry of paused reads, pending, Sentry once per failure by the read). The paginated list runs
  in a small reader under the kit `ReadBoundary` that hands its pages up, so the page and its
  failure note are drawn once, outside the boundary. `null` is *Not recorded yet*, never a zero.
- **Kit pieces with it:** `LedStrip`'s segments, `FilterChip` and its row and count, `FacetMenu`,
  `SearchMark`, `TableGroupRow`, `RetryNote`, `ReadBoundary`, and `Section`'s capped count ("400+")
  and amber chip.
- **Deliberately absent:** board 5.3's matches in other standings and its tally (no read answers
  across standings yet); a rejected body's full preview; *Opened recently*'s rows (its lane, this
  browser's own list, comes with the Body console, which writes it).
- **Where the mock and the code differ** (founder calls; the code stands until ruled): the state
  tabs carry no counts; completeness is out of ten, not twelve; the ask kicker is *Bay name · Inbox*,
  not the raw `name_bay`.
- **Wording the mock did not supply** (all asks' words in `components/admin/bodies/askWords.ts`,
  approved as written by the founder on 2026-11-14): request kinds *Activation*, *Admission*, *Restoration*, *Access contested*, *Takedown*,
  *Landmark name*; what a nameless request asks for — *Make it active*, *Add it to the map*,
  *Bring it back*, *Reopen its access*, *Take it down*, *Name a bay*, *Name a landmark*; a flag's
  reason — *Dangerously false ice report*, *Spam*, *Harassment*, *Inappropriate*, *Rated
  unhelpful*, *No public access*, *Other*; *Flag · Inbox*; *Newest N of M*; *Open in the editor*;
  *Couldn't read this list*, *Counts couldn't be read*, *Couldn't read this body*, *Couldn't read
  the history*, *Reports, completeness and asks couldn't be read*, *Put-ins and bays couldn't be
  read*, *Try again*, *Trying again…*;
  *The full preview isn't available for a rejected body*; *Record begins 1 Oct* (Metrics' words).
- **Server requests it raises** (accepted for a follow-up server PR): a search across standings
  (`bodies.listPage` answering the other lanes); the number of askers and the intake reasons on
  `bodies.preview.asks[]`; `moreTowns` with each town's state; `bodies.rowsByIds` (rows by id, for
  *Opened recently*); `SEARCH_MIN_CHARS` in core; a row-and-facts read for a rejected or removed body,
  with when and why it left.
- **Owed:** each page commits twice (the reader hands it up), the price of drawing the note outside
  the boundary; the preview's notes share one pending flag across its reads; the library backfills
  on dev (`bodyLibrary:backfillAll`, then `bodyLibrary:backfillChangedAt`) before a deployment shows
  real rows.

### The Bodies reads made right (B01-3b, the first server follow-up)

What the dev verification of #112 found (2026-11-14), and the first of two server PRs that answer
it; the second carries the writes and the reads the list's page asked for.

**Why `consoleExtras` timed out on the largest lake.** Both timeouts logged the cover's warning
(about 350 level-13 cells against its 256), so the cover looked like the cause. It wasn't: past 256
cells at a rung, `bodiesCoveringBox` skips that rung and finer (bounded, never an unbounded
fallback), and read 215 cells in under 0.1 s. The second went to the touching test — about 1,300
point-to-outline distance checks against a 14,151-vertex outline and its twelve neighbors' (1.4 s,
reproduced). The skip did hide something: a small neighbor indexed only at the finest rung was
never a candidate. Only `consoleExtras` asked the cover for a body's whole box; the map's viewport
reads and `listedBodiesNearCoord` (with `marginMeters`) ask for a viewport or a point's margin and
truncate by design.

**What it does now.** A body's touching bodies and places are computed at the write and stored
(`bodyGeoFacts`, `lib/bodyGeo.ts`, the `bodyGeo` jobs). An outline's change, a body's creation,
import, merge or deletion marks it stale (and the neighbors whose relation moves); a five-minute
cron recomputes stale bodies in an action, where the geometry has room. Its box is tiled so every
tile reads the finest rung whole (`coverTiles`: halved along the longer side until each covers at
most 256 cells there, at most 32 tiles; `neighborsCapped` past that). The answer is stored only if
the outline it was computed for is still the body's. A body that fails three times parks
(`lib/attempts.ts`) and waits for the daily retry; one failure never blocks the rest. A body never
computed reads `null` — *not computed* — and a body computed in no boundary reads empty lists.
The console's reads do no work that grows with an outline: the largest-lake test seeds a
14,151-vertex body with twelve 3,000-vertex neighbors and holds every Body read under 800 ms in the
simulated backend (warm, best of three; each takes ~20–35 ms locally, and the touching test took 1.4 s
before it moved).

**When the stored geometry goes stale** (after Greptile on #118: an admitted body was never
computed, and a neighbor's held ring never followed its outline). The rule is the library row's: a
stored, derived fact is invalidated by every write that can change it, found by enumeration. Every
input, every writer, and the mark:

| Input | Writer | How it is marked |
| --- | --- | --- |
| A body is created | `waterBodies.importCanonical` (insert), `waterBodies.create` (a drawn body), `corpusRequests` admit (`admitCandidate`) | **The choke point:** `syncWaterBodyCells` marks a body whose cells changed or that has no facts row. Every creation re-cells the body, so none can skip it (the admit did, before: Greptile's P1) |
| A body is admitted that already exists (its twin) | `activateBody` → `transitionStanding` | Re-celled when its listing or zoom rung changes; it already has a row otherwise |
| A body's box moves | `importCanonical` (patch) | The choke point (the cell set moved), and the import's own `footprintMoved` mark |
| An outline moves inside its box | `importCanonical` (`footprintMoved`) | `markGeoStale` explicitly; no other writer moves an outline (D221) — the drift repair compares stamps for one that ever does. The stamp is the vertex count, the box and a hash of every coordinate, so a reshape at the same count inside the same box moves it too |
| The point its places are first read at | `importCanonical` (`shapeFields` rewrites `interiorPoint`) | `markGeoStale` when the point moves (`placePointMoved`), the outline unchanged or not |
| A listing changes | approve, reject, merge (the loser), removal, restore, every standing transition | The choke point when the cell set moves; a merge and the two prune deletions also mark explicitly |
| A body is deleted or merged away | `resolveIncomingMergeDuplicates`, `resolveCampaignDuplicates`, `mergeBodyInto` | Marked, then `bodyGeo.store` drops its facts and links and marks every body holding its outline |
| An unmerge | none yet (§4 Corpus) | It will re-cell the body: the choke point |
| A neighbor's outline | any write above, on the neighbor | **The fan-out:** each stored neighbor carries its outline's stamp, and `bodyGeoLinks` indexes who holds whose. When a body's own stamp changes, `store` marks every holder — 25 inline, a chained job past that. Only a body's own stamp moving fans out, so it ends (Greptile's P2) |
| A neighbor's relation (touching or not) | the neighbor's recompute | `store` marks the bodies whose ids entered or left the list |
| A neighbor's name or standing | rename, reject, merge, delete | Not stored for display: `consoleExtras` reads the name and drops a merged, rejected or gone neighbor from the library row at read time |
| The places layer | `adminAreas.importCanonical`, `deleteByExternalIds`, `retireOsmSourcedAreas` | `noteAdminAreasChanged` inserts a mark — on an insert, a boundary that changed in anything the places read, or a delete; never on an unchanged re-import. A row computed under an older mark is behind |
| Anything the above missed | — | **The drift repair:** `bodyGeo.repairDrift` every 30 minutes checks the 40 rows checked longest ago (the body's stamp, the places mark, each held neighbor's stamp against that neighbor's answer — or, for a parked neighbor that never lands one, against its outline as it stands) within the read budget; a row never checked comes first, so one computed before the links existed is recomputed — the whole table in about two weeks (slow on purpose: each check reads an outline, and it is a net for rare misses); `bodyGeo.repairMissing` weekly finds library bodies with no row |

The guard (`packages/guards/src/geoStaleWriters.test.ts`) finds every insert of a body and every
write whose literal names a `polygon` or `bbox` (and, in `adminAreas.ts`, every delete), and fails
when the enclosing function doesn't call the matching mark — or, for a patch that names a `polygon`,
when its own block doesn't call `markGeoStale` (the cell index marks only a changed cell set). It can't see a write whose fields come through a variable or a spread, a write in
a helper whose caller holds the mark, or one outside `convex/`; the drift repair is the net. **The
library row has no such gap:** the admit's `set_included_by_request` audit row refreshes it
(`writeAudit`), and a twin's activation queues it (`transitionStanding`); the admit test checks both.

**Compute cost, before and after.** Dev's numbers are user execution time on the largest lake
(the Convex limit is 1 s); the synthetic numbers are wall time in `convex-test` on the same
outline size, warm. They are different clocks; the point is the column of timeouts going away.

| Read | Dev, before (ms) | What it reads now | Synthetic largest lake, after (ms) |
| --- | --- | --- | --- |
| `bodyConsole.consoleExtras` | 1,002 — **timed out** | The body, its stored facts, a library row per stored neighbor | 23 (167 on the first, cold call) |
| `bodies.preview` | 52 | Unchanged, plus the stored towns | 35 |
| `bodyConsole.history` | 210 (2,318 wall) | One link range per body in the merge chain | 22 |
| `bodyConsole.places` | ~280 wall | The stored facts | 22 |
| `bodyConsole.bayProvenance` | 112 wall | Unchanged | 22 |
| `bodyConsole.landmarkProvenance` | 93 | Unchanged | 21 |
| `bodyConsole.dailyHazards` | 41 | Unchanged range, stamped ends | 22 |
| `standing.retentionForBody` | 85 | Two bounded put-in reads | 23 |
| `bodies.listPage` | 327 (max) | Unchanged | 2 |
| `bodies.listSummary` | 62 | Unchanged | 1 |
| `bodyGeo` computation (action) | — | The body, its candidates per tile, its places' cells | ~5,000–6,000 for the giant and its twelve neighbors |

**The rest of the PR.**

- **History is one indexed range per body** (D259). Audit rows link to every body they concern
  (`auditBodyLinks`, written by `writeAudit`; `auditLinks:backfill` for the rows before). A body's
  History reads its own links and those of every body merged into it, newest first. `capped` means
  only that more rows exist than returned (or the merge chain ran past 50). `bodyOnly` narrows to
  rows on the body itself (and on each body merged into it); for a body nothing was merged into, those
  equal `moderation.listActions`' rows for it (tested).
- **A merge moves what was asked of the merged-away body**: its requests of every kind and status
  (the founder's ruling), and — the coordinator's extension — its open place names and its open or
  reviewing flags (a flagger's flag stays where it is when they already have an open one on the
  survivor). The moved rows are in the merge's change set beside the reports, hazards and the rest it
  already recorded. **No unmerge exists yet** (`undoPolicy`: *later, §4 Corpus*), so "undo puts them
  back" holds when it is built from that change set, not before.
  `waterBodies:retargetMergedAsks` moves the asks of the bodies merged before this existed (eight on
  dev).
- **The winters' strip counts recorded ends.** A hazard records when it left the lake
  (`leftLakeAt`): the vote that archived it (archival is a ratchet, so there is one such vote) or its
  merge into another pin. Set once, never moved. `dailyHazards` counts a recorded end through its
  day and no further; an archived pin without one (every pin archived before this) stays *unknown*
  after its first day. Days run through the end of the caller's UTC day; the window opens 1 July, the
  span the Hazards tab's list covers. Each counted hazard's first-report day and whether its end is
  recorded come back in `hazards`. Nothing reads as ended on weaker evidence than before: an
  unstamped end is never guessed, and a still-active pin counts through today whatever its stamp.
- **Every read that takes a body id follows a merge** through `resolveSurvivor` (`lib/bodies.ts`):
  the console's reads, `bodies.preview`, `standing.retentionForBody`, a lake's open names and bay
  asks.
- **A hidden put-in no longer keeps a body active.** `hasSavedPutIn` read 25 rows of any status and
  answered *yes* when they filled, so a body with 25 or more stored rows and no unsuppressed launch
  (a run of hides; launches all at a hidden coordinate) was kept. `savedPutInsOf` reads the visible
  rows, then the hidden coordinates, through `by_water_body_status`, 25 each; it answers exactly when
  both reads are whole and keeps the body when either isn't. The rollover walk is unchanged;
  `retentionForBody` asks the same function with wider reads. The fixture counts two shapes of nine
  that the old rule answered differently, both towards dormant, both bodies with no launch.
  **Counting them on dev:** a dry `standing:demoteInactiveBodies` pass over every page before the
  deploy and after; the difference in `demoted` is the bodies this changes.
- **Exactly the cap is whole.** The library's asks (each source) and reports, and the place-name
  queue, read one past their caps. `bodyLibrary:requeueCapped` re-counts the rows stored under the
  old meaning. `corpusPlaceNames.openForBody` and `corpusRequests.openBayRequestsForBody` say `more`.
- **The deferred call sites** (the governor's ruling above): a skater's new request and a new flag on
  a body queue the body's library refresh; the hazard callers of `recomputeBodySummary` pass
  `library = false`.
- **The audit feed names its targets** (S5): `listActions` rows carry `targetLabel`, a body's name
  from its stored library row, a person's display name.
- **`SEARCH_MIN_CHARS` is core's**; the list's page re-exports it.

**API shapes this PR changes** (every other read is as it was):

- `bodyConsole.consoleExtras`: adds `touching` (`[{ waterBodyId, name, ring }] | null`) and
  `geoComputedAt`; `towns` and `touchingBodyIds` come from the stored facts, `null` until computed,
  and `towns` is `[]` (not `null`) for a body in no town.
- `bodyConsole.places`: adds `computedAt`; `null` only until computed, empty lists for a body in no
  boundary (it was `null` for both).
- `bodyConsole.history`: adds the `bodyOnly` argument; `capped` means only more rows than returned.
- `bodyConsole.dailyHazards`: adds `hazards`; the window opens 1 July (it opened 1 October) and runs
  through the caller's whole day.
- `bodies.preview`: adds `townsComputedAt`.
- `standing.retentionForBody`: adds `putInKeeps`; `savedPutIns` counts at most 1,000 visible rows
  against at most 200 hidden coordinates, `savedPutInsCapped` past either.
- `moderation.listActions`: rows add an optional `targetLabel`.
- `corpusPlaceNames.openForBody`: was an array, now `{ names, more }`.
- `corpusRequests.openBayRequestsForBody`: was an array, now `{ bays, more }`. The old lake editor's
  two call sites read the new fields — the PR's only web change besides the search constant.

**After merge, on dev, in order** (each an internal function; the operator runs it with
`convex run`, no identity): `convex dev --once`; `bodyGeo:seedAll` then `bodyGeo:computeAll`;
`auditLinks:backfill`; `waterBodies:retargetMergedAsks`; `bodyLibrary:requeueCapped`.

**What the self-review changed** (before the PR opened):

- An unmerged hazard drops the stamp its merge wrote, so an archiving vote later records its real
  end; before, it kept the merge's day and the strip read the days between as clear.
- A merge leaves a flagger's flag on the merged-away body when they already have an open or
  in-review flag on the survivor for *any* reason (it checked the same reason and status), and
  `contentFlags.flag` files a flag through a merged-away id on its survivor.
- The geometry jobs: a stale mark that lands while a body is computed survives that body's store (a
  mark on a stale row moves `staleAt`, and `store` takes the mark `inputs` read); `consoleExtras` drops
  a rejected neighbor as it drops a merged one; the daily retry walks every parked body, not the cron's
  batch of 60; `seedAll` pages 250 (a re-seed rewrote up to 1,000 facts rows of ~16 KB); a tile's
  candidates skip the outlines the action already holds.
- A lot's audit row links to up to 64 of the bodies it serves (it took the library refresh's 16, so a
  seventeenth never saw it); History's body-only verb reads `by_body_self_action_time`.
- `corpusPlaceNames.openForBody` reads most discussed first (`by_water_body_status_messages`), so a
  lake past the cap shows its most discussed names; `reportsCapped` asks whether the first report left
  unread is inside the record; `retentionForBody.putInKeeps` is the rollover's own read.
- `adminAreas.townsForBody` is gone; `bodyGeo.placesFrom` is the one rule.

**Waiting for the second server PR:** a search across standings; a row-and-facts read for rejected
and removed bodies; askers and intake reasons on the preview's asks; `moreTowns` with each town's
state; `bodies.rowsByIds`; a light completeness read; the bathymetry search record; town lines; and
the four writes (`setAliases` with `moderatorAliases` and `setClass`; choosing a depth source and
filing a survey; the imagery pass override; editing a feature's shape).

### The Body console (B01-3, integrated)

**B01-3 (2026-11-13): Bodies — the library and the Body console, integrated.** Five builders (the
kit extensions, the Bodies list, the console's frame with Shape, Names/Places/Access/Water,
Imagery/Hazards/Standing/Links), cherry-picked serially onto `b01-3` off the kit branch.

- **Bodies mounts at `/admin/bodies`** and each body's console at `/admin/body/$id`; the rail's
  Bodies (G then B) stays lit inside a body. *Open in Body* carries the list's own address as
  `from`, and the console's way back defaults to the list. Home's most-reported rows, the audit
  feed's body rows and the palette's bodies now open the Body console; the old editor stays
  standing for the tools not built.
- **What the pages read today.** The list's reads are above (*The Bodies list*). *Opened recently*,
  which the console writes, has no server lane:
  each body by id (`waterBodies.get`), drawn as the body carries it, nothing narrowing or ordering
  it. The console reads the server too (the frame, Shape and the eight tabs, BS7–BS15): stored
  completeness (`bodies.preview`'s `complete`, core's ten — no stored answer reads *Not recorded
  yet*), the body's family history (`bodyConsole.history`, a capped read heads "Latest N" and says
  more exists), `consoleExtras` (towns, the outline's trust, touching bodies drawn as neighbors),
  bays' provenance, places, landmarks' provenance and proposers, the ruling's history by verb,
  `hasBathymetry`, `retentionForBody` and `dailyHazards` (a day's known count as bars, its unknown
  part said in words — "at least N, some unknown", never clear — and each archived hazard one mark
  on the day it was first reported, from the archived list). Controls whose write doesn't exist yet
  are drawn and say *Not available yet*.
- **One read layer, one failure note, one boundary** (the fold of the three wiring branches).
  `components/admin/reads/consoleReads.ts` is the console's only read layer, shared by the Bodies
  list (its counts and preview) and the Body console: `useConsoleReads` /
  `useConsoleReadSet` over one `useQueries` keyed on values; each read loading, a `ReadFailure` or
  its value, never a throw; one registry of paused reads, so *Try again* lets go of a read in every
  holder — frame, tab, the tab's map, and Imagery's archive (`useExternalRead`) — and the server
  runs it once afresh; from *Try again* to the fresh answer the read is a *pending* failure (the
  note says *Trying again…*), so the old failure never flashes back; Sentry hears a failure once by
  the read's identity (the client hands back a fresh `Error` each time it is asked, so the frame's
  `WeakSet` re-reported on every render) and again only after the read recovers. The failure note
  is the kit `RetryNote` (a live region mounted before its words, `aria-disabled` while pending,
  focus kept when it empties), drawn through `ReadNote` (`reads/`). The list's paginated read stays
  on Convex's paginated hook, run in a small reader under the kit `ReadBoundary` that hands its pages
  up, so the page — and its failure note — is drawn once outside the boundary: the note is mounted in
  every state, holds as *Trying again…* while the boundary resets and the first page reloads, and
  keeps focus on its own region when it empties (the kit's rule, as in the console). `TabBoundary` (the
  kit `ReadBoundary`) is the one boundary around a tab, reset by another body or tab. Kit moves:
  `RetryNote`, `ReadBoundary`, `EntryTile` and `UnavailableButton` (with Shape), `UnavailableField`
  and `UNAVAILABLE` (once, beside it), `Section`'s capped count and `warn` chip, `DayStrips` with
  first-report marks, a caption and an undrawn unknown part that keeps its words (replacing the old
  strips), and one `listWords` (`lib/words`).
- **Server requests — one list, from the list and the three wiring branches.** #118 (the first
  server follow-up, merged 2026-11-14) delivered, and the pages now read:
  - ~~`SEARCH_MIN_CHARS` in core~~;
  - ~~`more` on `corpusPlaceNames.openForBody` and `corpusRequests.openBayRequestsForBody`~~ (the
    client's mirrored caps are gone);
  - ~~`bodyConsole.history`'s `bodyOnly` and an honest `capped`~~;
  - ~~neighbor names and simplified rings in `consoleExtras`~~ (`touching`; nothing is read per
    neighbor);
  - ~~`dailyHazards` through the caller's whole UTC day, from 1 July, following a merge~~ (and
    `retentionForBody`);
  - ~~each counted hazard's first-report day and whether its end is recorded~~ (`hazards`, the
    marks' source);
  - ~~the list and the day-by-day read agreeing on expired crossings~~;
  - ~~`putInKeeps`, the rollover's own answer~~;
  - ~~"not computed yet" told from "in no town"~~ (`computedAt`, `geoComputedAt`, `townsComputedAt`).

  What remains waits for the next server PR, and until then each page says what it can't do rather
  than drawing it:
  1. **Search across standings** (`bodies.listPage` answering the other lanes): board 5.3's
     "Dormant 4" group and its tally are not drawn until it lands.
  2. **A row-and-facts read for a rejected or removed body, with when and why it left.**
  3. **`bodies.preview.asks[]`: the number of askers and the intake reasons.**
  4. **`bodies.preview.moreTowns` as `{ name, state }`.**
  5. **`bodies.rowsByIds`**: *Opened recently* draws only what `waterBodies.get` carries.
  6. **A light completeness read, or `complete` in `consoleExtras`**: the frame reads
     `bodies.preview` for one stored answer.
  7. **A bathymetry search record**: Water says *Not recorded yet*.
  8. **Town lines for the Names map.**
  9. **The four writes**: `setAliases` and `setClass`, choosing a depth source and filing a
     survey, the pass override, and `updateShape`.
  10. **An `active` flag on each of `dailyHazards`' hazards**: the read says whether an end is
      recorded, not whether a hazard is still up, so the strip tells an archived hazard from an
      active one by the next day's unknown part. A hazard first reported today is a bar until
      tomorrow says which.
- **Where the mock and the code differ** (each a founder call; the code stands until ruled):
  the list's state tabs carry no counts (the board's do), completeness is out of ten (the boards'
  twelve), and the ask kicker is *Bay name · Inbox* (the board's raw `name_bay`); the frame's
  *Trusted* carries a second line (how it came to be trusted) the board doesn't draw, and Merge
  stays when the touching test couldn't run or stopped short, with its note; Names and Water draw
  extra *Not recorded yet* lines on their ladders (each catalog's own claims, the other sources'
  depths); Names' Location comes from `bodyConsole.places`, where the board draws it; Hazards' quiet
  winter heads *No open reports · N archived* (the board's *All voted gone*); the strip runs the
  whole season, 1 July to 30 June (the boards draw October to March), so a hazard reported before
  October never falls off it; Standing's favorites read "1,000+" past the read's cap.
- **The hazard strip — ruled by the founder, 2026-11-14** (it closes the question of last winter's
  unknown part). A hazard whose end isn't recorded — every archived hazard today — draws **one mark,
  on the day it was first reported, and nothing after**, never a stack of "unknown" days; a hazard
  whose span is known (an open one, through today; later, an archived one with a stamped end) draws
  a bar for each day it was on the lake. A caption under the strips, present whenever a mark is
  drawn, says what a mark is and that how long the hazard stayed isn't recorded. A day's words say
  *first reported*, never ended, and pass the all-clear test; the server's `unknown` is still said
  for the day (an unknown-only day draws nothing but keeps its words on an unseen target) and in
  the strip's summary. A day draws the server's `count` less its marks as bars, so it never draws
  fewer known hazards than the count. Since #118 the marks come from the day-by-day read itself
  (`hazards`, each first-report day and whether its end is recorded), so every strip is marked —
  last winter's beside this one too; an archived hazard is told from an active one by the next
  day's unknown part (server request 10). The strip runs the season's whole window, 1 July to 30
  June, on one axis with a slot for 29 February; every month is ticked, the quarters named. The
  *Today* line stands over a list as beside an empty winter, since both now cover the same span.
  Property-tested: each archived hazard with no recorded end yields exactly one mark, on its
  first-report day; an ended or active one never; no day draws fewer than `count`; the caption is
  there whenever a mark is.
- **Wording the mock did not supply.** The list's ask words, all in
  `components/admin/bodies/askWords.ts`: request kinds *Activation*, *Admission*, *Restoration*,
  *Access contested*, *Takedown*, *Landmark name*; what a nameless request asks for — *Make it
  active*, *Add it to the map*, *Bring it back*, *Reopen its access*, *Take it down*, *Name a bay*,
  *Name a landmark*; a flag's reason — *Dangerously false ice report*, *Spam*, *Harassment*,
  *Inappropriate*, *Rated unhelpful*, *No public access*, *Other*; the kicker *Flag · Inbox*. The
  Hazards words, all in `tabs/hazards/hazardsWords.ts` and held by its test to never say gone,
  clear, healed, resolved, safe or fine about the lake: *No hazard reports on record* (never "no
  hazards"), *No open reports · N archived*, *At least N reported on the lake, M unknown*, *N
  reported on the lake, M first reported this day*, *M unknown: archived, may still have been on
  the lake*, *N days with hazard reports, M first reports with no recorded end, K with some
  unknown*; the strip's caption, *A bright mark is the day a hazard with no recorded end was first
  reported. How long it stayed on the lake isn't recorded; the days after it are not a reading of
  the ice.*; *N archived reports have no recorded end. Each is marked on the day it was first
  reported; from then on, every day counts them as unknown: each hazard may still have been on
  the lake.* (or, while one was first reported today, *M are marked on the day first reported,
  and the rest counted that day without a mark*), *Not computed yet*, *In no town*, *In no
  county*, *Towns not computed yet*; *The count stopped short of every hazard
  reported; each day is at least what it shows*, *No reports counted; the count stopped short*,
  *Archived this winter*, *Gone votes* and the counted, attributed
  "N skaters voted it gone". The failure lines: *Couldn't read this list*, *Counts couldn't be
  read*, *Couldn't read this body*, *This body couldn't be read*, *Couldn't read the history*,
  *Reports, completeness and asks couldn't be read*, *Couldn't read …* (a tab's list of what
  failed), *Couldn't be read* (in place), *{Tab} couldn't be shown*, *The map couldn't be drawn*,
  *The map couldn't read …*, *Try again*, *Trying again…*; and *The full preview isn't available
  for a rejected body*, *More history exists than is shown here.*, *Latest N*, *Record begins 1
  Oct* (Metrics' words).
- **States no board draws yet:** the console's removed and merged pages ("This body was merged into
  X", a link, no redirect); every failure note and its pending state; the map's failure notice in
  its foot; *Record begins* before 1 October (Metrics); the unknown and capped notes (a floor, "at
  least N", "Latest N"); the hazard strip's first-report marks and their caption, and its
  season-long axis; *Not computed yet* for a body's towns and touching bodies; the list's preview
  of a rejected body.
- **Owed** (accepted, 2026-11-14): **a design question for the founder — a hazard the map cannot
  show.** A hazard whose footprint can't be grown (malformed geometry, a buffer error) is drawn
  nowhere on the map (core's rule: "nowhere rather than somewhere wrong"), while the list counts it,
  so the map can show fewer hazards than the list. Also owed: Imagery builds its freeze-up timeline
  three times (inspector, dock, map); the four tabs' write wrappers and clock hooks are copies of
  `useTabAction`'s and each other's; a failed archived read over a list says so only inside the
  collapsed group; every Hazards open reads the body's whole archived history (`includeArchived`);
  the Hazards, Imagery and Standing views' own notes are still drawn only in their failed branch —
  they hold as *Trying again…* through a retry, but mount with their words (so they aren't
  announced as reliably as a region mounted before them) and leave with the fresh answer, so focus
  that was on *Try again* drops to the page. Fixed since: the leap-year axis (every winter on one
  1 October – 31 March axis with a slot for 29 February, property-tested), the hourly skeleton (a
  winter keeps its last answer through the hour's turn, drawn against the hour it was read for, so
  a held winter never reads the new day as clear), the list's notes (one read layer, mounted live
  regions, *Trying again…*, focus kept), and *Trying again…* on the tabs-b views' notes
  (Imagery's archive holds its own wait, since the registry keeps none for a reader outside
  Convex).
- **The console's interaction rules, set by the PRs' review round** (each held by a test over
  every tab, `tabs/tabAudits.test.tsx`):
  - **What answers a click answers the keyboard** (`src/test/keyboardAudit`). The kit's clickable
    `TableRow` is now a Tab stop that ⏎ and Space press, with ↑↓ Home End between rows.
  - **A cursor that isn't the focused element is scrolled into view** on every keyboard move, at
    once, never smoothly (BulletList fixed; MiddleList and the Bodies grid already did it).
  - **A tab's keys work wherever focus lands when the tab is reached**: they listen on the whole
    inspector (`frame/tabKeys`). Arriving at a body with nothing focused puts focus in the panel.
  - **A tab change restores that tab's defaults**: the map's switches, the lit item, the panel's
    scroll. State saved for one key is cleared, never parked: Hazards' held winter too. The map's
    camera through a theme switch and the list's scroll per list are remembered on purpose.
  - **No absent fact renders as a blank** (`src/test/blanksAudit`), and each model lists what its
    reads return that it doesn't keep, and why. The audit carried two facts through:
    - each proposal's first-asked date (*Asked 11 Oct 2026* / *Asked: Not recorded yet*);
    - a landmark's staff edits (*Changed*: *Edited … · Moved …*).
    It also wrote out three absences: *Who ruled: Not recorded yet*, and a bay with nothing
    recorded about its making.
  - **A write that settles never drops the keyboard to the page** (`frame/keepFocus` on the panel;
    Links returns focus to the link's own Edit, and a saved drop keeps its grip). A kit draft never
    outlives its items: SortableRows puts a lift down when its rows change, and links keep ids
    across an edit (`carryIds`).
- **Left by the three PRs' reviews** (each a call or a follow-up, none blocking):
  - the map pans only within three times the body's box, which keeps the min zoom out of reach on
    a wide pane; widening the fence changes "pans only within the body's reach" (founder call);
  - a depth stored without a source is not drawn in Water's table, whose rows need a source; focus
    does not return to the landmark row when the inset card closes (it would steal focus from a
    click in the left column);
  - archived rows' *last seen* is in the reader's zone while the strip's days are UTC; *since the
    watch opened* scopes an archived count that runs from 1 July; Imagery builds its timeline three
    times; an unmeasured kit `Meter` drops its passed props; the pass pager's ← → hints work only
    from the dock's slider; a dragged staff link snaps back until its save lands;
  - in the list: the survivor redirect (a merged body's id swapped for its survivor) moves the
    search's place and drops typing in progress; a heading sorted while a search waits is
    re-ranked by match when the search lands;
  - staff links have no id on the server: the console carries ids across an edit on the client
    (`carryIds`), which holds for one operator; a stored id per link would hold across operators.
- **The map contract settled before any tab landed.** Adopted from the tab builders: a `proposal`
  mark; `approach` and `dimension` lines and a `measure` label (a dimension is drawn in pixels with
  fixed ticks); a footprint's `field` — the hazard dot field, dimmed by freshness and a step further
  while unconfirmed, floored at .24 so a stale hazard fades and is never removed (D3, fast-checked);
  a `raster` item for an imagery pass, adopted into `items` rather than a separate list so the rack,
  the merge and the lit rule hold it, and painted by the skater app's own reveal
  (`useFreezeUpFrame`, its frame now asking only for the key); a plate `caption`; a tab `Dock` in a
  foot slot; and `useData(bodyId, lit)`, so Imagery follows the chosen band and Hazards the chosen
  winter. Every style write still waits on the live map; the map's projection math moved to
  `lib/mapSurface.ts`.
- **Duplicates merged:** three LED strips into the kit's `LedStrip`; the frame's place marks and
  the Places tab's landmark mark into `PlaceMark`; Access's entry tile and Shape's bay tiles into
  `EntryTile`; `ThresholdMeter` into the kit `Meter`'s lit tick (with a not-measured state).
- **Tokens taken up:** `gap.section` (the tabs' section gap), `gap.unit` (value to unit),
  `gap.segment` (the LED strip), `opacity.fade` (a mark stepping back for a hover). The rest of the
  builders' literals are each component's own dimensions.
- **What the integration found:** the tabs' copies of the frame's contract were verbatim, so
  removing them was mechanical; the frame's tab registration became generic over a tab's data; a
  test that pinned an unbuilt slot to *Water* now builds a Shape-only registry; the Hazards tab
  held its winter in local state, which its map could not see — the winter moved into the lit
  address; a promoted proposal glyph drawn as SVG text leaked a "?" into the map key's words, and
  is drawn as a path.
- **What is verified about the map, and what isn't.** The dot field, dimension lines, measure
  labels, proposals, the captioned plate, the fade on a plate and the foot slot are asserted on the
  SVG still (`Admin/Body/Map contract`); the layer order, the live-map gating of every write
  (against a fake map that throws before `load`) and the palette are unit-tested. The live MapLibre
  canvas — and the imagery raster on it — can't run in the automated browser (its tiles answer only
  a local dev address) and wasn't driven.
- **Every shown value and what qualifies it** (the review round of 2026-11-15, after Greptile
  caught a straight-line walk drawn as a measured route on #120). For each number, distance, date
  or count a tab shows, the server field that says how far it can be trusted, and how it is drawn.
  Rows marked *new* were dropped on the way to the screen until this round. Each weaker state is
  rendered by a test (`tabs/qualifiers.test.tsx` for Access and Water; the rest beside their
  views).

  | Tab | Shown | Qualified by | Drawn |
  |---|---|---|---|
  | Frame | Area | The outline it is computed from (`geometrySource`, the trust) | Exact for that outline; its source tag and *Trusted since* beside it |
  | Frame | Depth avg / max | `meanDepthSource`, `maxDepthSource` | *New:* plain only where a measured source vouches for it; "~9.4" for a modeled or unrecorded one, as core's `lakeCaption` reads it |
  | Bodies list | The preview's depth | The same two sources | *New* (the same drop, from #114): the same rule |
  | Frame | Elevation | `elevationSource` (moderator, 3DEP, GLO-90) | Not drawn: a DEM sample is a measurement at the interior point, the skater's header draws it plainly too, and freeze order is a hundreds-of-feet question |
  | Frame | Towns | `townsComputedAt` | *Not computed yet*, never *In no town* |
  | Frame | Asks, History | The reads' `more`, `capped` | Never counted as whole: a note, *Latest N* |
  | Shape | Touching bodies | `touchingComputedAt`, `touchingCapped` | *Isn't computed yet*; *smaller ones weren't checked* |
  | Shape | Bay acres; how each bay was made | Its polygon; `createdVia`, `createdAt` | Exact; *Not recorded yet* |
  | Names | Towns, county | `townsComputedAt`, `geoComputedAt` | *Not computed yet*; *In no town / county*; a county not found beside towns, *Not recorded yet* |
  | Places | Asks | The reads' `more` | A floor, "2+" |
  | Places | A proposal's nearby landmark, in meters | Point to point | A distance between two points, not a route: plain |
  | Places | Added, edited | The provenance read | *Not recorded* when it doesn't say |
  | Access | Walk from the lot | `approachRouted` | *New:* "at least 412 m" for a straight line (a moderator's link, until the ETL routes it); plain when routed or from before the flag, as core reads it |
  | Access | Earlier rulings; who ruled | History `capped`; the ruling's row | "19+"; *isn't recorded* |
  | Water | Each source's depth | Measured or modeled (core) | "~8.1" and *Modeled · an estimate* |
  | Water | A moderator's depth | `depthSourceNote` | *New:* the note ("NH Fish & Game, 1998 chart"), or *Entered by hand · no source noted* |
  | Water | Bathymetry | `hasBathymetry` only | What was searched isn't recorded, and says so |
  | Imagery | Cloud, coverage | The stop's `basis` and stats | *New:* *Not measured* on screen (it was a blank cell and an empty track, which read as zero); a region-wide figure says *over the region* |
  | Hazards | Age; state | `lastConfirmedAt`; `freshness`, `provisional` | Since anyone looked; fades, never removed; *unconfirmed* |
  | Hazards | Day counts | `unknown`, `capped`, `unknownEnds` | The unknown part; *at least what it shows*; the notes |
  | Hazards | A report's kind | `type` | *New:* a crossing is *Reported crossing*, its own mark, neutral (below) |
  | Hazards | Patterns waiting | The read stops at 1,000 with no `more` | Can't be told from whole; owed (BS19) |
  | Standing | Favorites, saved put-ins | `favoritesCapped`, `savedPutInsCapped` | "1,000+" |
  | Standing | Last activity, boost set, put-in keeps | `at: null`, `putInKeeps: null` | *Not recorded* |
  | Links | — | The derived links are built from the record; staff links are as entered | Nothing qualified |

- **A whole-list write is one queue; a single value is the last write** (Greptile's P1 on #121,
  Links' saves undoing each other). Two writers send a whole list: Links' staff links
  (`setReferenceLinks`) and a landmark's other spellings (`landmarks.update`'s `aliases`). Both go
  through `tabs/listWriter.ts`: a save path hands it a change by id, applied one write at a time to
  the newest list the server acknowledged (its own last write until the echo is seen, else the
  server's list, which carries another moderator's change — and always when the echo renders
  before the acknowledgment, the console's usual order, since the receipt is a further round trip;
  Links compares lists by their words, its row ids being the page's own). Chosen over blocking
  every control while a write is pending: it is small, and a press is never refused. A fast-check
  property drives arbitrary interleavings of presses, fast, slow, echo-first and refused
  acknowledgments, renders and outside changes, over both the generic changes and Links' own. Every other write sends one value — Names'
  name, a landmark's name and kind, Access's ruling and its put-in levers, Standing's standing,
  Imagery's satellite link — so a second press while the first is pending sends a second value and
  the later wins, nothing built from a stale copy; each dialog's own busy state keeps its reason
  from sending twice; a server change underneath moves the shown value, and an open dialog keeps
  what was typed. The race no client can close: another moderator's whole-list write committing
  while ours is in flight is overwritten by ours (BS17).
- **A reported crossing, on the safety tab** (Greptile's P1 on #121). `ridge_crossing` is a report
  that someone got across a ridge there (D51, D64), and it drew as a red danger field. `hazardKind`
  is now an exhaustive switch over core's types (a `never` check), and it decides the map mark (the
  kit's two-bar crossing mark, never the danger field), the row (*Reported crossing* in neutral ink,
  its age, *Reported again N times*; no state word, since "fresh" reads as good), the archived row
  and the words, held by a crossing claim guard (safe, passable, crossable, ok / clear / fine to
  cross, the way across). Not copied from the skater app, and raised with the founder: its passage
  color is a "positive-but-cautious green", and its verdict reads *Still crossable*, which trips
  the guard. The kit's crossing mark wears the ice accent, the boards' choice — neither red nor
  green; gray is a one-token change if the founder wants it quieter. The day strip follows the
  server, which counts a crossing as a report on the lake (BS18). Needs eyes on a real map: a fresh
  crossing on the preview reads as the two-bar mark, not a red field, and sits under the lit plate
  as the marks do.
- **Every write control and what its write does** (Greptile's P1 on #120: *Make official* inserted
  a second put-in). Read from each mutation's server source, since a test that mocks the Convex
  hook can't see it. Each control has a test that applies the mutation's real effect to the reads
  and shows the lever gone or inert with a second press writing nothing. *Undo* is what the
  server's undo policy offers on the receipt.

  | Tab | Control | Mutation (ids) | What the server does | The page after | Undo |
  |---|---|---|---|---|---|
  | Frame | Map boost | `waterBodies.setCuratedBoost` (the body) | Patches the boost; a dormant body rising above zero is brought back | The slider follows the record; letting go where it stands sends nothing | Set back |
  | Names | Display this; Back to the ranking; a community name | `waterBodies.setWaterBodyName` (the body, a name or `null`) | Sets the name with a `user` claim over the catalogs', or drops the claim and restores the catalogs' first | The chosen rung loses its lever; Back goes when nothing is overridden; ⏎ on the held name sends nothing | Set back |
  | Places | A landmark's name, kind, other spellings | `landmarks.update` (the landmark, one field) | Patches that field in place | The card shows the record; the same value sends nothing; spellings queue | Set back |
  | Places | Already here | `corpusPlaceNames.fileAsSpelling` (the name, the landmark) | Adds the name to the landmark's spellings; closes the name as *placed* | The ask leaves the list | The landmark's edit only; the name stays placed |
  | Places | Dismiss | `corpusPlaceNames.dismiss` (the name, a reason) | Closes the name as *dismissed* | The ask leaves the list | Not built ("not built yet") |
  | Places | Same place | `corpusRequests.approve` (the request, the landmark it may be) | Decides the request as approved, answered by that landmark; tells the asker | The ask leaves the list | Later (Inbox) |
  | Places | Decline | `corpusRequests.decline` (the request, a note) | Decides it as declined with the note the asker reads | The ask leaves the list | Later (Inbox) |
  | Access | Rule accessible; Rule no public access; Clear the ruling | `waterBodies.setPublicAccess` (the body, a verdict or `null`) | Sets the ruling; *accessible* brings a listed body back; closes open *no public access* flags | The lever for the ruling now standing goes | Set back |
  | Access | Hide | `putIns.hide` (the body, the launch's point, a reason) | Inserts a hidden row there, which hides every launch within 150 m (the dialog says "with every launch close by") | The launch leaves the list | Not built for a body target |
  | Access | **Make official** | `putIns.setOfficial` | **Inserts a second, official put-in** at the point (no parking, no walk) and leaves the launch | **Mismatch → *Not available yet*** (BS20) | — |
  | Imagery | Satellite link | `waterBodies.setSatelliteImagery` (the body, a mode) | Patches the mode | The chosen mode holds; pressing it again sends nothing | Set back |
  | Imagery | Show anyway; Hide from skaters | — | No writer on the server (BS13) | *Not available yet* | — |
  | Hazards | Demote | `bodyFeatures.demote` (the feature, a reason) | Sets the feature inactive; the active read drops it; frees its source hazard | The feature leaves the list | Later |
  | Standing | Set dormant; Bring back | `standing.setStanding` (the body, a standing, a note) | Sets the standing with the note; refuses a move it can't make | The pick follows the record; the form goes | Set back |
  | Standing | Remove from the map; Restore | `waterBodies.remove` / `restore` (the body) | Stamps or clears `removedAt` and its reason | The form goes; Restore is picked from Active | Each other |
  | Links | Reorder, add, edit, remove | `waterBodies.setReferenceLinks` (the body, the whole list) | Replaces the list | Through the one queue (above) | Set back |

  The one mismatch, *Make official*, became *Not available yet*; nothing else said one thing and did
  another.
- **A body's own state dies with it** (Greptile's P1 on #121: Standing's pick and note followed a
  switch to another body already read, and its save targeted the new body). One place keys a body's
  subtree: `BodyTabHost` mounts every tab and its dock keyed by body and tab; the map's drawing
  probe, the left column and the list's preview are keyed by body too. Kept across bodies on
  purpose: nothing. And every write is bound (`frame/currentBody.tsx`), with one explicit
  lifetime: a binding is one console's hold on one body, made by `BodyBindingProvider` (above the
  console's loading and tab branches, and in each tab host), alive from its commit until that
  console goes away for any reason — the body changes, a loading or failed state takes its place,
  the tab host unmounts, the route is left, the shell remounts — and never revived (coming back is
  a new console). A consumer holds the binding current at its mount; every write goes through
  `sendFor`, and the list queue checks the binding before taking up, sending and taking in each
  save. So nothing is sent once its console has gone (a save already pressed and queued is
  dropped), and a write already on its way lands but its refusal and receipt are dropped (History
  keeps the row). Proved by a model-based test (`bodyBinding.model.test.tsx`, fast-check over
  opening cached, uncached and failing bodies, tab switches, single and queued saves answered late,
  leaving and returning, remounts — on the real provider, host, queue and `sendFor`), and by named
  examples in the real route (Links, Standing, Access's Hide). Each tab
  and the preview have a switch test. **Open (a founder call):** a receipt toast already showing
  when the page switches stays its ten seconds over the next body, its title unnamed ("Links
  saved") and its Undo for the body it came from — close receipts on a switch, or name the body in
  them. The People pages
  (the `b01-4-people-person` branch, read, not changed) already remount the person's page by user
  id, and their receipts name the person; a late one still shows after a switch, under that
  person's name.
- **A write's completion acts only on the attempt that started it** (Greptile's P2 on #121). Links'
  editor openings each have an id; the reason dialog, Hazards' demote, Imagery's hide ask, Standing's
  form and the map boost tie their answers to their own opening or commit. The dialogs refuse to
  close while sending, so no dismissed attempt exists mid-write.

### The Bodies server register (owed to the server agent)

Every seam the B01-3 builders raised against `packages/convex` and `packages/core`; what the server
built against each is the table above. Nothing here blocks a merge: each block draws *Not recorded
yet* (or the fact as unknown) until its read lands.

| # | Ask | For | Status |
|---|---|---|---|
| BS1 | `bodies.listPage` — paged, server-sorted and filtered, a denormalized library row per body, indexes, search by standing, state, class and ids | The Active and All lanes, sorting and facets beyond a held lane | 🟢 server |
| BS2 | Lane counts | The lanes sidebar's counts | 🟢 server |
| BS3 | Facet counts | The facet menu's counts | 🟢 server |
| BS4 | `bodies.preview` — reports this season and all-time, asks, the town | The list's preview | 🟢 server |
| BS5 | Completeness in core (`bodyCompleteness`, on the server branch) and stored per body; the client module (`components/admin/body/completeness.ts`) is replaced by it | Both pages; the list's completeness column and facet | 🟢 server |
| BS6 | The starting page size | The list | 🟢 server |
| BS7 | `waterBodies.consoleExtras` — towns, `hasBathymetry`, `outlineTrustedSince`, `touchingBodyIds` | The console's identity list, completeness's bathymetry, neighbors on the map | 🟢 server |
| BS8 | `subAreas.listForBody` with `createdAt` / `createdVia`; a body-scoped history read that includes its sub-areas, landmarks and put-ins | Shape's bays; the console's history; *Changed this week* | 🟢 server |
| BS9 | Names: `setAliases`, `setClass` and class claims, per-catalog name claims unfolded | The Names tab's writes | ⚪ deferred (after #110) |
| BS10 | Places: `adminAreas.placesForBody`; the asker on landmark requests; a landmark's `createdAt` / `createdBy` | The Places tab | 🟢 server |
| BS11 | Water: `depthCandidates` + `chooseDepthSource`; `bathymetryState` + `fileBathymetrySurvey` | The Water tab | 🟡 server: `hasBathymetry` only; the rest deferred (after #110) |
| BS12 | `listActions` filtered by action, indexed | Access's ruling history, the tabs' receipts | 🟡 server: the index and `bodyConsole.history`; `listActions` deferred |
| BS13 | Imagery: `imagery.setPassOverride` + `overridesForBody` | The Imagery tab's call on a pass | ⚪ deferred (after #110) |
| BS14 | Standing: `standing.retentionForBody` | The Standing tab's lane timeline | 🟢 server |
| BS15 | Hazards: `hazards.dailyOnLakeForBody`; the watch's opening date | The Hazards tab's winters and day strips | 🟢 server |
| BS16 | `bodyFeatures.updateShape` | Editing a known feature's footprint | ⚪ deferred (after #110) |
| BS17 | A compare-and-set on the whole-list writers (`waterBodies.setReferenceLinks`, `landmarks.update`'s `aliases`): the list or version the write was built on, refused when it moved | Two moderators editing one body's links or spellings at once: today the later write silently drops the earlier | ⚪ owed |
| BS18 | `bodyConsole.dailyHazards` counts a reported crossing (`ridge_crossing`) as a hazard on the lake, every day from its first report through today (its 72-hour expiry is applied at read, never stored), with a first-report mark, and returns no type to tell it apart: leave passage markers out, or return the type | The day strips and their counts | ⚪ owed |
| BS19 | `recurrence.listForBodyAdmin` stops at 1,000 clusters and says nothing: a `more` | Hazards' *patterns waiting* count, today drawn as whole | ⚪ owed |
| BS20 | `putIns.promote({ putInId, name?, reason? })`, `body.access`: makes the selected visible `osm` or `derived` row `official` **in place** — its id, point, bay, `parkingAreaId`, `approachMeters`, `approachRouted`, `approachAscentM`, `approachPath` and `approachKindOverride` kept; the name set only when given; a `set_put_in` audit row with `metadata.prev` (source, name), `accessKind` recomputed, the standing rule `setOfficial` applies (an official put-in brings a dormant body back) kept. Undo puts the source and name back, leaving the row and its walk. `setOfficial` stays for placing a new point. | Access's *Make official*, drawn *Not available yet* until then | ⚪ owed |

### The Bodies reads the pages asked for (B01-3c, the second server follow-up)

The reads the list and the Body console's tab PRs asked for, and four carried items. The writes —
aliases and class, depth source and survey filing, the imagery override, a feature's shape — are
their own PR (they would have taken this one past its size, and two need a call; see *Owed*).

- **A search across standings** (`bodies.searchOtherStandings`, the list's arguments): beside a
  lane's search, each other standing's matches counted to 50 (`capped` past it) with the best five
  rows. None for no search, *All* or *Changed*. One search read per lane, ranked by the match.
  **The lane's facets are not applied** (`facetsIgnored` says when set): a search considers only its
  top results, so a facet filtered over them would count a partial set as whole.
- **Rows by id** (`bodies.rowsByIds`, *Opened recently*): up to 12 ids, trimmed and de-duplicated in
  order, each with what became of it — `ok`, `merged` (the survivor's row), `unlisted`, `unknown` —
  and how many were dropped. A row is one indexed read; only an id with no row reads its body.
- **A removed or rejected body's facts** (`bodyConsole.removedFacts`, `body.read`): stored name,
  class, states and area, standing, when it left, why and who decided (the row its standing names:
  the newest `remove` for a removed body, the newest `reject_waterbody` for a rejected one), towns,
  and a report count floor (200).
- **The preview's asks** gain `askers` (distinct people with the same question open, to 50 — the
  asks one decision closes, `openSiblings`' rule: for a bay the same name key, for a landmark the
  same place, as the inbox counts them) and the body's `intake` reasons, worst first, each with what
  is stored beside it (a duplicate's candidate count, a conflict's corroboration level).
- **Towns with their state**: the facts store each town's state and boundary (`townStates`,
  `townIds`); the preview gains `townState` and `moreTownsWithState`, the frame and Places
  `townsWithState`. **The recompute:** a row computed before is *behind* for the drift repair, so it
  fills in incrementally over the two-week sweep with no step; or at once with `bodyGeo:seedAll`
  then `bodyGeo:computeAll` — **47 minutes measured** on dev (24,953 bodies, B01-3b's run).
- **Completeness on the frame** (`consoleExtras.complete`, the library row's), so the frame stops
  calling `bodies.preview` and its 1,000-report scan for one field.
- **The bathymetry search record**: the coverage run records each contour dataset it searched and
  its states (`importContourCoverage`'s `searched`, the loader's `--searched=NAME:VT,NH`, sent with
  the run's last batch so a run that dies records no search), one row per (dataset, state); `consoleExtras.bathymetrySearched` is the newest search of the body's states,
  `null` (*not recorded*) where none covers it.
- **Town lines** (`bodyConsole.townLines`): each boundary's largest outer ring kept to 96 points (97
  positions: a ring closes on its first point, as GeoJSON's must) is
  stored beside it at its import (`adminAreaOutlines`; `adminAreas:backfillOutlines` for the rows
  before); a body's town lines are one small row per town, at most 24.
- **Only a geometry change marks a body** (the coordinator's ruling): the cell index marks a body
  with no facts row (a new body) and nothing else; the import marks by the outline stamp (every
  coordinate); a merge, a deletion and a boundary change mark as before. A rollover sends no
  unchanged body back (tested). The guard now requires a mark in the block of any patch naming a
  polygon *or* a box.
- **The audit feed's labels, one read per distinct target** (`auditTargetLabels`) and actors once
  per person: a full page of 100 makes at most 100 label reads (tested at the limit with a counting
  ctx; it was a read per row, 315 ms on dev). `systemFeed` builds its labels from its own rows; the
  People history should use `auditTargetLabels`.
- **The geometry walks survive a bad row**: a drift check that throws is recorded (`geoDrift`), its
  body marked for recompute and its row moved to the back; a missing-row probe that throws is
  recorded (`geoMissing`) and passed. Each clears when its item next goes through, and a body gone
  takes all three with its facts (no walk visits it again). The computation's attempt state is
  mirrored into `jobFailures` (`bodyGeo`), so `recurringJobs.health` counts geometry failures from
  small rows.
- **Exactly at the cap** (a quick audit): accounts total, the gate scatter, the contributor trend, a
  body's recurrence denominators and a bay's mouth line read one past their caps now. Loops that
  only decide whether to run another pass (`=== PAGE`, then continue) are left: an extra empty pass,
  never a wrong count.

**Owed — the writes PR:** `setAliases` (`moderatorAliases`, folded into the library row) and
`setClass`; `chooseDepthSource` with every source's candidate kept, and `fileBathymetrySurvey`; the
imagery pass override and its read; `bodyFeatures.updateShape`. Two need a call first: per-catalog
class claims exist only at import time (the import must start storing them, and old bodies read
*not recorded* until the next campaign), and what a survey filing records.

### The Bodies writes (B01-3d, the third server follow-up)

Built on B01-3c's reads; opened after #122 merges. Each write takes a capability from the map, writes
an audit row with its verb (the script's `via` rides through `writeAudit` as on every row), has an
undo-policy row and a handler whose undo is the forward write of the previous state (refused by the
same function), refreshes the library row through its audit row, refuses a merged-away body and
leaves a removed one editable.

- **Aliases** (`waterBodies.setAliases`, `body.identity`): `moderatorAliases`, trimmed, collapsed,
  de-duplicated case-insensitively against the display name and each other, refused past 20 or past
  120 characters; folded into the library row's aliases and search text (`aliasesOf`).
- **Class** (`waterBodies.setClass`, `body.identity`): `moderatorClass` is its own fact; `type`
  follows it and a re-import keeps it; clearing puts back `baseClass` — the import's own ranking,
  kept on every touch even under the override (never the first claim: the merge ranks classes by its
  own order, so the first claim is often not the class it stored); on a body no import touched, the
  class the first override displaced. **The import now stores each
  catalog's class claim** (`classClaims`, one per source, at most eight; the ETL carries them through).
  Every body on dev — all 24,961 — predates it and reads *not recorded* for the per-catalog lines
  until its next campaign: the merge threw the claims away, so no backfill can recover them.
  `bodyConsole.identity` serves the claims (or `null`), the moderator's class and aliases.
- **Depth source** (`waterBodies.chooseDepthSource`, `body.water`): the ladder now keeps every
  plausible offer as a candidate (`depthCandidates`); a candidate alone is stored but is not a changed
  depth, so a load's counts and the library refresh are as before (tested). A choice holds its
  source against better rungs and follows that source's fresh value; `null` hands the measure back
  to the ladder (the best-ranked candidate the pair allows — the best-ranked alone may be the one the
  ladder dropped for inverting it). Refused: a source with no value, a typed (operator) depth, a
  mean left deeper than the max. `bodyConsole.depthChoices` lists what `chooseDepthSource` accepts
  (`depthChoicesOf`).
  **What it can affect:** the depth every read shows, the shallow classification and the decay model
  that read a body's depth. A depth is the basin's; choosing one says nothing about ice.
- **A known feature's shape** (`bodyFeatures.updateShape`, `corpus.preIce`, as creating one is): the
  hazards' shape gate and its 500-position ceiling, a footprint on its lake's box. It changes the
  feature's geometry, box and bay stamp — never the body's outline, its geometry facts or a library
  fact (tested). The replaced shape is the audit row's snapshot.
- **The imagery pass override** (`imageryOverrides.set` / `.clear`, `machinery.imagery` — the board's
  *admin's override*): show a pass the gates hid (no reason, who and when recorded) or hide a shown
  one (a reason, at most 500 characters); at most 200 calls per body and season, bound at the write
  so the skater read is whole. `passOverrides` (public, granule and call only) and `forBody` (who,
  when, reason; newest first). `@skating/core`'s `buildBodyTimeline` honors an `overrides` map — a
  shown cloudy pass lends no lake to a seam, a hide is counted only where the pass would have been a
  stop; with
  none — the default, and what the apps pass today — the timeline is unchanged (tested). An override
  is a statement about one pass of a satellite, never about the lake. **Owed:** the apps'
  `useFreezeUpTimeline` passing `passOverrides` (web and mobile).
- **Towns keyed on name and state** (the coordinator's ruling on #122): the facts store
  `townEntries`; every read that offers a town's state reads them, so a border lake's Franklin, VT and
  Franklin, NH are two. `towns` stays keyed on the name for the pages that read it.
- **`rowsByIds` on merged ids (the read table):** worst case 12 merged ids, each reading its own body
  document and up to eight merge hops, each a whole body with its outline — accepted for 12.

**BS17–BS19 (the Body console pages' findings), checked against the code:**

- **BS17, a whole-list write overwrote a concurrent one.** Confirmed for the two the page named
  (`setReferenceLinks`, `landmarks.update`'s aliases) and found in three more: `setAliases`,
  `setWeatherSamplePoints`, `subAreas.rename`'s aliases. Each takes an optional `expected`
  (`expectedAliases` on the landmark and bay writes); a list that moved is refused with
  `{ code: 'list_changed', message, current }` in the error's data. Without it, the later write wins as
  before. The undo of a links or aliases write passes the list its row wrote. Left: single values (the
  later legitimately wins), writes that name what to act on (`clearDepthOverride`,
  `dismissDuplicates`), creation, and a lot's or a rule's record (`setOfficialParking`,
  `setPostedAccess` — owed if the Access tab saves them whole).
- **BS18, a reported crossing on the day strip.** Confirmed; one correction: a crossing expires 72
  hours after its **last confirmation**, not its first report (`isPassageExpired`). A crossing is a
  passage marker (D64), not a hazard: it leaves the day's hazard count and unknowns, and
  `days[].crossings` counts the crossings live that day (to expiry or recorded leaving, never past the
  caller's day). Each `hazards[]` entry carries `type` and `passage`.
- **BS19, patterns waiting.** Confirmed, and worse than logged: `listForBodyAdmin` also sorts by
  priority *after* its cap, so a body past 1,000 clusters can drop its highest-priority ones.
  `recurrence.waitingCountForBody` → `{ count, capped }` counts by the tab's rule (`isWaitingPattern`)
  over one read one past the bound; the list's array shape is left for the page that reads it.

**A launch made official in place** (`putIns.promote`, `body.access`; found by the Access tab, whose
*Make official* called `setOfficial`, which always inserts a new point). Checked: `setOfficial` snaps
to the shore, stamps the bay, writes `set_put_in` and recomputes access; `accessForBody` lists stored
visible rows with no proximity merge (so the tab drew both), while the map's marker read lets an
official marker win over others within the hide radius. `promote({ putInId, name?, reason? })` makes a
stored `osm` or persisted `derived` launch official on the same row — point, bay, lot, walk and
approach-kind override kept, the name set only when given — and returns `{ putInId, actionId,
undoNeedsReason }`. A live report cluster has no row and never appears in the tab's list; making one
official is `setOfficial` at its coordinate. Refused: official, hidden, suppressed, a merged-away
body, missing. The undo puts the source and name back (asking a reason: it takes official status
away) and is refused once the launch moved, was renamed, hidden or demoted; its undo promotes again.
`setOfficial` shares the after-write steps (`afterPutInChange`: the body back if shelved, access kind,
library row). The old lake editor places a clicked point with `setOfficial` — a moderator who clicks on
an existing launch there gets a second row too (the map hides the first; the console lists both); the
phone app has no caller.

**The sweep before re-review (B01-3f): an undo or redo over a row something un-audited changed.** An
undo was offered whenever its row was the newest on its target; a few verbs' refusals depend on the
row as it stands, which an import, a loader run, a merge's moves or a hide on another target change
without a row on that target. Each undo in B01-3d was run as write → un-audited change → undo → redo
(a table in `bodyWrites.test.ts`, every case also run without the change):

- **Restored stale values — fixed:** `edit_landmark`. A merge's fold and a catalog run change a
  landmark's spellings with no row on it, and the undo put the old list back over them. The edit now
  records the spellings it left (`aliases`) and its undo passes them as `expectedAliases`; a row from
  before carries none and undoes as it did. (The handler predates B01-3d; the compare-and-set came
  with it.) A bay rename's undo passes the aliases its row wrote too — no un-audited writer moves
  them today.
- **Offered, then refused — fixed:** `choose_depth_source` redone after a loader run took its source
  away; `update_body_feature_shape` after the outline moved off the shape it puts back;
  `set_put_in` after the launch was hidden (audited on the put-in) or moved or renamed by an import;
  `set_weather_sample_points` after the outline moved off the grid it puts back.
- **Held:** `set_class` after a re-import (the undo puts back the newer catalog class, never the
  recorded one); `set_aliases` and `set_reference_links` (every writer of the lists is audited on the
  body, and a merge's row overtakes); `choose_depth_source` undone after a loader refresh (hands back
  to the fresh value); `set_imagery_override` after its pass was recut or pruned (keyed by the pass,
  read from nothing of it); a feature after a merge (it moves to the survivor and undoes there). Rows
  written before B01-3d (no claims, no candidates, `undefined` lists, a feature with no bay) held
  for every write.

`UndoHandler.refusal` is the fix: an async check `undoState` asks last (after capability and an
operator leaving), running the same function the write refuses by — `depthChoiceOutcome`,
`shapeRefusal`, `launchRefusal` and `directionRefusal`, `samplePointsRefusal`, `listChangedRefusal`.
Its row reads (`lib/undoReads`) are charged at their real weight to the request's budget, one after
another, read once per query; past it the line reads *unavailable* — "This page has too much to check
this undo here — open what it changed to undo it." — never a read past the limit. A refusal's
snapshot read and a launch's hidden-neighbor read (at most 200, a handful in practice) went
uncharged at first; since B01-3h (#131) they go through the share `undoStates` reserves for the row,
so People's per-row plan (`ROW_SHAPE_DOCS`) counts none of a refusal's reads — a row with no room
for its share says "check elsewhere". **Owed:** the landmark undo's refusal checks the spellings
only on a page, not the duplicate and bay-name rules its write also takes.

**A page of History in a handful of rounds (B01-3i).** After #127 deployed, one busy body's first
page of History took 803 and 710 ms uncached on dev. Counted structurally (a round: a database call
started with none in flight) on a 50-row page: 203 sequential rounds before #126 and after it, 249
after #127 — `bodyConsole.history` awaited every read row by row, and #127 added the refusal reads.
Now 6 for a page whose rows share a target, 20 for the worst page (45 refusals), 18 for a 50-row feed
over 50 targets. The rule: a page's undo states are one reading (`undoStates`) — every row at once up
to its refusal, then the refusals **in page order** through `ReadBudget.waves`, each reserving its
declared worst case before it reads and handing back the difference after, so the accounting is exact
and the answer the same whatever order reads settle in. Reserve, never queue.

**B01-3h: aliases in skater search, the text caps, and the gaps #127 left.**

- **One rule for every search.** `@skating/core`'s `bodyAliasesFor` — the catalogs' other names, then
  a moderator's aliases, each once — builds `waterBodies.searchText` (`bodySearchTextFor`), the
  console's library aliases, and a search hit's `aliases`. Every skater search (the map box, Explore,
  the sheet's "Which lake?", web and phone) reads `searchByName`, which now finds a body by a
  moderator's alias and says which other name matched (`matchedAlias`, additive — how a result shows
  it is B04's). A merged-away duplicate's names find its survivor (at most eight survivor reads a
  search); a removed or rejected body is found by no name. Every writer of an ingredient rebuilds the
  text through the builder (`searchTextWriters.test.ts` inventories them: the import, a drawn body,
  `setAliases` and its undo, the name override and its undo, an admitted catalog body, the repair
  pass, and — since B01-3g — a merge, which carries a loser's aliases to its survivor); a merge moves
  no catalog names, a removal leaves them. No backfill: with no moderator aliases the
  rule gives today's string, and dev carries none. The repair pass (`backfillSearchText`) reads the
  builder; dry by default, one page a call or `chain`, each stale body its own nested write.
  The search read, measured worst case (a full page of heavy outlines, every alias at its bound, half
  the hits merged): 164,648 bytes before, 255,522 after — the same page, plus the survivors and the
  alias text. An alias is a name a skater might type, never a claim about the ice.
- **The text caps** (`@skating/core`'s `textCaps`): a place's name and each alias at 200 characters,
  a URL at 2,048, a catalog's machine id at 128 (every format ingested is under 40), a landmark's ids
  at 32, a launch's walk at 256 points (thinned, its ends kept). A moderator's write past a cap is
  refused with a plain message; an import skips the row and counts it (`tooLong`), never the campaign.
  Stricter caps stand: a landmark's name at 80, a launch's at 60, a request's at 80, a link's label at
  80, a moderator's alias at 120. The apps' `maxLength`s match the request and landmark caps; the
  console's name and link inputs set none yet (owed with their pages). A cap holds what a
  write introduces: a stored value past it keeps working, and an undo putting one back runs. Audit
  metadata from these writers is at most 160 KiB (fast-checked; the reference links' eight labels and
  URLs, before and after, are the largest). **Owed:** counting the rows written before the caps that
  exceed one (the dev agent's read); a read charges such a row its real size and carries on.
- **The gaps #127 left.** The weather-grid and feature-shape snapshots are charged through the row's
  share (each one document, bounded by its writer). A launch row is bounded at its writers
  (`ROW_MAX.launch`, 12 KiB: 8,852 bytes measured at the caps), so the put-in refusal reserves the
  launch and the body's hidden launches (200 × 12 KiB) and hands back the difference; a page that
  can't reserve them answers "check elsewhere". **A deliberate exception, on cost:** the landmark
  undo's duplicate-name and bay-name rule (`landmarkEditRefusal`, shared with the edit) runs where one
  landmark is in view — the toast, one landmark's own history, `runUndo` — and a list page checks the
  spellings only, because that rule reads the body's whole landmark list (up to 1,500 rows) and its
  bays' outlines, about 3.5–4 MiB at worst against a page's 4 MiB. Where it bites, it says so: `runUndo` answers
  "…, so this undo can't bring the old name back — a list of changes can't check that in advance.",
  and the single views say the first half before it is offered. Those
  list reads are uncharged in the one-landmark views (the forward write reads the same lists under the
  mutation's own limits). **Owed:** a stored light list of a body's bay and landmark names, kept by
  every writer of either, would let a page check it — a derived fact, not this PR's. A landmark's
  `externalIds` and a launch's id are now capped; what stays uncapped after this PR is a bay's outline
  and a landmark's corpus fields. People's per-row read plan needn't count the refusal reads: they
  reserve through `ReadBudget.waves` on the same budget, and a page past it reads "check elsewhere".


**Held — the survey filing** (`fileBathymetrySurvey`): the board shows the field (*A survey the next
build should load*, *Paste a link or a citation*) but not what appears once one is filed; it waits on
the founder's call.

### The region rule (B01-3g, D266)

**Why.** Seven dormant bodies had no town. All seven lay outside the five states, and the catalog had
stamped them with a state anyway: `importCanonical` filled any record without `states` from the
loader's `--state` tag. The facts' towns came from 13 sampled points (the interior point and twelve
shore vertices), so a big lake listed a fraction of its towns and called the list complete (Lake
Champlain: 13 of 40), and a shore point a few meters across a state line placed a Connecticut pond in
Massachusetts. Membership, towns, counties and states now come from one rule and one function.

**The rule (the founder's, 2026-11-15).** A body is in a town when at least `REGION_SHORE_M` (25 m)
of its shoreline lies inside that town — every ring, islands included, clipped exactly against the
town's polygon and measured in meters on the ground. The test is access from the land, not where the
water is: 25 m is enough shore for a put-in. Open water alone lists no town (a TIGER "not defined"
water unit holding none of the shore is not one the body is in; one that holds 25 m counts for its
county and state, and is never listed as a town). A stretch within 1 cm of a town's edge lies on it
and counts for both sides. When no town holds 25 m: if 25 m or more of the shore lies outside every
loaded town the body is **out of region**; otherwise (a short shore, or one split among towns in short
pieces) it is in the town holding the most of it, so a body inside the towns is never in none. In
region means in at least one loaded town; states follow from the towns, counties from each town's
GEOID (`tiger/SSCCCsssss`: its first five digits are its county's).

**One function, two readers.** `@skating/core`'s `createReach` (`regionReach.ts`) is the rule: exact
along every edge (a line meets the 1 cm capsule around each town edge in one closed-form interval; what
is left of the edge is wholly in or out, settled by one point-in-polygon test; each segment's ground
length comes from its own endpoints at its own mid-latitude, so nothing depends on vertex order, a
ring's start or its closing vertex — Greptile on #130 found the frame once did), pageable (towns are
added a page at a time, order-free), with a brute-force reference and fast-check properties under
pinned seeds plus one random run (monotone in the constant; invariant to vertex order and ring start;
equal to the reference; split by a line lists both; on a line lists both; short shores go to the most;
inside the towns is never none). Its readers:

| Reader | Layer | What it decides |
|---|---|---|
| The merge's `statesFor` (`scripts/etl`) | The rows `scripts/admin-areas` loads into `adminAreas` (`.raw/areas-*.ndjson`), read directly | A record's `states`, measured on the outline the import stores (the one the facts read); `[]` is out of region, always emitted |
| The geometry facts (`bodyGeo`) | `adminAreas` towns, paged by cell | A body's towns, counties, states (`placesRule: 2`) |

**The import.** `importCanonical` has no `state` argument any more (the exact validator refuses the
old tag), and the loader refuses `--state=`. A record without `states` throws before any write (the
producer ran without boundaries, which must never read as a corpus out of region); the loader refuses
such a file up front; the merge's `townLayerOf` throws on a missing, empty or short town layer. An
empty `states` is out of region: a new body is not inserted, and a stored body is patched but keeps
its states — no import relabels a body off the map — and both are counted and named (`outOfRegion`,
`outOfRegionKept`, `outsideRegion`, on the run row as itemized failures).

**Limits (the geometry facts).** Candidates come from `adminAreaCells` over the body's box padded by
0.0005°, at most 2,000 cell reads a query (`CANDIDATE_CELL_READS`), paged by a `{ z, i }` cursor that
must move on (else the body fails); a cell holding more than 64 town rows throws. Towns are read 11 to
a query (`TOWN_PAGE`: a polygon is uncapped, so each is charged at 1 MiB against the 12 MiB budget;
dev's largest is 98 KB) and counties 11 to a query. The action never holds more than one page of town
polygons. The worst body is Lake Champlain: 75 candidate towns, seven town pages; the rule took 28 ms
for it offline, and the whole dev corpus (24,953 bodies) 8.6 s. The chain keeps its run, attempt and
parking pattern unchanged. Tested on a 14,151-vertex outline over 81 towns.

**Honest states.** A facts row without `placesRule: 2` holds the sampled answer from before, and no
read shows it: places, town lines, the preview's town and the frame's towns read *not computed yet*,
the touching bodies still show. The drift repair marks such a row; a parked body keeps reading *not
computed yet* until its recompute goes through. The interior point no longer marks a body stale.

**What changed, measured on dev data offline** (the rule over every body against the loaded towns,
compared with the sampled rule's answer):

| The 20 largest bodies | Listed (stored, sampled) | Touched (vertex measure, Part C) | Under the rule |
|---|---|---|---|
| Sum | 95 | 155 | 155 |
| Lake Champlain | 13 | 40 | 40 |
| Seneca / Cayuga | 10 / 10 | 16 / 15 | 16 / 15 |

(The earlier report's 85 and 145 were each 10 short; every per-body figure stands.) Every one of the
20 lists exactly the towns it touches. Corpus-wide: **248** bodies change their town list, **647**
their counties (a border lake now names every county its towns lie in, not the interior point's),
**12** their states, and **8** are out of region. The full recompute's live cost is owed (measured
after merge).

**A shore along a line is the rule's own uncertainty.** The stored boundaries are good to ~5–7 m, so
a shore that follows a town or state line can count for one side, both or neither depending on a few
meters. Two of the seven are the worked examples: a quarry pond on the PA/NY line near Chemung holds
0 m of shore in New York by the stored layer and 247.6 m by raw TIGER (that shore lies within 3.4 m of
the raw line, 4.2 m of ours), and a 1,965-acre Quebec body holds 0 m by the stored layer and 546.1 m by
raw TIGER (within 0.2 m of the raw line). Two kept bodies sit just under the constant (24.2 m and
22.8 m). The constant is the founder's and is not tuned to these.

**Readers of the towns.** Console only: the preview's place line and its "+N" (the tooltip now names
a dozen and counts the rest), the frame's towns, Names (every county, labeled *Counties* when more than
one), Places, and town lines (cap raised from 24 to 48: Champlain is 40). The skater apps read only
`waterBodies.states` (the import's) — the search sub-lines, the lake kicker, the region filters; no
skater screen lists towns, and body search is by name only, so no skater wording changes until a
body's states change at its next campaign. The phone picker's empty state says "Try another spelling,
or the lake's town" though search does not match towns (owed, below).

**A removal can say why.** `waterBodies.remove` takes an optional note: trimmed, refused past
the audit-reason cap (D261: 2,000, `AUDIT_REASON_MAX`, its own sentence), written into the audit
reason beside the fixed one (composed, so a note at the cap shortens the line rather than failing it)
and kept whole in its metadata, returned by `bodyConsole.removedFacts` (`left.note`). No note is
exactly the old removal; the undo is unchanged.

**A moderator's pin outranks the rule.** `waterBodies.moderatorTownKeys` — stable `tiger/<GEOID>`
keys (a boundary reload keeps the document, and a key survives even a delete and reload), at most 8 —
holds a body in region in the towns named. `setModeratorTowns` is a whole-list write (`expected`,
`list_changed`), audited (`set_moderator_towns`) and undone through the same write. **A write that
removes any pin is a takeaway** and refuses without a nonblank reason ("A reason is required", as
every reason-required write says); a write that only adds takes an optional reason, defaulted ("Pinned
in N towns") and marked `reasonDefaulted` in the audit row. The person's reason is trimmed and
refused past the audit-reason cap (D261, `AUDIT_REASON_MAX`; #130's interim 1,000-character cap is
gone, one cap for every audit reason) — early in the mutation, and again by `writeAudit`, which
holds the same plain string to the same cap; an undo's own reason quotes the row's but never trips
it, since `runUndo` fits the line it composes to the cap. Its undo follows the same rule on the list
it puts back (one rule, the undo policy's `{ from, to }`): undoing an add removes pins and asks a
reason; undoing a removal only adds and asks none. The undo is refused, so never offered, when a
merge moved the list since its row. A body's states are built from two ingredients kept apart —
the rule's (`regionStates`) and the pinned towns' — by one builder (`regionStatesFields`), which
the pin's write, its undo, a merge and the import all patch through, so skater search, the library
and the console read a pin's state in the write's own transaction, and clearing a pin removes exactly
the state it added (Greptile on #130). The facts keep the pinned towns apart too (`pinnedTowns`,
rebuilt in the same transaction as every pin write and by each recompute) and the readers merge them
in, so no reader shows the pins as they were; a key whose town is gone is kept in `pinnedMissing`. The
import adds pinned states and never reads a pinned body as out of region (`keptByPin`). A merge folds
the loser's pins into the survivor and records both in its change set; a removal leaves them.
**Nothing a moderator set is dropped by a merge** (Greptile on #130): the survivor takes the union of
both bodies' pins, aliases and reference links (`mergedModeratorLists`) — the aliases with the
survivor's search text, rebuilt in the same patch (`bodySearchTextFor`) — and a union past a cap is a
refusal in a sentence (which list, how many, the cap, clear some first) — never a truncation. The
duplicate card never offers that merge and shows the sentence; the import's automated merge skips
the pair, names it and flags it into the duplicate queue on an applied run. Its dry run predicts
the apply exactly whatever the batch boundaries (Greptile on #130): each call returns `taken`, every
survivor's lists as they stand by now in this pass, merged under its own name as the merge merges
them, and the script feeds it to the next batch — chosen over keeping a survivor's pairs in one batch
because it holds for any batch size, order and chained absorption. A survivor the pass retired earlier
is skipped as merged in the dry run too, as the apply skips its tombstone. Weather sample points are not carried: each lies on its own body's outline.
The merge's change set keeps both bodies' lists as they were, for the unmerge (not built yet). A
guard reads the functions' source: nothing else writes the pins.

**The founder's determinations (2026-11-15), by hand, after the PR deploys.** Of the seven: keep the
Sterling Forest body (Warwick, NY; inside the state park), remove the other six with notes. Of the
twelve further out-of-state bodies: keep four (the Amity ME land-trust preserve, the Hodgdon ME public
reserved land, South Pond by Taconic State Park, Hatchet Pond by the Southbridge town reserve) and pin
South Pond (North East, NY) and Hatchet Pond (Southbridge, MA), which sit under 25 m; remove eight
with notes. Every removal runs as the founder through the run-as marker, reason `other`.

**Owed.**
- The console control for a pin (the server write and its reads are built; no page sets one).
- Better ownership and public-land data — a parcel or protected-area layer — so a call like these
  nineteen is made from data rather than by hand (OSM's land-use and protected-area polygons were
  the only evidence; no state parcel layer was queryable).
- The boundary-following shore caveat above stands documented; nothing in the rule resolves it.
- The full recompute's measured cost on dev, after merge.
- The phone picker's "or the lake's town" hint, which search does not honor.
- `waterBodies.remove` adopts the tagged-reason type when #125 lands.

### The People pages (B01-4, the page)

People at `/admin/people` (boards 8.1, 8.2, 8.5, 8.6) on the People server's reads above, in one PR after
that server's (#115); the rail's People mode (G then P, `people.read`) lights for the list and every person.

- **One page, three columns.** `/admin/people` is a layout: the lanes, the list, and the person
  route's page (`/admin/people/$id`) drawn in the third column through the outlet, so the list stays
  put while people open and close. The lane and the search ride in the URL both ways (opening a
  person carries them; the person's way back returns to them); a deep link opens the list beside the
  person on the lane it names, Everyone when none, and an id of the wrong shape or with no account
  is *No such person* with the list still usable. Esc or ⇧⏎ in the person's page puts focus back on
  the list, on the person's row.
- **The list.** A search lane over every account (`/` focuses it; the server ignores the lane while
  a search runs and the match is marked), then the server's lanes, Appeals open only for a viewer
  with support's read. `people.listPage` is read as a chain of cursor pages through the console's
  one read layer — it isn't Convex's paginated contract, and each page's `partial`, `reasons` and
  `pending` must survive. Rows in the server's order: the status chip first, the trust class, the
  person lockup (the handle is text inside a clickable row, never a nested control), the sub-line,
  the reason on file, and an age the lane defines (since the status, since the restriction, the
  time left in the window, otherwise since joining). Typing pending in the search is dropped on
  every change of place (another lane, a person opened, leaving).
- **The person page** renders `people.person` and its five companions; every lever is drawn from
  `can` exactly as the write would answer it, and every write goes through one action hook to the
  shell's undo toast. The toast skips its `undo.latestOwn` lookup only when a write returns both
  its audit row and whether undoing it asks a reason (`{ actionId, undoNeedsReason }`, asked of the
  server follow-up); with either missing it looks, which is also how it learns that another staffer
  acted in between (then no Undo).
- **The three answers, every block.** *Still being prepared* while a People backfill hasn't finished
  (no number, no "+": a lane draws no count, the lanes' foot names which, the head shows only the
  order, a note over the rows says the list may not have everyone, the list never ends on "All";
  the Overview's People card hides its figures while the rows are pending, and only *Flagged
  people* while only the flag subjects are); a floor while a read stopped at its cap ("200+", and
  why in a sentence per reason; a list short of its lane ends on "N shown"); *Not recorded yet* for
  `null`. Empty lanes say so in plain words; a failed read says so in its own place with *Try
  again* (a later page failing keeps the rows already in); a moderator's view simply lacks Appeals
  open and every support fact.
- **One of each.** `lib/ages` holds the row's short age (`shortAge`) and the written-out pair
  (`ageInWords`, `timeLeftInWords`) for the Overview, Metrics, the list and the person page;
  `people/answers.ts` words the three answers once; `people/clock.ts` holds the read clock both
  pages use; `lib/routerTarget` splits a path for the router. The old `/admin/users` and
  `/admin/users/$id` redirect; Users leaves Legacy and the old shell; a profile's moderator tools,
  the palette and the Overview link to People.

**Where the boards and the code differ** (the code stands until the founder rules):
- The list column is the `list` token (340), not the board's 380; the kicker's orders were
  shortened to fit it (*by end date* for *soonest to lapse first*, *latest first*), and a very long
  count wraps to a second line inside the head's height rather than being cut.
- A row says "4 d"; a head, a note or a status line writes its units out ("1 day left").
- The Staff lane draws no age and no "since … · N decisions this week" — no read gives either yet;
  Flagged and Appeals open age from joining until the server gives each person's oldest open flag
  or ticket.
- The staff page has no *Switch off* on flagging: the server refuses switching it off on staff.
- Receipts carry no pronouns (none is known); *Staff since* reads "Admin since …" as the value.
- No photos on the person page; no *Restore all*; the *On the record* row (the founder's name for it:
  the sheet covers hidden, removed, retracted and author-deleted items) is drawn with no sheet yet.
- *Make admin* in the role menu confirms first.
- A narrow screen (a phone): the open person takes the page with *Back to the list*; with no one
  open, the lanes over the list. The person page's strips wrap two to a row below an inspector and
  a search's width, and the head's chips wrap under the name.
- A block is left out only for a complete, genuinely empty answer (`settledEmpty`): *Open about this
  person* stays, saying so, when its read was capped or flags are still being prepared; *On the
  record* stays for a capped standing count.
- One heading outline for the joined page: the lane's word is the only `h1`, the person's name an
  `h2` in the board's look, its blocks `h3` (or `h2` when no name is drawn).
- A capped count is plural ("1+ open flags"); Metrics' *Oldest* keeps a tenth under two days
  ("1.5 d"), as every row does now that one formatter answers both.
- A suspension that ends while the list is open reads *Ran its course … · lifting on its own* (the
  person page's words) on the live minute; the list's reads stay held.

**Words the boards did not supply** are each in one module for the founder to read together: the
list's in `apps/web/src/components/admin/people/list/peopleWords.ts`, the person page's in
`…/people/person/personWords.ts`, the three answers in `…/people/answers.ts`.

**Kit.** Both pages draw the kit's `PersonLockup`, extended here: a person list's `row` and the
page `head` sizes, a heading name (`nameAs`), the search mark, a photo, and analytics masking on
every size (its `sm` and `md` draw as before). The *On the record* row's *Review* is the kit's
`UnavailableButton` (its sheet isn't built); refused levers keep the lever row's own refusal
tooltip, the server's no with its reason. Nothing on the person page is an unbuilt field, so the
kit's `UnavailableField` has no use here. Candidates still beside their pages: `SearchLane`
(`list/kit-candidates/`) and `LeverRow` (`person/kit-candidates/`). Two other kit changes: a lane
count's amber or red survives selection (`Lanes`, board 8.1), and `ListEnd` draws no tab until its
measures are numbers (an unresolved stroke token drew NaN).
Token differences: the person page's lever key column (112 px) and feed tag column (76 px) have no
token; the head's name is the 15 px logo step (no name step); lever rows are 32 px where the board
draws 34; the role menu's item takes two lines.

**Owed:**
- A web pass on the server follow-up (B01-4b), which supplies what was owed to it here:
  `people.listPage` taking an `endCursor` (until the page passes it, a change in an earlier page
  drops the deeper pages while they re-read); staff rows' `lastSeenInConsoleAt`, `roleSince` and
  `decisionsThisWeek`; each Flagged and Appeals row's oldest open flag or ticket time; `{ actionId,
  undoNeedsReason }` from every People write; `ledger.since`; `rightsSince`; the bounty season line;
  explicit `can` entries for every lever; a profile-opens flag; flag target labels and appeal text;
  who undid a row — and the capped answers beside them the page doesn't draw yet
  (`decisions.capped`, `open.flagLabelsCapped`, `ledger.sinceCapped`, `rightsSinceCapped`, and a
  staff row's `staff.lastSeenCapped` and `staff.roleSinceCapped`), so a capped date there still reads
  as not recorded. The merge filled the fixtures with the new fields and made the list row's staff
  overlay take `null`; `lanesFor` now reads core's `peopleLanesFor`; the status note's who-and-when
  line tells a start past the read (`statusNote.atCapped`) from one not recorded.
- The record sheet (boards 8.7–8.9) is not built on the web. Its server is (*B01-4d*, above): the
  *On the record* row should appear whenever any of the three lists has items, is capped, or is still
  being prepared — `people.person.hidden` for Standing, `contentRecord.recordCounts` for the other two.
- The kit promotions (`SearchLane`, `LeverRow`) await a kit pass.
- One `useClockFor` and one `ID_SHAPE` across Bodies and People — each duplicated in the Bodies
  directory, which the open Body console PRs are changing.
- **One rule for a list that pages as it scrolls** (`lib/loadAhead`): it asks for its next page
  only while it is in sight and measured — never from a zero-height viewport (a hidden pane, a
  section not shown, a list not yet laid out) or a background tab, which would read as "near the
  end" for every page — and asks again when it comes into sight. People's list reads it (the only
  People list that pages on scroll: History is one read, Decisions pages on a press). The Bodies
  library on main has the same trigger without the rule; it hides no list today, so it pages only
  in a background tab, and it adopts the rule with the narrow-screen one.
- **The console's one narrow-screen rule** (`shell/columnsFit`): below the width where a mode's
  columns fit side by side (their size tokens summed), the open record takes the page with a way
  back, and with none open the list does; nothing scrolls sideways. People has it; the Bodies
  library and the Body console lay out their own columns and break the same way at phone width —
  each adopts the rule once its open PRs land. The kit `AppShell`'s own stacking (below `lg`, for
  pages that pass it panes) measures the same way and should read the same rule.

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
