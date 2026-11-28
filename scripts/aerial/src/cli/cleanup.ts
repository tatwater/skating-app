/**
 * `pnpm --filter @skating/aerial cleanup <campaign> --old <key> --live-since <YYYY-MM-DD>
 * [--dry-run]` (a pilot: `--pilot <name>`, no `--live-since`) — the cleanup stage (B05 §2.5):
 * `stage/cleanupStage.ts` over the real world, through the gitignored rclone remote (`R2_REMOTE`,
 * default `r2`; `R2_BUCKET`). Every refusal is decided before anything is deleted, and `--dry-run`
 * prints the plan and deletes nothing.
 *
 * What the web points at is read from `apps/web`'s env files (`.env`, `.env.local`, … —
 * `WEB_ENV_FILES`), `VITE_NAIP_PMTILES_URL` by name and compared in code; its value is never printed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { webDir } from '../preflight';
import { outcomeWord } from '../refusals';
import { runCleanupStage } from '../stage/cleanupStage';
import { realWorld } from './world';

const WEB = webDir(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

runCleanupStage(process.argv.slice(2), realWorld(), (file) => {
  try {
    return readFileSync(join(WEB, file), 'utf8');
  } catch {
    return null;
  }
}).catch((e) => {
  process.stderr.write(`${outcomeWord(e)}: ${(e as Error).message}\n`);
  process.exit(1);
});
