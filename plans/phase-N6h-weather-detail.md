# Phase N6h — The weather panel: a season of past days, a planning window, and radar that admits what it can't see

> **Status:** 🚧 **PR 1 BUILT 2026-09-03 on `phase-n6h-weather-detail-1`** — Workstreams **A + B + C +
> G** (the re-key, the durable archive, the past-weather panel on both clients, and the dark
> thickness instrument). Unpushed, no PR opened, undeployed; founder is running the code-review skill
> in a fresh thread first. **D + E + F not started.** Suites: core 2,327 · convex 1,377 · web 495 ·
> mobile 108 · etl 433, `lint` and `check-types` clean across all 13 tasks.
> See *§What PR 1 shipped, and where it differs from this plan* below.
> Scoped 2026-09-02. Founder ask, same day. Grew out of a costing
> question — *"what is most expensive about this plan?"* — and the answer moved the design: the
> expensive half is not the data, it is **the cache key**, which today shares nothing.
> **Depends on:** nothing. Every seam it needs is already built.
> **Touches:** `weather.ts` (the sample-point key, the fetch spec), `weatherCache` /
> `weatherForecastCache`, the N5a season boundary, the N6c wind rose + fetch profile, Phase 4
> drive-time, the Phase 5 feed filter row, and the N6e imagery scrubber + Fly/R2 cutter pattern.
> **Decisions:** **D152–D161** (drafted below; written into [`01-decisions.md`](./01-decisions.md) 2026-09-03).
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
F (radar) are untouched.

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

**⚠ Better still, precompute the predicate inputs.** Store a small daily per-cell digest of the handful
of quantities filters actually ask about (nights below thresholds, snow since, freeze-run length, thaw
hours) so the common queries are index range scans rather than scan-and-filter. Adding a filter
dimension later then means adding a field, not a scan.

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

**D — The forecast panel.** Per D155: the 7-day grid as selector, hourly detail as the view, run-up
always drawn, drive time as a default hint.

**E — Weather-first discovery (D159).** Reads Tier B. The founder's target query: *"bodies within two
hours' drive that got at least three nights below 20°F and no snow since."* This is the reason Tier B
exists and the reason a cron exists at all — on-demand fetching cannot answer a question about lakes
nobody opened. Ships as: the per-cell predicate digest, the `weatherCellKeyB` index on `waterBodies`,
the shared discovery-filter store across map and feed, and the body-result card. **⚠ Answer the
feed-shape question (bodies vs reports) before building the card, not after.**

**F — Radar.** RainViewer proxied server-side as v1; MRMS-with-RQI as the honest version. Pay for the
layer-registry refactor. Extract the lane pool from `useFreezeUpFrame.ts` first.

**G — The admin thickness instrument (D160).** Small: a Stefan estimator over the Tier-A/B degree-hour
integrals, a role-gated `/admin` view, and a computed-vs-`measured` comparison table that accumulates
across the season. Ship it **early in the phase, not late** — its entire value is the season of paired
observations it collects, and every week it is not running is a week of data that cannot be recovered.

**Suggested split:** A+B+C+G is a shippable phase on its own and is where the value is concentrated
(G rides along because it is small and time-sensitive). D+E is a second. F is a third and depends on
neither.

---

## Later / deferred

- **Multi-season history and climatology baselines** via the ERA5 archive API past the 92-day horizon
  (D153). *"40% more freezing degree-days than a normal February 1"* is probably the strongest single
  sentence this data could produce. Deferred because it needs a second endpoint, a second call-cost
  model, and a decision about how many seasons deep to go. **Lands in the Overview tab** (open
  question 4), next to N6e's phenology brackets — the two are the same kind of claim about a lake and
  should be read together.
- **Paying Open-Meteo** (D158) — season two, against a written trigger.
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
them and **the boundary must be defined exactly once** (6 PM → 9 AM local, or whatever the ice
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
