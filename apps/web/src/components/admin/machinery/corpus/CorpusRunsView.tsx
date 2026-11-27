import { type ReactNode, type RefObject, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import type { ChainStatus } from '../../reads/joinChain';
import { useColumnsFit, usePaneFocus } from '../../shell/columnsFit';
import {
  BACK_TO_LIST,
  CORPUS,
  DETAIL_LABEL,
  LIST_KICKER,
  LIST_LABEL,
} from '../words/machineryWords';
import { RunDetail, type RunDetailState, type RunPages } from './RunDetail';
import { RunList } from './RunList';
import type { RunListEntry } from './runRows';

/**
 * **Machinery › Corpus** (board 6.2) as the console mounts it, from what the route hands it — three
 * columns: **the lanes** (Machinery's sidebar, `sidebar`), **the run list** (*Corpus · Runs · newest
 * first*, month dividers, the list end) and **the detail** (the open campaign or run, or nothing
 * open). The route (`CorpusRunsRoute`) wires it to the router and Convex; a story draws the same page.
 *
 * - **Keys.** Tab moves between the columns; ↑↓ within the list, typing jumps; ⏎ or Space opens a
 *   run and moves focus into the detail. ⇧⏎ (or Esc) in the detail goes back to the list.
 * - **The narrow rule** (`useColumnsFit`, the console's one): below the three columns' summed widths
 *   the open run takes the page with *Back to the list*, and with none open the lanes sit over the
 *   list. Nothing scrolls sideways.
 */

export type CorpusRunsViewProps = {
  sidebar: ReactNode;
  list: {
    entries: readonly RunListEntry[];
    status: ChainStatus;
    indexed: boolean;
    retryPending?: boolean;
  };
  onLoadMore?: () => void;
  onRetryList?: () => void;
  /** The list row open in the detail (a campaign's row while one of its passes is open). */
  selectedId: string | null;
  onOpen: (id: string, from: 'keys' | 'press') => void;
  /** Close the open run (back to the list). */
  onClose?: () => void;
  detail: RunDetailState;
  /** The run pages, as the integrator mounts them; a stand-in head without. */
  pages?: RunPages;
  /** The detail column, for the route to move focus into when a run opens. */
  detailRef?: RefObject<HTMLElement | null>;
  className?: string;
};

/** The three columns' width tokens: below their sum, one pane at a time. */
const COLUMNS = ['--size-lanes', '--size-list', '--size-inspector'] as const;

export function CorpusRunsView({
  sidebar,
  list,
  onLoadMore,
  onRetryList,
  selectedId,
  onOpen,
  onClose,
  detail,
  pages,
  detailRef,
  className,
}: CorpusRunsViewProps) {
  const page = useRef<HTMLDivElement>(null);
  const ownDetail = useRef<HTMLElement | null>(null);
  const pane = detailRef ?? ownDetail;
  const listBox = useRef<HTMLDivElement>(null);
  const narrow = !useColumnsFit(page, COLUMNS);
  const open = detail.kind !== 'none';
  const shown = !narrow ? 'all' : open ? 'detail' : 'list';
  const focusList = () => listBox.current?.focus();
  const panes = usePaneFocus({ page, shown, open, focusList, detailPane: 'detail' });
  const backToList = () => {
    if (narrow && onClose !== undefined) {
      panes.askBack();
      onClose();
      return;
    }
    focusList();
  };

  return (
    <div
      ref={page}
      data-slot="machinery-corpus-page"
      data-narrow={narrow ? '' : undefined}
      {...panes.pageProps}
      className={cn(
        // The lanes keep the console's 236; the list is the board's 310; the detail takes the rest.
        // Set on the page, as Corpus sets its own, so the narrow rule measures the same.
        'h-full min-h-0 [--size-list:19.375rem]',
        narrow
          ? 'flex flex-col overflow-x-hidden'
          : 'grid grid-cols-[var(--size-lanes)_var(--size-list)_minmax(0,1fr)]',
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

      <section
        data-pane="middle"
        aria-label={LIST_LABEL}
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
          narrow ? cn('flex-1', open && 'hidden') : 'border-r',
        )}
      >
        <div
          data-slot="runs-head"
          className="flex min-w-0 shrink-0 items-end gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-4) pb-(--space-3)"
        >
          <h1
            data-slot="page-word"
            className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
          >
            {CORPUS}
          </h1>
          <span
            data-slot="runs-kicker"
            className="min-w-0 truncate pb-(--space-0_5) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
          >
            {LIST_KICKER}
          </span>
        </div>
        <RunList
          label={LIST_LABEL}
          entries={list.entries}
          status={list.status}
          indexed={list.indexed}
          selectedId={selectedId}
          onOpen={onOpen}
          paused={narrow && open}
          listRef={listBox}
          {...(list.retryPending !== undefined && { retryPending: list.retryPending })}
          {...(onLoadMore !== undefined && { onLoadMore })}
          {...(onRetryList !== undefined && { onRetry: onRetryList })}
        />
      </section>

      <section
        ref={pane as RefObject<HTMLElement>}
        data-pane="detail"
        aria-label={DETAIL_LABEL}
        tabIndex={-1}
        onKeyDown={(event) => {
          // ⇧⏎ or Esc in the detail goes back to the list — never from a field, never from a
          // dialog, never a key already used.
          const back =
            !event.repeat && (event.key === 'Escape' || (event.key === 'Enter' && event.shiftKey));
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
          'relative flex min-h-0 min-w-0 flex-col outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
          shown === 'detail' ? 'flex-1' : shown === 'list' && 'hidden',
        )}
      >
        {narrow && open && onClose !== undefined && (
          <div
            data-slot="runs-back"
            className="flex shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-2)"
          >
            <Button size="xs" onClick={backToList}>
              {BACK_TO_LIST}
            </Button>
          </div>
        )}
        {/* A run page lays out its own head, scroll and action bar in this column. */}
        <RunDetail state={detail} {...(pages !== undefined && { pages })} />
      </section>
    </div>
  );
}
