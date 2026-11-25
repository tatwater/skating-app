import { ID_SHAPE } from '../reads/readArgs';
import { type TaskFacetTab, type TaskLaneEntry, taskLaneById } from './taskLanes';

/**
 * **A task lane's place in the URL** — the lane, its tab, the open task and the search — validated,
 * never trusted. `bodiesSearch.ts` (the route's `validateSearch`) imports it for the two fields a
 * task lane adds to the library's search:
 *
 * - **`tab`**: one of the lane's facet tabs (never `notRecorded`, which reads under *All* only), or
 *   `decided` (the lane's decided tasks, newest first). Absent is *All*; anything else is dropped.
 * - **`item`**: the task in the inspector — a `corpusTasks` id, or `body:<id>` (the body's task in
 *   this lane: the Body console's and the audit feed's way in). Anything else is dropped.
 *
 * On a task lane the library's `body`, `state`, `sort`, `dir` and facets are dropped; on a library
 * lane `tab` and `item` are (`validateBodiesSearch`).
 */

/** The longest `tab` the URL holds (the schema's cap). */
export const TAB_MAX_CHARS = 24;
/** The longest `item` the URL holds: `body:` and an id. */
export const ITEM_MAX_CHARS = 80;

/** The lane's decided tasks, as a tab. */
export const DECIDED_TAB = 'decided';

/** A tab: one of the lane's facets, or its decided tasks. `null` is *All*. */
export type TaskTab = TaskFacetTab | typeof DECIDED_TAB;

/** The tab `raw` names on `lane`, or `null` (*All*) for none, junk, or another lane's. */
export function taskTabOf(lane: TaskLaneEntry, raw: unknown): TaskTab | null {
  if (typeof raw !== 'string') return null;
  if (raw === DECIDED_TAB) return DECIDED_TAB;
  return lane.tabs.find((t) => t.id === raw)?.id ?? null;
}

/** The body ref an `item` may name: `body:` and a Convex id. */
const BODY_REF = /^body:([0-9a-z]{30,34})$/;

/** The task `raw` names — a task id or `body:<id>` — or `null` for anything else. */
export function taskItemOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return ID_SHAPE.test(text) || BODY_REF.test(text) ? text : null;
}

/** Whether a ref names a body (`body:<id>`), which the item read resolves with the lane. */
export const isBodyRef = (ref: string): boolean => BODY_REF.test(ref);

/** Where a task lane is, as the page reads it: every default filled in. */
export interface TaskQuery {
  lane: TaskLaneEntry;
  /** The tab; `null` is *All*. */
  tab: TaskTab | null;
  /** The open task, if any. */
  item: string | null;
  /** The search text; blank is no search. */
  q: string;
}

/** What a task lane's place is written as (a slice of the route's search). */
export type TaskSearch = { lane: string; tab?: string; item?: string; q?: string };

/** The task lane's place, or `null` when the search names no task lane. */
export function taskQueryOf(search: {
  lane?: unknown;
  tab?: unknown;
  item?: unknown;
  q?: unknown;
}): TaskQuery | null {
  const lane = taskLaneById(typeof search.lane === 'string' ? search.lane : undefined);
  if (lane === null) return null;
  return {
    lane,
    tab: taskTabOf(lane, search.tab),
    item: taskItemOf(search.item),
    q:
      typeof search.q === 'string'
        ? search.q
        : typeof search.q === 'number'
          ? String(search.q)
          : '',
  };
}

/** The search that puts the page at `query` — defaults left out, so equal places are equal URLs. */
export function taskSearchFor(query: TaskQuery): TaskSearch {
  const q = query.q.trim();
  return {
    lane: query.lane.id,
    ...(query.tab !== null && { tab: query.tab }),
    ...(query.item !== null && { item: query.item }),
    ...(q !== '' && { q }),
  };
}

/** A key for "this list, as it stands" — lane, tab and search, not the open task. */
export function taskListKey(query: TaskQuery): string {
  return JSON.stringify([query.lane.id, query.tab, query.q.trim()]);
}

/**
 * **Where a change of list leaves the open task** (the Inbox's rule): another tab or search closes a
 * task opened from the list — the new list may not hold it — and keeps one that came by a link.
 */
export function placeAfter(
  current: TaskQuery,
  next: TaskQuery,
  openedFromList: boolean,
): TaskQuery {
  const listChanged = taskListKey(next) !== taskListKey(current);
  return listChanged && openedFromList ? { ...next, item: null } : next;
}
