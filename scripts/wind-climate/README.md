# @skating/wind-climate — winter wind roses (N6c-1 / A4b)

A manual, run-on-demand ETL that gives each qualifying water body a **winter wind rose**: how often
wind blows from each of 16 compass sectors between December and March. Like the other `scripts/`
tools this is **not** built or deployed with the apps — you run it by hand.

Combined with the fetch profile, it answers the question a skater actually has: *which shore gets
hammered here?*

---

## Why this exists

The lake caption originally said Lake Willoughby is **"most open to wind out of the south-southeast"**
— on the basis that its longest fetch runs SSE. That is a claim about **geometry** wearing the
clothes of a claim about **wind**, and a direction with five miles of open water that wind never
blows from is not an exposed shore.

Founder catch, 2026-08-02:

> *"I am almost certain Lake Willoughby never gets wind out of the south… the terrain (mountains)
> around lakes drastically impact the chance that wind could come from particular directions."*

So we measured it. Willoughby, Dec–Mar, from the WIND Toolkit:

| From | Share of winter hours |
| --- | --- |
| SE | **19.4%** |
| NW | **18.6%** |
| SSE | **16.1%** |
| NE | 0.8% |

A strongly **bimodal** rose along the lake's NNW–SSE trough, with the E/NE quadrant essentially
blocked by Mount Pisgah and Mount Hor. The specific prediction was wrong — wind out of the south is
common here — and the **reasoning was exactly right**: terrain dominates, and it funnels wind *along*
the valley rather than excluding half of it.

Hence **D90**: exposure is `winterFrequency[k] × fetchM[k]`, and **a lake with no rose says nothing
about wind at all**. There is deliberately no fallback to fetch-alone, because that fallback is the
claim this pipeline exists to stop making — and its failure mode is a plausible sentence, not an
empty one.

---

## Source: NREL WIND Toolkit

WRF on a **2 km grid** over the contiguous US, hourly, wind speed and direction at 10 m.

**Why not the Global Wind Atlas**, which resolves 250 m and would see more terrain — three reasons,
in increasing order of how much they settle it:

1. Its public `/api/*` paths all return the site's HTML shell; the real services sit on a
   contractor's *staging* host. Depending on an undocumented endpoint is the fragility D71 argues
   against.
2. Its published climatology is **annual**. Prevailing December wind is not prevailing July wind, and
   only the WIND Toolkit's hourly data lets us filter to the skating season.
3. Decisively: its downloadable GIS layers are `wind-speed`, `power-density`, `capacity-factor`,
   `air-density`, `RIX` and `combined-Weibull-A`/`-k` — where **"combined" means combined *across*
   sectors**. There is no directional layer to build a rose from at all.

---

## Setup

```bash
cp .env.example .env.local
```

Then fill in a **free** API key from <https://developer.nlr.gov/signup/> (instant, emailed):

```
WIND_TOOLKIT_API_KEY=<your key>
WIND_TOOLKIT_EMAIL=you@example.com
```

Both are required — the API wants an active email on **every request**, not only at signup.
`.env.local` is gitignored.

> **Why `WIND_TOOLKIT_*` and not `NREL_*`:** the API's host moved from `developer.nrel.gov`, which no
> longer resolves at all, to `developer.nlr.gov`. Naming the credential after the **dataset** rather
> than the provider means it survives the next move too.

---

## The two commands

### 1. Dry run — always do this first

```bash
pnpm --filter @skating/wind-climate load --dry-run
```

**Costs zero API requests.** It walks the corpus, folds the qualifying bodies onto the WIND Toolkit's
native 2 km grid, and prints the arithmetic before you commit to it:

```
[wind] 116070 bodies scanned · 3184 qualify · 1902 distinct 2 km cells
[wind] 9510 requests (5 winters x 1902 cells), ~175 min at 1/s
[wind] the grid dedupe saves 6410 requests
```

Read those numbers against the budget — **10,000 CSV requests/day, one per second**. Requests are the
scarce resource here, not storage, which is the whole reason the dedupe exists: many lakes share a
2 km cell, and a rose is a property of the cell rather than of the lake.

Only bodies whose **longest fetch clears the caption's own floor** qualify. Anything smaller would
spend requests on a number nothing will ever render.

### 2. The real run

```bash
pnpm --filter @skating/wind-climate load
```

Fetches five winters (2010–2014) per cell, accumulates Dec–Mar hours into 16 sectors, normalises to
frequencies, and writes one rose per body.

**It is resumable, and that is not incidental.** The server-side query skips bodies that already
carry a rose, so an interrupted run *continues* rather than restarting a multi-hour pass — and
re-running it afterwards is a cheap no-op. If it dies, just run it again.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report the plan, spend nothing, write nothing |
| `--limit=N` | Stop after N grid cells — for a first taste against real lakes |
| `--refresh` | Re-read bodies that already have a rose (for the day the dataset changes; not the normal path) |
| `--prod` | Required to target anything that is not a dev deployment |

---

## Where this sits in the N6c run order

It is **step 4 of 5**, and the order is load-bearing:

1. canonical water re-import — geometry, shape stats, `interiorPoint`
2. depth + elevation — `pnpm --filter @skating/lake-depth load-elevation`
3. `convex run regionStats:recompute`
4. **this** — needs `fetchProfileM` from step 1 to know which bodies qualify
5. *(N6c-2's data, then)* `convex run waterBodies:backfillCells` — **one** re-score at the very end

Running this before step 1 finds nothing to do, because no body has a fetch profile yet.

---

## What lands, and what it is worth

One field per body: `waterBodies.windRose`, sixteen frequencies summing to 1, indexed by the
direction wind blows **from** — the same convention every forecast API reports and the same sector
order as `fetchProfileM`, so the two multiply elementwise. Plus `windRoseSource: 'wtk_2km'`.

Nothing is fetched at read time. The caption reads the stored column.

**Two denominator guards**, the same discipline as D78 and D86:

- A cell with fewer than **4,000 winter hours** stores **nothing**. A rose renders as *"about 19% of
  the time"*, which reads identically whether it summarises 300 hours or 14,000.
- The caption always states the **percentage**, never a bare superlative. *"Most exposed to the
  northwest"* is a claim with nothing behind it.

**Honest limits**, worth knowing before anyone reads too much into a rose:

- **2 km, so a small pond inside a tight valley gets its valley's wind, not its own.** That is the
  right resolution for the question and the wrong one for a hollow.
- **2010–2014.** A climatology, not a trend, and it says nothing about this winter.
- **One point per lake**, from the same `interiorPoint` the fetch profile is cast from. Wind varies
  across a big lake; this characterises the body.
