/**
 * Derive every live bay's max depth from its parent's archived survey, and load it (A09 PR 2).
 *
 *   pnpm --filter @skating/bathymetry export-bay-depths [--dry] [--out=path] [--campaign=<id>]
 *
 * ## Shape
 *
 * Read the cached join (`.scratch/join/lakes.json`, archived lake → corpus body), export the live
 * bays from Convex (`subAreas:exportForDepths` — id, our own key, parent id, outline, when the
 * outline last moved), read the archives, clip each parent's soundings or isobaths to each bay
 * (`bayDepths.ts`, the tested rule), write the result to a file, and load it through
 * `subAreas:setDerivedDepth`, which matches on the key and refuses any bay whose outline moved after
 * this run's snapshot. One `importRuns` row.
 *
 * Unlike `export-depths` this loads in the same run: the consumer is a Convex table this script
 * already reads from, not another package's join, so a file between the two halves would be a seam
 * with nothing on the other side. The file is still written — it is what the run row points at.
 *
 * ## Why a redraw needs a re-run rather than a recompute
 *
 * The inputs are here, on disk, and nowhere else. `subAreas.rederiveSubArea` therefore *clears* a
 * bay's depth when its outline moves and the admin card asks for this to be run again; nothing
 * beats stale (D3).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { type BayDepth, bayDepths, type ExportedBay } from './bayDepths';
import { readJoin } from './join';
import { readAllLakes } from './lakeSources';
import type { ArchivedLake } from './lakes';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, '..', '.scratch', 'bay-depths.ndjson');

/** Rows per `setDerivedDepth` call — each is one indexed read and one patch, well inside a mutation. */
const LOAD_BATCH = 50;
/** Skipped pairs named on the run row. Enough to recognize a pattern, small enough for a row. */
const SKIP_SAMPLE_CAP = 15;

function log(message: string): void {
  process.stderr.write(`[export-bay-depths] ${message}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** Archived lakes grouped by the corpus body the join matched them to. */
function lakesByParent(lakes: readonly ArchivedLake[]): Map<string, ArchivedLake[]> {
  const joined = readJoin();
  const byParent = new Map<string, ArchivedLake[]>();
  for (const lake of lakes) {
    const match = joined[`${lake.sourceKey}:${lake.lakeKey}`];
    if (!match?.waterBodyId) continue;
    const list = byParent.get(match.waterBodyId);
    if (list) list.push(lake);
    else byParent.set(match.waterBodyId, [lake]);
  }
  return byParent;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const outPath = flag(args, 'out') ?? DEFAULT_OUT;

  const logger = new RunLogger({
    kind: 'lake_depth',
    label: `bay max depth, clipped from the bathymetry archives${dry ? ' (dry run)' : ''}`,
    campaignId: flag(args, 'campaign'),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'bays · export',
        detail: 'live sub-areas with their outlines, from subAreas:exportForDepths',
      },
      {
        name: 'max depth · clip',
        detail:
          "deepest sounding inside each bay's outline; for a contour lane, the deepest isobath with a " +
          'vertex inside — a LOWER BOUND, flagged understatesMax',
        output: outPath,
      },
      {
        name: 'bays · load',
        detail:
          'subAreas:setDerivedDepth, matched on subAreaKey, refused when the outline is no longer the one exported',
      },
    ],
  });
  logger.start();

  try {
    log('exporting live bays…');
    const exportedAt = Date.now();
    const bays = convexRun<ExportedBay[]>('subAreas:exportForDepths', {});
    log(`${bays.length} live bays on ${new Set(bays.map((b) => b.waterBodyId)).size} parents`);

    log('reading every archived lake…');
    const lakes = await readAllLakes();
    const byParent = lakesByParent(lakes);
    const covered = bays.filter((b) => byParent.has(b.waterBodyId));
    log(
      `${lakes.length.toLocaleString()} archived lakes; ${covered.length} of ${bays.length} bays ` +
        `sit on a parent the archive covers`,
    );

    const { depths, skipped, skippedPairs, uncovered } = bayDepths(bays, byParent);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      depths.length > 0
        ? `${depths.map((d) => JSON.stringify({ ...d, exportedAt })).join('\n')}\n`
        : '',
    );
    const floors = depths.filter((d) => d.understatesMax).length;
    log(`${depths.length} bays with a maximum depth → ${outPath}`);
    log(
      `  ${depths.length - floors} from soundings (a measurement) · ${floors} from an isobath (a floor)`,
    );
    for (const [reason, n] of Object.entries(skipped)) if (n > 0) log(`  skipped ${n} · ${reason}`);
    log(`  ${uncovered} bays on a parent no archive covers — no depth, correctly`);

    // Written and refused are recorded on the run row **after every batch**, not once at the end:
    // a batch is a committed mutation, so if a later one fails the earlier ones stand, and a failed
    // row that said nothing about them would hide exactly how much landed and how much to repair.
    logger.count('withMaxDepth', depths.length);
    let written = 0;
    const refused: { subAreaKey: string; reason: string }[] = [];
    for (let i = 0; i < depths.length; i += LOAD_BATCH) {
      const batch: BayDepth[] = depths.slice(i, i + LOAD_BATCH);
      const result = convexRun<{
        written: number;
        refused: { subAreaKey: string; reason: string }[];
      }>('subAreas:setDerivedDepth', {
        rows: batch.map((d) => ({
          subAreaKey: d.subAreaKey,
          maxDepthM: d.maxDepthM,
          understatesMax: d.understatesMax,
          ...(d.geometryUpdatedAt !== undefined ? { geometryUpdatedAt: d.geometryUpdatedAt } : {}),
        })),
        ...(dry ? { dryRun: true } : {}),
      });
      written += result.written;
      refused.push(...result.refused);
      for (const r of result.refused)
        logger.fail({ stage: 'bays · load', key: r.subAreaKey, reason: r.reason });
      logger.count('written', written);
      logger.count('refused', refused.length);
      logger.flush();
    }
    log(`${dry ? 'would write' : 'wrote'} ${written} · refused ${refused.length}`);

    logger.count('bays', bays.length);
    logger.count('bays.covered', covered.length);
    logger.count('bays.uncovered', uncovered);
    logger.count('fromSoundings', depths.length - floors);
    logger.count('fromContours', floors);
    for (const [reason, n] of Object.entries(skipped))
      if (n > 0) logger.count(`skipped.${reason}`, n);
    logger.coverage({
      unit: 'live bays',
      eligible: bays.length,
      covered: depths.length,
      omissions: [
        { reason: 'parent not in the bathymetry archive', count: uncovered },
        ...Object.entries(skipped)
          .filter(([, n]) => n > 0)
          .map(([reason, count]) => ({ reason, count })),
      ],
    });
    logger.succeed([
      `${written} bay depths ${dry ? 'would be ' : ''}written from ${depths.length} derived`,
      ...(skippedPairs.length > 0
        ? [
            `skipped: ${skippedPairs
              .slice(0, SKIP_SAMPLE_CAP)
              .map((s) => `${s.bay} ← ${s.lake} (${s.reason})`)
              .join(', ')}`,
          ]
        : []),
    ]);
  } catch (err) {
    logger.failed(err);
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[export-bay-depths] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
