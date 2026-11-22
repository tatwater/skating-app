/**
 * `pnpm exec convex run <fn> <json>` as a function call.
 *
 * The CLI invokes internal functions with the deployment's admin credentials from
 * `packages/convex/.env.local`, which is why every loader shells out rather than holding a client.
 */

import type { RunAs } from './runAs';

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { parseConvexOutput } from './parseOutput';
import { identityArgs } from './runAs';
import { serverSentence } from './serverSentence';

/**
 * Call a Convex function and parse its return value.
 *
 * `convex run` pretty-prints the return value on stdout as JSON and sends the function's own logs
 * to stderr, which is captured and shown (once the call returns), so a failed call throws **the
 * server's own sentence** (`serverSentence`) — never pnpm's `Command failed …` line, which a run log
 * would otherwise record as why it failed.
 *
 * **`options.runAs` runs the call as a signed-in person, through this script.** Deployment
 * credentials carry no *user* identity, so a public mutation behind `requireContributorRole` —
 * `setCuratedBoost` is one — rejects a bare `convex run` with "Not authenticated". `convex run
 * --identity` supplies a `UserIdentity` for a dev deployment, and `lib/auth.ts` resolves the profile
 * from its `subject`. Per call, never global: a run carrying a user identity can reach *only* public
 * functions, so the internal reads a loader pages with (`listNamedForSeeding`) must keep going out
 * bare.
 *
 * **`as` is the operator's own Clerk user id — the person running the script, never just any
 * admin's.** The audit row names them as the actor, and `via` (the script's name, required) records
 * what they did it through, so the console reads "Teagan via seed-destinations" (D256). See
 * `runAs.ts`.
 */
export function convexRun<T>(
  functionName: string,
  args: unknown,
  options: { runAs?: RunAs } = {},
): T {
  const identity = identityArgs(options.runAs);
  const res = spawnSync(
    'pnpm',
    [
      '--filter',
      '@skating/convex',
      'exec',
      'convex',
      'run',
      functionName,
      JSON.stringify(args),
      ...identity,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(serverSentence(res.stderr ?? ''));
  return parseConvexOutput<T>(res.stdout ?? '');
}
