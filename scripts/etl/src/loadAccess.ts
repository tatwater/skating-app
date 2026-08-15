/**
 * The access loader (glue) — chunks the transform's two NDJSON streams into the internal
 * `accessPoints` mutations, which do the geometric join (N6d B3).
 *
 *   pnpm --filter @skating/etl load-access parking  .scratch/access/parking.ndjson [--prod]
 *   pnpm --filter @skating/etl load-access put-ins  .scratch/access/put-ins.ndjson [--prod]
 *
 * **Order is not a suggestion.** A put-in references its lot by OSM id, so every lot has to be a row
 * before the put-in stage runs; out of order, every paired put-in reports `parkingMissing` and loses
 * its parking association silently. That is why the two stages are separate `importRuns` kinds rather
 * than one: the signature of running them backwards should read as a sequencing mistake on
 * `/admin/imports`, not as a data-quality finding.
 *
 * ## Batch size, and the lesson it inherits
 *
 * N6a's first real run blew Convex's **16 MB transaction read cap** at batch 8 of 1,611 with
 * `MAX_BATCH_COUNT = 25`, because what the mutation reads is the *corpus*, not the input — the N1
 * cell index files large bodies at coarse rungs, so one lookup near Champlain drags a ~300 KB polygon
 * in. This join has exactly the same shape, so it starts where that one ended up: **8**, tunable with
 * `--batch=N`.
 *
 * ## Failures are isolated, not fatal
 *
 * Also inherited from N6a: one dense neighbourhood must not kill a run with 1,600 loadable batches
 * behind it. Isolated failures are recorded and skipped, five consecutive aborts, and skipped batches
 * are itemized **by OSM key** — a batch index is meaningless once the scratch file is gone, and the
 * named features are exactly what a `--batch=1` retry needs.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { convexRun, type ImportRunKind, RunLogger, resolveDeployment } from '@skating/run-log';

/** See the header: the corpus is what the mutation reads, so the input's own size proves nothing. */
const DEFAULT_BATCH = 8;

/** Five in a row means the deployment is unwell, not that one neighbourhood is dense. */
const MAX_CONSECUTIVE_FAILURES = 5;

type Stage = 'parking' | 'put-ins';

const STAGES: Record<
  Stage,
  { kind: ImportRunKind; fn: string; arg: string; label: string; detail: string }
> = {
  parking: {
    kind: 'access_parking',
    fn: 'accessPoints:matchAndImportParking',
    arg: 'lots',
    label: 'OSM parking areas (N6d B3)',
    detail:
      'accessPoints:matchAndImportParking — attaches each lot to every body within PARKING_INFER_RADIUS_M (inference only; a human may associate at any distance, D72 amendment)',
  },
  'put-ins': {
    kind: 'access_put_ins',
    fn: 'accessPoints:matchAndImportPutIns',
    arg: 'putIns',
    label: 'OSM put-in candidates (N6d B3)',
    detail:
      'accessPoints:matchAndImportPutIns — attaches each launch to the nearest body within PUTIN_SHORE_RADIUS_M and links its lot',
  },
};

function usage(): never {
  process.stderr.write(
    'usage: pnpm --filter @skating/etl load-access <parking|put-ins> <file.ndjson> [--prod] [--batch=N] [--campaign=<id>]\n',
  );
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const batchArg = args.find((a) => a.startsWith('--batch='))?.slice('--batch='.length);
  const batchSize = batchArg ? Math.max(1, Number.parseInt(batchArg, 10)) : DEFAULT_BATCH;
  const positional = args.filter((a) => !a.startsWith('--'));
  const stage = positional[0] as Stage | undefined;
  const inputPath = positional[1];
  if (!stage || !inputPath || !(stage in STAGES)) usage();
  const spec = STAGES[stage];

  const target = resolveDeployment();
  process.stderr.write(`[access] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[access] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const rows = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { externalId: string });
  if (rows.length === 0) {
    process.stderr.write(`[access] nothing to load: ${inputPath} is empty.\n`);
    return;
  }

  const logger = new RunLogger({
    kind: spec.kind,
    label: spec.label,
    campaignId,
    target,
    call: convexRun,
    stages: [{ name: 'load', detail: spec.detail, input: inputPath, output: target.label }],
  });
  logger.start();

  const totals: Record<string, number> = {};
  const notes: { key: string; reason: string }[] = [];
  const skippedKeys: string[] = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      const result = convexRun<Record<string, unknown>>(spec.fn, { [spec.arg]: batch });
      if (!result || typeof result !== 'object') {
        throw new Error(`convex run returned an unexpected response: ${JSON.stringify(result)}`);
      }
      for (const [name, value] of Object.entries(result)) {
        if (typeof value === 'number') totals[name] = (totals[name] ?? 0) + value;
      }
      if (Array.isArray(result.notes)) {
        notes.push(...(result.notes as { key: string; reason: string }[]));
      }
      consecutiveFailures = 0;
    } catch (err) {
      // Named, not numbered. A batch index is meaningless once `.scratch` is gone; these keys are
      // exactly what a `--batch=1` retry takes.
      consecutiveFailures++;
      for (const row of batch) skippedKeys.push(row.externalId);
      process.stderr.write(
        `[access] batch ${i / batchSize} failed (${String(err)}) — skipping ${batch.length}: ${batch
          .map((r) => r.externalId)
          .join(', ')}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        for (const [name, value] of Object.entries(totals)) logger.count(name, value);
        logger.count('skipped', skippedKeys.length);
        logger.failed(
          new Error(
            `${MAX_CONSECUTIVE_FAILURES} consecutive batch failures — aborting with ${rows.length - i} rows unread`,
          ),
        );
        process.exit(1);
      }
    }
  }

  for (const [name, value] of Object.entries(totals)) logger.count(name, value);
  logger.count('read', rows.length);
  if (skippedKeys.length) logger.count('skippedRows', skippedKeys.length);

  // `covered / inScope`, and name what the pass walked past — the N7-3 rule (D137). The put-in
  // stage's denominator honestly excludes nothing: every candidate was eligible, and the ones with no
  // body near them are a scope boundary (coastal slipways, river landings, ponds below the N7 floor)
  // rather than a failure, so they are named as an omission instead of hidden in the ratio.
  const landed = (totals.created ?? 0) + (totals.updated ?? 0);
  logger.coverage({
    unit: stage === 'parking' ? 'OSM parking areas' : 'OSM put-in candidates',
    eligible: rows.length,
    covered: landed,
    omissions: [
      { reason: 'no corpus body within the association radius', count: totals.noBodyNearby ?? 0 },
      {
        reason: 'a moderator had hidden this access point',
        count: totals.moderatorSuppressed ?? 0,
      },
      { reason: "held by an operator's row (fields untouched)", count: totals.operatorHeld ?? 0 },
      { reason: 'batch failed and was skipped', count: skippedKeys.length },
    ].filter((o) => o.count > 0),
  });

  process.stderr.write(
    `[access] ${stage}: ${landed}/${rows.length} landed · ${JSON.stringify(totals)}\n`,
  );
  // Itemized, not tallied: "17 declined" is a number an operator can do nothing with.
  for (const note of notes.slice(0, 50)) {
    process.stderr.write(`[access]   ${note.key}: ${note.reason}\n`);
  }
  if (notes.length > 50) process.stderr.write(`[access]   …and ${notes.length - 50} more\n`);
  if (skippedKeys.length) {
    process.stderr.write(`[access] skipped keys: ${skippedKeys.join(', ')}\n`);
  }

  logger.stage({ name: 'load', detail: spec.detail, input: inputPath, output: target.label });
  logger.succeed();
}

main();
