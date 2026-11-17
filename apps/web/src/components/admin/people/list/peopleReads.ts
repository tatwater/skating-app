import { api } from '@skating/convex/api';
import { PEOPLE_PAGE_MAX, PEOPLE_PAGE_SIZE, type PeopleLane } from '@skating/core';
import { useEffect, useMemo, useRef } from 'react';

import {
  isFailed,
  type Loadable,
  loaded,
  type ReadFailure,
  read,
  useConsoleReadSet,
} from '../../reads/consoleReads';
import { useHeldRead } from '../../shell/presence';
import { mustSplit } from './pageChain';
import type { Backfill, LanesRead, PartialReason, PeoplePage, PersonListRow } from './peopleModel';
import { useChainedPages } from './useChainedPages';

/**
 * The People list's reads, through the console's one read layer (`reads/consoleReads`): each read
 * is on its way, failed (with *Try again*, held as *Trying again…* until the fresh answer), or its
 * value — never a throw, so a failed read takes down its own block and nothing else.
 *
 * - **The lanes** (`people.lanes`): held through a change of list, so the sidebar's counts don't
 *   blink out while the next answer comes — but never past a failure: a failed or retrying read
 *   shows no count at all.
 * - **The list** (`people.listPage`) is a chain of pages, each read asked with the cursor the page
 *   before it ended on. `listPage` takes a cursor and a page size and answers with its rows and the
 *   page's own `partial`, `reasons` and `pending` — not Convex's paginated contract, so it can't go
 *   through `usePaginatedQuery`, which would drop those three anyway. Each page is a subscription,
 *   and the chain is stitched as Convex's own is (`pageChain`): a page read past is pinned to where
 *   it ended (`endCursor`), so a person joining or leaving it moves nothing on the pages after it.
 *   While a page is pinned its rows stand from its last answer, which covered exactly that range
 *   (`useChainedPages`, which the record sheet's lists read too).
 */

// ── The lanes ────────────────────────────────────────────────────────────────────────────────

export interface LanesState {
  /** The read for this clock: on its way, failed, or its answer. */
  state: Loadable<LanesRead>;
  /** This answer, or the last one that landed while this one is on its way; never after a failure. */
  shown: LanesRead | undefined;
}

export function usePeopleLanes(now: number, enabled: boolean): LanesState {
  const { reads } = useConsoleReadSet({
    lanes: enabled ? read(api.people.lanes, { now }) : null,
  });
  const state = reads.lanes;
  // A failure (or a read no longer asked for) forgets what was held, so nothing past it shows.
  return { state, shown: useHeldRead(loaded(state), !enabled || isFailed(state)) };
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────

/** How many rows each list was showing, this tab (a list is its `listKey`). */
const shownMemory = new Map<string, number>();

/** Forget every list's row count (stories and tests start clean). */
export function resetShownMemory(): void {
  shownMemory.clear();
}

/**
 * The first page a list asks for: the page size, or as many rows as it was showing when it was
 * left (up to the server's largest page), so the remembered scroll lands where it was.
 */
export function startingPageSize(memoryKey: string): number {
  return Math.min(PEOPLE_PAGE_MAX, Math.max(PEOPLE_PAGE_SIZE, shownMemory.get(memoryKey) ?? 0));
}

export type ListStatus =
  /** No read is made: the viewer can't read people. */
  | 'unread'
  /** The first page is on its way. */
  | 'loading'
  /** A page failed (the first: no rows; a later one: the rows so far). */
  | 'error'
  /** A next page is on its way. */
  | 'fetching'
  /** More to come, not yet asked for. */
  | 'more'
  /** Every row is in. */
  | 'done';

export interface PagesState {
  status: ListStatus;
  rows: PersonListRow[];
  /** What the pages read may be missing, by reason (every page's, joined). */
  reasons: PartialReason[];
  /** Backfills the pages rest on that haven't finished (every page's, joined). */
  pending: Backfill[];
  /** The failed page's retry, held as pending after *Try again*. */
  failure: ReadFailure | null;
  /** Ask for the next page, when there is one and none is on its way. */
  loadMore: () => void;
}

export interface PagesArgs {
  lane: PeopleLane;
  /** The search as the URL holds it; the server trims it and ignores the lane while it runs. */
  search: string | null;
  now: number;
  /** This list, as it stands: the chain starts over when it changes. */
  memoryKey: string;
}

const BACKFILL_ORDER: readonly Backfill[] = ['rows', 'flagSubjects', 'undoChains'];

export function usePeoplePages(args: PagesArgs | null): PagesState {
  const key = args === null ? '' : args.memoryKey;
  // Read once per list: the size only starts a list.
  const firstSize = useMemo(() => startingPageSize(key), [key]);
  // The pages asked for, for this list: the first starts at `null`; each read past is pinned.
  const { pages, loadMore, retry, retrying } = useChainedPages<PeoplePage>(
    key,
    args === null
      ? null
      : (link, i) =>
          read(api.people.listPage, {
            lane: args.lane,
            ...(args.search !== null && { search: args.search }),
            cursor: link.cursor,
            ...(link.end !== null && { endCursor: link.end }),
            pageSize: i === 0 ? firstSize : PEOPLE_PAGE_SIZE,
            now: args.now,
          }),
  );

  // Joined once per change of a page, so the rows (and the list drawn from them) keep their
  // identity through every render that changes no page — a minute's tick, a registry emit.
  const joined = useJoined(args === null ? null : pages);
  const { rows } = joined;
  const failure: ReadFailure | null = joined.failed
    ? { failed: true, pending: retrying, retry }
    : null;

  useEffect(() => {
    if (key !== '' && rows.length > 0) shownMemory.set(key, rows.length);
  }, [key, rows.length]);

  return {
    status: joined.status,
    rows,
    reasons: joined.reasons,
    pending: joined.pending,
    failure,
    loadMore,
  };
}

type Joined = {
  status: ListStatus;
  rows: PersonListRow[];
  reasons: PartialReason[];
  pending: Backfill[];
  failed: boolean;
};

/** The pages joined into one list — recomputed only when a page itself changed. */
function useJoined(pages: readonly Loadable<PeoplePage>[] | null): Joined {
  const cache = useRef<{ pages: readonly Loadable<PeoplePage>[] | null; value: Joined } | null>(
    null,
  );
  const last = cache.current;
  if (last !== null && samePages(last.pages, pages)) return last.value;
  const value = joinPages(pages);
  cache.current = { pages, value };
  return value;
}

function samePages(
  a: readonly Loadable<PeoplePage>[] | null,
  b: readonly Loadable<PeoplePage>[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/**
 * The chain's rows in order, each person once (a page re-read from a new start can still hold a
 * row the next page holds), what every page read says it may be missing, and where the chain stops:
 * a failed page (the rows before it stand), a page on its way or to be split, or the last page's end.
 */
export function joinPages(pages: readonly Loadable<PeoplePage>[] | null): Joined {
  if (pages === null)
    return { status: 'unread', rows: [], reasons: [], pending: [], failed: false };
  const rows: PersonListRow[] = [];
  const seen = new Set<string>();
  const reasons = new Set<PartialReason>();
  const pending = new Set<Backfill>();
  let status: ListStatus = 'done';
  let failed = false;
  for (const [i, page] of pages.entries()) {
    if (isFailed(page)) {
      status = 'error';
      failed = true;
      break;
    }
    if (page === undefined) {
      status = i === 0 ? 'loading' : 'fetching';
      break;
    }
    for (const row of page.rows) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      rows.push(row);
    }
    for (const r of page.reasons) reasons.add(r);
    for (const b of page.pending) pending.add(b);
    // A page the server says must be split holds only the start of its range: its rows stand, and
    // nothing after them is drawn until the split pages land (a gap would read as a lost row).
    if (mustSplit(page)) {
      status = 'fetching';
      break;
    }
    if (i === pages.length - 1) status = page.isDone ? 'done' : 'more';
  }
  return {
    status,
    rows,
    reasons: [...reasons],
    pending: BACKFILL_ORDER.filter((b) => pending.has(b)),
    failed,
  };
}
