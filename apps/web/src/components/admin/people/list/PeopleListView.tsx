import type { PeopleLane } from '@skating/core';
import { type ReactNode, type Ref, useLayoutEffect, useMemo, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Lanes } from '@/components/kit/lanes';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { countText } from '../../overview/overviewModel';
import { ConsoleStatus } from '../../shell/ConsoleShell';
import { useColumnsFit } from '../../shell/columnsFit';
import { SearchLane } from './kit-candidates/search-lane';
import { PeopleList } from './PeopleList';
import { PEOPLE_LANE_INFO } from './peopleLanes';
import {
  type Backfill,
  endWords,
  kickerText,
  type LaneEntry,
  laneCount,
  lanesPendingNote,
  type PartialReason,
  type PersonListRow,
  pendingWords,
  reasonWords,
  rowView,
} from './peopleModel';
import type { ListStatus } from './peopleReads';
import { isSearching, listKey, type PeopleQuery, serverSearch } from './peopleSearch';
import {
  appealsOpen as appealsOpenWords,
  BACK_TO_LIST,
  LANES_GROUP,
  NO_ONE_OPEN,
  noMatch,
  SEARCH_LABEL,
  SEARCH_WORDS,
  searchListLabel,
} from './peopleWords';

/**
 * The People list (boards 8.1 and 8.2, the left two columns) as the console mounts it, from what
 * the route hands it: the place in the URL (`query`), the lanes the viewer has and their counts, the
 * rows the lane's read returned, and the person open beside it (`detail`, the person route's page).
 * `PeopleListRoute` wires it to the router and Convex; a story draws the same page in the shell.
 *
 * Three columns, as the boards draw them: **the lanes** — a search over every account at the top,
 * then the lists — **the list** (its word, its count and order, then the rows) and **the person**.
 * Tab moves between them, ↑↓ within; `/` goes to the search from anywhere but a field.
 *
 * Every change of place goes through `onQueryChange` — the route writes it to the URL. Nothing here
 * is a fixture: a count no read gives is absent, a count not ready says so, a read that failed says
 * so, and the server's order is the order drawn.
 */

export type PeopleListData = {
  status: ListStatus;
  rows: readonly PersonListRow[];
  reasons: readonly PartialReason[];
  pending: readonly Backfill[];
  /** Tried again, the fresh answer not in. */
  retryPending?: boolean;
};

export type PeopleListViewProps = {
  /** The lanes the viewer has, in the sidebar's order. */
  lanes: readonly PeopleLane[];
  /** Each lane's count read, when the lanes' read has answered. */
  laneEntries: Readonly<Partial<Record<PeopleLane, LaneEntry>>> | null;
  query: PeopleQuery;
  /**
   * A change of place: another lane, or the search. `replace` for the search as it is typed, which
   * refines the place rather than leaving it (the back button goes to the lane, not each keystroke).
   */
  onQueryChange: (next: PeopleQuery, how?: { replace?: boolean }) => void;
  list: PeopleListData;
  onLoadMore?: () => void;
  onRetryList?: () => void;
  /** The person open beside the list. */
  selectedId: string | null;
  /** ⏎, Space or a press on a row: open that person (focus follows only from the keys). */
  onOpenPerson: (id: string, from: 'keys' | 'press') => void;
  /** The instant ages are read against. */
  now: number;
  /** The open person's page; without one, the column says no one is open. */
  detail?: ReactNode;
  /** The counts' failure note, at the lanes' foot. */
  countsNote?: ReactNode;
  /** The person column, for the route to move focus into when a person opens from the keys. */
  detailRef?: Ref<HTMLElement>;
  /**
   * Closes the open person (back to the list). On a narrow screen, where the person takes the page,
   * it is the way back — its button, and Esc or ⇧⏎ in the person's page.
   */
  onCloseDetail?: () => void;
  className?: string;
};

/** The three columns' width tokens: below their sum, the page is master–detail. */
const COLUMNS = ['--size-lanes', '--size-list', '--size-inspector'] as const;

export function PeopleListView({
  lanes,
  laneEntries,
  query,
  onQueryChange,
  list,
  onLoadMore,
  onRetryList,
  selectedId,
  onOpenPerson,
  now,
  detail,
  countsNote,
  detailRef,
  onCloseDetail,
  className,
}: PeopleListViewProps) {
  const search = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  // The console's narrow-screen rule (`useColumnsFit`): three columns while they fit, else the
  // open person takes the page and, with none open, the lanes and the list do.
  const fits = useColumnsFit(page, COLUMNS);
  const personOpen = selectedId !== null && detail !== undefined;
  const narrow = !fits;
  // Which panes are on screen: all three, or — narrow — the person's page, or the lanes and list.
  const shown = !narrow ? 'all' : personOpen ? 'detail' : 'list';
  // Where focus last sat in the page, kept when it went nowhere (its control hidden or gone).
  const held = useRef<HTMLElement | null>(null);
  // Back to the list from a person on a narrow screen: focus goes to the list once it is drawn.
  const backAsked = useRef(false);
  // A pane the narrow rule hides takes no focus with it, however it went — the page's way back,
  // the browser's, a row opened from the keys or a press, a resize: focus that sat in it (or on a
  // control that went with it) moves to the pane now on screen, never to the page.
  useLayoutEffect(() => {
    const asked = backAsked.current && shown === 'list';
    backAsked.current = false;
    if (shown === 'all') return;
    const hidden = (el: Element | null) => {
      const pane = el?.closest<HTMLElement>('[data-pane]')?.dataset.pane;
      return shown === 'detail' ? pane === 'lanes' || pane === 'middle' : pane === 'detail';
    };
    const active = document.activeElement;
    const from = held.current;
    const lost =
      active === null || active === document.body
        ? from !== null && (!from.isConnected || hidden(from))
        : page.current?.contains(active) === true && hidden(active);
    if (!asked && !lost) return;
    if (shown === 'list') listbox.current?.focus();
    else
      page.current
        ?.querySelector<HTMLElement>(':scope > [data-pane="detail"]')
        ?.focus({ preventScroll: true });
  }, [shown]);
  const backToList = () => {
    if (narrow && onCloseDetail !== undefined) {
      backAsked.current = true;
      onCloseDetail();
      return;
    }
    listbox.current?.focus();
  };
  const searching = isSearching(query);
  const mark = serverSearch(query.q) ?? '';
  const lane = query.lane;
  const listLane = searching ? null : lane;
  const info = PEOPLE_LANE_INFO[lane];
  const entry = laneEntries?.[lane];
  const entries = lanes.map((l) => laneEntries?.[l]).filter((e): e is LaneEntry => e !== undefined);

  const rows = useMemo(() => {
    const facts = {
      flagsPending: list.pending.includes('flagSubjects'),
      flagsFloor: list.reasons.includes('flags_capped'),
      appealsFloor: list.reasons.includes('tickets_capped'),
    };
    return list.rows.map((r) => rowView(r, listLane, facts, now));
  }, [list.rows, list.pending, list.reasons, listLane, now]);

  // What may be short or not ready, said once over the rows: the page's own reasons, and the lane
  // count's (a search has no count).
  const reasons = [
    ...new Set<PartialReason>([...list.reasons, ...(searching ? [] : (entry?.reasons ?? []))]),
  ];
  const notReady = list.status === 'loading' ? null : pendingWords(listLane, list.pending);
  const appeals = laneEntries?.appeals;
  const appealsOpen =
    appeals !== undefined && appeals.pending.length === 0 && appeals.count.count > 0
      ? appealsOpenWords(
          countText(appeals.count),
          appeals.count.count === 1 && !appeals.count.capped,
        )
      : null;
  const footNote = lanesPendingNote(entries);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a key the page hears from any of its panes, not a control of its own
    <div
      ref={page}
      data-slot="people-page"
      data-narrow={narrow ? '' : undefined}
      onFocus={(event) => {
        held.current = event.target as HTMLElement;
      }}
      onBlur={(event) => {
        // Focus moved on out of the page: nothing to keep. Taken out from under focus (hidden or
        // unmounted), it goes nowhere (`relatedTarget` is null) and stays held for the effect above.
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) held.current = null;
      }}
      onKeyDown={(event) => {
        // / goes to the search from anywhere on the page but a field (which types it) — and never
        // from a dialog or a menu the page opened: a portal's keys bubble here through React, but
        // its focus belongs to it, not to the search behind it. Narrow, with the person's page
        // over the lanes, the search isn't on screen: the key is left alone.
        if (
          event.key !== '/' ||
          shown === 'detail' ||
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
        search.current?.focus();
      }}
      className={cn(
        'h-full min-h-0',
        narrow
          ? 'flex flex-col overflow-x-hidden'
          : 'grid grid-cols-[var(--size-lanes)_var(--size-list)_minmax(0,1fr)]',
        className,
      )}
    >
      <ConsoleStatus
        groups={
          appealsOpen === null
            ? []
            : [
                <span key="appeals" data-slot="people-status-appeals" className="text-warn">
                  {appealsOpen}
                </span>,
              ]
        }
      />
      <section
        data-pane="lanes"
        aria-label="Lanes"
        // Narrow: over the list, its own height; hidden (kept mounted) while a person has the page.
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line pt-(--space-3_5)',
          narrow ? cn('shrink-0 border-b', personOpen && 'hidden') : 'border-r',
        )}
      >
        <SearchLane
          value={query.q}
          label={SEARCH_LABEL}
          place={JSON.stringify([lane, selectedId])}
          inputRef={search}
          onSearch={(q) => onQueryChange({ lane, q }, { replace: true })}
        />
        <Lanes
          label="People"
          className="min-h-0 flex-1 pt-(--space-3)"
          selected={searching ? undefined : lane}
          onKeyDown={(event) => {
            if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
            event.preventDefault();
            search.current?.focus();
          }}
          onSelect={(id) => {
            // The lane on screen keeps its place; another lane (or a lane after a search) opens fresh.
            if (id === lane && !searching) return;
            onQueryChange({ lane: id as PeopleLane, q: '' });
          }}
          groups={[
            {
              label: LANES_GROUP,
              lanes: lanes.map((l) => {
                const count = laneCount(laneEntries?.[l]);
                const meta = PEOPLE_LANE_INFO[l];
                return {
                  id: l,
                  label: meta.label,
                  ...(count !== null && { count: countText(count) }),
                  // Amber while anyone waits — chosen or not (the kit keeps a meaning's ink).
                  ...(count !== null &&
                    meta.tone !== undefined &&
                    (count.count > 0 || count.capped) && { countTone: meta.tone }),
                  ...(count !== null && count.count === 0 && !count.capped && { dim: true }),
                };
              }),
            },
          ]}
          {...(footNote !== null && {
            foot: <span data-slot="people-lanes-pending">{footNote}</span>,
          })}
        />
        {countsNote}
      </section>

      <section
        data-pane="middle"
        aria-label="List"
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
          narrow ? cn('flex-1', personOpen && 'hidden') : 'border-r',
        )}
      >
        <div
          data-slot="people-head"
          className="flex min-w-0 shrink-0 items-end gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-4) pb-(--space-3)"
        >
          <h1
            data-slot="page-word"
            className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
          >
            {searching ? SEARCH_WORDS.title : info.title}
          </h1>
          {/* Never cut: at the list column's width a long count beside a long word takes a second
              line, balanced, and the negative top margin keeps two lines inside the word's height,
              so the head's rhythm holds whichever lane is open. */}
          <span
            data-slot="people-kicker"
            className="-mt-(--space-0_5) min-w-0 pb-(--space-0_5) text-kick leading-none font-medium tracking-kick text-balance text-fg3 uppercase"
          >
            {kickerText(lane, entry, searching)}
          </span>
        </div>
        {(notReady !== null || reasons.length > 0) && (
          <div
            data-slot="people-notes"
            className="flex shrink-0 flex-col gap-(--space-2) border-0 border-b border-solid border-line px-gutter py-(--space-3) text-assist leading-list text-fg2"
          >
            {notReady !== null && <Note data-slot="people-pending">{notReady}</Note>}
            {reasons.map((r) => (
              <Note key={r} data-slot="people-reason" data-reason={r}>
                {reasonWords(r)}
              </Note>
            ))}
          </div>
        )}
        <PeopleList
          label={searching ? searchListLabel(query.q.trim()) : info.title}
          rows={rows}
          status={list.status}
          selectedId={selectedId}
          onOpen={onOpenPerson}
          {...(onLoadMore !== undefined && { onLoadMore })}
          {...(onRetryList !== undefined && { onRetry: onRetryList })}
          retryPending={list.retryPending === true}
          emptyWords={searching ? noMatch(query.q.trim()) : info.empty}
          doneWords={endWords(listLane, list.reasons, list.pending, list.rows.length)}
          mark={mark}
          memoryKey={listKey(query)}
          onSearchKey={() => search.current?.focus()}
          listRef={listbox}
        />
      </section>

      <section
        ref={detailRef}
        data-pane="detail"
        aria-label="Person"
        tabIndex={-1}
        onKeyDown={(event) => {
          // Esc or ⇧⏎ in the person's page goes back to the list, on the row it was opened from —
          // never from a field (Esc clears or leaves it), never from a dialog (it closes), never a
          // key something in the page already used.
          const back = event.key === 'Escape' || (event.key === 'Enter' && event.shiftKey);
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
          'flex min-h-0 min-w-0 flex-col outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
          shown === 'detail' ? 'flex-1' : shown === 'list' && 'hidden',
        )}
      >
        {narrow && personOpen && onCloseDetail !== undefined && (
          <div
            data-slot="people-back"
            className="flex shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-2)"
          >
            <Button size="xs" onClick={backToList}>
              {BACK_TO_LIST}
            </Button>
          </div>
        )}
        {detail ?? <ListEnd className="mt-(--space-3)">{NO_ONE_OPEN}</ListEnd>}
      </section>
    </div>
  );
}
