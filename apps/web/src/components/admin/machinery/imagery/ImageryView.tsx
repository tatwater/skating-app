import { type ReactElement, type ReactNode, type RefObject, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { InspectorProvider } from '../../inspector/inspectorContext';
import type { LowsState } from '../../season/sentinelLowsModel';
import { useColumnsFit, usePaneFocus } from '../../shell/columnsFit';
import type { ImageryRunsTab } from '../imagerySearch';
import { CronRunsDrawer } from './crons';
import { GranuleList, type GranuleListProps } from './GranuleList';
import { ImageryHead } from './ImageryHead';
import type { GranuleView, ImageryPageView, LowsFacts, SentinelRow } from './imageryModel';
import { pageShapeOf, type RunNowProp, runNowOf } from './imageryModel';
import * as W from './imageryWords';
import { WaitingView } from './WaitingView';

/**
 * **Machinery › Imagery** (boards 6.4, *Waiting for Cold*, *Line Crossed*) as the console mounts it,
 * from what the route hands it. The lanes (Machinery's sidebar, `sidebar`) run the page's height;
 * beside them the head (the page word, the five stats, the three cron cards) spans the rest, and
 * under it:
 *
 * - **working** (running, paused, ended): **the granule list** (360, the board's) and **the
 *   granule's detail**, the season's floating bar at the detail's foot;
 * - **waiting** (not started, no watch): **the sentinels** and **the start panel**.
 *
 * A cron card's *Runs* opens W2's runs drawer on its tab (`runs`, from the URL).
 *
 * - **Keys.** Tab moves between the columns; ↑↓ within the list; ⏎ or Space opens a granule and
 *   moves focus into the detail; ⇧⏎ (or Esc) in the detail goes back to the list.
 * - **The narrow rule** (`useColumnsFit`, the console's one): below the columns' summed widths an
 *   open granule takes the page with *Back to the list*, and with none open the lanes sit over the
 *   list; the waiting page stacks its start panel under the sentinels. Nothing scrolls sideways.
 */

export type ImageryPageState =
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; retrying: boolean }
  | { kind: 'none' }
  | { kind: 'view'; view: ImageryPageView };

export type GranuleDetailState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; retrying: boolean }
  | { kind: 'missing' }
  | { kind: 'granule'; view: GranuleView };

export type ImageryViewProps = {
  sidebar: ReactNode;
  page: ImageryPageState;
  now: number;
  timeZone?: string;
  /** The router's link to Seasons. */
  seasonsLink: ReactElement;
  /** The waiting page's sentinels. */
  lows: LowsState;
  lowsFacts: LowsFacts | null;
  sentinelRows: readonly SentinelRow[];
  /** The working page's list (its filter, its rows, its reads' state). */
  list: Omit<GranuleListProps, 'paused' | 'listRef' | 'className'>;
  detail: GranuleDetailState;
  /** The open granule's page (the route's `GranuleDetail` with its live log and the bar). */
  granulePage: (view: GranuleView) => ReactNode;
  /** The season's floating bar, drawn in the detail column when no granule is open. */
  actions?: ReactNode;
  onClose?: () => void;
  /** The runs drawer's tab, from the URL. */
  runs: ImageryRunsTab | null;
  onRuns: (tab: ImageryRunsTab | null) => void;
  /** *Run now* on the poll; absent when the viewer can't write. */
  onRunNow?: () => Promise<boolean>;
  /** *Start imagery*; absent when the viewer can't write. */
  onStart?: () => Promise<boolean>;
  detailRef?: RefObject<HTMLElement | null>;
  className?: string;
};

/** The working page's columns: below their sum, one pane at a time. */
const WORKING = ['--size-lanes', '--size-list', '--size-inspector'] as const;
/** The waiting page's: the lanes, the sentinels' room, the start panel. */
const WAITING = ['--size-lanes', '--size-inspector', '--size-sheet-sm'] as const;

export function ImageryView({
  sidebar,
  page,
  now,
  timeZone,
  seasonsLink,
  lows,
  lowsFacts,
  sentinelRows,
  list,
  detail,
  granulePage,
  actions,
  onClose,
  runs,
  onRuns,
  onRunNow,
  onStart,
  detailRef,
  className,
}: ImageryViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const ownDetail = useRef<HTMLElement | null>(null);
  const pane = detailRef ?? ownDetail;
  const listBox = useRef<HTMLDivElement>(null);
  const view = page.kind === 'view' ? page.view : null;
  const shape = view === null ? 'working' : pageShapeOf(view.state);
  const narrow = !useColumnsFit(root, shape === 'waiting' ? WAITING : WORKING);
  const open = shape === 'working' && detail.kind !== 'none';
  const shown = !narrow ? 'all' : open ? 'detail' : 'list';
  const focusList = () => listBox.current?.focus();
  const panes = usePaneFocus({ page: root, shown, open, focusList, detailPane: 'detail' });
  const backToList = () => {
    if (narrow && onClose !== undefined) {
      panes.askBack();
      onClose();
      return;
    }
    focusList();
  };
  const runNow: RunNowProp | undefined =
    onRunNow === undefined || view === null ? undefined : runNowOf(view.state, onRunNow);

  return (
    <div
      ref={root}
      data-slot="machinery-imagery-page"
      data-shape={shape}
      data-narrow={narrow ? '' : undefined}
      {...panes.pageProps}
      className={cn(
        'h-full min-h-0 [--size-list:22.5rem]',
        narrow
          ? 'flex flex-col overflow-x-hidden overflow-y-auto'
          : 'grid grid-cols-[var(--size-lanes)_minmax(0,1fr)]',
        className,
      )}
    >
      <section
        data-pane="lanes"
        aria-label="Lanes"
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
          narrow ? cn('shrink-0 border-b', open && 'hidden') : 'border-r',
        )}
      >
        {sidebar}
      </section>

      <div className={cn('flex min-h-0 min-w-0 flex-col', narrow && 'flex-1')}>
        {page.kind !== 'view' ? (
          <PageFrame page={page} />
        ) : (
          <>
            <ImageryHead
              view={page.view}
              lows={lowsFacts}
              now={now}
              {...(timeZone !== undefined && { timeZone })}
              seasonsLink={seasonsLink}
              onOpenRuns={(tab) => onRuns(tab)}
              {...(onRunNow !== undefined && { onRunNow })}
              narrow={narrow}
              className={cn(narrow && open && 'hidden')}
            />
            {shape === 'waiting' ? (
              <WaitingView
                view={page.view}
                lows={lows}
                rows={sentinelRows}
                facts={lowsFacts}
                now={now}
                {...(timeZone !== undefined && { timeZone })}
                {...(onStart !== undefined && { onStart })}
                pane={pane}
                narrow={narrow}
              />
            ) : (
              <div
                className={cn(
                  'min-h-0 min-w-0 flex-1',
                  narrow ? 'flex flex-col' : 'grid grid-cols-[var(--size-list)_minmax(0,1fr)]',
                )}
              >
                <section
                  data-pane="middle"
                  aria-label={W.LIST_LABEL}
                  className={cn(
                    'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
                    narrow ? cn('flex-1', open && 'hidden') : 'border-r',
                  )}
                >
                  <GranuleList {...list} paused={narrow && open} listRef={listBox} />
                </section>
                <section
                  ref={pane as RefObject<HTMLElement>}
                  data-pane="detail"
                  aria-label={W.DETAIL_LABEL}
                  tabIndex={-1}
                  onKeyDown={(event) => {
                    const back =
                      !event.repeat &&
                      (event.key === 'Escape' || (event.key === 'Enter' && event.shiftKey));
                    if (
                      !back ||
                      event.defaultPrevented ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.altKey ||
                      !event.currentTarget.contains(event.target as Node) ||
                      isTextEntry(event.target as Element)
                    ) {
                      return;
                    }
                    event.preventDefault();
                    backToList();
                  }}
                  className={cn(
                    'relative flex min-h-0 min-w-0 flex-col overflow-hidden outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
                    shown === 'detail' ? 'flex-1' : shown === 'list' && 'hidden',
                  )}
                >
                  {narrow && open && onClose !== undefined && (
                    <div className="flex shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-2)">
                      <Button size="xs" onClick={backToList}>
                        {W.BACK_TO_LIST}
                      </Button>
                    </div>
                  )}
                  <InspectorProvider value={{ pane, decidedOnOpen: false, now, timeZone, narrow }}>
                    {detail.kind === 'granule' ? (
                      granulePage(detail.view)
                    ) : (
                      <>
                        <DetailFrame detail={detail} />
                        {actions}
                      </>
                    )}
                  </InspectorProvider>
                </section>
              </div>
            )}
          </>
        )}
      </div>
      {view !== null && runs !== null && (
        <CronRunsDrawer
          crons={view.crons}
          tab={runs}
          open
          onClose={() => onRuns(null)}
          onTab={(tab) => onRuns(tab)}
          {...(timeZone !== undefined && { timeZone })}
          {...(runNow !== undefined && { runNow })}
        />
      )}
    </div>
  );
}

/** The page before its read lands, when it failed, or with no season to show. */
function PageFrame({ page }: { page: Exclude<ImageryPageState, { kind: 'view' }> }) {
  switch (page.kind) {
    case 'loading':
      return (
        <div
          data-slot="imagery-loading"
          aria-busy="true"
          className="flex flex-col gap-(--space-3) px-gutter pt-(--space-4)"
        >
          <SkeletonText className="text-disp" width="20%" />
          <SkeletonText className="text-body" width="60%" />
        </div>
      );
    case 'failed':
      return (
        <RetryNote
          data-slot="imagery-error"
          className="px-gutter pt-(--space-4)"
          onRetry={page.retry}
          pending={page.retrying}
        >
          {W.PAGE_FAILED}
        </RetryNote>
      );
    case 'none':
      return (
        <div
          data-slot="imagery-none"
          className="flex flex-col gap-(--space-2) px-gutter pt-(--space-7)"
        >
          <h1 className="m-0 text-disp leading-none font-semibold tracking-disp text-fg uppercase">
            {W.IMAGERY}
          </h1>
          <p className="m-0 pt-(--space-3) text-body leading-body font-medium text-fg1">
            {W.NO_SEASON}
          </p>
          <p className="m-0 text-assist leading-list text-fg3">{W.NO_SEASON_HINT}</p>
        </div>
      );
  }
}

/** The detail column with no granule drawn: nothing open, on its way, failed, or gone. */
function DetailFrame({ detail }: { detail: Exclude<GranuleDetailState, { kind: 'granule' }> }) {
  switch (detail.kind) {
    case 'none':
      return (
        <div
          data-slot="granule-none"
          className="flex flex-col gap-(--space-2) px-gutter pt-(--space-7)"
        >
          <p className="m-0 text-body leading-body font-medium text-fg1">{W.NOTHING_OPEN}</p>
          <p className="m-0 text-assist leading-list text-fg3">{W.NOTHING_OPEN_HINT}</p>
        </div>
      );
    case 'loading':
      return (
        <div
          data-slot="granule-loading"
          aria-busy="true"
          className="flex flex-col gap-(--space-3) px-gutter pt-(--space-4)"
        >
          <SkeletonText className="text-disp" width="40%" />
          <SkeletonText className="text-body" width="70%" />
        </div>
      );
    case 'failed':
      return (
        <RetryNote
          data-slot="granule-error"
          className="px-gutter pt-(--space-4)"
          onRetry={detail.retry}
          pending={detail.retrying}
        >
          {W.GRANULE_FAILED}
        </RetryNote>
      );
    case 'missing':
      return (
        <div className="px-gutter pt-(--space-4)">
          <Note data-slot="granule-missing">{W.GRANULE_MISSING}</Note>
        </div>
      );
  }
}
