/**
 * **The assemble stage, on the laptop** (B05 §2.4, §2.6), `cli/assemble.ts`' body when it is neither
 * on a Machine nor a dry run. The preflight (`preflightAssemble`) decides, under the campaign's lock;
 * then the body opens the `aerial_assemble` row and either takes a finished assembly's record or
 * starts the Machine through `spawn.sh assemble` (attaching to one already running) and follows its
 * progress object into the row's heartbeat until its record lands.
 *
 * Writes, in order: row open → the Machine (which writes the archive, the index, the manifest, then
 * its record; its progress object once it has decided) → row close.
 *
 * **The one refusal after a write**: the record that lands is held to the build manifest again. An
 * assembler attached to, or one that started from a manifest replaced between this preflight and
 * its own read, may have built other inputs — a race that exists only once the Machine is up. What
 * it wrote is never exposed: verify refuses an archive whose record and manifests disagree, and
 * nothing points the web at an archive verify hasn't passed.
 */

import type { NaipManifest } from '@skating/core';
import type { AssemblyRecord } from '../assemble/assemble';
import { AssembleRefusal, assemblyKeys } from '../assemble/assemble';
import {
  assembleScope,
  assemblyCounts,
  finishedAssembly,
  followAssembly,
  readObject,
  spawnExitMessage,
} from '../assemble/orchestrate';
import { withCampaignLock } from '../campaignLock';
import { manifestKey } from '../keys';
import { preflightAssemble } from '../preflight';
import { parseStageArgs } from '../stages';
import type { StageWorld } from '../world';

/** Runs the laptop's stage; resolves when the assembly is taken or followed to its record. */
export async function runAssembleStage(argv: readonly string[], world: StageWorld): Promise<void> {
  const args = parseStageArgs(argv, 'assemble');
  await withCampaignLock(
    world.scratch,
    args.campaign,
    'assemble',
    world.process,
    world.now(),
    async () => {
      const plan = await preflightAssemble(args, world);
      const pilot = args.pilot ?? undefined;
      const keys = assemblyKeys(args.campaign, pilot);
      const bucket = world.bucket(plan.target);
      const cat = <T>(key: string): Promise<T | null> =>
        readObject<T>(async () => (await bucket.read(key)) ?? '');
      const readPublished = () => cat<NaipManifest>(manifestKey(args.campaign, pilot));
      const logger = world.row({
        kind: 'aerial_assemble',
        label: `assemble ${args.campaign}${args.pilot ? ` (pilot ${args.pilot})` : ''}`,
        campaignId: args.campaign,
        target: plan.deployment,
        scope: assembleScope(args.pilot),
      });
      logger.start();
      if (plan.kind === 'take') {
        for (const [name, value] of Object.entries(assemblyCounts(plan.record)))
          logger.count(name, value);
        logger.succeed([
          `already assembled (${plan.record.finishedAt}): archive ${plan.record.archive.key}`,
          `index ${plan.record.cellIndex.key}`,
        ]);
        world.out(`already assembled: ${keys.record} names ${plan.record.archive.key}\n`);
        return;
      }
      const machine = world.launch.assemble(args.campaign, args.pilot);
      const errorKey = keys.progress.replace(/progress\.json$/, 'error.json');
      try {
        const followed = await followAssembly({
          readProgress: () => cat(keys.progress),
          readRecord: () => cat<AssemblyRecord>(keys.record),
          machineDone: async () => {
            const exit = machine.exit();
            if (exit === undefined) return false;
            if (exit === 0) return true;
            throw new Error(spawnExitMessage(exit));
          },
          logger,
          sleep: (ms) => world.sleep(ms),
          now: () => world.clock(),
        });
        // The race this preflight can't close (above): the record that landed, held to the inputs.
        const record = (await finishedAssembly(
          followed,
          plan.manifest,
          readPublished,
        )) as AssemblyRecord;
        for (const [name, value] of Object.entries(assemblyCounts(record)))
          logger.count(name, value);
        logger.succeed([`archive ${record.archive.key}`, `index ${record.cellIndex.key}`]);
      } catch (e) {
        if (machine.exit() === undefined) machine.stop();
        const err = await cat<{ at?: string; message?: string; refused?: boolean }>(errorKey).catch(
          () => null,
        );
        // The Machine's refusal stays a refusal (a published campaign's inputs, an incomplete set).
        const own =
          err?.message && err.at !== plan.stale
            ? err.refused === true
              ? new AssembleRefusal('assemble.machine', err.message)
              : new Error(err.message)
            : null;
        logger.failed(own ?? e);
        throw own ?? e;
      }
    },
  );
}
