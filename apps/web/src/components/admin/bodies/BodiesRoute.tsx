import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { type ReactElement, useEffect, useState } from 'react';

import { useRole } from '@/lib/useRole';

import { BodiesView } from './BodiesView';
import type { BodiesListData, BodyPreviewData } from './bodiesData';
import { UNREAD_LIST } from './bodiesData';
import {
  laneCountFrom,
  listFromLane,
  listFromSearch,
  previewFrom,
  SEARCH_LIMIT,
  SEARCH_MIN_CHARS,
  searchesByName,
  standingLaneOf,
} from './bodiesReads';
import { type BodiesQuery, type BodiesSearch, queryOf, searchFor } from './bodiesSearch';

/**
 * The Bodies library, wired: its place from the URL (validated by `validateBodiesSearch`, which the
 * route file adopts as its `validateSearch`), the reads that exist today (`bodiesReads` says which
 * serve what), the clock, and the link to a body's console.
 *
 * The integrator mounts it as the route's component:
 *
 * ```ts
 * export const Route = createFileRoute('/admin/bodies')({
 *   validateSearch: validateBodiesSearch,
 *   component: () => <BodiesRoute bodyPath={(id) => `/admin/body/${id}`} />,
 * });
 * ```
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
  const now = useMinuteClock();
  const query = queryOf(search);
  const { list, laneCount } = useLaneList(query);
  const preview = usePreview(query.bodyId, can('audit.read'));

  const go = (next: BodiesQuery, how?: { replace?: boolean }) =>
    void navigate({
      to: '.',
      search: searchFor(next) as never,
      ...(how?.replace === true && { replace: true }),
    });
  const bodyLink = (id: string): ReactElement => <Link to={bodyPath(id)} />;

  return (
    <BodiesView
      query={query}
      onQueryChange={go}
      list={list}
      laneCounts={{ [query.lane.id]: laneCount }}
      corpus={null}
      preview={preview}
      now={now}
      bodyLink={bodyLink}
      onOpenBody={(id) => void navigate({ to: bodyPath(id) })}
    />
  );
}

/** The list for the lane on screen, from whichever read serves it. */
function useLaneList(query: BodiesQuery): {
  list: BodiesListData;
  laneCount: { count: number; capped: boolean } | null;
} {
  const standingLane = standingLaneOf(query.lane);
  const byName = searchesByName(query.lane);
  const q = query.q.trim();
  const lane = useQuery(
    api.standing.listLane,
    standingLane === null ? 'skip' : { lane: standingLane },
  );
  const hits = useQuery(
    api.waterBodies.searchByName,
    byName && q.length >= SEARCH_MIN_CHARS
      ? { query: q, limit: SEARCH_LIMIT, bodiesOnly: true }
      : 'skip',
  );
  if (standingLane !== null) {
    return { list: listFromLane(lane, query), laneCount: laneCountFrom(lane) };
  }
  if (byName) return { list: listFromSearch(hits, query.lane, q), laneCount: null };
  return { list: UNREAD_LIST, laneCount: null };
}

/** The open body's preview, from the reads that exist. */
function usePreview(
  bodyId: string | null,
  canReadAudit: boolean,
): BodyPreviewData | null | undefined {
  const id = bodyId !== null && ID_SHAPE.test(bodyId) ? (bodyId as Id<'waterBodies'>) : null;
  const got = useQuery(api.waterBodies.get, id === null ? 'skip' : { waterBodyId: id });
  const putIns = useQuery(api.putIns.listForBody, id === null ? 'skip' : { waterBodyId: id });
  const subAreas = useQuery(api.subAreas.listForBody, id === null ? 'skip' : { waterBodyId: id });
  const history = useQuery(
    api.moderation.listActions,
    id === null || !canReadAudit ? 'skip' : { targetType: 'waterbody', targetId: id, limit: 7 },
  );
  if (id === null) return null;
  if (got === undefined) return undefined;
  if (got === null || !got.available) return null;
  return previewFrom({
    body: got.body,
    putIns,
    subAreas,
    history: canReadAudit ? history : null,
  });
}

/** The instant ages are read against, moved on once a minute (the finest age a row writes). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
