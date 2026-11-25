import { api } from '@skating/convex/api';
import { CORPUS_PAGE_SIZE, type CorpusTaskLane } from '@skating/core';

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
  CorpusLanesView,
  CorpusListPage,
  CorpusRowView,
  CorpusTaskItemRead,
} from '../corpusTypes';
import { DECIDED_TAB, isBodyRef, type TaskTab } from '../taskSearch';

/**
 * **The Corpus tasks' reads**, through the console's one read layer (`reads/consoleReads`), as the
 * Inbox's are: each read on its way, failed (with *Try again*), or its value — never a throw.
 *
 * - **The lanes** (`corpusTasks.lanes`): held through a change of list, never past a failure.
 * - **The list** (`corpusTasks.listPage`): the shared chain of cursor pages, each pinned to where it
 *   ended (`endCursor`), so a decision on page one moves nothing on page two. Each row once.
 * - **The decided tail**: the lane's decided tab, newest first, one page of twenty.
 * - **The item** (`corpusTasks.item`): one live read — the lock reads it.
 */

/** How many decided tasks the tail under the open list shows. */
export const TAIL_SIZE = 20;

// ── The lanes ─────────────────────────────────────────────────────────────────────────────────────────

export interface CorpusLanesState {
  state: Loadable<CorpusLanesView>;
  /** This answer, or the last one while the next is on its way; never after a failure. */
  shown: CorpusLanesView | undefined;
}

export function useCorpusLanes(now: number, enabled: boolean): CorpusLanesState {
  const { reads } = useConsoleReadSet({
    lanes: enabled ? read(api.corpusTasks.lanes, { now }) : null,
  });
  const state = reads.lanes;
  return { state, shown: useHeldRead(loaded(state), !enabled || isFailed(state)) };
}

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where the list stands: the shared chain's statuses, and the two ways a scan, not the list, ended
 * it — `budget`: a page stopped short with a next page to read on; `capped`: a search (one bounded
 * read, `corpusTasks.listPage`'s `q`: no next page) stopped at its bound with more that may match.
 */
export type TaskListStatus = ChainStatus | 'budget' | 'capped';

export interface TaskPagesState {
  status: TaskListStatus;
  rows: CorpusRowView[];
  /** The server is still filing its stored tasks: the list may be missing some. */
  pending: boolean;
  /** The failed page's retry, held as pending after *Try again*. */
  failure: ReadFailure | null;
  /** Ask for the next page (the load-ahead, or *Read on* past the scan's budget). */
  loadMore: () => void;
}

export interface TaskPagesArgs {
  lane: CorpusTaskLane;
  tab: TaskTab | null;
  q: string;
  now: number;
  /** This list, as it stands: the chain starts over when it changes. */
  memoryKey: string;
}

export function useTaskPages(args: TaskPagesArgs | null): TaskPagesState {
  const key = args === null ? '' : args.memoryKey;
  const q = args?.q.trim() ?? '';
  const { pages, loadMore, retry, retrying } = useChainedPages<CorpusListPage>(
    key,
    args === null
      ? null
      : (link) =>
          read(api.corpusTasks.listPage, {
            lane: args.lane,
            ...(args.tab !== null && { tab: args.tab }),
            ...(q !== '' && { q }),
            cursor: link.cursor,
            ...(link.end !== null && { endCursor: link.end }),
            pageSize: CORPUS_PAGE_SIZE,
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

type Joined = { status: TaskListStatus; rows: CorpusRowView[]; pending: boolean; failed: boolean };

/**
 * The chain's rows in order, each task once, whether any page read says the server is still filing,
 * and where the chain stops — at the scan's budget when the last page read says the scan, not the
 * list, ended it: with a next page (`budget`), or, as a search answers, with none (`capped` — the
 * server's search is done in one read and says `scanBudgetSpent` when it left matches unread, so a
 * done list that says so is never drawn as every match).
 */
export function joinPages(pages: readonly Loadable<CorpusListPage>[] | null): Joined {
  const { status, rows, read, failed } = joinChain(
    pages,
    (page) => page.rows,
    (row) => row.taskId,
  );
  const spent = read.at(-1)?.scanBudgetSpent === true;
  return {
    status: spent && status === 'more' ? 'budget' : spent && status === 'done' ? 'capped' : status,
    rows,
    pending: read.some((p) => p.pending),
    failed,
  };
}

// ── One read each ─────────────────────────────────────────────────────────────────────────────────────

export interface OneRead<T> {
  state: Loadable<T>;
  retry: () => void;
  retrying: boolean;
}

function useOne<T>(spec: Parameters<typeof useConsoleReadSet>[0]['x']): OneRead<T> {
  const { reads, retry, pending } = useConsoleReadSet({ x: spec });
  return { state: reads.x as Loadable<T>, retry, retrying: pending };
}

/** The lane's newest decisions, under its open list (not read on the decided tab itself). */
export function useTaskTail(
  lane: CorpusTaskLane,
  tab: TaskTab | null,
  now: number,
  enabled: boolean,
): OneRead<CorpusListPage> {
  return useOne<CorpusListPage>(
    enabled && tab !== DECIDED_TAB
      ? read(api.corpusTasks.listPage, {
          lane,
          tab: DECIDED_TAB,
          cursor: null,
          pageSize: TAIL_SIZE,
          now,
        })
      : null,
  );
}

/**
 * The task behind `?item=`, a live subscription (the decided-only lock reads it). A `body:` ref names
 * the body's task in this lane, so the lane goes with it.
 */
export function useTaskItem(
  ref: string | null,
  lane: CorpusTaskLane,
  now: number,
  enabled: boolean,
): OneRead<CorpusTaskItemRead> {
  return useOne<CorpusTaskItemRead>(
    enabled && ref !== null
      ? read(api.corpusTasks.item, { ref, ...(isBodyRef(ref) && { lane }), now })
      : null,
  );
}
