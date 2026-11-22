import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { useLoadAhead } from '@/lib/loadAhead';
import { cn } from '@/lib/utils';
import { withPinned } from '../../bodies/virtualRows';
import {
  allOf,
  LIST_FAILED,
  LOADING_MORE,
  MORE_TO_READ,
  NOT_RECORDED,
  READ_ON,
  REST_FAILED,
  TAIL_FAILED,
} from '../words/inboxWords';
import type { ChipTone, FlowEntry, RowView } from './inboxModel';
import type { ListStatus } from './inboxReads';

/**
 * **The Inbox list** (boards 2.1–2.9, the middle column): the lane's open items in the server's
 * order — All open with each lane's boundary — then the list-end tab (*All 3*, *Nothing open*), then
 * the lane's *Decided this week* (or, at zero, *Decided today*) as a list of its own under it.
 *
 * - **One tab stop.** The list is a `listbox` and its own scroller; a cursor moves through every row,
 *   open and decided (`aria-activedescendant`), so Tab goes straight on to the inspector. ↑↓ move,
 *   Home/End jump, typing jumps to the next title that starts with what was typed (a letter again
 *   cycles). **⏎ or Space opens** the item — and, from the keys, focus follows into the inspector; a
 *   press opens it where the pointer is. `G` and `?` pass through to the keyboard layer unless a
 *   type-ahead run is under way. No letter acts on an item here: the action keys live in the
 *   inspector, so typing in the list never fires one.
 * - **Pages arrive as it scrolls** (`useLoadAhead`); past a filter's scan budget the list stops at
 *   *More to read* and asks on only when *Read on* is pressed.
 * - **States**: loading is skeleton rows; a failed read is said in its own place with *Try again*
 *   (the kit `RetryNote`, always mounted, so its words are announced); empty says so in the end tab.
 */

const TYPE_AHEAD_MS = 500;
/** Rows above this virtualize (People's line). */
const VIRTUALIZE_ABOVE = 100;

/** One thing the listbox holds: a row (its option index), a boundary, the end tab, a head. */
type FlatItem = { key: string; row?: number; draw: () => ReactNode };

/** Where each list was scrolled to, this tab. */
const scrollMemory = new Map<string, number>();

/** Forget every list's scroll (stories and tests start clean). */
export function resetInboxScroll(): void {
  scrollMemory.clear();
}

export type TailList = {
  /** *Decided this week* / *Decided today*. */
  title: string;
  rows: readonly RowView[];
  /** The tail's read failed. */
  failure?: { retry: () => void; pending: boolean } | null;
};

export type InboxListProps = {
  /** The list's accessible name (the lane). */
  label: string;
  /** The open rows, with All open's boundaries. */
  entries: readonly FlowEntry[];
  status: ListStatus;
  /** What an empty list's end says. */
  emptyWords: string;
  /** The decided list under the open one; none for All open and the Decided lane. */
  tail?: TailList | null;
  selectedId: string | null;
  onOpen: (id: string, from: 'keys' | 'press') => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  retryPending?: boolean;
  /** Out of sight (a narrow screen gives the page to the item): keeps its place, asks for nothing. */
  paused?: boolean;
  /** This list, as it stands — its scroll is remembered under it. */
  memoryKey: string;
  listRef?: Ref<HTMLDivElement>;
  /**
   * Move on from an item (the viewer just decided it, and it leaves the open list): focus comes to
   * the list with the cursor on the open row after it — where it was, once it has gone — so focus
   * is never lost with the action bar that took the decision. `seq` asks again for the same item.
   */
  follow?: { id: string; seq: number } | null;
  className?: string;
};

export function InboxList({
  label,
  entries,
  status,
  emptyWords,
  tail = null,
  selectedId,
  onOpen,
  onLoadMore,
  onRetry,
  retryPending = false,
  paused = false,
  memoryKey,
  listRef,
  follow = null,
  className,
}: InboxListProps) {
  const base = useId();
  const optionId = (index: number) => `${base}-row-${index}`;
  const scroller = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const openRows = entries.flatMap((e) => (e.type === 'row' ? [e.row] : []));
  // The decided list is drawn (and in the cursor's reach) only under a list whose every row is in.
  const tailRows = status === 'done' ? (tail?.rows ?? []) : [];
  const rows: readonly RowView[] = [...openRows, ...tailRows];

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // An item opened from elsewhere (a link, the back button) takes the cursor, so coming back to the
  // list lands on its row.
  useEffect(() => {
    if (selectedId !== null) setCursorId(selectedId);
  }, [selectedId]);
  const cursor = rows.findIndex((r) => r.id === cursorId);

  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || restored.current === memoryKey || rows.length === 0) return;
    restored.current = memoryKey;
    const top = scrollMemory.get(memoryKey);
    if (top !== undefined) {
      el.scrollTop = top;
      return;
    }
    el.scrollTop = 0;
    const open = rows.findIndex((r) => r.id === selectedId);
    if (open >= 0) bringIntoView(open);
  });

  const bringIntoView = (index: number) => {
    if (virtual) {
      const at = flatOf.current.indexOf(index);
      if (at >= 0) virtualizer.scrollToIndex(at, { align: 'auto' });
      return;
    }
    document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' });
  };
  /** Each listbox item's row index (or -1), as last drawn: where the virtualizer finds a row. */
  const flatOf = useRef<number[]>([]);

  const scrollToCursor = useRef(false);

  // Each open row's last place in the list, so a row that has left still says where it was.
  const lastPlace = useRef(new Map<string, number>());
  const box = useRef<HTMLDivElement | null>(null);
  const followed = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when asked (`follow.seq`), reading the rows as they stand.
  useEffect(() => {
    if (follow === null || followed.current === follow.seq) return;
    followed.current = follow.seq;
    const at = openRows.findIndex((r) => r.id === follow.id);
    const place = at >= 0 ? at + 1 : (lastPlace.current.get(follow.id) ?? 0);
    const target = openRows[Math.min(place, openRows.length - 1)] ?? rows[0];
    // Focus first: the list's own focus handler places the cursor, and this place wins over it.
    box.current?.focus();
    if (target !== undefined) {
      scrollToCursor.current = true;
      setCursorId(target.id);
    }
  }, [follow?.seq]);
  useEffect(() => {
    openRows.forEach((r, i) => {
      lastPlace.current.set(r.id, i);
    });
  });
  useLayoutEffect(() => {
    if (!scrollToCursor.current || cursor < 0) return;
    scrollToCursor.current = false;
    bringIntoView(cursor);
  });

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
    const now = event.timeStamp;
    const running = typed.current.text !== '' && now - typed.current.at <= TYPE_AHEAD_MS;
    if (event.key === 'Enter' || (event.key === ' ' && !running)) {
      if (at < 0 || event.shiftKey) return;
      // A held key opens once: its repeats are swallowed, never a second open.
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      onOpen((rows[at] as RowView).id, 'keys');
      return;
    }
    if (event.key.length !== 1) return;
    // G and ? belong to the keyboard layer unless a type-ahead run is under way.
    if (!running && /^[g?]$/i.test(event.key)) return;
    event.preventDefault();
    const text = running ? typed.current.text + event.key : event.key;
    typed.current = { text, at: now };
    const lower = text.toLocaleLowerCase();
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

  // A press focuses the list on its way to the row under the pointer; that row takes the cursor
  // itself, so focus from a press neither moves the cursor nor scrolls.
  const pressing = useRef(false);
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    setFocused(true);
    const pressed = pressing.current;
    pressing.current = false;
    if (pressed || rows.length === 0) return;
    const from = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    const open = rows.findIndex((r) => r.id === selectedId);
    // Back from the inspector: the cursor goes to the open item's row.
    if (from?.closest('[data-pane="detail"]') != null && open >= 0) return moveTo(open);
    if (cursor >= 0) return bringIntoView(cursor);
    moveTo(Math.max(open, 0));
  };

  const loading = status === 'loading';
  // The list's size is known only once every row is in: at the scan's budget more may match, so a
  // row's set size is ARIA's "unknown" (-1) there too.
  const done = status === 'done';
  const renderRow = (row: RowView, index: number) => (
    <InboxRow
      key={row.id}
      id={optionId(index)}
      row={row}
      posinset={index + 1}
      setsize={done ? rows.length : -1}
      active={focused && index === cursor}
      selected={row.id === selectedId}
      onPress={() => {
        setCursorId(row.id);
        onOpen(row.id, 'press');
      }}
    />
  );

  // Everything the listbox holds, in order: the open rows (with All open's boundaries), then — once
  // every open row is in — the end tab and the decided list. The end tab and the decided list sit
  // inside the listbox so the cursor runs on into this week's decisions; a list still loading,
  // stopped by its scan, or failed ends outside it, with its control (`ListFoot`).
  const flat: FlatItem[] = [
    ...entries.map(
      (e): FlatItem =>
        e.type === 'boundary'
          ? {
              key: `lane:${e.lane}`,
              draw: () => (
                <Divider slot="inbox-boundary" lane={e.lane}>
                  {e.label}
                </Divider>
              ),
            }
          : { key: e.row.id, row: e.index, draw: () => renderRow(e.row, e.index) },
    ),
    ...(status === 'done'
      ? [
          {
            key: 'end',
            draw: () => (
              <div role="presentation">
                <ListEnd data-slot="inbox-end" data-status={status}>
                  {openRows.length === 0 ? emptyWords : allOf(openRows.length)}
                </ListEnd>
              </div>
            ),
          },
        ]
      : []),
    ...(tail !== null && tailRows.length > 0
      ? [
          {
            key: 'tail-head',
            draw: () => (
              <Divider slot="inbox-tail-head" gap>
                {tail.title}
              </Divider>
            ),
          },
          ...tailRows.map(
            (row, i): FlatItem => ({
              key: `tail:${row.id}`,
              row: openRows.length + i,
              draw: () => renderRow(row, openRows.length + i),
            }),
          ),
        ]
      : []),
  ];
  const cursorAt = flat.findIndex((f) => f.row !== undefined && f.row === cursor);
  flatOf.current = flat.map((f) => f.row ?? -1);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? flat.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 64,
    getItemKey: (i) => flat[i]?.key ?? i,
    overscan: 8,
    rangeExtractor: (range) => withPinned(defaultRangeExtractor(range), [cursorAt]),
  });

  return (
    <div
      ref={scroller}
      data-slot="inbox-scroll"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain pb-(--space-14)', className)}
      onScroll={(event) => {
        if (restored.current === memoryKey)
          scrollMemory.set(memoryKey, event.currentTarget.scrollTop);
        maybeLoadMore();
      }}
    >
      <div
        ref={(el) => {
          box.current = el;
          if (typeof listRef === 'function') listRef(el);
          else if (listRef != null) (listRef as { current: HTMLDivElement | null }).current = el;
        }}
        role="listbox"
        aria-label={label}
        aria-busy={loading || status === 'fetching' || undefined}
        aria-activedescendant={!loading && cursor >= 0 ? optionId(cursor) : undefined}
        tabIndex={0}
        data-slot="inbox-list"
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
          Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
            <SkeletonRow key={i} />
          ))
        ) : virtual ? (
          // Above a hundred rows only what is in view is in the page — the cursor's row always, so
          // `aria-activedescendant` names a real element (People's virtualized list, the same way).
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
                {(flat[v.index] as FlatItem).draw()}
              </div>
            ))}
          </div>
        ) : (
          flat.map((f) => <Fragment key={f.key}>{f.draw()}</Fragment>)
        )}
      </div>
      <ListFoot
        status={status}
        rows={openRows.length}
        onRetry={onRetry}
        retryPending={retryPending}
        onReadOn={onLoadMore}
      />
      {tail?.failure != null && (
        <RetryNote
          data-slot="inbox-tail-error"
          className="px-gutter pt-(--space-3)"
          onRetry={tail.failure.retry}
          pending={tail.failure.pending}
        >
          {TAIL_FAILED}
        </RetryNote>
      )}
    </div>
  );
}

/** A section head inside the list: a lane's boundary (All open) or the decided list's title. */
function Divider({
  children,
  slot,
  lane,
  gap = false,
}: {
  children: string;
  slot: string;
  lane?: string;
  /** The decided list's head sits 32 px under the end tab (the board's `.endm + .divider`). */
  gap?: boolean;
}) {
  return (
    <div
      role="presentation"
      data-slot={slot}
      data-lane={lane}
      className={cn(
        'flex items-center gap-(--space-2_5) px-gutter pb-(--space-1)',
        gap ? 'pt-(--space-8)' : 'pt-(--space-3)',
      )}
    >
      <span className="text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase">
        {children}
      </span>
      <i aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Why a list stops short of its end: on its way, stopped by its scan, failed, or not read. */
function ListFoot({
  status,
  rows,
  onRetry,
  retryPending,
  onReadOn,
}: {
  status: ListStatus;
  rows: number;
  onRetry: (() => void) | undefined;
  retryPending: boolean;
  onReadOn: (() => void) | undefined;
}) {
  const failed = status === 'error';
  const words =
    status === 'unread'
      ? NOT_RECORDED
      : status === 'budget'
        ? MORE_TO_READ
        : status === 'more' || status === 'fetching'
          ? LOADING_MORE
          : null;
  return (
    <>
      {/* Mounted in every state, so a failure's words are announced as they come. */}
      <RetryNote
        data-slot="inbox-error"
        className="px-gutter pt-(--space-3) empty:p-0"
        onRetry={onRetry}
        pending={retryPending}
      >
        {failed ? (rows === 0 ? LIST_FAILED : REST_FAILED) : null}
      </RetryNote>
      {words !== null && (
        <ListEnd data-slot="inbox-end" data-status={status}>
          {words}
        </ListEnd>
      )}
      {status === 'budget' && onReadOn !== undefined && (
        <div className="flex justify-center pt-(--space-2)">
          <Button size="xs" data-slot="inbox-read-on" onClick={onReadOn}>
            {READ_ON}
          </Button>
        </div>
      )}
    </>
  );
}

const CHIP_TONE: Record<ChipTone, 'default' | 'bad' | 'warn' | 'dim'> = {
  default: 'default',
  bad: 'bad',
  warn: 'warn',
  dim: 'dim',
};

/** A row: the chips, the title, the sub-line, and the short age on the right. */
function InboxRow({
  id,
  row,
  posinset,
  setsize,
  active,
  selected,
  onPress,
}: {
  id: string;
  row: RowView;
  posinset: number;
  setsize: number;
  active: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: an option is reached through the listbox's aria-activedescendant, never by its own focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys for every row
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-posinset={posinset}
      aria-setsize={setsize}
      data-slot="inbox-row"
      data-lane={row.lane}
      data-done={row.done ? '' : undefined}
      data-withdrawn={row.withdrawn ? '' : undefined}
      data-active={active ? '' : undefined}
      data-selected={selected ? '' : undefined}
      onClick={onPress}
      className={cn(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-(--space-3) px-gutter py-(--space-2_5)',
        'border-0 border-b-(length:--stroke-hair) border-dotted border-line',
        'transition-[background-color] duration-(--duration-fast) ease-standard',
        '[@media(hover:hover)]:not-data-selected:hover:bg-lift-05',
        'not-data-selected:data-active:bg-lift-05',
        'data-selected:bg-lift-08 data-selected:shadow-select-rule',
      )}
    >
      <span className="col-start-1 row-start-1 min-w-0">
        {row.chips.length > 0 && (
          <span
            data-slot="inbox-row-chips"
            className="mb-(--space-1_5) flex flex-wrap items-center gap-(--space-1_5)"
          >
            {row.chips.map((chip) => (
              <Badge key={chip.label} variant="outline" tone={CHIP_TONE[chip.tone]}>
                {chip.label}
              </Badge>
            ))}
          </span>
        )}
        <span
          data-slot="inbox-row-title"
          className={cn(
            'block min-w-0 text-body leading-(--lead-snug) font-medium',
            // Done or withdrawn: the quieter ink — never drawn as live content.
            row.done || row.withdrawn ? 'text-fg2' : 'text-fg1 in-data-selected:text-fg',
          )}
        >
          {row.title}
        </span>
        {row.sub !== null && (
          <span
            data-slot="inbox-row-sub"
            className="mt-(--space-0_5) block min-w-0 text-assist leading-list text-fg3 in-data-selected:text-fg2"
          >
            {row.sub}
          </span>
        )}
      </span>
      <span
        data-slot="inbox-row-age"
        className="col-start-2 row-start-1 pt-(--space-0_5) font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3"
      >
        {row.age}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      aria-hidden="true"
      data-slot="inbox-skeleton"
      className="border-0 border-b-(length:--stroke-hair) border-dotted border-line px-gutter py-(--space-2_5)"
    >
      <SkeletonText className="text-kick" width="30%" />
      <SkeletonText className="mt-(--space-1_5) text-body leading-(--lead-snug)" width="72%" />
      <SkeletonText className="mt-(--space-0_5) text-assist leading-list" width="88%" />
    </div>
  );
}
