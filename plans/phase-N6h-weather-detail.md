# Phase N6h — The weather panel: a season of past days, a planning window, and radar that admits what it can't see

> **Status:** 🚧 **PR 1 = [#48](https://github.com/tatwater/skating/pull/48), merged 2026-09-10 and
> deployed to dev** — Workstreams **A + B + C + G**, D162 + D163, **and a continuous hourly weather
> timeline on both clients that this plan never specified** (see *§What PR 1 actually shipped*). Four
> Greptile passes on the PR; suites at merge: core 2,460 · convex 1,437 · web 508 · mobile 108.
> **PR 3 = Workstream H = [#50](https://github.com/tatwater/skating/pull/50), merged 2026-09-11**
> (the three-tab drawer IA + sub-areas as the weather unit + the spread) — see *§What PR 3 shipped*.
> **PR 4 = Workstream D, built 2026-09-11 on `phase-n6h-weather-detail-4`** (two commits, deployed
> to dev, verified in the running web app against Champlain; mobile by type-check + suite only —
> founder checks the sheet) — see *§What PR 4 shipped*. Founder call 12 revised call 11's D+E bundle.
> **Two PRs remain after this one: E → F.**
> Scoped 2026-09-02. Founder ask, same day. Grew out of a costing
> question — *"what is most expensive about this plan?"* — and the answer moved the design: the
> expensive half is not the data, it is **the cache key**, which today shares nothing.
> **Depends on:** nothing. Every seam it needs is already built.
> **Touches:** `weather.ts` (the sample-point key, the fetch spec), `weatherCache` /
> `weatherForecastCache`, the N5a season boundary, the N6c wind rose + fetch profile, Phase 4
> drive-time, the Phase 5 feed filter row, and the N6e imagery scrubber + Fly/R2 cutter pattern.
> **Decisions:** **D152–D163**, all written into [`01-decisions.md`](./01-decisions.md) (D152–D161 on
> 2026-09-03, D162–D163 on 2026-09-11).
> **Supersedes one Phase 10 rule:** *"never the archive API"* was right for its use case and is wrong
> for this one. See D153.
>
> ### Founder calls, 2026-09-02 — second pass, after the first draft
>
> 1. **Discovery must not be limited to bodies that have reports.** The weather filter searches the
>    corpus, not the report table — *"with all this helpful data I don't want to limit discoverability
>    to only filtering on reports that exist."* This turned Workstream E from a feed filter into its
>    own thing. See **D159**.
> 2. **The ice-thickness estimate gets built, admin-only, as a calibration instrument** — *"can we
>    calculate this number and show it to admins-only just as a curiosity? I'm very interested to see
>    how it performs compared to reality through this season."* See **D160**.
> 3. **A missed day gets recovered, not skipped** — retry, then fall back to a coarser source, and only
>    then give up. See open question 3.
> 4. **The drawer/sidebar becomes three sub-tabs:** *Overview/Details* (machine-compiled facts about
>    the body, including historical and trend data) · *Reporting* (user-supplied, this season) ·
>    *Planning* (weather, put-ins, directions, derived season trends). **Tab selection persists across
>    bodies.** See open question 4.
>
> ### Founder calls, 2026-09-03 — third pass
>
> 5. **The feed becomes heterogeneous and is renamed "Newsfeed" → "Latest"**, with a user-set
>    *"only show reports"* boolean in the filter row for anyone who wants the old behaviour. See
>    **D159**.
> 6. **The season checker and the cell scanner play along rather than merge** — the cheap 25-site
>    checker stays the year-round trigger and *starts* the expensive scanner. See **D161**.
>
> ### Founder calls, 2026-09-11 — fourth pass, kicking off PR 3
>
> 7. **H carries the sub-area spread**, as sequenced in open question 5 — not a pure move. Verified
>    against seeded rows plus a **one-off out-of-season sweep of Champlain's bay cells** on dev, since
>    Tier B is otherwise empty until mid-November.
> 8. **A giant opens pre-selected on its top-`displayScore` bay, with an easy switcher.** The
>    effective bay is the route's `?sub=` if present, else the top bay — *implicitly*, never writing
>    the URL on open. The switcher and the spread's named extremes both set **route-level focus**
>    (`focusSubAreaId`), so camera, report-feed filter and weather follow one selection concept
>    rather than a third one.
> 9. **Spread lines only in H** — named extremes for lows and snow-since over the 7-day headline
>    window, collapsing to *"Similar across the lake"* inside a pinned threshold. The sorted bay lists
>    wait for E, where the per-cell digest gives them their inputs for free.
> 10. **IA mapping.** Action buttons (report / hazard / bounty / directions) and the NWS alert stay
>     **above the tabs, always visible**. *Overview:* public-access ruling, posted rules, wind
>     climatology, reference links, credits, moderator controls. *Reporting:* season filter, bounties,
>     ice history, hazards, reports. *Planning:* the weather timeline, the forecast, put-ins. The
>     "permission precedes access" adjacency is knowingly split across Overview/Planning because the
>     taxonomy puts put-ins with the trip and permission with the body.
> 11. **D stays as D155 wrote it** — a separate 7-day grid selector plus an hourly strip, *not* an
>     extension of the timeline PR 1 built. **Three PRs remain: H → D+E → F.** ⚠ *Both halves
>     revised the same evening by calls 12 and 14 below.*
>
> ### Founder calls, 2026-09-11 — fifth pass, kicking off PR 4
>
> 12. **D ships alone; then E; then F.** Call 11's D+E bundle was reconsidered once E's real size was
>     laid out (a join table + corpus backfill, a digest table, a cron change, a shared filter store on
>     both clients, the *Latest* rename, and a new card type) and once D grew its own design work (call
>     14). D+F was asked about and rejected: F is the most infrastructure-heavy workstream left and
>     shares nothing with D but the word. **Three PRs remain, not two.**
> 13. **One 7-day fetch serves both the strip and the planner.** `forecast_days` is parametrised per
>     caller (default stays 2 for the archive, decay cron and contradiction checker); the drawer's
>     forecast fetch asks for 7 and the existing 12-hour strip line becomes a prefix of the same
>     hours. `past_days: 1` + 7 = 8 days = still one billing unit, so an open costs 1.2 weighted calls
>     as before. `precipitation_probability` stays out (+8 % on every call, the archive's included).
> 14. **D's shape is a weather app's, not D155's grid.** *"Small cards in a horizontal scroll area
>     with vertically stacked temp, weather symbol, precipitation, time … then underneath, larger
>     full-day summary cards in their own horizontal scroll area, with a summary of each whole day's
>     forecast, including things like 'snow from 10 PM to 4 AM'."* The morning/afternoon/overnight
>     grid is gone; **a day card is the selector**. The hourly row holds **all seven days** with day
>     dividers, opens scrolled to *now* (so it reads as "the next twelve hours"), and tapping a day
>     card scrolls it to that day's morning — which is how D155's *"the run-up is drawn, not hidden"*
>     survives the redesign: drag back from Thursday and Wednesday night's snow is there. Drive time
>     stays a hint (see the readiness note below on what it can honestly be).
> 15. **Prime the whole filter tier on dev out of season, once, for E.** `past_days: 8` over the
>     registry's ~3,043 cells ≈ 3,650 weighted calls — a third of one free day. Rides with E, not D.
> 16. **E's predicate gets weather-only anchors, and the founder defined them.** *"'No snow since' is
>     since the last <20°F; the nights-below are intended to be a chain of nights in a row (seeing
>     temps below 20°F within 48 h of each other counts as consecutive). This stat is relevant when
>     ice is first freezing for the season (when the ice is best), because nights-below-20 is
>     predictive of ice formation, and no-snow-since is indicative of that fresh ice being
>     uncovered."* This closes D159's *"no snow since has no anchor without a report"* gap without a
>     report: the anchor is **the first night of the current cold chain**, where a chain is a run of
>     nights with `nightMinTempC` below the threshold and *one* milder night between two cold ones
>     does not break it (48 h). The per-cell digest therefore carries, per threshold, the chain
>     length in nights, the chain's start day, and snowfall since that day — and the copy reads
>     *"4 nights below 20°F, no snow since the first"*, which names its own anchor. ⚠ The 48-hour
>     tolerance is a founder rule, not a physics constant; pin it as one named number in core.
>
> ### Measurements taken 2026-09-02 (open questions 1 and 2)
>
> **Open question 1 is answered: elevation banding is cheap.** Three independent 3,000-body samples off
> the dev deployment (`agile-bee-397`, ~36% of the corpus), all with **100% elevation coverage**:
>
> | sample | 0.05° cells | + 100 m bands | ratio | + 200 m bands | ratio |
> |---|---|---|---|---|---|
> | 1 | 1,308 | 1,612 | 1.23× | 1,454 | 1.11× |
> | 2 | 1,626 | 1,852 | 1.14× | 1,736 | 1.07× |
> | 3 | 1,190 | 1,331 | 1.12× | 1,258 | 1.06× |
>
> **~1.16× at 100 m, ~1.08× at 200 m.** Against the corpus-wide 8,221 cells at 0.05°, Tier A lands
> around **9,500–10,500 keys** — nowhere near the 3× blow-up that would have forced a rethink. Cache
> sharing goes from 3.0 bodies/cell to ~2.6. **Take 100 m**; the extra resolution is nearly free and
> 200 m was already within a whisker of 300 m (1,454 vs 1,440 in sample 1), meaning 200 m bands are
> close to not banding at all in this terrain.
>
> ⚠ **Method limit, stated plainly:** these are per-page distinct counts, not an exact union across the
> whole corpus — a cell split across two pages with different bands is undercounted, so **the true
> ratio is slightly higher than 1.16**. The exact union was not computed because it would not change
> the decision: Tier A's absolute cardinality has almost no budget consequence (on-demand only ever
> fetches what users open), and the ratio is what governs cache dilution.
>
> **Open question 2 has no answer from dev, but the Google Group corpus answers it properly.**
>
> ⚠ **First, a correction.** The initial query looked for a table called `favorites`; the table is
> **`waterBodyFavorites`**, and the "0 favorites" it reported was an artefact of the wrong name. The
> real dev numbers are **14 favorites, 2 reports, 3 hazards, 1 bounty — 16 distinct bodies** (the 14
> favorites are all the founder's own account). Still far too little to size a job from, but the
> correction matters because the wrong number made the situation look worse than it is.
>
> **The real evidence is `training_data/google_group`** — one complete season (2025-07-15 → 2026-06-24,
> 1,197 messages) of an established Nordic-skating community actually talking about where they skated:
>
> | measure | value |
> |---|---|
> | distinct bodies discussed in one season | **116** |
> | bodies with ≥3 mentions | 75 |
> | bodies with ≥5 mentions | 49 |
> | bodies with ≥10 mentions | 25 |
> | share of all mentions from the top 10 | 37.6% |
> | share from the top 25 | 60.6% |
> | share from the top 50 | 79.2% |
>
> **The founder's hunch was right, and the numbers are almost exactly the guess:** *"my hunch is that
> the unique count will be closer to 50-75; the popular lakes are really popular."* The ≥3-mention band
> is 75 bodies and the ≥5 band is 49. The head is steep — Champlain (60) and Morey (57) alone are 14%
> of all mentions.
>
> **What this means for sizing.** Favorites will run *longer-tailed* than discussion, for two reasons:
> a favorite is personal and aspirational (everybody favorites their own local pond, which nobody posts
> about), and this corpus is VT-centric (`vtnordicskating`) while the app covers five states. So 116 is
> a **floor**, not a ceiling. Even taking the founder's pessimistic framing — 1,000 unique favorited
> bodies out of ~20,000 favorites — that collapses to roughly **600–900 Tier-A cells ≈ 1,200 calls/day**,
> which is a rounding error against the 10,000/day free tier. **The precompute tier is not a budget
> risk at any plausible adoption level.** The only thing in this phase that can threaten the budget is
> Tier B corpus-wide, and that is already sized at ~4,300/day.
>
> **The season shape is a second, unlooked-for finding.** 97% of the corpus's messages fall in
> **November–March** (Dec 352, Jan 354, Feb 262, Nov 90, Mar 107; July–October and April–June are
> single digits). That is 151 days, which matches the 150-day season assumed in the storage maths
> above almost exactly, and it is direct empirical support for idling the cron off-season (D153) and
> for gating the corpus-wide scanner behind the season checker (D161).

---

## What PR 1 shipped, and where it differs from this plan

**Built 2026-09-03: Workstreams A + B + C + G.** D (forecast panel), E (weather-first discovery) and
F (radar) are untouched. ⚠ The subsections below were written on 2026-09-03; **the PR then grew for a
week before merging as #48** — see *§What PR 1 actually shipped* immediately after them.

### What PR 1 actually shipped — the week between this section and the merge (written 2026-09-11)

The plan's own record stopped at the review pass. Between 2026-09-03 and the 2026-09-10 merge the
branch gained, in order:

1. **A continuous hourly weather timeline, on both clients.** Not in this document anywhere. The
   seven-column past panel showed each day's high and low and could not show *order* — snow at 2 PM
   Tuesday then a hard freeze that night is a different surface from a freeze that was later buried.
   `core/weatherTimeline.ts` (geometry) + `design/chartWeather.ts` (a measured, CVD-validated scale)
   draw temperature, precipitation (typed via `weather_code`), wind with **fetch as the fill's density
   channel**, and sun with an irradiance ramp. **Fixed at 2 px/hour** (founder call) with a scroll
   track, trackpad panning and a keyboard slider; the export under `exports/weather-timeline` is a port
   of the real model against real ERA5 data for Mascoma Lake. ⚠ This is why D should not be assumed
   to be "the timeline extended forward" — founder call 11 above keeps D155's grid+strip shape.
2. **`weatherHours`** — the hours the archive was already fetching and throwing away, stored for the
   *browse* tier only (grows with attention, not with the corpus) and never on `weatherDays`, whose
   rows are range-scanned corpus-wide. Rows carry `HOURLY_ROW_VERSION`; adding a field without
   bumping it is now the bug, because a cell already holding complete rows is otherwise satisfied for
   ever and the new field never appears on exactly the popular lakes.
3. **`weather_code` as the twelfth hourly variable** (~9% on every call; founder call, made with the
   number stated). `HOURLY_VARS` is 12, not the 14 the cost model below assumes — `dew_point_2m` was
   never added and `precipitation_probability` is still owed by D.
4. **`weatherCellSyncs`** and an import-triggered registry reconcile: `importRuns.finish` schedules a
   debounced walk for the run kinds that can move a cell key; the weekly cron is demoted to a drift
   net. A tier has one owning `runId`, so two concurrent walks can no longer take turns emptying it.
5. **`timeZone` stored per `weatherDays` row.** Four Greptile passes to learn that *a calendar date is
   not derivable from an offset*: Open-Meteo stamps one `utc_offset_seconds` on a whole response, so
   a July backfill gave every January row EDT and no arithmetic on it could recover the date.
   `localDateInZone` asks the zone (the Convex runtime has full ICU) and returns null rather than
   answering in UTC.
6. **`isCompleteDay` takes the lake's current local day**, because Open-Meteo returns whole calendar
   days and today's row holds forecast values for its un-elapsed hours — today was "complete" from the
   first fetch of the morning, on every surface.
7. **Staff email on season open and close** (`broadcastToStaff`, one message per active moderator or
   admin, gated on the mutation actually writing).
8. **D163's set-once `recordSeasonWinterFrom`** — a sentinel-opened season wrote `winterFrom: null`
   and could never close.

**⚠ Two things D inherits from this, recorded here so they are not rediscovered:**

- **`FORECAST_DAYS = 2` lives in the shared `fetchOpenMeteoHourly`**, used by the strip, the archive
  backfill, the decay cron and the contradiction checker. D needs seven forecast days; bumping the
  constant would move the 92-day backfill from 7 to 8 billing units. Parametrize it per caller.
- **`precipitation_probability` is forecast-only and would ride on every call**, including the
  archive's, at +8%. D v1 should ship without it — `weather_code` plus amount already carry the
  story — unless the founder wants it with that number stated.

### Six things the build decided that the plan did not

1. **A `weatherCells` registry table, which this doc never specified.** The Tier-B cron has to visit
   ~3,043 cells daily, and deriving that list by paginating 25,000 `waterBodies` rows would cost
   ~75 MB of read I/O *every day* to rediscover keys that change only when the corpus does. So the
   cells are materialised once, in batches, and the cron reads a few thousand small rows. This is the
   N6d 105 GB lesson applied before rather than after.
2. **The cell travels as an object, not as coordinates.** Hole 6 called for "exactly one definition"
   of the key with a test that the four consumers agree. That would have held by convention;
   `resolveWeatherSince` now takes a **`WeatherCell`** that can only come from `bodyWeatherCell`,
   so the four *cannot* disagree without deleting the helper. Convention became a type.
3. **`weatherCache.samplePointKey` keeps its now-inaccurate name.** Renaming a required field is a
   widen→deploy→backfill→narrow migration, for a table that prunes itself every 24 h and whose
   old-format rows are simply unreachable under the new key. The meaning moved, the name stayed, and
   the schema comment says why.
4. **The season gate is a pull, not a push.** D161 describes the 25-site checker "starting" the
   sweep; the sweep instead *reads* the checker's recorded verdict from `imageryIngestSeasons`. Same
   dependency inverted, and strictly more robust — a missed cron tick cannot lose a start signal that
   is re-derived daily. It also leaves `maybeCheckSeasonOpen` untouched, which matters given the
   circular-type landmine documented in that file.
5. **The gate runs the first batch inline instead of scheduling it.** The sweep reschedules its own
   remaining batches either way, so this is exactly the same work — and in exchange the cron tick
   reports what happened rather than only that it asked for something to happen.
6. **`wind_direction_10m` joined the fetch**, taking `HOURLY_VARS` to 11 and every call to 1.1×
   Open-Meteo's billing weight. It earns that alone: multiplied against `fetchProfileM` it is what
   turns "windy" into "the wind ran the full fetch", which is the difference between black ice and a
   rippled surface. The cost is now **counted rather than guessed** — see the `externalApiCalls`
   meter, which shipped with A because D158's trigger could not otherwise fire.

### Two bugs the tests found, both mine

- **The cell registry discriminated "same run" on `updatedAt === Date.now()`.** Body counts
  accumulate across the pages of one run and must be replaced by a later run — and two runs landing
  in the same millisecond both read as "same run", double-counting every body. Now a real run id: a
  clock is not an identifier.
- **The season gate scheduled its sweep**, which made the wiring untestable for no benefit. See
  delta 5.

### Holes closed, and the two that are not

| hole | status |
|---|---|
| 1 · local-shifted `startMs` | ✅ **closed 2026-09-03.** `formatLocalHourLabel` in `weatherPanel.ts` reads the value back with **UTC getters** (correct precisely because it is already local), and `HourlyWeather.startMs`'s docblock points at it. The archive never touches the field at all. Rationale for a helper rather than a rename: renaming the *stored* `weatherForecastCache.hours[].startMs` is a validator migration, and the real risk was that D gets written weeks later by someone who did not read a docblock — so the fix is making the obvious function the right one. Still a standalone memory. |
| 2 · multi-cell giants | ⚠️ **half closed, and the half that was closable.** The investigation reframed it: **zero bodies in the corpus carry `weatherSamplePoints`** — Champlain (170 km span) has none — so nothing was picking the wrong point among several; there is only ever one. N2 shipped the suggester *and* the moderator writer and nobody has run it (the same reader-with-no-producer shape as N6b's `hasContours`). ✅ The **dishonesty** is fixed: `spansMultipleSampleCells` (tied to `DEFAULT_SAMPLE_SPACING_KM`, so the caveat and the grid tool cannot disagree) drives a panel line saying the readings come from one point near the middle. ❌ The **data** is not: an operator still has to place a grid on the three bodies that need one. |
| 3 · "nights" undefined | ✅ `nightMinTempC` over an explicit `[18:00, 09:00)` window, defined once in `weatherDay.ts`, with `nightsBelowThresholdC` as the only predicate. |
| 4 · DST 23/25-hour days | ✅ Days are bucketed from local date *strings*, never from a shifted timestamp. `hours` reports what was seen. |
| 5 · backfill stampede | ✅ Batched and self-rescheduling (`CELL_BATCH_SIZE`), season-gated, and the meter makes the spend visible. |
| 6 · atomic re-key | ✅ See delta 2, plus a test asserting the strip and the decay cron land on one row. |
| 7 · idempotency + migration | ✅ Upsert on `(cellKey, dayMs)`; a gap marker refuses to overwrite real data. No migration needed (delta 3). ⚠ `weatherCellKeyB` on `waterBodies` is still owed by **E**. |
| 8 · mobile has no charts | ✅ Text-first mobile, all copy in `weatherPanel.ts` in core where it is testable. |
| 9 · offline | ❌ **Not done, deliberately.** Needs D's payload shape to cache against; inventing one now would be guessing at an interface that does not exist. |

### The operator task this uncovered

**Three bodies on dev are large enough to need a weather sample grid and have none:** Lake Champlain
(170 km span), Lake Memphremagog (41 km) and Connecticut River Reservoir (20 km). Everything needed
to fix that shipped in N2 — `suggestSamplePoints` proposes a grid at `DEFAULT_SAMPLE_SPACING_KM` and a
moderator action writes it. Running it is a founder/operator call (it costs one forecast fetch and one
cache row per point, and the spacing is a judgement), so it is recorded here rather than done.

Until then the panel says which claim it is making, which is the honest interim state rather than the
fixed one.

### Deferred inside B, with reasons rather than silently

- **The ERA5 leg of the recovery ladder (D161 step 3).** Only reachable for gaps older than 92 days,
  which cannot arise in a first season for a cell whose range starts this winter. The `archive`
  source literal is already in the enum, so wiring it later needs no migration.
- **The N5a season rollup.** An optimisation for a season that has not happened: 150 daily rows per
  cell is ~548 MB against Convex Pro's included 50 GB, and the rows are append-only. Can land any
  time before the season closes.

---

## What PR 3 shipped — Workstream H, 2026-09-11

**Built on `phase-n6h-weather-detail-3`, five commits:** the three-tab IA on both clients, sub-areas
as the weather unit, and the spread. Suites at build: core 2,546 · convex 1,447 · web 515 · mobile
108, all 13 tasks clean. Verified in the running web app against dev (Champlain); mobile verified by
type-check and suite only — the emulator build runs but sign-in is email-code, so the founder checks
the sheet by hand.

### Six things the build decided that the plan did not

1. **The mobile strip pins through two portal slots, not by being "outside the scroll view".**
   React Native can only stick a *direct* child of a scroll view, and `MapDrawer`'s
   `BottomSheetScrollView` wraps a single Expo Router `<Slot />` — so the plan's *"outside the scroll
   view"* would have put the tabs above the lake's own name and the NWS alert. The first cut let the
   strip scroll; the founder overruled that on the first device pass (*"(b), and in this PR"*), so
   the scroll view is now exactly three children — a **head** slot, a **pinned** slot
   (`stickyHeaderIndices={[1]}`), and the routed screen — and `WaterBodyDetail` teleports its
   header/actions/alert into the head and its strip into the pinned slot via `@gorhom/portal`
   (`DrawerHead` / `DrawerPinned`). Screens without a strip render exactly as before: an empty slot
   has no height. Web pins with `position: sticky` inside its own scroll container.
2. **`app.css` was missing the shadcn orientation variants**, so the vendored `Tabs` laid its list
   out as a column beside the panel. The preset ships `data-horizontal:`/`data-vertical:` in
   `shadcn/tailwind.css`, which the app never imports (that package is the CLI). Defined in
   `app.css` with the upstream selectors — which also revived dead classes `separator.tsx` and
   `toggle-group.tsx` had carried since they were vendored. `shadcn add` also mis-resolved `cn` to
   an npm package of that name; reverted.
3. **The default tab is *Overview*** (`DEFAULT_DETAIL_TAB`), the first in the strip; one word to
   change if usage says people go straight to *Planning*.
4. **Scope resolution is client-side, validation is server-side.** `resolveWeatherSubArea` (core)
   picks the bay — route `?sub=`, else top `displayScore`, never written back — and the server
   refuses a delisted or foreign id by answering for the lake and serving `scope` back, so the
   panel labels what it was *given*. Both `getWeatherDaysForBody` and `getForecastForBody` take
   the bay, so the Planning tab describes one place.
5. **A bay carries no fetch profile.** The profile is the lake's; Malletts Bay is sheltered where
   Champlain's eleven miles of fetch is not. The wind lane draws flat on a bay until a per-bay
   profile exists.
6. **The spread's collapse thresholds:** 3 °C on lows (lapse-rate and lake-effect noise between two
   points 20 km apart), 2 cm on snow (a dusting). Bays are compared over the **intersection** of
   their days with a floor of three, and the in-progress today is dropped per cell by its own zone
   — a bay with a hole must not read as *less snow*.

### Holes closed by this PR

| hole | status |
|---|---|
| 2 · multi-cell giants | ✅ **closed for any body with sub-areas.** The reading is for a named bay, the caveat line is gone there, and the spread says what the rest of the lake did. Memphremagog and Connecticut River Reservoir have no bays and keep the interim caveat until one is drawn (or a sample grid placed — still an operator call). |
| Open question 5 | ✅ Sub-areas first, as recommended. Champlain measured **10 live bays in 10 distinct Tier-B cells** on dev (the plan's 7 was an earlier count). The registry walk gains a sub-area pass, inline on the last body page, so bay cells are swept and gap-repaired like any other. |

### Two things worth remembering

- **The Tier-B empty-until-November problem has an operator tool now:** `primeSubAreaWeather`
  (`internalAction`, `convex run weatherArchive:primeSubAreaWeather '{"waterBodyId":…,"pastDays":8}'`)
  fills one lake's bay cells at the filter tier. Run on Champlain 2026-09-11, ~12 weighted calls.
- **The circular-type landmine bit again**, in a new place: an action that reaches
  `internal.weatherArchive.*` from inside its own module with an *inferred* return type makes
  TypeScript give up on the whole `api` type, and the first symptom was an unrelated test file
  failing to compile. Annotate the return type; the comment on `primeSubAreaWeather` says so.

**Known and deferred (founder, 2026-09-11):** switching tabs from a scrolled position jolts on
mobile when the new tab is shorter — the scroll view clamps to its new maximum. Not the slot layout;
just short tabs. Two easy fixes if it survives D and E filling the tabs: a `minHeight` floor on the
content child (never clamps; short tabs scroll into blank space), or animating to the strip's offset
on a tab change (predictable; loses position both ways). Decide once the tabs have their real content.

**Sequencing note for D.** `PastWeatherPanel` and `ForecastStrip` now take `subAreaId` + a
load-bearing `pending` flag (hold while the bays load, or a giant pays for the lake's cell and then
the bay's). D's forecast panel inherits both; the Planning tab already has the picker it wanted.

### ⚠ Readiness pass for PR 4, 2026-09-11 — four things the plan had wrong or stale

1. **`weatherCellKeyB` is dead; the join won, and it is free.** The holes table (row 7) and
   Workstream E still owe a single `weatherCellKeyB` field on `waterBodies`; open question 5 §4 had
   already *"picked the `bodyWeatherCells` option"* because a giant spans many cells and Convex has
   no array index. The join is what E builds — same shape as N1's `waterBodyCells` (`by_cell` +
   `by_body`) — and it costs no widen→deploy→backfill→narrow dance, because a new table has no
   existing rows to validate. Better: **the registry walk already visits every body and bay**
   (`pageBodyCells` / `pageSubAreaCells`) to compute their filter cells, so the join is written by
   that walk for nothing and inherits its import-triggered reconcile and its vacated-cell prune.
2. **Hole 8 is stale.** *"Mobile has no charting substrate"* stopped being true in PR 1:
   `WeatherTimeline` draws on mobile through `react-native-svg`. Nothing about D is forced text-first.
3. **Drive time is band-granular, so D's hint can only be band-granular.** Phase 4 gives a body a
   band — 30 / 60 / 90 minutes or `null` — never minutes, and the client is never told a single
   body's band today (`bandForCoord` runs inside `listFeed`, `profiles`, `notifications`). So the
   hint D155 asked for is *"≈ arrival"* marked on the hour card at *now + band*, computed server-side
   in the forecast action from the viewer's cached isochrones, and nothing more precise.
4. **The drawer's fetch drops two of the twelve variables it pays for.** `fetchOpenMeteoHourly` in
   `weather.ts` never carries `weather_code` or `wind_direction_10m` into `HourlyWeather` — only the
   archive's `fetchLocalHourly` does. The weather symbol on every card needs the code, so D wires
   both through (they are already in the response; this is parsing, not spend).

---

## What PR 4 shipped — Workstream D, 2026-09-11

**Built on `phase-n6h-weather-detail-4`, two commits.** The seven-day planner on both clients, off
one fetch. Suites at build: core 2,570 · convex 1,452 · web 524 · mobile 108. Deployed to dev and
verified in the running web app against Champlain's default bay (148 forward hours, seven day
cards, real episodes — *"Rain 5–7 AM · 0.11″"*, *"Wind 11 AM–3 PM · gusts 32 mph"*); the selector
verified in both directions. Mobile verified by type-check and suite only; the founder checks the
sheet by hand, since sign-in is email-code and there is no headless path.

### What it is

- **`core/forecastPlan.ts`** — everything printable. WMO code → `ForecastCondition` (the code
  speaks first because only it can say freezing rain; the amount/temperature derivation is the
  fallback, then cloud cover for a dry sky); `conditionGlyph` for the day/night symbol; per-day
  high/low; the archive's own night window (`[prev 18:00, this 09:00)`, from `weatherDay.ts`, so
  "night" means one thing on both halves of the Planning tab); **episodes** — runs of snow / rain /
  freezing rain / sleet / wind with a single dry hour bridged — printed as *"Snow 10 PM–4 AM ·
  1.2″"*, *"all day"* when a run covers the card. Floors: 0.3 cm snow, 0.3 mm rain, 32 km/h wind,
  **no floor on freezing rain**. The founder's example sentence is a test.
- **`ForecastPanel`** on both clients absorbs `ForecastStrip`: the strip's one-liner is now derived
  on the client from the same hours at its 12-hour horizon, above an hourly card row (time · symbol
  · temp · amount · wind) that holds **all seven days** with date dividers and opens at *now*, above
  a row of day cards (label · symbol · high/low · night low when colder than the day · totals ·
  episode lines). A day card is the selector: tap → the hour row scrolls to that morning; scroll the
  hours → the day row follows and re-presses. D155's *"run-up drawn, not hidden"* is the drag back.
- **Drive time as a band, never a time.** `getForecastForBody` resolves the viewer's Phase 4 band to
  the place (bay centroid or `defaultSampleAnchor`) from their cached isochrones and the planner
  marks one card *"≈ arrival, 60 min drive, if you left now"*. That is the whole hint.

### Five things the build decided that the plan did not

1. **The cache row records `forecastDays`, and a shorter row is a miss.** The key is the hour
   bucket, so in the hour after the deploy every popular lake would otherwise have answered a 7-day
   request with the strip's 2-day row — five empty day cards, no error anywhere. Pre-planner rows
   also lack `utcOffsetMs`, which is the second reason they read as a miss. `writeForecastCache`
   uses `replace`, not `patch`, so the strip's old derived fields cannot survive beside a longer
   series they do not describe; the schema keeps them optional until the hourly prune clears them.
2. **`FORECAST_DAYS` stays 2 as the shared default; the drawer passes 7.** The plan said
   parametrise; the build kept the archive, the decay cron and the contradiction checker on exactly
   the request they made before, and pinned the drawer's at one billing unit with a meter test.
3. **The strip's semantics moved to the client.** `ForecastPayload` is hours + offset + band, and
   `summarizeForecast` runs at render — the server no longer computes a horizon-shaped summary
   for a table that now holds a week. `resolveBodyWeatherCell` went with it (its one caller became
   `resolveForecastPlace`, which returns the band in the same read).
4. **A day's symbol is the worst precipitation that starts on it, else the modal daytime cloud** —
   with a tie resolving cloudier, and a trace of drizzle under the rain floor not counting (the
   first render gave Monday a drizzle icon over nothing worth a sentence). Thunder keeps a no-floor
   rule; it is the one condition where an hour is enough.
5. **The night low is printed only when the night was colder than the calendar day.** In September
   it repeated the low on every card; in January it is the line that matters.

### Two things a render found that no test did

- **A `<fieldset>` defaults to `min-inline-size: min-content`.** The day row grew to seven cards
  and overflowed the sidebar instead of scrolling — `scrollWidth === clientWidth`, and
  `scrollIntoView` had nothing to do. `min-w-0` fixes it; the comment on the element says why.
  (Biome insisted on the fieldset over `role="group"`, and it is the right element.)
- **jsdom has no `Element.scrollTo`** — the row scroller guards and falls back to `scrollLeft`.

### Holes closed by this PR

| hole | status |
|---|---|
| 9 · offline | ⚠ **Half.** `ForecastPayload` is the shape hole 9 was waiting on, and it is small (≤ 168 hours × 11 numbers). Caching it in the mobile offline body payload is **not** done here: it belongs with the on-ice/offline surface rather than the Planning tab, and the founder gave no call on it this pass. Recorded in the register, not silently. |
| D's `precipitation_probability` | ✅ Skipped, as inherited — `weather_code` plus amount carry the story, and the cards read fine without it on real data. |

**Sequencing note for E.** The planner reads Tier A on open and nothing corpus-wide; E owes it
nothing. The condition vocabulary (`ForecastCondition`, `CONDITION_LABEL`, `conditionGlyph`) is
reusable on a body-result card if E wants a symbol there — the same code, the same day/night rule.

---

## PR 2 — the review pass, 2026-09-03

A `/code-review xhigh --fix` before opening the PR found 15 issues (13 fixed mechanically; the two
left are below). The founder's read of the findings then turned three of them into design work.
Details in the decisions they produced — **D162** (solar weighting) and **D163** (the season close) —
plus the plan corrections marked ⚠ **PR 2** in D159, F and the workstream list.

**The three bugs worth remembering**, all of the same family: two true numbers making one false
sentence.

1. `getWeatherDaysForBody` anchored its window on the **UTC** day while rows are keyed by the lake's
   **local** date, so between UTC midnight and local midnight — all evening, prime browsing — the
   newest day looked permanently missing. Every drawer-open refetched, and the panel printed *"1 day
   of weather unavailable"* nightly. The test harness hid it by minting local dates off the UTC clock.
2. `borrowFromFilter` returned a *count* and the caller did `stillMissing.slice(borrowed)`, assuming
   the parent covered the first N holes when it returns an arbitrary subset. A parent covering only
   the newest hole left the oldest silently unrecorded — precisely the "absent day reads as *no snow
   fell*" failure D161 step 4 exists to prevent.
3. The snow headline paired a whole-window total with the most recent snow day under the word
   *since*: *"4.3 in of snow since Feb 6"* when 0.4 in fell since Feb 6. Now *"…of snow, last on
   Feb 4"*. D3 broken by grammar rather than by inference.

**⚠ The panel was invisible on the running web app, and it was not a bug.** `weatherArchive` is not
deployed to `agile-bee-397` — the branch is unpushed and undeployed, so the action throws, the
component's deliberate fail-open-and-quiet `catch` swallows it, and `rows.length === 0` renders
`null`. `pnpm convex-dev --once` from `packages/convex` fixes it. Worth knowing that **a missing
deployment and a lake with no weather are indistinguishable on screen** by design.

**One finding left unfixed and unchanged:** `wind_direction_10m` in the shared `HOURLY_VARS` takes
every weather call to 1.1× billing weight for a variable only the archive parses. Documented as
deliberate and pinned by two tests; splitting the archive's variable list is a cost decision, not a
bug fix.

---

## D162 — The sun is weighted by energy and albedo, never by hours

**Founder question, 2026-09-03:** *"An hour of sun at solar noon vs at sunset are going to have very
different effects on the ice, right?"*

**Right, and `hoursOfSun` could not see the difference.** Irradiance on a horizontal surface scales
with the sine of the solar elevation angle; at 44°N in January the sun peaks near 25° (sin ≈ 0.42)
and reaches zero at both ends of the day. A duration counts a noon hour and a dusk hour the same. So
does a 6-hour December day and a 6-hour March day, which are not remotely the same event.

**The fix is not to reweight the hours — it is to stop using hours.** `shortwave_radiation` is
already in `HOURLY_VARS` and already summed into `insolationWhM2`; irradiance has the solar geometry
inside it by construction, so the correct measure was one field away and simply unused.

**⚠ And the larger term was missing entirely: albedo.** Fresh snow reflects 0.8–0.9 of incoming
shortwave; bare clear ice reflects ~0.1, with observed lake values as low as 0.075. An identical
3 kWh/m² day therefore deposits roughly **9× more energy into black ice than into the same lake under
5 cm of snow**. Any sun term that ignores the surface is wrong by more than it is right. Three fields
land:

- **`absorbedInsolationWhM2`** — Σ shortwave × (1 − albedo), with albedo estimated per *hour* from
  that hour's snow depth. Per hour, not per day: a shallow cover that melts out by noon leaves the
  afternoon absorbing like bare ice, and the afternoon is the one that matters.
- **`sunlitThawHours`** — hours both above freezing and genuinely sunlit (≥ 120 W/m²). The founder's
  own observation, and the mechanism the literature agrees on: *"a single afternoon with sun above
  freezing will make the ice's surface sticky and soft in a way that kind of ruins it."* Shortwave
  penetrates clear ice and melts it internally at the grain boundaries, producing candled, rotten ice
  with little load-bearing capacity — a process that runs while the **air is still below freezing**,
  which is exactly why air temperature alone under-describes a spring thaw. A grey 2 °C day and a
  sunny 2 °C day score identically on `hoursAboveFreezing` and differently here.
- **`meltIndexMm`** — the standard *enhanced temperature-index* form from glaciology,
  `M = TF·T + SRF·(1−α)·SW`, which exists precisely because pure degree-day models miss that melt is
  governed to a large extent by radiation. Our SRF is not a tuned parameter: it is the latent heat of
  fusion, 92.8 Wh/m² per mm. Only TF is empirical, and it is the obvious thing for D160's instrument
  to fit.

**Three guardrails, matching D160's.**

- **`meltIndexMm` never reaches a skater surface, in any unit, under any label.** It is a number
  about a *model*, and an implied millimetre of melt is one step from a load-bearing claim. Its only
  legitimate readers compare it against reality (the operator instrument) or spend money on it (the
  season close).
- **The panel line stays an observation.** *"7 sunny hours above freezing, over 2 days"* names
  weather. It does not say the ice is soft, even though that is why the line is worth printing.
- **`hoursOfSun` survives, with a warning on it.** It is the right answer to *"was it sunny?"* and
  the wrong answer to *"how much did the sun do?"*, and now says so in its docblock.

**⚠ What this does not model, and should not be read as modelling:** snow insulation of the ice
below, water depth, current, springs, wind-driven turbulent exchange, or ice thickness. Albedo here
is a property of the *snow*, inferred from depth alone — nothing in the archive knows whether the ice
underneath is black, white, or gone.

---

## D163 — The season closes on the signal we already had, and nothing was reading it

**Founder question:** *"Wait — the season gate never closes? How do we know when a season is over?
Does that affect our ability to notice when a new season begins?"*

**Correcting the review's framing, because it changes the work.** The review said the close had to be
designed. It did not: **`ingestWindow` has computed `closesOn` since N6e** — ten consecutive days on
which every ordinary site went without an overnight freeze, measured from `winterFrom`, calibrated
against real 2025-26 weather to land on 5 May 2026 against a typical Vermont ice-out of mid-April to
early May. What was missing was three lines of wiring:

1. `imageryIngestSeasons` had **no column** for it.
2. `maybeCheckSeasonOpen` returned `skipped: 'already recorded'` on **any** row, so once a season
   opened the checker never looked again and the computed close was thrown away every day.
3. The weather sweep's gate therefore had only one edge — `opensOn` present — and ran from
   mid-November to the July label rollover: **~228 days against the ~151 D161 was costed on.**

**No, it does not affect noticing a new season.** `maybeCheckSeasonOpen` keys on the season *label*
(D63's July boundary), so a new season is a new row and the gate re-arms on its own. Closing one
season and opening the next are independent.

**⚠ The one thing that could not be reused, and would have failed silently.** A live checker cannot
re-derive `winterFrom`: `past_days` is 92, so by the April tick that would actually close a season
the December date the region froze is months outside the fetch window. `ingestWindow` would find no
`winterFrom`, return `closesOn: null`, and the season would never close — with the logs reporting a
perfectly tidy open window. So the closing half is split out as `thawClose(sites, winterFrom)` and
fed the **recorded** date.

**Three consumers, one signal, and the reluctance is right for all of them.** Imagery stops cutting
granules; the Tier-B weather sweep stands down; the archive stops growing. All three would rather be
two weeks late than one week early — closing early truncates the melt-out record *and* blinds
discovery during the last skateable weeks of the season, which is when the ice is most marginal and
a skater most wants to know what the weather has done to it. Against a budget with ~2 M calls spare,
buying that reluctance costs nothing worth counting.

**⚠ What the close is NOT, and must not become.** It is a coarse region-wide *ice-out* signal for
gating spend. It is **not** a per-lake claim that skating is over, and D162's melt fields must not be
promoted into one. A lake is not a region, and the whole argument of D161 — that a gate and a
discovery predicate should not share a threshold, a code path, or a bug — applies here unchanged.
The founder's *"several days like that ruins it"* is a real signal and its home is the **panel**, as
observations about weather, not a switch that turns anything off.

---

## Why this phase exists

Today the weather block is two lines: an NWS alert strip when one is active, and *"Next 12 hours:
22–31°F, snow starting 8 PM."* That is enough to answer *"is a storm coming"* and nothing else.

The question a skater actually has is not a weather question. It is: **do I get in the car.** That
decision is made against a body of ice whose history is invisible — how many nights it held below
freezing, whether the night it froze was calm or blowing, whether the two inches that fell on Tuesday
are still sitting on it. A general weather app cannot answer it, because a general weather app is
about a town and this is about a lake. And the part of it that matters most is the part no weather app
shows at all: **the past.**

So this phase is a weather app, deliberately, but a narrow one. No pollen, no air quality, no UV
index, no severe-weather portal. One place, already on screen, with the last few months of its own
history attached.

**The founder framing, 2026-09-02:** *"I am describing a weather app! But a focused one — you can't
just look up anywhere, and you don't get all the other data those come with that don't matter. And
it's precisely where you're already looking, no need to open another app and find the nearest
town/address/zipcode for the body you were already looking at."*

---

## What is already built, and where the seams are

Nearly all of the machinery exists. This phase is mostly a re-keying, one new table, and two new
surfaces.

| Seam | Where | What it gives us |
|---|---|---|
| Open-Meteo fetch, split past/forecast | `packages/convex/convex/weather.ts:121-234` | `forecast_days`/`past_days` handling, unixtime + offset arithmetic, the D74 past/forecast wall |
| Hour-bucketed shared cache | `weather.ts:63`, `weatherCache` / `weatherForecastCache` | concurrent viewers of one lake already collapse to one fetch |
| Sample-point resolution | `packages/convex/convex/lib/sampling.ts` | `nearestSamplePoint`, multi-point giants, one point for all four consumers |
| The reducer | `packages/core/src/weather.ts:139-253` | freezing/thaw degree-hours, longest freeze run, freeze-thaw cycles |
| Wind climatology × fetch | `packages/core/src/windRose.ts`, `fetchProfileM` in the corpus | `exposure[k] = winterFrequency[k] × fetchM[k]` over 16 sectors, per body |
| Season boundary | N5a | when a season opens and closes, already a first-class concept |
| A time-indexed raster layer | `apps/web/src/components/useFreezeUpFrame.ts` | lane pool, cross-fade, `sourcedata` reveal gate |
| Scrubber geometry | `packages/core/src/scrubberTrack.ts` | notch math, platform-agnostic, zero imagery knowledge |
| Cut-on-Fly, publish-to-R2 | `scripts/imagery/` | the three-part split: *what to cut* / *how* / *where it runs* |

**The one thing that is wrong** is `samplePointKeyFor` (`weather.ts:68`):

```ts
`${lat.toFixed(3)},${lng.toFixed(3)}`   // ~110 m
```

Run against the merged corpus (`scripts/etl/.scratch/merge/bodies.ndjson`, 24,948 bodies with an
interior point) that key produces **24,832 distinct values.** One per lake. The cache shares nothing.

It is invisible today because both weather actions are drawer-open-only, so the hour bucket collapses
concurrent viewers of the *same* lake and nothing ever asks for two. Every feature in this phase makes
it visible at once.

| rounding | ≈ cell (at 44°N) | distinct keys | bodies/cell |
|---|---|---|---|
| `toFixed(3)` — today | 110 m | **24,832** | 1.0 |
| 0.02° | 2.2 × 1.6 km | 17,385 | 1.4 |
| **0.05°** | 5.6 × 4.0 km | **8,221** | 3.0 |
| **0.1°** | 11 × 8 km | **3,043** | 8.2 |

It is also buying nothing. Open-Meteo's US best-match resolves at ~3 km (HRRR) to ~13 km (GFS). A
110 m key asks a model with roughly three thousand distinct answers for twenty-five thousand of them.

---

## The cost model

Everything below is priced against **Open-Meteo's free tier: 10,000 calls/day, 300,000/month,
non-commercial** — which is what [`00-vision.md:144`](./00-vision.md) commits to ("passion /
open-source project; lean on free tiers"). Their weighting is roughly

> `calls ≈ ceil(days / 14) × (variables / 10)`

from their own worked example: *"2 weeks of data with 15 weather variables will be calculated as 1.5
API calls, while 4 weeks of data equals 3.0."*

**We cross the 10-variable cliff no matter what.** `HOURLY_VARS` is exactly 10 today
(`weather.ts:50-61`). The additions this phase needs — `wind_direction_10m` (the fetch-profile
multiply), `precipitation_probability` (planning), `weather_code` (icons), `dew_point_2m` (frost and
rime) — put us at **14**, a flat 1.4× on every call. Dropping feels-like and humidity as offered saves
about 13% of weighted cost, not a tier; so keep whichever is genuinely useful. Recommendation: keep
`apparent_temperature` (a skater stands on wind-exposed ice for hours — it is the number they feel),
skip `relative_humidity_2m` in favour of `dew_point_2m`, which is the better frost signal at the same
price. ⚠ `precipitation_probability` exists only on forecast hours; it is null in the past and must not
reach the reducer (the D74 wall at `weather.ts:380-386`).

### What each option actually costs per day

| strategy | cells | calls/day | verdict |
|---|---|---|---|
| corpus-wide, 0.05°, hourly refresh | 8,221 | ~276,000 | the entire *monthly* allowance, daily |
| corpus-wide, 0.05°, once daily | 8,221 | ~11,500 | over the 10k/day limit |
| **corpus-wide, 0.1°, once daily** | 3,043 | **~4,300** | **fits, with room** |
| favorited/skated only, 0.05°+elev, once daily | ~2,000 est. | ~2,800 | fits |
| everything else, on demand | — | low hundreds | free |

That table *is* the architecture. The founder's two-tier call lands exactly on the affordable line.

### Storage is not the constraint, and it is not close

Convex Professional includes **50 GB database storage and 50 GB I/O**. A season of daily summaries:

- ~40–60 numbers per cell-day (min/max/mean temp, hours above and below freezing, FDD/TDD integrals,
  rain and snow split, snow depth, wind run, a 16-sector wind-direction histogram, sunshine hours)
  ≈ **1.2 KB** as a document, or **~36 KB per cell for a whole 150-day season** stored columnar.
- 0.1° corpus-wide: 3,043 × 150 × 1.2 KB = **548 MB/season** (≈110 MB rolled up columnar).
- 0.05°+elev for the precompute set: ~2,000 × 150 × 1.2 KB = **~360 MB/season**.
- **Ten seasons of both still fit inside the included 50 GB.**

So the answer to *"should we store a whole season?"* is an emphatic yes. **Storage was never the
expensive part. Acquisition is** — and even that is a one-time ~30k calls per season at 0.1°, which is
three days of free budget, spread over a week.

---

## D152 — The weather cache key is a two-tier grid, not a coordinate

**Tier A — the browse tier: `0.05° + 100 m elevation band`.** Full detail, on demand, for any body a
user opens. 0.05° is ~2× HRRR's native cell and loses nothing the model resolves.

**The elevation band is not optional, and it is why this isn't simply "round coarser."** Open-Meteo
lapse-rate-downscales temperature to whatever `elevation` you pass, and the corpus is at 99.5%
elevation coverage after the N7-3 campaign. In the Greens, the Adirondacks and the Whites a valley
lake can sit 400 m below its grid cell's mean elevation, and the default answer is then wrong by
several degrees — across freezing, which is the only threshold we care about. Passing the lake's real
elevation fixes it; including a coarse band in the key is what keeps the fix from fragmenting the
cache back to one-key-per-lake.

✅ **Measured 2026-09-02 — 100 m bands, and the cost is ~1.16×** (see the header block for the three
samples and the method's limits). Tier A is **~9,500–10,500 keys**, cache sharing ~2.6 bodies/cell.
The worry that banding would fragment the cache back toward one-key-per-lake was wrong: in this
terrain, 200 m bands are already within ~1% of 300 m bands, so the elevation axis is coarse-grained by
nature and 100 m buys real fidelity for almost nothing.

**Tier B — the filter tier: `0.1°`, no elevation.** Corpus-wide, cron-populated, powers cross-body
queries only. 11 km and no lapse-rate correction is genuinely coarser weather, and that is the
accepted trade: it is a *filter*, and a filter's job is to narrow 25,000 lakes to a dozen worth
opening. The dozen then get Tier A on open.

**Why two tiers rather than one compromise.** A single key fine enough for the detail panel cannot be
afforded corpus-wide; a single key cheap enough corpus-wide is too coarse for the panel. The two
answer different questions and the cheaper one is allowed to be wrong in ways that only change *which
lakes you look at*, never what the panel then tells you about them.

---

## D153 — Past weather is a durable archive, not a cache; 92 days is the lazy-backfill horizon

`weatherCache` prunes at 24 hours (`storageHygiene.ts:47`) because its rows are *window summaries*
keyed on `(samplePointKey, windowStartMs, windowEndBucketMs)` — reachable only during their own hour.
That was right for the strip. It is wrong for a season archive, for the same reason
`weatherForecastCache` was split out of `weatherCache` in the first place (`schema.ts:1239-1252`):
**a row that describes what happened between two past instants is true for ever.**

New table, `weatherDays`, keyed `(cellKey, tier, dayMs)`. Never pruned on the hygiene schedule.

**The finding that resolves the founder's worry.** The concern was that on-demand fetching gives *"a
specific window of days, not a full timeline."* It does not: **Open-Meteo's `past_days` reaches 92
days on the same forecast endpoint we already use.** The first person to open a lake in February
backfills the entire season to date in one request — ~9 weighted calls — not just the week before
their visit. Lazy backfill is not lossy. The rule is: **92-day backfill on first touch of a cell in a
season, then one appended day per day.**

**⚠ And the corollary that supersedes a Phase 10 rule.** Phase 10 banned the ERA5 archive API outright
because its ~5-day lag made it wrong for recent windows. That reasoning does not extend past 92 days,
where the forecast endpoint simply has no data and the archive is the only source — and a five-day lag
is meaningless when the question is about last February. **The boundary is 92 days: forecast+`past_days`
inside it, archive outside it.** This unlocks prior-season history and a per-cell climatology baseline
(*"this lake has 40% more freezing degree-days than a normal February 1"*), which is arguably the most
compelling thing in this document and is deliberately **deferred** — see the register.

**Shape, and the write-cost tension.** One document per cell-day is cheap to append and more expensive
to store and read; one columnar document per cell-season is ~5× smaller and reads a full-season chart
in a single shot, but patching it daily rewrites the whole thing (3,043 × 36 KB ≈ 110 MB/day of write
I/O at Tier B). **Resolution: append daily rows through the live season, then roll up into one
columnar season document when N5a closes the season.** The rollup is the natural home for the
season-boundary machinery we already have.

**Off-season the cron idles.** Nobody is skating in July. Suspending Tier B between N5a's season close
and open roughly halves the annual call spend for nothing given up.

---

## D154 — Precompute follows evidence of use, never the whole corpus

Founder call, and it is the right one: *"maybe we should consider pre-computing for any body that has
been favorited by at least one user, and maybe even every body that has been skated on by any user in
the past year… most of the 25,000 bodies probably do not get skated on, and we'll learn that with
time."*

The precompute set is **the union of: favorited by ≥1 user · has ≥1 report · has ≥1 hazard · has ≥1
bounty · appears in a recorded track**, over a rolling window. Everything else is Tier A on demand and
costs nothing until someone cares.

This is the same instinct as the imagery archive being built by *listing R2* rather than remembering
what was launched — **let the artifact tell you what exists** instead of maintaining a prediction of
it. Here the artifact is user behaviour.

⚠ **Year one has no three-year history to look back on.** Dev holds 14 favorites, 2 reports,
3 hazards, 1 bounty across 16 bodies — all of it the founder's own. The first season's set is whatever
gets favorited and reported, and it starts at approximately nothing, which is fine: Tier A on demand
covers the rest and costs nothing until someone looks. The rolling window becomes meaningfully
selective in season two. **Size the job off the query, never off an estimate.**

**But the Google Group corpus tells us what the steady state looks like, and it is small.** 116
distinct bodies discussed across a full season; 75 with ≥3 mentions; the top 25 carrying 61% of all
traffic (see the header block). Favorites will be longer-tailed than discussion — a favorite is
personal, and this corpus is one state's community — so treat 116 as a floor. Even at 1,000 unique
favorited bodies the precompute tier costs ~1,200 calls/day. **This tier will not be what breaks the
budget**, which is worth knowing up front so the job is built for correctness rather than for thrift.

---

## D155 — The forecast is a planning window, not a moment

The first draft of this idea was *"show the forecast at now + drive time."* The founder corrected it,
and the correction is the feature:

> *"If I'm checking before bedtime for a lake I plan to wake up early and skate, or midday at work
> thinking about where I'll go at 5pm, the start time I care about isn't just now + drive. But also,
> the weather leading up to when I'd get there still matters! If it's going to snow for hours
> overnight, I want to see that instead of skipping it."*

So the forecast surface is **a target window you choose, plus the run-up to it** — not a point
reading. Two consequences:

- The 7-day morning/afternoon/overnight grid and the 12-hour hourly detail are **not two panels.** The
  grid is the *selector*; picking a cell scrolls the hourly detail to that window. One interaction,
  and the same scrubber idiom the imagery layer already established.
- **The run-up is drawn, not hidden.** Between now and the selected window the hourly strip stays
  visible, because "six hours of snow ending at 4 AM before a calm clear morning" is a *reason to go*
  and a panel that only showed the target hour would have hidden it.
- Drive time (Phase 4) shifts the default selection, and nothing more. It is a hint about which window
  opens first, not a constraint on which windows exist.

**Future snow matters too, and for the same reasons past snow does.** Phase 10's framing — snow as a
since-freeze quantity — was right about the past and incomplete about the future. Both get shown.

**⚠ The authority ordering survives.** `apps/web/src/components/WaterBodyDetail.tsx:215-216` encodes an
explicit claim: **NWS alert > observation > prediction.** These panels are large and they are
predictions, and the temptation is to fuse everything into one "Weather" card. Do not. The alert stays
on top and the past panel stays visually distinct from the forecast panel, because the D74 wall
(`weather.ts:380-386`) is a type in the code and it should be a boundary on the screen.

---

## D156 — Radar publishes its own blindness; resolution is not the fix

**The founder's question:** *"do we fix that by going with the higher resolution options that exceed
our budgets? Or by using RainViewer or LibreWXR?"*

**Neither, and the premise is worth dismantling.** NEXRAD's failure in the Adirondacks and the Greens
is not a resolution problem — it is beam geometry. The beam rises with distance from the radar and
ridges block it, so the lowest usable scan passes *above* shallow winter precipitation. No product
tier changes that, and RainViewer and LibreWXR both derive from the same national feed. Buying a
better renderer of a beam that never reached the valley floor buys nothing.

**What does help is fusion plus an honest quality field**, and NOAA's MRMS has exactly both. MRMS
merges every radar with surface gauges, satellite and model fields — filling some of what any single
radar misses — and it publishes a **Radar Quality Index that explicitly encodes terrain blockage and
beam height.** That is the fix: **not making the radar see better, but drawing where it cannot see.**
A low-RQI region renders as a hatched "radar can't see here" mask rather than as clear sky, and the
layer stops lying by omission.

This is D150's rule (*derived classification is an observation, never counsel*) applied to a sensor:
the honest statement is about the instrument, not the sky.

MRMS is on the AWS Registry of Open Data (`s3://noaa-mrms-pds`), GRIB2, ~2-minute cadence for the
rapid products, free egress.

**On RainViewer — the earlier read was wrong and the founder's correction stands.** Their terms cover
*"personal, educational, and small-scale community use,"* which an open-source project with no paid
product and a projected ~1,000 users plainly is. The real constraint is the posted 1,000 requests/day
and their guidance to *"cache aggressively and avoid hammering endpoints."* Server-side proxying with
a shared cache — one fetch per frame for all clients, not one per client — brings a whole day's usage
to roughly 150–300 requests. **RainViewer is a legitimate v1** and the fastest path to something on
screen. It just doesn't solve the mountain problem, because nothing at that layer does.

---

## D157 — Radar is cut, not served

**LibreWXR ([librewxr.net](https://librewxr.net/), AGPL-3.0) is a genuinely good find** and it
validates this whole approach: it ingests exactly the source recommended above (NCEP MRMS
quality-controlled mosaics, with IEM as fallback), renders standard XYZ PNG/WebP at 256 and 512 px,
and adds a 60-minute optical-flow nowcast blended with HRRR. It is, essentially, the pipeline this
section would otherwise have specified.

**But it is architected as an always-on server, and that is the expensive shape.** It states 3–10 GB
RAM for a single-container deployment. On Fly that is `performance-1x` at 8 GB — **$63.36/mo, ~$760/yr**
— for a service that produces a few megabytes every ten minutes.

**The cheap shape is the one `scripts/imagery/` already established:** an ephemeral cutter on a Fly
Machine, publishing `.pmtiles` to R2, with the three-part split intact (*what to cut* in `src/`, *how*
in the Dockerfile, *where it runs* in the Fly files, so the host stays swappable). Priced out:

| item | quantity | cost |
|---|---|---|
| Tiles per frame, z4–10, 5-state region | 1,576 tiles ≈ 3–6 MB | — |
| Live set: 12 past frames (10-min) + 6 nowcast | ~100 MB | **$0.0015/mo on R2** |
| 30-day rolling archive at 10-min cadence | 4,320 frames ≈ 21 GB | **$0.32/mo on R2** |
| R2 egress | any | **$0** |
| MRMS ingest from AWS Open Data | ~1.4 GB/day in | **$0** (free egress; Fly ingress free) |
| Fly cutter, ~1 min per 10-min cycle (~10% duty) | `performance-1x` 4 GB | **~$4–5/mo** |
| **Total** | | **~$5/mo** |

**Radar tile storage is effectively free.** The entire cost is compute and, more honestly, the
operational burden of something that must run every ten minutes for ever — versus the imagery cutter,
which runs per satellite pass and can fail quietly for a day without anyone noticing.

**So the decision is: borrow LibreWXR's approach, not its deployment.** Read it (AGPL means we can),
copy its source selection and its RQI handling, and run the cut in our own pattern. ⚠ If we ever
*deploy* a modified LibreWXR as a network service, **AGPL §13 obliges us to offer that modified source
to its users** — a real obligation even for an open-source project, and one that belongs in
[`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md) as a new L-item before any
such deployment. They offer separate commercial licensing, which implies they expect this to bite.

**Reuse on the client, honestly assessed.** `useFreezeUpFrame.ts`'s lane pool and `sourcedata` reveal
gate is the crown jewel and is *nearly* generic — parameterise the id prefix, URL builder, attribution
and anchor. `scrubberTrack.ts` lifts unchanged. But `FreezeUpScrubber.tsx` is 558 lines mostly *about*
blocked stops, cloud fraction, SCL bands and granule seams, none of which a regular 10-minute radar
timeline has, and it is **drag-only with no play/pause** — an animation loop is new work. Two
structural mismatches to budget for:

- The imagery control is **gated on a single lake being selected** (`ImageryControl.tsx:12-36`,
  `MapView.tsx:1578`), per D146's one-control-per-lake rule. Radar is **viewport-scoped**. The
  placement argument does not transfer.
- **There is no layer registry.** Today's toggle is one boolean plus a hazard checkbox. A second
  overlay means either a third prop pair or a real refactor, and this phase should pay for the
  refactor rather than discover it.

One piece of good news: radar is plain raster XYZ, so **mobile gets it for free.** MapLibre Native
reads raster and `pmtiles://` natively. The summer aerial never shipped on mobile only because
`useImageryReveal` needs a Canvas2D context; radar has no such dependency.

---

## D158 — Paying Open-Meteo is a season-two decision with a written trigger

**Open-Meteo API Standard: $29/month, or $319/year — 1,000,000 calls/month**, with a commercial-use
licence, an API key, a dedicated endpoint, no daily rate limit, and a 99.9% uptime target.

**Founder call, 2026-09-02:** not this season. *"It's not out of the question, but it's probably not
going to happen for this first season until we see what community adoption looks like."*

Documented here so the trigger is written down rather than rediscovered. **1M calls/month is ~33k/day —
7.7× the free daily budget**, which is precisely what the corpus-wide 0.05° tier needs (~11,500/day)
with room for the on-demand path to grow underneath it. In other words, **paying collapses the two
tiers into one**: D152's Tier B stops being a coarser approximation and the feed filter runs at the
same resolution as the panel.

**Buy it when any of these is true:**

1. Free-tier usage exceeds ~7,000 calls/day sustained (70% of the ceiling) — instrument this in the
   Phase 7 analytics rollups from day one, since there is no counter today.
2. The feed's weather filter proves used enough that Tier B's 11 km coarseness is a felt limitation
   rather than a theoretical one.
3. The project stops being plainly non-commercial, at which point the free tier's licence no longer
   covers us regardless of volume.

⚠ **There is no request counter anywhere in the weather path today.** No token bucket, no rate
limiter, no metric. Trigger (1) cannot fire until one exists, so the counter is in scope for this
phase, not deferred.

---

## D159 — Weather-first discovery filters **cells**, then bodies — and never the report table

**Founder call:** *"You should be able to search for bodies that meet some criteria, even if reports
haven't been written about them in the specified window… I don't want to limit discoverability to only
filtering on reports that exist."*

This is the most consequential thing in the phase, because it inverts what the corpus is *for*. Today
discovery is report-shaped: you find lakes because somebody wrote about them, which means 25,000 bodies
are functionally invisible and the handful with reports get all the attention — a rich-get-richer loop
that a new lake can never break into. **Weather is the first signal we have about a lake that requires
no human to have visited it.** Filtering on it makes the whole corpus discoverable for the first time.

**The read-path danger is the one this repo has already been burned by twice.** A predicate like
*"three nights below 20°F and no snow since"* over 25,000 bodies is a full-corpus scan per query, which
is precisely the shape that made `listInViewport` read-cap-fragile at N1 and cost the N6d access load
105 GB of I/O. It must not be built that way.

**So the filter evaluates over Tier B cells, not bodies.** There are **3,043** of them and they are
small documents. The pipeline:

1. Evaluate the predicate over the 3,043 Tier-B cell-days → a matching cell set (typically a few
   hundred, often far fewer).
2. Resolve matching cells → bodies through a **denormalised `weatherCellKeyB` on `waterBodies`, with
   its own index** — stamped at import, one more field alongside the N1 ladder-grid cells. Only
   matched cells are ever read as bodies.
3. Intersect with the user's Phase 4 drive-time band **last**, because it is per-user and
   uncacheable while everything above it is shared across every user in the region.

The cost is then *proportional to the answer*, not to the corpus. This is the same lesson as N1's
two-tier fix, one dataset over.

**⚠ PR 2 correction — the per-cell digest is not an optimisation, it is the only shape that fits.**
This was written as *"better still, precompute the predicate inputs"*, which undersold it into a
nice-to-have. Do the arithmetic: **3,043 Tier-B cells × a 7-day predicate window = ~21,300 documents
in one query**, against Convex's **16,384-document read cap** — and that is *before* resolving a
single body. The founder's own example query (*"three nights below 20°F and no snow since"*) does not
run. Steps 1–3 above describe a pipeline that hits the cap on its headline use case, which is the
third time this repo has drawn that shape (`listInViewport` at N1, the N6d access load at 105 GB).

So step 1 becomes: **one rolling digest document per cell**, updated by the daily sweep, holding the
handful of quantities filters ask about — nights below each threshold, days since snow, freeze-run
length, thaw hours, and D162's `sunlitThawHours`. 3,043 small documents, one read each, no window
multiplier. Adding a filter dimension later then means adding a field, not a scan.

**⚠ PR 2 correction — `weatherCellKeyB` as a single field cannot represent a giant.** Hole 2 answers
*"does `weatherDays` store one row per sample point for multi-point bodies? It should"* — and step 2
above then stamps exactly **one** cell on `waterBodies`. Champlain spans many, and Convex has no
array/contains index, so a single field cannot be made to work by widening its type. Two honest
options, and it is a schema decision that hole 7's migration should settle rather than discover:

- **Anchor cell only.** Cheapest; a giant is findable through the cell holding its interior point and
  invisible through the others. Then the result card must say so, or the filter promises a claim
  about a lake it checked in one spot.
- **A `bodyWeatherCells` join table** (`cellKeyB` → `bodyId`, indexed both ways). One more small
  table, and it makes *"which part of the lake matched"* answerable — which is what the card needs
  anyway, and what the sub-area question below is really asking for.

**⚠ A spec gap worth catching now: "no snow *since*" has no anchor without a report.** Every
since-style predicate we have today borrows its start from a user-visible entity (`resolveStripAnchor`
derives it from a report's `skateEndTime` or a hazard's `lastConfirmedAt`, `weather.ts:297-336`). A
body with no reports has no such anchor. Weather-only predicates therefore need weather-only anchors —
*"no snow in the last N days"*, or *"since the last detected freeze-up transition"* — and the copy must
say which, because *"no snow since"* with an invisible anchor is a claim the user will read as more
specific than it is.

**Where it lives: both surfaces, one filter state.** The founder's instinct — *"maybe both, or even
carry over between the two until you clear your filters"* — is right, and it implies a single shared
discovery-filter store that the map and the feed both read, rather than the map's
`MapSelectionContext` and the feed's existing filter row each keeping their own. Carrying the filter
across a navigation is the entire point: you narrow on the feed, switch to the map, and the same dozen
lakes are what is drawn.

**And it changes what the feed *is* — deliberately.** Today the feed lists reports. A weather filter
that matches lakes nobody has written about produces a list of **bodies**. **Founder call: the feed
becomes heterogeneous, and it gets renamed from "Newsfeed" to "Latest"** — *"it allows us to get more
creative in the future, too."* The rename is doing real work: *Newsfeed* names a source (posts),
*Latest* names an ordering, and an ordering can admit new card types — a body that just froze, a
hazard that just cleared, a bounty that just opened — without the name becoming a lie each time.

**The escape hatch is a user-set boolean at the top of the filter row, alongside the existing ones:
"only show reports."** Anyone who wants the old feed keeps it in one tap, which is what makes widening
the card vocabulary safe rather than disruptive.

⚠ Card types map onto the open-question-4 taxonomy: a **body** result is an *Overview* object, a
**report** result is a *Reporting* object. Keeping that correspondence visible in the card design is
what stops a heterogeneous feed from reading as an undifferentiated pile.

---

## D160 — The ice-thickness estimate is an admin calibration instrument, and it ships dark

**Founder call:** *"Can we calculate this number and show it to admins-only just as a curiosity? I'm
very interested to see how it performs compared to reality through this season."*

**Yes — and there is established precedent for exactly this shape.** N5c's hazard-identity advisory
*ships dark on purpose*; N6e's phenology dates are *derived dark, operator-visible, no skater surface*
(D151). Phase 7 already provides the role-gated `/admin` tree to put it behind. A number that is
computed, stored, and shown only to operators — so it can be judged against reality before anyone
decides whether it earns a skater surface — is a pattern this project already runs.

**It is also more than a curiosity, and that is the argument for building it now rather than later.**
`reports.iceThickness` (`schema.ts:1351-1358`) carries a `method` discriminator where `estimated` is
explicitly lower-trust than a measurement. So a season of *computed-vs-measured* pairs is a genuine
calibration dataset, and it can only be collected by a season passing — start it late and the answer
arrives a year later. The classic Stefan form `h = α√(FDD)` gives a one-parameter model, and α is
exactly what a season of paired observations would fit. Calibrate against `measured` entries only;
`estimated` ones would be fitting the model to somebody else's guess.

**Three guardrails, none optional:**

- **Structurally admin-only, not visually admin-only.** The number never enters a payload a skater
  client receives. Role-gated at the query, in the same way the Phase 7 surfaces are — not rendered
  and hidden, not fetched and filtered client-side.
- **It never feeds anything.** Not hazard decay, not bounty freshness, not trust, not the reports
  themselves. It is measured *against* the world, and nothing reads it back. The moment a derived
  thickness becomes an input, it acquires authority it has not earned.
- **Graduating it to a skater surface requires its own decision.** This D authorises a dark
  instrument and nothing more. D3 (never a safety verdict) and D150 (derived classification is an
  observation, never counsel) both still bind, and a thickness in inches is the single most
  counsel-shaped number this app could ever publish.

**The honest expectation:** it will probably perform poorly, because air-temperature FDD ignores snow
insulation, wind, water depth, current, and springs — the same variables that make the never-hide
invariant necessary. Learning *how* poorly, with numbers, is worth a season. Learning it privately is
what makes it safe to learn at all.

---

## D161 — The season checker stays the trigger; the cell scanner is what it starts

**Founder question:** *"Does the weather-first discovery over cells replace/play along with our
season-start checker? Would it make sense to conflate the two…? Or is that too costly compared to our
current season starter, and we should only start this ~3,000-cell scanner once we know the season has
begun?"*

**Play along, and the second instinct is the right one — but the dependency runs the opposite way from
how it looks.** The cheap checker is not made redundant by the scanner; it becomes **the thing that
starts it.**

**The cost case is decisive.** `maybeCheckSeasonOpen` (`imageryIngest.ts:179-214`, daily cron) asks
Open-Meteo for `temperature_2m_min` at 25 sites **in a single multi-coordinate call** — about **365
calls a year.** Tier B is ~4,300/day. Running the scanner year-round is **~1.57M calls/year against a
free-tier ceiling of ~3.65M** — roughly 43% of the annual budget, most of it spent in July asking
frozen-lake questions about warm water. The Google Group corpus puts 97% of a season's activity in
November–March, so gating costs nothing real and saves nearly half the annual allowance.

**They are also different questions, and coupling them would be a category error.**

- *"Has winter started anywhere in the region?"* is coarse and region-wide. 25 sites is plenty; more
  resolution would not make the answer better.
- *"Which specific lakes look frozen?"* needs per-cell fidelity, because the whole point is
  distinguishing one lake from its neighbour.

**Their failure modes differ too, which is the stronger argument.** A season gate that fires two days
late costs a couple of satellite passes. A discovery scanner that is wrong sends somebody driving two
hours in the dark. These should not share a code path, a threshold, or a bug.

**So the arrangement is:**

1. The 25-site checker runs **year-round, unchanged**, and is the season trigger.
2. It **starts and stops the Tier B cron** at the season boundary (N5a), which is what buys back the
   43%.
3. **During the season, the checker reads `weatherDays` instead of fetching** — the data is already
   there at far better resolution, so the duplicate fetch disappears and the checker gets *cheaper*,
   not more expensive.
4. Tier B then supplies a **better season-*close* signal** than the checker ever had, and the first
   Tier B run of a season hands D159 a region-wide freeze map on day one.

⚠ **What must not happen is conflating "several nights below 20°F in some cell" with "the season has
begun."** A single cold cell in a Adirondack hollow in early November is not a season; it is weather.
The gate wants the coarse, boring, region-wide signal precisely because it is hard to fool.

---

## ⚠ Open question 5 — how a giant gets its weather: sample grid, or sub-areas?

**Founder, 2026-09-03:** *"I think we should be trying to get the best, most localized weather data we
can for large bodies, probably based on their sub-area bays? Rather than one weather report based on
the center point of the lake which most skaters might not even reach."*

**These are two different fixes to two different halves of hole 2, and an earlier thread offered only
the first.** The sample grid answers *"the panel has one reading for a 170 km lake."* Sub-areas answer
*"the one reading is for a place nobody skates."* They compose; they do not compete.

### Measured on dev, 2026-09-03 — and the numbers settle it

128 sub-areas across 22 bodies, resolved to Tier-A cells (0.05° + 100 m band):

| body | sub-areas | distinct Tier-A cells | sharing the body's anchor cell |
|---|---|---|---|
| Lake Winnipesaukee | 48 | 19 | **1** |
| Moosehead Lake | 13 | 9 | **0** |
| **Lake Champlain** | **10** | **10** | **0** |
| Squam Lake | 7 | 4 | 3 |
| Lake Placid | 5 | 2 | 4 |
| Pine River Pond | 8 | 2 | 7 |
| Stillwater Reservoir | 3 | 1 | 3 |

**⚠ Champlain's ten named bays land in ten distinct weather cells, and not one of them is the cell the
panel currently reads.** Malletts Bay, Burlington Bay, Shelburne Bay, Broad Lake — the places people
actually skate and actually talk about (Malletts Bay is 26 mentions in the Google Group corpus,
Button Bay 32, both out-ranking most whole lakes) — are all described today by a reading taken
somewhere none of them are. That is worse than the "one reading for a big lake" framing suggested:
it is one reading for a spot on the lake that is not any of the destinations.

**And the shape is self-limiting, which is what makes it affordable.** On Pine River Pond seven of
eight sub-areas share the anchor cell; on Stillwater Reservoir all three do. Below roughly a cell's
width the sub-areas collapse onto the same key and fetch nothing extra. Cost scales with a lake's
actual geographic spread rather than with a spacing constant — **~60 additional Tier-A cells for the
whole corpus**, against a free tier of 10,000 calls/day.

### The comparison

| | **Sample grid** (`suggestSamplePoints`, 11 km) | **Sub-areas** (`waterBodySubAreas`) |
|---|---|---|
| **What it produces** | A regular lattice of unnamed points | Named places: *Malletts Bay*, *Broad Lake* |
| **Champlain** | ~15–20 points | 10 bays, already drawn |
| **Which one does the panel show?** | ⚠ **Unanswered** — a grid has no target, so the panel must pick, and "point 7 of 18" is not a claim | Falls out: the sub-area the user selected, else the body anchor, and the label names it |
| **Operator work** | One action per body, three bodies owed, judgement on spacing | **None — 128 already placed** |
| **Coverage** | Any body, on demand | Only the 22 bodies that have them |
| **Cost on small lakes** | A grid is placed regardless | Collapses to the anchor cell; free |
| **Serves D159's "where matched?"** | No — a grid index is not a place name | Yes, directly |
| **⚠ Resolution mismatch** | 11 km spacing is **coarser than Tier A's 5.6 × 4.0 km cell**, so adjacent grid points can share a key and buy nothing | Bays are naturally spaced by geography, and the table above shows they separate |

### Recommendation: sub-areas first, grid as the fallback

1. **Sub-areas become the weather unit for any body that has them.** No new data, no operator task,
   and it fixes the sharper half of the problem — the reading describes somewhere with a name.
2. **The grid stays available for giants with no sub-areas.** Memphremagog (41 km) and Connecticut
   River Reservoir (20 km) have none, so they keep today's honest caveat line until either a grid or
   a bay is drawn on them.
3. **⚠ Do not run the grid on Champlain now.** It would create the unanswered question in row 3 above
   — several points, no target, and no decision about which one the panel claims. Sub-areas answer
   that by construction, so let them.
4. This also picks the `bodyWeatherCells` option in D159's second PR 2 correction: the join becomes
   *cell → sub-area → body*, and the result card can say **which bay** matched instead of asserting
   something about 170 km of lake.

### How the parent body describes itself — the spread, not the envelope

**Founder, 2026-09-03:** *"What do you think about combining weather somehow from all sub-areas when
describing a parent body? The highest high, lowest low, most precipitation, most wind… And then offer
an affordance to filter to one of the sub-areas? Or say something like '___ Bay is your best bet for
a good day tomorrow'."*

**The instinct is right and one of the three mechanisms is a trap.** Taking the union of extremes —
max high, min low, max precip, max wind — builds a **day that happened nowhere.** On Champlain the
highest high might be Burlington Bay and the lowest low Missisquoi, 60 km apart; printed as one row
it describes a lake that was simultaneously the warmest and the coldest place on itself. Every number
true, the row false. That is the same failure the review just caught three times in one PR (the
`since`-vs-total snow line, the UTC-vs-local day anchor, the borrowed-days count) and it is worth
naming as a class rather than re-deriving each time.

**⚠ It is also not even consistently conservative, which is the subtler problem.** A worst-case
envelope assumes every axis points the same way, and for ice they do not: *lowest low* reads as
**reassuring** (colder → better ice) while *most wind* and *most snow* read as **discouraging**. So
the composite is a lake that froze harder than any part of it did *and* got more snow than any part
of it did. It is not pessimistic or optimistic; it is incoherent.

**What replaces it: report the spread, and name its ends.** The honest aggregate of ten places is a
range whose extremes are places:

> *Across 10 bays — lows −18 °C to −11 °C. Coldest: Missisquoi Bay. Mildest: Burlington Bay.*
>
> *Snow since Tuesday: none at Malletts Bay, 4″ at Broad Lake.*

Every sentence is true of somewhere real, the variation is presented *as* variation instead of
collapsed, and — the useful part — **the named extremes are the tap targets.** The affordance stops
needing to be explained, because the data does the pointing.

**And when the bays agree, collapse it.** If the cells fall inside a threshold, one line: *"Similar
across the lake."* That is the common case in a cold snap, and printing ten rows of the same weather
is how a panel teaches people to skip it.

**⚠ On *"___ Bay is your best bet"* — no, and this is the clearest D3/D150 line in the phase.** It is
a recommendation to drive somewhere, derived from air temperature alone, by a system that knows
nothing about that bay's depth, current, springs, or whether anyone has been on it. It is the most
counsel-shaped sentence available short of a thickness in inches.

**The honest version is a sort, not a sentence.** Let the user pick the criterion and do the
arithmetic in public:

> *Bays by coldest nights:* Missisquoi · Broad Lake · St. Albans …
> *Bays by least snow:* Malletts · Shelburne …

Same information, same decision reached, and the app never claims the conclusion. *"Your best bet"*
is the app judging; *"sorted by coldest nights"* is the user judging and the app counting. That
distinction is exactly D150's grammar, and it is what lets this ship at all.

### ⚠ The spread is free, and it comes off the tier that already exists

The obvious cost objection — *opening Winnipesaukee now means 19 Tier-A fetches instead of 1* — does
not apply, because **the spread should read Tier B.** Those rows are cron-populated corpus-wide
through the season and cost nothing at read time, and Champlain's ten bays still resolve to seven
distinct Tier-B cells (measured above), which is ample to rank bays against each other. Then:

- **Tier B answers *"which part of the lake"*** — the spread, the sort, the extremes. Free.
- **Tier A answers *"what is it like there"*** — one fetch, for the sub-area actually selected.

That is D152's two tiers applied to one lake instead of to the corpus, which is a good sign the
original split was cut in the right place. It also means the parent-body panel needs **no fetch at
all** to draw its spread, and the drawer stays fast.

**Still open for the founder:** whether the *default* view of a giant is the body anchor with the
spread above it, or the highest-`displayScore` sub-area pre-selected. The spread-plus-anchor is more
honest and the pre-selection is fewer taps; N2 already stores `displayScore`, so either is cheap.

### ⚠ Sequencing: the spread ships with H, and it cannot ship with PR 1

**It reads Tier B, and Tier B is empty until mid-November.** `imageryIngestSeasons` holds **zero
rows** on dev (checked 2026-09-03) — no season has ever been recorded, the checker does not start
looking until October, and D163's gate only opens on a real regional freeze. So the corpus-wide daily
rows the spread ranks bays against do not exist yet. Writing the ranking, the copy, the
collapse-when-they-agree threshold and the extremes labelling against a table nobody can look at,
inside a metered review, on a PR already at 46 files and 8,377 lines, is the wrong order.

Two structural reasons agree:

- **It wants the picker, and H is rebuilding the drawer.** *"Coldest: Missisquoi Bay"* is only useful
  if tapping it does something. Building a bay-picker into today's flat sidebar means building it
  twice.
- **It would force D159's `bodyWeatherCells` decision early**, from the panel side, before E knows
  its read patterns.

**So: with H.** H is otherwise a pure move — low-risk, easy to review — which leaves room for exactly
one real feature, and this is the one that most needs the new IA. Waiting for E would be too late:
the spread is what makes a giant's panel honest, and Champlain is the most-discussed body in the
corpus.

**Nothing is owed by PR 1 to keep this open.** `getWeatherDaysForBody` grows a field rather than
changing shape, and no migration is prejudiced. The interim line — *"this lake is large enough that
weather differs across it — these readings are from one point near the middle"* — is the right thing
to say while the spread does not exist, and it is the same sentence that argues for building it.

---

## Workstreams

**A — Re-key (blocks everything).** Measure Tier-A cardinality with real elevations; implement the
two-tier key; migrate `weatherCache` and `weatherForecastCache`. Both are ephemeral and prunable, so
the migration is *delete and let it refill* — no backfill, no widen→deploy→narrow dance.

**B — `weatherDays` + the season archive.** New table, 92-day first-touch backfill, daily append cron
at Tier B, season rollup on the N5a boundary, off-season idle. Add the request counter here.

**C — The past panel.** The headline. Per-day summaries with the freeze/thaw/snow story, leading with
the two things no general weather app shows: **wind at the moment of freezing** (calm night → black
ice; blowing night → rough ice) and **snow since the ice formed, and whether wind cleared it.** The
wind-rose × fetch-profile multiply already exists in `windRose.ts`; this is largely wiring.

**⚠ The panel is one step from an ice-thickness calculator, and we have already decided not to be
that.** The FDD integrals are right there and the ~1″/15-FDD backbone is written down in
[`phase-10-weather.md`](./phase-10-weather.md). Publish an integer and a reader divides by fifteen.
Observations only — *"four nights below 20°F, calm; no snow since Feb 2"* — never derived ice. This is
D3 and D150, and it is not negotiable in a safety app.

**D — The forecast panel.** ✅ **Shipped as PR 4 (2026-09-11)** — see *§What PR 4 shipped*. Per D155
in principle, per founder call 14 in shape: day cards as the selector, an hourly card row as the
view (all seven days, opens at now), run-up always a drag away, drive time as an "≈ arrival" band.

**E — Weather-first discovery (D159).** Reads Tier B. The founder's target query: *"bodies within two
hours' drive that got at least three nights below 20°F and no snow since."* This is the reason Tier B
exists and the reason a cron exists at all — on-demand fetching cannot answer a question about lakes
nobody opened. Ships as: the per-cell predicate digest, the `weatherCellKeyB` index on `waterBodies`,
the shared discovery-filter store across map and feed, and the body-result card. **⚠ Answer the
feed-shape question (bodies vs reports) before building the card, not after.**

**H — The three-tab drawer IA (open question 4).** ⚠ **PR 2 addition: this was resolved as an open
question and then never listed as work, which is how it got skipped.** PR 1 stacked
`PastWeatherPanel` flat into `WaterBodyDetail` on both clients, adding to exactly the pile the tabs
exist to relieve — the web sidebar now runs alert → access → forecast → wind exposure → bathymetry →
imagery → **past weather** → reports → hazards → bounties, and mobile's drawer snaps at 16/58/94%.
**It blocks D**: there is nowhere coherent to put a 7-day grid plus an hourly strip until it lands.

Ships as:

- **Web: shadcn/ui `Tabs`** (founder call, 2026-09-03) — `Tabs` / `TabsList` / `TabsTrigger` /
  `TabsContent`, which brings the roving-tabindex and `aria-controls` wiring for free rather than
  hand-rolled buttons. ⚠ **Not yet vendored** — `apps/web/src/components/ui/` has fifteen components
  and `tabs.tsx` is not among them, so H starts by adding it. The repo is on **Base UI**
  (`@base-ui/react` ^1.6.0, `components.json` style `base-nova`), *not* Radix — founder correction,
  2026-09-03, and the `add` handles it.
- **Mobile: not shadcn** — the primitives are web-only regardless of which library backs them. A
  three-segment control over the same three content groups, with the tab list pinned outside the
  scroll view so it survives the 16% snap point.
- **One shared tab-selection store, session-scoped and body-independent**, per the founder's
  *"preserve tab selection and see how it feels"*. Comparing five lakes on *Planning* should not
  cost four re-selections.
- **⚠ The NWS alert stays above the tab strip on both clients.** A tabbed alert is an alert you can
  be one tap away from not seeing, and it is what preserves the authority ordering at
  `WaterBodyDetail.tsx:215-216` under the new IA.
- **Nothing is rewritten** — the existing panels are moved into groups, unchanged. Overview =
  machine-compiled facts about the body; Reporting = user-supplied, this season; Planning = weather,
  put-ins, directions, derived season trends.

**F — Radar.** RainViewer proxied server-side as v1; MRMS-with-RQI as the honest version. Pay for the
layer-registry refactor. Extract the lane pool from `useFreezeUpFrame.ts` first.

⚠ **PR 2 founder call: F stays in, and it runs season-gated.** The review recommended deferring it
past season one as the only workstream carrying a permanent recurring cost and a
runs-every-ten-minutes-forever obligation. Overruled, with a reason: *"I think it's a real winning
feature that will excite people about switching to this app."* That is an adoption argument, and the
adoption argument outranks a ~$5/mo infrastructure argument — the cost was never the real objection,
the *operational* burden was. So two conditions ride along:

1. **The cutter is gated on `closesOn`/`opensOn`, exactly like the Tier-B sweep** (D163). A radar
   loop nobody is reading in July is the same waste as a weather sweep nobody is filtering on, and
   the gate now exists for free.
2. **The AGPL §13 note becomes an L-item in
   [`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md) *before* the first Fly
   deploy, not alongside it.** Borrowing LibreWXR's source selection and RQI handling is fine;
   deploying a modified LibreWXR as a network service obliges us to offer that modified source to
   its users. They sell commercial licences, which implies they expect this to bite.

**G — The admin thickness instrument (D160).** Small: a Stefan estimator over the Tier-A/B degree-hour
integrals, a role-gated `/admin` view, and a computed-vs-`measured` comparison table that accumulates
across the season. Ship it **early in the phase, not late** — its entire value is the season of paired
observations it collects, and every week it is not running is a week of data that cannot be recovered.

**Suggested split:** A+B+C+G is a shippable phase on its own and is where the value is concentrated
(G rides along because it is small and time-sensitive) — **shipped as PR 1**. ⚠ **PR 2 revision:
H comes next and alone**, because it is a cross-cutting UI refactor of both clients that blocks D and
touches every existing panel — bundling it with new panels means reviewing a move and a build in one
diff. Then D+E. F is last and depends on neither.

---

## Later / deferred

- **Multi-season history and climatology baselines** via the ERA5 archive API past the 92-day horizon
  (D153). *"40% more freezing degree-days than a normal February 1"* is probably the strongest single
  sentence this data could produce. Deferred because it needs a second endpoint, a second call-cost
  model, and a decision about how many seasons deep to go. **Lands in the Overview tab** (open
  question 4), next to N6e's phenology brackets — the two are the same kind of claim about a lake and
  should be read together.
- **Paying Open-Meteo** (D158) — season two, against a written trigger.
- **Caching the forecast payload for offline** (hole 9's second half). `ForecastPayload` exists
  since PR 4 and is small; writing it into the mobile offline body payload on drawer-open is a
  one-commit task that belongs with the on-ice/offline surface, not the Planning tab.
- **MRMS RQI blindness mask** — if radar v1 ships on RainViewer, the mask arrives with the MRMS
  switch, not before.
- **Radar nowcast beyond ~60 minutes.** NOAA's NDFD grids are free and time-enabled but cadence 3-hourly
  to 72 h then 6-hourly — a slideshow, not an animation. Anything smoother means ingesting HRRR and
  rendering it ourselves, hourly, for ever. That is a phase, not a workstream, and it should not ride
  in on the coat-tails of past-radar.
- ~~**A weather tab.**~~ ✅ **Resolved by open question 4** — the drawer gets three sub-tabs
  (Overview / Reporting / Planning) and weather lives in *Planning*. The concern that raised it stands
  and is now the tabs' job to solve: the sidebar already stacks alert → access → forecast → wind
  exposure → bathymetry → imagery → reports → hazards → bounties, and mobile's drawer snaps at
  16/58/94%. Three new panels do not fit in a flat list.

---

## ⚠ Holes to close before building — found 2026-09-03 in a readiness pass

None of these change the shape of the phase. All of them would cost a day each if found during
implementation instead of now, and the first three would ship as *silent wrong answers* rather than as
build failures.

### 1. `HourlyWeather.startMs` is **local-shifted, not a UTC instant** — and this phase is the first to render it

Verified at `weather.ts:199`: `startMs: tsMs + offsetMs`, commented *"local ms → correct night
bucketing."* That is deliberate and correct for the reducer, which needs to know which hours belong to
the same night. **But every consumer so far has been an integral, not a clock.** N6h is the first
feature to put those hours on screen as times of day, and `new Date(startMs).toLocaleTimeString()`
will apply the offset a *second* time — a silent 4–5 hour shift that looks entirely plausible
("snow starts at 1 AM" when it starts at 8 PM) and that no type will catch.

**Rule: display code must never format `startMs` with a local-timezone formatter.** Either format it
with UTC-based formatters (since the shift has already been applied), or carry a separate true-UTC
field for display and keep `startMs` for the maths. Decide which *before* the first hourly row is
rendered, and put the reason in a comment where a future reader will hit it.

### 2. Multi-cell giants are unspecified — and Champlain is the single most-discussed body in the corpus

`nearestSamplePoint` (`lib/sampling.ts:32-48`) picks the sample point closest to **a target**, which
works when there is one (a report's coordinate, a hazard's centre). **A body-level weather panel has
no target.** Lake Champlain is ~200 km long, spans many 0.05° cells, and is the top of the Google Group
corpus at 60 mentions — so the least-specified case is also the most-visited one.

Three sub-questions, all needing answers before Workstream C:

- **Which point does the panel show?** Proposal: the sample point nearest the user's selected put-in or
  sub-area if one is selected, else the default anchor — **and the panel says which**, because
  "weather at Lake Champlain" is not a well-formed claim.
- **Does `weatherDays` store one row per sample point** for multi-point bodies? (It should — the key is
  the cell, and a giant legitimately occupies several.)
- **Does D159 match a body if *any* of its cells match?** Almost certainly yes, but then the result
  card must name *where* on the lake matched, or the filter promises something it did not check.

⚠ **N2 sub-areas are probably the right unit here** and already exist. A bay is the thing people
actually skate and talk about ("Button Bay" is 32 mentions, "Malletts Bay" 26 — both *sub-areas of
Champlain*, both ranking above most whole lakes). Worth deciding whether a giant's weather is
sub-area-scoped rather than body-scoped.

### 3. "Nights" are undefined, and it is D159's headline predicate

*"Three nights below 20°F"* is the example query in every discussion of this phase, and a night spans
two calendar days. If `weatherDays` rows are local-calendar-day, then "nights" is a derived query over
t
hem and **the boundary must be defined exactly once** (6 PM → 9 AM local, or whatever the ice
physics argues for) in `@skating/core`, shared by the filter and the panel. Two definitions means the
feed and the drawer disagree about the same lake, which is the worst kind of bug: both surfaces look
right in isolation.

### 4. DST makes two days of every skating season 23 or 25 hours long

Both transitions fall inside November–March. The daily rollup must count **actual** hours, never
assume 24 — "hours below freezing" on a 25-hour day is a real quantity and a hardcoded divisor is a
silent off-by-4%.

### 5. The first-of-season backfill is a stampede

3,043 Tier-B cells × ~9 weighted calls ≈ **27,000 calls — about 3× the daily ceiling, in one cron
tick.** It needs a queue that spreads it over several days *and* batch-and-reschedule, because a
Convex action cannot fetch 3,043 cells within its time limit. The pattern already exists: N6d's
`backfillCells` did 24,961 bodies in 84 batches. Reuse it rather than rediscovering the shape.

### 6. The re-key must land atomically across **four** consumers

The strip, the decay cron, the bounty reopen gate and the contradiction checker all resolve the same
sample point so they share one cache entry, and Phase 10 §5's strip↔decay consistency invariant
depends on it. **If the key changes in three of the four, they fork silently** — the strip would
describe one window while the decay applied another. Build rule: the key function has **exactly one
definition**, all four call it, and a test asserts they agree on the same body.

### 7. Idempotency and one real migration

- `weatherDays` needs an **upsert** on `(cellKey, tier, dayMs)`. A cron that retries or overlaps must
  not double-insert, and the D161 gap detector will re-request days it already has.
- **`weatherCellKeyB` on `waterBodies` is a schema migration**, not a code change: widen → deploy →
  backfill 25k bodies → narrow, and stamped at import for new bodies thereafter.
- ⚠ **Dropping the old caches at re-key causes a one-time refetch burst.** Bounded and harmless —
  `ACTIVE_HAZARD_SCAN_CAP = 1000` and `WEATHER_REFRESH_MIN_INTERVAL_HOURS = 3` throttle it — but know
  it is coming so it is not mistaken for a leak.

### 8. Mobile has no charting substrate at all

Checked 2026-09-03: nothing in `apps/mobile` draws a chart. Phase 7b's dataviz-validated Recharts kit
is **web-and-admin-only**. The past-weather panel is inherently chart-shaped, so mobile needs either a
charting dependency or a deliberately text-first design with a minimal hand-rolled SVG sparkline.
**Decide this at design time, not when the web panel is done and mobile is "just the port."**

⚠ Related and still true: **mobile has no RN-under-Vitest harness** (Phase 10 deliberately skipped the
`WeatherStrip` render test for this reason). New mobile panels get core-level tests only, so put as
much logic as possible in `@skating/core` where it can actually be tested.

### 9. Offline

On-ice mode already has background location, and the drive to a remote lake is exactly where signal
dies. The selected forecast window and the past-week summary should ride along in the offline body
payload — the data is small and it is needed precisely when the network is not there.

---

## Open questions — all four answered 2026-09-02

1. ✅ **Tier A cardinality with elevation banding: ~9,500–10,500 keys, a ~1.16× cost. Take 100 m
   bands.** Measured against dev; three samples, method and its limits stated in the header block.
   Workstream A is unblocked.

2. ✅ **Unanswerable, permanently, until there are users — and that is the answer.** 0 favorites,
   2 reports, 3 hazards, 1 bounty on dev. The precompute job must derive its own set at runtime
   (D154). Re-run this query mid-season; it is the number that tells us whether Tier A precompute is
   worth having at all.

3. ✅ **A missed day is recovered, not skipped.** Founder call: *"We should try to recover a missed
   day! If multiple tries returns nothing, then we can skip, but we should try to backfill whenever
   possible, even with coarser data (or from another source)."* The ladder:

   1. **Retry from the same source.** `past_days` reaches 92 days, so a gap inside that window is
      fully recoverable — the job just has to notice. Requires a **gap detector** (the append cron
      checks for missing `dayMs` rows in its own window before appending, not merely that today
      succeeded), which is new: nothing in the weather path retries today (`weather.ts:158-168` warns
      and returns null).
   2. **Fall back to the coarser tier.** A missing Tier A cell-day can borrow its Tier B parent
      cell's day. Coarser, and honest about it — the row records which tier produced it.
   3. **Fall back to another source.** Past the 92-day horizon, ERA5 (D153). This is a second reason
      the archive ban had to go: it is also the deep-gap repair path.
   4. **Only then record an explicit gap.** ⚠ A missing day must be *stored as missing*, never as a
      zero — a silently-absent day reads as "no snow fell" to every predicate in D159, which is the
      most dangerous possible failure mode for a filter whose whole job is finding lakes with no snow
      on them.

4. ✅ **Three sub-tabs in the drawer/sidebar**, per the founder's taxonomy: **Overview/Details**
   (machine-compiled facts about the body, including historical and trend data) · **Reporting**
   (user-supplied, this season) · **Planning** (weather, put-ins, directions, derived season trends).

   **This resolves something the first draft left vague, and the split falls out cleanly:**

   - **This season's past-weather → Planning.** It exists to answer *"is there ice right now"*, which
     is a planning question even though the data is historical.
   - **Multi-season climatology → Overview.** *"Usually freezes in early January"* is a fact about the
     lake, in the same family as depth, elevation and the wind rose. This is where the deferred ERA5
     baselines (D153) and N6e's phenology brackets (D151) land, and it is a good sign that two
     deferred items find an obvious home in the taxonomy.
   - **The forecast panels → Planning**, alongside drive-time and put-ins, which is exactly the
     grouping D155's planning-window framing wants: the window you pick, how you get there, and how
     long it takes are one decision.
   - **⚠ The NWS alert belongs to none of them.** It stays above the tab strip, always visible,
     because a tabbed alert is an alert you can be one tap away from not seeing. This preserves the
     authority ordering at `apps/web/src/components/WaterBodyDetail.tsx:215-216` under the new IA.

   ✅ **Tab selection persists across bodies.** Founder call: *"Let's preserve tab selection and see
   how it feels."* Comparing five lakes on *Planning* without re-selecting it four times is the
   common case. Persist for the session; revisit if it turns out people expect a fresh body to open on
   *Overview*.
