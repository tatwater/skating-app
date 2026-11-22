import { useRef } from 'react';

import { isFailed, type Loadable } from './consoleReads';
import { mustSplit, type PageEnd } from './pageChain';

/**
 * **A chain's pages, joined into the list drawn** — the other half of `useChainedPages`, shared by
 * every console list that pages by cursor (People's list, the record sheet's lists, the Inbox's
 * list), so the rule for where a list stops is written once:
 *
 * - **Each row once, in the chain's order.** A page read again from a new start can still hold a
 *   row the next page holds; the first one drawn stands (`keyOf` names a row).
 * - **A failed page stops the list** (`error`): the rows before it stand, and nothing after it.
 * - **A page on its way stops it** — `loading` while it is the first, `fetching` after.
 * - **A page the server says must be split** holds only the start of its range: its rows stand, and
 *   nothing after them is drawn until the split pages land (`fetching`) — a gap would read as a
 *   lost row.
 * - **Otherwise the last page says** whether more can come (`more`) or every row is in (`done`).
 *
 * `read` is every page whose rows were drawn, in order (the split page included), so a list can
 * fold what each page says about itself (a backfill pending, a partial read) over exactly those.
 */

/** Where a list stands. `unread`: no read is made (the viewer can't read it). */
export type ChainStatus = 'unread' | 'loading' | 'error' | 'fetching' | 'more' | 'done';

export interface JoinedChain<P, R> {
  status: ChainStatus;
  rows: R[];
  /** The pages whose rows were drawn, in order. */
  read: P[];
  /** A page failed: the list shows its *Try again* after the rows before it. */
  failed: boolean;
}

/** The chain's pages as one list: each row once, stopped where the chain stops. */
export function joinChain<P extends PageEnd, R>(
  pages: readonly Loadable<P>[] | null,
  rowsOf: (page: P) => readonly R[],
  keyOf: (row: R) => string,
): JoinedChain<P, R> {
  if (pages === null) return { status: 'unread', rows: [], read: [], failed: false };
  const rows: R[] = [];
  const read: P[] = [];
  const seen = new Set<string>();
  let status: ChainStatus = 'done';
  let failed = false;
  for (const [i, page] of pages.entries()) {
    if (isFailed(page)) {
      status = 'error';
      failed = true;
      break;
    }
    if (page === undefined) {
      status = i === 0 ? 'loading' : 'fetching';
      break;
    }
    read.push(page);
    for (const row of rowsOf(page)) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (mustSplit(page)) {
      status = 'fetching';
      break;
    }
    if (i === pages.length - 1) status = page.isDone ? 'done' : 'more';
  }
  return { status, rows, read, failed };
}

/**
 * `join` of the chain's pages, recomputed only when a page itself changed — so the rows, and the
 * list drawn from them, keep their identity through every render that changes no page (a minute's
 * tick, a registry emit). `join` is read when a page changes, never as a key: pass a module-level
 * function.
 */
export function useJoinedPages<P, J>(
  pages: readonly Loadable<P>[] | null,
  join: (pages: readonly Loadable<P>[] | null) => J,
): J {
  const cache = useRef<{ pages: readonly Loadable<P>[] | null; value: J } | null>(null);
  const last = cache.current;
  if (last !== null && samePages(last.pages, pages)) return last.value;
  const value = join(pages);
  cache.current = { pages, value };
  return value;
}

function samePages<P>(a: readonly Loadable<P>[] | null, b: readonly Loadable<P>[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((p, i) => p === b[i]);
}
