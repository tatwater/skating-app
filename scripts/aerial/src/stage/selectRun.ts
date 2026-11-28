/**
 * **The select stage's frame** (B05 §2.1), `cli/select.ts`' body: the arguments, the campaign's lock,
 * the preflight that needs no catalog — where the row goes, the bucket a published manifest is read
 * from, `--from-current`'s source — and then `selectStage.ts`' `runSelect`, which reads the published
 * manifest and the current one before it walks (the eighth review), decides, and only then writes
 * the manifest and the cloud sheet into the campaign's scratch.
 *
 * Writes, in order: row open → [the kept walk, the score caches: memos of reads, written once and
 * never replaced] → the manifest → the cloud sheet → row close.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NAIP_STATES, type NaipManifest } from '@skating/core';
import { readObject } from '../assemble/orchestrate';
import { withCampaignLock } from '../campaignLock';
import { manifestKey, type ScratchPaths, scratchPaths } from '../keys';
import { checkedTarget, needBucket, needEnv } from '../preflight';
import { StageRefusal } from '../refusals';
import { readPrescreen, writeContactSheet } from '../scoreSheet';
import { runSelect, type SelectDeps, type SelectResult } from '../selectStage';
import { parseStageArgs, type StageArgs } from '../stages';
import type { StageWorld } from '../world';

/** What only the real world supplies: the catalog, the thumbnails, `--from-current`'s fetch. */
export type SelectSources = Pick<
  SelectDeps,
  | 'walk'
  | 'score'
  | 'unreadable'
  | 'readCellList'
  | 'log'
  | 'exclusions'
  | 'foliageStrikes'
  | 'check'
> & {
  /** The current manifest at `from` (a URL or a local copy's path). */
  fetchCurrent: (from: string) => Promise<NaipManifest>;
  /** Where the sheet's thumbnails are kept. */
  thumbsDir: string;
};

export async function runSelectStage(
  argv: readonly string[],
  world: StageWorld,
  sources: (args: StageArgs, paths: ScratchPaths) => SelectSources,
): Promise<SelectResult> {
  const args = parseStageArgs(argv, 'select');
  return withCampaignLock(world, args.campaign, 'select', async () => {
    const paths = scratchPaths(args.campaign, world.scratch);
    // The preflight that needs no catalog: every refusal here is before the row opens.
    const deployment = args.dryRun ? null : checkedTarget(world, args.pilot);
    const target = args.dryRun ? null : needBucket(world);
    const from = args.fromCurrent ? needEnvFromCurrent(world) : null;
    const src = sources(args, paths);
    const sheetDir = join(paths.report, 'cloud');
    const run =
      deployment === null
        ? null
        : world.row({
            kind: 'aerial_select',
            label: 'Summer aerial: the frame rule over the NAIP catalog',
            campaignId: args.campaign,
            target: deployment,
            scope: {
              pass: 'archive',
              states: [...(args.states ?? NAIP_STATES)],
              complete: args.states === null && args.cells === null,
            },
          });
    const { fetchCurrent: _, thumbsDir: __, ...deps } = src;
    return runSelect(args, {
      ...deps,
      readCurrent: () => src.fetchCurrent(from as string),
      // What this campaign has published: `null` when nothing is; a bucket that can't be read
      // fails the stage (can't tell is never "nothing published").
      readPublished: () => {
        const t = target as NonNullable<typeof target>;
        const key = manifestKey(args.campaign, args.pilot ?? undefined);
        return readObject<NaipManifest>(async () => (await world.bucket(t).read(key)) ?? '');
      },
      writeManifest: (manifest) => {
        mkdirSync(dirname(paths.manifest), { recursive: true });
        writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
        return paths.manifest;
      },
      writeSheet: (candidates) =>
        writeContactSheet(sheetDir, src.thumbsDir, candidates, {
          campaign: args.campaign,
          prescreen: readPrescreen(sheetDir),
        }),
      run,
      now: () => world.now(),
    });
  });
}

function needEnvFromCurrent(world: StageWorld): string {
  try {
    return needEnv(world, 'NAIP_MANIFEST_URL');
  } catch {
    throw new StageRefusal(
      'select.fromCurrentUrl',
      '--from-current needs NAIP_MANIFEST_URL: the live manifest',
    );
  }
}
