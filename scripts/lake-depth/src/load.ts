/**
 * Lake-depth loader (glue). Chunks depth NDJSON into the internal `waterBodies.matchAndImportDepths`
 * mutation via the Convex CLI, which is where the geometric join happens (the N1 cell index lives
 * there). Loads the **dev** deployment by default; refuses a non-dev target unless `--prod` is passed.
 * Thin subprocess + file I/O — excluded from coverage; all real work is in the tested transform and the
 * tested mutation.
 *
 *   pnpm --filter @skating/lake-depth load <depths.ndjson> [--prod]
 *
 * Re-running is safe and converges: the D68 ladder is enforced inside the mutation, so a resumed or
 * repeated run never downgrades a value and never overwrites an operator's.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

/**
 * Batch size.
 *
 * **The original 25 was reasoned against the wrong limit, and the first real run proved it.** The note
 * here used to say bytes "never bind" because the *records* are tiny — a point and two numbers. True,
 * and irrelevant: what the mutation reads is the corpus, not the input. Each lake pulls every listed
 * body whose bbox covers its neighbourhood, and Convex counts **16 MB of reads per transaction**. A
 * body averages 1.8 KB, but the cell index files large bodies at coarse rungs, so a lookup anywhere
 * near Champlain or Ontario drags a ~300 KB polygon in with it. Twenty-five such lookups in one
 * transaction blew the byte cap at batch 8 of 1,611 on 2026-08-02.
 *
 * **8 turned out to be marginal, not conservative — measured, not guessed.** The 2026-08-02 run
 * completed with zero failures, but Convex emitted near-cap warnings on five batches, peaking at
 * **16.2 MB against the 16.8 MB ceiling**. Within 4%. So 8 is the number that *happens to fit this
 * corpus today*, and the corpus only grows; a denser neighbourhood or one more large polygon indexed
 * at a coarse rung tips it over.
 *
 * **4 is the number that deserves the word conservative**, and it is what a first run against prod
 * should use — there, a half-loaded pass costs more than the extra wall clock (roughly 2× on a
 * ~3-hour job). 8 is kept as the default because dev has now demonstrably survived it and the loader
 * degrades gracefully: an over-cap batch is recorded, skipped, and named by lake key for a targeted
 * `--batch=1` retry, rather than killing the run.
 *
 * Override with `--batch=N`. Lower it on any `Too many bytes read` error.
 */
const DEFAULT_BATCH_COUNT = 8;

/**
 * How many batches may fail back-to-back before the load gives up.
 *
 * Matches the water ETL, and for the reason that loader learned first: this pass is thousands of
 * `convex run` calls, a single dense neighbourhood blowing the read cap is a *local* fact about the
 * corpus rather than a broken run, and the ladder is enforced server-side so retrying is free. A
 * streak means something systemic. **This loader used to rethrow on the first failure**, which is why
 * the 2026-08-02 run stopped at batch 8 with 1,603 batches of perfectly loadable depth behind it.
 */
const MAX_CONSECUTIVE_BATCH_FAILURES = 5;

interface MatchResult {
  updated: number;
  unmatched: number;
  /** Matched by proximity + corroboration rather than containment — a weaker claim, counted apart. */
  matchedByProximity: number;
  /** A body was in range but nothing corroborated it. Distinct from "nothing here". */
  proximityUnconfirmed: number;
  areaRejected: number;
  skipped: number;
  /** Matches the area gate could not run on, because one side reported no area. */
  noAreaGate: number;
  /** Measurements a moderator owns — a reading or an explicit rejection. Never overwritten (D68). */
  operatorHeld: number;
  /** Lakes where a mean exceeded a max, so the ladder had to drop one of the two. */
  inverted: number;
  /** Lakes where both we and HydroLAKES had a shoreline, so D85's cross-check could run. */
  shorelineCompared: number;
  /** …of those, how many disagreed by more than 2x — a broken-join signal, not an accuracy bar. */
  shorelineDisagreed: number;
  rejects: { key: string; reason: string }[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function runImport(lakes: unknown[]): MatchResult {
  const parsed = convexRun<unknown>('waterBodies:matchAndImportDepths', { lakes });
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { updated?: unknown }).updated !== 'number'
  ) {
    throw new Error(`convex run returned an unexpected response: ${JSON.stringify(parsed)}`);
  }
  return parsed as MatchResult;
}

function main(): void {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const batchArg = Number(args.find((a) => a.startsWith('--batch='))?.slice('--batch='.length));
  const batchSize =
    Number.isFinite(batchArg) && batchArg > 0 ? Math.floor(batchArg) : DEFAULT_BATCH_COUNT;
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath) {
    process.stderr.write(
      'usage: pnpm --filter @skating/lake-depth load <depths.ndjson> [--prod] [--campaign=<id>]\n' +
        '       [--batch=N]   (lower it if a dense region blows the 16 MB read cap)\n',
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[lake-depth] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[lake-depth] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const lakes = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const batches = chunk(lakes, batchSize);
  process.stderr.write(
    `[lake-depth] matching ${lakes.length} source lakes in ${batches.length} batch(es) of ${batchSize}…\n`,
  );

  const totals = {
    updated: 0,
    unmatched: 0,
    matchedByProximity: 0,
    proximityUnconfirmed: 0,
    areaRejected: 0,
    skipped: 0,
    noAreaGate: 0,
    operatorHeld: 0,
    inverted: 0,
    shorelineCompared: 0,
    shorelineDisagreed: 0,
  };
  const rejects: { key: string; reason: string }[] = [];
  let applied = 0;

  const logger = new RunLogger({
    kind: 'lake_depth',
    label: 'lake depth join (HydroLAKES / GLOBathy / LAGOS-US)',
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'match',
        detail:
          'waterBodies:matchAndImportDepths — spatial match then the D68 precedence ladder, enforced server-side so nothing downgrades',
        input: inputPath,
        output: target.label,
      },
    ],
  });
  logger.start();

  let failedBatches = 0;
  let lakesInFailedBatches = 0;
  let consecutiveFailures = 0;
  let aborted: Error | undefined;

  for (const [index, batch] of batches.entries()) {
    try {
      const result = runImport(batch);
      totals.updated += result.updated;
      totals.unmatched += result.unmatched;
      totals.matchedByProximity += result.matchedByProximity ?? 0;
      totals.proximityUnconfirmed += result.proximityUnconfirmed ?? 0;
      totals.areaRejected += result.areaRejected;
      totals.skipped += result.skipped;
      totals.noAreaGate += result.noAreaGate ?? 0;
      totals.operatorHeld += result.operatorHeld ?? 0;
      totals.inverted += result.inverted ?? 0;
      totals.shorelineCompared += result.shorelineCompared ?? 0;
      totals.shorelineDisagreed += result.shorelineDisagreed ?? 0;
      rejects.push(...(result.rejects ?? []));
      applied++;
      consecutiveFailures = 0;
      if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
        process.stderr.write(`[lake-depth] batch ${index + 1}/${batches.length} done\n`);
        // Push progress to the run row too, not just the terminal. This pass is ~5,000 batches and
        // hours long; without it `/admin/imports` shows a `running` row with no counts for the whole
        // run, which is exactly the window an operator most wants to look at it. The water ETL
        // already did this — the omission here was the third variant of the same oversight.
        for (const [name, value] of Object.entries(totals)) logger.count(name, value);
        logger.count('batchesApplied', applied);
        logger.count('batchesFailed', failedBatches);
        logger.flush();
      }
    } catch (err) {
      failedBatches++;
      lakesInFailedBatches += batch.length;
      consecutiveFailures++;
      const message = err instanceof Error ? err.message : String(err);
      // Name the lakes, not the batch index: a batch number is meaningless once the scratch file is
      // gone, and these are exactly the ones worth retrying at a smaller --batch.
      const keys = batch
        .map((l) => (l as { key?: string }).key)
        .filter(Boolean)
        .join(' ');
      logger.fail({
        stage: 'match',
        key: keys || `batch ${index + 1}/${batches.length}`,
        reason: message.slice(0, 400),
      });
      process.stderr.write(
        `[lake-depth] batch ${index + 1}/${batches.length} FAILED (${consecutiveFailures} in a row): ` +
          `${message.split('\n')[0]}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        aborted = err instanceof Error ? err : new Error(message);
        break;
      }
    }
  }

  if (aborted) {
    process.stderr.write(
      `[lake-depth] ABORTED after ${MAX_CONSECUTIVE_BATCH_FAILURES} consecutive failures; ` +
        `${applied}/${batches.length} applied. Re-running is safe (the ladder is server-side).\n`,
    );
    for (const [name, value] of Object.entries(totals)) logger.count(name, value);
    logger.count('batchesApplied', applied);
    logger.count('batchesFailed', failedBatches);
    logger.failed(aborted, [
      `Partial join: ${applied}/${batches.length} batches applied. Re-running is safe and idempotent.`,
    ]);
    throw aborted;
  }

  // The match rate is the number worth reading, so it goes first and it is a rate, not a count. A join
  // that stamped 60% of its input reads exactly like one that stamped all of it if you only print totals.
  const rate = lakes.length > 0 ? ((totals.updated / lakes.length) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `[lake-depth] load complete: ${totals.updated}/${lakes.length} stamped (${rate}%) · ` +
      `${totals.skipped} already had a better source · ${totals.unmatched} matched no body · ` +
      `${totals.areaRejected} rejected on area\n`,
  );
  // The two numbers that describe how much of the run went un-checked or was deliberately withheld.
  // Both are expected to be non-zero; both are wrong if they are *large*, and neither is visible from
  // the match rate alone — which is the shape of every silent-cap bug this repo has already hit once.
  process.stderr.write(
    `[lake-depth] of those: ${totals.noAreaGate} matched with no area gate (one side reported no area) · ` +
      `${totals.operatorHeld} held by a moderator's override · ` +
      `${totals.inverted} contradictory mean/max pairs resolved\n`,
  );
  // D85's free cross-check. Printed even at zero, because "HydroLAKES and we agreed everywhere" and
  // "the comparison never ran" are different results that look identical if you only print failures.
  process.stderr.write(
    `[lake-depth] shoreline cross-check (D85): ${totals.shorelineCompared} lakes comparable · ` +
      `${totals.shorelineDisagreed} disagreed by >2× (ours is stored either way)\n`,
  );
  const SHOWN = 30;
  for (const r of rejects.slice(0, SHOWN)) {
    process.stderr.write(`[lake-depth] no match ${r.key}: ${r.reason}\n`);
  }
  if (rejects.length > SHOWN) {
    process.stderr.write(
      `[lake-depth] …and ${rejects.length - SHOWN} more rejections (not shown)\n`,
    );
  }

  // Every reject itemized on the run row — this is the loader whose *whole* interesting output is
  // which lakes it declined and why, and until now that scrolled past 30 lines at a time.
  for (const r of rejects) logger.fail({ stage: 'match', key: r.key, reason: r.reason });

  for (const [name, value] of Object.entries(totals)) logger.count(name, value);
  logger.count('sourceLakes', lakes.length);
  logger.count('batchesApplied', applied);
  // The omissions are the D68 ladder and the area gate doing their jobs — every one of these is a
  // deliberate decline, and naming them is what stops the match rate reading as a shortfall.
  logger.count('batchesFailed', failedBatches);
  logger.coverage({
    unit: 'source lakes',
    eligible: lakes.length,
    covered: totals.updated,
    omissions: [
      { reason: 'already had a higher-precedence source (D68)', count: totals.skipped },
      { reason: 'no body within 500 m — not in our corpus', count: totals.unmatched },
      {
        reason: 'a body was near but nothing corroborated it (area and name both disagreed)',
        count: totals.proximityUnconfirmed,
      },
      { reason: 'rejected on the area gate', count: totals.areaRejected },
      { reason: "held by a moderator's override", count: totals.operatorHeld },
      { reason: 'in a batch that blew the read cap and was skipped', count: lakesInFailedBatches },
    ].filter((o) => o.count > 0),
  });
  logger.stage({
    name: 'match',
    detail:
      'waterBodies:matchAndImportDepths — spatial match then the D68 precedence ladder, enforced server-side so nothing downgrades',
    input: inputPath,
    output: target.label,
    counts: Object.entries(totals).map(([name, value]) => ({ name, value })),
  });
  if (failedBatches > 0) {
    process.stderr.write(
      `[lake-depth] ${failedBatches} batch(es) failed and were skipped (${lakesInFailedBatches} lakes). ` +
        'Retry those at a smaller --batch; every one is named on the run row.\n',
    );
    logger.failed(
      new Error(
        `${failedBatches} of ${batches.length} batches failed and were skipped (${lakesInFailedBatches} lakes)`,
      ),
      [`Retry with a smaller --batch=N. The lakes are named in this run's failures.`],
    );
    process.exitCode = 1;
    return;
  }

  logger.succeed([
    `match rate ${rate}% (${totals.updated}/${lakes.length} source lakes stamped)`,
    `${totals.matchedByProximity} matched by proximity + corroboration rather than containment`,
    `${totals.noAreaGate} matched with no area gate (one side reported no area)`,
    `${totals.inverted} contradictory mean/max pairs resolved`,
    `D85 shoreline cross-check: ${totals.shorelineCompared} comparable, ${totals.shorelineDisagreed} disagreed by >2x (ours stored either way)`,
  ]);
}

main();
