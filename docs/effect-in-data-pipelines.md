# Effect in the data pipelines

**Effect v4 is a tool for specific I/O boundaries, not the default for scripts.** The initial rollout
is complete. We use it where retries, deadlines, concurrency, cancellation, or cleanup interact
and make failures hard to reason about or test. The surrounding CLI, data transforms, and persistent
state stay in plain TypeScript.

## What landed

| Boundary | What Effect owns | What stays outside it |
| --- | --- | --- |
| [3DEP elevation snapshot](../scripts/lake-depth/README.md) ([#153](https://github.com/tatwater/skating-app/pull/153), D278) | [Fetch concurrency, per-attempt deadlines, retries, and cancellation](../scripts/lake-depth/src/fetchElevation.ts). | The CLI owns checkpoints and resume. A graceful stop saves completed readings; a hard kill relies on the last checkpoint. |
| [WIND Toolkit snapshot](../scripts/wind-climate/README.md) ([#154](https://github.com/tatwater/skating-app/pull/154), D279) | [The cell-year retry schedule](../scripts/wind-climate/src/wtkFetch.ts), including the longer budget after a `429` and both forms of `Retry-After`. | The CLI still paces requests serially and owns the archive. Offline `derive` does not use Effect. |
| [ORS walking approaches](../scripts/etl/README.md) ([#155](https://github.com/tatwater/skating-app/pull/155), D280) | [The route request and `429` backoff](../scripts/etl/src/orsApproach.ts). | Serial pacing, the per-run `403` quota breaker, and the on-disk cache keep their existing rules. A temporary straight-line fallback is not a cacheable answer. |
| [Direct bathymetry downloads](../scripts/bathymetry/README.md) and the [3DHP source ZIP](../scripts/etl/README.md) ([#156](https://github.com/tatwater/skating-app/pull/156), D281) | [Cancellation and staging cleanup](../scripts/archive-io/src/download.ts). Node streams and hashes the bytes; the staged file replaces the previous one only after the transfer and applicable size check succeed. | Manifests, ArcGIS paging, and GDAL clipping stay with their callers. No automatic download retries were added. A refresh needs room for the old file and its staged replacement. |

The [decisions log](../plans/01-decisions.md) records the provider-specific policies in D278–D281.
Share transfer mechanics when they serve multiple real callers; don't share retry policy just because
two jobs make HTTP requests. Wind and ORS both wait on `429`, but use different budgets and rules.

## What we deliberately left unchanged

No migration is planned for web, mobile, pure domain logic, or routine CLI glue. Keep a simple fetch,
timeout, or retry loop in plain TypeScript when that's easier to read and test. A synchronous
subprocess doesn't become interruptible just because it's called from an Effect.

Convex still owns transactions, scheduling, leases, and recovery across runs. The
[Open-Meteo prototype](https://github.com/tatwater/skating-app/pull/157) worked in a throwaway local
Convex action, but easier timing tests didn't justify adding the runtime: the isolated minified
fetch bundle grew from about 19 KB to 110 KB. That was a bundle comparison, **not** a hosted
cold-start measurement. We closed the prototype and shipped the
[post-meter deadline check in plain TypeScript](https://github.com/tatwater/skating-app/pull/158).
There is no Effect dependency in Convex.

## What to watch on normal runs

Use the terminal and RunLogger for progress and failures. Look for repeat quota exhaustion, work
that continues after cancellation, missing progress on resume, or incomplete artifacts displacing
good ones. App traffic doesn't exercise these manual jobs, and there's no reason to rerun a full
refresh just to collect data.

**Only `snapshot-elevation` sends Sentry telemetry.** With `SCRIPT_SENTRY_DSN` loaded into the
operator's shell, it sends one `3dep.snapshot.fetch` span per fetch batch to `gli-data-scripts`.
In **Explore → Traces**, filter to the `manual-scripts` environment and compare batch duration,
retries, and refusals against the point count. Run details stay in the terminal and RunLogger:
the span is not a log stream, and this integration doesn't send error events or coordinates.
Vitest and CI don't send data to hosted Sentry. See the [lake-depth runbook](../scripts/lake-depth/README.md)
for local setup; neither Convex nor Vercel needs that DSN.

## When to use Effect again

1. **Name the failure that costs us something.** Examples: a canceled job still spends quota,
   a failed refresh risks the previous archive, or a retry can duplicate a write. If a small
   plain TypeScript fix solves it, stop there.
2. **Keep the migration at the I/O boundary.** Write down what gets retried, which results may be
   cached or persisted, what happens on interruption, and which state has to survive the process.
   Keep provider policies explicit. Don't retry a write with an ambiguous outcome unless it's
   idempotent or there's a way to reconcile what happened.
3. **Prove the improvement.** Use a virtual clock for timing and a local fixture for interruption,
   partial results, or resume. Use Fallow as a second reviewer with measured coverage, not a score
   target. If considering a hosted runtime, compare the actual before-and-after behavior on hosted
   dev rather than assuming local tests or bundle size settle the question.

Adopt it for the next concrete problem that meets those criteria, not as a standing rewrite.
