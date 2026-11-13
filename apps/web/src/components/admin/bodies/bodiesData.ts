import type { Count } from '../overview/overviewModel';
import {
  type BodyColumnId,
  type BodyRow,
  type BodyStandingKey,
  type Completeness,
  sortRows,
  standingGroupWord,
} from './bodiesModel';
import type { BodiesQuery } from './bodiesSearch';
import {
  type BodyFacts,
  FACET_IDS,
  type FacetCounts,
  type FacetId,
  matchesSelection,
  optionsOf,
} from './bodyFacets';
import { matchParts } from './kit-candidates/search-mark';

/**
 * What the page is handed — the list, the lanes' counts, the preview — and the one rule for
 * answering a query over a lane held **whole** (`answerHeld`).
 *
 * The page never asks the server for the corpus, and never filters after a page: a read either
 * answers the query itself (sort, facets, search — the seam the route files) or hands over a lane
 * small enough to hold whole, and only then does the client sort and filter it. A read that stopped
 * at its cap (`capped`) answers nothing locally: its rows are drawn in the read's own order with the
 * controls it can't honor turned off.
 */

/** Where the list's reading stands. */
export type ListStatus =
  /** No read serves this lane yet: the list says *Not recorded yet*. */
  | 'unread'
  | 'loading'
  /** More pages wait; the list asks for them as it scrolls. */
  | 'more'
  | 'done'
  /** The read stopped at its cap: these are its newest, not the lane. */
  | 'capped';

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
  /** A search's matches in other standings. */
  others: readonly BodyGroup[];
  /** How many the list holds after filters, when the read says. */
  total: Count | null;
  serves: ListServes;
  facetCounts: FacetCounts | null;
  /** The state tabs, in order (All is always first and is not here). */
  states: readonly string[];
}

export const UNREAD_LIST: BodiesListData = {
  status: 'unread',
  rows: [],
  others: [],
  total: null,
  serves: SERVES_NOTHING,
  facetCounts: null,
  states: [],
};

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
  /** Reports this season, and how they were made ("2 on the ice · 1 from shore"). */
  season: { count: number; sub: string | null } | null;
  /** Reports since the record began ("Since 2023–24"). */
  allTime: { count: number; sub: string | null } | null;
  complete: Completeness | null;
  asks: readonly PreviewAsk[] | null;
  history: readonly PreviewHistoryRow[] | null;
  standing: BodyStandingKey;
}

// ── Answering a query over a lane held whole ─────────────────────────────────────────────────

/** A row of a held lane, with what its facets need. */
export interface HeldRow {
  row: BodyRow;
  facts: BodyFacts;
  /** Aliases, for the search. */
  aliases: readonly string[];
}

const matches = (text: string, q: string) => matchParts(text, q).some((p) => p.match);

/**
 * Answers `query` over a lane **held whole** (a read that returned every row, not a page): the
 * search over names and aliases, the state tab, the facets, then the order. Every count it returns
 * is exact. Only lanes whose read finished uncapped come here.
 */
export function answerHeld(
  held: readonly HeldRow[],
  query: Pick<BodiesQuery, 'q' | 'state' | 'facets' | 'sort'>,
): Pick<BodiesListData, 'rows' | 'total' | 'facetCounts' | 'states'> {
  const q = query.q.trim();
  const searched = held.flatMap(({ row, facts, aliases }) => {
    if (q === '' || matches(row.name, q)) return [{ row, facts }];
    const alias = aliases.find((a) => matches(a, q));
    return alias === undefined ? [] : [{ row: { ...row, matchedAlias: alias }, facts }];
  });
  // The state tabs: every state the search leaves, in order of how many bodies touch it.
  const perState = new Map<string, number>();
  for (const { row } of searched) {
    for (const s of row.states) perState.set(s, (perState.get(s) ?? 0) + 1);
  }
  const states = [...perState.entries()]
    .sort(([a, na], [b, nb]) => nb - na || a.localeCompare(b))
    .map(([s]) => s);
  const inState = searched.filter(
    ({ row }) => query.state === null || row.states.includes(query.state),
  );
  const kept = inState.filter(({ row, facts }) => matchesSelection(row, facts, query.facets));
  // The menu's counts: what each option would leave with the other facets as they are.
  const facetCounts: FacetCounts = {};
  for (const facet of FACET_IDS) {
    const others = { ...query.facets, [facet]: undefined };
    const counts: Record<string, number> = {};
    for (const { row, facts } of inState) {
      if (!matchesSelection(row, facts, others)) continue;
      for (const option of optionsOf(row, facts, facet) ?? []) {
        counts[option] = (counts[option] ?? 0) + 1;
      }
    }
    facetCounts[facet] = counts;
  }
  return {
    rows: sortRows(
      kept.map(({ row }) => row),
      query.sort,
    ),
    total: { count: kept.length, capped: false },
    facetCounts,
    states,
  };
}

/** A search's other standings, grouped under one divider per word ("Dormant", "Removed"). */
export function groupOthers(rows: readonly BodyRow[]): BodyGroup[] {
  const groups: BodyGroup[] = [];
  for (const row of rows) {
    const label = standingGroupWord(row.standing);
    const group = groups.find((g) => g.label === label);
    if (group) (group.rows as BodyRow[]).push(row);
    else groups.push({ key: label.toLowerCase(), label, rows: [row] });
  }
  return groups;
}
