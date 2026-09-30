/**
 * The corpus-name loader (glue, D202) — reads `corpus-names.ndjson` from `pnpm landmarks` and loads
 * it into the moderator's queue through `corpusPlaceNames:importBatch`, **dry unless `--apply`**.
 *
 *   pnpm --filter @skating/etl load-landmark-names [.scratch/landmarks/corpus-names.ndjson] [--campaign=<id>] [--apply]
 *
 * Idempotent: an open name gets the run's counts, a placed or dismissed one is left as a moderator
 * left it (the mutation's rules, tested there). A few hundred rows, so one call per hundred.
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
  'corpus-names.ndjson',
);
const BATCH = 100;

type Counts = { created: number; refreshed: number; unchanged: number; decidedHeld: number };

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const inputPath = args.find((a) => !a.startsWith('--')) ?? DEFAULT_INPUT;
  const target = resolveDeployment();
  process.stderr.write(`[landmark-names] target deployment: ${target.label}\n`);
  const names = readFileSync(inputPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

  const logger = new RunLogger({
    kind: 'landmark_seed',
    label: 'Corpus place names no landmark took — the moderator queue (D202)',
    campaignId,
    target,
    call: convexRun,
    stages: [],
    notes: [apply ? 'applied' : 'dry run — nothing written'],
  });
  logger.start();
  const totals: Counts = { created: 0, refreshed: 0, unchanged: 0, decidedHeld: 0 };
  try {
    for (let i = 0; i < names.length; i += BATCH) {
      const counts = convexRun<Counts>('corpusPlaceNames:importBatch', {
        names: names.slice(i, i + BATCH),
        ...(campaignId !== undefined ? { campaignId } : {}),
        dryRun: !apply,
      });
      for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += counts[key];
    }
  } catch (error) {
    logger.failed(error);
    throw error;
  }
  logger.count('namesRead', names.length);
  for (const [key, value] of Object.entries(totals)) logger.count(key, value);
  logger.succeed();
  process.stdout.write(`${JSON.stringify({ apply, names: names.length, ...totals }, null, 2)}\n`);
  if (!apply) process.stderr.write('[landmark-names] DRY RUN — re-run with --apply to write.\n');
}

main();
