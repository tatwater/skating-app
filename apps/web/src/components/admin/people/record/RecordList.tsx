import { type KeyboardEvent, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { DropdownMenuCaret } from '@/components/kit/dropdown-menu';
import { FacetMenu } from '@/components/kit/facet-menu';
import { FilterCount } from '@/components/kit/filter-chip';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/kit/popover';
import { RecordRow, RecordRowQuote } from '@/components/kit/record-row';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { useLoadAhead } from '@/lib/loadAhead';
import type { ReadFailure } from '../../reads/consoleReads';
import {
  type ListEnd as End,
  type RecordTab,
  type Restored,
  type RowView,
  TABS,
  titleText,
} from './recordModel';
import { type RecordKind, RECORD_WORDS as W } from './recordWords';

/**
 * **The record's list** (8.7–8.9, the sheet's left column): the three lists as tabs — Standing,
 * Deleted, Reversed — with the kinds behind *Filter* (one kind at a time: the server narrows by
 * one), then the rows newest first.
 *
 * - **Pages arrive as it scrolls**, only while it is in sight and measured (`lib/loadAhead`); while
 *   more can load, a skeleton row stands where the end tab will — never an end tab, so a floor never
 *   reads as the whole.
 * - **Still being prepared** says so in a note over the rows, and the end tab says *N so far*.
 * - **A failed page** is said in its place with *Try again*; the rows before it stand.
 * - **One tab stop**: the open row (else the first) is tabbable, and ↑↓, Home and End move between
 *   rows; ⏎ or Space opens one. A row's own *Undo* is its own stop beside it.
 */
export type RecordListProps = {
  tab: RecordTab;
  onTab: (tab: RecordTab) => void;
  kind: RecordKind | null;
  onKind: (kind: RecordKind | null) => void;
  kindOptions: Array<{ id: RecordKind; label: string; count?: number }>;
  rows: ReadonlyArray<{ view: RowView; restored: Restored | null }>;
  loading: boolean;
  end: End;
  pending: boolean;
  failure: ReadFailure | null;
  /** More pages can load and none is on its way. */
  canLoadMore: boolean;
  onLoadMore: () => void;
  selectedKey: string | null;
  onOpen: (view: RowView) => void;
  onUndo: (restored: Restored) => void;
};

export function RecordList({
  tab,
  onTab,
  kind,
  onKind,
  kindOptions,
  rows,
  loading,
  end,
  pending,
  failure,
  canLoadMore,
  onLoadMore,
  selectedKey,
  onOpen,
  onUndo,
}: RecordListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const maybeLoadMore = useLoadAhead(scroller, canLoadMore, onLoadMore, rows.length);
  const tabbable = Math.max(
    0,
    rows.findIndex((r) => r.view.key === selectedKey),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [
      ...(event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[data-slot="record-row-button"]',
      ) ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const go = (i: number) => {
      event.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, i))]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(at + 1);
      case 'ArrowUp':
        return go(at - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(buttons.length - 1);
    }
  };

  return (
    <section
      data-slot="record-list"
      aria-label={W.listLabel(W.tabs[tab])}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <div
        data-slot="record-tabs"
        className="flex shrink-0 items-center gap-(--space-2) border-0 border-b border-solid border-line px-(--space-2_5) py-(--space-2_5)"
      >
        <ToggleGroup
          aria-label={W.tabsLabel}
          value={tab}
          onValueChange={(value) => onTab(value as RecordTab)}
        >
          {TABS.map((t) => (
            // The boards' compact tab row: three lists and Filter fit the list column.
            <ToggleGroupItem key={t} value={t} data-tab={t} className="px-[0.8em]">
              {W.tabs[t]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="ms-auto">
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger
              render={
                <Button size="sm" data-slot="record-filter" data-on={kind !== null || undefined}>
                  {kind !== null && <FilterCount count={1} />}
                  {W.filter}
                  <DropdownMenuCaret />
                </Button>
              }
            />
            <PopoverContent align="end" className="w-[22rem]" aria-label={W.filter}>
              <FacetMenu
                facets={[{ id: 'kind', label: W.kindFacet, options: kindOptions }]}
                selected={{ kind: kind === null ? [] : [kind] }}
                // One kind at a time: choosing another replaces it; choosing it again clears it.
                onToggle={(_, option) => onKind(option === kind ? null : (option as RecordKind))}
              />
            </PopoverContent>
          </Popover>
        </span>
      </div>
      <div
        ref={scroller}
        data-slot="record-list-scroll"
        onScroll={maybeLoadMore}
        className="min-h-0 flex-1 overflow-y-auto pb-(--space-7)"
        aria-busy={loading || undefined}
      >
        {pending && (
          <Note data-slot="record-preparing" className="mx-gutter mt-(--space-3) mb-(--space-0_5)">
            {W.preparingNote}
          </Note>
        )}
        {loading ? (
          <div data-slot="record-list-loading">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : (
          rows.length > 0 && (
            <ul data-slot="record-rows" className="m-0 p-0" onKeyDown={onKeyDown}>
              {rows.map(({ view, restored }, i) => (
                <RecordRow
                  key={view.key}
                  data-key={view.key}
                  tabIndex={i === tabbable ? 0 : -1}
                  chips={view.chips}
                  title={titleText(view.title)}
                  gone={view.title.gone}
                  lines={view.lines.map((l) =>
                    l.quote === undefined ? (
                      l.text
                    ) : (
                      <>
                        {l.text}
                        <RecordRowQuote>{l.quote}</RecordRowQuote>
                      </>
                    ),
                  )}
                  meta={view.meta}
                  selected={view.key === selectedKey}
                  back={restored !== null}
                  onClick={() => onOpen(view)}
                  {...(restored?.undo != null && {
                    action: (
                      <Button
                        size="xs"
                        data-slot="record-row-undo"
                        onClick={() => onUndo(restored)}
                      >
                        {W.undo}
                      </Button>
                    ),
                  })}
                />
              ))}
            </ul>
          )
        )}
        <RetryNote
          className="mx-gutter mt-(--space-4)"
          data-slot="record-list-failed"
          tone="bad"
          onRetry={failure?.retry}
          pending={failure?.pending ?? false}
        >
          {failure !== null ? W.listFailed : null}
        </RetryNote>
        {end.kind === 'more' && <SkeletonRow data-slot="record-more" />}
        {end.kind === 'end' && <ListEnd data-slot="record-end">{end.label}</ListEnd>}
      </div>
    </section>
  );
}

function SkeletonRow(props: { 'data-slot'?: string }) {
  return (
    <div
      aria-hidden="true"
      data-slot="record-skeleton"
      {...props}
      className="flex flex-col gap-(--space-1_5) border-0 border-b-(length:--stroke-hair) border-dotted border-line px-gutter py-(--space-3)"
    >
      <SkeletonText className="text-kick" width="22%" />
      <SkeletonText className="text-body leading-(--lead-snug)" width="70%" />
      <SkeletonText className="text-assist leading-list" width="54%" />
    </div>
  );
}
