import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import { type Ref, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { DropdownMenuCaret } from '@/components/kit/dropdown-menu';
import { FacetMenu } from '@/components/kit/facet-menu';
import { FilterChip, FilterChipRow, FilterCount } from '@/components/kit/filter-chip';
import { Input, InputGroup, InputGroupIcon, InputGroupKbd } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/kit/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import type { BodiesListData } from './bodiesData';
import { isSearch } from './bodiesSearch';
import {
  type AppliedOption,
  appliedOptions,
  chipWords,
  FACETS,
  type FacetId,
  type FacetSelection,
} from './bodyFacets';
import type { BodyLane } from './bodyLanes';

/**
 * The tools over the list (boards 5.1–5.3): the search, then the facet row — the commonest facet
 * (the state) as tabs, the rest behind *Filter* — and the applied filters as chips.
 *
 * - **The search** waits a beat before it asks (`SEARCH_DEBOUNCE_MS`), so the URL and the read
 *   follow the words, not each key. Its `/` cap shows at rest (it's the key that puts focus here);
 *   while it holds words it says how many matched where ("2 active · 4 dormant").
 * - **Filter tabs carry no counts**; the menu's options keep theirs.
 * - A control the lane's read can't honor is drawn off, never left to lie.
 */

export const SEARCH_DEBOUNCE_MS = 250;
const ALL = '__all';

type ListToolsProps = {
  lane: BodyLane;
  list: BodiesListData;
  q: string;
  onSearch: (q: string) => void;
  state: string | null;
  onStateChange: (state: string | null) => void;
  facets: FacetSelection;
  onToggleFacet: (facet: FacetId, option: string) => void;
  onClearFacets: () => void;
  filterOpen: boolean;
  onFilterOpenChange: (open: boolean) => void;
  searchRef?: Ref<HTMLInputElement>;
};

export function ListTools({
  lane,
  list,
  q,
  onSearch,
  state,
  onStateChange,
  facets,
  onToggleFacet,
  onClearFacets,
  filterOpen,
  onFilterOpenChange,
  searchRef,
}: ListToolsProps) {
  const applied = appliedOptions(facets);
  const states =
    state !== null && !list.states.includes(state) ? [state, ...list.states] : list.states;
  const menuFacets = FACETS.filter((f) => lane.facets.includes(f.id)).map((facet) => ({
    id: facet.id,
    label: facet.label,
    options: facet.options.map((o) => {
      const count = list.facetCounts?.[facet.id]?.[o.id];
      return {
        id: o.id,
        label: o.label,
        ...(count !== undefined && { count }),
        ...(!list.serves.facets.includes(facet.id) && { disabled: true }),
      };
    }),
  }));
  const canFilter = list.serves.facets.length > 0;

  return (
    <>
      <div data-slot="bodies-search" className="flex shrink-0 flex-col px-gutter pt-(--space-2)">
        <SearchField
          q={q}
          onSearch={onSearch}
          disabled={!list.serves.search}
          tally={isSearch(q) ? searchTally(list, lane.word) : null}
          inputRef={searchRef}
        />
      </div>
      <div
        data-slot="bodies-facets"
        className="flex shrink-0 items-center gap-(--space-2_5) px-gutter py-(--space-3)"
      >
        {lane.stateTabs && (
          <ToggleGroup
            aria-label="State"
            value={state ?? ALL}
            disabled={!list.serves.states}
            onValueChange={(value) => onStateChange(value === ALL ? null : value)}
          >
            <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
            {states.map((s) => (
              <ToggleGroupItem key={s} value={s}>
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <span className="ms-auto flex items-center gap-(--space-2)">
          <Popover open={filterOpen} onOpenChange={onFilterOpenChange}>
            <PopoverTrigger
              disabled={!canFilter}
              render={
                <Button
                  size="sm"
                  data-slot="filter-button"
                  data-on={applied.length > 0 || undefined}
                >
                  {applied.length > 0 && <FilterCount count={applied.length} />}
                  Filter
                  <Kbd variant="dim" aria-hidden="true">
                    F
                  </Kbd>
                  <DropdownMenuCaret />
                </Button>
              }
            />
            <PopoverContent align="end" className="w-[31.25rem]" aria-label="Filter">
              <FacetMenu
                facets={menuFacets}
                selected={facets}
                onToggle={(f, o) => onToggleFacet(f as FacetId, o)}
              />
            </PopoverContent>
          </Popover>
        </span>
      </div>
      {applied.length > 0 && (
        <FilterChipRow data-slot="bodies-applied" className="shrink-0 px-gutter pb-(--space-3)">
          {applied.map(({ facet, option }: AppliedOption) => (
            <FilterChip
              key={`${facet.id}:${option.id}`}
              facet={facet.label}
              onRemove={() => onToggleFacet(facet.id, option.id)}
            >
              {chipWords(option)}
            </FilterChip>
          ))}
          <Button size="xs" onClick={onClearFacets}>
            Clear
          </Button>
        </FilterChipRow>
      )}
    </>
  );
}

/**
 * "2 active · 4 dormant": the matches in this lane, then each other standing's. While more pages
 * wait, the lane's figure is what has arrived so far — a floor, written "50+". Drawn only when a
 * read gives the other standings (`others`): a tally of one lane alone would read as the whole.
 */
export function searchTally(list: BodiesListData, laneWord: string): string | null {
  if (list.others === null) return null;
  if (list.status === 'loading' || list.status === 'unread' || list.status === 'error') {
    return null;
  }
  const more = list.status !== 'done';
  const parts = [
    `${list.rows.length.toLocaleString('en-US')}${more ? '+' : ''} ${laneWord}`,
    ...list.others.map((g) => `${g.rows.length} ${g.label.toLowerCase()}`),
  ];
  return parts.join(' · ');
}

function SearchField({
  q,
  onSearch,
  disabled,
  tally,
  inputRef,
}: {
  q: string;
  onSearch: (q: string) => void;
  disabled: boolean;
  tally: string | null;
  inputRef?: Ref<HTMLInputElement> | undefined;
}) {
  const [text, setText] = useState(q);
  const sent = useRef(q);
  const timer = useRef<number | undefined>(undefined);
  // The URL moved on its own (a lane change, the back button): the field follows it.
  useEffect(() => {
    if (q !== sent.current) {
      sent.current = q;
      setText(q);
    }
  }, [q]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <InputGroup className="h-(--space-8) text-body">
      <InputGroupIcon>
        <FontAwesomeIcon icon={faMagnifyingGlass} />
      </InputGroupIcon>
      <Input
        ref={inputRef}
        type="search"
        aria-label="Find a body"
        placeholder="Find a body by name or alias"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            sent.current = next.trim();
            onSearch(next.trim());
          }, SEARCH_DEBOUNCE_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && text !== '') {
            event.preventDefault();
            setText('');
            window.clearTimeout(timer.current);
            sent.current = '';
            onSearch('');
          }
        }}
      />
      {tally !== null && (
        <span
          data-slot="search-tally"
          className="shrink-0 text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase"
        >
          {tally}
        </span>
      )}
      <InputGroupKbd always>/</InputGroupKbd>
    </InputGroup>
  );
}
