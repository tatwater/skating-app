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

/** How far a source's candidate count may fall below its last good count and still vouch. */
export const MAX_SOURCE_SHRINK = 0.1;

/**
 * May this run vouch for a complete list? Every state must have run, and **every source must have
 * read what it read last time** — a truncated or empty cached extract (an osmium run cut short, a
 * GNIS file half-downloaded) would otherwise read as thousands of catalog removals and retire valid
 * labels. A source with no candidates, or more than {@link MAX_SOURCE_SHRINK} under its last good
 * count (`state.osm`, `state.gnis`), is a shortfall; any shortfall leaves the run incomplete — it
 * still adds and updates, and retires nothing — unless `acceptShrink` says the drop is real.
 *
 * The baseline moves only on a run that vouches, so one bad extract cannot lower the bar for the
 * next. With no baseline yet, only an empty source is caught.
 */
export function runCompleteness(
  selected: readonly string[],
  all: readonly string[],
  counts: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>> | undefined,
  acceptShrink: boolean,
): { complete: boolean; shortfalls: string[]; baseline: Record<string, number> | undefined } {
  const shortfalls: string[] = [];
  for (const [source, n] of Object.entries(counts)) {
    const last = baseline?.[source];
    if (n === 0) shortfalls.push(`${source}: no candidates`);
    else if (last !== undefined && n < last * (1 - MAX_SOURCE_SHRINK)) {
      const pct = Math.round((1 - n / last) * 100);
      shortfalls.push(`${source}: ${n} candidates, ${pct}% under the last good run's ${last}`);
    }
  }
  const vouches = shortfalls.length === 0 || acceptShrink;
  return {
    complete: runIsComplete(selected, all) && vouches,
    shortfalls,
    baseline: vouches ? { ...baseline, ...counts } : baseline,
  };
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

/** What the transform's `summary.json` says about the run the loader is about to write. */
export interface TransformSummary {
  corpusApplied?: boolean;
  complete?: boolean;
  /**
   * When `bodies.ndjson` was exported (epoch ms) — sent with every batch as `matchedAt`, so the
   * importer never drops a row a merge moved onto its body after the export the run was matched to.
   */
  bodiesExportedAt?: number;
}

/**
 * Why `load-landmarks --apply` must not go ahead, or `null`: a catalog row takes this run's corpus
 * count and spellings (the importer replaces them), so a transform run without the corpus would
 * erase every one — unless `--without-corpus` says that is meant.
 */
export function applyRefusal(
  summary: TransformSummary | undefined,
  flags: { withoutCorpus: boolean },
): string | null {
  if (summary?.corpusApplied !== true && !flags.withoutCorpus) {
    return 'the transform ran without the corpus (--mentions); applying it would erase every corpus count and community spelling. Re-run the transform with --mentions, or pass --without-corpus to mean it.';
  }
  return null;
}
