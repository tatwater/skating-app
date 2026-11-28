/**
 * `pnpm --filter @skating/aerial select <campaign> [--states …|--cells <file>] [--from-current]
 *   [--pilot <name>] [--dry-run]` — the select stage (B05 §2.1), on the operator's laptop.
 *
 * Thin glue over `stage/selectRun.ts` and `selectStage.ts`: the real `fetch`, the anonymous SAS
 * signer, GDAL's decoder and the world (`cli/world.ts`). Excluded from coverage by name, as every
 * stage CLI is.
 *
 * The run row (`aerial_select`) goes to Convex dev for a production campaign and to a local backend
 * for a pilot (§3.1: a pilot's rows never reach dev); a dry run writes none, and needs no backend.
 * Prod is refused outright (the founder, F-4 a: dev only). Anything but a dry run reads the
 * campaign's published manifest first (`R2_BUCKET`), before the walk, and refuses to select other
 * inputs for a campaign already published (`publishedBuild.ts`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { type NaipManifest, NaipSasSigner } from '@skating/core';
import { walkCatalog } from '../catalog';
import { AERIAL_SCRATCH } from '../keys';
import { outcomeWord, StageRefusal } from '../refusals';
import { gdalDecode, ScoreCache, scoreFrames } from '../score';
import { pickTable } from '../selectStage';
import { runSelectStage } from '../stage/selectRun';
import { AERIAL_USAGE, StageArgsError } from '../stages';
import { realWorld } from './world';

const log = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  const signer = new NaipSasSigner((url: string) => fetch(url));
  const cache = new ScoreCache(join(AERIAL_SCRATCH, 'scores.json'));
  const thumbsDir = join(AERIAL_SCRATCH, 'thumbs');
  // The frames a read failed for this time: a re-run reads them again (`selectStage.ts` refuses).
  const unreadable = new Set<string>();

  const result = await runSelectStage(process.argv.slice(2), realWorld(), (_args, paths) => ({
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
        unreadable,
        onProgress: (done, total) => {
          if (done % 500 === 0 || done === total) log(`[select] scored ${done}/${total}`);
        },
      }),
    unreadable,
    // The live manifest's URL (or a local copy's path). Read by name; never printed.
    fetchCurrent: async (from) => {
      if (!/^https?:\/\//.test(from)) return JSON.parse(readFileSync(from, 'utf8')) as NaipManifest;
      const res = await fetch(from);
      if (!res.ok) {
        throw new StageRefusal(
          'select.fromCurrentRead',
          `the live manifest answered ${res.status}`,
        );
      }
      return (await res.json()) as NaipManifest;
    },
    readCellList: (path) => readFileSync(path, 'utf8'),
    log,
    thumbsDir,
  }));

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
  else log(`[select] ${outcomeWord(e)}: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
