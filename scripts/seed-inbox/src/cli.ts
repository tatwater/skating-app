/**
 * `seed-inbox` — fill dev's Inbox with realistic work, and clear it again (B01-5, D287).
 *
 *   pnpm --filter @skating/seed-inbox seed                    # dry run: the plan; writes nothing
 *   CONVEX_RUN_AS=<your Clerk user id, an admin> \
 *     pnpm --filter @skating/seed-inbox seed --apply          # file it
 *   pnpm --filter @skating/seed-inbox seed --clear            # what the clear would remove
 *   pnpm --filter @skating/seed-inbox seed --clear --apply    # remove it
 *
 * Dev only (the deployment `convex run` targets, as `@skating/run-log` resolves it; the server's
 * `inboxSeed` functions refuse off dev too). Every run that writes leaves a run log in `runs/`
 * (gitignored) saying what it filed or removed. Glue around the tested loops in `seed.ts` and the
 * arguments in `args.ts`, excluded from coverage like every other script's CLI.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, type RunAs, resolveDeployment } from '@skating/run-log';
import { nodeVersionRefusal, parseArgs } from './args';
import { applyAndReport, clearAndReport } from './report';
import { type Call, describePlan, errorLine, planSeed, runLogName, tally } from './seed';
import { uploader } from './upload';

const say = (line: string) => process.stderr.write(`[seed-inbox] ${line}\n`);

/** `convex run` through `@skating/run-log`: a failed call throws the server's own sentence. */
const call: Call = <T>(fn: string, args: unknown, runAs?: RunAs): T =>
  convexRun<T>(fn, args, runAs !== undefined ? { runAs } : {});

function writeLog(mode: string, record: unknown): string {
  const dir = new URL('../runs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(runLogName(mode, new Date()), dir);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return fileURLToPath(file);
}

/** The repo's pinned Node (`.node-version` at the root); empty when it can't be read. */
function pinnedNode(): string {
  try {
    return readFileSync(new URL('../../../.node-version', import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<number> {
  const wrongNode = nodeVersionRefusal(pinnedNode(), process.version);
  if (wrongNode !== null) {
    say(wrongNode);
    return 2;
  }
  const target = resolveDeployment();
  const parsed = parseArgs(process.argv.slice(2), process.env, target);
  if (!parsed.ok) {
    say(parsed.message);
    return 2;
  }
  say(`target ${target.label} · ${parsed.mode}`);
  const out = { say, writeLog, target: target.label };
  switch (parsed.mode) {
    case 'dry': {
      const { people, state } = planSeed(call);
      for (const line of describePlan(people, state)) say(line);
      say('dry run — nothing written. Add --apply (with CONVEX_RUN_AS) to file it.');
      return 0;
    }
    case 'apply': {
      // The photo steps upload to the dev deployment the run targets, and nowhere else.
      const devName = target.isDev ? target.label.replace(/^dev:/, '') : null;
      // Ctrl-C stops the run between steps (the step it cut short fails and releases its uploads)
      // rather than killing it mid-step with files no row names.
      let interrupted = false;
      process.on('SIGINT', () => {
        interrupted = true;
        say('interrupted — stopping after this step');
      });
      return applyAndReport(call, parsed.operator, uploader(call, devName), () => interrupted, out);
    }
    case 'clear-dry': {
      say(
        `would remove: ${tally(call<Record<string, number>>('inboxSeed:clearPlan', {}))} (and everything about them)`,
      );
      say('dry run — nothing removed. Add --apply to remove it.');
      return 0;
    }
    case 'clear':
      return clearAndReport(call, out);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      say(`failed: ${errorLine(err)}`);
      process.exit(1);
    },
  );
}
