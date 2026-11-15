import { type ReactElement, type ReactNode, useRef, useState } from 'react';

import { Lanes } from '@/components/kit/lanes';
import { isTextEntry, usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { type Count, countText } from '../overview/overviewModel';
import { type Loadable, loaded } from '../reads/consoleReads';
import { ConsoleStatus } from '../shell/ConsoleShell';
import { BodiesTable } from './BodiesTable';
import { BodyPreview, OPEN_LABEL } from './BodyPreview';
import {
  allRows,
  type BodiesListData,
  type BodyPreviewData,
  type RemovedPreviewData,
} from './bodiesData';
import { laneKicker, nextSort } from './bodiesModel';
import { type BodiesQuery, listKey, listSort } from './bodiesSearch';
import { appliedOptions, chipWords, toggleOption } from './bodyFacets';
import { BODY_LANES, type BodyLane, laneById, laneGroups } from './bodyLanes';
import { ListTools } from './ListTools';

/**
 * The Bodies library (boards 5.1–5.3) as the console mounts it, from what the route hands it: the
 * place in the URL (`query`), the list the lane's read returned, the lanes' counts and the open
 * body's preview. `BodiesRoute` wires it to the router and Convex; a story draws the same page in
 * the real shell.
 *
 * Three panes, as the boards draw them: **the lanes** (which list), **the list** (its word and
 * kicker, the search, the facet row, the applied chips, the table) and **the preview**. Tab moves
 * between them and ↑↓ within; ⏎ or Space on a row opens it in the preview and moves focus there,
 * where ⏎ opens the body's console and ⇧⏎ comes back to the list. F opens the filter while the list
 * pane has focus (and not a field or the rows, which type ahead); / goes to the search.
 *
 * Every change of place goes through `onQueryChange` — the route writes it to the URL, so the list
 * comes back exactly as it was when you return from a body. Nothing here is a fixture: a lane no
 * read serves says *Not recorded yet*, a count no read gives is absent, a read that failed says so.
 */

export type BodiesViewProps = {
  /** The lanes, in the sidebar's order. Default: the library's. */
  lanes?: readonly BodyLane[];
  query: BodiesQuery;
  /** A change of place. `replace` for one that shouldn't stack history (moving down the list). */
  onQueryChange: (next: BodiesQuery, how?: { replace?: boolean }) => void;
  list: BodiesListData;
  /** Near the list's end with more to come. */
  onLoadMore?: () => void;
  /** Re-runs a failed list (its *Try again*). */
  onRetryList?: () => void;
  /** Re-runs the preview's failed reads. */
  onRetryPreview?: () => void;
  /** The preview's failed reads were tried again; their fresh answers aren't in. */
  previewPending?: boolean;
  /** Each lane's count, when a read gives one. */
  laneCounts: Readonly<Partial<Record<string, Count | null>>>;
  /** How many bodies the corpus holds, when a read says. */
  corpus: Count | null;
  /**
   * The open body; `undefined` while it loads, `null` with none open, `'error'` if it failed, and
   * `'unavailable'` for a body the reads can't serve (a rejected one) — drawn from its list row.
   */
  preview: BodyPreviewData | null | undefined | 'error' | 'unavailable';
  /** For an `'unavailable'` preview: what its record still holds, on its way or failed. */
  previewRemoved?: Loadable<RemovedPreviewData | null> | null;
  /** The instant ages are read against. */
  now: number;
  /** The open action's words (where it opens the body). */
  openLabel?: string;
  /** The router's link to a body's console; the preview's open action renders as it. */
  bodyLink?: (id: string) => ReactElement;
  /** Opens a body's console (⏎ in the preview). */
  onOpenBody: (id: string) => void;
  /** The page's status-bar groups ("Last campaign 12 Oct"). */
  status?: readonly ReactNode[];
  /**
   * The counts' failure note, drawn at the lanes' foot (the counts are theirs) — a note and its
   * *Try again* are a block, which the one-line status bar would clip.
   */
  countsNote?: ReactNode;
  className?: string;
};

export function BodiesView({
  lanes = BODY_LANES,
  query,
  onQueryChange,
  list,
  onLoadMore,
  onRetryList,
  onRetryPreview,
  previewPending = false,
  laneCounts,
  corpus,
  preview,
  previewRemoved = null,
  now,
  bodyLink,
  openLabel = OPEN_LABEL,
  onOpenBody,
  status = [],
  countsNote,
  className,
}: BodiesViewProps) {
  const middle = useRef<HTMLElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const { lane } = query;
  // The order the list is in — a search too short to run keeps the lane's, its heading lit.
  const sort = listSort(query);
  const set = (patch: Partial<BodiesQuery>, how?: { replace?: boolean }) =>
    onQueryChange({ ...query, ...patch }, how);
  // A body the reads can't serve is drawn from its row; while the first page is still on its way
  // the pane holds its shape rather than saying the list doesn't hold it.
  const unavailableRow =
    preview === 'unavailable' ? (allRows(list).find((r) => r.id === query.bodyId) ?? null) : null;
  // Its record, once read, names it without the row.
  const previewData =
    preview !== 'unavailable'
      ? preview
      : unavailableRow === null &&
          list.status === 'loading' &&
          loaded(previewRemoved ?? undefined) == null
        ? undefined
        : { unavailable: unavailableRow, removed: previewRemoved };

  // F opens the filter from the list's tools (the tabs, the buttons, the chips) — not from the
  // search, which types it, nor from the rows, whose letters type ahead.
  usePaneKeys(tools, [
    {
      key: 'F',
      label: 'Filter',
      run: () => setFilterOpen(true),
      enabled: list.serves.facets.length > 0,
    },
  ]);
  usePaneKeys(inspector, [
    {
      key: 'Enter',
      label: openLabel,
      run: () => {
        if (query.bodyId !== null) onOpenBody(query.bodyId);
      },
      enabled:
        query.bodyId !== null &&
        preview != null &&
        preview !== 'error' &&
        preview !== 'unavailable',
    },
    { key: 'Shift+Enter', label: 'Back to the list', run: () => grid.current?.focus() },
  ]);

  const applied = appliedOptions(query.facets);
  const kicker = laneKicker({
    shown: list.total,
    lane: laneCounts[lane.id] ?? null,
    corpus,
    laneWord: lane.word,
    narrowedBy: [
      ...(query.state !== null ? [query.state] : []),
      ...applied.map(({ option }) => chipWords(option)),
    ],
  });

  return (
    <div
      data-slot="bodies-page"
      className={cn(
        'grid h-full min-h-0 grid-cols-[var(--size-lanes)_minmax(0,1fr)_var(--size-inspector)]',
        className,
      )}
    >
      <ConsoleStatus groups={status} />
      <section
        data-pane="lanes"
        aria-label="Lanes"
        className="flex min-h-0 min-w-0 flex-col border-0 border-r border-solid border-line"
      >
        <Lanes
          label="Bodies"
          selected={lane.id}
          onSelect={(id) => {
            // The lane on screen again keeps its place; another lane opens fresh.
            if (id === lane.id) return;
            const next = laneById(id, lanes);
            onQueryChange({
              lane: next,
              bodyId: null,
              q: '',
              state: null,
              facets: {},
              sort: next.sort,
            });
          }}
          groups={laneGroups(lanes).map((g) => ({
            label: g.label,
            lanes: g.lanes.map((l) => {
              const count = laneCounts[l.id] ?? null;
              return {
                id: l.id,
                label: l.label,
                ...(count !== null && { count: countText(count) }),
                ...(count !== null && count.count === 0 && !count.capped && { dim: true }),
              };
            }),
          }))}
        />
        {countsNote}
      </section>

      <section
        ref={middle}
        data-pane="middle"
        aria-label="List"
        tabIndex={-1}
        onKeyDown={(event) => {
          // / goes to the search from anywhere in the list pane but a field (which types it).
          if (event.key !== '/' || event.defaultPrevented || isTextEntry(event.target as Element)) {
            return;
          }
          event.preventDefault();
          search.current?.focus();
        }}
        className="flex min-h-0 min-w-0 flex-col border-0 border-r border-solid border-line outline-none"
      >
        <div
          data-slot="bodies-head"
          className="flex min-w-0 shrink-0 items-end gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-4) pb-(--space-3)"
        >
          <h1
            data-slot="page-word"
            className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
          >
            {lane.title}
          </h1>
          {kicker !== null && (
            <span
              data-slot="bodies-kicker"
              className="min-w-0 truncate pb-(--space-0_5) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
            >
              {kicker}
            </span>
          )}
        </div>
        <div ref={tools} data-slot="bodies-tools" className="contents">
          <ListTools
            lane={lane}
            list={list}
            q={query.q}
            onSearch={(q) =>
              set({ q, sort: q === '' ? lane.sort : { column: 'match' } }, { replace: true })
            }
            state={query.state}
            onStateChange={(state) => set({ state })}
            facets={query.facets}
            onToggleFacet={(facet, option) =>
              set({ facets: toggleOption(query.facets, facet, option) })
            }
            onClearFacets={() => set({ facets: {} })}
            filterOpen={filterOpen}
            onFilterOpenChange={setFilterOpen}
            searchRef={search}
            place={searchPlace(query)}
          />
        </div>
        <div className="min-h-0 flex-1 border-0 border-t border-solid border-line flex flex-col">
          <BodiesTable
            lane={lane}
            list={list}
            q={query.q}
            sort={sort}
            selectedId={query.bodyId}
            now={now}
            onSort={(column) => set({ sort: nextSort(sort, column) })}
            onSelect={(bodyId) => set({ bodyId }, { replace: true })}
            onOpen={(bodyId) => {
              set({ bodyId }, { replace: true });
              inspector.current?.focus();
            }}
            {...(onLoadMore !== undefined && { onLoadMore })}
            {...(onRetryList !== undefined && { onRetry: onRetryList })}
            memoryKey={listKey(query)}
            onSearchKey={() => search.current?.focus()}
            gridRef={grid}
          />
        </div>
      </section>

      <section
        ref={inspector}
        data-pane="inspector"
        aria-label="Preview"
        tabIndex={-1}
        className="flex min-h-0 min-w-0 flex-col outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
      >
        <BodyPreview
          // The body's own: nothing a preview holds carries to the next body chosen.
          key={query.bodyId ?? 'none'}
          data={previewData}
          now={now}
          {...(bodyLink !== undefined && { bodyLink })}
          onOpen={onOpenBody}
          openLabel={openLabel}
          // The note holds (Trying again…) and keeps focus while the reads run again.
          {...(onRetryPreview !== undefined && { onRetry: onRetryPreview })}
          pending={previewPending}
        />
      </section>
    </div>
  );
}

/**
 * Where a search is typed: the lane, the state tab, the facets and the open body. The order is the
 * search's own (a search ranks by match), so it isn't part of the place.
 */
export function searchPlace(query: BodiesQuery): string {
  return JSON.stringify([query.lane.id, query.state, query.facets, query.bodyId]);
}
