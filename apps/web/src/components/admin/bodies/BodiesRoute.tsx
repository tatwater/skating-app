import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { clampPageSize, LIBRARY_PAGE_SIZE } from '@skating/core';
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { type PaginationStatus, usePaginatedQuery } from 'convex/react';
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { ReadBoundary } from '@/components/kit/read-boundary';
import { useRole } from '@/lib/useRole';
import { ID_SHAPE } from '../body/frame/bodySearch';

import { isFailed, type Loadable, loaded, read, useConsoleReadSet } from '../reads/consoleReads';
import { ReadNote } from '../reads/ReadNote';

import { useMinuteNow } from '../shell/presence';
import { BodiesView, type BodiesViewProps } from './BodiesView';
import { type BodiesListData, type BodyPreviewData, UNREAD_LIST } from './bodiesData';
import {
  type GetResult,
  type LibraryRow,
  type ListArgs,
  type ListSummary,
  laneCountsFrom,
  listArgsOf,
  listFrom,
  listFromOpened,
  type OtherStandings,
  previewFrom,
  servesFrom,
} from './bodiesReads';
import { type BodiesQuery, type BodiesSearch, listKey, queryOf, searchFor } from './bodiesSearch';
import { BODY_LANES } from './bodyLanes';
import { useOpenedBodies } from './openedRecently';

/**
 * The Bodies library, wired: its place from the URL (validated by `validateBodiesSearch`, which the
 * route file adopts as its `validateSearch`), the library's server reads (`bodiesReads` maps them),
 * the clock, and the link to a body's console. The page itself is `BodiesView`, props only.
 *
 * - **The list** is `bodies.listPage` through the paginated hook, starting at the library's page
 *   size — or, coming back to a list, as many rows as were showing (up to the library's most), so
 *   the remembered scroll lands where it was. The hook throws a failed page into React, so it runs
 *   in a small reader under the kit `ReadBoundary` and hands its pages up; the page itself is drawn
 *   once, outside the boundary, so its failure note (a live region mounted before its words) is
 *   announced, holds as *Trying again…* while the boundary resets and the first page reloads, and
 *   keeps focus when it empties.
 * - **The counts and the preview** go through the console's one read layer (`reads/`): the same
 *   registry, pending state, Sentry rule and `RetryNote` as the Body console's reads.
 * - **The counts** are `bodies.listSummary`. The lanes' counts are held through a change of place
 *   (they don't move with a filter); the list's total and the facet counts are only ever this
 *   query's, so a count is never a stale one. A lane no server read lists (Opened recently) reads
 *   All's summary for them, so the rail is counted whichever lane the page opens on.
 * - **The preview** reads the open body and its facts; the body, its facts and its history each say
 *   so in their block when their read fails. A failed put-ins or bays read draws no dots and no
 *   figure, and says so under the still — never drawn like a body that has none. A body merged away
 *   opens as its survivor (the URL moves there), so the pane's reads are always of one body.
 *
 * The list and its counts are read against the **list's clock**: the minute the list was opened,
 * held while it stays open, so a new minute never restarts the paging. Every read waits on
 * `body.read`; a viewer without it sees *Not recorded yet*.
 *
 * Mounted by `routes/admin.bodies.tsx`, which binds `validateBodiesSearch`. *Open in Body* goes to
 * the Body console carrying the list's own address as `from`, so the console's way back puts the
 * list back exactly as it was.
 *
 * Every change of place is a navigation to the same route with the new search, so the back button,
 * a reload and a return from the Body console put the list back as it was. Moving down the list
 * replaces the entry rather than stacking one per row.
 */

/** Where the list opens a body: its Body console, the id escaped as every other link to it is. */
export const BODY_PATH = (id: string) => `/admin/body/${encodeURIComponent(id)}`;

export type BodiesRouteProps = {
  /** Where a body opens (its Body console). */
  bodyPath?: (id: string) => string;
  /** The open action's words, matching `bodyPath`. */
  openLabel?: string;
};

export function BodiesRoute({ bodyPath = BODY_PATH, openLabel }: BodiesRouteProps) {
  const search = useSearch({ strict: false }) as BodiesSearch;
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  // The list's own address, whole: the Body console's way back.
  const from = useRouterState({ select: (s) => s.location.href });
  const query = queryOf(search);
  const key = listKey(query);
  const listNow = useClockFor(key);
  const canRead = can('body.read');
  const args = canRead ? listArgsOf(query, listNow) : null;
  // A lane no server read lists (Opened recently) still counts the others: All's summary.
  const summary = useSummary(canRead ? (args ?? { lane: 'all', now: listNow }) : null);
  const others = useOtherStandings(args);
  const opened = useOpenedList(canRead && query.lane.read.kind === 'openedByViewer');
  const preview = usePreview(query.bodyId, canRead, can('audit.read'));
  const paged = usePaged(key);

  const go = (next: BodiesQuery, how?: { replace?: boolean }) =>
    void navigate({
      to: '.',
      search: searchFor(next) as never,
      ...(how?.replace === true && { replace: true }),
    });
  const bodyLink = (id: string): ReactElement => <Link to={bodyPath(id)} search={{ from }} />;

  // A body merged away (a stale link, or back from merging it) opens as its survivor: the URL moves
  // there, so every read in the preview — and the row the list marks — is the survivor's.
  const survivor = preview.survivor;
  // biome-ignore lint/correctness/useExhaustiveDependencies: moves once per survivor found, from the place it was found at.
  useEffect(() => {
    if (survivor !== null && survivor !== query.bodyId) {
      go({ ...query, bodyId: survivor }, { replace: true });
    }
  }, [survivor]);

  // A failed or retrying summary shows no count at all — never a zero, never the last one held.
  const counted = isFailed(summary.state) ? undefined : summary.held;
  const view: Omit<BodiesViewProps, 'list'> = {
    query,
    onQueryChange: go,
    laneCounts: {
      ...laneCountsFrom(counted, BODY_LANES),
      ...(opened?.list.status === 'done' && { [query.lane.id]: opened.list.total }),
    },
    corpus: counted?.corpus ?? null,
    preview: preview.data,
    onRetryPreview: preview.retry,
    previewPending: preview.pending,
    now,
    bodyLink,
    onOpenBody: (id) => void navigate({ to: bodyPath(id), search: { from } }),
    ...(openLabel !== undefined && { openLabel }),
    // Mounted whatever the counts' state, so its words are announced when they come; at the
    // lanes' foot, a block the one-line status bar would clip.
    countsNote: (
      <ReadNote
        data-slot="counts-error"
        className="shrink-0 border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3) empty:border-0 empty:p-0"
        reads={[summary.state]}
      >
        Counts couldn’t be read
      </ReadNote>
    ),
  };

  if (opened !== null) {
    return <BodiesView {...view} list={opened.list} onRetryList={opened.retry} />;
  }
  if (args === null) return <BodiesView {...view} list={UNREAD_LIST} />;
  return (
    <>
      <ReadBoundary
        resetKey={key}
        fallback={(retry) => <PagedFailed memoryKey={key} retry={retry} onFailed={paged.fail} />}
      >
        <PagedRead args={args} memoryKey={key} onPage={paged.put} />
      </ReadBoundary>
      <PagedView view={view} paged={paged} summary={summary} others={others} />
    </>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────

/** How many rows each list was showing, this tab (a list is its `listKey`). */
const shownMemory = new Map<string, number>();

/** Forget every list's row count (stories and tests start clean). */
export function resetShownMemory(): void {
  shownMemory.clear();
}

/**
 * The first page a list asks for: the library's page size, or as many rows as it was showing when
 * it was left — up to the library's most a first page may ask for.
 */
export function startingPageSize(memoryKey: string): number {
  return clampPageSize(Math.max(LIBRARY_PAGE_SIZE, shownMemory.get(memoryKey) ?? 0));
}

/** What the paginated read last handed up, for the list it was read for. */
type Page = {
  key: string;
  results: readonly LibraryRow[];
  status: PaginationStatus;
  loadMore: (n: number) => void;
};

type PagedState = {
  key: string;
  page: Page | null;
  /** The read failed for this list: its boundary's retry. */
  failure: (() => void) | null;
  /** Try again was pressed and the first page hasn't landed. */
  retrying: boolean;
  /** A page the reader read, or `null` when the reader is gone (failed, or another lane drawn). */
  put: (page: Page | null) => void;
  fail: (key: string, retry: () => void) => void;
  retry: () => void;
};

/** The paginated read's state, held by the page (the reader runs under the boundary). */
function usePaged(key: string): PagedState {
  const [page, setPage] = useState<Page | null>(null);
  const [failure, setFailure] = useState<{ key: string; retry: () => void } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const put = useRef((next: Page | null) => {
    // A reader that is gone leaves no page behind: a fresh reader starts on its first page, so a
    // retry holds as pending and a list drawn again never shows the rows of the reader before.
    setPage(next);
    if (next === null) return;
    // A reader that reads is answered: no failure stands — for its list, or for one left earlier,
    // which would otherwise come back with that list.
    setFailure(null);
    // The first page landed (or the read moved on): the retry is answered.
    setRetrying((r) => (r === next.key && next.status === 'LoadingFirstPage' ? r : null));
  }).current;
  const fail = useRef((failedKey: string, retry: () => void) => {
    setFailure({ key: failedKey, retry });
    // A failure after Try again is the fresh answer: no longer pending.
    setRetrying((r) => (r === failedKey ? null : r));
  }).current;
  const own = page !== null && page.key === key ? page : null;
  const failed = failure !== null && failure.key === key ? failure : null;
  return {
    key,
    page: own,
    failure: failed?.retry ?? null,
    retrying: retrying === key && (own === null || own.status === 'LoadingFirstPage'),
    put,
    fail,
    retry: () => {
      if (failed === null) return;
      setRetrying(key);
      setFailure(null);
      failed.retry();
    },
  };
}

/** The paginated read, under the boundary: it draws nothing, and hands each page up. */
function PagedRead({
  args,
  memoryKey,
  onPage,
}: {
  args: ListArgs;
  memoryKey: string;
  onPage: (page: Page | null) => void;
}): ReactNode {
  // Read once per list: the size only starts a list, and changing it mid-list would restart none.
  const initialNumItems = useMemo(() => startingPageSize(memoryKey), [memoryKey]);
  const { results, status, loadMore } = usePaginatedQuery(api.bodies.listPage, args, {
    initialNumItems,
  });
  useEffect(() => {
    if (results.length > 0) shownMemory.set(memoryKey, results.length);
  }, [memoryKey, results.length]);
  useEffect(() => {
    onPage({ key: memoryKey, results, status, loadMore });
  }, [onPage, memoryKey, results, status, loadMore]);
  // Gone (its read failed into the boundary, or another lane is drawn): its pages go with it.
  useEffect(() => () => onPage(null), [onPage]);
  return null;
}

/** The boundary's fallback: it draws nothing, and tells the page the read failed and how to retry. */
function PagedFailed({
  memoryKey,
  retry,
  onFailed,
}: {
  memoryKey: string;
  retry: () => void;
  onFailed: (key: string, retry: () => void) => void;
}): ReactNode {
  useEffect(() => {
    onFailed(memoryKey, retry);
  }, [onFailed, memoryKey, retry]);
  return null;
}

/** The list as the page draws it: its pages, its failure (held while retrying), or on its way. */
function PagedView({
  view,
  paged,
  summary,
  others,
}: {
  view: Omit<BodiesViewProps, 'list'>;
  paged: PagedState;
  summary: SummaryRead;
  others: OtherStandings | undefined;
}): ReactNode {
  const { page, failure, retrying } = paged;
  const { current, laneHeld } = summary;
  // Rows keep their identity between renders (a minute's tick, a row selected), so the table
  // rebuilds its model only when a page or the summary lands.
  const list = useMemo((): BodiesListData => {
    if (failure !== null || retrying) {
      return {
        ...UNREAD_LIST,
        status: 'error',
        retryPending: retrying,
        serves: servesFrom(current ?? laneHeld),
      };
    }
    return listFrom({
      rows: page?.results ?? [],
      status: page?.status ?? 'LoadingFirstPage',
      current,
      held: laneHeld,
      others,
    });
  }, [page, failure, retrying, current, laneHeld, others]);
  return (
    <BodiesView
      {...view}
      list={list}
      onLoadMore={() => page?.loadMore(LIBRARY_PAGE_SIZE)}
      onRetryList={paged.retry}
    />
  );
}

// ── The counts ───────────────────────────────────────────────────────────────────────────────

type SummaryRead = {
  /** The summary read's state for this query: on its way, failed (or retrying), or its value. */
  state: Loadable<ListSummary>;
  /** This query's summary; `undefined` while it loads, fails or retries. */
  current: ListSummary | undefined;
  /** The last summary that landed, for any query — the lanes' counts and the corpus. */
  held: ListSummary | undefined;
  /** The last summary that landed for this lane — its state tabs and what the read honors. */
  laneHeld: ListSummary | undefined;
};

function useSummary(args: ListArgs | null): SummaryRead {
  const summaryArgs = args === null ? null : (({ sort: _sort, ...rest }) => rest)(args);
  const { reads } = useConsoleReadSet({
    summary: summaryArgs === null ? null : read(api.bodies.listSummary, summaryArgs),
  });
  const state = reads.summary;
  const current = loaded(state);
  const held = useRef<{ lane: string; value: ListSummary } | undefined>(undefined);
  if (current !== undefined && args !== null) held.current = { lane: args.lane, value: current };
  const last = held.current;
  return {
    state,
    current,
    held: last?.value,
    laneHeld: last !== undefined && last.lane === args?.lane ? last.value : undefined,
  };
}

/**
 * A search's matches in the other standings (`bodies.searchOtherStandings`): read only for a search
 * in one standing's lane — *All* and *Changed* already hold every standing. `undefined` while it
 * loads, fails or there's no search: no group is drawn then, never an empty one.
 */
function useOtherStandings(args: ListArgs | null): OtherStandings | undefined {
  const asked =
    args !== null &&
    (args.q ?? '').trim().length >= 2 &&
    args.lane !== 'all' &&
    args.lane !== 'changed'
      ? (({ sort: _sort, ...rest }) => rest)(args)
      : null;
  const { reads } = useConsoleReadSet({
    others: asked === null ? null : read(api.bodies.searchOtherStandings, asked),
  });
  return asked === null ? undefined : loaded(reads.others);
}

/**
 * The minute a place was opened at, held while it stays open: the clock a list (or a preview) is
 * read against, so the clock moving on never restarts a read. A new `key` reads the clock again.
 */
function useClockFor(key: string): number {
  const [clock, setClock] = useState(() => ({ key, at: minute(Date.now()) }));
  if (clock.key !== key) {
    const next = { key, at: minute(Date.now()) };
    setClock(next);
    return next.at;
  }
  return clock.at;
}

const minute = (at: number) => Math.floor(at / 60_000) * 60_000;

// ── Opened recently ──────────────────────────────────────────────────────────────────────────

/**
 * The Opened recently lane: this browser's list, each body read by id. `null` while another lane is
 * on screen (and nothing is read). The reads are keyed on the ids' value, so a render with the same
 * list keeps its subscriptions.
 */
function useOpenedList(on: boolean): { list: BodiesListData; retry: () => void } | null {
  const ids = useOpenedBodies();
  // Through the read layer, keyed on the ids' value: Try again re-runs only the failed reads, and
  // a body the preview also reads is one read, retried once.
  const { reads, retry, pending } = useConsoleReadSet(
    Object.fromEntries(
      (on ? ids : []).map((id) => [
        id,
        read(api.waterBodies.get, { waterBodyId: id as Id<'waterBodies'> }),
      ]),
    ),
  );
  if (!on) return null;
  const list = listFromOpened(ids, reads as Record<string, Loadable<GetResult>>);
  return { list: list.status === 'error' ? { ...list, retryPending: pending } : list, retry };
}

// ── The preview ──────────────────────────────────────────────────────────────────────────────

/**
 * The open body's preview, through the read layer: `retry` re-runs the reads that failed, and
 * `pending` holds the notes as *Trying again…* until their fresh answers land.
 */
function usePreview(
  bodyId: string | null,
  canRead: boolean,
  canReadAudit: boolean,
): {
  data: BodyPreviewData | null | undefined | 'error' | 'unavailable';
  retry: () => void;
  pending: boolean;
  /** The body `bodyId` was merged into, which `waterBodies.get` serves in its place; else `null`. */
  survivor: string | null;
} {
  const id =
    canRead && bodyId !== null && ID_SHAPE.test(bodyId) ? (bodyId as Id<'waterBodies'>) : null;
  const now = useClockFor(id ?? '');
  const waterBodyId = id as Id<'waterBodies'>;
  const { reads, retry, pending } = useConsoleReadSet({
    body: id === null ? null : read(api.waterBodies.get, { waterBodyId }),
    putIns: id === null ? null : read(api.putIns.listForBody, { waterBodyId }),
    subAreas: id === null ? null : read(api.subAreas.listForBody, { waterBodyId }),
    facts: id === null ? null : read(api.bodies.preview, { waterBodyId, now }),
    history:
      id === null || !canReadAudit
        ? null
        : read(api.bodyConsole.history, { waterBodyId, limit: HISTORY_ROWS }),
  });
  if (id === null) return { data: null, retry, pending, survivor: null };
  const body = reads.body;
  // `waterBodies.get` follows a merge to the survivor; the other reads are of the id asked. The
  // pane never draws the one's outline over the other's facts: it holds while the place moves on.
  const survivor =
    body !== undefined && body !== null && !isFailed(body) && body.available && body.body._id !== id
      ? body.body._id
      : null;
  let data: BodyPreviewData | null | undefined | 'error' | 'unavailable';
  if (body === undefined || survivor !== null) data = undefined;
  else if (isFailed(body)) data = 'error';
  else if (body === null) data = null;
  // A rejected body isn't served whole; the page draws it from its list row.
  else if (!body.available) data = 'unavailable';
  else {
    data = previewFrom({
      body: body.body,
      // A failure is passed on, so the pane says so rather than drawing no put-ins as none.
      putIns: reads.putIns,
      subAreas: reads.subAreas,
      history: canReadAudit ? reads.history : null,
      facts: reads.facts,
      now,
    });
  }
  return { data, retry, pending, survivor };
}

/** How many of a body's latest changes the preview lists. */
const HISTORY_ROWS = 7;
