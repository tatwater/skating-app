/**
 * Write the reconciliation into Convex — campaign step 2's write half (N7).
 *
 *   pnpm --filter @skating/etl load-reconciliation [--dry-run] [--campaign=<id>] [--batch=N]
 *
 * **Deliberately a separate command from `reconcile`.** The matching pass is read-only so its output
 * can be audited before anything is written; a reconciliation that writes as it goes cannot be
 * reviewed before it has already happened. Run `reconcile --audit` first — it fails loudly on a false
 * merge, which is the one error class this loader could make permanent.
 *
 * ## Two outputs, not one
 *
 * A **1:1 match** gets its `nhdId`. A **collapsed group** — two of our bodies matching one NHD
 * feature — gets the dedup queue instead, and no id. Writing the id to both would create exactly the
 * corrupt state `resolveUpsert` refuses to work with, and the duplicate is the more valuable finding
 * anyway: OSM cannot see its own duplicates, and NHD just showed us 55 of them.
 *
 * Untestable network glue; the decision logic is `@skating/core`'s `reconcile.ts` and the write rules
 * are in `waterBodies.importReconciliation`, both tested.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findCollapsedDuplicates, type ReconcileOutcome } from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAPPING = join(HERE, '..', '.scratch', 'reconcile.ndjson');

/**
 * Rows per mutation.
 *
 * Small because each one is a `get` plus a `patch` and Convex caps a transaction at 16 MB of reads —
 * a body averages 1.8 KB but the N1 cell index drags large polygons in, and the N6c depth loader blew
 * that cap at a batch of 25 by counting documents rather than bytes. 250 point-gets by id is a
 * different shape from 25 index scans, but the lesson is to leave headroom.
 */
const DEFAULT_BATCH = 250;

function log(message: string): void {
  process.stderr.write(`[load-reconcile] ${message}\n`);
}

function runMutation(payload: unknown): { idWritten: number; flagged: number; missing: number } {
  const res = spawnSync(
    'pnpm',
    [
      '--filter',
      '@skating/convex',
      'exec',
      'convex',
      'run',
      'waterBodies:importReconciliation',
      JSON.stringify(payload),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: join(HERE, '..', '..', '..') },
  );
  if (res.status !== 0) throw new Error(`convex run failed: ${res.stderr?.slice(0, 500)}`);
  const text = res.stdout ?? '';
  return JSON.parse(text.slice(text.indexOf('{')));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.split('=')[1];
  const batchSize = Number(
    args.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? DEFAULT_BATCH,
  );

  if (!existsSync(MAPPING)) throw new Error(`no mapping at ${MAPPING} — run \`reconcile\` first`);

  const matched: { key: string; id: string }[] = [];
  const rl = createInterface({
    input: createReadStream(MAPPING),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { key: string; outcome: ReconcileOutcome };
    if (row.outcome.verdict === 'matched') matched.push({ key: row.key, id: row.outcome.id });
  }

  const groups = findCollapsedDuplicates(matched);
  const inGroup = new Set(groups.flatMap((g) => g.keys));
  const oneToOne = matched.filter((m) => !inGroup.has(m.key));

  log(`matched bodies        ${matched.length.toLocaleString()}`);
  log(`  1:1 → write nhdId   ${oneToOne.length.toLocaleString()}`);
  log(
    `  in a collapsed group ${inGroup.size.toLocaleString()} across ${groups.length} groups → dedup queue, NO id`,
  );

  const logger = new RunLogger({
    kind: 'raw_archive',
    label: 'load reconciliation (nhdId + dedup flags)',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    notes: [
      'A collapsed group receives the dedup queue rather than the nhdId: writing one id to two rows is the corrupt state resolveUpsert refuses to work with.',
    ],
  });
  logger.start();

  try {
    if (dryRun) {
      log('--dry-run: nothing written');
      logger.count('wouldWriteNhdId', oneToOne.length);
      logger.count('wouldFlagDuplicates', inGroup.size);
      logger.succeed();
      return;
    }

    let written = 0;
    let missing = 0;
    for (let i = 0; i < oneToOne.length; i += batchSize) {
      const chunk = oneToOne.slice(i, i + batchSize);
      const res = runMutation({ matches: chunk.map((m) => ({ key: m.key, nhdId: m.id })) });
      written += res.idWritten;
      missing += res.missing;
      if (i % (batchSize * 10) === 0) {
        log(
          `  ${Math.min(i + batchSize, oneToOne.length).toLocaleString()} / ${oneToOne.length.toLocaleString()}…`,
        );
      }
    }

    let flagged = 0;
    for (let i = 0; i < groups.length; i += 25) {
      const chunk = groups.slice(i, i + 25);
      const res = runMutation({ duplicateGroups: chunk.map((g) => g.keys) });
      flagged += res.flagged;
    }

    log('');
    log(`nhdId written         ${written.toLocaleString()}`);
    log(`bodies flagged dup    ${flagged.toLocaleString()}`);
    if (missing > 0)
      log(`! ${missing} body/bodies no longer exist — the corpus moved under the mapping`);
    logger.count('nhdIdWritten', written);
    logger.count('duplicatesFlagged', flagged);
    logger.count('missing', missing);
    logger.succeed();
  } catch (err) {
    logger.fail({
      stage: 'load',
      key: 'reconciliation',
      reason: err instanceof Error ? err.message : String(err),
    });
    logger.failed(err);
    throw err;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[load-reconcile] FAILED: ${(error as Error).message}\n`);
  process.exit(1);
});
