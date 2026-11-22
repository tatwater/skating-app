import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import { INBOX_AGE_FLOORS_DAYS } from '@skating/core';
import { useState } from 'react';

import { Button } from '@/components/kit/button';
import { DropdownMenuCaret } from '@/components/kit/dropdown-menu';
import { FacetMenu, type FacetMenuCount } from '@/components/kit/facet-menu';
import { FilterChip, FilterChipRow, FilterCount } from '@/components/kit/filter-chip';
import { Input, InputGroup, InputGroupIcon } from '@/components/kit/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/kit/popover';
import { RetryNote } from '@/components/kit/retry-note';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';

import type { InboxFilter } from '../inboxSearch';
import {
  ageFloorLabel,
  FACET_LABELS,
  FILTER,
  FILTER_AGE,
  FILTER_BODY,
  FILTER_BODY_UNNAMED,
  FILTER_CLEAR,
  FILTER_PERSON,
  FILTER_PERSON_UNNAMED,
  FIND_BODY,
  FIND_PERSON,
  facetLabel,
  SEARCH_FAILED,
} from '../words/inboxWords';

/**
 * **The tools over the list** (boards 2.1–2.8, `.facets`): the lane's tabs — no counts on a tab —
 * then *Filter ▾* at the row's end, and the applied filter as a chip under them.
 *
 * - **The tabs** are the lane's facets (`INBOX_FACETS`, *All* first). All open and Decided have none.
 * - **The filter menu** (the kit `FacetMenu` in a popover) offers the lane's kinds with their counts
 *   (the server's `inbox.lanes` facets — a menu keeps its counts), how long an item has waited (1 d,
 *   3 d, 7 d, 30 d), and a body or a person found by name. The list's read takes **one** filter, so
 *   choosing one replaces the last; a kind is the tab itself, chosen from either place.
 * - What the searches find is the route's (a body read, a person read); this view only draws them.
 */

export type FilterOption = { id: string; label: string; sub?: string };

export type FilterSearch = {
  /** What was typed; the route's read answers it. */
  onQuery: (q: string) => void;
  /** What the read found for the words typed (empty while nothing was typed). */
  results: readonly FilterOption[];
  /** The search read failed — said as a failure with *Try again*, never as "no results". */
  failure?: { retry: () => void; pending: boolean } | null;
};

export type LaneFacetsProps = {
  /** The lane's tabs, `all` first; empty for a list with none. */
  facets: readonly string[];
  facet: string;
  onFacet: (facet: string) => void;
  /** Each tab's open count, for the menu (the tabs carry none). */
  facetCounts?: Readonly<Record<string, number>>;
  /**
   * Each age option's open count (`ageCounts`, from the lane's `olderThan`); a count the server
   * stopped at its cap is a floor, drawn "200+".
   */
  ageCounts?: Readonly<Record<number, FacetMenuCount>>;
  filter: InboxFilter | null;
  onFilter: (filter: InboxFilter | null) => void;
  /** The applied body's or person's name, when the page knows it. */
  filterName?: string | null;
  /** Find a body by name (absent for a viewer who can't read bodies). */
  bodySearch?: FilterSearch;
  /** Find a person by name (absent for a viewer who can't read people). */
  personSearch?: FilterSearch;
  /** A body or a person was chosen in the menu: its name, for the chip. */
  onNamed?: (id: string, name: string) => void;
};

const ALL = 'all';

export function LaneFacets({
  facets,
  facet,
  onFacet,
  facetCounts,
  ageCounts,
  filter,
  onFilter,
  filterName = null,
  bodySearch,
  personSearch,
  onNamed,
}: LaneFacetsProps) {
  const [open, setOpen] = useState(false);
  // Closed, the menu's searches stop reading: what was typed goes with the menu.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    bodySearch?.onQuery('');
    personSearch?.onQuery('');
  };
  const kinds = facets.filter((f) => f !== ALL);
  const menuFacets = [
    ...(kinds.length === 0
      ? []
      : [
          {
            id: 'kind',
            label: 'Kind',
            options: kinds.map((k) => ({
              id: k,
              label: facetLabel(k),
              ...(facetCounts?.[k] !== undefined && { count: facetCounts[k] }),
            })),
          },
        ]),
    {
      id: 'age',
      label: FILTER_AGE,
      options: INBOX_AGE_FLOORS_DAYS.map((d) => ({
        id: String(d),
        label: ageFloorLabel(d),
        ...(ageCounts?.[d] !== undefined && { count: ageCounts[d] }),
      })),
    },
  ];
  const applied = (filter === null ? 0 : 1) + (facet === ALL ? 0 : 1);
  const chip = filterChip(filter, filterName);

  return (
    <>
      <div
        data-slot="inbox-facets"
        // The Inbox pass: a list's filter bar sits 10 px in.
        className="flex shrink-0 flex-wrap items-center gap-(--space-2_5) border-0 border-b border-solid border-line px-(--space-2_5) py-(--space-2_5)"
      >
        {facets.length > 0 && (
          <ToggleGroup
            aria-label="Kind"
            // A lane with more tabs than the column holds (Content flags' six) wraps them inside the
            // column, never past it into the inspector.
            className="max-w-full flex-wrap gap-y-px"
            value={facet}
            onValueChange={(value) => onFacet(value === '' ? ALL : value)}
          >
            {facets.map((f) => (
              <ToggleGroupItem key={f} value={f}>
                {FACET_LABELS[f] ?? facetLabel(f)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <span className="ms-auto flex items-center">
          <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger
              render={
                <Button size="sm" data-slot="inbox-filter" data-on={applied > 0 || undefined}>
                  {applied > 0 && <FilterCount count={applied} />}
                  {FILTER}
                  <DropdownMenuCaret />
                </Button>
              }
            />
            <PopoverContent align="end" className="w-[31.25rem]" aria-label={FILTER}>
              <FacetMenu
                facets={menuFacets}
                selected={{
                  kind: facet === ALL ? [] : [facet],
                  age: filter?.kind === 'age' ? [String(filter.days)] : [],
                }}
                onToggle={(f, o) => {
                  if (f === 'kind') onFacet(o === facet ? ALL : o);
                  else {
                    const days = Number(o);
                    onFilter(
                      filter?.kind === 'age' && filter.days === days ? null : { kind: 'age', days },
                    );
                  }
                }}
              />
              {(bodySearch !== undefined || personSearch !== undefined) && (
                <div
                  data-slot="inbox-filter-searches"
                  className="flex flex-col gap-(--space-3) border-0 border-t border-dotted border-line px-(--space-4) py-(--space-3_5)"
                >
                  {bodySearch !== undefined && (
                    <SearchFacet
                      label={FILTER_BODY}
                      placeholder={FIND_BODY}
                      search={bodySearch}
                      onPick={(o) => {
                        onNamed?.(o.id, o.label);
                        onFilter({ kind: 'body', id: o.id });
                        onOpenChange(false);
                      }}
                    />
                  )}
                  {personSearch !== undefined && (
                    <SearchFacet
                      label={FILTER_PERSON}
                      placeholder={FIND_PERSON}
                      search={personSearch}
                      onPick={(o) => {
                        onNamed?.(o.id, o.label);
                        onFilter({ kind: 'about', id: o.id });
                        onOpenChange(false);
                      }}
                    />
                  )}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </span>
      </div>
      {chip !== null && (
        <FilterChipRow data-slot="inbox-applied" className="shrink-0 px-gutter py-(--space-2_5)">
          <FilterChip facet={chip.facet} onRemove={() => onFilter(null)}>
            {chip.words}
          </FilterChip>
          <Button size="xs" onClick={() => onFilter(null)}>
            {FILTER_CLEAR}
          </Button>
        </FilterChipRow>
      )}
    </>
  );
}

/** The applied filter's chip: its facet and its words. */
export function filterChip(
  filter: InboxFilter | null,
  name: string | null,
): { facet: string; words: string } | null {
  if (filter === null) return null;
  switch (filter.kind) {
    case 'age':
      return { facet: FILTER_AGE, words: ageFloorLabel(filter.days) };
    case 'body':
      return { facet: FILTER_BODY, words: name ?? FILTER_BODY_UNNAMED };
    case 'about':
      return { facet: FILTER_PERSON, words: name ?? FILTER_PERSON_UNNAMED };
  }
}

/** A body or a person found by name: a field, then what it found, each a press away. */
function SearchFacet({
  label,
  placeholder,
  search,
  onPick,
}: {
  label: string;
  placeholder: string;
  search: FilterSearch;
  onPick: (option: FilterOption) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div data-slot="inbox-filter-search" className="flex flex-col gap-(--space-1_5)">
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        {label}
      </span>
      <InputGroup className="h-(--space-8) text-body">
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input
          type="search"
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            search.onQuery(event.currentTarget.value);
          }}
        />
      </InputGroup>
      {text.trim() !== '' && search.failure != null && (
        <RetryNote
          data-slot="inbox-filter-search-error"
          onRetry={search.failure.retry}
          pending={search.failure.pending}
        >
          {SEARCH_FAILED}
        </RetryNote>
      )}
      {text.trim() !== '' && search.failure == null && search.results.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0" aria-label={label}>
          {search.results.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                data-slot="inbox-filter-result"
                onClick={() => onPick(o)}
                className="flex w-full cursor-pointer items-baseline gap-(--space-2) border-0 bg-transparent px-(--space-1) py-(--space-1_5) text-left text-row text-fg1 outline-none hover:bg-lift-05 focus-visible:inset-ring-1 focus-visible:inset-ring-fg"
              >
                <span className="min-w-0 truncate">{o.label}</span>
                {o.sub !== undefined && (
                  <span className="shrink-0 text-assist text-fg3">{o.sub}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
