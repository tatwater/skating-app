/**
 * `pnpm --filter @skating/aerial select <campaign> [--states …|--cells <file>] [--from-current]
 *   [--pilot <name>] [--dry-run]` — the select stage (B05 §2.1), on the operator's laptop.
 *
 * Thin glue over `selectStage.ts`: the real `fetch`, the anonymous SAS signer, GDAL's decoder, the
 * scratch layout, and the run row. Excluded from coverage by name, as every stage CLI is.
 *
 * The run row (`aerial_select`) goes to Convex dev for a production campaign and to a local backend
 * for a pilot (§3.1: a pilot's rows never reach dev); a dry run writes none, and needs no backend.
 * Prod is refused outright (the founder, F-4 a: dev only). Anything but a dry run reads the
 * campaign's published manifest first (`R2_BUCKET`), and refuses to select other inputs for a
 * campaign already published (`publishedBuild.ts`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { NAIP_STATES, type NaipManifest, NaipSasSigner } from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { readObject } from '../assemble/orchestrate';
import { rcloneRun } from '../assemble/upload';
import { walkCatalog } from '../catalog';
import { AERIAL_SCRATCH, manifestKey, scratchPaths } from '../keys';
import { checkRunTarget } from '../runTarget';
import { gdalDecode, ScoreCache, scoreFrames } from '../score';
import { readPrescreen, writeContactSheet } from '../scoreSheet';
import { pickTable, runSelect, SelectRefusal, type SelectRunLog } from '../selectStage';
import { AERIAL_USAGE, parseStageArgs, StageArgsError } from '../stages';

const log = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  const args = parseStageArgs(process.argv.slice(2), 'select');
  const paths = scratchPaths(args.campaign);

  let run: SelectRunLog | null = null;
  if (!args.dryRun) {
    const target = resolveDeployment();
    checkRunTarget(args.pilot, target);
    run = new RunLogger({
      kind: 'aerial_select',
      label: 'Summer aerial: the frame rule over the NAIP catalog',
      campaignId: args.campaign,
      target,
      call: convexRun,
      scope: {
        pass: 'archive',
        states: [...(args.states ?? NAIP_STATES)],
        complete: args.states === null && args.cells === null,
      },
    });
  }

  const signer = new NaipSasSigner((url: string) => fetch(url));
  const cache = new ScoreCache(join(AERIAL_SCRATCH, 'scores.json'));
  const thumbsDir = join(AERIAL_SCRATCH, 'thumbs');
  const sheetDir = join(paths.report, 'cloud');

  const result = await runSelect(args, {
    walk: (onState) =>
      walkCatalog({
        fetchFn: fetch,
        inventoryDir: paths.inventory,
        onState: (state, items) => onState(state, items),
      }),
    score: (targets) =>
      scoreFrames(targets, {
        fetchBlob: (url) => signer.fetch(url),
        decode: gdalDecode,
        thumbsDir,
        cache,
        onProgress: (done, total) => {
          if (done % 500 === 0 || done === total) log(`[select] scored ${done}/${total}`);
        },
      }),
    // The live manifest's URL (or a local copy's path). Read by name; never printed.
    readCurrent: async () => {
      const from = process.env.NAIP_MANIFEST_URL;
      if (!from)
        throw new SelectRefusal('--from-current needs NAIP_MANIFEST_URL: the live manifest');
      if (!/^https?:\/\//.test(from)) return JSON.parse(readFileSync(from, 'utf8')) as NaipManifest;
      const res = await fetch(from);
      if (!res.ok) throw new SelectRefusal(`the live manifest answered ${res.status}`);
      return (await res.json()) as NaipManifest;
    },
    // What this campaign has published, through the laptop's rclone remote (`R2_REMOTE`, default
    // `r2`; `R2_BUCKET`): `null` when nothing is; a bucket that can't be read fails the stage.
    readPublished: () => {
      const bucket = process.env.R2_BUCKET;
      if (!bucket) throw new SelectRefusal('R2_BUCKET is not set (scripts/aerial/.env.local)');
      const target = { remote: process.env.R2_REMOTE || 'r2', bucket };
      const key = manifestKey(args.campaign, args.pilot ?? undefined);
      return readObject<NaipManifest>(() =>
        rcloneRun(target, ['cat', `${target.remote}:${target.bucket}/${key}`]),
      );
    },
    readCellList: (path) => readFileSync(path, 'utf8'),
    writeManifest: (manifest) => {
      mkdirSync(dirname(paths.manifest), { recursive: true });
      writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
      return paths.manifest;
    },
    writeSheet: (candidates) =>
      writeContactSheet(sheetDir, thumbsDir, candidates, {
        campaign: args.campaign,
        prescreen: readPrescreen(sheetDir),
      }),
    log,
    run,
    now: () => new Date(),
  });

  log(`[select] picks by labeled state, year and resolution:`);
  for (const line of pickTable(result.manifest)) log(`  ${line}`);
  log(`[select] counts: ${JSON.stringify(result.counts)}`);
  if (result.noCandidate.length > 0) {
    log(
      `[select] ${result.noCandidate.length} cells listed with no candidate (coarse frames only)`,
    );
  }
  log(`[select] manifest: ${result.manifestPath}`);
  log(`[select] cloud contact sheet: ${result.sheetPath}`);
}

main().catch((e: unknown) => {
  if (e instanceof StageArgsError) log(`${e.message}\n${AERIAL_USAGE}`);
  else log(`[select] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
