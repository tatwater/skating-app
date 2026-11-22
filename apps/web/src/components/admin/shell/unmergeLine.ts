import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';

/**
 * **The unmerge's outcome, in one wording** — the Undone toast after a merge's Undo, the unmerge's
 * row in a body's History and in the shell's History panel all say it from the same two facts the
 * unmerge's own audit row carries (`metadata.done`, `metadata.left.count`): still moving rows back,
 * finished with every row back, or how many rows had changed since the merge and stayed.
 */
export function unmergeLine({ done, leftCount }: { done: boolean; leftCount: number }): string {
  if (!done) return leftCount > 0 ? `${MW.unmerging} · ${MW.leftSince(leftCount)}` : MW.unmerging;
  return leftCount > 0 ? MW.leftSince(leftCount) : MW.unmergedAll;
}

/** The two facts from an unmerge row's stored `metadata`; `null` when it doesn't carry them. */
export function unmergeFactsOf(metadata: unknown): { done: boolean; leftCount: number } | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const { done, left } = metadata as { done?: unknown; left?: { count?: unknown } };
  if (typeof done !== 'boolean' || typeof left?.count !== 'number') return null;
  return { done, leftCount: left.count };
}

/**
 * Why a row can't be undone, said on the row before anything runs — only where the reason is the
 * row's own rather than the verb's (a merge recorded before its change set kept everything an
 * unmerge needs); a verb that never undoes says nothing, as before.
 */
export function mergeUndoWhy(
  action: string,
  undo: { state: string; why?: string } | undefined,
): string | null {
  return action === 'merge_waterbody' && undo?.state === 'unavailable' && undo.why !== undefined
    ? undo.why
    : null;
}
