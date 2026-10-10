# Phase A06i — The season watch: an ice watch you can read, tune, and that starts the imagery itself

The daily season checker (A06e §3.3, D149; D161's gate for the weather sweep) opened winter-2026-27
on **3 October 2026** and emailed the staff *"Skating season winter-2026-27 has begun"*, which said
neither which sentinel had opened it nor what it had measured, told the operator to run a command it
didn't explain, and claimed a skating season nobody was skating. This phase makes the watch
something the founder can read, tune and learn from, and lets it run the season's satellite imagery
without a terminal.

## Kickoff pass — 2026-10-05/06 (founder calls + what the data said)

### What opened the season

The dev row: `opensOn 2026-10-03`, `openedBy ['sentinel']`, `sitesSampled 28`, `winterFrom null`,
detected 2026-10-04 20:46 UTC. Open-Meteo's observed lows for that night:

| Site | Elevation | Low, 3 Oct | Rule (≤ 0 °C) |
| --- | --- | --- | --- |
| Upper Lake of the Clouds | 1,531 m | −0.4 °C (31.3 °F) | fired |
| Eagle Lake (Lafayette) | 1,264 m | 0.0 °C (32.0 °F) | fired, on the line |
| Kinsman Pond | 1,134 m | 1.4 °C (34.5 °F) | — |
| 25 ordinary sites | — | none ≤ 0 (warmest-coldest 2.5 °C) | needs 10 % |

**The rule is one night at or below freezing at any one sentinel**, after 1 October. The forecast
showed why tightening it would barely move this year: the summit was forecast to −7.1 °C (19 °F) on
6 October, and the corpus 10 % signal alone fires ~10 October. The 2025-26 archive says the same of
last year: the summit crossed 0 °C on 1 October 2025 and −6.7 °C (20 °F) on 9 October. Only a
November floor or a cumulative measure would postpone a season meaningfully; Matt (an admin who
skates earlier than the founder) is being asked for thresholds. **The triggers are not changed by
this phase** — it builds the instrument to change them with.

### Founder calls

1. **Recipients** — `broadcastToStaff` mails every active moderator and admin, one message each. On
   dev that is two admins.
2. **"Ice watch", never "season"** (D212). The subjects become *Winter 2026-27: Ice Watch Has Begun*
   and so on; the body says daily monitoring has begun, not skating.
3. **Sentinels that fired are a table** of names and lows, only the ones that fired, °F first with °C
   in brackets.
4. **A second email at the first 20 °F night at a sentinel**, reminding the founder to start imagery
   if it hasn't been started. Sentinel, not ordinary lake (the founder overruled the recommendation).
5. **A third email when winter sets in region-wide**, with what was met and where.
6. **No two emails on one day.** If two are due, the second goes the next day.
7. **One sentinel roster for the cron and the CLI** — all three.
8. **Imagery runs itself once started** — an admin presses *Start imagery*, then it runs through the
   season; a whole season cuts for ~$1.50 of Fly compute (A06e), so the human-before-spend rule
   guarded almost nothing. **From Convex**, polling the satellite catalog every 6 hours (D214).
9. **The thresholds are editable on a Seasons page**, with a preview against past seasons; each
   season keeps the settings it was decided under (D213).
10. **Real-world dates per season** (first skated, last skated) are admin-entered, so a preview can
    say how many days before or after them a rule fired.
11. **The current season's watch can be reset** from the page, keeping the old record as superseded.
12. **Imagery failures and a hit cap email admins only**, outside the one-a-day rule.
13. **One PR** for everything.

### The archive is good enough to backtest on

Open-Meteo's ERA5 archive and its archived forecast both elevation-correct to the summit (1,533 m) and
agree within ~1–2 °C night to night at Upper Lake of the Clouds (Sept–Oct 2025), with no bias either
way. The live watch reads the forecast endpoint's `past_days` (D140); history is filled from the
archive. The page labels which is which.

## The build

### §1 — One rule, in core (`packages/core/src/seasonWatch.ts`)

`ingestWindow` gains `sentinelNights` (consecutive nights at one sentinel, default 1 — today's rule),
and returns *which* sentinels fired and their lows, and the corpus counts behind the open and the
winter dates. New beside it: `firstSentinelNightAtOrBelow` (the imagery nudge), `clipToFloor` (the
October floor, moved out of the cron so a backtest applies it too) and `evaluateSeason`, the one
function the cron and the page's preview both call. `SeasonWatchSettings` is the settings shape, with
`DEFAULT_SEASON_WATCH_SETTINGS` built from the existing constants so nothing moves until someone
edits it.

### §2 — Settings, versioned, in the database

`seasonWatchSettings` holds every saved version (who, when, a note); the latest is current. Sentinels
and pinned sites are stored as water-body ids with a name/state snapshot, resolved through merges
(`mergedInto`). With no row yet, the defaults resolve the roster by name and state exactly as before
(`SENTINELS`, `PINNED_SITES`). Each `imageryIngestSeasons` row now carries a copy of the settings it
was decided under; the legacy row is stamped with the defaults it was in fact decided under.

### §3 — Observations kept, history filled

`seasonWatchSeries`: one document per (season, site), `firstDate` + a `lows` array (°C, `null` for a
gap), `source: 'forecast' | 'archive'`. The daily tick merges its 92 days into the current season's
documents instead of throwing them away. `fillSeasonHistory` fetches Sep 1 – Jun 30 for every past
season back to 2016-17 from the archive, one multi-site request per season, for every site in the
current settings plus the ordinary sample, and again for every site a settings save starts watching
— roster or sample. The floor editor stops at 1 September, where that history begins.

### §4 — The emails (D212)

A queue on the season row (`emailQueue`, `lastEmailOn` as a New York date). Each tick enqueues what
it found and sends the head if nothing went out today. Each entry carries what it reports (sites,
lows, counts) so the copy never re-derives a past night from a rolling window. `broadcastToStaff`
takes typed blocks (paragraph, heading, list, table) and renders a real HTML table plus an aligned
plain-text one; `roles` narrows it to admins for imagery alerts.

The copy, as settled with the founder (2026-10-06):

1. **Winter 2026-27: Ice Watch Has Begun** — *Ice watch began on Saturday, October 3* · daily
   monitoring has begun because at least one sentinel had one night at or below freezing · **What
   set it off** (table) · the rule, and how many ordinary lakes froze that night · **What changes
   now** — the weather sweep runs daily; imagery doesn't start until you start it, from the Seasons
   page, now or at the first 20 °F night · **What to expect next** — the 20 °F reminder, winter
   region-wide, the end of the watch. After a reset it says which notice it replaces.
2. **Winter 2026-27: Time to Start Satellite Imagery** — *First 20 °F night: Tuesday, October 6* ·
   table · running it late loses nothing (the archive keeps every image) but the app won't show this
   season until it runs · press *Start imagery* on the Seasons page; from then it checks the catalog
   every 6 hours until the watch ends. Skipped when imagery is already running.
3. **Winter 2026-27: Winter Has Set In Region-Wide** — *Winter set in region-wide on Monday,
   October 19* · N of M ordinary lakes at or below 32 °F, above the threshold of half, air
   temperature not ice · table of the lakes that froze · the watch keeps running until spring.
4. **Winter 2026-27: Ice Watch Has Ended** — the existing close copy.

### §5 — Live imagery from Convex (D214)

`imageryLive.ts`. Every 6 hours, while the season row is open and `imageryStartedAt` is set and not
paused, `poll` searches Earth Search's STAC for S2 L2A and S1 GRD over the mask extent since the
last window (less a 5-day overlap for late-published items), selects with the A06e functions (now in
core), and queues each new slot — oldest first, at most 300; a capped poll moves its window only to
the newest pass it queued. What it queues, the pump starts at once.

**The pump** (`pump`, a fixed 3-minute cron, under a lease — never two at once) is the only thing
that touches Fly: it settles cuts in flight against the manifests in R2 (landed, still running, or
gone without a frame — retried once, then *empty* on exit 0 or *failed* otherwise), then, only while
imagery is running, starts new ones up to 25 live Machines with exactly `fan-out.sh`'s
configuration. With nothing queued or cutting a tick is one read. A Fly or archive failure backs it
off half an hour with one admin email a day; a refused spawn spends no attempt, three in a row trip
a breaker that lets one probe through after the backoff, and a timed-out spawn stays in flight.
`buildIndex` (a 10-minute cron, its own lease) runs when a frame has landed: it lists R2, reads only
new manifests and writes `index/<season>.json` and, on turnover, `index/latest.json`; a failed build,
or one with a manifest it could not read, is retried next tick. *Retry failed* and *Try again now* on the page end a backoff.

The search plan the cron can't compute (the mask extent and the empty-tile set, both from `ogrinfo`)
is published once per mask bake as `masks/<season>-search.json` (`publish-search-plan`); an unknown
tile is kept.

#### Built record — the self-review (2026-10-06)

`/code-review xhigh` found 15 issues; the seven in the imagery job had one cause — separate
self-rescheduling spawn and reconcile chains that multiplied, each reading live Machines on its own
(the `fan-out.sh` overshoot), spawning after *Pause*, retrying a dead token every two minutes, and
dying on one transient error. They became the leased pump above. The rest were fixed in place: a
capped poll no longer skips passes; the archive fills gaps in the live season's kept nights but
never replaces them; the legacy row is stamped as **version 0** (the shipped defaults) on every tick
and save, so an admin saving first cannot misattribute it; today's low (a forecast) is dropped
before anything is stored or decided (D140); the full history fill runs once a day; field dates
must be real days inside their season; the reset email names the notice by its New York day; the
ledger totals are kept in `imageryCounts` instead of counted per render.

A second pass over that fix found it still let beats multiply — a nine-minute lease under a
ten-minute action limit could lapse mid-run, an unowned release freed the next holder's lease,
each wake-up scheduled its own beat, and a run that threw scheduled nothing — and that the
breaker reset every beat, so a refusal arriving one at a time never tripped it. Two rounds in the
same fix meant redesign: `lib/imageryPump` makes both jobs **single-flight** (one state row per
job: a 15-minute owner-token lease, the one pending beat, the backoff and the refusal streak; every
wake-up replaces rather than adds; a throw ends in a backoff beat; only an admin's *Start* or *Retry
failed* cuts a backoff short). In place: a single unknown among answers no longer backs off; a
refused granule moves to the back of the queue and fails on its third refusal; the pump, the
failed list and *Retry failed* are scoped to the current season; the fill guard holds from the
click until the fill's last request, not for a calendar day; today's low is dropped at
`storeSeries`, the one sink, rather than at each fetch; Fly and archive reads time out at 30 s;
settle checks run eight at a time and land in one mutation, with the ledger written once per
mutation.

A third pass found the redesign's own scheduling still had holes — a breaker that, once tripped and
carried across beats, never closed; a stored beat id that outlived a failed run and wedged the job;
a crashed holder with no beat behind it; an admin's reset overwritten by the run it interrupted.
Every one came from a job scheduling its own next run, so the pump and the index build became
**fixed crons** (3 and 10 minutes) under a plain lease, and the scheduling state went away. Also in
that round: the breaker reopens half-way (one probe) after a backoff; a spawn that times out is left
in flight, not refused (the Machine may exist); back off only on three failed checks with no answer;
an admin's reset during a run wins; the history fill is planned in the click's own transaction; the
signed R2 calls time out too; *Try again now* on the page.

A fourth pass found only edges, which says the design had settled: spawning has a time budget and
stops after two timeouts (a hung create could otherwise outlive the action and its `finally`);
a claim never confirmed fails on its last attempt instead of passing as *empty*; untried claims
are handed back even when a run throws; the index's dirty flag became compare-and-clear, so a
killed build leaves its request standing; three blind runs in a row back off however few cuts are in
flight; a half-open breaker claims one granule; *Try again now*, *Retry failed* and a poll that
queued something run the pump at once; one runnable rule serves both queries.

Greptile's first pass (2026-10-10) found seven, four in the preview and the emails. The preview
replayed an edit with the saved sample and the roster ids the version stored; it now asks the server
for the edited sites (`previewSites`, which is `sampleSites`), so roster ids follow merges and the
sample is re-drawn at the edited size, and a season missing lows for watched lakes says so. A save
fills history for every site it starts watching, not only the roster it names; a fill of more than
one request is spaced like a full one. Each queued email keeps the settings that decided its fact,
so a reminder found after the imagery line moved names the new line. The floor stops at 1 September,
where the history begins. In the imagery job: a spawn batch asks again before each create, so
nothing starts after *Pause*; an unreadable manifest leaves the index request standing, with one
email a day.

### §6 — `/admin/seasons`

The current watch (state, dates, sentinels, *Reset*), imagery (*Start* / *Pause*, the run history),
the settings editor with the preview table (every season under the saved and the edited settings,
each over the sites the cron would read for it, with the field dates beside them), a season's sentinel lows charted against the thresholds, the
field-date form, and where each default lives in code. Admin-only.

### §7 — The CLI

`ingest-window` stops re-deciding with its own sample and its own one-sentinel regex: it reads the
recorded watch and the settings from the deployment (`convex run seasonWatch:status`) and prints them
with the manual backfill commands. The cutter, `fan-out.sh` and `backfill.sh` stay for past seasons.

## On dev — 2026-10-09

Deployed from a local-only branch combining this one with the landmarks stack (#82–#84), whose data
a main-based schema cannot validate; that branch is never pushed. What the real data said:

- The legacy row stamped as **version 0**; its opening night filled in exactly as the first email
  should have read: Upper Lake of the Clouds −0.4 °C (31.3 °F), Eagle Lake 0.0 °C, 0 of 25 ordinary
  lakes.
- **No 20 °F night yet.** The forecast had the summit at −7.1 °C on 6 October; observed was −5.7, and
  −6.2 on the 7th (about 21 °F). Dropping today's forecast low is what kept that from firing.
- ⚠ **Winter region-wide was already recorded for 7 October** (by the old tick, so with no email):
  13 of 25 ordinary lakes at or below freezing for one night, none the next. The end of the watch is
  measured from that date, so ten straight nights above freezing at every ordinary lake would end
  the watch — imagery and the weather sweep with it — in October. A threshold for Matt and the
  founder: a winter rule of more than one night, or a reset under stricter settings.
- The live catalog for 3–6 October selected 85 passes (74 optical of 157, 81 dropped as empty tiles;
  11 radar of 17), about 21 a day — a normal catch-up stays under the 300 cap.
- `/admin/seasons` rendered in both themes from real dev data (a local harness; dev sign-in is by
  emailed code); the chart gained a legend and visible reference lines from that render.
- The history fill is running: 33 requests 75 minutes apart, done about 2026-10-11 11:00 UTC.

## Owed at merge

- 🟢 Convex dev env set 2026-10-09: `IMAGERY_ARCHIVE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_ENDPOINT`, `FLY_IMAGE`; 🟢 `FLY_API_TOKEN` 2026-10-09 — a deploy token scoped to
  `skating-imagery`, one year (`convex-dev-live-imagery` in `fly tokens list`).
- 🟢 `publish-search-plan` for `winter-2026-27`, 2026-10-09 (50 empty / 50 kept tiles).
- Dev runs the combined branch until #82–#84 merge; after they do, rebase this PR and push it.
- The masks predate the 2026-09-19/21 corpus seed; a re-bake is still the register's item.
