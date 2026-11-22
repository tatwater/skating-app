import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { ReactNode } from 'react';

import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';
import { isFailed, read, useConsoleReadSet } from '../reads/consoleReads';

/**
 * **What an unmerge left where it was**, said where the unmerge is: the Undone toast after a merge's
 * Undo, and the unmerge's History row. The server counts it on the unmerge's own audit row as its
 * pages land (`unmerge.receipt`), so the line moves while the unmerge runs: "Moving rows back…",
 * then — once the last page lands — how many rows had changed since the merge and stayed, or
 * nothing at all when every row went back (the toast then says what any undo says).
 *
 * The line is a toast's or a row's second line, so a read that fails draws nothing: the unmerge
 * still landed, and its History row asks again when it is next drawn.
 */

export type UnmergeReceipt = FunctionReturnType<typeof api.unmerge.receipt>;

/** The line for one answer: `null` while there is nothing to say. */
export function unmergeLeftLine(receipt: UnmergeReceipt | undefined): string | null {
  if (receipt === undefined || receipt === null) return null;
  const { done, left } = receipt;
  if (!done) return left.count > 0 ? `${MW.unmerging} · ${MW.leftSince(left.count)}` : MW.unmerging;
  return left.count > 0 ? MW.leftSince(left.count) : null;
}

/** The line for an answer the page already holds (a story, a test). */
export function UnmergeLeftView({
  receipt,
  fallback = null,
}: {
  receipt: UnmergeReceipt | undefined;
  /** What to say while there is nothing to say (the toast's usual line). */
  fallback?: ReactNode;
}): ReactNode {
  const line = unmergeLeftLine(receipt);
  if (line === null) return fallback;
  return <span data-slot="unmerge-left">{line}</span>;
}

/** The line for one merge's unmerge, read live from the server. */
export function UnmergeLeft({
  mergeActionId,
  fallback = null,
}: {
  mergeActionId: string;
  fallback?: ReactNode;
}): ReactNode {
  const { reads } = useConsoleReadSet({
    receipt: read(api.unmerge.receipt, {
      mergeActionId: mergeActionId as Id<'moderationActions'>,
    }),
  });
  const receipt = reads.receipt;
  return <UnmergeLeftView receipt={isFailed(receipt) ? undefined : receipt} fallback={fallback} />;
}
