# `@skating/run-log` — ETL run history

The shared writer behind the `importRuns` table and `/admin/imports` (A06c Workstream §6.2).

## Why it exists

Every loader in this repo — `etl`, `admin-areas`, `lake-depth`, `wind-climate`, `bathymetry` —
computed a genuinely useful summary and then printed it to a terminal that scrolls. Match rates,
rejects by reason, overrides held, contested merges: nothing wrong with any of the numbers, there
was simply nowhere to put them. So *"how did the last import go"*, *"is coverage better or worse
than last time"* and *"which lakes did it decline"* had no answer short of re-running the pass, and
coverage regressions between runs were invisible by construction.

This package is the other half: one `importRuns` row per run, written through the same
admin-credentialed `pnpm exec convex run` channel the loaders already use.

## What is wired

Every pass that writes third-party data into the Convex data model, plus the one derived pass that
walks the whole corpus:

| kind | command |
| --- | --- |
| `canonical_water` | `pnpm --filter @skating/etl load` |
| `osm_depths` | `pnpm --filter @skating/etl load-depths` |
| `admin_areas` | `pnpm --filter @skating/admin-areas load` |
| `lake_depth` | `pnpm --filter @skating/lake-depth load` |
| `elevation` | `pnpm --filter @skating/lake-depth load-elevation` |
| `wind_climate` | `pnpm --filter @skating/wind-climate load` |
| `bathymetry_coverage` | `pnpm --filter @skating/bathymetry coverage` |
| `region_stats` | `convex run regionStats:recompute` |

Each invocation inserts a **new row**, so re-running one loader gives you a fresh row at the top of
`/admin/imports` with the previous one still there to compare against. That is the whole "is
coverage better or worse than last time" question.

And the **acquisition** steps ahead of every loader, which is where a source actually turns out to
have moved, changed schema or quietly returned less than last time:

| kind | command |
| --- | --- |
| `raw_archive` | `pnpm --filter @skating/bathymetry snapshot` — one row per source |
| `r2_mirror` | `scripts/etl/mirror-r2.sh push`, `scripts/bathymetry/mirror-r2.sh push` |
| `bathymetry_join` | `pnpm --filter @skating/bathymetry join` |
| `bathymetry_build` | `pnpm --filter @skating/bathymetry build-contours` |

`backfill-archives` reconstructs `raw_archive` rows for the archives populated **before** this table
existed, from the manifests the fetchers wrote at the time. Nothing is invented — see that script's
comment for what it refuses to claim.

And every pass of a **corpus campaign** (`scripts/etl/run-corpus.sh`), including the three that wrote
nothing to Convex and so left no row before B01-7a, so Machinery can draw a campaign whole from what
it stored. Under `run-corpus.sh` each carries the campaign id; run by hand, pass `--campaign=<id>`:

| kind | command |
| --- | --- |
| `region_masks` | `pnpm --filter @skating/admin-areas build-region` — files only, plus this row |
| `corpus_merge` | `pnpm --filter @skating/etl merge` |
| `landmark_match` | `pnpm --filter @skating/etl landmarks` — the offline match, plus this row |
| `floor_prune` | `pnpm --filter @skating/etl prune-floor` — dry or applied, a row either way |
| `absorbed_retire` | `pnpm --filter @skating/etl retire-absorbed` (was `canonical_water` before B01-7a) |

## Scope and heartbeat (D218)

**`scope` is what a run set out to cover**, stated once at `start` through `RunLogger`'s `scope`
option: the pass (`full-canonical`, `single-source`, `enrichment`, `seed`, `rollover`, `archive`,
`derived`, `cleanup`), the two-letter states it covered when it is by state, and `complete` — `false`
for a subset of states, a resumed walk, or a merge missing a catalog. It is intent, never outcome:
`status` and `coverage` say how it went. The merge writes its scope into `merge-manifest.json`, so a
pass that replays the manifest (the bays) inherits it. The vocabulary lives twice, `IMPORT_RUN_SCOPES`
in Convex and `ImportRunScopePass` here, and `packages/guards` holds the two (and the kinds) in step.

**`progressAt` is the heartbeat**, stamped by the server at `start`, every `progress` and `finish` —
a loader never sends it, so every loader that flushes already has one. A `running` row silent long
past its loader's flush interval is *stalled*, not running.

**Still not covered:** `scripts/basemap` is `upload.sh` / `upload-r2.sh`, bash + rclone pushing
tiles to R2. It never touches Convex and populates no part of the data model. The `record` CLI now
makes it *possible* (the mirrors use exactly that route), so this is a scope decision rather than a
technical one.

## The live log, beats and the campaign row (D341, B01-8a)

Machinery's corpus page watches a campaign as it runs, so the logger records what it sees as it sees
it — no loader writes a line itself.

**The live log.** The logger keeps a line for each call it already receives — the start (*Run
started · A07a unified corpus · full canonical, 5 states · dev · dry run*), a stage the first time
it is named, the failures since the last report (*3 new failures · e.g. nhd/3290011 · …*), the counts
that changed (`inserted=1200, updated=40`, in the order the loader set them, at most 500 characters),
a beat's label, and the close (*Succeeded*, or *Failed: …*). It sends them to `runEvents:append` after
the start, after each `progress` and after the `finish` — at most 200 lines a call; past that it keeps
the first 150 and the last, with one line saying how many it left out.

**`beat(label?)`** is for a pass that never flushed. It is cheap enough for a hot loop — a clock read
— and reaches Convex (a flush) only once `beatMs` (default 60 s) has passed since the logger last
did; the latest label rides that flush as a `beat` line. Every logger call is a `pnpm exec convex run`
subprocess of one to three seconds, so a beat can never be per item, and no beat can cover one
synchronous step longer than its gap (an `osmium` run, one hung batch, one huge `JSON.parse`).

**The console's directives**, in `append`'s answer:

- *marked failed* — the logger says so on stderr once and carries on; its own close is kept beside
  the mark, never over it.
- *stop* (built, not drawn) — the logger adds a line, closes the row as failed with *Stopped on
  request*, and calls `onStop` (default `process.exit(130)`). It takes effect only at a flush or a
  reported beat — between batches, never inside one.

**The campaign, from the environment.** `run-corpus.sh` sets `RUN_CORPUS_PASS` (the pass's name)
and `RUN_CORPUS_PARENT` (the campaign row's id) for each pass; the logger sends them at `start` as
`campaignPass` and `parentRunId`. A loader run by hand has neither, and lists on its own.

**An older deployment loses only lines, never counts.** A `start` refused with the campaign's keys is
retried once without them; a missing `runEvents:append` turns the lines off for the run with one
warning; `progress` and `finish` are unchanged either way.

**The campaign row** is `run-corpus.sh`'s own (`corpus_campaign`), written by `src/campaign.ts`:

```sh
pnpm --silent --filter @skating/run-log campaign open <campaignId> --plan=<pass,…> \
    [--hand=<pass,…>] [--skipped=<pass>:<why>]… [-- <the script's flags>…]   # prints the row's id
pnpm --silent --filter @skating/run-log campaign pass <runId> <pass>          # prints `stop` if asked
pnpm --silent --filter @skating/run-log campaign skip <runId> <pass> <why…>
pnpm --silent --filter @skating/run-log campaign close <runId> --exit=<code> [--last-pass=<pass>]
```

Every verb exits 0 whatever Convex says: a campaign never fails because its row couldn't be written.
`--silent` matters — without it pnpm prints its banner on stdout, ahead of the id.

## The two rules

**1. Bookkeeping never breaks the thing it books.** Every call `RunLogger` makes into Convex is
swallowed and warned about on stderr. An import that died because its history row could not be
written would be strictly worse than the printed summaries this replaces. The observability is
always the junior partner.

**2. A crashed loader still leaves a record.** The row is opened *before* the first batch, not after
the last. A loader that is killed — blown heap, closed laptop, `^C` — leaves a row stuck in
`running` that names what it was doing, which is exactly the failure mode a printed summary can
never capture. The admin page says *"no finish recorded"* rather than *"in progress"*, because the
row cannot tell a live loader from a dead one and must not assert either.

## Usage

```ts
import { convexRun, extractStage, resolveDeployment, RunLogger } from '@skating/run-log';

const target = resolveDeployment();
const logger = new RunLogger({
  kind: 'canonical_water',            // one of IMPORT_RUN_KINDS
  label: 'VT canonical water',
  campaignId: 'n6c-20260802',         // groups runs that were one operation
  target,
  stages: [extractStage(manifest)],   // provenance known before the run starts
  call: convexRun,
});
logger.start();

for (const batch of batches) {
  try {
    const result = await load(batch);
    logger.count('inserted', totalInserted);   // running totals, not deltas
  } catch (err) {
    logger.fail({ stage: 'load', key: batchName, reason: String(err) });
  }
  if (n % 25 === 0) logger.flush();            // so a long run is visible while it runs
}

logger.stage({ name: 'load', counts: [...] });
logger.coverage({                              // the rate, and where the rest went
  unit: 'bodies',
  eligible: scanned,
  covered: updated,
  omissions: [{ reason: "held by a moderator's override (D68)", count: operatorHeld }],
});
logger.succeed();                              // or logger.failed(err), and still rethrow
```

## Coverage is a rate, and the omissions have to add up

`logger.coverage()` is the part worth getting right, because **a count cannot be wrong**. "9,981
bodies stamped" reads as a complete pass whether the corpus is 10,000 or 116,070; only a denominator
makes a shortfall visible. Every loader here already computed its rate and printed it.

The `omissions` ledger is what makes the rate readable. `eligible − covered` minus the stated
omissions is rendered on the admin page as **unexplained**, and that line is the entire point: it
separates *"107,970 lakes sit below HydroLAKES' 10 ha floor"* — a documented limit of the source,
expected, fine — from *"107,970 lakes went missing."* Those are indistinguishable in a totals-only
summary and they are the two readings that matter most. So put every deliberate decline in
`omissions` with a reason a stranger can evaluate, and let the remainder be loud.

Pick the denominator that keeps the declines visible. The water ETL counts **polygon features the
filter emitted**, not bodies the transform kept — otherwise "dropped as a river" vanishes from the
ledger and every run looks perfect.

## Things that will bite you

**Counts replace by name; they do not accumulate.** The loader already holds running totals, so
making the server add would mean a retried `progress` call double-counts — the one arithmetic bug an
observability table cannot afford, because nothing downstream would ever contradict it.

**Failures are capped on both sides, and the cap is reported.** `MAX_FORWARDED_FAILURES` (here)
protects the `convex run` argv, which is an inline JSON string against a ~1 MiB `ARG_MAX`;
`MAX_STORED_FAILURES` (in `convex/importRuns.ts`) protects the 1 MB document. Both are 200.
`failuresTotal` keeps counting past them, and the UI says how many it is hiding — a truncated list
that doesn't admit it was truncated reads as *"only three lakes failed"*, which is the specific lie
this whole table exists to stop telling.

**Stages replace by name too.** A stage is re-sent when its counts firm up (the `load` stage's batch
tally), and appending would render the same step twice with different numbers.

**`resolveDeployment` fails closed.** An unknown target counts as non-dev, so a loader's dev-first
guard demands an explicit `--prod`. Being wrong in that direction costs one flag; being wrong in the
other direction upserts an OSM extract into production.

**The `sourceAt` on an extract stage is the *publisher's* build date**, not when we fetched it — and
`checksumVerified` reports the **published md5**, not our sha256. Ours only proves the file hasn't
changed since we archived it, which is a weaker and less interesting claim than that we downloaded
what Geofabrik actually published.
