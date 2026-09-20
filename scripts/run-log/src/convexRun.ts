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
 *
 * **`options.as` (a Clerk user id) runs the call as that signed-in user.** Deployment credentials
 * carry no *user* identity, so a public mutation behind `requireContributorRole` — `setCuratedBoost`
 * is one — rejects a bare `convex run` with "Not authenticated". `convex run --identity` supplies a
 * `UserIdentity` for a dev deployment, and `lib/auth.ts` resolves the profile from its `subject`.
 * Per call, never global: a run carrying a user identity can reach *only* public functions, so the
 * internal reads a loader pages with (`listNamedForSeeding`) must keep going out bare. The operator
 * who names the user is the one whose audit rows result.
 */
export function convexRun<T>(
  functionName: string,
  args: unknown,
  options: { as?: string } = {},
): T {
  const identity = options.as ? ['--identity', JSON.stringify({ subject: options.as })] : [];
  const stdout = execFileSync(
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
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  return parseConvexOutput<T>(stdout);
}
