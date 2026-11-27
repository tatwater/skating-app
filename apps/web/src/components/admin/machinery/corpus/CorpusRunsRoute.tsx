import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef } from 'react';

import { useRole } from '@/lib/useRole';

import { isFailed, type Loadable, loaded, read, useConsoleReadSet } from '../../reads/consoleReads';
import { type JoinedChain, joinChain, useJoinedPages } from '../../reads/joinChain';
import { useChainedPages } from '../../reads/useChainedPages';
import { useMinuteNow } from '../../shell/presence';
import { useMachinerySidebar } from '../MachineryRoute';
import {
  isOpen,
  type MachineryPlace,
  type MachinerySearch,
  placeOf,
  searchOf,
} from '../machinerySearch';
import type { CampaignRead, RunListPage, RunRead, RunRowView } from '../machineryTypes';
import { CorpusRunsView } from './CorpusRunsView';
import type { RunDetailState, RunPages } from './RunDetail';
import { withMonths } from './runRows';

/**
 * **Machinery › Corpus, wired** — the page `/admin/machinery/corpus` mounts, beside the sidebar the
 * layout hands it. Its place comes from the URL (`campaign`, `run`; validated by
 * `validateMachinerySearch`); the list and the open run come through the console's one read layer.
 *
 * - **The list is read on the minute**, its cursor chain kept: a run going late is a change in the
 *   clock, not in any row, so the clock moving on re-asks each page where it stands rather than
 *   holding a stale verdict (the server rounds and clamps it, `callerNow`).
 * - **A campaign row opens by its campaign id** (`?campaign=`, the URL `run-corpus.sh` prints);
 *   **a pass by its run id** (`?run=`). A `?run=` that names a campaign row (an audit feed's link to
 *   a marked campaign) opens the campaign page, read by its id.
 * - **Every change of place is a navigation**, so the back button, a reload and a shared link put
 *   the page back as it was; opening a run beside one already open replaces the entry.
 * - **Every read waits on `machinery.read`**; a viewer without it reads nothing.
 *
 * `pages` mounts the run pages (`CampaignView`, `RunView`); until then a read run shows its name.
 */
export function CorpusRunsRoute({ pages }: { pages?: RunPages } = {}) {
  const navigate = useNavigate();
  const { can } = useRole();
  const canRead = can('machinery.read');
  const now = useMinuteNow();
  const place = placeOf(useSearch({ strict: false }) as MachinerySearch);
  const sidebar = useMachinerySidebar('corpus');
  const detailRef = useRef<HTMLElement | null>(null);

  // ── The list ──
  const chain = useChainedPages<RunListPage>(
    canRead ? 'corpus' : '',
    canRead
      ? (link) =>
          read(api.machineryRuns.listPage, {
            lane: 'corpus',
            paginationOpts: {
              numItems: RUN_PAGE_SIZE,
              cursor: link.cursor,
              ...(link.end !== null && { endCursor: link.end }),
            },
            now,
          })
      : null,
  );
  const joined = useJoinedPages(canRead ? chain.pages : null, joinRuns);

  // ── The open run ──
  const target = detailTarget(place, joined.rows);
  const {
    reads: runReads,
    retry: retryRun,
    pending: runPending,
  } = useConsoleReadSet({
    run:
      canRead && target.run !== null
        ? read(api.machineryRuns.run, { runId: target.run as Id<'importRuns'>, now })
        : null,
  });
  const runValue = loaded(runReads.run as Loadable<RunRead>);
  const campaignBy = campaignArgs(place, target, runValue);
  const {
    reads: campaignReads,
    retry: retryCampaign,
    pending: campaignPending,
  } = useConsoleReadSet({
    campaign:
      canRead && campaignBy !== null
        ? read(api.machineryRuns.campaign, { ...campaignBy, now })
        : null,
  });

  const detail: RunDetailState =
    campaignBy !== null
      ? stateOf(
          campaignReads.campaign as Loadable<CampaignRead>,
          retryCampaign,
          campaignPending,
          (view) => ({
            kind: 'campaign',
            view,
          }),
        )
      : target.run !== null
        ? stateOf(runReads.run as Loadable<RunRead>, retryRun, runPending, (view) => ({
            kind: 'run',
            view,
          }))
        : { kind: 'none' };

  // ── Navigation ──
  const go = (next: MachineryPlace, replace: boolean) =>
    void navigate({
      to: '/admin/machinery/corpus',
      search: searchOf(next) as never,
      ...(replace && { replace: true }),
    });

  return (
    <CorpusRunsView
      sidebar={sidebar}
      list={{
        entries: withMonths(joined.rows, now),
        status: joined.status,
        indexed: joined.indexed,
        retryPending: chain.retrying,
      }}
      onLoadMore={chain.loadMore}
      {...(joined.failed && { onRetryList: chain.retry })}
      selectedId={selectedRow(place, joined.rows, runValue)}
      onOpen={(id, from) => {
        const row = joined.rows.find((r) => r.id === id);
        go(placeForRow(row, id), isOpen(place));
        if (from === 'keys') detailRef.current?.focus();
      }}
      onClose={() => go({ campaign: null, run: null }, true)}
      detail={detail}
      {...(pages !== undefined && { pages })}
      detailRef={detailRef}
    />
  );
}

/** Runs a page: the read's own size (`machineryRuns.listPage` lists 25 a page). */
export const RUN_PAGE_SIZE = 25;

type Joined = JoinedChain<RunListPage, RunRowView> & { indexed: boolean };

/** The chain's rows in order, each run once; indexed only while every page read says so. */
export function joinRuns(pages: readonly Loadable<RunListPage>[] | null): Joined {
  const joined = joinChain(
    pages,
    (page) => page.page,
    (row) => row.id,
  );
  return { ...joined, indexed: joined.read.every((p) => p.indexed) };
}

/** The place a row opens: a campaign by its campaign id, anything else by its run id. */
export function placeForRow(row: RunRowView | undefined, id: string): MachineryPlace {
  return row?.kind === 'campaign' && row.campaignId !== null
    ? { campaign: row.campaignId, run: null }
    : { campaign: null, run: id };
}

/** What the open place reads: a run by its id (unless the list already says it is a campaign). */
export function detailTarget(
  place: MachineryPlace,
  rows: readonly RunRowView[],
): { run: string | null; runIsCampaign: boolean } {
  if (place.run === null) return { run: null, runIsCampaign: false };
  const row = rows.find((r) => r.id === place.run);
  return row?.kind === 'campaign'
    ? { run: null, runIsCampaign: true }
    : { run: place.run, runIsCampaign: false };
}

/**
 * How the campaign page is read, or `null` for none: by the run's id when `?run=` names a campaign
 * row (the list says so, or the run read does), else by `?campaign=` when no run is open.
 */
export function campaignArgs(
  place: MachineryPlace,
  target: { runIsCampaign: boolean },
  run: RunRead | undefined,
): { runId: Id<'importRuns'> } | { campaignId: string } | null {
  if (place.run !== null) {
    const isCampaign = target.runIsCampaign || run?.doc.kind === 'corpus_campaign';
    return isCampaign ? { runId: place.run as Id<'importRuns'> } : null;
  }
  return place.campaign !== null ? { campaignId: place.campaign } : null;
}

/** A detail read's state: on its way, failed, not there, or its page. */
function stateOf<T>(
  value: Loadable<T | null>,
  retry: () => void,
  retrying: boolean,
  page: (view: T) => RunDetailState,
): RunDetailState {
  if (isFailed(value)) return { kind: 'failed', retry, retrying };
  if (value === undefined) return { kind: 'loading' };
  if (value === null) return { kind: 'missing' };
  return page(value);
}

/**
 * The list's open row: the run's own row; for a pass open under its campaign, the campaign's row;
 * for a campaign open by its id, its row.
 */
export function selectedRow(
  place: MachineryPlace,
  rows: readonly RunRowView[],
  run: RunRead | undefined,
): string | null {
  if (place.run !== null) {
    if (rows.some((r) => r.id === place.run)) return place.run;
    const parent = run?.parent?.id;
    if (parent !== undefined && rows.some((r) => r.id === parent)) return parent;
  }
  if (place.campaign !== null) {
    return rows.find((r) => r.kind === 'campaign' && r.campaignId === place.campaign)?.id ?? null;
  }
  return null;
}
