import {
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { useLoadAhead } from '@/lib/loadAhead';
import { cn } from '@/lib/utils';

import type { ChainStatus } from '../../reads/joinChain';
import {
  allRuns,
  LIST_FAILED,
  LOADING_MORE,
  listedSoFar,
  NO_RUNS,
  NONE_LISTED_YET,
  NOT_INDEXED,
  REST_FAILED,
} from '../words/machineryWords';
import { RunRow } from './RunRow';
import type { RunListEntry, RunRowModel } from './runRows';

/**
 * **The run list** (board 6.2's middle column): a lane's runs in the server's order, newest first,
 * a divider before each month, ending in the list-end tab (*All 41*). Drawn from props; the route
 * hands it the joined pages.
 *
 * - **One tab stop.** A `listbox` that is its own scroller; a cursor moves through the rows
 *   (`aria-activedescendant`), so Tab goes straight on to the detail. ↑↓ move, Home/End jump,
 *   typing jumps to the next title starting with what was typed (a letter again cycles). **⏎ or
 *   Space opens** the run, and from the keys focus follows into the detail. `G` and `?` pass through
 *   to the keyboard layer unless a type-ahead run is under way. No letter acts on a run here.
 * - **Pages arrive as it scrolls** (`useLoadAhead`).
 * - **Before the history is indexed** the list says so over its rows, and its end says how many are
 *   listed so far — never *All*, and an empty list is never an empty history.
 * - **States**: loading is skeleton rows; a failed page is said in its own place with *Try again*.
 *
 * Not virtualized: a lane holds a few hundred runs at most (the corpus has written a few hundred
 * rows in its life), so every row stays in the page.
 */

const TYPE_AHEAD_MS = 500;

export type RunListProps = {
  /** The list's accessible name. */
  label: string;
  entries: readonly RunListEntry[];
  status: ChainStatus;
  /** False until the history is indexed: only the newest runs are listed. */
  indexed: boolean;
  selectedId: string | null;
  onOpen: (id: string, from: 'keys' | 'press') => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  retryPending?: boolean;
  /** Out of sight (a narrow screen gives the page to the run): asks for nothing. */
  paused?: boolean;
  listRef?: Ref<HTMLDivElement>;
  className?: string;
};

export function RunList({
  label,
  entries,
  status,
  indexed,
  selectedId,
  onOpen,
  onLoadMore,
  onRetry,
  retryPending = false,
  paused = false,
  listRef,
  className,
}: RunListProps) {
  const base = useId();
  const optionId = (index: number) => `${base}-row-${index}`;
  const scroller = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const rows: RunRowModel[] = entries.flatMap((e) => (e.type === 'row' ? [e.row] : []));

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // A run opened from elsewhere (a link, the back button) takes the cursor.
  useEffect(() => {
    if (selectedId !== null) setCursorId(selectedId);
  }, [selectedId]);
  const cursor = rows.findIndex((r) => r.id === cursorId);
  const scrollToCursor = useRef(false);
  useLayoutEffect(() => {
    if (!scrollToCursor.current || cursor < 0) return;
    scrollToCursor.current = false;
    document.getElementById(optionId(cursor))?.scrollIntoView?.({ block: 'nearest' });
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
      event.preventDefault();
      // A held key opens once.
      if (event.repeat) return;
      onOpen((rows[at] as RunRowModel).id, 'keys');
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
      if ((rows[index] as RunRowModel).title.toLocaleLowerCase().startsWith(query)) {
        moveTo(index);
        return;
      }
    }
  };

  // A press focuses the list on its way to the row under the pointer, which takes the cursor itself.
  const pressing = useRef(false);
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    setFocused(true);
    const pressed = pressing.current;
    pressing.current = false;
    if (pressed || rows.length === 0) return;
    const open = rows.findIndex((r) => r.id === selectedId);
    const from = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    // Back from the detail: the cursor goes to the open run's row.
    if (from?.closest('[data-pane="detail"]') != null && open >= 0) return moveTo(open);
    if (cursor >= 0) return;
    moveTo(Math.max(open, 0));
  };

  const loading = status === 'loading';
  const done = status === 'done';

  return (
    <div
      ref={scroller}
      data-slot="run-scroll"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain pb-(--space-14)', className)}
      onScroll={maybeLoadMore}
    >
      {!indexed && !loading && (
        <Note data-slot="run-list-not-indexed" className="px-gutter pt-(--space-3)">
          {NOT_INDEXED}
        </Note>
      )}
      <div
        ref={(el) => {
          if (typeof listRef === 'function') listRef(el);
          else if (listRef != null) (listRef as { current: HTMLDivElement | null }).current = el;
        }}
        role="listbox"
        aria-label={label}
        aria-busy={loading || status === 'fetching' || undefined}
        aria-activedescendant={!loading && cursor >= 0 ? optionId(cursor) : undefined}
        tabIndex={0}
        data-slot="run-list"
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
        {loading
          ? Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
              <SkeletonRow key={i} />
            ))
          : entries.map((e) =>
              e.type === 'month' ? (
                <MonthDivider key={`m:${e.key}`}>{e.label}</MonthDivider>
              ) : (
                <Fragment key={e.row.id}>
                  <RunRow
                    id={optionId(e.index)}
                    aria-posinset={e.index + 1}
                    aria-setsize={done ? rows.length : -1}
                    title={e.row.title}
                    state={e.row.state}
                    kind={e.row.kind}
                    sub={e.row.sub}
                    age={e.row.age}
                    data-live={e.row.live ?? undefined}
                    data-rebuilt={e.row.rebuilt ? '' : undefined}
                    active={focused && e.index === cursor}
                    selected={e.row.id === selectedId}
                    onClick={() => {
                      setCursorId(e.row.id);
                      onOpen(e.row.id, 'press');
                    }}
                  />
                </Fragment>
              ),
            )}
        {done && (
          <div role="presentation">
            <ListEnd data-slot="run-list-end" data-indexed={indexed ? '' : undefined}>
              {rows.length === 0
                ? indexed
                  ? NO_RUNS
                  : NONE_LISTED_YET
                : indexed
                  ? allRuns(rows.length)
                  : listedSoFar(rows.length)}
            </ListEnd>
          </div>
        )}
      </div>
      {/* Mounted in every state, so a failure's words are announced as they come. */}
      <RetryNote
        data-slot="run-list-error"
        className="px-gutter pt-(--space-3) empty:p-0"
        onRetry={onRetry}
        pending={retryPending}
      >
        {status === 'error' ? (rows.length === 0 ? LIST_FAILED : REST_FAILED) : null}
      </RetryNote>
      {(status === 'more' || status === 'fetching') && (
        <ListEnd data-slot="run-list-end" data-status={status}>
          {LOADING_MORE}
        </ListEnd>
      )}
    </div>
  );
}

/** A month's head inside the list: its name and a rule to the pane's edge. */
function MonthDivider({ children }: { children: string }) {
  return (
    <div
      role="presentation"
      data-slot="run-list-month"
      className="flex items-center gap-(--space-2_5) px-gutter pt-(--space-3) pb-(--space-1)"
    >
      <span className="text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase">
        {children}
      </span>
      <i aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      aria-hidden="true"
      data-slot="run-list-skeleton"
      className="border-0 border-b-(length:--stroke-hair) border-dotted border-line px-gutter py-(--space-2_5)"
    >
      <SkeletonText className="text-kick" width="40%" />
      <SkeletonText className="mt-(--space-1_5) text-body leading-(--lead-snug)" width="64%" />
      <SkeletonText className="mt-(--space-0_5) text-assist leading-list" width="88%" />
    </div>
  );
}
