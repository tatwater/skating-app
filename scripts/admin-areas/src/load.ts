/**
 * Admin-areas loader (glue). Chunks admin-area NDJSON into the internal
 * `adminAreas.importCanonical` mutation via the Convex CLI (`pnpm exec convex run`), stamping the
 * required `--state=XX` (2-letter code) onto every row — each per-state extract is one state, so the
 * transform leaves `state` off and the loader injects it here. Loads the **dev** deployment by
 * default; refuses a non-dev target unless `--prod` is passed.
 *
 *   pnpm --filter @skating/admin-areas load <areas.ndjson> --state=VT [--prod]
 *     [--campaign=<id>] [--no-run-log]
 *
 * Writes one `importRuns` row (A06c §6.2) with its coverage and any failed batches, readable at
 * `/admin/imports`. `--no-run-log` opts out; nothing else about the load changes.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { isKnownStateCode, KNOWN_STATE_CODES } from '@skating/core';
import { batchNdjson, convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

/**
 * How many batches may fail back-to-back before the load gives up. Same reasoning as the water
 * ETL: one bad batch is worth surviving because the upsert is idempotent, a streak is a schema
 * mismatch or a dead deployment and is worth failing fast on.
 */
const MAX_CONSECUTIVE_BATCH_FAILURES = 5;

function runImport(areas: unknown[]): { inserted: number; updated: number } {
  const parsed = convexRun<unknown>('adminAreas:importCanonical', { areas });
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { inserted?: unknown }).inserted !== 'number' ||
    typeof (parsed as { updated?: unknown }).updated !== 'number'
  ) {
    throw new Error(`convex run returned an unexpected response: ${JSON.stringify(parsed)}`);
  }
  return parsed as { inserted: number; updated: number };
}

export function loadAdminAreas(args: string[]): number {
  const allowNonDev = args.includes('--prod');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const runLogEnabled = !args.includes('--no-run-log');
  // `--state=XX` is REQUIRED — it's the denormalized `state` code stamped onto every row.
  const state = args
    .find((arg) => arg.startsWith('--state='))
    ?.slice('--state='.length)
    .toUpperCase();
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath || !state) {
    process.stderr.write(
      'usage: pnpm --filter @skating/admin-areas load <areas.ndjson> --state=XX [--prod]\n' +
        '       [--campaign=<id>] [--no-run-log]\n',
    );
    return 1;
  }
  if (!isKnownStateCode(state)) {
    process.stderr.write(
      `[admin-areas] refusing: unknown --state=${state}. Expected one of: ${KNOWN_STATE_CODES.join(', ')}.\n`,
    );
    return 1;
  }

  const target = resolveDeployment();
  process.stderr.write(`[admin-areas] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[admin-areas] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    return 1;
  }

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const batches = batchNdjson(lines);
  process.stderr.write(
    `[admin-areas] loading ${lines.length} areas in ${batches.length} batch(es) (state: ${state})…\n`,
  );

  const loadStage = {
    name: 'load',
    detail:
      'adminAreas:importCanonical — idempotent upsert, cell-indexed (A01); the loader stamps `state` the transform leaves off',
    input: inputPath,
    output: target.label,
  };
  const logger = new RunLogger({
    kind: 'admin_areas',
    label: `${state} admin areas`,
    campaignId,
    target,
    call: convexRun,
    stages: [loadStage],
  });
  if (runLogEnabled) logger.start();

  const { inserted, updated, appliedBatchCount, failedBatchCount, skippedAreaCount, aborted } =
    importBatches(batches, state, logger);
  logger.count('areasRead', lines.length);
  logger.count('batchesTotal', batches.length);
  logger.count('batchesApplied', appliedBatchCount);
  logger.count('batchesFailed', failedBatchCount);
  logger.count('inserted', inserted);
  logger.count('updated', updated);
  logger.coverage({
    unit: 'admin areas',
    eligible: lines.length,
    covered: inserted + updated,
    omissions:
      skippedAreaCount > 0
        ? [{ reason: 'in a batch that failed and was skipped', count: skippedAreaCount }]
        : [],
  });
  logger.stage({
    ...loadStage,
    counts: [
      { name: 'inserted', value: inserted },
      { name: 'updated', value: updated },
      { name: 'batchesFailed', value: failedBatchCount },
    ],
  });

  if (aborted) {
    process.stderr.write(
      `[admin-areas] ABORTED after ${MAX_CONSECUTIVE_BATCH_FAILURES} consecutive batch failures; ` +
        `${appliedBatchCount}/${batches.length} applied. Re-running is safe (idempotent upsert).\n`,
    );
    logger.failed(aborted);
    throw aborted;
  }

  process.stderr.write(
    `[admin-areas] load complete: ${inserted} inserted · ${updated} updated` +
      `${failedBatchCount > 0 ? ` · ${failedBatchCount} batch(es) failed and were skipped` : ''}\n`,
  );
  if (failedBatchCount > 0) {
    logger.failed(
      new Error(`${failedBatchCount} of ${batches.length} batches failed and were skipped`),
    );
    return 1;
  }
  logger.succeed();
  return 0;
}

function importBatches(batches: string[][], state: string, logger: RunLogger) {
  let inserted = 0;
  let updated = 0;
  let appliedBatchCount = 0;
  let failedBatchCount = 0;
  let skippedAreaCount = 0;
  let consecutiveFailures = 0;
  let aborted: Error | undefined;

  for (const [index, batch] of batches.entries()) {
    try {
      // Stamp the state onto every row before sending (transform leaves it off).
      const areas = batch.map((line) => ({ ...JSON.parse(line), state }));
      const result = runImport(areas);
      inserted += result.inserted;
      updated += result.updated;
      appliedBatchCount++;
      consecutiveFailures = 0;
      process.stderr.write(`[admin-areas] batch ${index + 1}/${batches.length} done\n`);
    } catch (err) {
      failedBatchCount++;
      skippedAreaCount += batch.length;
      consecutiveFailures++;
      const message = err instanceof Error ? err.message : String(err);
      logger.fail({
        stage: 'load',
        key: `batch ${index + 1}/${batches.length} (${batch.length} areas)`,
        reason: message,
      });
      process.stderr.write(
        `[admin-areas] batch ${index + 1}/${batches.length} FAILED (${consecutiveFailures} in a row): ${message}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        aborted = err instanceof Error ? err : new Error(message);
        break;
      }
    }

    if ((index + 1) % 25 === 0) {
      logger.count('inserted', inserted);
      logger.count('updated', updated);
      logger.count('batchesApplied', appliedBatchCount);
      logger.flush();
    }
  }

  return { inserted, updated, appliedBatchCount, failedBatchCount, skippedAreaCount, aborted };
}

if (import.meta.main) process.exitCode = loadAdminAreas(process.argv.slice(2));
