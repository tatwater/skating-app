import {
  INBOX_AGE_FLOORS_DAYS,
  INBOX_FACETS,
  INBOX_LANES,
  INBOX_LIST_LANES,
  type InboxLane,
  type InboxListLane,
  isInboxFacet,
} from '@skating/core';

import { ID_SHAPE } from '../reads/readArgs';

/**
 * **The Inbox's place in the URL** (`/admin/inbox`) — everything a reload, a shared link, the back
 * button and a link from another mode must keep: which list (`lane`, `facet`, the filter), which
 * item is open (`item`), and where ⇧⏎ goes back to (`from`). Validated like the Body console's
 * search, never trusted — an unknown value falls back or is dropped, never throws:
 *
 * - **`lane`** — `all` (the default, written as no param), a lane, or `decided`: the Overview's
 *   `InboxLane` names, so its links land as they are. `support` for a viewer without support's read
 *   reads as `all` ({@link queryOf}, which knows the viewer).
 * - **`facet`** — the lane's tab; one the lane doesn't have is dropped (`all` is no param).
 * - **`item`** — an item's id or a source ref (`flag:`, `request:`, `body:`, `ticket:` and an id of
 *   word characters); a bare id (the audit feed's `?item=<id>`) is passed as it is, and the server
 *   tries it as each source. Anything else is dropped.
 * - **`body`**, **`about`** (a person), **`age`** (days) — the filter menu's; each only if well
 *   formed. The list's read takes one filter, so a link carrying more keeps the first of body,
 *   person, age.
 * - **`from`** — a return path for ⇧⏎, kept only when it is a same-origin path under
 *   {@link RETURN_PATHS} (the Overview, People, the Corpus list, a Body console).
 *
 * TanStack Router JSON-parses a param that looks like a number or a boolean, so text params take a
 * number back to its string and `age` takes its string to a number.
 */

/** The list `/admin/inbox` opens on, written as no param. */
export const DEFAULT_LANE: InboxListLane = 'all';

/** A source ref's kinds — the prefixes `inbox.item` resolves. */
export const ITEM_REF_KINDS = ['flag', 'request', 'body', 'ticket'] as const;

/** An item's id, a source ref, or a bare id of word characters. */
const ITEM_REF = /^(?:(?:flag|request|body|ticket):)?\w{1,64}$/;

/** Where ⇧⏎ may return to: the Overview (exactly), and the trees of People, Corpus and each body. */
export const RETURN_PATHS = ['/admin/people', '/admin/corpus', '/admin/body'] as const;
const OVERVIEW = '/admin';
const MAX_FROM = 2048;

/** What the route keeps: each only if valid, defaults left out. */
export type InboxSearch = {
  lane?: Exclude<InboxListLane, 'all'>;
  facet?: string;
  item?: string;
  body?: string;
  about?: string;
  age?: number;
  from?: string;
};

const asText = (raw: unknown): string | undefined =>
  typeof raw === 'string'
    ? raw
    : typeof raw === 'number' || typeof raw === 'boolean'
      ? String(raw)
      : undefined;

export function isListLane(value: unknown): value is InboxListLane {
  return typeof value === 'string' && (INBOX_LIST_LANES as readonly string[]).includes(value);
}

export function isInboxLane(value: unknown): value is InboxLane {
  return typeof value === 'string' && (INBOX_LANES as readonly string[]).includes(value);
}

/** An item ref the page may hand the server: an id, a source ref, or a bare id. */
export function isItemRef(value: unknown): value is string {
  return typeof value === 'string' && ITEM_REF.test(value);
}

/** An age floor the filter menu offers, from a number or its string. */
export function ageFloorOf(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return (INBOX_AGE_FLOORS_DAYS as readonly number[]).includes(n) ? n : undefined;
}

/**
 * A return path ⇧⏎ may navigate to: same-origin, the Overview or under one of
 * {@link RETURN_PATHS}, its search and hash kept. Returns the normalized path, or `null`.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FROM) return null;
  // A path, and only a path: no scheme, no host, no `//` or `\` that a browser reads as one.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://console.invalid');
  } catch {
    /* v8 ignore next 2 — a path that starts with one slash always parses against a base */
    return null;
  }
  if (url.origin !== 'https://console.invalid') return null;
  const path = url.pathname;
  const allowed =
    path === OVERVIEW ||
    path === `${OVERVIEW}/` ||
    RETURN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  return allowed ? `${path}${url.search}${url.hash}` : null;
}

/** The route's `validateSearch`: keeps what is valid, drops everything else. */
export function validateInboxSearch(raw: Record<string, unknown>): InboxSearch {
  const out: InboxSearch = {};
  const lane = asText(raw.lane);
  const listLane: InboxListLane = isListLane(lane) ? lane : DEFAULT_LANE;
  if (listLane !== DEFAULT_LANE) out.lane = listLane as Exclude<InboxListLane, 'all'>;
  const facet = asText(raw.facet);
  if (
    facet !== undefined &&
    facet !== 'all' &&
    isInboxLane(listLane) &&
    isInboxFacet(listLane, facet)
  ) {
    out.facet = facet;
  }
  const item = asText(raw.item);
  if (isItemRef(item)) out.item = item;
  // One filter: the list's read takes one, so the first well-formed of body, person, age is kept.
  const body = asText(raw.body);
  const about = asText(raw.about);
  const age = ageFloorOf(raw.age);
  if (body !== undefined && ID_SHAPE.test(body)) out.body = body;
  else if (about !== undefined && ID_SHAPE.test(about)) out.about = about;
  else if (age !== undefined) out.age = age;
  const from = safeReturnPath(raw.from);
  if (from !== null) out.from = from;
  return out;
}

// ── The page's view of it ────────────────────────────────────────────────────────────────────

/** The list's one filter, as the page holds it. */
export type InboxFilter =
  | { kind: 'body'; id: string }
  | { kind: 'about'; id: string }
  | { kind: 'age'; days: number };

/** Where the Inbox is, as the page reads it: every default filled in. */
export interface InboxQuery {
  lane: InboxListLane;
  /** The lane's tab; `all` for none (and always for `all` and `decided`). */
  facet: string;
  filter: InboxFilter | null;
  item: string | null;
  from: string | null;
}

/**
 * The page's place from the URL. A lane the viewer doesn't have (Support, without support's read)
 * is All open, as an unknown one is — never an error — and its facet goes with it.
 */
export function queryOf(search: InboxSearch, canReadSupport: boolean): InboxQuery {
  const asked = isListLane(search.lane) ? search.lane : DEFAULT_LANE;
  const lane = asked === 'support' && !canReadSupport ? DEFAULT_LANE : asked;
  const facet =
    search.facet !== undefined && isInboxLane(lane) && isInboxFacet(lane, search.facet)
      ? search.facet
      : 'all';
  const filter: InboxFilter | null =
    search.body !== undefined
      ? { kind: 'body', id: search.body }
      : search.about !== undefined
        ? { kind: 'about', id: search.about }
        : search.age !== undefined
          ? { kind: 'age', days: search.age }
          : null;
  return {
    lane,
    facet,
    filter,
    item: search.item ?? null,
    from: search.from ?? null,
  };
}

/** The search that puts the page at `query` — defaults left out, so equal places are equal URLs. */
export function searchFor(query: InboxQuery): InboxSearch {
  const out: InboxSearch = {};
  if (query.lane !== DEFAULT_LANE) out.lane = query.lane as Exclude<InboxListLane, 'all'>;
  if (query.facet !== 'all' && isInboxLane(query.lane) && isInboxFacet(query.lane, query.facet)) {
    out.facet = query.facet;
  }
  if (query.item !== null && isItemRef(query.item)) out.item = query.item;
  if (query.filter?.kind === 'body') out.body = query.filter.id;
  else if (query.filter?.kind === 'about') out.about = query.filter.id;
  else if (query.filter?.kind === 'age') out.age = query.filter.days;
  if (query.from !== null) out.from = query.from;
  return out;
}

/** The facets a list lane has: a lane's tabs; none for All open and Decided. */
export function facetsOf(lane: InboxListLane): readonly string[] {
  return isInboxLane(lane) ? INBOX_FACETS[lane] : [];
}

/** The filter as `inbox.listPage` takes it. */
export function serverFilter(
  filter: InboxFilter | null,
): { waterBodyId: string } | { subjectUserId: string } | { minAgeDays: number } | undefined {
  if (filter === null) return undefined;
  switch (filter.kind) {
    case 'body':
      return { waterBodyId: filter.id };
    case 'about':
      return { subjectUserId: filter.id };
    case 'age':
      return { minAgeDays: filter.days };
  }
}

/** A key for "this list, as it stands": the lane, its tab and its filter — not the open item. */
export function listKey(query: InboxQuery): string {
  const f = query.filter;
  const filter = f === null ? '' : f.kind === 'age' ? `age:${f.days}` : `${f.kind}:${f.id}`;
  return `${query.lane}|${query.facet}|${filter}`;
}

/**
 * The page's own path for `query`, as a link writes it (an item's return, a story's address). A path
 * for a link, never navigated to as an `href`: the router reads a string query with JSON's rules.
 */
export function inboxHref(query: InboxQuery): string {
  const search = searchFor(query);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) params.set(k, String(v));
  const text = params.toString();
  return `/admin/inbox${text === '' ? '' : `?${text}`}`;
}

/**
 * **Where a change of list leaves the open item.** Another lane, tab or filter closes an item the
 * operator opened from the list: it was a row of the list being left, and the new list may not hold
 * it — an item sitting open beside a list that doesn't contain it reads as a row lost. An item that
 * came by a direct link (`?item=`, from People, a body, the audit feed) stays open while the list
 * beside it changes: the link was about the item, not the list. The same list (a change that moves
 * nothing) keeps whatever is open.
 */
export function placeAfter(
  current: InboxQuery,
  next: InboxQuery,
  openedFromList: boolean,
): InboxQuery {
  const listChanged = listKey(next) !== listKey(current);
  return listChanged && openedFromList ? { ...next, item: null } : next;
}
