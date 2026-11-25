import type { CorpusTaskLane } from '@skating/core';
import { type ReactElement, type ReactNode, type RefObject, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { useColumnsFit, usePaneFocus } from '../shell/columnsFit';
import type { CorpusLanesView } from './corpusTypes';
import { CorpusInspector, type CorpusInspectorState } from './inspector/CorpusInspector';
import type { CorpusHandler } from './inspector/handlerRegistry';
import { TaskSearch } from './list/TaskSearch';
import { type TaskListData, TaskTable, type TaskTail } from './list/TaskTable';
import { DECIDED_TAB, type TaskQuery, type TaskTab } from './taskSearch';
import {
  BACK_TO_LIST,
  bodiesCount,
  DECIDED_THIS_WEEK,
  INSPECTOR_LABEL,
  LANE_WHAT,
  LIST_LABEL,
  LIST_PENDING,
  NOTHING_DECIDED,
  NOTHING_MATCHES,
  NOTHING_OPEN,
  SEARCH_HINT,
  TAB_ALL,
} from './words/corpusWords';

/**
 * **A Corpus task lane** (boards 4.2, 4.3) as the console mounts it, from what the route hands it —
 * three columns: **the lanes** (the one Corpus sidebar, `sidebar`, the same column the library
 * mounts), **the list** (the lane's page word and count, the line the board says under it, the
 * search, the tabs, then the table with its decided tail) and **the inspector** (the open task,
 * drawn by its lane's handler from the registry, or the placeholder). The route
 * (`CorpusTaskRoute`) wires it to the router and Convex; a story draws the same page.
 *
 * - **Keys.** Tab moves between the columns, ↑↓ within one, typing jumps in the list, / goes to
 *   the search from anywhere in the list's column but a field. ⏎ or Space on a row opens it and
 *   moves focus into the inspector, where the handler's single-letter keys act — only there. ⇧⏎
 *   (or Esc) in the inspector goes back to the list.
 * - **The narrow rule** (`useColumnsFit`, the console's one): below the three columns' summed widths
 *   the open task takes the page with *Back to the list*, and with none open the lanes sit over the
 *   list.
 *
 * Nothing here is a fixture: a count no read gives is absent, a read not ready says so, a failed one
 * says so, and the server's order is the order drawn.
 */

export type CorpusTaskViewProps = {
  /** The Corpus sidebar (`useCorpusSidebar`), mounted by both views. */
  sidebar: ReactNode;
  query: TaskQuery;
  /** A change of place: another tab, a search. */
  onQueryChange: (next: TaskQuery) => void;
  /** The lanes read's answer (held through a change of list), or none yet. */
  lanes: CorpusLanesView | undefined;
  list: TaskListData;
  onLoadMore?: () => void;
  onRetryList?: () => void;
  /** The lane's newest decisions, under its open list. */
  tail?: Omit<TaskTail, 'title'> | null;
  inspector: CorpusInspectorState;
  /** ⏎, Space or a press on a row: open it (focus follows into the inspector). */
  onOpenItem: (taskId: string) => void;
  /** Close the open task (back to the list). */
  onCloseItem?: () => void;
  now: number;
  /** A pinned zone, for stories and tests; the live page reads the reader's own. */
  timeZone?: string;
  /** The router's link for a console path (an anchor in a story). */
  linkFor: (path: string) => ReactElement;
  /** The inspector column, for the route to move focus into when a task opens. */
  inspectorRef?: RefObject<HTMLElement | null>;
  /** The handlers by lane: a story's own seam; the live page always takes the builders' registry. */
  registry?: ReadonlyMap<CorpusTaskLane, CorpusHandler>;
  className?: string;
};

/** The three columns' width tokens: below their sum, one pane at a time. */
const COLUMNS = ['--size-lanes', '--size-list', '--size-inspector'] as const;

/** Where a search is typed: the lane and its tab (typing is dropped when either moves). */
const searchPlace = (query: TaskQuery) => JSON.stringify([query.lane.id, query.tab]);

export function CorpusTaskView({
  sidebar,
  query,
  onQueryChange,
  lanes,
  list,
  onLoadMore,
  onRetryList,
  tail = null,
  inspector,
  onOpenItem,
  onCloseItem,
  now,
  timeZone,
  linkFor,
  inspectorRef,
  registry,
  className,
}: CorpusTaskViewProps) {
  const page = useRef<HTMLDivElement>(null);
  const ownInspector = useRef<HTMLElement | null>(null);
  const pane = inspectorRef ?? ownInspector;
  const grid = useRef<HTMLTableElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const narrow = !useColumnsFit(page, COLUMNS);
  const itemOpen = inspector.kind !== 'none';
  const shown = !narrow ? 'all' : itemOpen ? 'detail' : 'list';
  const focusList = () => grid.current?.focus();
  const panes = usePaneFocus({
    page,
    shown,
    open: itemOpen,
    focusList,
    detailPane: 'detail',
  });
  const backToList = () => {
    if (narrow && onCloseItem !== undefined) {
      panes.askBack();
      onCloseItem();
      return;
    }
    focusList();
  };

  const { lane } = query;
  const figures = lanes?.lanes[lane.task];
  const kicker =
    query.tab === DECIDED_TAB || figures === undefined || lanes?.pending === true
      ? null
      : bodiesCount(
          query.tab === null ? figures.open : (figures.facets[query.tab] ?? figures.open),
        );
  const what = LANE_WHAT[lane.task];
  const selectedId = inspector.kind === 'item' ? inspector.item.taskId : query.item;
  const setTab = (tab: TaskTab | null) => onQueryChange({ ...query, tab });

  return (
    <div
      ref={page}
      data-slot="corpus-task-page"
      data-lane={lane.id}
      data-narrow={narrow ? '' : undefined}
      {...panes.pageProps}
      className={cn(
        'h-full min-h-0',
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
          narrow ? cn('shrink-0 border-b', itemOpen && 'hidden') : 'border-r',
        )}
      >
        {sidebar}
      </section>

      <section
        data-pane="middle"
        aria-label={LIST_LABEL}
        tabIndex={-1}
        onKeyDown={(event) => {
          // / goes to the search from anywhere in the list's column but a field (which types it).
          if (event.key !== '/' || event.defaultPrevented || isTextEntry(event.target as Element)) {
            return;
          }
          event.preventDefault();
          search.current?.focus();
        }}
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line outline-none',
          narrow ? cn('flex-1', itemOpen && 'hidden') : 'border-r',
        )}
      >
        <div
          data-slot="corpus-head"
          className="flex min-w-0 shrink-0 flex-col gap-(--space-2) border-0 border-b border-solid border-line px-gutter pt-(--space-4) pb-(--space-3)"
        >
          <div className="flex min-w-0 items-end gap-(--space-3_5)">
            <h1
              data-slot="page-word"
              className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
            >
              {lane.label}
            </h1>
            {kicker !== null && (
              <span
                data-slot="corpus-kicker"
                className="min-w-0 truncate pb-(--space-0_5) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
              >
                {kicker}
              </span>
            )}
          </div>
          {what !== null && (
            <p data-slot="corpus-what" className="m-0 truncate text-row leading-none text-fg2">
              {what}
            </p>
          )}
        </div>
        <div
          data-slot="corpus-tools"
          className="flex min-w-0 shrink-0 flex-col gap-(--space-2_5) px-gutter pt-(--space-2) pb-(--space-3)"
        >
          <TaskSearch
            q={query.q}
            place={searchPlace(query)}
            onSearch={(q) => onQueryChange({ ...query, q })}
            placeholder={SEARCH_HINT[lane.task]}
            inputRef={search}
          />
          <ToggleGroup
            aria-label="Tab"
            className="max-w-full flex-wrap gap-y-px"
            value={query.tab ?? ''}
            onValueChange={(value) =>
              setTab(
                value === ''
                  ? null
                  : value === DECIDED_TAB
                    ? DECIDED_TAB
                    : (lane.tabs.find((t) => t.id === value)?.id ?? null),
              )
            }
          >
            <ToggleGroupItem value="">{TAB_ALL}</ToggleGroupItem>
            {lane.tabs.map((t) => (
              <ToggleGroupItem key={t.id} value={t.id}>
                {t.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {list.pending && list.status !== 'loading' && (
          <div
            data-slot="corpus-notes"
            className="shrink-0 border-0 border-t border-solid border-line px-gutter py-(--space-3)"
          >
            <Note data-slot="corpus-pending">{LIST_PENDING}</Note>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col border-0 border-t border-solid border-line">
          <TaskTable
            lane={lane.task}
            label={lane.label}
            list={list}
            emptyWords={
              query.tab === DECIDED_TAB
                ? NOTHING_DECIDED
                : query.q.trim() !== ''
                  ? NOTHING_MATCHES
                  : NOTHING_OPEN
            }
            tail={tail === null ? null : { ...tail, title: DECIDED_THIS_WEEK }}
            selectedId={selectedId}
            q={query.q}
            now={now}
            onOpen={onOpenItem}
            paused={narrow && itemOpen}
            gridRef={grid}
            {...(onLoadMore !== undefined && { onLoadMore })}
            {...(onRetryList !== undefined && { onRetry: onRetryList })}
          />
        </div>
      </section>

      <section
        ref={pane as RefObject<HTMLElement>}
        data-pane="detail"
        aria-label={INSPECTOR_LABEL}
        tabIndex={-1}
        onKeyDown={(event) => {
          // ⇧⏎ or Esc in the inspector goes back to the list — never from a field, never from a
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
        {narrow && itemOpen && onCloseItem !== undefined && (
          <div
            data-slot="corpus-back"
            className="flex shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-2)"
          >
            <Button size="xs" onClick={backToList}>
              {BACK_TO_LIST}
            </Button>
          </div>
        )}
        <CorpusInspector
          state={inspector}
          now={now}
          {...(timeZone !== undefined && { timeZone })}
          pane={pane}
          onBack={backToList}
          linkFor={linkFor}
          narrow={narrow}
          {...(registry !== undefined && { registry })}
        />
      </section>
    </div>
  );
}
