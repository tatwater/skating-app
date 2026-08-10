/**
 * Retire the corpus rows the merge absorbed — **the destructive half of D136** (N7-3).
 *
 *   pnpm --filter @skating/etl retire-absorbed [--campaign=<id>] [--apply] [--batch=N]
 *
 * Dry by default, like `prune-floor`, and for the same reason: this is the campaign's second pass
 * that can remove a body from the map, so it says what it would do and changes nothing until told.
 *
 * ## What it fixes
 *
 * `importCanonical` is an upsert. It writes what the merge emitted and **never deletes a row that
 * stopped being emitted** — so when D136's same-source lane decided two OSM features are one lake,
 * the survivor was updated and the absorbed row stayed in the corpus, listed and `dedupStatus:
 * clean`. `Mud Pond Swamp` was still in the corpus twice *after* the lane built to collapse it ran.
 *
 * `pruneNotInCampaign` cannot cover this. It deletes rows the campaign never stamped, but a campaign
 * re-run under its **own id** re-stamps nothing and unstamps nothing, so a row that dropped out
 * between two runs of the same id still reads as current. Re-running a campaign — the most ordinary
 * thing an operator does — blinds the one mechanism that would have caught it.
 *
 * ## It never deletes
 *
 * `retireAbsorbedBodies` folds each absorbed row into its survivor through the same helper the
 * moderator merge uses, so reports, hazards, bounties, tracks, favourites, put-ins, body features and
 * hand-drawn sub-areas all move rather than strand. The row is soft-tombstoned and reads chase
 * `mergedIntoId` to the survivor, which is what keeps a deep link to a retired duplicate working.
 *
 * Idempotent by construction: an already-merged row, a missing row and a self-pair are each skipped
 * and counted, so re-running a campaign is safe.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch', 'merge');
const ABSORBED = join(SCRATCH, 'absorbed.ndjson');

interface Pair {
  survivor: { source: string; externalId: string };
  absorbed: { source: string; externalId: string };
  name?: string;
}

/**
 * Pairs per mutation.
 *
 * Small on purpose: applying one pair fans out over every body-keyed child table, and the merge
 * helper is the heaviest write in this codebase. Sized for the worst pair rather than the median,
 * because unlike the join there is no adaptive splitting to rescue a batch that trips a limit.
 */
const BATCH = 20;

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const batch =
    Number(args.find((a) => a.startsWith('--batch='))?.slice('--batch='.length)) || BATCH;

  if (!existsSync(ABSORBED)) {
    process.stderr.write(
      `[retire] no ${ABSORBED}.\n[retire] Run the merge first — this reads the pairs it decided.\n`,
    );
    process.exit(1);
  }
  const pairs: Pair[] = readFileSync(ABSORBED, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Pair);

  const target = resolveDeployment();
  process.stderr.write(`[retire] target deployment: ${target.label}\n`);
  process.stderr.write(
    `[retire] ${pairs.length} absorbed pair(s) from the merge · ${apply ? 'APPLYING' : 'dry run (pass --apply)'}\n`,
  );
  if (pairs.length === 0) {
    process.stderr.write('[retire] nothing to do.\n');
    return;
  }

  const logger = new RunLogger({
    kind: 'canonical_water',
    label: `retire absorbed duplicates${apply ? '' : ' (dry run)'}`,
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'retire',
        detail:
          'waterBodies:retireAbsorbedBodies — each absorbed row folded into its survivor through the ' +
          'same helper the moderator merge uses. Nothing is deleted; children re-point, the row is ' +
          'tombstoned, and reads chase mergedIntoId.',
        input: ABSORBED,
        output: target.label,
      },
    ],
  });
  logger.start();

  const totals = { scanned: 0, retired: 0 };
  const skipped: Record<string, number> = {};
  const samples: { absorbed: string; into: string; name: string }[] = [];
  // A skip means a duplicate row STAYS. That is at least as worth naming as a retirement.
  const skippedSamples: { pair: string; why: string }[] = [];

  // **Carried across batches, because one row can arrive under two keys.** The mutation's own
  // one-row-once guard is per-call, and two merge-group keys resolving to the same document —
  // `Divol Pond` as both an OSM key and an NHD one — land in different batches whenever the boundary
  // falls between them. Without this the dry run counted such a row twice while `--apply` counted it
  // once, so the dry run stopped predicting the apply at exactly the sizes nobody tests at.
  //
  // These are the RESOLVED row keys the mutation returns, not the input refs, which is what lets two
  // differing keys collapse to one string.
  const retiredKeys: string[] = [];

  for (let i = 0; i < pairs.length; i += batch) {
    const slice = pairs
      .slice(i, i + batch)
      .map((p) => ({ survivor: p.survivor, absorbed: p.absorbed }));
    const result = convexRun<{
      applied: boolean;
      scanned: number;
      retired: number;
      samples: { absorbed: string; into: string; name: string }[];
      retiredKeys: string[];
      skipped: Record<string, number>;
      skippedSamples: { pair: string; why: string }[];
    }>('waterBodies:retireAbsorbedBodies', {
      pairs: slice,
      ...(campaignId ? { campaignId } : {}),
      ...(apply ? { apply: true } : {}),
      ...(retiredKeys.length > 0 ? { alreadyRetired: retiredKeys } : {}),
    });
    retiredKeys.push(...result.retiredKeys);
    totals.scanned += result.scanned;
    totals.retired += result.retired;
    for (const [why, n] of Object.entries(result.skipped)) skipped[why] = (skipped[why] ?? 0) + n;
    for (const s of result.samples) if (samples.length < 25) samples.push(s);
    for (const s of result.skippedSamples) if (skippedSamples.length < 25) skippedSamples.push(s);
    logger.count('retired', totals.retired);
    logger.flush();
  }

  process.stderr.write(
    `\n[retire] ${apply ? 'retired' : 'WOULD retire'} ${totals.retired} of ${totals.scanned} pair(s)\n`,
  );
  // Named, not just tallied. A retirement you cannot look up is a deletion nobody can check — the
  // same rule the drop ledger and the reject list follow.
  for (const s of samples) {
    process.stderr.write(`[retire]   ${s.absorbed} → ${s.into}  ${s.name}\n`);
  }
  if (samples.length < totals.retired) {
    process.stderr.write(`[retire]   … and ${totals.retired - samples.length} more\n`);
  }
  for (const [why, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`[retire]   ${n} skipped — ${why}\n`);
  }
  // "Survivor not in the corpus" is the only skip that leaves a duplicate behind AND is not the
  // expected steady state, so its pairs are printed rather than tallied.
  for (const s of skippedSamples.filter((x) => x.why !== 'absorbed row does not exist')) {
    process.stderr.write(`[retire]     ${s.pair}  (${s.why})\n`);
  }

  logger.count('scanned', totals.scanned);
  for (const [why, n] of Object.entries(skipped)) logger.count(`skipped:${why}`, n);
  logger.coverage({
    unit: 'absorbed pairs',
    eligible: totals.scanned,
    covered: totals.retired,
    omissions: Object.entries(skipped).map(([reason, count]) => ({ reason, count })),
  });
  logger.succeed([
    apply
      ? `${totals.retired} duplicate row(s) folded into their survivors; nothing deleted`
      : `dry run — ${totals.retired} would be retired. Re-run with --apply.`,
  ]);
}

main();
