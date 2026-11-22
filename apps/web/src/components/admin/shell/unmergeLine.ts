import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';

/**
 * **The unmerge's outcome, in one wording** — the Undone toast after a merge's Undo, the unmerge's
 * row in a body's History and in the shell's History panel all say it from the same two facts the
 * unmerge's own audit row carries (`metadata.done`, `metadata.left.count`): still moving rows back,
 * finished with every row back, or how many rows had changed since the merge and stayed.
 */
export function unmergeLine({
  done,
  leftCount,
  stalled = false,
  abandoned = false,
}: {
  done: boolean;
  leftCount: number;
  /** Not done, and nothing is carrying it on (a page failed): it stopped before it finished. */
  stalled?: boolean;
  /** Ended by a moderator before it finished (`unmerge.abandon`): terminal, beside done. */
  abandoned?: boolean;
}): string {
  if (!done && abandoned) return MW.unmergeAbandoned;
  if (!done && stalled) return MW.unmergeStalled;
  if (!done) return leftCount > 0 ? `${MW.unmerging} · ${MW.leftSince(leftCount)}` : MW.unmerging;
  return leftCount > 0 ? MW.leftSince(leftCount) : MW.unmergedAll;
}

/**
 * The facts from an unmerge row's stored `metadata`; `null` when it doesn't carry them. A stall its
 * row records (a page that found a state it couldn't carry on from) reads here; one the scheduler
 * alone knows (a page that failed) only from the live read (`unmerge.receipt`).
 */
export function unmergeFactsOf(
  metadata: unknown,
): { done: boolean; leftCount: number; stalled: boolean; abandoned: boolean } | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const { done, left, stalled, abandoned } = metadata as {
    done?: unknown;
    left?: { count?: unknown };
    stalled?: unknown;
    abandoned?: unknown;
  };
  if (typeof done !== 'boolean' || typeof left?.count !== 'number') return null;
  return {
    done,
    leftCount: left.count,
    stalled: !done && stalled != null,
    abandoned: !done && abandoned != null,
  };
}

/**
 * The line of the row an abandon wrote (`unmerge_waterbody` with `metadata.abandons`): that it was
 * abandoned, what it had left where it was, and what it never reached (`notReached`, each phase's rows
 * from where it stopped, still where the merge put them) — or that this couldn't be read. `null` for
 * any other row.
 */
export function abandonLineOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const { abandons, left, notReached } = metadata as {
    abandons?: unknown;
    left?: { count?: unknown };
    notReached?: { remaining?: Record<string, number> } | null;
  };
  if (abandons === undefined) return null;
  const parts: string[] = [MW.unmergeAbandoned];
  if (typeof left?.count === 'number' && left.count > 0) parts.push(MW.leftSince(left.count));
  if (notReached === null || notReached === undefined) parts.push(MW.notReachedUnread);
  else {
    const n = Object.values(notReached.remaining ?? {}).reduce((sum, k) => sum + k, 0);
    parts.push(n > 0 ? MW.notReached(n) : MW.everythingReached);
  }
  return parts.join(' · ');
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
