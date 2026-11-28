/**
 * `pnpm --filter @skating/aerial tiles <campaign> [--pilot <name>] [--dry-run]` — the tiles stage
 * (B05 §2.2): `stage/tilesStage.ts` over the real world (`cli/world.ts`). The preflight decides
 * everything a refusal depends on — the scratch manifest, the run target, the published manifest,
 * whether the campaign's assembler is up and what it reads — before a unit, a manifest or a Machine
 * is written (`preflight.ts`, §2.8).
 *
 * Reads the bucket through the laptop's rclone remote (`R2_REMOTE`, default `r2`; `R2_BUCKET`), and
 * spawns with `AERIAL_IMAGE` — all by name, from the shell or `scripts/aerial/.env.local`; nothing
 * here prints a value.
 */

import process from 'node:process';
import { outcomeWord } from '../refusals';
import { runTilesStage } from '../stage/tilesStage';
import { realWorld } from './world';

runTilesStage(process.argv.slice(2), realWorld()).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${outcomeWord(e)}: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
