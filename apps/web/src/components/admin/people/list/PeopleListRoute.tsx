import type { PeopleLane } from '@skating/core';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useRef, useState } from 'react';

import { useRole } from '@/lib/useRole';

import { isFailed } from '../../reads/consoleReads';
import { ReadNote } from '../../reads/ReadNote';
import { useMinuteNow } from '../../shell/presence';
import { PeopleListView } from './PeopleListView';
import { lanesFor } from './peopleLanes';
import type { LaneEntry } from './peopleModel';
import { usePeopleLanes, usePeoplePages } from './peopleReads';
import {
  listKey,
  type PeopleQuery,
  type PeopleSearch,
  personHref,
  queryOf,
  searchFor,
  serverSearch,
} from './peopleSearch';

/**
 * The People list, wired: its place from the URL (validated by `validatePeopleSearch`, which the
 * route adopts as its `validateSearch`), the lanes' counts and the lane's pages (`peopleReads`, the
 * console's one read layer), the clock, and the person open beside it — the person route's page,
 * drawn in the third column through the router's outlet.
 *
 * - **The lanes a viewer has** are the server's rule, asked of the role before the counts land, so a
 *   moderator's link to Appeals open (support tickets, an admin's to read) is Everyone, never an
 *   error.
 * - **The list and its counts are read against the list's clock**: the minute the list was opened,
 *   held while it stays open, so a new minute never restarts the paging. Every read waits on
 *   `people.read`; a viewer without it sees *Not recorded yet*.
 * - **Every change of place is a navigation**, so the back button, a reload and a return from a
 *   person put the list back as it was. Another lane closes the open person (it opens fresh, as the
 *   Bodies library does); a search keeps them open and replaces the entry as it is typed. Opening a
 *   person carries the lane and the search in their path (`personHref`), so their page returns
 *   here.
 */

export type PeopleListRouteProps = {
  /** Draws the open person; default the router's outlet (the person route's page). */
  detail?: ReactNode;
};

export function PeopleListRoute({ detail }: PeopleListRouteProps = {}) {
  const search = useSearch({ strict: false }) as PeopleSearch;
  const params = useParams({ strict: false }) as { id?: string };
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  const canRead = can('people.read');
  const lanes = lanesFor(can('inbox.support.read'));
  const query = queryOf(search, lanes);
  const key = listKey(query);
  const listNow = useClockFor(key);
  const selectedId = params.id ?? null;
  const detailPane = useRef<HTMLElement>(null);

  const lanesRead = usePeopleLanes(listNow, canRead);
  const pages = usePeoplePages(
    canRead
      ? { lane: query.lane, search: serverSearch(query.q), now: listNow, memoryKey: key }
      : null,
  );

  // A failed or retrying count read shows no count at all — never a zero, never the last one held.
  const laneEntries: Partial<Record<PeopleLane, LaneEntry>> | null =
    lanesRead.shown === undefined
      ? null
      : Object.fromEntries(lanesRead.shown.lanes.map((l) => [l.lane, l]));

  const goToList = (next: PeopleQuery) =>
    void navigate({ to: '/admin/people', search: searchFor(next) as never });
  const onQueryChange = (next: PeopleQuery) => {
    if (next.lane !== query.lane || selectedId === null) {
      goToList(next);
      return;
    }
    // A search typed beside an open person keeps them open; the typing replaces the entry.
    void navigate({ href: personHref(selectedId, next), replace: true });
  };

  return (
    <PeopleListView
      lanes={lanes}
      laneEntries={isFailed(lanesRead.state) ? null : laneEntries}
      query={query}
      onQueryChange={onQueryChange}
      list={{
        status: pages.status,
        rows: pages.rows,
        reasons: pages.reasons,
        pending: pages.pending,
        retryPending: pages.failure?.pending === true,
      }}
      onLoadMore={pages.loadMore}
      {...(pages.failure !== null && { onRetryList: pages.failure.retry })}
      selectedId={selectedId}
      onOpenPerson={(id) => {
        // Opening another person beside one already open replaces the entry, so back returns to
        // the list rather than walking every person looked at.
        void navigate({ href: personHref(id, query), replace: selectedId !== null });
        detailPane.current?.focus();
      }}
      now={now}
      detail={selectedId === null ? undefined : (detail ?? <Outlet />)}
      detailRef={detailPane}
      countsNote={
        // Mounted whatever the counts' state, so its words are announced when they come.
        <ReadNote
          data-slot="counts-error"
          className="shrink-0 border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3) empty:border-0 empty:p-0"
          reads={[lanesRead.state]}
        >
          Counts couldn’t be read
        </ReadNote>
      }
    />
  );
}

/**
 * The minute a list was opened at, held while it stays open: the clock its reads are asked
 * against, so the clock moving on never restarts the paging. A new `key` reads the clock again.
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
