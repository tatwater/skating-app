import {
  isPeopleLane,
  normalizePeopleListArgs,
  PEOPLE_SEARCH_MAX_CHARS,
  type PeopleLane,
} from '@skating/core';
import { z } from 'zod';

/**
 * The People list's place in the URL — the lane and the search, everything that says which list is
 * on screen. A reload, a shared link, the back button and a return from a person's page all put the
 * list back as it was. The person open beside the list is the path (`/admin/people/$id`), never a
 * param, so the same two params ride along when a person opens and come back when one closes.
 *
 * Validated, never trusted: an unknown lane (a stale link, a lane renamed) falls back to Everyone,
 * a blank or overlong search is trimmed to nothing or to the server's limit, and the default lane
 * is no param at all (`/admin/people` is Everyone).
 *
 * TanStack Router JSON-parses a param that looks like a number, so a search takes a number back to
 * its string (`?q=123`).
 */

/** The lane `/admin/people` opens on, written as no param. */
export const DEFAULT_LANE: PeopleLane = 'everyone';

const asText = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : undefined;

export const peopleSearchSchema = z.object({
  lane: z.preprocess((raw) => {
    const text = asText(raw);
    return text !== undefined && isPeopleLane(text) && text !== DEFAULT_LANE ? text : undefined;
  }, z.string().optional()),
  q: z.preprocess((raw) => {
    const text = asText(raw)?.trim().slice(0, PEOPLE_SEARCH_MAX_CHARS).trim();
    return text === undefined || text === '' ? undefined : text;
  }, z.string().optional()),
});

export type PeopleSearch = z.infer<typeof peopleSearchSchema>;

/** The route's `validateSearch` — the list route's, and the person route's beside it. */
export function validatePeopleSearch(raw: Record<string, unknown>): PeopleSearch {
  const parsed = peopleSearchSchema.parse(raw);
  const out: PeopleSearch = {};
  if (parsed.lane !== undefined) out.lane = parsed.lane;
  if (parsed.q !== undefined) out.q = parsed.q;
  return out;
}

// ── The page's view of it ────────────────────────────────────────────────────────────────────

/** Where the list is, as the page reads it: every default filled in. */
export interface PeopleQuery {
  /** The lane — kept while a search runs, so clearing the search goes back to it. */
  lane: PeopleLane;
  /** The search as typed; blank is no search. */
  q: string;
}

/**
 * The page's place from the URL. A lane the viewer doesn't have (Appeals open, for a moderator:
 * support tickets are an admin's to read) is Everyone, as an unknown one is — never an error.
 */
export function queryOf(search: PeopleSearch, lanes?: readonly PeopleLane[]): PeopleQuery {
  const asked = search.lane !== undefined && isPeopleLane(search.lane) ? search.lane : DEFAULT_LANE;
  const lane = lanes === undefined || lanes.includes(asked) ? asked : DEFAULT_LANE;
  return { lane, q: search.q ?? '' };
}

/** The search that puts the list at `query` — defaults left out, so equal places are equal URLs. */
export function searchFor(query: PeopleQuery): PeopleSearch {
  const out: PeopleSearch = {};
  if (query.lane !== DEFAULT_LANE) out.lane = query.lane;
  const q = query.q.trim();
  if (q !== '') out.q = q;
  return out;
}

/**
 * The search the server runs for `q` — trimmed, its inner space folded, a leading `@` dropped
 * (core's rule, the one `people.listPage` applies) — or `null` for none. The page marks matches
 * with this, so a pasted `@handle` marks the handle it found.
 */
export function serverSearch(q: string): string | null {
  return normalizePeopleListArgs({ lane: DEFAULT_LANE, search: q })?.search ?? null;
}

/** Whether the list on screen is a search (the server ignores the lane while one runs). */
export const isSearching = (query: PeopleQuery): boolean => serverSearch(query.q) !== null;

/** A key for "this list, as it stands": the lane, or the search over every account. */
export function listKey(query: PeopleQuery): string {
  const search = serverSearch(query.q);
  return search === null ? `lane:${query.lane}` : `search:${search}`;
}

/** The list's own path for `query` — where a person's page returns to. */
export function peopleListHref(query: PeopleQuery): string {
  return `/admin/people${queryString(searchFor(query))}`;
}

/** A person's page, carrying the list's place so it can come back to it. */
export function personHref(id: string, query: PeopleQuery): string {
  return `/admin/people/${encodeURIComponent(id)}${queryString(searchFor(query))}`;
}

function queryString(search: PeopleSearch): string {
  const params = new URLSearchParams();
  if (search.lane !== undefined) params.set('lane', search.lane);
  if (search.q !== undefined) params.set('q', search.q);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
