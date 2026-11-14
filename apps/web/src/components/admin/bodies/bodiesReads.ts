import type { api } from '@skating/convex/api';
import { currentSeason, type LibraryListLane, seasonRecordOpensMs } from '@skating/core';
import type { PaginationStatus } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { VANTAGE_LABELS } from '../metrics/metricsModel';
import type { Count } from '../overview/overviewModel';
import { actionLabel } from '../shell/actionLabels';
import { dayMonth, seasonYears } from '../shell/consoleTime';
import { askFrom } from './askWords';
import type {
  BodiesListData,
  BodyPreviewData,
  ListServes,
  ListStatus,
  PreviewCount,
} from './bodiesData';
import type { BodyRow, BodySort } from './bodiesModel';
import { type BodiesQuery, isSearch } from './bodiesSearch';
import { FACET_IDS } from './bodyFacets';
import type { BodyLane } from './bodyLanes';

/**
 * The Bodies library's server reads, turned into what the page draws — pure, so each mapping is
 * tested without Convex. `BodiesRoute` runs the queries and hands their results here.
 *
 * - **The list** — `bodies.listPage`, a page at a time through the paginated hook: the lane, the
 *   state tab, the facets, the search and the order are all the server's. A page that comes back
 *   short because its scan ran out is not the end (`isDone` stays false): the list keeps asking,
 *   and draws its end only once the read says it is done.
 * - **The counts** — `bodies.listSummary`: every lane's total (*Changed this week* to a cap), the
 *   corpus, the lane's state tabs, the list's total and the facet counts the stored counts answer
 *   exactly. A count it can't answer is `null` — no number, never a zero.
 * - **The preview** — `waterBodies.get` (outline, figures), `putIns.listForBody`,
 *   `subAreas.listForBody`, the body's history (`bodyConsole.history`: the body, its bays,
 *   landmarks and put-ins) and `bodies.preview`, whose facts the page words: reports this season by
 *   vantage and all time, completeness, the open asks, the towns.
 *
 * **`null` is "not recorded"** throughout, never a zero.
 */

export type ListPage = FunctionReturnType<typeof api.bodies.listPage>;
export type LibraryRow = ListPage['page'][number];
export type ListSummary = FunctionReturnType<typeof api.bodies.listSummary>;
export type PreviewFacts = NonNullable<FunctionReturnType<typeof api.bodies.preview>>;
export type BodyDoc = Extract<
  NonNullable<FunctionReturnType<typeof api.waterBodies.get>>,
  { available: true }
>['body'];
export type PutIns = FunctionReturnType<typeof api.putIns.listForBody>;
export type SubAreas = FunctionReturnType<typeof api.subAreas.listForBody>;
export type BodyHistory = FunctionReturnType<typeof api.bodyConsole.history>;

/** What `bodies.listPage` and `bodies.listSummary` are asked, short of the page cursor. */
export type ListArgs = Omit<FunctionArgs<typeof api.bodies.listPage>, 'paginationOpts'>;
/** The server's order. The page's columns are its columns: `sortArg` doesn't compile otherwise. */
type ListSort = NonNullable<ListArgs['sort']>;

// ── The list ─────────────────────────────────────────────────────────────────────────────────

/** The server lane behind a library lane, or `null` for one no server read lists. */
export function libraryLaneOf(lane: BodyLane): LibraryListLane | null {
  return lane.read.kind === 'library' ? lane.read.lane : null;
}

/** The server's order for the page's: none while a search ranks the list. */
function sortArg(sort: BodySort): ListSort | undefined {
  return sort.column === 'match' ? undefined : { column: sort.column, dir: sort.dir };
}

/**
 * The list read's arguments for the place in the URL, at `now` (the list's clock: *Changed this
 * week* and the season's reports are read against it). `null` for a lane no server read lists.
 */
export function listArgsOf(query: BodiesQuery, now: number): ListArgs | null {
  const lane = libraryLaneOf(query.lane);
  if (lane === null) return null;
  const q = query.q.trim();
  const searching = isSearch(q);
  // A search too short for the server to run ranks nothing: the lane in its own order, not the
  // match's (which the server would answer by name).
  const sort = sortArg(searching || query.sort.column !== 'match' ? query.sort : query.lane.sort);
  const facets = Object.fromEntries(
    FACET_IDS.flatMap((id) => {
      const chosen = query.facets[id];
      return chosen !== undefined && chosen.length > 0 ? [[id, [...chosen]]] : [];
    }),
  ) as NonNullable<ListArgs['facets']>;
  return {
    lane,
    ...(query.state !== null && { state: query.state }),
    // The search as the URL holds it: the server trims, bounds and ignores a short one itself.
    ...(q !== '' && { q }),
    ...(Object.keys(facets).length > 0 && { facets }),
    ...(sort !== undefined && { sort }),
    now,
  };
}

/** A stored library row as the list draws it. */
export function rowFromLibrary(row: LibraryRow): BodyRow {
  return {
    id: row.id,
    name: row.name,
    ...(row.matchedAlias !== undefined && { matchedAlias: row.matchedAlias }),
    bodyClass: row.bodyClass,
    states: row.states,
    areaSqM: row.areaSqM,
    complete: row.complete,
    asks: row.asks,
    ...(row.asksCapped && { asksCapped: true }),
    ...(row.asksWaiting && { asksWaiting: true }),
    reports: row.reports,
    ...(row.reportsCapped && { reportsCapped: true }),
    changedAt: row.changedAt,
    standing: row.standing,
  };
}

/** The paginated hook's status in the list's words. */
export function listStatusOf(status: PaginationStatus): ListStatus {
  switch (status) {
    case 'LoadingFirstPage':
      return 'loading';
    case 'CanLoadMore':
      return 'more';
    case 'LoadingMore':
      return 'fetching';
    case 'Exhausted':
      return 'done';
  }
}

/** While the summary loads (or failed), no control claims more than the list read honors. */
const SERVES_WHILE_UNKNOWN: ListServes = {
  sort: [],
  facets: [...FACET_IDS],
  states: true,
  search: true,
};

/** What the list read honors for this query, from the summary that says so. */
export function servesFrom(summary: ListSummary | undefined): ListServes {
  if (summary === undefined) return SERVES_WHILE_UNKNOWN;
  return {
    sort: summary.serves.sort,
    facets: summary.serves.facets,
    states: summary.serves.states,
    search: summary.serves.search,
  };
}

/**
 * The list from its reads: the pages the paginated hook has gathered, and the summary — `current`
 * for this exact query (the total and the facet counts, never a stale one), `held` the last that
 * landed (what controls the read honors, and the lane's state tabs, which don't move with a
 * filter).
 */
export function listFrom({
  rows,
  status,
  current,
  held,
}: {
  rows: readonly LibraryRow[];
  status: PaginationStatus;
  /** The summary for this query, `undefined` while it loads or if it failed. */
  current: ListSummary | undefined;
  /** The last summary for this lane, if any. */
  held: ListSummary | undefined;
}): BodiesListData {
  return {
    status: listStatusOf(status),
    rows: rows.map(rowFromLibrary),
    // A search answers this lane only; matches in other standings need a read of their own.
    others: [],
    total: current?.total ?? null,
    serves: servesFrom(current ?? held),
    facetCounts: current?.facetCounts ?? null,
    states: (current ?? held)?.states ?? [],
  };
}

/** Each lane's count by the page's lane id, from the summary; `null` where no read counts it. */
export function laneCountsFrom(
  summary: ListSummary | undefined,
  lanes: readonly BodyLane[],
): Record<string, Count | null> {
  const out: Record<string, Count | null> = {};
  for (const lane of lanes) {
    const server = libraryLaneOf(lane);
    out[lane.id] = server === null ? null : (summary?.laneCounts[server] ?? null);
  }
  return out;
}

// ── The preview ──────────────────────────────────────────────────────────────────────────────

type Position = readonly number[];

/** The polygons of a GeoJSON outline as `[lng, lat]` rings; anything else has none. */
export function polygonsOf(
  polygon: BodyDoc['polygon'],
): (readonly (readonly [number, number])[])[][] {
  const ring = (r: readonly Position[]) => r.map((p) => [p[0] ?? 0, p[1] ?? 0] as const);
  if (polygon.type === 'Polygon') return [polygon.coordinates.map(ring)];
  if (polygon.type === 'MultiPolygon') return polygon.coordinates.map((poly) => poly.map(ring));
  return [];
}

/** A recorded area; a body never measured reads `0` or nothing. */
const area = (sqm: number | undefined) => (sqm === undefined || sqm <= 0 ? null : sqm);

/** Staff by first name; the machine by no name (`null`). */
function firstName(actor: BodyHistory['entries'][number]['actor']): string | null {
  if (actor === null) return null;
  const full = actor.displayName.trim() || actor.username;
  return full.split(/\s+/u)[0] ?? full;
}

/** "2 on the ice · 1 from shore": how the season's reports were made, the kinds with any. */
export function vantageWords(byVantage: PreviewFacts['season']['byVantage']): string | null {
  const parts = (['on_ice', 'shore', 'secondhand', 'unstated'] as const)
    .filter((k) => byVantage[k] > 0)
    .map((k) => `${byVantage[k].toLocaleString('en-US')} ${VANTAGE_LABELS[k].toLowerCase()}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Reports this season, as the preview writes them. From 1 July to 30 September the season's record
 * hasn't opened: it is honestly empty, and says when it begins.
 */
export function seasonCount(season: PreviewFacts['season'], now: number): PreviewCount {
  if (!season.recordOpen) {
    const opens = dayMonth(seasonRecordOpensMs(currentSeason(now)), 'UTC');
    return { count: 0, capped: false, sub: `Record begins ${opens}` };
  }
  return { count: season.count, capped: season.capped, sub: vantageWords(season.byVantage) };
}

/** Reports since the record began, and the season of the first ("Since 2023–24"). */
export function allTimeCount(allTime: PreviewFacts['allTime']): PreviewCount {
  return {
    count: allTime.count,
    capped: allTime.capped,
    sub: allTime.firstSeason === null ? null : `Since ${seasonYears(allTime.firstSeason)}`,
  };
}

/** The body's own facts: `undefined` while `bodies.preview` loads, an `Error` if it failed. */
type FactsRead = PreviewFacts | null | undefined | Error;

/** What the preview's reads say about a body. */
export function previewFrom({
  body,
  putIns,
  subAreas,
  history,
  facts,
  now,
}: {
  body: BodyDoc;
  putIns: PutIns | undefined;
  subAreas: SubAreas | undefined;
  /** `null` when the viewer can't read the audit; an `Error` if the read failed. */
  history: BodyHistory | null | undefined | Error;
  facts: FactsRead;
  /** The clock the facts were read against. */
  now: number;
}): BodyPreviewData {
  const ready = facts !== undefined && !(facts instanceof Error) ? facts : null;
  return {
    id: body._id,
    name: body.name,
    bodyClass: body.type,
    states: body.states ?? [],
    town: ready?.town ?? null,
    moreTowns: ready?.moreTowns ?? [],
    centroid: body.centroid,
    outline: {
      polygons: polygonsOf(body.polygon),
      bbox: [body.bbox.minLng, body.bbox.minLat, body.bbox.maxLng, body.bbox.maxLat],
    },
    putIns: putIns === undefined ? null : putIns.map((p) => p.coord),
    bays: subAreas === undefined ? null : subAreas.length,
    areaSqM: area(body.surfaceAreaSqM),
    meanDepthM: body.meanDepthM ?? null,
    maxDepthM: body.maxDepthM ?? null,
    elevationM: body.elevationM ?? null,
    facts: facts === undefined ? 'loading' : facts instanceof Error ? 'error' : 'ready',
    season: ready === null ? null : seasonCount(ready.season, now),
    allTime: ready === null ? null : allTimeCount(ready.allTime),
    // Core's rule, as the stored row holds it; a body with no row yet is not recorded.
    complete: ready?.complete ?? null,
    asks: ready === null ? null : ready.asks.map(askFrom),
    history:
      history instanceof Error
        ? 'error'
        : history == null
          ? null
          : history.entries.map((row) => ({
              id: row.id,
              at: row.createdAt,
              actor: firstName(row.actor),
              words: actionLabel(row.action, row.targetType),
            })),
  };
}
