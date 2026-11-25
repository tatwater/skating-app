import type { CorpusTaskLane } from '@skating/core';
import {
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { RetryNote } from '@/components/kit/retry-note';
import { SearchMark } from '@/components/kit/search-mark';
import { SkeletonText } from '@/components/kit/skeleton';
import { Table, TableCell, TableHead, TableRow } from '@/components/kit/table';
import { TableGroupRow } from '@/components/kit/table-group-row';
import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { useLoadAhead } from '@/lib/loadAhead';
import { cn } from '@/lib/utils';

import type { CorpusRowView } from '../corpusTypes';
import {
  allOf,
  COLUMN_HEADS,
  LIST_FAILED,
  LOADING_MORE,
  MORE_TO_READ,
  READ_MORE,
  SEARCH_CAPPED,
  TAIL_FAILED,
} from '../words/corpusWords';
import type { TaskListStatus } from './taskReads';
import { type MarkedName, type TaskRowView, taskRowView } from './taskRows';

/**
 * **A task lane's list** (boards 4.2, 4.3, the middle column): a real table — the lane's three
 * columns under their heads, rules unbroken — with the lane's open tasks in the server's order
 * (prominence first), then, once every open row is in, the end tab (*All 412*) and the decided tail
 * under its own group row. One grid, one tab stop (the cursor is `aria-activedescendant`), so ↑↓
 * run on from the open rows into the decided ones; Home and End jump; typing jumps by the row's
 * first name (G and ? pass to the console's keys unless a run is under way); ⏎ or Space, or a
 * press, opens the row. The search's text is marked in the names.
 *
 * - **Pages arrive as it scrolls** (`useLoadAhead`); where a scan's budget ends a page the list stops
 *   at *More to read* with *Read on*. A search is one bounded read with no next page: stopped at its
 *   bound, its end says more may match and to narrow it — never *All 50*, and no decided tail under
 *   a list that isn't all in.
 * - **States**: loading is skeleton rows; a failed page is said under the rows that stand, with
 *   *Try again* (the kit `RetryNote`, always mounted, so its words are announced); empty says so in
 *   the end tab. A failed tail is said under the list, never drawn as none decided.
 */

export type TaskListData = {
  status: TaskListStatus;
  rows: readonly CorpusRowView[];
  /** The server is still filing its stored tasks. */
  pending: boolean;
  retryPending?: boolean;
};

export type TaskTail = {
  title: string;
  rows: readonly CorpusRowView[];
  failure?: { retry: () => void; pending: boolean } | null;
};

export type TaskTableProps = {
  lane: CorpusTaskLane;
  /** The grid's accessible name (the lane). */
  label: string;
  list: TaskListData;
  /** What an empty open list's end says. */
  emptyWords: string;
  tail?: TaskTail | null;
  selectedId: string | null;
  /** The search, marked in the names. */
  q: string;
  /** The clock a decided row's age is read against. */
  now: number;
  onOpen: (id: string) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  /** No pages asked while the list is out of sight (narrow, a task open). */
  paused?: boolean;
  gridRef?: Ref<HTMLTableElement>;
  className?: string;
};

const TYPE_AHEAD_MS = 500;

/** Each lane's column widths, after the first (which takes the rest). */
const WIDTHS: Record<CorpusTaskLane, readonly [string, string]> = {
  nameConflicts: ['5.5rem', '4rem'],
  classConflicts: ['8.5rem', '3.5rem'],
};

export function TaskTable({
  lane,
  label,
  list,
  emptyWords,
  tail = null,
  selectedId,
  q,
  now,
  onOpen,
  onLoadMore,
  onRetry,
  paused = false,
  gridRef,
  className,
}: TaskTableProps) {
  const base = useId();
  const rowId = (id: string) => `${base}-${id}`;
  const scroller = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const done = list.status === 'done';
  const open = useMemo(() => list.rows.map((r) => taskRowView(r, now)), [list.rows, now]);
  // The decided tail is drawn (and in the cursor's reach) only under a list whose every row is in.
  const decided = useMemo(
    () => (done && tail !== null ? tail.rows.map((r) => taskRowView(r, now)) : []),
    [done, tail, now],
  );
  const rows: readonly TaskRowView[] = useMemo(() => [...open, ...decided], [open, decided]);

  const [cursorId, setCursorId] = useState<string | null>(null);
  // A task opened from elsewhere (a link, the back button) takes the cursor.
  useEffect(() => {
    if (selectedId !== null) setCursorId(selectedId);
  }, [selectedId]);
  const cursor = rows.findIndex((r) => r.id === cursorId);
  const scrollToCursor = useRef(false);
  useLayoutEffect(() => {
    if (!scrollToCursor.current || cursor < 0) return;
    scrollToCursor.current = false;
    document.getElementById(rowId(rows[cursor]?.id ?? ''))?.scrollIntoView?.({ block: 'nearest' });
  });

  const maybeLoadMore = useLoadAhead(
    scroller,
    !paused && list.status === 'more',
    onLoadMore,
    rows.length,
  );

  const moveTo = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    scrollToCursor.current = true;
    setCursorId(row.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (rows.length === 0) return;
    const at = cursor;
    const step = (to: number) => {
      event.preventDefault();
      moveTo(Math.max(0, Math.min(rows.length - 1, to)));
    };
    if (event.key === 'ArrowDown') return step(at < 0 ? 0 : at + 1);
    if (event.key === 'ArrowUp') return step(at < 0 ? 0 : at - 1);
    if (event.key === 'Home') return step(0);
    if (event.key === 'End') return step(rows.length - 1);
    const stamp = event.timeStamp;
    const running = typed.current.text !== '' && stamp - typed.current.at <= TYPE_AHEAD_MS;
    if (event.key === 'Enter' || (event.key === ' ' && !running)) {
      // ⇧⏎ is the page's (back to the list), never an open.
      if (at < 0 || event.shiftKey) return;
      event.preventDefault();
      // A held key opens once.
      if (event.repeat) return;
      onOpen((rows[at] as TaskRowView).id);
      return;
    }
    if (event.key.length !== 1) return;
    // / is the page's (to the search), never a type-ahead letter.
    if (event.key === '/') return;
    // G and ? belong to the keyboard layer unless a type-ahead run is under way.
    if (!running && /^[g?]$/i.test(event.key)) return;
    event.preventDefault();
    const text = running ? typed.current.text + event.key : event.key;
    typed.current = { text, at: stamp };
    const lower = text.toLocaleLowerCase();
    const repeat = lower.length > 1 && [...lower].every((c) => c === lower[0]);
    const query = repeat ? lower.charAt(0) : lower;
    const from = query.length === 1 ? at + 1 : Math.max(0, at);
    for (let i = 0; i < rows.length; i++) {
      const index = (from + i) % rows.length;
      if ((rows[index] as TaskRowView).title.toLocaleLowerCase().startsWith(query)) {
        moveTo(index);
        return;
      }
    }
  };

  // Focus from a press leaves the cursor to the row pressed; from the keyboard it lands on the open
  // task's row (back from the inspector), else where it was, else the first row.
  const pressing = useRef(false);
  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const pressed = pressing.current;
    pressing.current = false;
    if (pressed || rows.length === 0 || event.target !== event.currentTarget) return;
    const opened = rows.findIndex((r) => r.id === selectedId);
    if (opened >= 0) return moveTo(opened);
    if (cursor >= 0) return;
    moveTo(0);
  };

  const heads = COLUMN_HEADS[lane];
  const [middleWidth, acresWidth] = WIDTHS[lane];
  const colgroup = (
    <colgroup>
      <col />
      <col style={{ width: middleWidth }} />
      <col style={{ width: acresWidth }} />
    </colgroup>
  );
  const loading = list.status === 'loading' || list.status === 'unread';

  const renderRow = (row: TaskRowView, index: number) => {
    const selected = row.id === selectedId;
    return (
      <TableRow
        key={row.id}
        id={rowId(row.id)}
        role="row"
        aria-selected={selected}
        aria-rowindex={index + 1}
        data-cursor={index === cursor ? '' : undefined}
        data-decided={row.decision !== null ? '' : undefined}
        clickable
        selected={selected}
        dim={row.decision !== null && !selected}
        tabIndex={-1}
        onMouseDown={() => {
          pressing.current = true;
        }}
        onClick={() => {
          setCursorId(row.id);
          onOpen(row.id);
        }}
        className="data-cursor:in-focus-visible:bg-lift-05"
      >
        <TableCell role="gridcell" className="min-w-0 align-top">
          <div data-slot="corpus-row-names" className="flex min-w-0 flex-col gap-(--space-0_5)">
            {row.names.map((name, i) => (
              // A name wraps rather than lose its end: the console's column is narrower than the
              // board's, and a cut name can't be told from another.
              <span
                key={name.text}
                className={cn('break-words', i === 0 ? 'font-medium text-fg' : 'text-fg2')}
              >
                <Name name={name} q={q} />
              </span>
            ))}
            {row.place !== '' && (
              <span className="break-words text-meta leading-list text-fg3">{row.place}</span>
            )}
            {row.consequence !== null && (
              <span
                data-slot="corpus-row-consequence"
                className="break-words text-meta leading-list text-fg2 in-data-selected:text-fg"
              >
                {row.consequence}
              </span>
            )}
            {row.decision !== null && (
              <span data-slot="corpus-row-decision" className="truncate text-meta text-fg3">
                {row.decision}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell role="gridcell" className="align-top">
          <div data-slot="corpus-row-middle" className="flex min-w-0 flex-col gap-(--space-0_5)">
            {row.middle.map((line) => (
              <span key={`${line.tag}:${line.text}`} className="flex min-w-0 items-baseline">
                {line.tag !== null && (
                  <span
                    data-slot="corpus-row-tag"
                    className="w-(--space-8) shrink-0 font-(family-name:--family-mono) text-kick tracking-kick text-fg3 uppercase"
                  >
                    {line.tag}
                  </span>
                )}
                <span className="truncate text-meta text-fg2">{line.text}</span>
              </span>
            ))}
          </div>
        </TableCell>
        <TableCell role="gridcell" align="end" mono className="align-top">
          {row.acres}
        </TableCell>
      </TableRow>
    );
  };

  const stoppedEarly = list.status === 'budget';
  const endWords =
    list.status === 'done'
      ? open.length === 0
        ? emptyWords
        : allOf(open.length)
      : list.status === 'more' || list.status === 'fetching'
        ? LOADING_MORE
        : stoppedEarly
          ? MORE_TO_READ
          : list.status === 'capped'
            ? SEARCH_CAPPED
            : null;

  return (
    <div data-slot="corpus-task-table" className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <Table data-slot="corpus-task-heads" className="table-fixed" aria-hidden="true">
        {colgroup}
        <thead>
          <tr>
            <TableHead sticky={false} className="pt-(--space-3)">
              {heads[0]}
            </TableHead>
            <TableHead sticky={false} className="pt-(--space-3)">
              {heads[1]}
            </TableHead>
            <TableHead sticky={false} align="end" className="pt-(--space-3)">
              {heads[2]}
            </TableHead>
          </tr>
        </thead>
      </Table>
      <div
        ref={scroller}
        data-slot="corpus-task-scroll"
        className="min-h-0 flex-1 overflow-y-auto pb-(--space-14)"
        onScroll={maybeLoadMore}
      >
        <Table
          ref={gridRef}
          role="grid"
          aria-label={label}
          aria-busy={loading || undefined}
          aria-rowcount={done ? rows.length : -1}
          aria-activedescendant={cursor >= 0 ? rowId(rows[cursor]?.id ?? '') : undefined}
          tabIndex={0}
          data-slot="corpus-task-grid"
          {...{ [KEYS_PASS_THROUGH]: '' }}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          className="table-fixed outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
        >
          {colgroup}
          <tbody>
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
                  <TableRow key={i} aria-hidden="true" data-skeleton="">
                    <TableCell>
                      <SkeletonText width="9rem" />
                    </TableCell>
                    <TableCell>
                      <SkeletonText width="60%" />
                    </TableCell>
                    <TableCell align="end">
                      <SkeletonText width="60%" className="ml-auto" />
                    </TableCell>
                  </TableRow>
                ))
              : open.map((row, i) => renderRow(row, i))}
            {!loading && endWords !== null && (
              // The end tab, between the open rows and the decided ones: room, not a row of the grid.
              // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: the list's end tab, never a row the cursor reaches
              <tr role="presentation" data-slot="corpus-end-row">
                <td colSpan={3} className="p-0">
                  <ListEnd data-slot="corpus-end" data-status={list.status}>
                    {endWords}
                  </ListEnd>
                </td>
              </tr>
            )}
          </tbody>
          {decided.length > 0 && (
            <tbody data-slot="corpus-tail">
              <TableGroupRow colSpan={3} label={tail?.title ?? ''} count={decided.length} />
              {decided.map((row, i) => renderRow(row, open.length + i))}
            </tbody>
          )}
        </Table>
        {/* Mounted in every state, so a failure's words are announced as they come. */}
        <RetryNote
          data-slot="corpus-list-error"
          className="px-gutter pt-(--space-3) empty:p-0"
          onRetry={onRetry}
          pending={list.retryPending === true}
        >
          {list.status === 'error' ? LIST_FAILED : null}
        </RetryNote>
        {stoppedEarly && onLoadMore !== undefined && (
          <div className="flex justify-center px-gutter py-(--space-3)">
            <Button size="xs" data-slot="corpus-read-more" onClick={onLoadMore}>
              {READ_MORE}
            </Button>
          </div>
        )}
        <RetryNote
          data-slot="corpus-tail-error"
          className="px-gutter pt-(--space-3) empty:p-0"
          {...(tail?.failure != null && { onRetry: tail.failure.retry })}
          pending={tail?.failure?.pending === true}
        >
          {tail?.failure != null && done ? TAIL_FAILED : null}
        </RetryNote>
      </div>
    </div>
  );
}

/** A name with the search marked, and — on a one-letter conflict — the letter where it parts. */
function Name({ name, q }: { name: MarkedName; q: string }) {
  if (name.mark === null) return <SearchMark text={name.text} query={q} />;
  const chars = [...name.text];
  return (
    <>
      {chars.slice(0, name.mark).join('')}
      <span
        data-slot="corpus-parting-letter"
        className="bg-fg2 px-px text-bg in-data-selected:bg-fg"
      >
        {chars[name.mark]}
      </span>
      {chars.slice(name.mark + 1).join('')}
    </>
  );
}
