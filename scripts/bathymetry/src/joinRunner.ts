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
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@skating/convex',
      'exec',
      'convex',
      'run',
      'waterBodies:matchBathymetryLakes',
      JSON.stringify({ lakes: batch }),
    ],
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
  return JSON.parse(out.slice(start)) as JoinResult;
}
