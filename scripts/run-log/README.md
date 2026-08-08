# `@skating/run-log` — ETL run history

The shared writer behind the `importRuns` table and `/admin/imports` (N6c Workstream F2).

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

**Still not covered:** `scripts/basemap` is `upload.sh` / `upload-r2.sh`, bash + rclone pushing
tiles to R2. It never touches Convex and populates no part of the data model. The `record` CLI now
makes it *possible* (the mirrors use exactly that route), so this is a scope decision rather than a
technical one.

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
