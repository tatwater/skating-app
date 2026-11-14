import { z } from 'zod';

import {
  BODY_COLUMNS,
  type BodyColumnId,
  type BodySort,
  FIRST_DIR,
  type SortDir,
} from './bodiesModel';
import { FACET_IDS, FACETS, type FacetId, type FacetSelection } from './bodyFacets';
import { BODY_LANES, type BodyLane, DEFAULT_LANE_ID, laneById } from './bodyLanes';

/**
 * The library's place in the URL — **everything that says where you are**: the lane, the body in
 * the preview, the search (debounced before it lands here), the state tab, the facets and the sort.
 * A reload, a shared link, the back button and a return from the Body console all put the list back
 * exactly as it was.
 *
 * Validated, never trusted: every field `.catch()`es to absent, so a stale or hand-edited link
 * degrades to the default lane instead of an error page. Defaults are written as no param at all
 * (`/admin/bodies` is Active, by reports), and facets are comma lists of option ids
 * (`?size=1000-up&class=lakePond,bay`), each kept in the menu's order with unknown ids dropped.
 *
 * TanStack Router JSON-parses a param that looks like a number, so a text field takes a number
 * back to its string (`?q=123`).
 */

/** The server trims a search past this; the URL never holds more. */
export const SEARCH_MAX_CHARS = 100;
/**
 * The shortest search the server runs (`bodies.ts`' `SEARCH_MIN_CHARS`, not exported to core): the
 * page uses it only for what it draws — a shorter one marks nothing and ranks nothing. The server
 * canonicalizes the search itself; the page never trims it for the read.
 */
export const SEARCH_MIN_CHARS = 2;

/** Whether `q` is a search the server runs — two characters or more, trimmed. */
export const isSearch = (q: string) => q.trim().length >= SEARCH_MIN_CHARS;

const asText = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : undefined;

/** Trimmed and capped; blank, missing or not text is no value at all. */
const optionalText = (max: number) =>
  z.preprocess((raw) => {
    const value = asText(raw)?.trim().slice(0, max);
    return value === undefined || value === '' ? undefined : value;
  }, z.string().optional());

/** A facet's options as a comma list, unknown ids dropped, in the menu's order. */
const facetList = (facet: FacetId) => {
  const known = FACETS.find((f) => f.id === facet)?.options.map((o) => o.id) ?? [];
  return z.preprocess((raw) => {
    const text = asText(raw);
    if (text === undefined) return undefined;
    const ids = new Set(text.split(',').map((s) => s.trim()));
    const kept = known.filter((id) => ids.has(id));
    return kept.length === 0 ? undefined : kept.join(',');
  }, z.string().optional());
};

const facetFields = Object.fromEntries(FACET_IDS.map((id) => [id, facetList(id)])) as Record<
  FacetId,
  ReturnType<typeof facetList>
>;

export const bodiesSearchSchema = z.object({
  lane: z
    .string()
    .refine((id) => BODY_LANES.some((l) => l.id === id) && id !== DEFAULT_LANE_ID)
    .optional()
    .catch(() => undefined),
  /** The body in the preview. */
  body: optionalText(64),
  q: optionalText(SEARCH_MAX_CHARS),
  /** A state tab other than All. */
  state: z.preprocess((raw) => {
    const text = asText(raw)?.trim().toUpperCase();
    return text !== undefined && /^[A-Z]{2}$/.test(text) ? text : undefined;
  }, z.string().optional()),
  sort: z
    .enum(BODY_COLUMNS)
    .optional()
    .catch(() => undefined),
  dir: z
    .enum(['asc', 'desc'])
    .optional()
    .catch(() => undefined),
  ...facetFields,
});

export type BodiesSearch = z.infer<typeof bodiesSearchSchema>;

/** The route's `validateSearch`. */
export function validateBodiesSearch(raw: Record<string, unknown>): BodiesSearch {
  return stripUndefined(bodiesSearchSchema.parse(raw));
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ── The page's view of it ────────────────────────────────────────────────────────────────────

/** Where the library is, as the page reads it: every default filled in. */
export interface BodiesQuery {
  lane: BodyLane;
  /** The body in the preview, if any. */
  bodyId: string | null;
  /** The search text; blank is no search. */
  q: string;
  /** The state tab; `null` is All. */
  state: string | null;
  facets: FacetSelection;
  /** The list's order — `match` while a search ranks it and no heading was pressed. */
  sort: BodySort;
}

export function queryOf(
  search: BodiesSearch,
  lanes: readonly BodyLane[] = BODY_LANES,
): BodiesQuery {
  const lane = laneById(search.lane, lanes);
  const q = search.q ?? '';
  const facets: FacetSelection = {};
  for (const id of FACET_IDS) {
    const list = search[id];
    if (list !== undefined) facets[id] = list.split(',');
  }
  const sort: BodySort =
    search.sort !== undefined
      ? { column: search.sort, dir: search.dir ?? FIRST_DIR[search.sort] }
      : q !== ''
        ? { column: 'match' }
        : lane.sort;
  return { lane, bodyId: search.body ?? null, q, state: search.state ?? null, facets, sort };
}

/** The search that puts the library at `query` — defaults left out, so equal places are equal URLs. */
export function searchFor(query: BodiesQuery): BodiesSearch {
  const out: BodiesSearch = {};
  if (query.lane.id !== DEFAULT_LANE_ID) out.lane = query.lane.id;
  if (query.bodyId !== null) out.body = query.bodyId;
  const q = query.q.trim();
  if (q !== '') out.q = q;
  if (query.state !== null) out.state = query.state;
  for (const id of FACET_IDS) {
    const list = query.facets[id];
    if (list !== undefined && list.length > 0) out[id] = list.join(',');
  }
  const { sort } = query;
  if (sort.column !== 'match') {
    // With a search the lane's own order is a choice (the default is the match), so it is written.
    const isLaneDefault =
      sort.column === query.lane.sort.column && sort.dir === query.lane.sort.dir;
    if (q !== '' || !isLaneDefault) {
      out.sort = sort.column;
      out.dir = sort.dir;
    }
  }
  return out;
}

/** A key for "this list, as it stands" — lane, search, tab, facets and sort, not the selection. */
export function listKey(query: BodiesQuery): string {
  const { body: _body, ...rest } = searchFor(query);
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export type { BodyColumnId, SortDir };
