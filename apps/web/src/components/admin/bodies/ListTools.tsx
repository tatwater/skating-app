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
 *   while it runs it says how many matched where ("2 active · 4 dormant") — once a read gives the
 *   other standings' matches; until then it says nothing.
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
  /**
   * The place the search is typed in — everything about the list but the search and its order.
   * Typing pending when it changes is dropped. Default: one place.
   */
  place?: string;
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
  place = '',
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
          place={place}
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
    ...list.others.map(
      (g) =>
        `${(g.count ?? g.rows.length).toLocaleString('en-US')}${g.capped ? '+' : ''} ${g.label.toLowerCase()}`,
    ),
  ];
  // The other standings are counted across the lane's facets: said, never read as filtered.
  return `${parts.join(' · ')}${list.othersFacetsIgnored ? ' (other standings unfiltered)' : ''}`;
}

function SearchField({
  q,
  place,
  onSearch,
  disabled,
  tally,
  inputRef,
}: {
  q: string;
  /** Where the search is typed: typing belongs to it, and is dropped when it moves. */
  place: string;
  onSearch: (q: string) => void;
  disabled: boolean;
  tally: string | null;
  inputRef?: Ref<HTMLInputElement> | undefined;
}) {
  const [text, setText] = useState(q);
  const sent = useRef(q);
  const timer = useRef<number | undefined>(undefined);
  /*
   * **Typing belongs to the place it was typed in.** Pending typing is dropped whenever the place
   * moves — another lane, a state tab, a facet, a body opened, the back button — whether or not the
   * search itself changed (two lanes can both have an empty one), and the field shows what the URL
   * says. One rule, checked twice: the place moving resets the field, and a wait that ends after
   * the place moved sends nothing.
   */
  const latest = useRef({ onSearch, place });
  latest.current = { onSearch, place };
  const typedIn = useRef(place);
  useEffect(() => {
    if (q !== sent.current || place !== typedIn.current) {
      window.clearTimeout(timer.current);
      sent.current = q;
      typedIn.current = place;
      setText(q);
    }
  }, [q, place]);
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
          const at = latest.current.place;
          timer.current = window.setTimeout(() => {
            if (latest.current.place !== at) return;
            sent.current = next.trim();
            latest.current.onSearch(next.trim());
          }, SEARCH_DEBOUNCE_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && text !== '') {
            event.preventDefault();
            setText('');
            window.clearTimeout(timer.current);
            // Typing that never landed leaves nothing to clear: asking for an empty search would
            // put the lane's order back over a heading pressed meanwhile.
            if (sent.current === '') return;
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
