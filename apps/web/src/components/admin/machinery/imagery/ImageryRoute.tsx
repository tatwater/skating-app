import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  metricDay,
  metricDayStart,
  SENTINEL_LOWS_CAPABILITY,
  seasonStartYear,
} from '@skating/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';

import { useRole } from '@/lib/useRole';

import { useTickingNow } from '../../body/tabs/tabParts';
import { isFailed, type Loadable, loaded, read, useConsoleReadSet } from '../../reads/consoleReads';
import { joinChain, useJoinedPages } from '../../reads/joinChain';
import { useChainedPages } from '../../reads/useChainedPages';
import { lowsState } from '../../season/sentinelLowsModel';
import { useHeldRead, useMinuteNow } from '../../shell/presence';
import type { ImageryRunsTab, ImagerySearch } from '../imagerySearch';
import { useMachinerySidebar } from '../MachineryRoute';
import { LiveAttemptLog } from './AttemptLog';
import { GranuleDetail } from './GranuleDetail';
import { granuleRowModel } from './granuleRows';
import { ImageryActions } from './ImageryActions';
import { type GranuleDetailState, type ImageryPageState, ImageryView } from './ImageryView';
import {
  allListRows,
  type GranuleFilter,
  type GranulePage,
  type GranuleRead,
  type GranuleRowView,
  type ImageryPageRead,
  type ImageryPageView,
  imageryLaneTailFromPage,
  lowsFactsOf,
  pageShapeOf,
  type SentinelLowsRead,
  sentinelRows,
} from './imageryModel';
import { type ImageryWrites, useLiveImageryWrites } from './useImageryWrites';

/**
 * **Machinery › Imagery, wired** — the page `/admin/machinery/imagery` mounts, beside the sidebar the
 * layout hands it. Its place comes from the URL (`granule`, `attempt`, `runs`; validated by
 * `validateImagerySearch`); the filter is the page's own. Every read goes through the console's one
 * read layer.
 *
 * - **The page is read on the minute** (`machineryImagery.page`, held through the minute's turn and
 *   never past a failure); the crons' verdicts are re-read every second from the inputs it carries,
 *   by core's rule, so the lane and the cards turn late on the second they do.
 * - **The waiting page** reads the sentinels' lows (`sentinelLows.forSeason`) for the season, as the
 *   Overview does — only while waiting, and only for a viewer its capability admits.
 * - **The working page** reads the failed granules first (`failedFirst`, under *All*), the list's
 *   pages (`granules`, its cursor chain kept), and the open granule (`granule`).
 * - **Every change of place is a navigation**, so the back button, a reload and a shared link put
 *   the page back; opening a granule beside one already open replaces the entry.
 * - **Every read waits on `machinery.read`**; **the writes on `machinery.imagery`** — a viewer
 *   without it gets the page with no bar, no switch and no *Run now*.
 *
 * `writes` overrides the live writes (a test's own).
 */
export function ImageryRoute({ writes: writesOverride }: { writes?: ImageryWrites } = {}) {
  const navigate = useNavigate();
  const { can } = useRole();
  const canRead = can('machinery.read');
  const now = useMinuteNow();
  const tick = useTickingNow(TICK_MS);
  const search = useSearch({ strict: false }) as ImagerySearch;
  const granuleId = search.granule ?? null;
  const attempt = search.attempt ?? null;
  const runs = search.runs ?? null;
  const detailRef = useRef<HTMLElement | null>(null);
  const [filter, setFilter] = useState<GranuleFilter>('all');
  const liveWrites = useLiveImageryWrites();
  const writes = can('machinery.imagery') ? (writesOverride ?? liveWrites) : null;

  // ── The page ──
  const {
    reads: pageReads,
    retry: retryPage,
    pending: pagePending,
  } = useConsoleReadSet({ page: canRead ? read(api.machineryImagery.page, { now }) : null });
  const pageAsked = pageReads.page as Loadable<ImageryPageRead>;
  // Held through the minute's new subscription, so the page never falls back to loading as it turns;
  // never across a failure, nor once the season is gone.
  const answered = loaded(pageAsked);
  const held = useHeldRead(
    answered ?? undefined,
    !canRead || isFailed(pageAsked) || answered === null,
  );
  const view: ImageryPageView | null = held ?? null;
  const page: ImageryPageState = isFailed(pageAsked)
    ? { kind: 'failed', retry: retryPage, retrying: pagePending }
    : held !== undefined
      ? { kind: 'view', view: held }
      : answered === null
        ? { kind: 'none' }
        : { kind: 'loading' };
  const shape = view === null ? null : pageShapeOf(view.state);
  const sidebar = useMachinerySidebar(
    'imagery',
    view === null ? undefined : { imagery: imageryLaneTailFromPage(view) },
  );

  // ── The waiting page's lows ──
  const canLows = can(SENTINEL_LOWS_CAPABILITY);
  const { reads: lowsReads } = useConsoleReadSet({
    lows:
      canLows && shape === 'waiting' && view !== null
        ? read(api.sentinelLows.forSeason, {
            season: seasonStartYear(view.season),
            now: metricDayStart(metricDay(now)),
          })
        : null,
  });
  const lowsAsked = lowsReads.lows as Loadable<SentinelLowsRead>;
  const lowsValue = loaded(lowsAsked);

  // ── The list ──
  const working = canRead && shape === 'working';
  const chain = useChainedPages<GranulePage>(
    working ? filter : '',
    working
      ? (link) =>
          read(api.machineryImagery.granules, {
            filter,
            paginationOpts: {
              numItems: GRANULE_PAGE_SIZE,
              cursor: link.cursor,
              ...(link.end !== null && { endCursor: link.end }),
            },
          })
      : null,
  );
  const joined = useJoinedPages(working ? chain.pages : null, joinGranules);
  const { reads: failedReads, retry: retryFailedFirst } = useConsoleReadSet({
    failed: working && filter === 'all' ? read(api.machineryImagery.failedFirst, {}) : null,
  });
  const failedAsked = failedReads.failed as Loadable<GranuleRowView[]>;
  const failedRows = loaded(failedAsked);
  const listed =
    filter === 'all'
      ? allListRows(failedRows ?? [], joined.rows)
      : { failed: [], rest: joined.rows };

  // ── The open granule ──
  const {
    reads: granuleReads,
    retry: retryGranule,
    pending: granulePending,
  } = useConsoleReadSet({
    granule:
      canRead && granuleId !== null && shape === 'working'
        ? read(api.machineryImagery.granule, { id: granuleId as Id<'imageryGranules'> })
        : null,
  });
  const granuleAsked = granuleReads.granule as Loadable<GranuleRead>;
  const detail: GranuleDetailState =
    granuleId === null
      ? { kind: 'none' }
      : isFailed(granuleAsked)
        ? { kind: 'failed', retry: retryGranule, retrying: granulePending }
        : granuleAsked === undefined
          ? { kind: 'loading' }
          : granuleAsked === null
            ? { kind: 'missing' }
            : { kind: 'granule', view: granuleAsked };

  // ── Navigation ──
  const go = useCallback(
    (next: ImagerySearch, replace: boolean) =>
      void navigate({
        to: '/admin/machinery/imagery',
        search: next as never,
        ...(replace && { replace: true }),
      }),
    [navigate],
  );
  const placeOf = (patch: Partial<ImagerySearch>): ImagerySearch => {
    const next: ImagerySearch = { ...search, ...patch };
    for (const k of Object.keys(next) as (keyof ImagerySearch)[]) {
      if (next[k] === undefined) delete next[k];
    }
    return next;
  };

  const actions =
    view === null ? null : (
      <ImageryActions view={view} now={tick} writes={writes} pane={detailRef} />
    );

  return (
    <ImageryView
      sidebar={sidebar}
      page={page}
      now={tick}
      seasonsLink={<Link to="/admin/seasons" />}
      lows={lowsState(lowsAsked)}
      lowsFacts={lowsFactsOf(lowsValue)}
      sentinelRows={sentinelRows(lowsValue)}
      list={{
        filter,
        onFilter: setFilter,
        failed:
          filter === 'all'
            ? {
                rows: listed.failed.map((r) => granuleRowModel(r, tick)),
                status: isFailed(failedAsked)
                  ? 'error'
                  : failedRows === undefined
                    ? 'loading'
                    : 'done',
              }
            : null,
        rows: listed.rest.map((r) => granuleRowModel(r, tick)),
        status: joined.status,
        selectedId: granuleId,
        onOpen: (id, from) => {
          go(placeOf({ granule: id, attempt: undefined }), granuleId !== null);
          if (from === 'keys') detailRef.current?.focus();
        },
        onLoadMore: chain.loadMore,
        ...(joined.failed && { onRetry: chain.retry }),
        retryPending: chain.retrying,
        onRetryFailed: retryFailedFirst,
      }}
      detail={detail}
      granulePage={(g) => (
        <GranuleDetail
          view={g}
          now={tick}
          attempt={attempt}
          onAttempt={(n) => go(placeOf({ attempt: n }), true)}
          log={(a, failed) => <LiveAttemptLog attemptId={a.id} failed={failed} />}
          recordedFrom={view?.fly.countedFrom ?? null}
          actions={actions}
        />
      )}
      actions={actions}
      onClose={() => go(placeOf({ granule: undefined, attempt: undefined }), true)}
      runs={runs}
      onRuns={(tab: ImageryRunsTab | null) =>
        go(placeOf({ runs: tab ?? undefined }), runs !== null && tab !== null)
      }
      {...(writes !== null &&
        view !== null && {
          onRunNow: () => writes.pollNow(view.season),
          onStart: () => writes.start(view.season),
        })}
      detailRef={detailRef}
    />
  );
}

/** How often the crons' verdicts and the rows' ages are re-read. */
const TICK_MS = 1_000;

/** Granules a page: the read's own size (`GRANULES_PAGE_SIZE`). */
export const GRANULE_PAGE_SIZE = 25;

/** The chain's rows in order, each granule once. */
export function joinGranules(pages: readonly Loadable<GranulePage>[] | null) {
  return joinChain(
    pages,
    (page) => page.page,
    (row) => row.id,
  );
}
