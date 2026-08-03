/**
 * `pnpm exec convex run <fn> <json>` as a function call. Subprocess glue — excluded from coverage.
 *
 * The CLI invokes internal functions with the deployment's admin credentials from
 * `packages/convex/.env.local`, which is why every loader shells out rather than holding a client.
 */

import { execFileSync } from 'node:child_process';
import { parseConvexOutput } from './parseOutput';

/**
 * Call a Convex function and parse its return value.
 *
 * `convex run` pretty-prints the return value on stdout as JSON and sends the function's own logs
 * to stderr, which we inherit so a loader's operator still sees them live.
 */
export function convexRun<T>(functionName: string, args: unknown): T {
  const stdout = execFileSync(
    'pnpm',
    ['--filter', '@skating/convex', 'exec', 'convex', 'run', functionName, JSON.stringify(args)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  return parseConvexOutput<T>(stdout);
}
