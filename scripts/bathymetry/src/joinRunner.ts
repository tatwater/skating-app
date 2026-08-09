/**
 * The one subprocess that talks to the deployment (N6b).
 *
 * Split from `joinQuery.ts` so the batching logic — the part that decides whether a failure means
 * "split" or "give up" — stays pure and fully tested, while this stays untestable glue.
 */

import { spawnSync } from 'node:child_process';
import type { JoinCandidate, JoinResult } from './joinQuery';

/**
 * The concrete runner: one `convex run` against the deployment.
 *
 * Shelled out rather than held open as a client, because this is a manual ETL that runs a handful of
 * times and the CLI already resolves the deployment, the admin key and the codegen. **It must throw**
 * on failure rather than returning an error shape — `joinInBatches` decides whether a failure means
 * "split" or "give up", and it can only do that if the failure reaches it.
 */
export async function runJoinQuery(batch: readonly JoinCandidate[]): Promise<JoinResult> {
  return runConvexQuery<JoinResult>('waterBodies:matchBathymetryLakes', { lakes: batch });
}

/**
 * Which corpus body contains each point — the D95 re-key lane's resolver.
 *
 * Same shape and the same "must throw" contract as `runJoinQuery`, so `joinInBatches` can drive it
 * with the same adaptive splitting. It needs that as much as the join does: `listedBodiesNearCoord`
 * pulls polygons, and a batch of points in the middle of Champlain reads three orders of magnitude
 * more than a batch in a farm pond.
 */
export async function runCoveringBodyQuery(
  points: readonly { lat: number; lng: number }[],
): Promise<{ bodies: ({ externalId?: string; name: string } | null)[] }> {
  return runConvexQuery('waterBodies:coveringBodyForPoints', { points });
}

function runConvexQuery<T>(functionName: string, args: unknown): T {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@skating/convex', 'exec', 'convex', 'run', functionName, JSON.stringify(args)],
    // A generous buffer, not a guess: a batch each carrying a full OSM shoreline polygon back is
    // megabytes of JSON on one stdout, and node's 1 MB default truncates it into a parse error that
    // reads like a query failure.
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || 'convex run failed with no output');
  }
  // The CLI prints the JSON result after any banner lines; take from the first brace.
  const out = result.stdout ?? '';
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`convex run returned no JSON: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start)) as T;
}
