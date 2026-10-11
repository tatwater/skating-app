/**
 * The landmark loader (glue, D202) — reads `landmarks.ndjson` from `pnpm landmarks` and writes it
 * through `landmarks:importBatch`, **dry unless `--apply`**.
 *
 *   pnpm --filter @skating/etl load-landmarks [.scratch/landmarks/landmarks.ndjson] [--campaign=<id>] [--apply] [--without-corpus] [--accept-source-drop] [--accept-mass-drop]
 *
 * Batches are packed by **landmark count across bodies**: ten thousand bodies hold one or two each,
 * and a spawn per body would be hours of `convex run` for seconds of writes. A body is never split
 * across calls (`packLines`). Every rule — the merge, the holds, the cap, the bay-name skip, the
 * drop — is in the mutation and tested there; when `--apply` refuses is `applyRefusal`.
 *
 * Failures are isolated (A06a's rule): a failed batch is recorded with the body ids it carried and
 * the run moves on; five in a row means the deployment is unwell and the run stops.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  acceptsLoad,
  applyRefusal,
  type BodyLine,
  matchedAtOf,
  packLines,
  summarySources,
  type TransformSummary,
} from './landmarkLines';

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

type Counts = Record<
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'removedHeld'
  | 'moderatorHeld'
  | 'overCap'
  | 'bodyNotListed'
  | 'alreadyBay'
  | 'invalidName'
  | 'dropped'
  | 'dropsHeld'
  | 'returned',
  number
>;

let activeLogger: RunLogger | undefined;

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const inputPath = args.find((a) => !a.startsWith('--')) ?? DEFAULT_INPUT;
  // What the transform says about its run decides whether --apply may go ahead (`applyRefusal`).
  const summaryPath = join(dirname(inputPath), 'summary.json');
  const summary = existsSync(summaryPath)
    ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as TransformSummary)
    : undefined;
  const refusal = apply
    ? applyRefusal(summary, { withoutCorpus: args.includes('--without-corpus') })
    : null;
  if (refusal) {
    process.stderr.write(`[landmarks] ${summaryPath}: ${refusal}\n`);
    process.exit(1);
  }
  const target = resolveDeployment();
  process.stderr.write(`[landmarks] target deployment: ${target.label}\n`);

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BodyLine);
  const batches = packLines(lines, BATCH_LANDMARKS);
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
    invalidName: 0,
    dropped: 0,
    dropsHeld: 0,
    returned: 0,
  };
  // A complete line retires rows only when the run's sources vouch for it against the deployment's
  // last accepted load; the importer says when they do not, and the operator may overrule it.
  const sources = summarySources(summary);
  const acceptSourceDrop = args.includes('--accept-source-drop');
  // A separate word: excusing a real catalog shrink must not also lift the per-lake brake.
  const acceptMassDrop = args.includes('--accept-mass-drop');
  let batchesRetried = 0;
  const shortfalls = new Set<string>();
  let failedBatches = 0;
  let consecutive = 0;
  for (const [i, batch] of batches.entries()) {
    try {
      const call = () =>
        convexRun<Counts & { shortfalls?: string[] }>('landmarks:importBatch', {
          bodies: batch,
          ...(campaignId !== undefined ? { campaignId } : {}),
          ...matchedAtOf(summary),
          ...(sources !== undefined ? { sources } : {}),
          ...(acceptSourceDrop ? { acceptSourceDrop } : {}),
          ...(acceptMassDrop ? { acceptMassDrop } : {}),
          dryRun: !apply,
        });
      let counts: Counts & { shortfalls?: string[] };
      try {
        counts = call();
      } catch {
        // One retry: the CLI's own auth check intermittently answers 401 mid-run (seen on the first
        // dry run, 2026-09-29), and the batch is idempotent — a second attempt is always safe. But if
        // the first call committed before the CLI failed, the retry sees its writes as already done
        // and counts them `unchanged`: the run says so rather than under-report quietly.
        batchesRetried++;
        counts = call();
      }
      for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += counts[key] ?? 0;
      for (const shortfall of counts.shortfalls ?? []) shortfalls.add(shortfall);
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
        `[landmarks] ${i + 1}/${batches.length} batches — ${totals.created} created · ${totals.updated} updated · ${totals.dropped} dropped\n`,
      );
    }
  }

  for (const shortfall of shortfalls) {
    process.stderr.write(`[landmarks] sources do not vouch — nothing retired: ${shortfall}\n`);
  }
  if (totals.dropsHeld > 0) {
    process.stderr.write(
      `[landmarks] ${totals.dropsHeld} drops held by the per-lake brake — a lake was about to lose most of its labels. Check the extract; --accept-source-drop if it is real.\n`,
    );
  }
  // Only now, with every batch landed, may this load become the bar the next one is held to.
  const notes: string[] = [];
  if (sources !== undefined && acceptsLoad({ apply, lines, failedBatches })) {
    const result = convexRun<{ accepted: boolean; shortfalls: string[] }>(
      'landmarks:acceptCompleteLoad',
      {
        sources,
        ...(campaignId !== undefined ? { campaignId } : {}),
        ...(acceptSourceDrop ? { acceptSourceDrop } : {}),
      },
    );
    const note = result.accepted
      ? 'source counts accepted as the deployment’s new baseline'
      : `source counts NOT accepted as the baseline (${result.shortfalls.join('; ')})`;
    notes.push(note);
    process.stderr.write(`[landmarks] ${note}\n`);
  }

  logger.count('bodies', lines.length);
  logger.count('landmarksRead', landmarkCount);
  for (const [name, value] of Object.entries(totals)) logger.count(name, value);
  logger.count('batchesFailed', failedBatches);
  logger.count('batchesRetried', batchesRetried);
  if (batchesRetried > 0) {
    notes.push(
      `${batchesRetried} batch(es) retried: a first attempt that committed before failing is counted as unchanged, so created/updated/dropped may under-report`,
    );
  }
  logger.stage({
    name: 'load',
    detail:
      'landmarks:importBatch — upsert by upstream id or same name nearby; holds removed and moderator rows; retires catalog rows a complete line no longer places',
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
    logger.succeed(notes);
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
