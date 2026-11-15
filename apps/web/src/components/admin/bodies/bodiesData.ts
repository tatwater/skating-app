import type { DepthSource } from '@skating/core';
import type { Removal } from '../body/frame/bodyModel';
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
  /** Its best matches (the server's five). */
  rows: readonly BodyRow[];
  /** How many match in all, counted to the server's bound; `capped`: a floor ("50+"). */
  count?: number;
  capped?: boolean;
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
  /**
   * The other standings' search ignores the lane's facets (`facetsIgnored`): said plainly, so a
   * tally that counts across them is never read as filtered.
   */
  othersFacetsIgnored?: boolean;
  /** How many the list holds after filters, when the read says. */
  total: Count | null;
  serves: ListServes;
  /** The list's read failed and Try again was pressed: hold the note as *Trying again…*. */
  retryPending?: boolean;
  /** The menu's counts; `null` while the read gives none (a search, two facets, loading). */
  facetCounts: FacetCounts | null;
  /** The state tabs, in order (All is always first and is not here). */
  states: readonly string[];
  /**
   * Opened recently's ids the library didn't list: `unlisted` — a body with no library row;
   * `unknown` — no such body; `dropped` — past what one read takes. Said at the list's end.
   */
  notListed?: { unlisted: number; unknown: number; dropped: number };
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

/**
 * What a removed or rejected body's record still holds (`bodyConsole.removedFacts`), for the
 * preview's page in place of the full preview.
 */
export interface RemovedPreviewData {
  name: string;
  bodyClass: string;
  states: readonly string[];
  /** `null` — not recorded. */
  areaSqM: number | null;
  /** `null` — the library files it under no standing. */
  standing: BodyRow['standing'] | null;
  /** How it left (when, who, why); `null` when no row says. */
  left: Removal | null;
  /** Its towns, each with its state when recorded; `null` — not computed yet. */
  towns: readonly string[] | null;
  /** Visible reports, a floor when capped. */
  reports: Count;
}

/** One intake review reason on the body, worded ("Possible duplicate", "Overlaps 2 bodies"). */
export interface PreviewIntake {
  reason: string;
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
  /** The body's towns aren't computed yet (`townsComputedAt` unset): not the same as no town. */
  townsNotComputed?: boolean;
  /** `town`'s state, when the read says ("NH"); `null` — not recorded, never inferred. */
  townState?: string | null;
  /** Other towns it reaches, each with its state when the read says. */
  moreTowns: readonly { name: string; state: string | null }[];
  centroid: { lat: number; lng: number };
  outline: BodyOutline | null;
  putIns: readonly { lat: number; lng: number }[] | null;
  bays: number | null;
  areaSqM: number | null;
  meanDepthM: number | null;
  maxDepthM: number | null;
  /**
   * Where each depth came from (`null` when the record doesn't say): only a measured source reads
   * plainly; a modeled or unrecorded one is an estimate, written "~8.1" (D3).
   */
  meanDepthSource?: DepthSource | null;
  maxDepthSource?: DepthSource | null;
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
  /** The body's intake review reasons, worst first; `null` while the facts aren't in. */
  intake?: readonly PreviewIntake[] | null;
  /** How many asks are open in all (a floor when capped); `null` while the facts aren't in. */
  askCount: Count | null;
  /** `asks` is the newest of them, not all: the list says "Newest 20 of 21", never reads whole. */
  asksPartial: boolean;
  /** What changed last; `null` for a viewer who can't read the audit, `'error'` when it failed. */
  history: readonly PreviewHistoryRow[] | null | 'error';
  /** `history` is the newest of more: its count is a floor ("7+"), never the whole. */
  historyCapped?: boolean;
  /**
   * The put-ins or bays read failed: the still draws neither, and says so — a failure never drawn
   * like a body that has none.
   */
  marksError?: boolean;
}

/** A count of reports in the preview: a floor when the read stopped short, with its sub-line. */
export interface PreviewCount {
  count: number;
  /** The read stopped at its cap: `count` is a floor ("1,000+"). */
  capped: boolean;
  sub: string | null;
}
