import type { PeopleLane } from '@skating/core';
import { type ReactNode, type Ref, useMemo, useRef } from 'react';

import { Lanes } from '@/components/kit/lanes';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { countText } from '../../overview/overviewModel';
import { ConsoleStatus } from '../../shell/ConsoleShell';
import { SearchLane } from './kit-candidates/search-lane';
import { PeopleList } from './PeopleList';
import { LANES_GROUP, PEOPLE_LANE_INFO, SEARCH_INFO } from './peopleLanes';
import {
  type Backfill,
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
  /** A change of place: another lane, or the search. */
  onQueryChange: (next: PeopleQuery) => void;
  list: PeopleListData;
  onLoadMore?: () => void;
  onRetryList?: () => void;
  /** The person open beside the list. */
  selectedId: string | null;
  /** ⏎, Space or a press on a row: open that person. */
  onOpenPerson: (id: string) => void;
  /** The instant ages are read against. */
  now: number;
  /** The open person's page; without one, the column says no one is open. */
  detail?: ReactNode;
  /** The counts' failure note, at the lanes' foot. */
  countsNote?: ReactNode;
  /** The person column, for the route to move focus into when a person opens from the keys. */
  detailRef?: Ref<HTMLElement>;
  className?: string;
};

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
  className,
}: PeopleListViewProps) {
  const search = useRef<HTMLInputElement>(null);
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
      ? `${countText(appeals.count)} ${appeals.count.count === 1 && !appeals.count.capped ? 'appeal' : 'appeals'} open`
      : null;
  const footNote = lanesPendingNote(entries);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a key the page hears from any of its panes, not a control of its own
    <div
      data-slot="people-page"
      onKeyDown={(event) => {
        // / goes to the search from anywhere on the page but a field (which types it).
        if (event.key !== '/' || event.defaultPrevented || isTextEntry(event.target as Element)) {
          return;
        }
        event.preventDefault();
        search.current?.focus();
      }}
      className={cn(
        'grid h-full min-h-0 grid-cols-[var(--size-lanes)_var(--size-list)_minmax(0,1fr)]',
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
        className="flex min-h-0 min-w-0 flex-col border-0 border-r border-solid border-line pt-(--space-3_5)"
      >
        <SearchLane
          value={query.q}
          label="Search any account"
          place={JSON.stringify([lane, selectedId])}
          inputRef={search}
          onSearch={(q) => onQueryChange({ lane, q })}
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
                  ...(count !== null && count.count === 0 && !count.capped && { dim: true }),
                  ...(count !== null &&
                    meta.tone !== undefined &&
                    (count.count > 0 || count.capped) && { countTone: meta.tone }),
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
        className="flex min-h-0 min-w-0 flex-col border-0 border-r border-solid border-line"
      >
        <div
          data-slot="people-head"
          className="flex min-w-0 shrink-0 items-end gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-4) pb-(--space-3)"
        >
          <h1
            data-slot="page-word"
            className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
          >
            {searching ? SEARCH_INFO.title : info.title}
          </h1>
          <span
            data-slot="people-kicker"
            className="min-w-0 truncate pb-(--space-0_5) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
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
          label={searching ? `Search: ${query.q.trim()}` : info.title}
          rows={rows}
          status={list.status}
          selectedId={selectedId}
          onOpen={onOpenPerson}
          {...(onLoadMore !== undefined && { onLoadMore })}
          {...(onRetryList !== undefined && { onRetry: onRetryList })}
          retryPending={list.retryPending === true}
          emptyWords={searching ? `No one matches “${query.q.trim()}”` : info.empty}
          mark={mark}
          memoryKey={listKey(query)}
          onSearchKey={() => search.current?.focus()}
        />
      </section>

      <section
        ref={detailRef}
        data-pane="detail"
        aria-label="Person"
        tabIndex={-1}
        className="flex min-h-0 min-w-0 flex-col outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
      >
        {detail ?? <ListEnd className="mt-(--space-3)">No one open</ListEnd>}
      </section>
    </div>
  );
}
