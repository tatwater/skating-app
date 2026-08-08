/**
 * Resolve the `merge` verdicts a canonical load declined (N7).
 *
 *   pnpm --filter @skating/etl resolve-merge-duplicates            # dry — names every deletion
 *   pnpm --filter @skating/etl resolve-merge-duplicates --apply
 *
 * ## What it is for
 *
 * A master list that now collapses a duplicate pair meets a corpus still holding both halves. The
 * incoming record carries both catalogue ids, `resolveUpsert` returns `merge`, and — by D93's rule
 * that an automatic merge which is wrong is unrecoverable in a way a queued one is not — the loader
 * writes nothing and flags both rows. Run 7 produced **110** of these, every one a pair the
 * gazetteer ordering fix correctly collapsed.
 *
 * The loader writes those records to `unresolved.ndjson` beside the artifact they came from, and
 * this reads it. Nothing is re-derived: the survivor is chosen by the record's own arrival key.
 *
 * **Run the load again afterwards.** This deletes the losing rows; it does not write the merged
 * record. The load is idempotent, and the second pass is what actually lands those bodies.
 *
 * Untestable subprocess + file glue, excluded from coverage — every rule lives in
 * `waterBodies.resolveIncomingMergeDuplicates`, which is covered.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(HERE, '..', '.scratch', 'merge', 'unresolved.ndjson');

/**
 * Records per mutation call.
 *
 * Each one costs up to three index probes plus, per losing row, an attachment scan (≤10 probes) and
 * a coverage lookup — so the document cap binds well before the byte cap here. 25 keeps the worst
 * case around 350 reads, an order of magnitude inside the limit, and the whole set is ~110 records.
 */
const BATCH = 25;

interface UnresolvedRecord {
  externalId: string;
  osmId?: string;
  nhdId?: string;
  threeDhpId?: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const includeCoverageReferenced = process.argv.includes('--include-coverage-referenced');
  const campaignId = process.argv
    .find((a) => a.startsWith('--campaign='))
    ?.slice('--campaign='.length);
  const file = process.argv.find((a) => a.endsWith('.ndjson')) ?? DEFAULT_FILE;

  if (!existsSync(file)) {
    process.stderr.write(
      `[resolve] missing ${file}\n` +
        '[resolve] the loader writes it when it declines a record; if the last load reported\n' +
        '[resolve]   "0 queued for dedup review", there is nothing to resolve.\n',
    );
    process.exit(1);
  }

  const records: UnresolvedRecord[] = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const body = JSON.parse(line) as UnresolvedRecord;
      // Identity only. The rest of the record is the loader's business, not this pass's, and sending
      // 65 MB of polygons through `convex run` argv would fail for reasons unrelated to dedup.
      return {
        externalId: body.externalId,
        ...(body.osmId !== undefined ? { osmId: body.osmId } : {}),
        ...(body.nhdId !== undefined ? { nhdId: body.nhdId } : {}),
        ...(body.threeDhpId !== undefined ? { threeDhpId: body.threeDhpId } : {}),
      };
    });

  const target = resolveDeployment();
  process.stderr.write(
    `[resolve] ${records.length} unresolved record(s) from ${file}\n` +
      `[resolve] target ${target.label}${apply ? '' : ' — DRY RUN, nothing will be deleted'}\n`,
  );

  const logger = new RunLogger({
    kind: 'dedup_resolve',
    label: 'N7 — merge verdicts the load declined',
    campaignId,
    target,
    call: convexRun,
  });
  logger.start();

  let deletedCount = 0;
  let alreadyResolved = 0;
  const skipped: { externalId: string; reason: string; detail?: string }[] = [];

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const result = convexRun<{
      deletedCount: number;
      alreadyResolved: number;
      deleted: { name: string; externalId?: string; acres: number; survivor: string }[];
      skipped: { externalId: string; reason: string; detail?: string }[];
    }>('waterBodies:resolveIncomingMergeDuplicates', {
      records: batch,
      apply,
      includeCoverageReferenced,
    });
    deletedCount += result.deletedCount;
    alreadyResolved += result.alreadyResolved;
    skipped.push(...result.skipped);
    // **Every deletion named, not sampled.** The prune's dry run had to be made a complete list for
    // exactly this reason: a twenty-row sample of a 110-row deletion is not a review.
    for (const d of result.deleted) {
      process.stdout.write(
        `${apply ? 'deleted' : 'would delete'}  ${d.externalId ?? '(no key)'}  ` +
          `${d.name}  ${d.acres.toLocaleString()} ac  → survivor ${d.survivor}\n`,
      );
    }
    for (const s of result.skipped) {
      logger.fail({
        stage: 'load',
        key: s.externalId,
        reason: `${s.reason}${s.detail ? `: ${s.detail}` : ''}`,
      });
    }
  }

  logger.count('considered', records.length);
  logger.count('deleted', deletedCount);
  logger.count('alreadyResolved', alreadyResolved);
  logger.count('skipped', skipped.length);
  logger.succeed();

  process.stderr.write(
    `[resolve] ${apply ? 'deleted' : 'would delete'} ${deletedCount} · ` +
      `${alreadyResolved} already resolved · ${skipped.length} skipped\n`,
  );
  for (const s of skipped) {
    process.stderr.write(
      `[resolve]   skip ${s.externalId}: ${s.reason}${s.detail ? ` (${s.detail})` : ''}\n`,
    );
  }
  if (!apply && deletedCount > 0) {
    process.stderr.write(
      '[resolve] re-run with --apply to delete, THEN re-run the load — this pass removes the\n' +
        '[resolve]   losing rows; the load is what writes the merged record.\n',
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[resolve] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
