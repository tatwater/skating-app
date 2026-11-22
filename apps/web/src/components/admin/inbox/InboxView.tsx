import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { ConsoleStatus } from '../shell/ConsoleShell';
import { useColumnsFit, usePaneFocus } from '../shell/columnsFit';
import { historyWhen } from '../shell/consoleTime';
import { facetsOf, type InboxQuery } from './inboxSearch';
import type { HandlerKey, InboxHandler } from './inspector/handlerRegistry';
import { InboxInspector, type InspectorState } from './inspector/InboxInspector';
import { InboxLanes } from './lanes/InboxLanes';
import { ageCountsFor, statusFacts } from './lanes/laneModel';
import { InboxList, type TailList } from './list/InboxList';
import { InboxZero, type ZeroToday } from './list/InboxZero';
import { flowEntries, rowView } from './list/inboxModel';
import type { ListStatus } from './list/inboxReads';
import type { InboxLanesView, InboxRowView } from './list/inboxTypes';
import { type FilterSearch, LaneFacets } from './list/LaneFacets';
import {
  BACK_TO_LIST,
  DECIDED_KICKER,
  DECIDED_THIS_WEEK,
  DECIDED_TODAY,
  INSPECTOR_LABEL,
  LANE_LABELS,
  LANES_LABEL,
  LIST_LABEL,
  LIST_PENDING,
  NOTHING_DECIDED,
  NOTHING_MATCHES,
  NOTHING_OPEN,
  openCount,
} from './words/inboxWords';

/**
 * **The Inbox** (boards 2.1–2.9) as the console mounts it, from what the route hands it — three
 * columns, as the boards draw them: **the lanes** (which list), **the list** (its word and count, the
 * lane's tabs and *Filter*, the rows, the end tab and this week's decisions), and **the inspector**
 * (the open item, drawn by its handler; Inbox zero when nothing waits). `InboxRoute` wires it to the
 * router and Convex; a story draws the same page in the shell.
 *
 * - **Keys.** Tab moves between the columns, ↑↓ within one, typing jumps in a list. ⏎ or Space on
 *   a row opens it and moves focus into the inspector, where the handler's single-letter keys act —
 *   only there. ⇧⏎ (or Esc) in the inspector goes back to the list, on the row it opened from.
 *   ⌘K and G then a letter go anywhere (the shell's). No number keys, no J/K.
 * - **The narrow rule** (`useColumnsFit`): below the three columns' summed widths the open item takes
 *   the page with *Back to the list*, and with none open the lanes sit over the list.
 * - **The status bar** carries Safety's open count (red) and today's decided, never the page's name.
 *
 * Nothing here is a fixture: a count no read gives is absent, one not ready says so, a failed read
 * says so, and the server's order is the order drawn.
 */

export type InboxListData = {
  status: ListStatus;
  rows: readonly InboxRowView[];
  /** The server is still preparing its stored items. */
  pending: boolean;
  retryPending?: boolean;
};

export type InboxViewProps = {
  /** The lanes read's answer (held through a change of list), or none yet. */
  lanes: InboxLanesView | undefined;
  canReadSupport: boolean;
  query: InboxQuery;
  /** A change of place: another lane, tab or filter. */
  onQueryChange: (next: InboxQuery) => void;
  list: InboxListData;
  onLoadMore?: () => void;
  onRetryList?: () => void;
  /** The lane's decided list under its open one (a lane's week, or today's at zero). */
  tail?: { rows: readonly InboxRowView[]; failure?: TailList['failure'] } | null;
  /** The inbox is at zero: the list says so and the inspector shows the day. */
  zero?: { day: ZeroToday; notInInbox?: { corpus?: ReactNode; machinery?: ReactNode } } | null;
  inspector: InspectorState;
  /** ⏎, Space or a press on a row: open it (focus follows only from the keys). */
  onOpenItem: (itemId: string, from: 'keys' | 'press') => void;
  /** Close the open item (back to the list). */
  onCloseItem?: () => void;
  /**
   * The page the operator came from (`?from=`, a People or Body link): ⇧⏎ in the inspector returns
   * there instead of to the list.
   */
  onReturn?: () => void;
  now: number;
  /** A pinned zone, for stories and tests; the live page reads the reader's own (absent here). */
  timeZone?: string;
  /** The router's link for a console path (an anchor in a story). */
  linkFor: (path: string) => ReactElement;
  /** The applied body's or person's name, when known. */
  filterName?: string | null;
  bodySearch?: FilterSearch;
  personSearch?: FilterSearch;
  onNamed?: (id: string, name: string) => void;
  /** The counts' failure note, under the lanes. */
  countsNote?: ReactNode;
  /** The inspector column, for the route to move focus into when an item opens from the keys. */
  inspectorRef?: RefObject<HTMLElement | null>;
  /** The handlers by key: a story's own seam; the live page always takes the builders' registry. */
  registry?: ReadonlyMap<HandlerKey, InboxHandler>;
  className?: string;
};

/** The three columns' width tokens: below their sum, one pane at a time. */
const COLUMNS = ['--size-lanes', '--size-list', '--size-inspector'] as const;

export function InboxView({
  lanes,
  canReadSupport,
  query,
  onQueryChange,
  list,
  onLoadMore,
  onRetryList,
  tail = null,
  zero = null,
  inspector,
  onOpenItem,
  onCloseItem,
  onReturn,
  now,
  timeZone,
  linkFor,
  filterName = null,
  bodySearch,
  personSearch,
  onNamed,
  countsNote,
  inspectorRef,
  registry,
  className,
}: InboxViewProps) {
  const page = useRef<HTMLDivElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const ownInspector = useRef<HTMLElement | null>(null);
  const pane = inspectorRef ?? ownInspector;
  const fits = useColumnsFit(page, COLUMNS);
  const narrow = !fits;
  const itemOpen = inspector.kind !== 'none';
  const shown = !narrow ? 'all' : itemOpen ? 'detail' : 'list';
  const panes = usePaneFocus({
    page,
    shown,
    open: itemOpen,
    focusList: () => listbox.current?.focus(),
    detailPane: 'detail',
  });
  const backToList = () => {
    if (narrow && onCloseItem !== undefined) {
      panes.askBack();
      onCloseItem();
      return;
    }
    listbox.current?.focus();
  };

  const lane = query.lane;
  const facets = facetsOf(lane);
  const figures = lanes?.lanes.find((l) => l.lane === lane);
  const kicker =
    lane === 'decided'
      ? DECIDED_KICKER
      : lanes === undefined || lanes.pending
        ? null
        : openCount(
            (lane === 'all' ? lanes.allOpen : (figures?.open ?? 0)).toLocaleString('en-US'),
          );
  const views = useMemo(() => list.rows.map((r) => rowView(r, now)), [list.rows, now]);
  const entries = useMemo(() => flowEntries(views, lane), [views, lane]);
  // At zero the decided rows are today's: each says the time it was decided ("15:02").
  const tailViews = useMemo(
    () =>
      tail === null
        ? []
        : tail.rows.map((r) => {
            const v = rowView(r, now);
            return zero !== null && r.decided !== null
              ? { ...v, age: historyWhen(r.decided.at, now, timeZone) }
              : v;
          }),
    [tail, now, zero, timeZone],
  );
  const selectedId = inspector.kind === 'item' ? inspector.item.itemId : query.item;
  // **A decision lands on the open item: focus is never left on the page body.** The frame drops the
  // action bar — and with it any reason dialog the bar opened, closed unsent, what was typed
  // dropped — so focus that sat on either falls to `<body>`, where no inspector key works.
  // - A colleague's decision (the lock): focus goes to the inspector, where ⏎ is *Back to the
  //   queue* and the banner's links are a Tab away.
  // - The viewer's own (quiet): focus moves on to the next open row in the list; on a narrow page,
  //   where the item has the page and the list is hidden, to the inspector, which is what is shown.
  // Only when focus was lost or inside the inspector: focus the operator put elsewhere stays put.
  const decided =
    inspector.kind === 'item' && (inspector.phase === 'quiet' || inspector.phase === 'locked')
      ? { id: inspector.item.itemId, phase: inspector.phase }
      : null;
  const decidedKey = decided === null ? null : `${decided.phase}:${decided.id}`;
  const [follow, setFollow] = useState<{ id: string; seq: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as a decision lands on the open item.
  useEffect(() => {
    if (decided === null) return;
    const active = document.activeElement;
    const nowhere = active === null || active === document.body;
    if (!nowhere && !pane.current?.contains(active)) return;
    if (decided.phase === 'locked' || narrow) {
      // Focus still on something in the inspector that stands (a link in its body) stays there.
      if (nowhere) pane.current?.focus({ preventScroll: true });
      return;
    }
    const id = decided.id;
    setFollow((f) => ({ id, seq: (f?.seq ?? 0) + 1 }));
  }, [decidedKey]);
  const facts = statusFacts(lanes);
  const ageCounts = ageCountsFor(lanes, lane);
  const atZero = zero !== null;

  return (
    <div
      ref={page}
      data-slot="inbox-page"
      data-narrow={narrow ? '' : undefined}
      {...panes.pageProps}
      className={cn(
        // The boards' columns (2.1–2.9: 204 | 384 | the rest). The console's tokens are People's
        // (236 | 340); the Inbox's own pair is a reported missing token, set here on the page so the
        // narrow rule (`useColumnsFit`, which reads the tokens off this element) measures the same.
        'h-full min-h-0 [--size-lanes:12.75rem] [--size-list:24rem]',
        narrow
          ? 'flex flex-col overflow-x-hidden'
          : 'grid grid-cols-[var(--size-lanes)_var(--size-list)_minmax(0,1fr)]',
        className,
      )}
    >
      <ConsoleStatus
        groups={
          facts === null
            ? []
            : [
                ...(facts.safety > 0
                  ? [
                      <span key="safety" data-slot="inbox-status-safety" className="text-bad">
                        {`${facts.safety.toLocaleString('en-US')} safety`}
                      </span>,
                    ]
                  : []),
                <span key="today" data-slot="inbox-status-today">
                  {`decided today · ${facts.today}`}
                </span>,
              ]
        }
      />
      <section
        data-pane="lanes"
        aria-label={LANES_LABEL}
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
          narrow ? cn('shrink-0 border-b', itemOpen && 'hidden') : 'border-r',
        )}
      >
        <InboxLanes
          view={lanes}
          canReadSupport={canReadSupport}
          selected={lane}
          onSelect={(next) => {
            if (next === lane) return;
            // The item is the route's to keep or close (`placeAfter`: a linked item stays, one opened from
            // the list closes), so a lane's change never forces it.
            onQueryChange({ ...query, lane: next, facet: 'all' });
          }}
          countsNote={countsNote}
        />
      </section>

      <section
        data-pane="middle"
        aria-label={LIST_LABEL}
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
          narrow ? cn('flex-1', itemOpen && 'hidden') : 'border-r',
        )}
      >
        <div
          data-slot="inbox-head"
          className="flex min-w-0 shrink-0 items-end gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-4) pb-(--space-3)"
        >
          <h1
            data-slot="page-word"
            className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
          >
            {LANE_LABELS[lane]}
          </h1>
          {kicker !== null && (
            <span
              data-slot="inbox-kicker"
              className="min-w-0 pb-(--space-0_5) text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase"
            >
              {kicker}
            </span>
          )}
        </div>
        {!atZero && (
          <LaneFacets
            facets={facets}
            facet={query.facet}
            onFacet={(facet) => onQueryChange({ ...query, facet })}
            {...(figures !== undefined && { facetCounts: figures.facets })}
            {...(ageCounts !== undefined && { ageCounts })}
            filter={query.filter}
            onFilter={(filter) => onQueryChange({ ...query, filter })}
            filterName={filterName}
            {...(bodySearch !== undefined && { bodySearch })}
            {...(personSearch !== undefined && { personSearch })}
            {...(onNamed !== undefined && { onNamed })}
          />
        )}
        {list.pending && list.status !== 'loading' && (
          <div
            data-slot="inbox-notes"
            className="shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-3)"
          >
            <Note data-slot="inbox-pending">{LIST_PENDING}</Note>
          </div>
        )}
        <InboxList
          label={LANE_LABELS[lane]}
          entries={entries}
          status={list.status}
          emptyWords={
            lane === 'decided'
              ? NOTHING_DECIDED
              : query.filter !== null
                ? NOTHING_MATCHES
                : NOTHING_OPEN
          }
          tail={
            tailViews.length === 0 && tail?.failure == null
              ? null
              : {
                  title: atZero ? DECIDED_TODAY : DECIDED_THIS_WEEK,
                  rows: tailViews,
                  failure: tail?.failure ?? null,
                }
          }
          selectedId={selectedId}
          onOpen={onOpenItem}
          {...(onLoadMore !== undefined && { onLoadMore })}
          {...(onRetryList !== undefined && { onRetry: onRetryList })}
          retryPending={list.retryPending === true}
          paused={narrow && itemOpen}
          memoryKey={`${lane}|${query.facet}|${JSON.stringify(query.filter)}`}
          listRef={listbox}
          follow={follow}
        />
      </section>

      <section
        ref={pane as RefObject<HTMLElement>}
        data-pane="detail"
        aria-label={INSPECTOR_LABEL}
        tabIndex={-1}
        onKeyDown={(event) => {
          // ⇧⏎ or Esc in the inspector goes back to the list, on the row it opened from — never
          // from a field (Esc clears or leaves it), never from a dialog, never a key already used.
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
          if (onReturn !== undefined && event.key === 'Enter') onReturn();
          else backToList();
        }}
        className={cn(
          'relative flex min-h-0 min-w-0 flex-col outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
          shown === 'detail' ? 'flex-1' : shown === 'list' && 'hidden',
        )}
      >
        {narrow && itemOpen && onCloseItem !== undefined && (
          <div
            data-slot="inbox-back"
            className="flex shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-2)"
          >
            <Button size="xs" onClick={backToList}>
              {BACK_TO_LIST}
            </Button>
          </div>
        )}
        <InboxInspector
          state={inspector}
          now={now}
          {...(timeZone !== undefined && { timeZone })}
          pane={pane}
          onBack={backToList}
          linkFor={linkFor}
          canReadSupport={canReadSupport}
          narrow={narrow}
          {...(registry !== undefined && { registry })}
          {...(atZero &&
            zero !== null && {
              zero: (
                <InboxZero
                  day={zero.day}
                  now={now}
                  canReadSupport={canReadSupport}
                  {...(timeZone !== undefined && { timeZone })}
                  {...(zero.notInInbox !== undefined && { notInInbox: zero.notInInbox })}
                />
              ),
            })}
        />
      </section>
    </div>
  );
}
