/**
 * **A whole-list write refuses when the list moved under it** (B01-3d, BS17) — the compare-and-set
 * every write that replaces a body's list from the client's copy takes: the client sends the list it
 * built its edit on (`expected`); when the stored list differs, the write refuses with a plain message
 * and the list as it stands now (`ConvexError` data `{ code: 'list_changed', current }`), so the page
 * can re-apply the moderator's change on top. Without `expected` the write behaves as before (the
 * later write wins), which is what a page that doesn't send it yet gets.
 */

import { ConvexError, type Value } from 'convex/values';

/** The refusal's data, for a page to read the current list from. */
export interface ListChanged<T> {
  code: 'list_changed';
  message: string;
  current: T[];
}

/** Refuse when `expected` is given and the stored list no longer equals it. */
export function assertListUnchanged<T extends Value>(
  stored: readonly T[],
  expected: readonly T[] | undefined,
  what: string,
): void {
  if (expected === undefined) return;
  if (JSON.stringify(stored) === JSON.stringify(expected)) return;
  throw new ConvexError({
    code: 'list_changed',
    message: `Someone else changed ${what} since you opened it. Here is the list as it stands now — apply your change to it and save again.`,
    current: [...stored],
  } as unknown as Value);
}
