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

/** One line of `sub-areas.ndjson`, as `masterList.ts` emits it. */
interface SubAreaRow {
  name: string;
  polygon: unknown;
  parentIds: { osmId?: string; nhdId?: string; threeDhpId?: string; gnisId?: string };
}

/**
 * Bays per mutation call.
 *
 * Smaller than the body loader's 150 because each row carries a full traced outline **and** costs a
 * polygon clip against a parent that may be Lake Champlain (10,755 vertices). The whole artifact is
 * on the order of a hundred rows, so this is one or two calls in practice.
 */
const MAX_BATCH = 25;

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const actorUserId = args.find((a) => a.startsWith('--actor='))?.slice('--actor='.length);
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const inputPath = args.find((a) => !a.startsWith('--'));

  if (!inputPath || !actorUserId) {
    process.stderr.write(
      'usage: pnpm --filter @skating/etl load-sub-areas <sub-areas.ndjson> ' +
        '--actor=<profileId> [--campaign=<id>] [--apply]\n' +
        '  --actor is required: every sub-area write is audited to a person (N2/D60).\n',
    );
    process.exit(1);
  }

  const target = resolveDeployment();
  process.stderr.write(`[etl] target deployment: ${target.label}\n`);

  const rows: SubAreaRow[] = readFileSync(inputPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SubAreaRow);

  const logger = new RunLogger({
    kind: 'sub_area_seed',
    label: 'N7 bays — an arm is not a lake',
    campaignId,
    target,
    call: convexRun,
    notes: [
      'Bays the merge found a parent for. Parent resolved by catalogue id, outline clipped to it.',
      'Run AFTER waterBodies:importCanonical — the parent has to exist.',
    ],
  });
  logger.start();

  let created = 0;
  let refused = 0;
  for (let i = 0; i < rows.length; i += MAX_BATCH) {
    const batch = rows.slice(i, i + MAX_BATCH);
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
        // `gnisId` is deliberately not passed: it proposes candidates and 92 of them resolve to more
        // than one body, so it may not decide which lake a bay belongs to.
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
      // A bay that cannot find its parent is a finding, not a statistic: it means the body load did
      // not include the lake this arm belongs to.
      logger.fail({ stage: 'load', key: r.name, reason: r.reason ?? 'refused' });
    }
    process.stderr.write(
      `[etl] bays ${Math.min(i + MAX_BATCH, rows.length)}/${rows.length} — ` +
        `${result.created} created · ${result.refused} refused\n`,
    );
  }

  logger.count('baysRead', rows.length);
  logger.count('created', created);
  logger.count('refused', refused);
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
    `[etl] ${apply ? 'applied' : 'DRY RUN'}: ${created} sub-area(s) created · ${refused} refused\n` +
      (apply ? '' : '[etl] re-run with --apply to write.\n'),
  );
  if (refused > 0) {
    logger.failed(new Error(`${refused} of ${rows.length} bays could not be placed`));
    process.exitCode = 1;
  } else {
    logger.succeed();
  }
}

main();
