/**
 * **The tiles stage** (B05 §2.2), `cli/tiles.ts`' body: the preflight (`preflight.ts`' `preflightTiles`)
 * decides, under the campaign's lock; then, and only then:
 *
 * 1. writes one work unit per work tile it cuts (`<scratch>/<campaign>/units/11_<x>_<y>.json`);
 * 2. `--dry-run` stops there: the plan, no upload, no Machine, no row;
 * 3. uploads the manifest to `buildManifestKey` and the catalog snapshot to `inventoryKey`
 *    (`selectUploads`) — the assembler and verify read them from the bucket — unless the campaign is
 *    published from these inputs (nothing to cut; a drifted build manifest is put back) or its
 *    assembler is up reading exactly this selection with every work tile landed (nothing to write);
 * 4. opens the `aerial_tiles` row (scope per §2.6) and runs the rounds (`runTileRounds`): what has
 *    landed is read from the done records, the rest spawned by `spawn.sh tiles … --drain`, three
 *    rounds; a heartbeat every 25 work tiles landed, read every ten minutes while a round runs;
 * 5. closes the row: succeeded only when every work tile landed; otherwise failed, naming them.
 *
 * Writes, in order: units → [manifest, snapshot] → row open → per round: its list file, its Machines
 * (each Machine writes its own shard) → row close. §2.8 says what an interruption between any two
 * leaves, and how a re-run recovers.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCampaignLock } from '../campaignLock';
import { buildPrefix, scratchPaths } from '../keys';
import { preflightTiles, type TilesPlan } from '../preflight';
import { parseShardDone, type ShardDone } from '../shard';
import { parseStageArgs, type StageArgs } from '../stages';
import { HEARTBEAT_EVERY, heartbeatDue, runTileRounds, tilesScope, unitFileName } from '../tiles';
import type { StageWorld } from '../world';

/** Runs the stage; resolves with the exit status (a refusal throws, having written nothing). */
export async function runTilesStage(argv: readonly string[], world: StageWorld): Promise<number> {
  const args = parseStageArgs(argv, 'tiles');
  return withCampaignLock(world, args.campaign, 'tiles', async () => {
    const plan = await preflightTiles(args, world);
    return tilesBody(args, plan, world);
  });
}

async function tilesBody(args: StageArgs, plan: TilesPlan, world: StageWorld): Promise<number> {
  const { manifest, units } = plan;
  if (plan.kind === 'published') {
    if (plan.repair !== null) {
      await world.bucket(plan.target).upload(plan.repair.local, plan.repair.key);
      world.out(
        `${args.campaign} is already published from these inputs; its build manifest had drifted and is put back (${plan.repair.key})\n`,
      );
    } else if (plan.waiting) {
      world.out(
        `${args.campaign}'s build manifest has drifted from its published one, and its assembler is still up: run the tiles stage again once it has gone, to put it back\n`,
      );
    }
    world.out(
      `${args.campaign} is already published from these inputs: nothing to cut, nothing uploaded\n`,
    );
    return 0;
  }
  const paths = scratchPaths(args.campaign, world.scratch);
  const unitsDir = join(paths.dir, 'units');
  if (plan.kind !== 'attached') {
    rmSync(unitsDir, { recursive: true, force: true });
    mkdirSync(unitsDir, { recursive: true });
    for (const unit of units) {
      writeFileSync(join(unitsDir, unitFileName(unit.workTile)), `${JSON.stringify(unit)}\n`);
    }
  }
  const frames = units.reduce((n, u) => n + u.cells.reduce((m, c) => m + c.frames.length, 0), 0);
  world.out(
    `${units.length} work tiles to cut (${manifest.workTiles.length - units.length} copied), ` +
      `${frames} cell frames; units in ${unitsDir}\n`,
  );
  if (plan.kind === 'dry') return 0;

  const bucket = world.bucket(plan.target);
  if (plan.kind === 'cut') {
    for (const up of plan.uploads) {
      await bucket.upload(up.local, up.key);
      world.out(`uploaded ${up.key}\n`);
    }
  } else {
    world.out(
      `${args.campaign}'s assembler is running from this selection and every work tile has landed: nothing to cut, nothing uploaded\n`,
    );
  }

  const logger = world.row({
    kind: 'aerial_tiles',
    label: `tiles ${args.campaign}${args.pilot ? ` (pilot ${args.pilot})` : ''}`,
    campaignId: args.campaign,
    target: plan.deployment,
    scope: tilesScope(manifest, units),
  });
  logger.start();
  logger.count('workTiles', units.length);

  const pilot = args.pilot ?? undefined;
  let landedBefore = 0;
  try {
    const result = await runTileRounds(args.campaign, units, {
      async readDone(workTiles) {
        // One listing-and-copy per read: every done record under the shards prefix.
        const texts = await bucket.doneRecords(`${buildPrefix(args.campaign, pilot)}shards/`);
        const out = new Map<string, ShardDone | null>();
        for (const w of workTiles) {
          const text = texts.get(w);
          let done: ShardDone | null = null;
          if (text !== undefined) {
            try {
              done = parseShardDone(JSON.parse(text));
            } catch (e) {
              world.err(`${w}: unreadable done record (${(e as Error).message})\n`);
            }
          }
          out.set(w, done);
        }
        return out;
      },
      async spawn(workTiles, round) {
        const list = join(paths.dir, `round-${round}.txt`);
        writeFileSync(list, `${workTiles.join('\n')}\n`);
        world.out(`round ${round}: spawning ${workTiles.length} work tiles\n`);
        const status = await world.launch.tiles(args.campaign, unitsDir, list);
        if (status !== 0) throw new Error(`spawn.sh exited ${status}`);
      },
      onProgress(round, landed, outstanding) {
        world.out(`during round ${round}: ${landed} landed, ${outstanding} outstanding\n`);
        logger.count('landed', landed);
        logger.count('outstanding', outstanding);
        if (heartbeatDue(landedBefore, landed, HEARTBEAT_EVERY)) logger.flush();
        landedBefore = landed;
      },
      onReconcile(round, landed, outstanding) {
        world.out(`after round ${round}: ${landed} landed, ${outstanding} outstanding\n`);
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
      world.err(`${msg}\nread a Machine's log: fly logs --app skating-imagery\n`);
      logger.failed(new Error(msg));
      return 1;
    }
    logger.succeed([`${result.landed.length} work tiles landed in ${result.rounds} rounds`]);
    return 0;
  } catch (e) {
    logger.failed(e);
    throw e;
  }
}
