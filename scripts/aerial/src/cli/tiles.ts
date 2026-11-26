/**
 * `pnpm --filter @skating/aerial tiles <campaign> [--pilot <name>] [--dry-run]` — the tiles stage
 * (B05 §2.2). A shell over `tiles.ts`:
 *
 * 1. reads the select stage's manifest from the campaign's scratch and writes one work unit per
 *    work tile it cuts (`<scratch>/<campaign>/units/11_<x>_<y>.json`);
 * 2. `--dry-run` stops there: the plan, no upload, no Machine, no row;
 * 3. uploads the manifest to `buildManifestKey` and the catalog snapshot to `inventoryKey`
 *    (`selectUploads`) — the assembler and verify read them from the bucket;
 * 4. opens the `aerial_tiles` row (scope per §2.6) and runs the rounds (`runTileRounds`): what has
 *    landed is read from the done records in the bucket, the rest spawned by `spawn.sh tiles …
 *    --drain`, three rounds; a heartbeat every 25 work tiles landed;
 * 5. closes the row: succeeded only when every work tile landed; otherwise failed, naming them.
 *
 * Reads the bucket through the laptop's rclone remote (`R2_REMOTE`, default `r2`; `R2_BUCKET`), and
 * spawns with `AERIAL_IMAGE` — all by name, from the shell or `scripts/aerial/.env.local`; nothing
 * here prints a value.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { NaipManifest } from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { buildPrefix, scratchPaths } from '../keys';
import { parseShardDone, type ShardDone } from '../shard';
import { parseStageArgs, StageArgsError } from '../stages';
import {
  checkPilotTarget,
  HEARTBEAT_EVERY,
  heartbeatDue,
  runTileRounds,
  selectUploads,
  tilesScope,
  unitFileName,
  workUnitsFor,
} from '../tiles';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPAWN = join(HERE, '..', '..', 'spawn.sh');

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (scripts/aerial/.env.local)`);
  return v;
}

function rclone(args: string[]): string {
  const res = spawnSync('rclone', [...args, '--s3-no-check-bucket'], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`rclone ${args[0]} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout;
}

async function main(): Promise<void> {
  const args = parseStageArgs(process.argv.slice(2), 'tiles');
  const paths = scratchPaths(args.campaign);
  if (!existsSync(paths.manifest)) {
    throw new StageArgsError(`no manifest at ${paths.manifest}: run the select stage first`);
  }
  const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as NaipManifest;
  if (manifest.campaign !== args.campaign || manifest.pilot !== args.pilot) {
    throw new StageArgsError(`the manifest is ${manifest.campaign}'s, not this run's`);
  }

  const units = workUnitsFor(manifest);
  const unitsDir = join(paths.dir, 'units');
  rmSync(unitsDir, { recursive: true, force: true });
  mkdirSync(unitsDir, { recursive: true });
  for (const unit of units) {
    writeFileSync(join(unitsDir, unitFileName(unit.workTile)), `${JSON.stringify(unit)}\n`);
  }
  const frames = units.reduce((n, u) => n + u.cells.reduce((m, c) => m + c.frames.length, 0), 0);
  process.stdout.write(
    `${units.length} work tiles to cut (${manifest.workTiles.length - units.length} copied), ` +
      `${frames} cell frames; units in ${unitsDir}\n`,
  );
  if (args.dryRun) return;

  const deployment = resolveDeployment();
  checkPilotTarget(args.pilot, deployment);
  const remote = process.env.R2_REMOTE ?? 'r2';
  const bucket = need('R2_BUCKET');
  need('AERIAL_IMAGE');

  for (const up of selectUploads(manifest)) {
    rclone(['copyto', up.local, `${remote}:${bucket}/${up.key}`]);
    process.stdout.write(`uploaded ${up.key}\n`);
  }

  const logger = new RunLogger({
    kind: 'aerial_tiles',
    label: `tiles ${args.campaign}${args.pilot ? ` (pilot ${args.pilot})` : ''}`,
    campaignId: args.campaign,
    target: deployment,
    scope: tilesScope(manifest, units),
    call: convexRun,
  });
  logger.start();
  logger.count('workTiles', units.length);

  const pilot = args.pilot ?? undefined;
  const doneDir = join(paths.dir, 'done');
  let landedBefore = 0;
  try {
    const result = await runTileRounds(args.campaign, units, {
      async readDone(workTiles) {
        // One listing-and-copy per round: every done record under the shards prefix.
        rmSync(doneDir, { recursive: true, force: true });
        rclone([
          'copy',
          `${remote}:${bucket}/${buildPrefix(args.campaign, pilot)}shards/`,
          doneDir,
          '--include',
          '*.done.json',
        ]);
        const out = new Map<string, ShardDone | null>();
        for (const w of workTiles) {
          const file = join(doneDir, `${w}.done.json`);
          let done: ShardDone | null = null;
          if (existsSync(file)) {
            try {
              done = parseShardDone(JSON.parse(readFileSync(file, 'utf8')));
            } catch (e) {
              process.stderr.write(`${w}: unreadable done record (${(e as Error).message})\n`);
            }
          }
          out.set(w, done);
        }
        return out;
      },
      async spawn(workTiles, round) {
        const list = join(paths.dir, `round-${round}.txt`);
        writeFileSync(list, `${workTiles.join('\n')}\n`);
        process.stdout.write(`round ${round}: spawning ${workTiles.length} work tiles\n`);
        const res = spawnSync('bash', [SPAWN, 'tiles', args.campaign, unitsDir, list, '--drain'], {
          stdio: 'inherit',
        });
        if (res.status !== 0) throw new Error(`spawn.sh exited ${res.status}`);
      },
      onReconcile(round, landed, outstanding) {
        process.stdout.write(
          `after round ${round}: ${landed} landed, ${outstanding} outstanding\n`,
        );
        logger.count('landed', landed);
        logger.count('outstanding', outstanding);
        if (round === 0 || heartbeatDue(landedBefore, landed, HEARTBEAT_EVERY)) logger.flush();
        landedBefore = landed;
      },
    });
    logger.count('rounds', result.rounds);
    for (const w of result.failed) {
      logger.fail({
        stage: 'tiles',
        key: w,
        reason: 'no done record with the manifest’s input hash',
      });
    }
    if (result.failed.length > 0) {
      const msg = `${result.failed.length} work tiles never landed: ${result.failed.join(', ')}`;
      process.stderr.write(`${msg}\nread a Machine's log: fly logs --app skating-imagery\n`);
      logger.failed(new Error(msg));
      process.exitCode = 1;
      return;
    }
    logger.succeed([`${result.landed.length} work tiles landed in ${result.rounds} rounds`]);
  } catch (e) {
    logger.failed(e);
    throw e;
  }
}

main().catch((e) => {
  process.stderr.write(
    `${e instanceof StageArgsError ? 'refused' : 'failed'}: ${(e as Error).message}\n`,
  );
  process.exit(1);
});
