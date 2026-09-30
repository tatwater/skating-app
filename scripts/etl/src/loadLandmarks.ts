/**
 * The landmark loader (glue, D202) — reads `landmarks.ndjson` from `pnpm landmarks` and writes it
 * through `landmarks:importBatch`, **dry unless `--apply`**.
 *
 *   pnpm --filter @skating/etl load-landmarks [.scratch/landmarks/landmarks.ndjson] [--campaign=<id>] [--apply]
 *
 * Batches are packed by **landmark count across bodies**: ten thousand bodies hold one or two each,
 * and a spawn per body would be hours of `convex run` for seconds of writes. A giant's list is split
 * across calls; the mutation re-reads the body's rows each time, so the per-body cap and the
 * same-place merge stay exact across the split. Every rule — the merge, the holds, the cap, the
 * bay-name skip — is in the mutation and tested there.
 *
 * Failures are isolated (A06a's rule): a failed batch is recorded with the body ids it carried and
 * the run moves on; five in a row means the deployment is unwell and the run stops.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

const DEFAULT_INPUT = join(
  fileURLToPath(new URL('..', import.meta.url)),
  '.scratch',
  'landmarks',
  'landmarks.ndjson',
);

/**
 * Landmarks per call. Each carries a few hundred bytes, and each body in a batch costs the mutation
 * one body read (its polygon — Champlain's 300 KB), its landmark rows and its bays: 300 keeps a batch
 * of small ponds well inside the 16 MB read cap and the one-second budget.
 */
const BATCH_LANDMARKS = 300;
const MAX_CONSECUTIVE_FAILURES = 5;

interface BodyLine {
  waterBodyId: string;
  landmarks: unknown[];
}

type Counts = Record<
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'removedHeld'
  | 'moderatorHeld'
  | 'overCap'
  | 'bodyNotListed'
  | 'alreadyBay',
  number
>;

/** Pack bodies into calls of about `BATCH_LANDMARKS` landmarks, splitting a body that alone exceeds it. */
function pack(lines: readonly BodyLine[]): BodyLine[][] {
  const batches: BodyLine[][] = [];
  let current: BodyLine[] = [];
  let size = 0;
  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
    size = 0;
  };
  for (const line of lines) {
    for (let i = 0; i < line.landmarks.length; i += BATCH_LANDMARKS) {
      const part = line.landmarks.slice(i, i + BATCH_LANDMARKS);
      if (size + part.length > BATCH_LANDMARKS) flush();
      current.push({ waterBodyId: line.waterBodyId, landmarks: part });
      size += part.length;
    }
  }
  flush();
  return batches;
}

let activeLogger: RunLogger | undefined;

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const inputPath = args.find((a) => !a.startsWith('--')) ?? DEFAULT_INPUT;
  const target = resolveDeployment();
  process.stderr.write(`[landmarks] target deployment: ${target.label}\n`);

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BodyLine);
  const batches = pack(lines);
  const landmarkCount = lines.reduce((n, l) => n + l.landmarks.length, 0);

  const logger = new RunLogger({
    kind: 'landmark_seed',
    label: 'Named landmarks — OSM + GNIS + the corpus (D202)',
    campaignId,
    target,
    call: convexRun,
    stages: [],
    notes: [
      'Matched to bodies offline against landmarks:listBodyGeometry; written per body by landmarks:importBatch.',
      apply ? 'applied' : 'dry run — nothing written',
    ],
  });
  logger.start();
  activeLogger = logger;

  const totals: Counts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    removedHeld: 0,
    moderatorHeld: 0,
    overCap: 0,
    bodyNotListed: 0,
    alreadyBay: 0,
  };
  let failedBatches = 0;
  let consecutive = 0;
  for (const [i, batch] of batches.entries()) {
    try {
      const call = () =>
        convexRun<Counts>('landmarks:importBatch', {
          bodies: batch,
          ...(campaignId !== undefined ? { campaignId } : {}),
          dryRun: !apply,
        });
      let counts: Counts;
      try {
        counts = call();
      } catch {
        // One retry: the CLI's own auth check intermittently answers 401 mid-run (seen on the first
        // dry run, 2026-09-29), and the batch is idempotent — a second attempt is always safe.
        counts = call();
      }
      for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += counts[key] ?? 0;
      consecutive = 0;
    } catch (err) {
      failedBatches++;
      consecutive++;
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      for (const line of batch) {
        logger.fail({ stage: 'load', key: line.waterBodyId, reason: `batch failed: ${message}` });
      }
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `${MAX_CONSECUTIVE_FAILURES} batches failed in a row — stopping (${message})`,
        );
      }
    }
    if ((i + 1) % 10 === 0 || i + 1 === batches.length) {
      process.stderr.write(
        `[landmarks] ${i + 1}/${batches.length} batches — ${totals.created} created · ${totals.updated} updated\n`,
      );
    }
  }

  logger.count('bodies', lines.length);
  logger.count('landmarksRead', landmarkCount);
  for (const [name, value] of Object.entries(totals)) logger.count(name, value);
  logger.count('batchesFailed', failedBatches);
  logger.stage({
    name: 'load',
    detail:
      'landmarks:importBatch — upsert by upstream id or same name nearby; holds removed and moderator rows',
    input: inputPath,
    output: target.label,
    counts: Object.entries(totals).map(([name, value]) => ({ name, value })),
  });
  process.stdout.write(
    `${JSON.stringify({ apply, bodies: lines.length, landmarks: landmarkCount, ...totals, failedBatches }, null, 2)}\n`,
  );
  if (!apply) process.stderr.write('[landmarks] DRY RUN — re-run with --apply to write.\n');
  if (failedBatches > 0) {
    logger.failed(new Error(`${failedBatches} batch(es) failed`));
    process.exitCode = 1;
  } else {
    logger.succeed();
  }
}

try {
  main();
} catch (error) {
  activeLogger?.failed(error instanceof Error ? error : new Error(String(error)));
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
