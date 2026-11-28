/**
 * `pnpm --filter @skating/aerial foliage <campaign> [--threshold 0.6]` — the foliage review (B05
 * §2.1.4, D319), on the operator's laptop, before a full build's select stage.
 *
 * 1. Reads the campaign's catalog walk (kept beside it; walked if there is none), scores every
 *    candidate flown from 1 September from its thumbnail (kept under `.scratch/thumbs/`, scores in
 *    `.scratch/foliage-scores.json`), and writes the review sheet and the proposal to
 *    `<campaign>/report/foliage/`.
 * 2. Runs the select stage **as a dry run** with the proposal applied over the reviewed list, writing
 *    that manifest and its cloud contact sheet beside the review (`manifest-proposed.json`,
 *    `cloud/`): the build the proposal would make, checked end to end, with no row and no upload.
 *
 * Thin glue over `foliageReview.ts`, `foliageSheet.ts` and `selectStage.ts`; excluded from coverage by
 * name, as every stage CLI is. Writes nothing outside the package's scratch; never a run row.
 */

import { join } from 'node:path';
import process from 'node:process';
import { NaipSasSigner } from '@skating/core';
import { walkCatalog } from '../catalog';
import { type FoliageScore, foliagePixels } from '../foliage';
import { AERIAL_SCRATCH, scratchPaths } from '../keys';
import { gdalDecode, ScoreCache, scoreFrames } from '../score';
import { pickTable } from '../selectStage';
import { parseFoliageArgs, runFoliageStage } from '../stage/foliageRun';
import { realWorld } from './world';

const log = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { campaign } = parseFoliageArgs(argv);
  const paths = scratchPaths(campaign);
  const thumbsDir = join(AERIAL_SCRATCH, 'thumbs');
  const signer = new NaipSasSigner((url: string) => fetch(url));
  const walk = () => walkCatalog({ fetchFn: fetch, inventoryDir: paths.inventory });
  const fetchBlob = (url: string) => signer.fetch(url);
  const progress = (what: string) => (done: number, total: number) => {
    if (done % 1000 === 0 || done === total) log(`[${what}] scored ${done}/${total}`);
  };
  const foliageCache = new ScoreCache<FoliageScore>(join(AERIAL_SCRATCH, 'foliage-scores.json'));
  const cloudCache = new ScoreCache(join(AERIAL_SCRATCH, 'scores.json'));
  const { review, applied, proposalPath, sheetPath } = await runFoliageStage(argv, realWorld(), {
    walk,
    scoreFoliage: (targets) =>
      scoreFrames(
        targets,
        {
          fetchBlob,
          decode: gdalDecode,
          thumbsDir,
          cache: foliageCache,
          onProgress: progress('foliage'),
        },
        foliagePixels,
      ),
    scoreCloud: (targets) =>
      scoreFrames(targets, {
        fetchBlob,
        decode: gdalDecode,
        thumbsDir,
        cache: cloudCache,
        onProgress: progress('select'),
      }),
    thumbsDir,
    log,
  });
  const manifestPath = applied.manifestPath;

  log(`[foliage] ${review.proposal.length} proposed entries; ${review.total.cells} cells change`);
  for (const s of review.states) {
    log(
      `  ${s.state}: ${s.changed} of ${s.cells} change, ${s.sharpToCoarse} 0.3→0.6 m, ${s.yearsOlder.toFixed(2)} yr older (changed), ${s.yearsOlderAll.toFixed(2)} yr (all)`,
    );
  }
  log(`[foliage] still turned: ${review.stillTurned.length}`);
  log(`[foliage] applied, picks by labeled state, year and resolution:`);
  for (const line of pickTable(applied.manifest)) log(`  ${line}`);
  log(`[foliage] applied, counts: ${JSON.stringify(applied.counts)}`);
  log(`[foliage] review sheet: ${sheetPath}`);
  log(`[foliage] proposal: ${proposalPath}`);
  log(`[foliage] applied manifest: ${manifestPath}`);
  log(`[foliage] applied cloud sheet: ${applied.sheetPath}`);
}

main().catch((e: unknown) => {
  // Never a URL: a refused read could carry a signed one.
  log(
    `[foliage] ${(e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
});
