/**
 * `pnpm --filter @skating/aerial cleanup <campaign> --old <key> --live-since <YYYY-MM-DD>
 * [--dry-run]` (a pilot: `--pilot <name>`, no `--live-since`) — the
 * cleanup stage (B05 §2.5), on the laptop, through the gitignored rclone remote (`R2_REMOTE`, default
 * `r2`; `R2_BUCKET`). A shell over `cleanup.ts`: every refusal is decided before anything is deleted,
 * and `--dry-run` prints the plan and deletes nothing.
 *
 * What the web points at is read from `apps/web`'s env files (`.env`, `.env.local`, … —
 * `WEB_ENV_FILES`), `VITE_NAIP_PMTILES_URL` by name and compared in code; its value is never printed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { rcloneList, rcloneRun } from '../assemble/upload';
import { CleanupRefusal, parseLiveSince, planCleanup, webArchiveUrls } from '../cleanup';
import { publishPrefix } from '../keys';
import { parseStageArgs, StageArgsError } from '../stages';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parseStageArgs(process.argv.slice(2), 'cleanup');
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error('R2_BUCKET is not set');
  const target = { remote: process.env.R2_REMOTE || 'r2', bucket };
  const prefix = publishPrefix(args.campaign, args.pilot ?? undefined);
  const listing = (await rcloneList(target, prefix))
    .filter((o) => !o.IsDir)
    .map((o) => ({ key: `${prefix}${o.Path}`, modified: new Date(o.ModTime) }));
  // `undefined` when none of the web's env files can be read: planCleanup refuses rather than skip
  // the check.
  const webDir = join(HERE, '..', '..', '..', '..', 'apps', 'web');
  const live = webArchiveUrls((file) => {
    try {
      return readFileSync(join(webDir, file), 'utf8');
    } catch {
      return null;
    }
  });
  const plan = planCleanup({
    campaign: args.campaign,
    pilot: args.pilot,
    old: args.old as string,
    listing,
    liveArchiveUrls: live,
    liveSince: args.liveSince === null ? null : parseLiveSince(args.liveSince),
    now: new Date(),
  });
  process.stdout.write(
    `[cleanup] ${args.dryRun ? 'would delete' : 'deleting'}: ${plan.deleteKeys.join(', ')} and ${plan.deletePrefix}* (replaced by ${plan.replacedBy}, uploaded ${plan.replacedAt.toISOString()}, live since ${plan.liveFrom.toISOString()})\n`,
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
