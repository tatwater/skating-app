import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { ListEnd } from './list-end';
import { ScrollBar } from './scroll-area';
import { SkeletonText } from './skeleton';

/**
 * The kit's selectable middle list: the console's queue column (Inbox, Reports, a lane's list).
 * Custom — Base UI has no standalone listbox (its lists live in popups).
 *
 * - **One Tab stop.** The list is a `listbox` that is also its own scroll viewport; focus stays
 *   on it and a cursor moves through the rows (`aria-activedescendant`), so Tab goes straight on
 *   to the next pane.
 * - **↑↓ within, Home/End to the ends, typing jumps** (type-ahead on row titles; repeat a letter
 *   to step through rows that start with it). **⏎ or Space opens** the row: `onOpen` fires, and
 *   the caller moves focus into the right pane. A press opens it too.
 * - **`G` and `?` pass through** to the keyboard layer unless a type-ahead run is under way, so
 *   go-mode and the key sheet work from the list (the rest of the alphabet is type-ahead, never an
 *   action). Keys the list uses never reach the page.
 * - **A wash only on rows that do something** (R3#3): hover and the keyboard cursor share one
 *   quiet lift; the open row carries the selection wash and the white rule on its left edge. A
 *   **locked** row is half opacity, readable, and skipped — the cursor, type-ahead and a press all
 *   pass it by — and takes no wash.
 * - **The decided list sits 32 px under the open one** (`space-8` from the end tab to its
 *   heading), in the same listbox, so ↑↓ runs straight on into it.
 * - **Empty keeps its name**: the list keeps its label, and the end tab says what is empty
 *   ("Nothing open"). **Loading** is skeleton rows in the rows' own box, the list `aria-busy`.
 * - **Virtualized above `virtualizeAbove` rows** (`@tanstack/react-virtual`): only the rows in
 *   view are in the page, but the cursor's row is always kept rendered, so `aria-activedescendant`
 *   always names a real element and type-ahead searches every row, not just the rendered ones.
 *
 * Density follows the surface: rows are the gutter in from each edge and `space-2_5` tall in
 * padding, in the surface's body and assist steps — all rem (D233).
 */

export type MiddleListItem = {
  /** Stable across renders; what `onOpen` and `selectedId` speak. */
  id: string;
  /** The row's name — what type-ahead matches. */
  title: string;
  /** The line under it (where, who, why). */
  sub?: ReactNode;
  /** The chips over the title (kit `Badge`s). */
  chips?: ReactNode;
  /** The right column, on the title's baseline (an age, a count). */
  meta?: ReactNode;
  /** A leading column (an avatar), centered on the row. */
  leading?: ReactNode;
  /** Readable, but not openable: half opacity, skipped by the cursor. */
  locked?: boolean;
};

export type MiddleListProps = {
  /** The list's name, kept when it's empty or loading ("Open asks"). */
  label: string;
  items: readonly MiddleListItem[];
  /** The end tab's label; default "All N". */
  endLabel?: string;
  /** What an empty open list says ("Nothing open"). */
  emptyLabel: string;
  /** The decided list, under the open one ("Decided this week"). */
  decided?: { label: string; items: readonly MiddleListItem[] };
  /** The row open in the right pane. */
  selectedId?: string | null;
  /** ⏎, Space or a press on a row: open it (and move focus to the right pane). */
  onOpen: (id: string) => void;
  /** Skeleton rows in place of the list. */
  loading?: boolean;
  /** How many skeleton rows (default 6). */
  loadingRows?: number;
  /** Virtualize when the rows outnumber this (default 100). */
  virtualizeAbove?: number;
  className?: string;
};

/** How long a type-ahead run waits for its next letter. */
const TYPE_AHEAD_MS = 500;

type Entry =
  | { kind: 'row'; item: MiddleListItem; row: number; decided: boolean }
  | { kind: 'end'; label: string; empty: boolean }
  | { kind: 'divider'; label: string };

/** The scroll lane, as the kit's ScrollArea keeps it: the thumb's stroke and its inset each side. */
const LANE = '[--scroll-lane:calc(var(--stroke-run)+2*var(--space-1))]';

function MiddleList({
  label,
  items,
  endLabel,
  emptyLabel,
  decided,
  selectedId = null,
  onOpen,
  loading = false,
  loadingRows = 6,
  virtualizeAbove = 100,
  className,
}: MiddleListProps) {
  const base = useId();
  const dividerId = `${base}-decided`;
  const optionId = (row: number) => `${base}-row-${row}`;

  // Every row in reading order (open, then decided) — what the cursor and type-ahead walk.
  const rows = useMemo(() => [...items, ...(decided?.items ?? [])], [items, decided]);
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = items.map((item, row) => ({ kind: 'row', item, row, decided: false }));
    out.push({
      kind: 'end',
      label: items.length === 0 ? emptyLabel : (endLabel ?? `All ${items.length}`),
      empty: items.length === 0,
    });
    if (decided !== undefined) {
      out.push({ kind: 'divider', label: decided.label });
      decided.items.forEach((item, i) => {
        out.push({ kind: 'row', item, row: items.length + i, decided: true });
      });
    }
    return out;
  }, [items, decided, endLabel, emptyLabel]);
  const entryOfRow = useMemo(() => {
    const map: number[] = [];
    entries.forEach((e, i) => {
      if (e.kind === 'row') map[e.row] = i;
    });
    // Every row has an entry, so a row's index always finds one (the cast is for the type).
    return (row: number) => map[row] as number;
  }, [entries]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const activeRow = activeId === null ? -1 : rows.findIndex((r) => r.id === activeId);
  // The cursor is on a row that still exists and can be opened, or nowhere.
  const cursor = activeRow >= 0 && rows[activeRow]?.locked !== true ? activeRow : -1;

  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const virtual = rows.length > virtualizeAbove;
  const cursorEntry = cursor >= 0 ? entryOfRow(cursor) : -1;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const out = defaultRangeExtractor(range);
      // The cursor's row stays in the page, wherever the list has scrolled.
      if (cursorEntry >= 0 && !out.includes(cursorEntry)) {
        out.push(cursorEntry);
        out.sort((a, b) => a - b);
      }
      return out;
    },
    [cursorEntry],
  );
  const rem = rootRem();
  const virtualizer = useVirtualizer({
    count: virtual ? entries.length : 0,
    getScrollElement: () => viewport,
    estimateSize: (i) => estimate(entries[i] as Entry, rem),
    getItemKey: (i) => entryKey(entries[i] as Entry),
    overscan: 8,
    rangeExtractor,
  });

  // ── The cursor ──
  const enabled = (row: number) => row >= 0 && row < rows.length && rows[row]?.locked !== true;
  const step = (from: number, by: 1 | -1): number => {
    for (let r = from + by; r >= 0 && r < rows.length; r += by) if (enabled(r)) return r;
    return from;
  };
  const first = () => step(-1, 1);
  const last = () => step(rows.length, -1);
  const scrollTo = useRef(false);
  const moveTo = (row: number, scroll = true) => {
    const item = rows[row];
    if (row < 0 || item === undefined || item.locked === true) return;
    scrollTo.current = scroll;
    setActiveId(item.id);
  };

  // Keep the cursor's row in view after a keyboard move.
  useLayoutEffect(() => {
    if (!scrollTo.current || cursor < 0) return;
    scrollTo.current = false;
    if (virtual) {
      virtualizer.scrollToIndex(entryOfRow(cursor), { align: 'auto' });
    } else {
      document.getElementById(optionId(cursor))?.scrollIntoView({ block: 'nearest' });
    }
  });

  // ── Type-ahead ──
  const run = useRef<{ text: string; timer?: ReturnType<typeof setTimeout> }>({ text: '' });
  useEffect(() => () => clearTimeout(run.current.timer), []);
  const typeAhead = (char: string) => {
    const r = run.current;
    clearTimeout(r.timer);
    r.text += char.toLowerCase();
    r.timer = setTimeout(() => {
      r.text = '';
    }, TYPE_AHEAD_MS);
    const text = r.text;
    // One letter pressed again and again steps through the rows that start with it.
    const repeat = text.length > 1 && [...text].every((c) => c === text[0]);
    const needle = repeat ? text.charAt(0) : text;
    const start = repeat || text.length === 1 ? cursor + 1 : Math.max(cursor, 0);
    for (let i = 0; i < rows.length; i++) {
      const row = (start + i) % rows.length;
      if (enabled(row) && rows[row]?.title.toLowerCase().startsWith(needle)) {
        moveTo(row);
        return;
      }
    }
  };

  // Called only with an openable row: the cursor's, or a pressed row that isn't locked.
  const open = (row: number) => {
    const item = rows[row] as MiddleListItem;
    setActiveId(item.id);
    onOpen(item.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (loading || event.ctrlKey || event.metaKey || event.altKey) return;
    const running = run.current.text !== '';
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(cursor < 0 ? first() : step(cursor, 1));
        break;
      case 'ArrowUp':
        moveTo(cursor < 0 ? first() : step(cursor, -1));
        break;
      case 'Home':
        moveTo(first());
        break;
      case 'End':
        moveTo(last());
        break;
      case 'Enter':
        if (cursor >= 0) open(cursor);
        break;
      case ' ':
        if (running) typeAhead(' ');
        else if (cursor >= 0) open(cursor);
        break;
      default:
        // A printable key is type-ahead — except G and ?, which start go-mode and the key sheet
        // unless a run is already under way.
        if (event.key.length !== 1 || (!running && /^[gG?]$/.test(event.key))) handled = false;
        else typeAhead(event.key);
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // A press focuses the list on pointerdown; scrolling to the cursor then would move the pressed
  // row out from under the click. So focus scrolls only when a press didn't bring it.
  const pressing = useRef(false);
  const onFocus = () => {
    setFocused(true);
    const scroll = !pressing.current;
    pressing.current = false;
    if (cursor >= 0) return;
    const selected = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
    moveTo(enabled(selected) ? selected : first(), scroll);
  };

  // ── Drawing ──
  const renderEntry = (entry: Entry) => {
    if (entry.kind === 'end') {
      return (
        <ListEnd role="presentation" id={entry.empty ? `${base}-empty` : undefined}>
          {entry.label}
        </ListEnd>
      );
    }
    if (entry.kind === 'divider') {
      return (
        <div
          role="presentation"
          data-slot="middle-list-divider"
          className="flex items-center gap-(--space-2_5) px-gutter pt-(--space-8) pb-(--space-1)"
        >
          <span
            id={dividerId}
            data-slot="middle-list-divider-label"
            className="shrink-0 text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
          >
            {entry.label}
          </span>
          <i aria-hidden="true" className="h-(--stroke-hair) flex-1 bg-line" />
        </div>
      );
    }
    const { item, row } = entry;
    return (
      <Row
        id={optionId(row)}
        item={item}
        posinset={row + 1}
        setsize={rows.length}
        active={focused && row === cursor}
        selected={item.id === selectedId}
        describedBy={entry.decided ? dividerId : undefined}
        onPress={() => open(row)}
      />
    );
  };

  const busy = loading;
  const empty = items.length === 0 && !busy;
  return (
    <ScrollAreaPrimitive.Root
      data-slot="middle-list"
      className={cn('group/scroll relative min-h-0 min-w-0 overflow-hidden', LANE, className)}
    >
      <ScrollAreaPrimitive.Viewport
        ref={setViewport}
        role="listbox"
        aria-label={label}
        aria-busy={busy || undefined}
        aria-activedescendant={!busy && cursor >= 0 ? optionId(cursor) : undefined}
        aria-describedby={empty ? `${base}-empty` : undefined}
        {...{ [KEYS_PASS_THROUGH]: '' }}
        // Always one Tab stop — Base UI would drop it when nothing overflows.
        tabIndex={0}
        data-slot="scroll-area-viewport"
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          pressing.current = true;
        }}
        onPointerUp={() => {
          pressing.current = false;
        }}
        onFocus={onFocus}
        onBlur={() => setFocused(false)}
        className={cn(
          'size-full overflow-x-hidden! overscroll-contain pr-(--scroll-lane) outline-none',
          'focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
        )}
      >
        <ScrollAreaPrimitive.Content className="min-w-0!">
          {busy ? (
            <div data-slot="middle-list-loading">
              {Array.from({ length: loadingRows }, (_, i) => (
                // Placeholders are positional and never reorder.
                // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
                <SkeletonListRow key={i} />
              ))}
            </div>
          ) : virtual ? (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => (
                <div
                  key={v.key}
                  ref={virtualizer.measureElement}
                  data-index={v.index}
                  role="presentation"
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  {renderEntry(entries[v.index] as Entry)}
                </div>
              ))}
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entryKey(entry)} role="presentation">
                {renderEntry(entry)}
              </div>
            ))
          )}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
    </ScrollAreaPrimitive.Root>
  );
}

type RowProps = {
  id: string;
  item: MiddleListItem;
  posinset: number;
  setsize: number;
  active: boolean;
  selected: boolean;
  describedBy: string | undefined;
  onPress: () => void;
};

/**
 * A row: chips over the title, the meta on the title's baseline, the sub-line under. The grid
 * keeps those three rows even when chips are absent (the empty row has no height), so every row
 * lines its title up the same way.
 */
function Row({ id, item, posinset, setsize, active, selected, describedBy, onPress }: RowProps) {
  const locked = item.locked === true;
  const lead = item.leading !== undefined;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: an option is reached through the listbox's aria-activedescendant, never by its own focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys for every row
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={locked || undefined}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-describedby={describedBy}
      data-slot="middle-list-row"
      data-active={active ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-locked={locked ? '' : undefined}
      onClick={locked ? undefined : onPress}
      className={cn(
        'grid items-baseline gap-x-(--space-3) px-gutter py-(--space-2_5)',
        lead ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
        'border-0 border-b-(length:--stroke-hair) border-dotted border-line',
        'transition-[background-color] duration-(--duration-fast) ease-standard',
        locked
          ? 'opacity-(--opacity-muted)'
          : [
              // Hover and the keyboard cursor are one look; the open row keeps its own over both.
              'cursor-pointer [@media(hover:hover)]:not-data-selected:hover:bg-lift-05',
              'not-data-selected:data-active:bg-lift-05',
              'data-selected:bg-lift-08 data-selected:shadow-select-rule',
            ],
      )}
    >
      {lead && (
        <span data-slot="middle-list-leading" className="row-span-3 self-center">
          {item.leading}
        </span>
      )}
      {item.chips !== undefined && (
        <span
          data-slot="middle-list-chips"
          className={cn(
            'row-start-1 mb-(--space-1_5) flex items-center gap-(--space-1_5)',
            lead ? 'col-start-2' : 'col-start-1',
          )}
        >
          {item.chips}
        </span>
      )}
      <span
        data-slot="middle-list-title"
        className={cn(
          'row-start-2 min-w-0 text-body leading-(--lead-snug) font-medium text-fg1',
          lead ? 'col-start-2' : 'col-start-1',
          !locked && 'in-data-selected:text-fg',
        )}
      >
        {item.title}
      </span>
      {item.meta !== undefined && (
        <span
          data-slot="middle-list-meta"
          className={cn(
            'row-start-2 font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3',
            lead ? 'col-start-3' : 'col-start-2',
          )}
        >
          {item.meta}
        </span>
      )}
      {item.sub !== undefined && (
        <span
          data-slot="middle-list-sub"
          className={cn(
            'row-start-3 mt-(--space-0_5) min-w-0 text-assist leading-list text-fg3',
            lead ? 'col-start-2' : 'col-start-1',
            !locked && 'in-data-selected:text-fg2',
          )}
        >
          {item.sub}
        </span>
      )}
    </div>
  );
}

/** A loading row: the box a title-and-sub row takes, its two lines as skeleton runs. */
function SkeletonListRow() {
  return (
    <div
      aria-hidden="true"
      data-slot="middle-list-skeleton"
      className="border-0 border-b-(length:--stroke-hair) border-dotted border-line px-gutter py-(--space-2_5)"
    >
      <SkeletonText className="text-body leading-(--lead-snug)" width="62%" />
      <SkeletonText className="mt-(--space-0_5) text-assist leading-list" width="84%" />
    </div>
  );
}

function entryKey(entry: Entry): string {
  return entry.kind === 'row' ? `row-${entry.item.id}` : entry.kind;
}

/** The root font size in px, for the virtualizer's first guess (measured right after). */
function rootRem(): number {
  // A server render never measures; the guard is for it, not a case worth a test.
  /* v8 ignore next */
  if (typeof document === 'undefined') return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/** A first guess at an entry's height, in px; every rendered entry is measured. */
function estimate(entry: Entry, rem: number): number {
  if (entry.kind === 'row') return 3.75 * rem;
  return entry.kind === 'end' ? 1.75 * rem : 2.75 * rem;
}

export { MiddleList };
