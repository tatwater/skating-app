import { Autocomplete } from '@base-ui/react/autocomplete';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLocationDot, faMagnifyingGlass } from '@fortawesome/sharp-light-svg-icons';
import { faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import { ringsToPath, silhouetteProjection } from '@skating/core';
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import { Avatar } from '../kit/avatar';
import { Kbd } from '../kit/kbd';
import { SearchTrigger } from '../kit/top-bar-parts';
import { type SearchGroup, type SearchRow, splitMatch } from './searchModel';
import { PLATE } from './styles';

/**
 * Global search (boards 3.17–3.20), props only. Closed, it's the kit's `SearchTrigger` — a button
 * dressed as the underline input, wearing `/`. Open, the same place is the real input, and the
 * plate hangs **centered under it** (Review 3): Recent with no query; Lakes, Bays and Skaters for
 * one; "click it on the map" when nothing matches.
 *
 * The plate is Base UI Autocomplete's own popup, anchored to the field — the kit's Popover would
 * trap focus in a dialog, and search's focus belongs in the field while ↑↓ walk the rows.
 */
export interface GlobalSearchViewProps {
  open: boolean;
  /** The trigger was pressed (`true`), or the plate was dismissed (`false`). */
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** The groups to draw: Recent, or Lakes · Bays · Skaters. */
  groups: readonly SearchGroup[];
  /** A search is in flight; earlier results stay up meanwhile. */
  loading?: boolean;
  /** The query came back empty: the "click it on the map" note, naming what was typed. */
  noResultsFor?: string | null;
  onPick: (row: SearchRow) => void;
  /** Scope the plate to a container (stories: each theme quad holds its own). */
  container?: HTMLElement | null;
  className?: string;
}

export const SEARCH_LABEL = 'Search lakes, bays, and skaters';

/** Close reasons that mean the person dismissed the plate; typing it empty is not one of them. */
const DISMISS = new Set(['escape-key', 'outside-press', 'focus-out', 'item-press', 'close-press']);

export function GlobalSearchView({
  open,
  onOpenChange,
  query,
  onQueryChange,
  groups,
  loading = false,
  noResultsFor = null,
  onPick,
  container,
  className,
}: GlobalSearchViewProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The plate centers under the whole field (Review 3), not under the bare <input> inside it.
  const anchorRef = useRef<HTMLDivElement>(null);
  // Set while the field holds focus as it closes, so focus returns to the trigger — but not when
  // the close came from a press somewhere else, which takes focus where it was pressed.
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus();
  }, [open]);

  const count = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div
      ref={anchorRef}
      data-slot="global-search"
      className={cn('relative flex w-full max-w-search min-w-0 justify-center', className)}
    >
      <Autocomplete.Root
        open={open}
        onOpenChange={(next, details) => {
          if (!next && DISMISS.has(details.reason)) onOpenChange(false);
        }}
        mode="none"
        items={groups}
        value={query}
        onValueChange={(next, details) => {
          // Choosing a row would write its name into the field; the query stays what was typed.
          if (details.reason !== 'item-press') onQueryChange(next);
        }}
        itemToStringValue={(row: SearchRow) => row.name}
        autoHighlight="always"
        keepHighlight
        openOnInputClick={false}
      >
        {open ? (
          <SearchField refocus={refocus} loading={loading && count > 0} />
        ) : (
          <SearchTrigger
            ref={triggerRef}
            data-attr="search"
            label={SEARCH_LABEL}
            shortcut="/"
            keyshortcuts="/"
            aria-label={SEARCH_LABEL}
            onClick={() => onOpenChange(true)}
            className="w-full"
          />
        )}
        <Autocomplete.Portal container={container}>
          <Autocomplete.Positioner
            anchor={anchorRef}
            align="center"
            sideOffset={12}
            className="isolate z-[calc(var(--z-viewer)+1)] outline-none"
          >
            <Autocomplete.Popup
              data-slot="global-search-plate"
              // Search text, lake and people's names: never autocaptured (D240).
              className={cn(
                PLATE,
                'ph-no-capture flex max-h-(--available-height) w-[32.5rem] max-w-(--available-width) flex-col overflow-hidden pt-(--space-1_5)',
                'transition-opacity duration-(--duration-fast) ease-standard data-starting-style:opacity-0',
              )}
            >
              <Autocomplete.List
                data-slot="global-search-list"
                className="min-h-0 overflow-y-auto outline-none"
              >
                {(group: SearchGroup) => (
                  <Autocomplete.Group
                    key={group.id}
                    items={group.items}
                    data-slot="global-search-group"
                  >
                    <Autocomplete.GroupLabel
                      data-slot="global-search-group-label"
                      className="flex h-[1.875rem] items-center px-(--space-4) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
                    >
                      {group.label}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(row: SearchRow) => (
                        <ResultRow key={row.key} row={row} query={query} onPick={onPick} />
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
              {count === 0 && <EmptyNote noResultsFor={noResultsFor} loading={loading} />}
              <div
                data-slot="global-search-foot"
                className="mt-(--space-1_5) flex h-[2.375rem] shrink-0 items-center gap-(--space-4_5) border-0 border-t border-solid border-line px-(--space-4) text-assist leading-none text-fg3"
              >
                {count > 0 && (
                  <>
                    <FootKey keys={['↑', '↓']}>Move</FootKey>
                    <FootKey keys={['↵']}>Open</FootKey>
                  </>
                )}
                <FootKey keys={['Esc']}>Close</FootKey>
              </div>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
    </div>
  );
}

/** The open field: the trigger's metrics with the rule lit, the query, and Esc at the end. */
function SearchField({ refocus, loading }: { refocus: { current: boolean }; loading: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    input?.focus();
    // Runs before the field leaves the DOM: is focus still in it?
    return () => {
      refocus.current = document.activeElement === input;
    };
  }, [refocus]);
  return (
    <div
      data-slot="global-search-field"
      className={cn(
        'flex h-btn-sm w-full min-w-0 items-center gap-(--space-2) px-0 pb-(--space-0_5)',
        'border-0 border-b border-solid border-fg shadow-[0_1px_0_0_var(--fg)]',
        'text-assist leading-none text-fg',
      )}
    >
      <FontAwesomeIcon
        icon={faMagnifyingGlass}
        aria-hidden="true"
        className="h-[1em] shrink-0 text-fg2"
      />
      <Autocomplete.Input
        ref={inputRef}
        aria-label={SEARCH_LABEL}
        placeholder={SEARCH_LABEL}
        className="ph-no-capture min-w-0 flex-1 bg-transparent p-0 text-assist leading-none text-fg caret-fg outline-none placeholder:text-fg3"
      />
      <span aria-hidden="true" className={cn('shrink-0 text-fg3', !loading && 'invisible')}>
        <FontAwesomeIcon icon={faSpinnerThird} className="h-[1em] motion-safe:animate-spin" />
      </span>
      <Kbd variant="dim" aria-hidden="true">
        Esc
      </Kbd>
    </div>
  );
}

export function ResultRow({
  row,
  query,
  onPick,
}: {
  row: SearchRow;
  query: string;
  onPick: (row: SearchRow) => void;
}) {
  const hit = splitMatch(row.name, query);
  return (
    <Autocomplete.Item
      value={row}
      data-slot="global-search-row"
      data-kind={row.kind}
      onClick={() => onPick(row)}
      className={cn(
        'flex h-12 cursor-pointer items-center gap-(--space-3) rounded-control px-(--space-4) text-fg1 outline-none select-none',
        'transition-colors duration-(--duration-instant) ease-standard data-highlighted:bg-raise',
      )}
    >
      <RowMark row={row} />
      <span className="flex min-w-0 flex-col gap-(--space-0_5)">
        <span
          data-slot="global-search-name"
          className="truncate text-row leading-(--lead-snug) text-fg"
        >
          {hit ? (
            <>
              {hit.before}
              <b className="font-semibold underline decoration-fg3 underline-offset-[3px]">
                {hit.match}
              </b>
              {hit.after}
            </>
          ) : (
            row.name
          )}
        </span>
        <span
          data-slot="global-search-sub"
          className={cn(
            'truncate text-assist leading-(--lead-snug) text-fg2',
            row.kind === 'skater' && 'font-(family-name:--family-mono) text-mono-sm',
          )}
        >
          {row.sub}
        </span>
      </span>
      {row.meta !== undefined && (
        <span
          data-slot="global-search-meta"
          className="ml-auto shrink-0 text-assist leading-none whitespace-nowrap text-fg2"
        >
          {row.meta}
        </span>
      )}
    </Autocomplete.Item>
  );
}

/** The leading slot, 36 × 26: a lake's outline, a pin, or the person's circle. */
function RowMark({ row }: { row: SearchRow }) {
  if (row.kind === 'skater') {
    return (
      <span className="flex w-9 shrink-0 justify-center">
        <Avatar
          name={row.name}
          {...(row.imageUrl ? { src: row.imageUrl } : {})}
          aria-hidden="true"
        />
      </span>
    );
  }
  if (row.silhouette) return <Outline rings={row.silhouette.rings} bbox={row.silhouette.bbox} />;
  return (
    <span className="flex h-[1.625rem] w-9 shrink-0 items-center justify-center text-fg2">
      <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" className="h-[0.9375rem]" />
    </span>
  );
}

/** A lake's shape, small: the outline only, never anyone's track or put-in. */
function Outline({ rings, bbox }: NonNullable<SearchRow['silhouette']>) {
  const W = 36;
  const H = 26;
  const p = silhouetteProjection(bbox, W, H, 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      data-slot="global-search-outline"
      className="h-[1.625rem] w-9 shrink-0"
    >
      <path
        d={ringsToPath(rings, p)}
        fillRule="evenodd"
        className="fill-raise stroke-fg2"
        strokeWidth={0.8}
      />
    </svg>
  );
}

export function EmptyNote({
  noResultsFor,
  loading,
}: {
  noResultsFor: string | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div role="status" className="grid h-12 place-items-center text-fg3">
        <FontAwesomeIcon icon={faSpinnerThird} className="h-[1.2em] motion-safe:animate-spin" />
        <span className="sr-only">Searching</span>
      </div>
    );
  }
  return (
    <div
      role="status"
      data-slot="global-search-empty"
      className="flex flex-col gap-(--space-1_5) px-(--space-4) pt-(--space-4_5) pb-(--space-5)"
    >
      {noResultsFor !== null ? (
        <>
          <span className="text-row text-fg">
            No lakes, bays, or skaters match “{noResultsFor}”.
          </span>
          <span className="text-assist leading-body text-fg2">
            Know water we don’t have? Click it on the Explore map to ask the moderators to add it.
          </span>
        </>
      ) : (
        <span className="text-assist leading-body text-fg2">
          Type the name of a lake, a bay, or a skater.
        </span>
      )}
    </div>
  );
}

function FootKey({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-(--space-1_5) whitespace-nowrap">
      {keys.map((k) => (
        <Kbd key={k} variant="dim" aria-hidden="true">
          {k}
        </Kbd>
      ))}
      {children}
    </span>
  );
}
