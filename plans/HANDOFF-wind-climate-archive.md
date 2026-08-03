# HANDOFF — wind-climate: raw archive + sustained-wind capture

> **Temporary working doc, written 2026-08-02.** Delete once the work lands and the findings are
> folded into `plans/phase-N6c-expanded-lake-profiles.md` and `scripts/wind-climate/README.md`.
>
> **Do the whole build before re-running the fetch.** The fetch is ~7.7 hours and 5,225 requests
> against a 10,000/day quota. Every item below exists so that it happens *once*.

---

## Why this exists

Two findings from the 2026-08-02 N6c data campaign, both caught while the wind pass was already
running (it was stopped ~2% in, deliberately):

**1. We fetch wind speed and throw it away.** `scripts/wind-climate/src/wtk.ts` requests
`attributes: 'winddirection_10m,windspeed_10m'`, and every response row is
`Year,Month,Day,Hour,Minute,direction,speed`. But `accumulateCsv` reads `cells[5]` (direction) and
never touches `cells[6]` (speed). The stored `windRose` is 16 direction frequencies summing to 1 —
nothing about how hard it blows.

That matters because the founder wants **wind-hole risk**, which is a speed question, not a
direction one. Pressure-ridge formation is what the 1 km fetch gate is about; wind holes are driven
by sustained strong wind and have no comparable fetch minimum.

**2. `wind-climate` is the only fetching ETL with no `.raw/` archive.** `scripts/etl`,
`scripts/bathymetry` and `scripts/lake-depth` all keep byte-faithful archives with manifests and R2
mirrors. This package fetches, parses, discards.

The second finding is why the first one is expensive: adding speed *should* have been a two-minute
local recompute. Instead it is a 7.7-hour re-fetch. **That regret is the entire argument for this
work** — archive whole responses so the next "could we also derive X?" costs minutes.

---

## Measured facts (not estimates — taken 2026-08-02)

One live WTK request, `POINT(-73.3 44.5)`, year 2012, both attributes:

| | |
| --- | --- |
| latency | **5.3 s** per request |
| rows | 8,763 (a point-year, hourly) |
| raw size | 266,976 bytes |
| gzipped | 71,563 bytes (**3.7×**) |
| full archive (5,225 responses) | **0.37 GB gzipped**, 1.4 GB raw |
| full fetch time | 5,225 × 5.3 s ≈ **7.7 hours** |

⚠️ **The loader's own "~96 min at 1/s" estimate is wrong** and should be fixed as part of this work.
It counts only the deliberate 1-second pacing delay and ignores response latency, which is 5× larger.
Print an estimate derived from a measured sample, or state plainly that it is a floor.

**R2 headroom is not a concern.** Current usage across four buckets is 3.23 GB of the 10 GB free
tier; this adds 0.37 GB. 5,225 PUTs against a 1M/month Class A allowance is nothing, and R2 egress
is free — which is what makes "pull the archive instead of re-fetching" the cheap path.

---

## Scope of the fetch (already measured, post-floor)

```
123,952 bodies scanned · 100,701 below the import floor · 1,061 qualify · 1,045 distinct 2 km cells
5,225 requests (5 winters × 1,045 cells)
```

Note `1,061`, not the `3,184` in the current `scripts/wind-climate/README.md` — that figure predates
both the canonical re-import and the import floor. **Fix the README's numbers.**

⚠️ **The 1,061 figure was measured against the OLD floor** (`named OR >= 5 acres`). The settled rule
is `>= 5 acres OR (named AND >= 1 acre)` — stricter — and `waterBodies.pruneBelowAreaFloor` was run
against the corpus on 2026-08-03. **Re-measure with `--dry-run` before committing to a fetch budget;**
the number can only have gone down.

---

## What to build

### 1. `.raw/` archive — byte-faithful, one file per response

```
scripts/wind-climate/.raw/<gridKey>/<year>.csv.gz
scripts/wind-climate/.raw/<gridKey>/manifest.json
```

- **One file per response**, gzipped. `gunzip` must return exactly what WTK served. (Gzipped rather
  than plain is consistent with `scripts/bathymetry`, whose archive uses `page-*.json.gz`.)
- 5,225 objects. Keep per-response files rather than concatenating five years per cell: object count
  is cheap, and per-response granularity keeps partial-fetch resume simple and the archive honest
  about what each call actually returned.
- Manifest per cell: resolved URL, `fetchedAt`, sha256 per file, bytes, row count, the WTK years
  requested, and the grid point the key resolves to. Model it on
  `scripts/lake-depth/src/depthSources.ts`'s `DepthManifest` — that one is recent and already carries
  the licence/checksum discipline.
- **Never overwrite without `--refresh`.** The archive's value is that it does not change under the
  transform being iterated on.

### 2. `mirror-r2.sh`

Bucket **`skating-raw-wind-climate`** — already created and added to the API token (2026-08-02).

Copy `scripts/lake-depth/mirror-r2.sh` verbatim and change three lines:

```bash
ARCHIVE_LABEL="wind-climate-wtk"
ARCHIVE_DIR="$HERE/.raw"
DEFAULT_BUCKET="skating-raw-wind-climate"
```

Add `scripts/wind-climate/.env.example` + `.env.local` with `RCLONE_REMOTE=r2` and
`RAW_BUCKET=skating-raw-wind-climate`, and `.raw/` to the package `.gitignore`. The shared body in
`scripts/lib/mirror-r2.sh` already handles preflight, `copy`-never-`sync`, and writes an
`r2_mirror` run row.

### 3. Split fetch from derive

Right now `load.ts` fetches and computes in one pass. Separate them, mirroring `scripts/bathymetry`:

| command | does | costs |
| --- | --- | --- |
| `snapshot` | qualify cells → fetch → write `.raw/` | 7.7 h, 5,225 requests — **once** |
| `derive` | read `.raw/` → compute roses → load to Convex | minutes, **zero requests** |
| `mirror-r2.sh push/pull` | the durable second copy | — |

This is the point of the whole exercise: after the one fetch, changing a threshold, adding a
statistic, or rebuilding from scratch is `mirror-r2.sh pull` + `derive`.

`derive` should read from `.raw/` only and **fail loudly if a cell is missing** rather than silently
fetching — a derive that quietly hits the network is how the archive stops being the source of truth.

### 4. Sustained-wind capture — the data model

**Founder decision, 2026-08-02:** wind-hole risk comes from hours at or above a minimum speed, and
**strict consecutiveness is not required** — *"if the wind dies down for an hour and picks back up I
bet it would do just as much damage"*. Both the speed and the hours threshold must be configurable,
and it is wanted **per-sector across all 16 sectors**.

That correction simplifies the computation and improves the storage design. Do **not** implement
run-length/episode detection. Instead:

**Store per-sector strong-hour COUNTS, and leave the duration threshold to read time.**

```ts
/** Winter hours at or above the speed threshold, by the same 16 sectors as `windRose`. */
strongWindHours?: number[];      // length 16, absolute hours (not normalised)
/** Total winter hours the rose was accumulated from — the honest denominator. */
sampledWindHours?: number;
/** The m/s threshold those counts were accumulated at. Self-describing; see below. */
strongWindMinMps?: number;
```

Why counts rather than frequencies, when `windRose` stores frequencies: the duration question
(*"how many hours counts as risky?"*) is a threshold on an absolute number of hours. Storing
frequencies would force every consumer to multiply back through `sampledWindHours`, and the cells
do not all carry the same sample (see `MIN_ROSE_HOURS`).

**The two thresholds live in different places, on purpose:**

- **Speed** (`strongWindMinMps`, default **8.94 m/s = 20 mph**) is baked into the stored counts.
  Changing it needs a recompute — which after this work is a local `derive`, not a re-fetch. Store
  the value used alongside the counts so a row is self-describing and a mixed-threshold corpus is
  detectable rather than silent.
- **Duration** (`WIND_HOLE_MIN_HOURS`, default **3**) is applied at **read time** in
  `@skating/core`. Changing it requires **no recompute at all** — which is the strongest form of
  "configurable" available and worth preferring wherever a threshold can be pushed to the reader.

Both belong in `@skating/core` as named constants, and both should appear on the Phase 7b tuning
page read-only, like `MIN_FETCH_CLAUSE_M` and the D2 weights already do.

WTK's `windspeed_10m` is at 10 m, which is standard anemometer height — so 20 mph compares directly
to a reported wind speed with no conversion fudge. Say so in the constant's docstring; someone will
otherwise wonder.

### 5. Derived read-time helper

In `@skating/core`, beside `mostExposedSector`:

```ts
/** Sectors whose strong-hour count clears the duration threshold, worst first. */
export function windHoleSectors(
  body: { strongWindHours?: number[]; sampledWindHours?: number },
  minHours: number = WIND_HOLE_MIN_HOURS,
): CompassPoint16[]
```

Consumers today are `lakeCaption.ts` and `lakeProfile.ts` — those are the only two files that read
`windRose` (verified 2026-08-02). Decide with the founder whether a wind-hole clause belongs in the
caption or only in the profile; **do not add safety-sounding copy without asking** (cf. D82, where
bathymetry was explicitly ruled "context, not counsel").

### 6. No fetch gate for wind holes

`MIN_FETCH_CLAUSE_M = 1000` gates the *wind-exposure caption clause*, and the founder confirmed it
is right for pressure ridges. **Wind holes have no comparable fetch minimum** — their research found
sustained ≥20 mph to be the driver, with no fetch threshold. So:

- Keep the 1 km gate for which bodies get a rose *fetched* (it is also what makes 1,045 cells
  affordable), but
- Do **not** assume the same gate is meaningful for the wind-hole derivation, and say so where the
  constant is defined. If wind-hole risk later wants wider coverage, that is a new fetch scope
  decision with a real cost (the ~4.1% → wider expansion is measured in §Scope above).

---

## Verification before declaring it done

1. `snapshot --limit=3` → three cells archived, manifests written, sha256s present.
2. `derive` with the archive present and **the network disabled** — it must succeed. If it needs the
   network, the split is not real.
3. Re-run `derive` with a different `--min-mps` → different counts, no requests made.
4. `mirror-r2.sh push` then `status` → object count matches local, and an `r2_mirror` run row appears
   on `/admin/imports`.
5. Delete `.raw/` locally, `mirror-r2.sh pull`, `derive` again → identical output. **This is the test
   that proves the 7.7 hours never has to be repeated.**
6. Spot-check a known windy lake (Champlain's broad lake, Winnipesaukee) against intuition — the
   most-exposed sector should point along the fetch axis, not across it.

---

## Lessons from today worth not re-learning

- **Free-tier quotas are counted per coordinate, not per request** (Open-Meteo, elevation). Batching
  saves HTTP overhead and no quota at all. Check WTK's accounting before assuming 5,225 requests is
  the relevant number for its 10,000/day limit.
- **Estimate wall clock from a measured sample**, never from the pacing delay. The 96-minute estimate
  was off by ~5×.
- **A run's ETA and its scope both belong in the run row** (`importRuns`, `/admin/imports`), so the
  next person does not rediscover them from a terminal.
- **Filter to the import floor** (`--import-floor`) before spending any third-party quota. It cut
  wind scope 3×.

  **And do not restate the rule — import it.** This was briefly a `--min-area-acres=N` flag whose
  server side re-implemented `named OR >= 5 acres`. The rule changed the same day to
  `>= 5 acres OR (named AND >= 1 acre)`, and the copy silently became *more permissive* than the
  import it was supposed to mirror — quota spent on bodies the prune was deleting. `meetsAreaFloor`
  now lives in `@skating/core` (`osm.ts`) and both `listNeedingElevation` and `listNeedingWindRose`
  call it directly, with a boolean switch rather than a threshold. A parameter invites a caller to
  invent a floor; a predicate cannot drift.
- The elevation pass's rate-limit handling (`ELEVATION_RATE_LIMIT_RETRIES`, `retryAfterMs`, honouring
  `Retry-After`) is a good model if WTK turns out to rate-limit too. `fetchCellYear` already has 429
  backoff; check it is as patient.
