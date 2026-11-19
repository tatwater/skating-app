import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Badge } from '@/components/kit/badge';
import { ListEnd } from '@/components/kit/list-end';
import { PersonLockup } from '@/components/kit/person-lockup';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { useLoadAhead } from '@/lib/loadAhead';
import { cn } from '@/lib/utils';

import { withPinned } from '../../bodies/virtualRows';
import type { RowView } from './peopleModel';
import type { ListStatus } from './peopleReads';
import { allShown, LIST_FAILED, LOADING_MORE, NOT_RECORDED, REST_FAILED } from './peopleWords';

/**
 * The People list (boards 8.1, 8.2, the middle column): one row per person as the lane's read
 * returned them, in the server's order — the chips (the colored status chip first, then the trust
 * class), the person lockup, the sub-line, the reason on file, and the age the lane counts, the only
 * thing on the right.
 *
 * - **One tab stop.** The list is a `listbox` that is its own scroll viewport; a cursor moves through
 *   the rows (`aria-activedescendant`), so Tab goes straight on. ↑↓ move, Home/End jump, typing jumps
 *   to the next name that starts with what was typed (a letter again cycles). **⏎ or Space opens**
 *   the person; so does a press. `G` and `?` pass through to the keyboard layer unless a type-ahead
 *   run is under way; `/` goes to the search. No other letter does anything.
 * - **The cursor's row is kept in view** as it moves, and — coming back to a list — the remembered
 *   scroll is restored, or else the open person's row is brought into view.
 * - **Pages arrive as it scrolls**: near the end it asks for the next; a page that came back short
 *   while more remain is still near the end, so the next is asked for at once. The end tab is drawn
 *   only once every row is in.
 * - **Loading** is skeleton rows; **a failed read** is said in its own place with *Try again* (the
 *   kit `RetryNote`, mounted always, so its words are announced); **empty** says so in plain words in
 *   the end tab. Above a hundred rows only the rows in view are in the page, the cursor's always.
 */

/** Rows above this virtualize. */
const VIRTUALIZE_ABOVE = 100;
const TYPE_AHEAD_MS = 500;

/** Where each list was scrolled to, this tab. */
const scrollMemory = new Map<string, number>();

/** Forget every list's scroll (stories and tests start clean). */
export function resetScrollMemory(): void {
  scrollMemory.clear();
}

export type PeopleListProps = {
  /** The list's accessible name (the lane, or the search). */
  label: string;
  rows: readonly RowView[];
  status: ListStatus;
  /** The person open beside the list. */
  selectedId: string | null;
  /** ⏎, Space or a press on a row; `from` says which, so only the keys move focus on. */
  onOpen: (id: string, from: 'keys' | 'press') => void;
  /** Near the end with more to come. */
  onLoadMore?: () => void;
  /** Re-runs the failed page. */
  onRetry?: () => void;
  /** Tried again; the fresh answer isn't in. */
  retryPending?: boolean;
  /** What an empty list says. */
  emptyWords: string;
  /**
   * What the end says, every row in, when the list isn't the whole lane (not ready, or short) —
   * in place of "All N" and the empty words.
   */
  doneWords?: string | null;
  /** What was searched: marked in each row's name and handle. */
  mark?: string;
  /**
   * The list is out of sight (a narrow screen gives the page to the person): it keeps its place but
   * asks for no more pages — a hidden scroller measures nothing, so every page would read as "near
   * the end" and the whole lane would load.
   */
  paused?: boolean;
  /** This list, as it stands — the scroll is remembered under it. */
  memoryKey: string;
  /** / was pressed in the rows. */
  onSearchKey?: () => void;
  listRef?: Ref<HTMLDivElement>;
  className?: string;
};

export function PeopleList({
  label,
  rows,
  status,
  selectedId,
  onOpen,
  onLoadMore,
  onRetry,
  retryPending = false,
  emptyWords,
  doneWords = null,
  mark = '',
  memoryKey,
  paused = false,
  onSearchKey,
  listRef,
  className,
}: PeopleListProps) {
  const base = useId();
  const optionId = (index: number) => `${base}-row-${index}`;
  const scroller = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: '', at: 0 });

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // A person opened from outside the list (the palette, the back button, a link) takes the cursor,
  // so Esc or Tab back from their page lands on their row — not the row the keys left earlier.
  // Neither moves focus nor scrolls: only coming back to the list brings the cursor into view.
  useEffect(() => {
    if (selectedId !== null) setCursorId(selectedId);
  }, [selectedId]);
  const cursorIndex = rows.findIndex((r) => r.id === cursorId);
  const cursor = cursorIndex >= 0 ? cursorIndex : -1;

  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 64,
    getItemKey: (i) => rows[i]?.id ?? i,
    overscan: 8,
    // The cursor's row stays in the page wherever the list has scrolled, so
    // `aria-activedescendant` always names a real element.
    rangeExtractor: (range) => withPinned(defaultRangeExtractor(range), [cursor]),
  });

  // Come back where you were: the remembered scroll once rows are in, else the open row in view.
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || restored.current === memoryKey || rows.length === 0) return;
    const top = scrollMemory.get(memoryKey);
    if (top !== undefined) {
      el.scrollTop = top;
      // A first page holds at most a hundred rows, so the place may lie past the rows in so far:
      // hold it (the scroll the browser clamps to is not saved over it) until the pages that
      // follow reach it, or the list ends short of it.
      const reached = el.scrollTop >= top - 1;
      if (reached || status === 'done' || status === 'error') restored.current = memoryKey;
      return;
    }
    restored.current = memoryKey;
    el.scrollTop = 0;
    const open = rows.findIndex((r) => r.id === selectedId);
    if (open >= 0) bringIntoView(open);
  });

  const bringIntoView = (index: number) => {
    if (virtual) virtualizer.scrollToIndex(index, { align: 'auto' });
    else document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' });
  };

  const scrollToCursor = useRef(false);
  useLayoutEffect(() => {
    if (!scrollToCursor.current || cursor < 0) return;
    scrollToCursor.current = false;
    bringIntoView(cursor);
  });

  // The next page, only while the list is in sight and measured (`useLoadAhead`): a page shorter
  // than the viewport (or cut short by the server) asks for the next at once; a list out of sight
  // asks for nothing, and picks up when it is shown.
  const maybeLoadMore = useLoadAhead(
    scroller,
    !paused && status === 'more',
    onLoadMore,
    rows.length,
  );

  const moveTo = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    scrollToCursor.current = true;
    setCursorId(row.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (rows.length === 0) {
      if (event.key === '/') {
        event.preventDefault();
        onSearchKey?.();
      }
      return;
    }
    const at = cursor;
    const step = (to: number) => {
      event.preventDefault();
      moveTo(Math.max(0, Math.min(rows.length - 1, to)));
    };
    if (event.key === 'ArrowDown') return step(at < 0 ? 0 : at + 1);
    if (event.key === 'ArrowUp') return step(at < 0 ? 0 : at - 1);
    if (event.key === 'Home') return step(0);
    if (event.key === 'End') return step(rows.length - 1);
    const now = event.timeStamp;
    const running = typed.current.text !== '' && now - typed.current.at <= TYPE_AHEAD_MS;
    if (event.key === 'Enter' || (event.key === ' ' && !running)) {
      if (at < 0 || event.shiftKey) return;
      event.preventDefault();
      onOpen((rows[at] as RowView).id, 'keys');
      return;
    }
    // No name holds a slash, so / goes to the search even mid-run.
    if (event.key === '/') {
      event.preventDefault();
      onSearchKey?.();
      return;
    }
    if (event.key.length !== 1) return;
    // G and ? belong to the keyboard layer unless a type-ahead run is under way.
    if (!running && /^[g?]$/i.test(event.key)) return;
    event.preventDefault();
    const text = running ? typed.current.text + event.key : event.key;
    typed.current = { text, at: now };
    const lower = text.toLocaleLowerCase();
    // One letter pressed again and again steps through the names that start with it.
    const repeat = lower.length > 1 && [...lower].every((c) => c === lower[0]);
    const query = repeat ? lower.charAt(0) : lower;
    const from = query.length === 1 ? at + 1 : Math.max(0, at);
    for (let i = 0; i < rows.length; i++) {
      const index = (from + i) % rows.length;
      if ((rows[index] as RowView).name.toLocaleLowerCase().startsWith(query)) {
        moveTo(index);
        return;
      }
    }
  };

  // A press focuses the list on its way to the row under the pointer (focus comes on the press,
  // the click after it). That row takes the cursor itself, so focus from a press neither moves the
  // cursor nor scrolls: scrolling here would slide another row under the pointer and lose the click.
  const pressing = useRef(false);
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    setFocused(true);
    const pressed = pressing.current;
    pressing.current = false;
    if (pressed || rows.length === 0) return;
    // Back from the person's page: the cursor goes to that person's row when it is loaded — the row
    // the page was opened from — whatever the cursor was left on before.
    const from = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    const open = rows.findIndex((r) => r.id === selectedId);
    if (from?.closest('[data-pane="detail"]') != null && open >= 0) {
      moveTo(open);
      return;
    }
    // Back from the keys (Tab, or Esc from the person's page) with the cursor scrolled away: its
    // row comes into view, so the row the keys act on is the row in sight.
    if (cursor >= 0) {
      bringIntoView(cursor);
      return;
    }
    moveTo(Math.max(open, 0));
  };

  const loading = status === 'loading';
  const renderRow = (row: RowView, index: number, measure?: (el: Element | null) => void) => (
    <PersonRow
      key={row.id}
      ref={measure}
      id={optionId(index)}
      index={index}
      row={row}
      mark={mark}
      posinset={index + 1}
      setsize={status === 'done' ? rows.length : -1}
      active={focused && index === cursor}
      selected={row.id === selectedId}
      onPress={() => {
        setCursorId(row.id);
        onOpen(row.id, 'press');
      }}
    />
  );

  return (
    <div
      ref={(el) => {
        scroller.current = el;
      }}
      data-slot="people-scroll"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain pb-(--space-14)', className)}
      onScroll={(event) => {
        // Only once this list's place is restored: the scroll the browser clamps as the last list's
        // rows give way to this one's skeleton is no place of this list's.
        if (restored.current === memoryKey) {
          scrollMemory.set(memoryKey, event.currentTarget.scrollTop);
        }
        maybeLoadMore();
      }}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        aria-busy={loading || status === 'fetching' || undefined}
        aria-activedescendant={!loading && cursor >= 0 ? optionId(cursor) : undefined}
        tabIndex={0}
        data-slot="people-list"
        {...{ [KEYS_PASS_THROUGH]: '' }}
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          pressing.current = true;
        }}
        onPointerCancel={() => {
          pressing.current = false;
        }}
        onFocus={onFocus}
        onBlur={() => {
          pressing.current = false;
          setFocused(false);
        }}
        className="outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
      >
        {loading ? (
          Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
            <SkeletonRow key={i} />
          ))
        ) : virtual ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div
                key={v.key}
                role="presentation"
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                {renderRow(rows[v.index] as RowView, v.index, virtualizer.measureElement)}
              </div>
            ))}
          </div>
        ) : (
          rows.map((row, i) => renderRow(row, i))
        )}
      </div>
      <ListFoot
        status={status}
        rows={rows.length}
        emptyWords={emptyWords}
        doneWords={doneWords}
        onRetry={onRetry}
        retryPending={retryPending}
      />
    </div>
  );
}

/** The list-end tab, or why the list stops where it does. */
function ListFoot({
  status,
  rows,
  emptyWords,
  doneWords,
  onRetry,
  retryPending,
}: {
  status: ListStatus;
  rows: number;
  emptyWords: string;
  doneWords: string | null;
  onRetry: (() => void) | undefined;
  retryPending: boolean;
}) {
  const failed = status === 'error';
  const words = (() => {
    switch (status) {
      case 'unread':
        return NOT_RECORDED;
      case 'error':
        return rows === 0 ? LIST_FAILED : REST_FAILED;
      case 'loading':
      case 'more':
      case 'fetching':
        return LOADING_MORE;
      case 'done':
        if (doneWords !== null) return doneWords;
        return rows === 0 ? emptyWords : allShown(rows);
    }
  })();
  return (
    <>
      {/* Mounted in every state, so a failure's words are announced as they come, Try again holds
          as pending while the page reloads, and focus stays here when the words go. */}
      <RetryNote
        data-slot="people-error"
        className="px-gutter pt-(--space-3) empty:p-0"
        onRetry={onRetry}
        pending={retryPending}
      >
        {failed ? words : null}
      </RetryNote>
      {!failed && status !== 'loading' && (
        <ListEnd data-slot="people-end" data-status={status}>
          {words}
        </ListEnd>
      )}
    </>
  );
}

type PersonRowProps = {
  ref?: ((el: Element | null) => void) | undefined;
  id: string;
  index: number;
  row: RowView;
  mark: string;
  posinset: number;
  setsize: number;
  active: boolean;
  selected: boolean;
  onPress: () => void;
};

/**
 * A row: the chips, the lockup and the age on its baseline, the sub-line and the reason under. The
 * age is the only thing on the right.
 */
function PersonRow({
  ref,
  id,
  index,
  row,
  mark,
  posinset,
  setsize,
  active,
  selected,
  onPress,
}: PersonRowProps) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: an option is reached through the listbox's aria-activedescendant, never by its own focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys for every row
    <div
      ref={ref}
      id={id}
      data-index={index}
      role="option"
      aria-selected={selected}
      aria-posinset={posinset}
      aria-setsize={setsize}
      data-slot="people-row"
      data-active={active ? '' : undefined}
      data-selected={selected ? '' : undefined}
      onClick={onPress}
      className={cn(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-(--space-3) px-gutter py-(--space-2_5)',
        'border-0 border-b-(length:--stroke-hair) border-dotted border-line',
        'transition-[background-color] duration-(--duration-fast) ease-standard',
        // Hover and the keyboard cursor are one look; the open row keeps its own over both.
        '[@media(hover:hover)]:not-data-selected:hover:bg-lift-05',
        'not-data-selected:data-active:bg-lift-05',
        'data-selected:bg-lift-08 data-selected:shadow-select-rule',
      )}
    >
      {row.chips.length > 0 && (
        <span
          data-slot="people-row-chips"
          className="col-start-1 row-start-1 mb-(--space-1_5) flex items-center gap-(--space-1_5)"
        >
          {row.chips.map((chip) => (
            <Badge key={chip.label} variant="outline" tone={chip.tone}>
              {chip.label}
            </Badge>
          ))}
        </span>
      )}
      <PersonLockup
        size="row"
        data-slot="people-row-title"
        className="col-start-1 row-start-2 text-fg1 in-data-selected:text-fg"
        name={row.name}
        handle={row.handle}
        src={row.src}
        mark={mark}
      />
      {row.age !== null && (
        <span
          data-slot="people-row-age"
          className="col-start-2 row-start-2 font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3"
        >
          {row.age}
        </span>
      )}
      {row.sub !== null && (
        <span
          data-slot="people-row-sub"
          className="col-span-2 col-start-1 row-start-3 mt-(--space-0_5) min-w-0 text-assist leading-list text-fg3 in-data-selected:text-fg2"
        >
          {row.sub}
        </span>
      )}
      {row.reason !== null && (
        <span
          data-slot="people-row-reason"
          className="col-span-2 col-start-1 row-start-4 mt-(--space-0_5) min-w-0 text-assist leading-list text-fg3 in-data-selected:text-fg2"
        >
          {row.reason}
        </span>
      )}
    </div>
  );
}

/** A loading row: the box a lockup-and-sub row takes, its two lines as skeleton runs. */
function SkeletonRow() {
  return (
    <div
      aria-hidden="true"
      data-slot="people-skeleton"
      className="border-0 border-b-(length:--stroke-hair) border-dotted border-line px-gutter py-(--space-2_5)"
    >
      <SkeletonText className="text-body leading-(--lead-snug)" width="62%" />
      <SkeletonText className="mt-(--space-0_5) text-assist leading-list" width="84%" />
    </div>
  );
}
