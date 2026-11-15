import { api } from '@skating/convex/api';
import { PEOPLE_PAGE_MAX, PEOPLE_PAGE_SIZE, type PeopleLane } from '@skating/core';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  isFailed,
  type Loadable,
  loaded,
  type ReadFailure,
  type ReadSpec,
  read,
  useConsoleReadSet,
} from '../../reads/consoleReads';
import { useHeldRead } from '../../shell/presence';
import type { Backfill, LanesRead, PartialReason, PeoplePage, PersonListRow } from './peopleModel';

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
 *   so a page that changes reactively re-anchors the pages after it.
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
  // The cursors asked for, for this list: the first page's is always `null`.
  const [chain, setChain] = useState<{ key: string; cursors: (string | null)[] }>({
    key,
    cursors: [null],
  });
  const cursors = chain.key === key ? chain.cursors : [null];
  // Read once per list: the size only starts a list.
  const firstSize = useMemo(() => startingPageSize(key), [key]);

  const specs: Record<string, ReadSpec | null> = {};
  if (args !== null) {
    cursors.forEach((cursor, i) => {
      specs[`p${i}`] = read(api.people.listPage, {
        lane: args.lane,
        ...(args.search !== null && { search: args.search }),
        cursor,
        pageSize: i === 0 ? firstSize : PEOPLE_PAGE_SIZE,
        now: args.now,
      });
    });
  }
  const { reads, retry, pending: retrying } = useConsoleReadSet(specs);
  const pages = cursors.map((_, i) => reads[`p${i}`] as Loadable<PeoplePage>);

  // A page whose end moved (it changed reactively) re-anchors the pages after it: the chain is
  // cut there and asks again from the new end.
  const settledEnds = pages.map((p) => {
    const page = loaded(p);
    return page === undefined ? undefined : page.isDone ? 'done' : page.continueCursor;
  });
  const endsKey = JSON.stringify(settledEnds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pages' ends, by value.
  useEffect(() => {
    if (args === null) return;
    for (let i = 0; i < cursors.length - 1; i++) {
      const end = settledEnds[i];
      if (end === undefined) return;
      if (end === 'done' || end !== cursors[i + 1]) {
        const kept = cursors.slice(0, i + 1);
        setChain({ key, cursors: end === 'done' ? kept : [...kept, end] });
        return;
      }
    }
  }, [endsKey, key]);

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

  const last = loaded(pages.at(-1));
  const loadMore = () => {
    if (args === null || last === undefined || last.isDone) return;
    const next = last.continueCursor;
    setChain({ key, cursors: [...cursors, next] });
  };

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
 * The chain's rows in order, each person once (a re-anchoring page can still hold a row the next
 * page holds), what every page read says it may be missing, and where the chain stops: a failed
 * page (the rows before it stand), a page on its way, or the last page's end.
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
