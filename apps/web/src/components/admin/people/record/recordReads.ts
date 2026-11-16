import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isFailed,
  type Loadable,
  loaded,
  type ReadFailure,
  type ReadSpec,
  read,
  useConsoleReadSet,
} from '../../reads/consoleReads';
import {
  type DeletedRow,
  type ListStatus,
  type RecordTab,
  type ReversedRow,
  type StandingRow,
  targetKey,
} from './recordModel';
import type { RecordKind } from './recordWords';

/**
 * **The record sheet's lists, through the console's one read layer** (`reads/consoleReads`): each
 * list is a chain of pages, each page a read asked with the cursor the page before it ended on —
 * the server's cursors are positions in the list's order, not Convex page cursors, so the chain is
 * ours (as People's list is). Each page is a subscription: a page whose end moves reactively
 * re-anchors the pages after it. A failed page is said in its place with *Try again*; the rows
 * before it stand.
 *
 * - **A short page is not the end** — `isDone` is. A page can even come back empty with more to
 *   come (the Deleted list passes over an erased comment's shell); the list asks for the next.
 * - **`pending`**: any page saying `verdicts` makes the whole list *still being prepared*.
 */

export type RecordRowOf<T extends RecordTab> = T extends 'standing'
  ? StandingRow
  : T extends 'deleted'
    ? DeletedRow
    : ReversedRow;

type AnyPage = {
  page: Array<StandingRow | DeletedRow | ReversedRow>;
  isDone: boolean;
  continueCursor: string;
  pending: readonly string[];
};

export interface RecordListState<R> {
  status: ListStatus | 'unread';
  rows: R[];
  /** Any page said the record is still being prepared. */
  pending: boolean;
  /** The failed page's *Try again*, held as pending after a press. */
  failure: ReadFailure | null;
  /** Ask for the next page, when there is one and none is on its way. */
  loadMore: () => void;
}

export type RecordListArgs = {
  tab: RecordTab;
  userId: string;
  kind: RecordKind | null;
};

/** The read for one page of a tab. */
function pageRead(args: RecordListArgs, cursor: string | null): ReadSpec {
  const query =
    args.tab === 'standing'
      ? api.contentRecord.personVerdicts
      : args.tab === 'deleted'
        ? api.contentRecord.personDeleted
        : api.contentRecord.personReversed;
  return read(query, {
    userId: args.userId as Id<'profiles'>,
    ...(args.kind !== null && { targetType: args.kind }),
    cursor,
  });
}

export function useRecordList<T extends RecordTab>(
  args: (RecordListArgs & { tab: T }) | null,
): RecordListState<RecordRowOf<T>> {
  const key = args === null ? '' : `${args.userId}|${args.tab}|${args.kind ?? ''}`;
  const [chain, setChain] = useState<{ key: string; cursors: (string | null)[] }>({
    key,
    cursors: [null],
  });
  const cursors = chain.key === key ? chain.cursors : [null];

  const specs: Record<string, ReadSpec | null> = {};
  if (args !== null) {
    cursors.forEach((cursor, i) => {
      specs[`p${i}`] = pageRead(args, cursor);
    });
  }
  const { reads, retry, pending: retrying } = useConsoleReadSet(specs);
  const pages = cursors.map((_, i) => reads[`p${i}`] as Loadable<AnyPage>);

  // A page whose end moved re-anchors the chain after it.
  const ends = pages.map((p) => {
    const page = loaded(p);
    return page === undefined ? undefined : page.isDone ? 'done' : page.continueCursor;
  });
  const endsKey = JSON.stringify(ends);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pages' ends, by value.
  useEffect(() => {
    if (args === null) return;
    const next = reanchor(cursors, ends);
    if (next !== null) setChain({ key, cursors: next });
  }, [endsKey, key]);

  const joined = useJoined(args === null ? null : pages);
  const last = loaded(pages.at(-1));
  // The next page's cursor, or `null` when there is none to ask for (closed, on its way, or done).
  const next = args === null || last === undefined || last.isDone ? null : last.continueCursor;
  // Stable while the chain holds still, so the list's load-ahead check isn't rebuilt every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cursors` is derived from `chain` and `key`.
  const loadMore = useCallback(() => {
    if (next === null) return;
    setChain({ key, cursors: [...cursors, next] });
  }, [next, key, chain]);
  return {
    status: joined.status,
    rows: joined.rows as RecordRowOf<T>[],
    pending: joined.pending,
    failure: joined.failed ? { failed: true, pending: retrying, retry } : null,
    loadMore,
  };
}

/**
 * The chain to ask for when a page's end no longer matches the cursor after it (it moved
 * reactively, or a page came back done): cut there, and ask on from the new end. `null` while every
 * page agrees with the next, or a page before the mismatch is still on its way.
 */
export function reanchor(
  cursors: readonly (string | null)[],
  ends: readonly (string | undefined)[],
): (string | null)[] | null {
  for (let i = 0; i < cursors.length - 1; i++) {
    const end = ends[i];
    if (end === undefined) return null;
    if (end === 'done' || end !== cursors[i + 1]) {
      const kept = cursors.slice(0, i + 1);
      return end === 'done' ? kept : [...kept, end];
    }
  }
  return null;
}

type Joined = {
  status: ListStatus | 'unread';
  rows: AnyPage['page'];
  pending: boolean;
  failed: boolean;
};

/** The pages joined — recomputed only when a page itself changed, so rows keep their identity. */
function useJoined(pages: readonly Loadable<AnyPage>[] | null): Joined {
  const cache = useRef<{ pages: readonly Loadable<AnyPage>[] | null; value: Joined } | null>(null);
  const last = cache.current;
  if (
    last !== null &&
    (last.pages === pages ||
      (last.pages !== null &&
        pages !== null &&
        last.pages.length === pages.length &&
        last.pages.every((p, i) => p === pages[i])))
  ) {
    return last.value;
  }
  const value = joinRecordPages(pages);
  cache.current = { pages, value };
  return value;
}

/**
 * The chain's rows in order, each item once (a re-anchoring page can repeat a row the next holds),
 * whether any page says the record is still being prepared, and where the chain stops: a failed page
 * (the rows before it stand), a page on its way, or the last page's end.
 */
export function joinRecordPages(pages: readonly Loadable<AnyPage>[] | null): Joined {
  if (pages === null) return { status: 'unread', rows: [], pending: false, failed: false };
  const rows: AnyPage['page'] = [];
  const seen = new Set<string>();
  let pending = false;
  let status: ListStatus = 'done';
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
    for (const row of page.page) {
      const k = targetKey(row);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(row);
    }
    if (page.pending.includes('verdicts')) pending = true;
    if (i === pages.length - 1) status = page.isDone ? 'done' : 'more';
  }
  return { status, rows, pending, failed };
}
