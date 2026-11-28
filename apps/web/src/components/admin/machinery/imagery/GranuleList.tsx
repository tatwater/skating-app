import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ListEnd } from '@/components/kit/list-end';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { KEYS_PASS_THROUGH } from '@/lib/keys';
import { useLoadAhead } from '@/lib/loadAhead';
import { cn } from '@/lib/utils';

import type { ChainStatus } from '../../reads/joinChain';
import { RunChipBadge } from '../corpus/RunRow';
import type { GranuleRowModel } from './granuleRows';
import { FAILED_FIRST_SHOWN, GRANULE_FILTERS, type GranuleFilter } from './imageryModel';
import * as W from './imageryWords';

/**
 * **The granule list** (board 6.4's middle column): the filter row (*All*, *Queued*, *Cutting*,
 * *Empty*, *Failed*), then the rows. Under *All* the failed granules come first (the server's
 * `failedFirst`, at most 50), then *Everything else · newest first*; under a filter, that filter's
 * granules newest first. The list ends in its tab (*All 24*) — or, when the failed section is full
 * and may have left older failures out, says *Failed* lists them all and ends in what it shows
 * (*74 shown*). Drawn from props; the route reads.
 *
 * - **One tab stop** for the rows: a `listbox` with a cursor (`aria-activedescendant`); ↑↓ move,
 *   Home/End jump, **⏎ or Space opens** the granule (and from the keys focus follows into the
 *   detail). `G` and `?` pass through to the keyboard layer. No letter acts on a granule here.
 * - **Pages arrive as it scrolls** (`useLoadAhead`); a failed page is said in its own place with
 *   *Try again*. Loading is skeleton rows.
 */

export type GranuleListProps = {
  filter: GranuleFilter;
  onFilter: (filter: GranuleFilter) => void;
  /** Under *All*: the failed granules drawn first; `null` under any other filter. */
  failed: { rows: readonly GranuleRowModel[]; status: 'loading' | 'error' | 'done' } | null;
  rows: readonly GranuleRowModel[];
  status: ChainStatus;
  selectedId: string | null;
  onOpen: (id: string, from: 'keys' | 'press') => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  retryPending?: boolean;
  onRetryFailed?: () => void;
  /** Out of sight (a narrow screen gives the page to the granule): asks for nothing. */
  paused?: boolean;
  listRef?: Ref<HTMLDivElement>;
  className?: string;
};

type Entry =
  | { type: 'row'; row: GranuleRowModel; index: number }
  | { type: 'divider'; label: string }
  | { type: 'note'; label: string };

export function GranuleList({
  filter,
  onFilter,
  failed,
  rows,
  status,
  selectedId,
  onOpen,
  onLoadMore,
  onRetry,
  retryPending = false,
  onRetryFailed,
  paused = false,
  listRef,
  className,
}: GranuleListProps) {
  const base = useId();
  const optionId = (index: number) => `${base}-g-${index}`;
  const scroller = useRef<HTMLDivElement | null>(null);

  const ordered: GranuleRowModel[] = [...(failed?.rows ?? []), ...rows];
  // A full failed section may have left older failures out (the rows below never repeat one).
  const capped = failed !== null && failed.rows.length >= FAILED_FIRST_SHOWN;
  const entries: Entry[] = [];
  ordered.forEach((row, index) => {
    if (failed !== null && failed.rows.length > 0 && index === failed.rows.length) {
      entries.push({ type: 'divider', label: W.EVERYTHING_ELSE });
    }
    entries.push({ type: 'row', row, index });
    if (capped && failed !== null && index === failed.rows.length - 1) {
      entries.push({ type: 'note', label: W.failedShownOf(failed.rows.length) });
    }
  });

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (selectedId !== null) setCursorId(selectedId);
  }, [selectedId]);
  const cursor = ordered.findIndex((r) => r.id === cursorId);
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
    const row = ordered[index];
    if (row === undefined) return;
    scrollToCursor.current = true;
    setCursorId(row.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (ordered.length === 0) return;
    const step = (to: number) => {
      event.preventDefault();
      moveTo(Math.max(0, Math.min(ordered.length - 1, to)));
    };
    if (event.key === 'ArrowDown') return step(cursor < 0 ? 0 : cursor + 1);
    if (event.key === 'ArrowUp') return step(cursor < 0 ? 0 : cursor - 1);
    if (event.key === 'Home') return step(0);
    if (event.key === 'End') return step(ordered.length - 1);
    if (event.key === 'Enter' || event.key === ' ') {
      if (cursor < 0 || event.shiftKey) return;
      event.preventDefault();
      if (event.repeat) return;
      onOpen((ordered[cursor] as GranuleRowModel).id, 'keys');
    }
  };

  const pressing = useRef(false);
  const loading = status === 'loading' || failed?.status === 'loading';
  const done = status === 'done' && (failed === null || failed.status === 'done');
  const total = ordered.length;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        data-slot="granule-filters"
        className="shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-1_5)"
      >
        <ToggleGroup
          aria-label={W.FILTER_LABEL}
          value={filter}
          onValueChange={(v) => onFilter(v as GranuleFilter)}
          className="flex w-full [&>*]:flex-1"
        >
          {GRANULE_FILTERS.map((f) => (
            <ToggleGroupItem key={f} value={f} data-slot="granule-filter" data-filter={f}>
              {W.FILTER_WORDS[f]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div
        ref={scroller}
        data-slot="granule-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-(--space-14)"
        onScroll={maybeLoadMore}
      >
        <div
          ref={listRef}
          role="listbox"
          aria-label={W.LIST_LABEL}
          aria-busy={loading || status === 'fetching' || undefined}
          aria-activedescendant={!loading && cursor >= 0 ? optionId(cursor) : undefined}
          tabIndex={0}
          data-slot="granule-list"
          {...{ [KEYS_PASS_THROUGH]: '' }}
          onKeyDown={onKeyDown}
          onPointerDown={() => {
            pressing.current = true;
          }}
          onFocus={() => {
            setFocused(true);
            const pressed = pressing.current;
            pressing.current = false;
            if (pressed || ordered.length === 0 || cursor >= 0) return;
            moveTo(
              Math.max(
                ordered.findIndex((r) => r.id === selectedId),
                0,
              ),
            );
          }}
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
                e.type === 'divider' ? (
                  <Divider key="divider">{e.label}</Divider>
                ) : e.type === 'note' ? (
                  <p
                    key="failed-capped"
                    role="presentation"
                    data-slot="granule-failed-capped"
                    className="m-0 px-gutter pt-(--space-2) text-assist text-fg3"
                  >
                    {e.label}
                  </p>
                ) : (
                  <GranuleRow
                    key={e.row.id}
                    id={optionId(e.index)}
                    row={e.row}
                    posinset={e.index + 1}
                    setsize={done ? total : -1}
                    active={focused && e.index === cursor}
                    selected={e.row.id === selectedId}
                    onPress={() => {
                      setCursorId(e.row.id);
                      onOpen(e.row.id, 'press');
                    }}
                  />
                ),
              )}
          {done && (
            <div role="presentation">
              <ListEnd data-slot="granule-list-end">
                {total === 0
                  ? W.NONE_IN_FILTER[filter]
                  : capped
                    ? W.shownGranules(total)
                    : W.allGranules(total)}
              </ListEnd>
            </div>
          )}
        </div>
        <RetryNote
          data-slot="granule-failed-error"
          className="px-gutter pt-(--space-3) empty:p-0"
          onRetry={onRetryFailed}
        >
          {failed?.status === 'error' ? W.FAILED_FIRST_FAILED : null}
        </RetryNote>
        <RetryNote
          data-slot="granule-list-error"
          className="px-gutter pt-(--space-3) empty:p-0"
          onRetry={onRetry}
          pending={retryPending}
        >
          {status === 'error' ? (rows.length === 0 ? W.LIST_FAILED : W.REST_FAILED) : null}
        </RetryNote>
        {(status === 'more' || status === 'fetching') && (
          <ListEnd data-slot="granule-list-end" data-status={status}>
            {W.LOADING_MORE}
          </ListEnd>
        )}
      </div>
    </div>
  );
}

/**
 * A granule's row: the state chip and the attempts chip over the title, the sub-line under it, the
 * age on the title's baseline — the run row's register (`RunRow`), one chip optional. An option of
 * its list's listbox, reached through `aria-activedescendant`.
 */
function GranuleRow({
  id,
  row,
  posinset,
  setsize,
  active,
  selected,
  onPress,
}: {
  id: string;
  row: GranuleRowModel;
  posinset: number;
  setsize: number;
  active: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: an option is reached through the listbox's aria-activedescendant, never by its own focus
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns the keys (⏎ and Space open)
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-posinset={posinset}
      aria-setsize={setsize}
      data-slot="granule-row"
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
        <span className="mb-(--space-1_5) flex flex-wrap items-center gap-(--space-1_5)">
          <RunChipBadge chip={row.state} data-slot="granule-row-state" data-tone={row.state.tone} />
          {row.attempts !== null && (
            <RunChipBadge chip={row.attempts} data-slot="granule-row-attempts" />
          )}
        </span>
        <span
          data-slot="granule-row-title"
          className="block min-w-0 truncate text-body leading-(--lead-snug) font-medium text-fg1 in-data-selected:text-fg"
        >
          {row.title}
        </span>
        <span
          data-slot="granule-row-sub"
          className="mt-(--space-0_5) block min-w-0 text-assist leading-list text-fg3 in-data-selected:text-fg2"
        >
          {row.sub}
        </span>
      </span>
      <span
        data-slot="granule-row-age"
        className="col-start-2 row-start-1 pt-(--space-0_5) font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3"
      >
        {row.age}
      </span>
    </div>
  );
}

/** The divider between the failed granules and the rest: its words and a rule to the pane's edge. */
function Divider({ children }: { children: string }) {
  return (
    <div
      role="presentation"
      data-slot="granule-divider"
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
      data-slot="granule-skeleton"
      className="border-0 border-b-(length:--stroke-hair) border-dotted border-line px-gutter py-(--space-2_5)"
    >
      <SkeletonText className="text-kick" width="40%" />
      <SkeletonText className="mt-(--space-1_5) text-body leading-(--lead-snug)" width="64%" />
      <SkeletonText className="mt-(--space-0_5) text-assist leading-list" width="88%" />
    </div>
  );
}
