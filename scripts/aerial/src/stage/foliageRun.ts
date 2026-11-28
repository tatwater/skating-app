/**
 * **The foliage review's frame** (B05 §2.1.4, D319), `cli/foliage.ts`' body. Not a stage — no row,
 * no upload — but it writes into the campaign's scratch, so it keeps the rule too: its arguments are
 * read and its campaign locked before anything, the review and the select stage's dry run with the
 * proposal applied are both decided before a file is written, and only then are the proposal, the
 * review sheet and the applied manifest and cloud sheet written.
 *
 * Writes, in order: [the kept walk, the score caches: memos of reads] → the applied manifest → its
 * cloud sheet → the proposal → the review sheet.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAIP_FOLIAGE_STRIKES } from '@skating/core';
import { withCampaignLock } from '../campaignLock';
import type { CatalogSnapshot } from '../catalog';
import type { FoliageScore } from '../foliage';
import {
  type FoliageReview,
  type FoliageReviewDeps,
  proposalFile,
  runFoliageReview,
} from '../foliageReview';
import { writeFoliageSheet } from '../foliageSheet';
import { parseCampaign, scratchPaths } from '../keys';
import { StageRefusal } from '../refusals';
import type { ScoreTarget, ThumbnailScore } from '../score';
import { writeContactSheet } from '../scoreSheet';
import { runSelect, type SelectResult } from '../selectStage';
import { parseStageArgs } from '../stages';
import type { StageWorld } from '../world';

export const FOLIAGE_USAGE =
  'usage: pnpm --filter @skating/aerial foliage <campaign> [--threshold 0.6]';

/** The review's arguments: a full campaign and an optional threshold in (0, 1). */
export function parseFoliageArgs(argv: readonly string[]): {
  campaign: string;
  threshold?: number;
} {
  const [campaign, ...rest] = argv;
  if (campaign === undefined) throw new StageRefusal('foliage.usage', FOLIAGE_USAGE);
  let pilot: boolean;
  try {
    pilot = parseCampaign(campaign).pilot;
  } catch (e) {
    throw new StageRefusal('foliage.usage', `${(e as Error).message}\n${FOLIAGE_USAGE}`);
  }
  if (pilot) {
    throw new StageRefusal(
      'foliage.pilot',
      'the foliage review reads a full campaign, not a pilot',
    );
  }
  if (rest.length === 0) return { campaign };
  const [flag, value] = rest.length === 1 ? (rest[0] as string).split('=') : rest;
  if (flag !== '--threshold' || !(Number(value) > 0 && Number(value) < 1) || rest.length > 2) {
    throw new StageRefusal('foliage.usage', FOLIAGE_USAGE);
  }
  return { campaign, threshold: Number(value) };
}

/** What only the real world supplies. */
export interface FoliageSources {
  walk: () => Promise<CatalogSnapshot>;
  /** The foliage measure over thumbnails. */
  scoreFoliage: (targets: readonly ScoreTarget[]) => Promise<Map<string, FoliageScore | null>>;
  /** The cloud measure, for the select stage's dry run. */
  scoreCloud: (targets: readonly ScoreTarget[]) => Promise<Map<string, ThumbnailScore | null>>;
  thumbsDir: string;
  log: (line: string) => void;
  /** The review's own lists and proof, for a test to make it refuse (`FoliageReviewDeps`). */
  review?: Pick<FoliageReviewDeps, 'exclusions' | 'reviewed' | 'kept' | 'check'>;
}

export interface FoliageRunResult {
  review: FoliageReview;
  applied: SelectResult;
  proposalPath: string;
  sheetPath: string;
}

export async function runFoliageStage(
  argv: readonly string[],
  world: StageWorld,
  sources: FoliageSources,
): Promise<FoliageRunResult> {
  const args = parseFoliageArgs(argv);
  return withCampaignLock(world, args.campaign, 'foliage', async () => {
    const paths = scratchPaths(args.campaign, world.scratch);
    const reviewDir = join(paths.report, 'foliage');
    const review = await runFoliageReview(args, {
      ...sources.review,
      walk: sources.walk,
      score: sources.scoreFoliage,
      log: sources.log,
      now: () => world.now(),
    });
    // The build the proposal would make: the select stage, as a dry run, with it applied — every
    // refusal of it decided before the review's own files are written.
    const manifestPath = join(reviewDir, 'manifest-proposed.json');
    const applied = await runSelect(parseStageArgs([args.campaign, '--dry-run'], 'select'), {
      walk: () => sources.walk(),
      score: sources.scoreCloud,
      readCurrent: () => Promise.reject(new Error('the foliage review builds from nothing')),
      readPublished: () => Promise.reject(new Error('the foliage review is a dry run')),
      readCellList: () => '',
      writeManifest: (manifest) => {
        mkdirSync(reviewDir, { recursive: true });
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
        return manifestPath;
      },
      writeSheet: (candidates) =>
        writeContactSheet(join(reviewDir, 'cloud'), sources.thumbsDir, candidates, {
          campaign: `${args.campaign} (foliage proposal applied)`,
        }),
      log: sources.log,
      run: null,
      now: () => world.now(),
      foliageStrikes: [...NAIP_FOLIAGE_STRIKES, ...review.proposal],
    });
    mkdirSync(reviewDir, { recursive: true });
    const proposalPath = join(reviewDir, 'proposed.json');
    writeFileSync(proposalPath, `${JSON.stringify(proposalFile(review), null, 2)}\n`);
    const sheetPath = writeFoliageSheet(reviewDir, sources.thumbsDir, review);
    return { review, applied, proposalPath, sheetPath };
  });
}
