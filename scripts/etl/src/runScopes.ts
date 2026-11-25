/**
 * **What each corpus pass set out to cover** — the `scope` its run row carries (D218, B01-6a).
 *
 * Stated by the writer at the run's start, so Machinery reads a full re-import and a gap-fill apart
 * without inferring it from `kind` and `label`. Kept here rather than inline in each CLI because the
 * CLIs are excluded from coverage (`vitest.config.ts`), and *which* runs read as partial is a
 * decision: a subset of states, a resumed walk, a merge missing one of its catalogs.
 *
 * `complete` is the run's intent, never its outcome — a full pass that died halfway is still a full
 * pass that failed; its `status` and `coverage` say so.
 */

import type { ImportRunScope } from '@skating/run-log';

/** Two-letter codes, upper case and sorted, so two runs over the same states store the same list. */
export function stateCodes(states: readonly string[]): string[] {
  return [...new Set(states.map((s) => s.toUpperCase()))].sort();
}

/**
 * The merge: every state it reads, from every catalog. A merge run without one of its catalogs is a
 * different corpus, so it is not complete, whatever states it covered.
 */
export function mergeScope(
  states: readonly string[],
  absentCatalogs: readonly string[],
): ImportRunScope {
  return {
    pass: 'full-canonical',
    states: stateCodes(states),
    complete: absentCatalogs.length === 0,
  };
}

/** The offline landmark match: the states it ran, complete only over every state the corpus covers. */
export function landmarkMatchScope(
  selected: readonly string[],
  all: readonly string[],
): ImportRunScope {
  const ran = new Set(stateCodes(selected));
  return {
    pass: 'derived',
    states: [...ran],
    complete: stateCodes(all).every((s) => ran.has(s)),
  };
}

/**
 * A landmark load: what the match it loads covered, read off the match's `summary.json`. A summary
 * that does not say is not complete — a load that retires rows must never be read as whole on a guess.
 */
export function landmarkLoadScope(
  summary: { states?: readonly string[]; complete?: boolean } | undefined,
): ImportRunScope {
  return {
    pass: 'enrichment',
    ...(summary?.states !== undefined && { states: stateCodes(summary.states) }),
    complete: summary?.complete === true,
  };
}

/**
 * The floor prune walks the whole corpus, not by state. Resumed from a checkpoint, this run covers
 * only what the killed one had not reached, so it is partial — the two rows together are the pass.
 */
export function floorPruneScope(resumed: boolean): ImportRunScope {
  return { pass: 'cleanup', complete: !resumed };
}

/** Every pair the merge absorbed, from its `absorbed.ndjson` — never by state. */
export const RETIRE_ABSORBED_SCOPE: ImportRunScope = { pass: 'cleanup', complete: true };
