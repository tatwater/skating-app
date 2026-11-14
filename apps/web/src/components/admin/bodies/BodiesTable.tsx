import {
  type CellContext,
  createColumnHelper,
  FlexRender,
  metaHelper,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ListEnd } from '@/components/kit/list-end';
import { SearchMark } from '@/components/kit/search-mark';
import { SkeletonText } from '@/components/kit/skeleton';
import { Table, TableCell, TableHead, TableRow } from '@/components/kit/table';
import { TableGroupRow } from '@/components/kit/table-group-row';
import { LedStrip } from '@/components/kit/trace-chart';
import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { countText } from '../overview/overviewModel';
import type { BodiesListData } from './bodiesData';
import {
  acresText,
  asksText,
  type BodyColumnId,
  type BodyRow,
  type BodySort,
  COLUMN_LABEL,
  changedWhen,
  classWord,
  STANDING_LABEL,
  statesText,
} from './bodiesModel';
import { isSearch } from './bodiesSearch';
import { type BodyLane, laneStanding } from './bodyLanes';
import { TryAgain } from './TryAgain';

/**
 * The library's list (boards 5.1–5.3, middle): a real table over the lane's rows — TanStack Table
 * for the columns and the cells, TanStack Virtual for the rows once there are many — with the
 * completeness strip in each row, the group dividers a search across standings draws, and the
 * search's match marked in place.
 *
 * - **Sort by clicking a heading** (lit, with its arrow; again reverses). The order is the read's:
 *   the heading asks for it, the route answers. A column the read can't sort by has a plain
 *   heading. While a search ranks the list, no heading is lit.
 * - **One tab stop for the rows**: the body is a `grid` with a cursor (`aria-activedescendant`), so
 *   Tab goes on to the preview. ↑↓ move the cursor, Home/End jump, typing jumps to the next name
 *   that starts with what was typed (a letter again cycles); **⏎ or Space opens** the row in the
 *   preview and moves focus there; a click opens it where you are. G and ? pass through to the
 *   keyboard layer; / goes to the search.
 * - **Pages arrive as it scrolls**: near the end it asks for more, so the server is asked for a page
 *   at a time, never for the corpus. A page that came back short (its scan ran out) is still near
 *   the end, so the next is asked for at once; the end tab is drawn only once the read is done.
 *   Above a hundred rows only the rows in view are in the page.
 * - **It comes back as it was**: the scroll offset is kept per list (lane, search, facets, sort) for
 *   this tab, so returning from a body's console lands where you left.
 */

/** Rows above this virtualize. */
const VIRTUALIZE_ABOVE = 100;
/** Ask for the next page this far (px) from the end. */
const LOAD_AHEAD_PX = 640;
const TYPE_AHEAD_MS = 500;

/** Where each list was scrolled to, this tab (a list is its `listKey`). */
const scrollMemory = new Map<string, number>();

/** Forget every list's scroll (stories and tests start clean). */
export function resetScrollMemory(): void {
  scrollMemory.clear();
}

/**
 * Each column's width (rem), shared by the heading table and the body grid; the name takes the
 * rest. The boards' widths at 1440, rounded to the ruler.
 */
const WIDTH: Record<Exclude<BodyColumnId, 'name'>, string> = {
  class: '6.5rem',
  state: '4rem',
  acres: '5rem',
  complete: '5.75rem',
  asks: '3.25rem',
  reports: '5.25rem',
  changed: '4.75rem',
};

const END_ALIGNED: ReadonlySet<BodyColumnId> = new Set(['acres', 'asks', 'reports']);
const MONO: ReadonlySet<BodyColumnId> = new Set(['acres', 'asks', 'reports', 'changed']);

type Entry =
  | { kind: 'row'; row: BodyRow; other: boolean }
  | { kind: 'group'; key: string; label: string; count: number };

type CellCtx = { q: string; now: number; showStanding: (row: BodyRow) => boolean };

const features = tableFeatures({ columnMeta: metaHelper<{ column: BodyColumnId }>() });
const helper = createColumnHelper<typeof features, BodyRow>();

/** What a cell draws. `null` (not recorded) is an empty cell, never a zero. */
function cellFor(column: BodyColumnId, row: BodyRow, ctx: CellCtx): ReactNode {
  switch (column) {
    case 'name':
      return (
        <>
          <span className="block truncate">
            <span data-slot="body-name" className="font-medium">
              <SearchMark text={row.name} query={ctx.q} />
            </span>
            {row.matchedAlias !== undefined && (
              <span data-slot="body-alias" className="ms-(--space-2) text-assist text-fg3">
                also “<SearchMark text={row.matchedAlias} query={ctx.q} />”
              </span>
            )}
          </span>
          {ctx.showStanding(row) && (
            <span
              data-slot="body-standing"
              className="mt-(--space-0_5) block text-assist leading-snug text-fg3"
            >
              {STANDING_LABEL[row.standing]}
            </span>
          )}
        </>
      );
    case 'class':
      return classWord(row.bodyClass);
    case 'state':
      return statesText(row.states);
    case 'acres':
      return row.areaSqM === null ? null : acresText(row.areaSqM);
    case 'complete':
      return row.complete === null ? null : (
        <LedStrip
          aria-label="Complete"
          size="row"
          tone="on"
          value={row.complete.have}
          max={row.complete.of}
        />
      );
    case 'asks':
      return row.asks === null ? null : (
        <span
          data-slot="body-asks"
          data-waiting={row.asksWaiting === true && row.asks > 0 ? '' : undefined}
          className="data-waiting:text-warn"
        >
          {asksText(row.asks, row.asksCapped === true)}
        </span>
      );
    case 'reports':
      return row.reports === null
        ? null
        : countText({ count: row.reports, capped: row.reportsCapped === true });
    case 'changed':
      return row.changedAt === null ? null : changedWhen(row.changedAt, ctx.now);
  }
}

type BodiesTableProps = {
  lane: BodyLane;
  list: BodiesListData;
  q: string;
  sort: BodySort;
  /** The body open in the preview. */
  selectedId: string | null;
  now: number;
  /** A heading was pressed. */
  onSort: (column: BodyColumnId) => void;
  /** A row was clicked: open it in the preview. */
  onSelect: (id: string) => void;
  /** ⏎ or Space on a row: open it and move focus into the preview. */
  onOpen: (id: string) => void;
  /** Near the end with more to come. */
  onLoadMore?: () => void;
  /** Re-runs a failed list. */
  onRetry?: () => void;
  /** This list, as it stands — the scroll is remembered under it. */
  memoryKey: string;
  /** / was pressed in the rows. */
  onSearchKey?: () => void;
  gridRef?: Ref<HTMLTableElement>;
};

export function BodiesTable({
  lane,
  list,
  q,
  sort,
  selectedId,
  now,
  onSort,
  onSelect,
  onOpen,
  onLoadMore,
  onRetry,
  memoryKey,
  onSearchKey,
  gridRef,
}: BodiesTableProps) {
  const base = useId();
  const optionId = (id: string) => `${base}-${id}`;
  const scroller = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });

  // The cells read the latest context (the search, the clock) through a ref, so the column
  // model is built once per lane, not once per keystroke.
  const ctx = useRef<CellCtx>({ q, now, showStanding: () => false });
  ctx.current = {
    // A search too short to run marks nothing: the rows aren't its matches.
    q: isSearch(q) ? q : '',
    now,
    showStanding: (row) => lane.showStanding || row.standing !== laneStanding(lane),
  };
  const columns = useMemo(
    () =>
      lane.columns.map((column) =>
        helper.display({
          id: column,
          header: COLUMN_LABEL[column],
          cell: (info: CellContext<typeof features, BodyRow, unknown>) =>
            cellFor(column, info.row.original, ctx.current),
          meta: { column },
        }),
      ),
    [lane.columns],
  );
  const data = useMemo(
    () => [...list.rows, ...(list.others ?? []).flatMap((g) => g.rows)],
    [list.rows, list.others],
  );
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });
  const rowById = new Map(table.getRowModel().rows.map((r) => [r.id, r]));

  const entries = useMemo<Entry[]>(
    () => [
      ...list.rows.map((row) => ({ kind: 'row' as const, row, other: false })),
      ...(list.others ?? []).flatMap((g) => [
        { kind: 'group' as const, key: g.key, label: g.label, count: g.rows.length },
        ...g.rows.map((row) => ({ kind: 'row' as const, row, other: true })),
      ]),
    ],
    [list.rows, list.others],
  );
  const rowEntries = useMemo(
    () => entries.flatMap((e) => (e.kind === 'row' ? [e.row] : [])),
    [entries],
  );

  // The cursor: the row last moved to, else the open one, else the first.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursor =
    rowEntries.find((r) => r.id === cursorId)?.id ??
    rowEntries.find((r) => r.id === selectedId)?.id ??
    rowEntries[0]?.id ??
    null;

  const virtual = entries.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? entries.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (entries[i]?.kind === 'group' ? 40 : 32),
    getItemKey: (i) => {
      const e = entries[i];
      return e === undefined ? i : e.kind === 'row' ? e.row.id : `group-${e.key}`;
    },
    overscan: 12,
    // The cursor's row stays rendered, so `aria-activedescendant` always names an element.
    rangeExtractor: (range) => {
      const at = entries.findIndex((e) => e.kind === 'row' && e.row.id === cursor);
      const out: number[] = [];
      for (let i = range.startIndex; i <= range.endIndex; i++) out.push(i);
      if (at !== -1 && !out.includes(at)) out.push(at);
      return out.sort((a, b) => a - b);
    },
  });

  // Come back where you were: the remembered scroll once rows are in, else the open row in view.
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || restored.current === memoryKey || entries.length === 0) return;
    restored.current = memoryKey;
    const top = scrollMemory.get(memoryKey);
    if (top !== undefined) {
      el.scrollTop = top;
      return;
    }
    el.scrollTop = 0;
  }, [memoryKey, entries.length]);

  const status = list.status;
  const maybeLoadMore = () => {
    const el = scroller.current;
    if (el === null || status !== 'more' || onLoadMore === undefined) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_AHEAD_PX) onLoadMore();
  };
  // A first page shorter than the viewport asks for the next straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check whenever a page lands.
  useEffect(maybeLoadMore, [entries.length, status]);

  const moveTo = (id: string | undefined) => {
    if (id === undefined) return;
    setCursorId(id);
    const at = entries.findIndex((e) => e.kind === 'row' && e.row.id === id);
    if (virtual) virtualizer.scrollToIndex(at, { align: 'auto' });
    else document.getElementById(optionId(id))?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const at = rowEntries.findIndex((r) => r.id === cursor);
    const step = (to: number) => {
      event.preventDefault();
      moveTo(rowEntries[Math.max(0, Math.min(rowEntries.length - 1, to))]?.id);
    };
    if (event.key === 'ArrowDown') return step(at + 1);
    if (event.key === 'ArrowUp') return step(at - 1);
    if (event.key === 'Home') return step(0);
    if (event.key === 'End') return step(rowEntries.length - 1);
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.shiftKey || cursor === null) return;
      event.preventDefault();
      onOpen(cursor);
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      onSearchKey?.();
      return;
    }
    if (event.key.length !== 1) return;
    const now = event.timeStamp;
    const running = typed.current.text !== '' && now - typed.current.at <= TYPE_AHEAD_MS;
    // G and ? belong to the keyboard layer unless a type-ahead run is under way.
    if (!running && /^[g?]$/i.test(event.key)) return;
    event.preventDefault();
    const text = running ? typed.current.text + event.key : event.key;
    typed.current = { text, at: now };
    const lower = text.toLocaleLowerCase();
    const repeat = lower.length > 1 && [...lower].every((c) => c === lower[0]);
    const query = repeat ? lower.charAt(0) : lower;
    const from = query.length === 1 ? at + 1 : Math.max(0, at);
    const order = [...rowEntries.slice(from), ...rowEntries.slice(0, from)];
    moveTo(order.find((r) => r.name.toLocaleLowerCase().startsWith(query))?.id);
  };

  const headers = table.getHeaderGroups().at(-1)?.headers ?? [];
  const colgroup = (
    <colgroup>
      {lane.columns.map((c) => (
        <col key={c} style={c === 'name' ? undefined : { width: WIDTH[c] }} />
      ))}
    </colgroup>
  );

  const renderEntry = (entry: Entry, index: number, measure?: (el: Element | null) => void) => {
    if (entry.kind === 'group') {
      return (
        <TableGroupRow
          key={`group-${entry.key}`}
          ref={measure}
          data-index={index}
          colSpan={lane.columns.length}
          label={entry.label}
          count={entry.count}
        />
      );
    }
    const { row, other } = entry;
    const tr = rowById.get(row.id);
    // A row with a second line (its standing) centers its cells on both, as the board does.
    const tall = ctx.current.showStanding(row);
    const selected = row.id === selectedId;
    return (
      <TableRow
        key={row.id}
        ref={measure}
        id={optionId(row.id)}
        data-index={index}
        data-cursor={row.id === cursor ? '' : undefined}
        data-other={other ? '' : undefined}
        role="row"
        aria-selected={selected}
        clickable
        selected={selected}
        tabIndex={-1}
        onClick={() => {
          setCursorId(row.id);
          onSelect(row.id);
        }}
        className={cn(
          // The cursor shares the hover's quiet lift (one look), the grid holds the focus.
          'data-cursor:in-focus-visible:bg-lift-05',
          other && 'text-fg3 [&_[data-slot=body-name]]:text-fg1',
        )}
      >
        {(tr?.getAllCells() ?? []).map((cell) => {
          const column = (cell.column.columnDef.meta as { column: BodyColumnId }).column;
          return (
            <TableCell
              key={cell.id}
              role="gridcell"
              align={END_ALIGNED.has(column) ? 'end' : 'start'}
              mono={MONO.has(column)}
              lead={column === 'name' && !other}
              className={cn('whitespace-nowrap', (tall || column === 'complete') && 'align-middle')}
            >
              <FlexRender cell={cell} />
            </TableCell>
          );
        })}
      </TableRow>
    );
  };

  const items = virtual ? virtualizer.getVirtualItems() : [];
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtual ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;
  const loading = status === 'loading';
  const rowsTotal = rowEntries.length;

  return (
    <div data-slot="bodies-table" className="flex min-h-0 flex-1 flex-col">
      <Table data-slot="bodies-heads" className="table-fixed">
        {colgroup}
        <thead>
          <tr>
            {headers.map((header) => {
              const column = header.column.id as BodyColumnId;
              const sortable = list.serves.sort.includes(column);
              const on = sort.column === column ? sort.dir : false;
              return (
                <TableHead
                  key={header.id}
                  align={END_ALIGNED.has(column) ? 'end' : 'start'}
                  sticky={false}
                  className="pt-(--space-3)"
                  {...(sortable && { sort: on, onSort: () => onSort(column) })}
                >
                  <FlexRender header={header} />
                </TableHead>
              );
            })}
          </tr>
        </thead>
      </Table>
      <div
        ref={scroller}
        data-slot="bodies-scroll"
        className="min-h-0 flex-1 overflow-y-auto pb-(--space-14)"
        onScroll={(event) => {
          scrollMemory.set(memoryKey, event.currentTarget.scrollTop);
          maybeLoadMore();
        }}
      >
        <Table
          ref={gridRef}
          role="grid"
          aria-label={lane.title}
          aria-busy={loading || undefined}
          aria-rowcount={list.total !== null && !list.total.capped ? list.total.count : -1}
          aria-activedescendant={cursor !== null ? optionId(cursor) : undefined}
          tabIndex={0}
          data-slot="bodies-grid"
          {...{ [KEYS_PASS_THROUGH]: '' }}
          onKeyDown={onKeyDown}
          className="table-fixed outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
        >
          {colgroup}
          <tbody>
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
                  <TableRow key={i} aria-hidden="true" data-skeleton="">
                    {lane.columns.map((c) => (
                      <TableCell key={c} align={END_ALIGNED.has(c) ? 'end' : 'start'}>
                        <SkeletonText
                          width={c === 'name' ? '9rem' : '60%'}
                          className={cn(END_ALIGNED.has(c) && 'ml-auto')}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : virtual
                ? [
                    padTop > 0 && (
                      <tr key="pad-top" data-slot="bodies-pad" style={{ height: padTop }} />
                    ),
                    ...items.map((item) =>
                      renderEntry(
                        entries[item.index] as Entry,
                        item.index,
                        virtualizer.measureElement,
                      ),
                    ),
                    padBottom > 0 && (
                      <tr key="pad-bottom" data-slot="bodies-pad" style={{ height: padBottom }} />
                    ),
                  ]
                : entries.map((entry, i) => renderEntry(entry, i))}
          </tbody>
        </Table>
        {!loading && <ListFoot list={list} rows={rowsTotal} q={q} onRetry={onRetry} />}
      </div>
    </div>
  );
}

/** The list-end tab: what the list is, or why it stops where it does. */
function ListFoot({
  list,
  rows,
  q,
  onRetry,
}: {
  list: BodiesListData;
  rows: number;
  q: string;
  onRetry: (() => void) | undefined;
}) {
  const words = (() => {
    switch (list.status) {
      case 'unread':
        return 'Not recorded yet';
      case 'error':
        return 'Couldn’t read this list';
      case 'loading':
      case 'more':
      case 'fetching':
        return 'Loading more';
      case 'done':
        if (rows === 0) return isSearch(q) ? `Nothing matches “${q.trim()}”` : 'None here';
        return `All ${list.total !== null ? countText(list.total) : rows.toLocaleString('en-US')}`;
    }
  })();
  return (
    <>
      <ListEnd data-slot="bodies-end" data-status={list.status}>
        {words}
      </ListEnd>
      {list.status === 'error' && onRetry !== undefined && (
        <div className="px-gutter pt-(--space-3)">
          <TryAgain onRetry={onRetry} />
        </div>
      )}
    </>
  );
}
