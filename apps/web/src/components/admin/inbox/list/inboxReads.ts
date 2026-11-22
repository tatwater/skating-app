import { api } from '@skating/convex/api';
import { INBOX_PAGE_SIZE, type InboxLane, type InboxListLane } from '@skating/core';

import {
  isFailed,
  type Loadable,
  loaded,
  type ReadFailure,
  read,
  useConsoleReadSet,
} from '../../reads/consoleReads';
import { type ChainStatus, joinChain, useJoinedPages } from '../../reads/joinChain';
import { useChainedPages } from '../../reads/useChainedPages';
import { useHeldRead } from '../../shell/presence';
import type {
  InboxItemRead,
  InboxLanesView,
  InboxListPage,
  InboxRowView,
  InboxTailView,
  InboxTodayView,
} from './inboxTypes';

/**
 * **The Inbox's reads**, through the console's one read layer (`reads/consoleReads`): each read is
 * on its way, failed (with *Try again*, held as *Trying again…* until the fresh answer), or its
 * value — never a throw, so a failed read takes down its own block and nothing else.
 *
 * - **The lanes** (`inbox.lanes`): held through a change of list, so the sidebar's counts don't
 *   blink out while the next answer comes — never past a failure.
 * - **The list** (`inbox.listPage`) is the shared chain of cursor pages (`reads/useChainedPages`,
 *   joined by `reads/joinChain`): a page read past is pinned to where it ended (`endCursor`), so a
 *   decision on page one moves nothing on page two. Each row once, by its item.
 * - **The scan's budget**: a filtered page the scan ended, not the list (`scanBudgetSpent`), stops
 *   the list at *More to read* — asked on only by a press, so a filter that matches little never
 *   walks the whole table on its own.
 * - **The tail** (`inbox.tail`), **the day** (`inbox.today`) and **the item** (`inbox.item`) are one
 *   read each.
 */

// ── The lanes ────────────────────────────────────────────────────────────────────────────────

export interface LanesState {
  state: Loadable<InboxLanesView>;
  /** This answer, or the last one while the next is on its way; never after a failure. */
  shown: InboxLanesView | undefined;
}

export function useInboxLanes(now: number, dayStart: number, enabled: boolean): LanesState {
  const { reads } = useConsoleReadSet({
    lanes: enabled ? read(api.inbox.lanes, { now, dayStart }) : null,
  });
  const state = reads.lanes;
  return { state, shown: useHeldRead(loaded(state), !enabled || isFailed(state)) };
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────

/** Where the list stands: the shared chain's statuses, and `budget` — the scan stopped it. */
export type ListStatus = ChainStatus | 'budget';

export interface PagesState {
  status: ListStatus;
  rows: InboxRowView[];
  /** The server is still preparing its stored items: the list may be missing some. */
  pending: boolean;
  /** The failed page's retry, held as pending after *Try again*. */
  failure: ReadFailure | null;
  /** Ask for the next page (the load-ahead, or *Read on* past the scan's budget). */
  loadMore: () => void;
}

export interface PagesArgs {
  lane: InboxListLane;
  facet: string;
  filter?: { waterBodyId: string } | { subjectUserId: string } | { minAgeDays: number };
  now: number;
  /** This list, as it stands: the chain starts over when it changes. */
  memoryKey: string;
  pageSize?: number;
}

export function useInboxPages(args: PagesArgs | null): PagesState {
  const key = args === null ? '' : args.memoryKey;
  const { pages, loadMore, retry, retrying } = useChainedPages<InboxListPage>(
    key,
    args === null
      ? null
      : (link) =>
          read(api.inbox.listPage, {
            lane: args.lane,
            ...(args.facet !== 'all' && { facet: args.facet }),
            ...(args.filter !== undefined && { filter: args.filter }),
            cursor: link.cursor,
            ...(link.end !== null && { endCursor: link.end }),
            pageSize: args.pageSize ?? INBOX_PAGE_SIZE,
            now: args.now,
          }),
  );
  const joined = useJoinedPages(args === null ? null : pages, joinPages);
  return {
    status: joined.status,
    rows: joined.rows,
    pending: joined.pending,
    failure: joined.failed ? { failed: true, pending: retrying, retry } : null,
    loadMore,
  };
}

type Joined = { status: ListStatus; rows: InboxRowView[]; pending: boolean; failed: boolean };

/**
 * The chain's rows in order, each item once, whether any page read says the server is still
 * preparing, and where the chain stops — at the scan's budget when the last page read says the scan,
 * not the list, ended it.
 */
export function joinPages(pages: readonly Loadable<InboxListPage>[] | null): Joined {
  const { status, rows, read, failed } = joinChain(
    pages,
    (page) => page.rows,
    (row) => row.itemId,
  );
  const last = read.at(-1);
  const budget = status === 'more' && last?.scanBudgetSpent === true;
  return {
    status: budget ? 'budget' : status,
    rows,
    pending: read.some((p) => p.pending),
    failed,
  };
}

// ── One read each ────────────────────────────────────────────────────────────────────────────

export interface OneRead<T> {
  state: Loadable<T>;
  retry: () => void;
  retrying: boolean;
}

function useOne<T>(spec: Parameters<typeof useConsoleReadSet>[0]['x']): OneRead<T> {
  const { reads, retry, pending } = useConsoleReadSet({ x: spec });
  return { state: reads.x as Loadable<T>, retry, retrying: pending };
}

/** A lane's *Decided this week*; no read for All open or Decided (they have no tail). */
export function useInboxTail(lane: InboxListLane, now: number, enabled: boolean) {
  const isLane = enabled && lane !== 'all' && lane !== 'decided';
  return useOne<InboxTailView>(
    isLane ? read(api.inbox.tail, { lane: lane as InboxLane, now }) : null,
  );
}

/** The day so far (2.9), asked only while the inbox is at zero. */
export function useInboxToday(now: number, dayStart: number, enabled: boolean) {
  return useOne<InboxTodayView>(enabled ? read(api.inbox.today, { now, dayStart }) : null);
}

/** The newest decisions (the zero list's *Decided today*): the Decided list's first page. */
export function useDecidedFirstPage(now: number, enabled: boolean) {
  return useOne<InboxListPage>(
    enabled
      ? read(api.inbox.listPage, { lane: 'decided', cursor: null, pageSize: INBOX_PAGE_SIZE, now })
      : null,
  );
}

/** The item behind `?item=`, a live subscription (the decided-only lock reads it). */
export function useInboxItem(ref: string | null, enabled: boolean) {
  return useOne<InboxItemRead>(enabled && ref !== null ? read(api.inbox.item, { ref }) : null);
}
