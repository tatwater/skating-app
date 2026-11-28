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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { NAIP_FOLIAGE_STRIKES, NaipSasSigner } from '@skating/core';
import { walkCatalog } from '../catalog';
import { type FoliageScore, foliagePixels } from '../foliage';
import { proposalFile, runFoliageReview } from '../foliageReview';
import { writeFoliageSheet } from '../foliageSheet';
import { AERIAL_SCRATCH, parseCampaign, scratchPaths } from '../keys';
import { gdalDecode, ScoreCache, scoreFrames } from '../score';
import { writeContactSheet } from '../scoreSheet';
import { pickTable, runSelect } from '../selectStage';
import { parseStageArgs } from '../stages';

const log = (line: string) => process.stderr.write(`${line}\n`);
const USAGE = 'usage: pnpm --filter @skating/aerial foliage <campaign> [--threshold 0.6]';

async function main(): Promise<void> {
  const [campaign, ...rest] = process.argv.slice(2);
  if (campaign === undefined) throw new Error(USAGE);
  if (parseCampaign(campaign).pilot)
    throw new Error('the foliage review reads a full campaign, not a pilot');
  let threshold: number | undefined;
  if (rest.length > 0) {
    const [flag, value] = rest.length === 1 ? (rest[0] as string).split('=') : rest;
    if (flag !== '--threshold' || !(Number(value) > 0 && Number(value) < 1) || rest.length > 2) {
      throw new Error(USAGE);
    }
    threshold = Number(value);
  }

  const paths = scratchPaths(campaign);
  const reviewDir = join(paths.report, 'foliage');
  const thumbsDir = join(AERIAL_SCRATCH, 'thumbs');
  const signer = new NaipSasSigner((url: string) => fetch(url));
  const walk = () => walkCatalog({ fetchFn: fetch, inventoryDir: paths.inventory });
  const fetchBlob = (url: string) => signer.fetch(url);
  const progress = (what: string) => (done: number, total: number) => {
    if (done % 1000 === 0 || done === total) log(`[${what}] scored ${done}/${total}`);
  };

  const foliageCache = new ScoreCache<FoliageScore>(join(AERIAL_SCRATCH, 'foliage-scores.json'));
  const review = await runFoliageReview(
    { campaign, ...(threshold === undefined ? {} : { threshold }) },
    {
      walk,
      score: (targets) =>
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
      log,
      now: () => new Date(),
    },
  );
  mkdirSync(reviewDir, { recursive: true });
  const proposalPath = join(reviewDir, 'proposed.json');
  writeFileSync(proposalPath, `${JSON.stringify(proposalFile(review), null, 2)}\n`);
  const sheetPath = writeFoliageSheet(reviewDir, thumbsDir, review);

  // The build the proposal would make: the select stage, as a dry run, with it applied.
  const cloudCache = new ScoreCache(join(AERIAL_SCRATCH, 'scores.json'));
  const manifestPath = join(reviewDir, 'manifest-proposed.json');
  const applied = await runSelect(parseStageArgs([campaign, '--dry-run'], 'select'), {
    walk: () => walk(),
    score: (targets) =>
      scoreFrames(targets, {
        fetchBlob,
        decode: gdalDecode,
        thumbsDir,
        cache: cloudCache,
        onProgress: progress('select'),
      }),
    readCurrent: () => Promise.reject(new Error('the foliage review builds from nothing')),
    readPublished: () => Promise.reject(new Error('the foliage review is a dry run')),
    readCellList: () => '',
    writeManifest: (manifest) => {
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      return manifestPath;
    },
    writeSheet: (candidates) =>
      writeContactSheet(join(reviewDir, 'cloud'), thumbsDir, candidates, {
        campaign: `${campaign} (foliage proposal applied)`,
      }),
    log,
    run: null,
    now: () => new Date(),
    foliageStrikes: [...NAIP_FOLIAGE_STRIKES, ...review.proposal],
  });

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
