/**
 * Calling `waterBodies:matchBathymetryLakes`, and surviving the read cap (N6b).
 *
 * ## Why this is its own module
 *
 * Two callers resolve lakes to bodies — the ETL's `join` lane and the sample renderer — and both hit
 * the same wall at corpus scale. A Convex function may read **16 MB** in one execution, and each lake
 * in a batch pulls every listed body near its representative point, polygons included. A batch of 20
 * blew the limit on the first real run; the failure is a *server* error, not a validation one, so it
 * arrives as an opaque 500 rather than as "your batch is too big".
 *
 * ## Why the batch size cannot simply be lowered
 *
 * **The cost is per-lake and wildly uneven.** A farm pond near nothing reads a few kilobytes; a point
 * in the middle of Champlain reads every body in a dense cell plus its own multi-megabyte shoreline.
 * So there is no constant that is both safe for Champlain and not absurdly slow for the other 2,473
 * lakes — a batch of 1 would be correct and would take an hour.
 *
 * So the size is **adaptive**: start optimistic, and on a read-limit failure split the batch and retry
 * the halves. A lake that fails alone is recorded as a reject naming the limit, rather than vanishing
 * — an ETL that silently resolves 60% looks exactly like one that resolved all of it.
 */

/**
 * What the query is asked about one lake.
 *
 * **`samplePoints` is not optional in practice, whatever this type says.** It is a strided sample of
 * the survey's own measurements, and it is the only thing standing between the join and attributing a
 * farm pond's soundings to the reservoir it sits beside. The equivalent field stayed unset for the
 * whole first build — declared here and never populated — which silently disabled the gate on the
 * server and shipped nine wrong lakes. It is typed optional only because the server tolerates its
 * absence; a caller that omits it is choosing to run without the gate, and the ETL says so.
 */
export interface JoinCandidate {
  key: string;
  point: { lat: number; lng: number };
  samplePoints?: { lat: number; lng: number }[];
}

/** One water body a lake resolved to. */
export interface ResolvedBody {
  waterBodyId: string;
  externalId?: string;
  source: string;
  name: string;
  surfaceAreaSqM?: number;
  states?: string[];
  polygon?: unknown;
}

/**
 * What comes back for a lake that matched: the body the survey *is*, plus the bodies it also covers.
 *
 * `alsoCovers` is the bodies nested inside the surveyed lake, largest first. Empty for all but **9 of
 * 2,353** lakes in the first build, so a caller that ignores it is wrong about a handful rather than
 * broken. Those 9 are not all bays, and the mix is worth knowing before tuning anything here:
 *
 * - **1 true parent/bay** — Moosehead Lake over North Bay, the case this was built for.
 * - **2 genuinely distinct nested waters** — an unnamed 41-acre pond inside Five Kezar Ponds; Upper
 *   Artichoke Reservoir inside Artichoke River Reservoir.
 * - **5 corpus duplicates** — one lake carrying two OSM features a few percent apart in area (Long
 *   Pond 2,552 vs 2,532 ac, Lovell Lake 553 vs 540, Duncan Lake 85 vs 83, Meadow Lake, Bolster
 *   Pond). Stamping both is a *workaround* for a D36 dedup gap, not a feature: the right fix is one
 *   row per lake, and if dedup ever lands these should stop appearing here.
 *
 * Count them deduplicated by `externalId`. A raw read of the ETL's per-state `bodies.ndjson` counts
 * Umbagog, Moore Reservoir and Great East Lake as duplicates because one OSM relation appears in
 * every state extract it touches — but `importCanonical` upserts on `(source, externalId)`, so the
 * corpus holds exactly one row for each. That artifact is what made this number look like 34.
 */
export interface JoinedBody extends ResolvedBody {
  key: string;
  alsoCovers?: ResolvedBody[];
}

export interface JoinResult {
  matches: JoinedBody[];
  rejects: { key: string; reason: string }[];
}

/**
 * Does this failure mean "the batch was too big" rather than "the query is broken"?
 *
 * Matched on the limit's own wording because Convex surfaces it as a generic server error. Being
 * wrong in the permissive direction is the safe way round: a genuinely broken query retried at size 1
 * fails 2,474 times with a clear message, whereas a read-limit failure mistaken for a broken query
 * aborts a run that would have completed.
 */
export function isReadLimitError(message: string): boolean {
  return /too many bytes read|read too much data|limit: \d+ bytes/i.test(message);
}

/**
 * Resolve every candidate, splitting any batch that trips the read cap.
 *
 * `run` is injected so the splitting logic is testable without a deployment — it is the part that can
 * be wrong in a way that still looks right (dropping a half, or recursing forever on a single lake
 * that fails for an unrelated reason).
 */
export async function joinInBatches(
  candidates: readonly JoinCandidate[],
  batchSize: number,
  run: (batch: readonly JoinCandidate[]) => Promise<JoinResult>,
  onProgress?: (done: number, total: number) => void,
): Promise<JoinResult> {
  const matches: JoinedBody[] = [];
  const rejects: { key: string; reason: string }[] = [];
  let done = 0;

  async function attempt(batch: readonly JoinCandidate[]): Promise<void> {
    if (batch.length === 0) return;
    try {
      const result = await run(batch);
      matches.push(...result.matches);
      rejects.push(...result.rejects);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (batch.length === 1 || !isReadLimitError(message)) {
        // Named, never dropped. A single lake too expensive to resolve is a finding about our corpus
        // (a dense cell, or a shoreline with a very large vertex count), not a lake to lose quietly.
        for (const candidate of batch) {
          rejects.push({ key: candidate.key, reason: `join failed: ${message.slice(0, 200)}` });
        }
        return;
      }
      const half = Math.floor(batch.length / 2);
      await attempt(batch.slice(0, half));
      await attempt(batch.slice(half));
      return;
    }
    done += batch.length;
    onProgress?.(done, candidates.length);
  }

  for (let i = 0; i < candidates.length; i += batchSize) {
    await attempt(candidates.slice(i, i + batchSize));
  }
  return { matches, rejects };
}
