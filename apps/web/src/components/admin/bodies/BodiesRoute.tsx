import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { clampPageSize, LIBRARY_PAGE_SIZE } from '@skating/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { usePaginatedQuery, useQueries } from 'convex/react';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useRole } from '@/lib/useRole';

import { useMinuteNow } from '../shell/presence';
import { BodiesView, type BodiesViewProps } from './BodiesView';
import { type BodiesListData, type BodyPreviewData, UNREAD_LIST } from './bodiesData';
import {
  type BodyDoc,
  type BodyHistory,
  type ListArgs,
  type ListSummary,
  laneCountsFrom,
  listArgsOf,
  listFrom,
  type PreviewFacts,
  type PutIns,
  previewFrom,
  type SubAreas,
  servesFrom,
} from './bodiesReads';
import { type BodiesQuery, type BodiesSearch, listKey, queryOf, searchFor } from './bodiesSearch';
import { BODY_LANES } from './bodyLanes';
import { ReadBoundary } from './ReadBoundary';
import { TryAgain } from './TryAgain';

/**
 * The Bodies library, wired: its place from the URL (validated by `validateBodiesSearch`, which the
 * route file adopts as its `validateSearch`), the library's server reads (`bodiesReads` maps them),
 * the clock, and the link to a body's console. The page itself is `BodiesView`, props only.
 *
 * - **The list** is `bodies.listPage` through the paginated hook, starting at the library's page
 *   size — or, coming back to a list, as many rows as were showing (up to the library's most), so
 *   the remembered scroll lands where it was. A failed page is the list's own error state.
 * - **The counts** are `bodies.listSummary`. The lanes' counts are held through a change of place
 *   (they don't move with a filter); the list's total and the facet counts are only ever this
 *   query's, so a count is never a stale one. A lane no server read lists (Opened recently) reads
 *   All's summary for them, so the rail is counted whichever lane the page opens on.
 * - **The preview** reads the open body and its facts; the body, its facts and its history each say
 *   so in their block when their read fails. A failed put-ins or bays read is drawn as not recorded
 *   (no dots, no figure), never as a zero.
 *
 * The list and its counts are read against the **list's clock**: the minute the list was opened,
 * held while it stays open, so a new minute never restarts the paging. Every read waits on
 * `body.read`; a viewer without it sees *Not recorded yet*.
 *
 * Every change of place is a navigation to the same route with the new search, so the back button,
 * a reload and a return from the Body console put the list back as it was. Moving down the list
 * replaces the entry rather than stacking one per row.
 */

/** Where a body's console is. Default: the Body console's route. */
export const BODY_CONSOLE_PATH = (id: string) => `/admin/body/${id}`;

/** A Convex id's shape, so a hand-edited `?body=` never reaches a query as junk. */
const ID_SHAPE = /^[0-9a-z]{30,34}$/;

export type BodiesRouteProps = {
  /** Where a body's console is (the Body console's route). */
  bodyPath?: (id: string) => string;
};

export function BodiesRoute({ bodyPath = BODY_CONSOLE_PATH }: BodiesRouteProps) {
  const search = useSearch({ strict: false }) as BodiesSearch;
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  const query = queryOf(search);
  const key = listKey(query);
  const listNow = useClockFor(key);
  const canRead = can('body.read');
  const args = canRead ? listArgsOf(query, listNow) : null;
  // A lane no server read lists (Opened recently) still counts the others: All's summary.
  const summary = useSummary(canRead ? (args ?? { lane: 'all', now: listNow }) : null);
  const preview = usePreview(query.bodyId, canRead, can('audit.read'));
  // A failed list is tried again by a new attempt: the boundary resets and the list subscribes anew.
  const [attempt, setAttempt] = useState(0);

  const go = (next: BodiesQuery, how?: { replace?: boolean }) =>
    void navigate({
      to: '.',
      search: searchFor(next) as never,
      ...(how?.replace === true && { replace: true }),
    });
  const bodyLink = (id: string): ReactElement => <Link to={bodyPath(id)} />;

  const view: Omit<BodiesViewProps, 'list'> = {
    query,
    onQueryChange: go,
    laneCounts: laneCountsFrom(summary.held, BODY_LANES),
    corpus: summary.held?.corpus ?? null,
    preview: preview.data,
    onRetryPreview: preview.retry,
    now,
    bodyLink,
    onOpenBody: (id) => void navigate({ to: bodyPath(id) }),
    status: summary.failed
      ? [
          <span key="counts" data-slot="counts-error" className="flex items-center gap-(--space-2)">
            Counts couldn’t be read
            <TryAgain onRetry={summary.retry} />
          </span>,
        ]
      : [],
  };

  if (args === null) return <BodiesView {...view} list={UNREAD_LIST} />;
  const failedList: BodiesListData = {
    ...UNREAD_LIST,
    status: 'error',
    serves: servesFrom(summary.current ?? summary.laneHeld),
  };
  return (
    <ReadBoundary
      resetKey={`${key}#${attempt}`}
      fallback={
        <BodiesView {...view} list={failedList} onRetryList={() => setAttempt((n) => n + 1)} />
      }
    >
      <PagedList args={args} memoryKey={key} summary={summary} view={view} />
    </ReadBoundary>
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

function PagedList({
  args,
  memoryKey,
  summary,
  view,
}: {
  args: ListArgs;
  memoryKey: string;
  summary: SummaryRead;
  view: Omit<BodiesViewProps, 'list'>;
}): ReactNode {
  // Read once per list: the size only starts a list, and changing it mid-list would restart none.
  const initialNumItems = useMemo(() => startingPageSize(memoryKey), [memoryKey]);
  const { results, status, loadMore } = usePaginatedQuery(api.bodies.listPage, args, {
    initialNumItems,
  });
  useEffect(() => {
    if (results.length > 0) shownMemory.set(memoryKey, results.length);
  }, [memoryKey, results.length]);
  // Rows keep their identity between renders (a minute's tick, a row selected), so the table
  // rebuilds its model only when a page or the summary lands.
  const { current, laneHeld } = summary;
  const list = useMemo(
    () => listFrom({ rows: results, status, current, held: laneHeld }),
    [results, status, current, laneHeld],
  );
  return <BodiesView {...view} list={list} onLoadMore={() => loadMore(LIBRARY_PAGE_SIZE)} />;
}

// ── The counts ───────────────────────────────────────────────────────────────────────────────

type SummaryRead = {
  /** This query's summary; `undefined` while it loads or if it failed. */
  current: ListSummary | undefined;
  /** The last summary that landed, for any query — the lanes' counts and the corpus. */
  held: ListSummary | undefined;
  /** The last summary that landed for this lane — its state tabs and what the read honors. */
  laneHeld: ListSummary | undefined;
  failed: boolean;
  /** Re-runs a failed summary. */
  retry: () => void;
};

const NOTHING_PAUSED: ReadonlySet<string> = new Set();

/**
 * Reads to try again: `retry(keys)` drops those reads' subscriptions for one render and takes them
 * up again, so the server runs them anew. Until it answers, Convex's client still holds the failure
 * it had, so the read reads as failed until its new answer lands. A read another component also
 * subscribes to (the same query and arguments) keeps its server subscription, and isn't run anew.
 */
function useRetry(): { paused: ReadonlySet<string>; retry: (keys: Iterable<string>) => void } {
  const [paused, setPaused] = useState(NOTHING_PAUSED);
  useEffect(() => {
    if (paused.size > 0) setPaused(NOTHING_PAUSED);
  }, [paused]);
  const retry = useCallback((keys: Iterable<string>) => setPaused(new Set(keys)), []);
  return { paused, retry };
}

function useSummary(args: ListArgs | null): SummaryRead {
  const { paused, retry } = useRetry();
  const summaryArgs = args === null ? null : (({ sort: _sort, ...rest }) => rest)(args);
  const json = JSON.stringify(summaryArgs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the arguments' value.
  const queries = useMemo(() => {
    const out: Parameters<typeof useQueries>[0] = {};
    if (summaryArgs !== null && !paused.has('summary')) {
      out.summary = { query: api.bodies.listSummary, args: summaryArgs };
    }
    return out;
  }, [json, paused]);
  const got = useQueries(queries).summary as ListSummary | undefined | Error;
  const current = got instanceof Error ? undefined : got;
  const held = useRef<{ lane: string; value: ListSummary } | undefined>(undefined);
  if (current !== undefined && args !== null) held.current = { lane: args.lane, value: current };
  const last = held.current;
  return {
    current,
    held: last?.value,
    laneHeld: last !== undefined && last.lane === args?.lane ? last.value : undefined,
    failed: got instanceof Error,
    retry: () => retry(['summary']),
  };
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

// ── The preview ──────────────────────────────────────────────────────────────────────────────

type GetRead = { available: true; body: BodyDoc } | { available: false } | null;

type PreviewReads = {
  body?: GetRead | Error;
  putIns?: PutIns | Error;
  subAreas?: SubAreas | Error;
  facts?: PreviewFacts | null | Error;
  history?: BodyHistory | Error;
};

/** The open body's preview, from its reads; `retry` re-runs only the reads that failed. */
function usePreview(
  bodyId: string | null,
  canRead: boolean,
  canReadAudit: boolean,
): { data: BodyPreviewData | null | undefined | 'error' | 'unavailable'; retry: () => void } {
  const { paused, retry } = useRetry();
  const id =
    canRead && bodyId !== null && ID_SHAPE.test(bodyId) ? (bodyId as Id<'waterBodies'>) : null;
  const now = useClockFor(id ?? '');
  const queries = useMemo<Parameters<typeof useQueries>[0]>(() => {
    if (id === null) return {};
    const waterBodyId = id;
    const reads: Parameters<typeof useQueries>[0] = {
      body: { query: api.waterBodies.get, args: { waterBodyId } },
      putIns: { query: api.putIns.listForBody, args: { waterBodyId } },
      subAreas: { query: api.subAreas.listForBody, args: { waterBodyId } },
      facts: { query: api.bodies.preview, args: { waterBodyId, now } },
      ...(canReadAudit && {
        history: { query: api.bodyConsole.history, args: { waterBodyId, limit: HISTORY_ROWS } },
      }),
    };
    return Object.fromEntries(Object.entries(reads).filter(([key]) => !paused.has(key)));
  }, [id, now, canReadAudit, paused]);
  const got = useQueries(queries) as PreviewReads;
  const failed = Object.entries(got).flatMap(([key, r]) => (r instanceof Error ? [key] : []));
  return { data: previewOf(id, got, canReadAudit, now), retry: () => retry(failed) };
}

function previewOf(
  id: Id<'waterBodies'> | null,
  got: PreviewReads,
  canReadAudit: boolean,
  now: number,
): BodyPreviewData | null | undefined | 'error' | 'unavailable' {
  if (id === null) return null;
  const body = got.body;
  if (body === undefined) return undefined;
  if (body instanceof Error) return 'error';
  if (body === null) return null;
  // A rejected body isn't served whole; the page draws it from its list row.
  if (!body.available) return 'unavailable';
  const quiet = <T,>(r: T | Error | undefined) => (r instanceof Error ? undefined : r);
  return previewFrom({
    body: body.body,
    putIns: quiet(got.putIns),
    subAreas: quiet(got.subAreas),
    history: canReadAudit ? got.history : null,
    facts: got.facts,
    now,
  });
}

/** How many of a body's latest changes the preview lists. */
const HISTORY_ROWS = 7;
