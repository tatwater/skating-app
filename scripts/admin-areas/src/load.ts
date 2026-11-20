/**
 * Admin-areas loader (glue). Chunks admin-area NDJSON into the internal
 * `adminAreas.importCanonical` mutation via the Convex CLI (`pnpm exec convex run`), stamping the
 * required `--state=XX` (2-letter code) onto every row — each per-state extract is one state, so the
 * transform leaves `state` off and the loader injects it here. Loads the **dev** deployment by
 * default; refuses a non-dev target unless `--prod` is passed. Thin subprocess + file I/O — excluded
 * from coverage; all real work is in the tested transform.
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

function main(): void {
  const args = process.argv.slice(2);
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
    process.exit(1);
  }
  if (!isKnownStateCode(state)) {
    process.stderr.write(
      `[admin-areas] refusing: unknown --state=${state}. Expected one of: ${KNOWN_STATE_CODES.join(', ')}.\n`,
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[admin-areas] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[admin-areas] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const batches = batchNdjson(lines);
  process.stderr.write(
    `[admin-areas] loading ${lines.length} areas in ${batches.length} batch(es) (state: ${state})…\n`,
  );

  const logger = new RunLogger({
    kind: 'admin_areas',
    label: `${state} admin areas`,
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'load',
        detail:
          'adminAreas:importCanonical — idempotent upsert, cell-indexed (A01); the loader stamps `state` the transform leaves off',
        input: inputPath,
        output: target.label,
      },
    ],
  });
  if (runLogEnabled) logger.start();

  let inserted = 0;
  let updated = 0;
  let applied = 0;
  let failedBatches = 0;
  let skippedAreas = 0;
  let consecutiveFailures = 0;
  let aborted: Error | undefined;

  for (const [index, batch] of batches.entries()) {
    try {
      // Stamp the state onto every row before sending (transform leaves it off).
      const areas = batch.map((line) => ({ ...JSON.parse(line), state }));
      const result = runImport(areas);
      inserted += result.inserted;
      updated += result.updated;
      applied++;
      consecutiveFailures = 0;
      process.stderr.write(`[admin-areas] batch ${index + 1}/${batches.length} done\n`);
    } catch (err) {
      failedBatches++;
      skippedAreas += batch.length;
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
      logger.count('batchesApplied', applied);
      logger.flush();
    }
  }

  logger.count('areasRead', lines.length);
  logger.count('batchesTotal', batches.length);
  logger.count('batchesApplied', applied);
  logger.count('batchesFailed', failedBatches);
  logger.count('inserted', inserted);
  logger.count('updated', updated);
  logger.coverage({
    unit: 'admin areas',
    eligible: lines.length,
    covered: inserted + updated,
    omissions:
      skippedAreas > 0
        ? [{ reason: 'in a batch that failed and was skipped', count: skippedAreas }]
        : [],
  });
  logger.stage({
    name: 'load',
    detail:
      'adminAreas:importCanonical — idempotent upsert, cell-indexed (A01); the loader stamps `state` the transform leaves off',
    input: inputPath,
    output: target.label,
    counts: [
      { name: 'inserted', value: inserted },
      { name: 'updated', value: updated },
      { name: 'batchesFailed', value: failedBatches },
    ],
  });

  if (aborted) {
    process.stderr.write(
      `[admin-areas] ABORTED after ${MAX_CONSECUTIVE_BATCH_FAILURES} consecutive batch failures; ` +
        `${applied}/${batches.length} applied. Re-running is safe (idempotent upsert).\n`,
    );
    logger.failed(aborted);
    throw aborted;
  }

  process.stderr.write(
    `[admin-areas] load complete: ${inserted} inserted · ${updated} updated` +
      `${failedBatches > 0 ? ` · ${failedBatches} batch(es) failed and were skipped` : ''}\n`,
  );
  if (failedBatches > 0) {
    logger.failed(
      new Error(`${failedBatches} of ${batches.length} batches failed and were skipped`),
    );
    process.exitCode = 1;
  } else {
    logger.succeed();
  }
}

main();
