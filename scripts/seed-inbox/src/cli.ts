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

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { identityArgs, type RunAs, resolveDeployment } from '@skating/run-log';
import { parseArgs } from './args';
import {
  applyClear,
  applySeed,
  type Call,
  describePlan,
  parseRunOutput,
  planSeed,
  runLogName,
  serverSentence,
  tally,
} from './seed';

const say = (line: string) => process.stderr.write(`[seed-inbox] ${line}\n`);

/**
 * `convex run`, as `@skating/run-log`'s `convexRun` makes it, but with stderr captured as well as
 * shown: a refused step's run-log row then carries the server's own sentence (`serverSentence`), not
 * the `Command failed: pnpm …` line the child process error would give.
 */
const call: Call = <T>(fn: string, args: unknown, runAs?: RunAs): T => {
  const res = spawnSync(
    'pnpm',
    [
      '--filter',
      '@skating/convex',
      'exec',
      'convex',
      'run',
      fn,
      JSON.stringify(args),
      ...identityArgs(runAs),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(serverSentence(res.stderr ?? ''));
  return parseRunOutput<T>(res.stdout ?? '');
};

function writeLog(mode: string, record: unknown): string {
  const dir = new URL('../runs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(runLogName(mode, new Date()), dir);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return fileURLToPath(file);
}

function main(): number {
  const target = resolveDeployment();
  const parsed = parseArgs(process.argv.slice(2), process.env, target);
  if (!parsed.ok) {
    say(parsed.message);
    return 2;
  }
  say(`target ${target.label} · ${parsed.mode}`);
  switch (parsed.mode) {
    case 'dry': {
      const { people, state } = planSeed(call);
      for (const line of describePlan(people, state)) say(line);
      say('dry run — nothing written. Add --apply (with CONVEX_RUN_AS) to file it.');
      return 0;
    }
    case 'apply': {
      const run = applySeed(call, parsed.operator, (f) =>
        say(
          `${f.error === undefined ? 'filed ' : 'FAILED'} ${f.key.padEnd(22)} ${f.fn} as ${f.as}${f.error ? ` — ${f.error}` : ''}`,
        ),
      );
      const log = writeLog('apply', { target: target.label, ...run });
      say(`people created ${run.people.created.length}`);
      say(
        `filed ${run.counts.filed} · failed ${run.counts.failed} · done ${run.counts.done} · still ready ${run.counts.ready} · waiting ${run.counts.waiting} · unavailable ${run.counts.unavailable}`,
      );
      for (const u of run.last.unavailable) say(`unavailable ${u.key} — needs ${u.missing}`);
      say(`run log ${log}`);
      return run.counts.failed > 0 ? 1 : 0;
    }
    case 'clear-dry': {
      say(
        `would remove: ${tally(call<Record<string, number>>('inboxSeed:clearPlan', {}))} (and everything about them)`,
      );
      say('dry run — nothing removed. Add --apply to remove it.');
      return 0;
    }
    case 'clear': {
      const run = applyClear(call);
      const log = writeLog('clear', { target: target.label, ...run });
      say(`removed in ${run.calls} calls: ${tally(run.removed)}`);
      say(`run log ${log}`);
      return run.done ? 0 : 1;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    say(`failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
