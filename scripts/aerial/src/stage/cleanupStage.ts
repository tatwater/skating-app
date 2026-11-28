/**
 * **The cleanup stage** (B05 §2.5), `cli/cleanup.ts`' body: every refusal decided by the preflight
 * (`preflightCleanup`: the listing, the web's env files, `planCleanup`) under the campaign's lock;
 * `--dry-run` prints the plan and deletes nothing.
 *
 * **The deletes run in the order a re-run can finish** (the eighth review's interruption table):
 * the old build's private prefix, then its index and manifest, and **its archive last** — the
 * archive's presence is what the plan's refusals read (`… is not in the bucket: nothing to delete`),
 * so a cleanup stopped part way, re-run, still finds it and deletes the rest. The archive first (as
 * before) left the index, the manifest and the build prefix behind with every re-run refused.
 */

import { withCampaignLock } from '../campaignLock';
import { preflightCleanup } from '../preflight';
import { parseStageArgs } from '../stages';
import type { StageWorld } from '../world';

export async function runCleanupStage(
  argv: readonly string[],
  world: StageWorld,
  readWebFile: (file: string) => string | null,
): Promise<void> {
  const args = parseStageArgs(argv, 'cleanup');
  await withCampaignLock(
    world.scratch,
    args.campaign,
    'cleanup',
    world.process,
    world.now(),
    async () => {
      const { target, plan } = await preflightCleanup(args, world, readWebFile);
      world.out(
        `[cleanup] ${args.dryRun ? 'would delete' : 'deleting'}: ${plan.deletePrefix}* and ${plan.deleteKeys.join(', ')} (replaced by ${plan.replacedBy}, uploaded ${plan.replacedAt.toISOString()}, live since ${plan.liveFrom.toISOString()})\n`,
      );
      if (args.dryRun) return;
      const bucket = world.bucket(target);
      await bucket.deletePrefix(plan.deletePrefix);
      // `deleteKeys` is the archive, the index, the manifest: the archive goes last.
      const [archive, ...rest] = plan.deleteKeys;
      for (const key of [...rest, archive as string]) await bucket.deleteFile(key);
      world.out('[cleanup] done\n');
    },
  );
}
