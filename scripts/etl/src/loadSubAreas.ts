/**
 * Load the merge's bays into `waterBodySubAreas` (N7 second intake audit, step 5b).
 *
 *   pnpm --filter @skating/etl load-sub-areas <sub-areas.ndjson> --actor=<profileId> [--apply]
 *
 * ## Why this is a separate pass, after the bodies
 *
 * A sub-area is resolved to its parent **by catalogue id** and clipped to that parent's polygon, so
 * the parent has to exist first. Running it as part of the body load would mean resolving a parent
 * that may be later in the same file — which is exactly the ordering trap this phase keeps meeting,
 * one table down. Two commands, in order, is the version that cannot be got wrong:
 *
 * ```
 * pnpm --filter @skating/etl load .scratch/merge/bodies.ndjson --campaign=<id>
 * pnpm --filter @skating/etl load-sub-areas .scratch/merge/sub-areas.ndjson --actor=<id> --apply
 * ```
 *
 * **Dry by default.** `--apply` writes; without it the mutation reports what each bay would do,
 * including which ones cannot find their parent.
 *
 * Thin subprocess + file I/O — the decisions are `bayParent` in `mergeRules.ts` (which bay has a
 * parent) and `subAreas.importBaySubAreas` (whether the clip survives), both tested.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { loadMergeProvenance } from './mergeProvenance';

/** One line of `sub-areas.ndjson`, as `masterList.ts` emits it. */
interface SubAreaRow {
  name: string;
  polygon: unknown;
  parentIds: { osmId?: string; nhdId?: string; threeDhpId?: string; gnisId?: string };
}

/**
 * Bays per mutation call — **one**, and the number was measured down to it in three steps.
 *
 * 25 timed out on every batch; 4 timed out on 13 of 28. One succeeds, including the worst case in
 * the artifact: Spencer Bay clipped against **Moosehead Lake**, 100% retained.
 *
 * ```
 * Error: Function execution timed out (maximum duration: 1s)
 * ```
 *
 * The cost is not the payload and it is not the bay — it is the **parent**. A bay is an arm of a big
 * lake by construction, so every clip here runs against one of the largest polygons in the corpus,
 * and every failure was a bay of Moosehead or Winnipesaukee. `subAreas.importSeed` had already
 * written the answer down: *"a clip against it is comfortable alone and blows a mutation's 1s budget
 * at a dozen (measured in the N2 curation session)."* **Comfortable alone** is the operative phrase,
 * and this pass now takes it literally.
 *
 * The artifact is ~112 rows once per campaign, so one-at-a-time costs about five minutes of
 * subprocess round-trips — which is nothing against a pass that only runs when the corpus is rebuilt.
 *
 * **A count and not a byte budget**, unlike `load.ts`: the binding limit there is ARG_MAX on the
 * serialized args, and here it is compute inside the mutation, which payload size does not predict.
 */
const MAX_BATCH = 1;

/** Set once `main` has opened its run row, so the top-level catch can close it as failed. */
let activeLogger: RunLogger | undefined;

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const actorUserId = args.find((a) => a.startsWith('--actor='))?.slice('--actor='.length);
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const mergeManifestFlag = args
    .find((a) => a.startsWith('--merge-manifest='))
    ?.slice('--merge-manifest='.length);
  const inputPath = args.find((a) => !a.startsWith('--'));

  if (!inputPath || !actorUserId) {
    process.stderr.write(
      'usage: pnpm --filter @skating/etl load-sub-areas <sub-areas.ndjson> ' +
        '--actor=<profileId> [--campaign=<id>] [--merge-manifest=<path>] [--apply]\n' +
        '  --actor is required: every sub-area write is audited to a person (N2/D60).\n' +
        '  A merge-manifest.json beside the input is read automatically for the run path.\n',
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[etl] target deployment: ${target.label}\n`);

  const rows: SubAreaRow[] = readFileSync(inputPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SubAreaRow);

  // The same default as `load.ts`: the merge writes its whole path beside the artifact, so the bay
  // seed inherits it without being asked. A sub-area load whose Path stops at "load" cannot answer
  // which archives its parents came from, and the answer is sitting in the same directory.
  const found = loadMergeProvenance(inputPath, mergeManifestFlag);
  if (found) {
    process.stderr.write(
      `[etl] provenance: replaying ${found.manifest.stages?.length ?? 0} upstream stage(s) from ${found.path}\n`,
    );
  }

  const logger = new RunLogger({
    kind: 'sub_area_seed',
    label: 'N7 bays — an arm is not a lake',
    campaignId: campaignId ?? found?.manifest.campaignId,
    target,
    stages: found?.manifest.stages ?? [],
    call: convexRun,
    notes: [
      'Bays the merge found a parent for. Parent resolved by catalogue id, outline clipped to it.',
      'Run AFTER waterBodies:importCanonical — the parent has to exist.',
      ...(found ? [`path replayed from ${found.path}`] : []),
    ],
  });
  logger.start();
  activeLogger = logger;

  let created = 0;
  let refused = 0;
  let failedBatches = 0;
  for (let i = 0; i < rows.length; i += MAX_BATCH) {
    const batch = rows.slice(i, i + MAX_BATCH);
    // **One bad batch is not the run** — the same rule `load.ts` follows, and it was missing here.
    // The clip is the expensive part and its cost is set by the *parent*, so a single arm of an
    // exceptionally large lake can exceed the mutation's 1-second budget however small the batch is.
    // Aborting on that throws away the other 111 bays to report one; recording it does not.
    try {
      const result = convexRun<{
        created: number;
        refused: number;
        results: { name: string; ok: boolean; reason?: string; parent?: string }[];
      }>('subAreas:importBaySubAreas', {
        actorUserId,
        dryRun: !apply,
        bays: batch.map((r) => ({
          name: r.name,
          polygon: r.polygon,
          // `gnisId` is deliberately not passed: it proposes candidates and 158 of them resolve to
          // more than one body, so it may not decide which lake a bay belongs to.
          parentIds: {
            ...(r.parentIds.osmId ? { osmId: r.parentIds.osmId } : {}),
            ...(r.parentIds.nhdId ? { nhdId: r.parentIds.nhdId } : {}),
            ...(r.parentIds.threeDhpId ? { threeDhpId: r.parentIds.threeDhpId } : {}),
          },
        })),
      });
      created += result.created;
      refused += result.refused;
      for (const r of result.results) {
        if (r.ok) continue;
        // A bay that cannot find its parent is a finding, not a statistic: it means the body load
        // did not include the lake this arm belongs to.
        logger.fail({ stage: 'load', key: r.name, reason: r.reason ?? 'refused' });
      }
      process.stderr.write(
        `[etl] bays ${Math.min(i + MAX_BATCH, rows.length)}/${rows.length} — ` +
          `${result.created} created · ${result.refused} refused\n`,
      );
    } catch (err) {
      failedBatches++;
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      for (const r of batch) {
        logger.fail({ stage: 'load', key: r.name, reason: `batch failed: ${message}` });
      }
      process.stderr.write(
        `[etl] bays ${Math.min(i + MAX_BATCH, rows.length)}/${rows.length} — ` +
          `BATCH FAILED (${batch.map((r) => r.name).join(', ')}): ${message}\n`,
      );
    }
  }

  logger.count('baysRead', rows.length);
  logger.count('created', created);
  logger.count('refused', refused);
  logger.count('batchesFailed', failedBatches);
  logger.stage({
    name: 'load',
    detail:
      'subAreas:importBaySubAreas — parent by catalogue id (D93), outline clipped to the parent (D60)',
    input: inputPath,
    output: target.label,
    counts: [
      { name: 'created', value: created },
      { name: 'refused', value: refused },
    ],
  });
  process.stderr.write(
    `[etl] ${apply ? 'applied' : 'DRY RUN'}: ${created} sub-area(s) created · ${refused} refused` +
      `${failedBatches > 0 ? ` · ${failedBatches} batch(es) failed` : ''}\n` +
      (apply ? '' : '[etl] re-run with --apply to write.\n'),
  );
  if (refused > 0 || failedBatches > 0) {
    logger.failed(
      new Error(
        `${refused} of ${rows.length} bays refused; ${failedBatches} batch(es) failed outright`,
      ),
    );
    process.exitCode = 1;
  } else {
    logger.succeed();
  }
}

// **The run row must not be left `running`** (D99). The first attempt at this pass threw out of
// `main` on a mutation timeout and left three rows in that state on dev — the exact signature D99
// records from the abandoned N6c campaign, reproduced by the loader written to honour it. `merge.ts`
// has carried this handler since the first audit; this file was written without it.
try {
  main();
} catch (error) {
  process.stderr.write(`[etl] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  activeLogger?.failed(error);
  process.exitCode = 1;
}
