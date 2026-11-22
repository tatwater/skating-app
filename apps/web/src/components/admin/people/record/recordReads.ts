import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type Loadable, type ReadFailure, type ReadSpec, read } from '../../reads/consoleReads';
import { joinChain, useJoinedPages } from '../../reads/joinChain';
import type { ChainLink } from '../../reads/pageChain';
import { useChainedPages } from '../../reads/useChainedPages';
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
 * list is a chain of pages, stitched as the People list's is (`reads/useChainedPages`, over the pure
 * rule in `reads/pageChain`, joined by `reads/joinChain`) — the server's cursors are positions in the list's order, not Convex page
 * cursors, so the chain is ours. A page read past is pinned to where it ended (`endCursor`): the
 * server then reads exactly that range and keeps its end, so a decision landing in an earlier page
 * moves nothing on the pages after it; a pinned page that outgrew a page is split where the server
 * says (`splitCursor`). A failed page is said in its place with *Try again*; the rows before it stand.
 *
 * - **A short page is not the end** — `isDone` is. A page can even come back empty with more to
 *   come (the budget cut it before its first shown row); the list asks for the next.
 * - **`pending`**: any page naming a backfill (`verdicts`; on Deleted, `withdrawals` too) makes the
 *   whole list *still being prepared*.
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
  splitCursor?: string | null;
  pageStatus?: string | null;
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

/** The read for one page of a tab: from its cursor, to its end once it has been read past. */
function pageRead(args: RecordListArgs, link: ChainLink): ReadSpec {
  const query =
    args.tab === 'standing'
      ? api.contentRecord.personVerdicts
      : args.tab === 'deleted'
        ? api.contentRecord.personDeleted
        : api.contentRecord.personReversed;
  return read(query, {
    userId: args.userId as Id<'profiles'>,
    ...(args.kind !== null && { targetType: args.kind }),
    cursor: link.cursor,
    ...(link.end !== null && { endCursor: link.end }),
  });
}

export function useRecordList<T extends RecordTab>(
  args: (RecordListArgs & { tab: T }) | null,
): RecordListState<RecordRowOf<T>> {
  const key = args === null ? '' : `${args.userId}|${args.tab}|${args.kind ?? ''}`;
  const { pages, loadMore, retry, retrying } = useChainedPages<AnyPage>(
    key,
    args === null ? null : (link) => pageRead(args, link),
  );
  const joined = useJoinedPages(args === null ? null : pages, joinRecordPages);
  return {
    status: joined.status,
    rows: joined.rows as RecordRowOf<T>[],
    pending: joined.pending,
    failure: joined.failed ? { failed: true, pending: retrying, retry } : null,
    loadMore,
  };
}

type Joined = {
  status: ListStatus | 'unread';
  rows: AnyPage['page'];
  pending: boolean;
  failed: boolean;
};

/**
 * The chain's rows in order, each item once (a page read again from a new start can still hold a
 * row the next page holds), whether any page says the record is still being prepared, and where the
 * chain stops: a failed page (the rows before it stand), a page on its way or to be split, or the
 * last page's end.
 */
export function joinRecordPages(pages: readonly Loadable<AnyPage>[] | null): Joined {
  const { status, rows, read, failed } = joinChain(
    pages,
    (page) => page.page,
    (row) => targetKey(row),
  );
  // Whatever backfill a page rests on — the record's verdicts, or the Deleted list's withdrawal rows.
  const pending = read.some((page) => page.pending.length > 0);
  return { status, rows, pending, failed };
}
