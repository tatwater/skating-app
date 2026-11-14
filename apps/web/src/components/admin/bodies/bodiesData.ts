import type { Count } from '../overview/overviewModel';
import type { BodyColumnId, BodyRow, Completeness } from './bodiesModel';
import type { FacetCounts, FacetId } from './bodyFacets';

/**
 * What the page is handed — the list, the lanes' counts, the preview — as plain data, so a story
 * draws the page from a board's fixture and the route draws it from the reads (`bodiesReads`).
 *
 * The page never asks the server for the corpus, and never sorts or filters a list itself: the
 * server answers the lane, the state tab, the facets, the search and the order a page at a time
 * (`bodies.listPage`), and says which of them it can honor (`serves`). A control it can't honor is
 * drawn off.
 */

/** Where the list's reading stands. */
export type ListStatus =
  /** No read serves this lane yet: the list says *Not recorded yet*. */
  | 'unread'
  /** The first page is on its way. */
  | 'loading'
  /**
   * More pages wait; the list asks for the next as it nears the end. A page can come back short —
   * even empty — because its scan budget ran out, not because the list ended: it is still `more`.
   */
  | 'more'
  /** The next page is on its way. */
  | 'fetching'
  /** The read reached the end of the list. Only now does the list draw its end. */
  | 'done'
  /** The read failed: the list says so, never that it is empty. */
  | 'error';

/** What the read behind the list can honor. A control it can't is drawn off. */
export interface ListServes {
  /** The columns it sorts by. */
  sort: readonly BodyColumnId[];
  facets: readonly FacetId[];
  /** The state tabs. */
  states: boolean;
  search: boolean;
}

export const SERVES_NOTHING: ListServes = { sort: [], facets: [], states: false, search: false };

/** Matches from another standing, drawn under their own divider ("Dormant 4"). */
export interface BodyGroup {
  key: string;
  label: string;
  rows: readonly BodyRow[];
}

export interface BodiesListData {
  status: ListStatus;
  /** The lane's rows that answer the query, in the order to draw them. */
  rows: readonly BodyRow[];
  /**
   * A search's matches in other standings (board 5.3's "Dormant 4"), or `null` when no read gives
   * them — then neither the group nor the search's tally is drawn, never an empty one or a zero.
   */
  others: readonly BodyGroup[] | null;
  /** How many the list holds after filters, when the read says. */
  total: Count | null;
  serves: ListServes;
  /** The menu's counts; `null` while the read gives none (a search, two facets, loading). */
  facetCounts: FacetCounts | null;
  /** The state tabs, in order (All is always first and is not here). */
  states: readonly string[];
}

export const UNREAD_LIST: BodiesListData = {
  status: 'unread',
  rows: [],
  others: null,
  total: null,
  serves: SERVES_NOTHING,
  facetCounts: null,
  states: [],
};

/** Every row the list draws, in order: the lane's, then each other standing's group. */
export function allRows(list: BodiesListData): BodyRow[] {
  return [...list.rows, ...(list.others ?? []).flatMap((g) => g.rows)];
}

// ── The preview ──────────────────────────────────────────────────────────────────────────────

export interface PreviewAsk {
  id: string;
  /** What kind and from where ("name_bay · asked by 3 · inbox"). */
  kicker: string;
  /** The ask itself ("“Shaker cove”"). */
  title: string;
  sub: string | null;
}

export interface PreviewHistoryRow {
  id: string;
  at: number;
  /** First name for staff; `null` for the machine ("The campaign"). */
  actor: string | null;
  /** What was done, lowercase, past tense ("set curated boost 0.3"). */
  words: string;
}

export interface BodyOutline {
  /** Each polygon's rings, `[lng, lat]`. */
  polygons: readonly (readonly (readonly [number, number])[])[][];
  /** West, south, east, north. */
  bbox: readonly [number, number, number, number];
}

export interface BodyPreviewData {
  id: string;
  name: string;
  bodyClass: string;
  states: readonly string[];
  /** The town it's in ("Enfield"), when a read names one. */
  town: string | null;
  /** Other towns it reaches. */
  moreTowns: readonly string[];
  centroid: { lat: number; lng: number };
  outline: BodyOutline | null;
  putIns: readonly { lat: number; lng: number }[] | null;
  bays: number | null;
  areaSqM: number | null;
  meanDepthM: number | null;
  maxDepthM: number | null;
  elevationM: number | null;
  /**
   * Where the body's own facts stand (`bodies.preview`: the reports, completeness, the asks and the
   * towns): `ready`, on their way, or failed. While not `ready` those blocks are drawn as loading or
   * as the failure — never as zeros.
   */
  facts: 'ready' | 'loading' | 'error';
  /** Reports this season, and how they were made ("2 on the ice · 1 from shore"). */
  season: PreviewCount | null;
  /** Reports since the record began ("Since 2023–24"). */
  allTime: PreviewCount | null;
  complete: Completeness | null;
  asks: readonly PreviewAsk[] | null;
  /** What changed last; `null` for a viewer who can't read the audit, `'error'` when it failed. */
  history: readonly PreviewHistoryRow[] | null | 'error';
}

/** A count of reports in the preview: a floor when the read stopped short, with its sub-line. */
export interface PreviewCount {
  count: number;
  /** The read stopped at its cap: `count` is a floor ("1,000+"). */
  capped: boolean;
  sub: string | null;
}
