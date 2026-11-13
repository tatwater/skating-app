import type { api } from '@skating/convex/api';
import { type BodyStanding, standingOf } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { actionLabel } from '../shell/actionLabels';
import {
  answerHeld,
  type BodiesListData,
  type BodyPreviewData,
  groupOthers,
  type HeldRow,
  type ListServes,
  SERVES_NOTHING,
  UNREAD_LIST,
} from './bodiesData';
import type { BodyRow, BodyStandingKey } from './bodiesModel';
import type { BodiesQuery } from './bodiesSearch';
import type { FacetId } from './bodyFacets';
import type { BodyLane } from './bodyLanes';

/**
 * The reads that exist today, turned into what the page draws — pure, so each mapping is tested
 * without Convex. `BodiesRoute` runs the queries and hands their results here.
 *
 * What serves the board today, and what doesn't (each gap is a seam request in the report):
 *
 * - **Dormant, no public access, removed** — `standing.listLane`, newest first, capped at 200. A lane
 *   that came back whole is answered here exactly (search, state, class, size, the order by name,
 *   class, state or acres); a lane that hit the cap is drawn in the read's order with nothing to
 *   narrow it (`capped`), since filtering a page would lie.
 * - **Active, all bodies, the views** — no read lists them. The list says *Not recorded yet*; a
 *   search of two letters or more runs `waterBodies.searchByName` (the top 20, ranked), the active
 *   matches first and the dormant ones under their divider.
 * - **The preview** — `waterBodies.get` (outline, figures), `putIns.listForBody`,
 *   `subAreas.listForBody` and the body's own audit rows (`moderation.listActions`). Reports,
 *   completeness, asks and the town have no read: those blocks are left out.
 */

export type LaneRows = FunctionReturnType<typeof api.standing.listLane>;
export type SearchHits = FunctionReturnType<typeof api.waterBodies.searchByName>;
export type BodyDoc = Extract<
  NonNullable<FunctionReturnType<typeof api.waterBodies.get>>,
  { available: true }
>['body'];
export type PutIns = FunctionReturnType<typeof api.putIns.listForBody>;
export type SubAreas = FunctionReturnType<typeof api.subAreas.listForBody>;
export type ActionRows = FunctionReturnType<typeof api.moderation.listActions>;

/** The `standing.listLane` lane behind a library lane, if one serves it. */
export function standingLaneOf(
  lane: BodyLane,
): 'inactive' | 'not_in_campaign' | 'moderator' | 'no_public_access' | 'removed' | null {
  if (lane.read.kind !== 'standing') return null;
  const [only, ...rest] = lane.read.standings;
  if (only === 'removed' && rest.every((s) => s === 'rejected')) return 'removed';
  if (rest.length > 0) return null;
  switch (only) {
    case 'inactive':
    case 'not_in_campaign':
    case 'moderator':
    case 'no_public_access':
      return only;
    default:
      return null;
  }
}

/** Whether a search runs `waterBodies.searchByName` for this lane (one no lane read serves). */
export function searchesByName(lane: BodyLane): boolean {
  return lane.read.kind === 'standing' && lane.read.standings.includes('active');
}

/** Where a body stands, in the library's keys. */
export function standingKey(standing: BodyStanding): BodyStandingKey {
  switch (standing.standing) {
    case 'active':
      return 'active';
    case 'unlisted':
      return 'rejected';
    case 'removed':
      return 'removed';
    case 'dormant':
      return standing.reason;
  }
}

/** A recorded area; the lane read writes `0` for a body never measured. */
const area = (sqm: number | undefined) => (sqm === undefined || sqm <= 0 ? null : sqm);

/** A `standing.listLane` row as the list holds it. What the read doesn't carry is `null`. */
export function heldFromLane(row: LaneRows['rows'][number]): HeldRow {
  return {
    row: {
      id: row._id,
      name: row.name,
      bodyClass: row.type,
      states: row.states,
      areaSqM: area(row.surfaceAreaSqM),
      complete: null,
      asks: null,
      reports: null,
      changedAt: null,
      standing: standingKey(row.standing),
    },
    facts: {
      outline: null,
      putIns: null,
      curated: row.curatedBoost > 0,
      intake: null,
      awaitingEnrichment: null,
    },
    aliases: [],
  };
}

/** What a lane held whole can answer: only what its rows carry. */
const HELD_SERVES: ListServes = {
  sort: ['name', 'class', 'state', 'acres'],
  facets: ['class', 'size'],
  states: true,
  search: true,
};

/**
 * A `standing.listLane` result as the list. Whole, it answers the query here; capped, it is the
 * read's newest rows in the read's order, with nothing to narrow them.
 */
export function listFromLane(result: LaneRows | undefined, query: BodiesQuery): BodiesListData {
  if (result === undefined) return { ...UNREAD_LIST, status: 'loading', serves: HELD_SERVES };
  const held = result.rows.map(heldFromLane);
  if (result.truncated) {
    return {
      status: 'capped',
      rows: held.map((h) => h.row),
      others: [],
      total: { count: held.length, capped: true },
      serves: SERVES_NOTHING,
      facetCounts: null,
      states: [],
    };
  }
  // A column the rows don't carry can't order them: the read's own order stands.
  const sort =
    query.sort.column !== 'match' && !HELD_SERVES.sort.includes(query.sort.column)
      ? ({ column: 'match' } as const)
      : query.sort;
  // A facet the rows can't answer (a hand-edited link) narrows nothing rather than everything.
  const facets = Object.fromEntries(
    Object.entries(query.facets).filter(([id]) => HELD_SERVES.facets.includes(id as FacetId)),
  );
  return {
    status: 'done',
    others: [],
    serves: HELD_SERVES,
    ...answerHeld(held, { ...query, sort, facets }),
  };
}

/** How many a lane holds, from its read: exact when whole, a floor when capped. */
export function laneCountFrom(result: LaneRows | undefined) {
  if (result === undefined) return null;
  return { count: result.rows.length, capped: result.truncated };
}

/** The shortest search `searchByName` answers. */
export const SEARCH_MIN_CHARS = 2;
/** How many hits it is asked for (its most). */
export const SEARCH_LIMIT = 20;

/** A `searchByName` body hit as a row. */
export function rowFromHit(hit: SearchHits[number]): BodyRow {
  return {
    id: hit.waterBodyId,
    name: hit.name,
    bodyClass: hit.type,
    states: hit.states,
    areaSqM: area(hit.surfaceAreaSqM),
    complete: null,
    asks: null,
    reports: null,
    changedAt: null,
    standing: hit.inactive === true ? 'dormant' : 'active',
  };
}

/**
 * A lane no read lists, searched by name: the active matches as the list (or every match, in a lane
 * that holds every standing), the dormant ones under their divider. Ranked by the search, so no
 * heading sorts it; the top 20 is the search's whole answer.
 */
export function listFromSearch(
  hits: SearchHits | undefined,
  lane: BodyLane,
  q: string,
): BodiesListData {
  const searchOnly: ListServes = { ...SERVES_NOTHING, search: true };
  if (q.trim().length < SEARCH_MIN_CHARS) return { ...UNREAD_LIST, serves: searchOnly };
  if (hits === undefined) return { ...UNREAD_LIST, status: 'loading', serves: searchOnly };
  const rows = hits.filter((h) => h.kind === 'body').map(rowFromHit);
  const holdsAll = lane.read.kind === 'standing' && lane.read.standings.length > 1;
  const here = holdsAll ? rows : rows.filter((r) => r.standing === 'active');
  const others = holdsAll ? [] : groupOthers(rows.filter((r) => r.standing !== 'active'));
  return {
    status: hits.length >= SEARCH_LIMIT ? 'capped' : 'done',
    rows: here,
    others,
    total: { count: here.length, capped: hits.length >= SEARCH_LIMIT },
    serves: searchOnly,
    facetCounts: null,
    states: [],
  };
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

/** Staff by first name; the machine by no name (`null`). */
function firstName(actor: ActionRows[number]['actor']): string | null {
  if (actor === null) return null;
  const full = actor.displayName.trim() || actor.username;
  return full.split(/\s+/u)[0] ?? full;
}

/** What the preview's reads that exist say about a body. */
export function previewFrom({
  body,
  putIns,
  subAreas,
  history,
}: {
  body: BodyDoc;
  putIns: PutIns | undefined;
  subAreas: SubAreas | undefined;
  /** `null` when the viewer can't read the audit. */
  history: ActionRows | null | undefined;
}): BodyPreviewData {
  return {
    id: body._id,
    name: body.name,
    bodyClass: body.type,
    states: body.states ?? [],
    town: null,
    moreTowns: [],
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
    season: null,
    allTime: null,
    complete: null,
    asks: null,
    history:
      history == null
        ? null
        : history.map((row) => ({
            id: row.id,
            at: row.createdAt,
            actor: firstName(row.actor),
            words: actionLabel(row.action, row.targetType),
          })),
    standing: standingKey(standingOf(body)),
  };
}
