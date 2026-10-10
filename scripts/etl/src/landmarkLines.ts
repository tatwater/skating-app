/**
 * The landmark pass's hand-off (D202) — which bodies get a line in `landmarks.ndjson`, how the loader
 * packs lines into calls, and when `--apply` must refuse. Pulled out of `landmarkCli.ts` and
 * `loadLandmarks.ts` (both excluded from coverage as I/O) because each is a decision: a line marked
 * `complete` is what lets the importer retire a catalog row, so the rule that marks one is tested.
 */

import type { PlacedLandmark } from './landmarkMatch';

export interface BodyLine {
  waterBodyId: string;
  landmarks: unknown[];
  /** This list is all the catalogs place on the body: a row it lacks may be retired. */
  complete?: boolean;
}

/**
 * Is this a run of every state? Only then is a body's list complete. A partial run cannot vouch for
 * any body: a Vermont pond 500 m from a New Hampshire village holds a landmark only the NH catalogs
 * place, so even a body wholly inside the run's states may be missing rows the run never read.
 */
export function runIsComplete(selected: readonly string[], all: readonly string[]): boolean {
  const ran = new Set(selected.map((s) => s.toLowerCase()));
  return all.every((s) => ran.has(s.toLowerCase()));
}

/**
 * One line per body for the loader. A partial run writes only the bodies it placed something on;
 * a complete run writes every exported body, an empty line where nothing landed, each marked
 * `complete` — the empty line is how a lake whose last landmark moved off it loses the label.
 */
export function landmarkLines(
  bodyIds: readonly string[],
  byBody: ReadonlyMap<string, readonly PlacedLandmark[]>,
  complete: boolean,
): BodyLine[] {
  const lines: BodyLine[] = [];
  for (const waterBodyId of bodyIds) {
    const placed = byBody.get(waterBodyId) ?? [];
    if (placed.length === 0 && !complete) continue;
    lines.push({
      waterBodyId,
      landmarks: placed.map(({ waterBodyId: _, ...rest }) => rest),
      ...(complete ? { complete } : {}),
    });
  }
  return lines;
}

/**
 * Pack bodies into calls of about `batchSize` landmarks — **never splitting a body**. The mutation
 * resolves every candidate to its row before writing, and retires a complete body's rows that no
 * candidate resolved to; both hold only within one call. A body over the batch size goes alone
 * (Champlain's ~560 is one call); the write caps it at 1,500. An empty line weighs one: it costs
 * the mutation an index read, and the body's own read only when it has catalog rows to retire.
 */
export function packLines(lines: readonly BodyLine[], batchSize: number): BodyLine[][] {
  const batches: BodyLine[][] = [];
  let current: BodyLine[] = [];
  let size = 0;
  for (const line of lines) {
    const weight = Math.max(1, line.landmarks.length);
    if (current.length > 0 && size + weight > batchSize) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += weight;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** How old a body export a complete run may be matched against before `--apply` refuses. */
export const MAX_BODY_EXPORT_AGE_MS = 24 * 60 * 60 * 1000;

/** What the transform's `summary.json` says about the run the loader is about to write. */
export interface TransformSummary {
  corpusApplied?: boolean;
  complete?: boolean;
  /** When `bodies.ndjson` was exported (epoch ms). */
  bodiesExportedAt?: number;
}

/**
 * Why `load-landmarks --apply` must not go ahead, or `null`. Each refusal names the flag that
 * overrides it, so a run that means it can say so.
 *
 * - **Without the corpus**: a catalog row takes this run's corpus count and spellings (the importer
 *   replaces them), so a transform run without the corpus would erase every one.
 * - **Against a stale body export**: a complete run retires what its lines lack, and a lake merged
 *   since the export has its landmarks on the survivor, which the old export matched nothing to —
 *   they would be dropped until the next run.
 */
export function applyRefusal(
  summary: TransformSummary | undefined,
  flags: { withoutCorpus: boolean; staleBodies: boolean },
  now: number,
): string | null {
  if (summary?.corpusApplied !== true && !flags.withoutCorpus) {
    return 'the transform ran without the corpus (--mentions); applying it would erase every corpus count and community spelling. Re-run the transform with --mentions, or pass --without-corpus to mean it.';
  }
  if (summary?.complete === true && !flags.staleBodies) {
    const exportedAt = summary.bodiesExportedAt;
    if (exportedAt === undefined || now - exportedAt > MAX_BODY_EXPORT_AGE_MS) {
      return 'a complete run retires the landmarks its lines lack, and the body export it was matched against is over a day old (or undated) — a lake merged since would lose its labels. Re-run the transform with --refresh-bodies, or pass --stale-bodies to mean it.';
    }
  }
  return null;
}
