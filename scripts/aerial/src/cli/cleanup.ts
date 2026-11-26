/**
 * `pnpm --filter @skating/aerial cleanup <campaign> --old <key> [--pilot <name>] [--dry-run]` — the
 * cleanup stage (B05 §2.5), on the laptop, through the gitignored rclone remote (`R2_REMOTE`, default
 * `r2`; `R2_BUCKET`). A shell over `cleanup.ts`: every refusal is decided before anything is deleted,
 * and `--dry-run` prints the plan and deletes nothing.
 *
 * What the web points at is read from `apps/web/.env`'s `VITE_NAIP_PMTILES_URL` by name and compared
 * in code; its value is never printed.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { rcloneList, rcloneRun } from '../assemble/upload';
import { CleanupRefusal, envValue, planCleanup } from '../cleanup';
import { publishPrefix } from '../keys';
import { parseStageArgs, StageArgsError } from '../stages';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parseStageArgs(process.argv.slice(2), 'cleanup');
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error('R2_BUCKET is not set');
  const target = { remote: process.env.R2_REMOTE ?? 'r2', bucket };
  const prefix = publishPrefix(args.campaign, args.pilot ?? undefined);
  const listing = (await rcloneList(target, prefix))
    .filter((o) => !o.IsDir)
    .map((o) => ({ key: `${prefix}${o.Path}`, modified: new Date(o.ModTime) }));
  // `undefined` when the web's env can't be read: planCleanup refuses rather than skip the check.
  let live: string | null | undefined;
  try {
    live = envValue(
      await readFile(join(HERE, '..', '..', '..', '..', 'apps', 'web', '.env'), 'utf8'),
      'VITE_NAIP_PMTILES_URL',
    );
  } catch {
    live = undefined;
  }
  const plan = planCleanup({
    campaign: args.campaign,
    pilot: args.pilot,
    old: args.old as string,
    listing,
    liveArchiveUrl: live,
    now: new Date(),
  });
  process.stdout.write(
    `[cleanup] ${args.dryRun ? 'would delete' : 'deleting'}: ${plan.deleteKeys.join(', ')} and ${plan.deletePrefix}* (replaced by ${plan.replacedBy}, written ${plan.replacedAt.toISOString()})\n`,
  );
  if (args.dryRun) return;
  for (const key of plan.deleteKeys) {
    await rcloneRun(target, ['deletefile', `${target.remote}:${target.bucket}/${key}`]).catch(
      (e: Error) => {
        if (!/not found/i.test(e.message)) throw e;
      },
    );
  }
  await rcloneRun(target, [
    'delete',
    `${target.remote}:${target.bucket}/${plan.deletePrefix}`,
  ]).catch((e: Error) => {
    if (!/directory not found/i.test(e.message)) throw e;
  });
  process.stdout.write('[cleanup] done\n');
}

main().catch((e) => {
  const kind = e instanceof StageArgsError || e instanceof CleanupRefusal ? 'refused' : 'failed';
  process.stderr.write(`${kind}: ${(e as Error).message}\n`);
  process.exit(1);
});
