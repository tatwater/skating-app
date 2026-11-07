import { Autocomplete } from '@base-ui/react/autocomplete';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faMagnifyingGlass, faXmark } from '@fortawesome/sharp-light-svg-icons';
import { faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import { type ReactNode, useRef } from 'react';

import { cn } from '@/lib/utils';

import { Dialog, DialogContent, DialogTitle } from '../../kit/dialog';
import {
  EmptyNote,
  type GlobalSearchViewProps,
  ResultRow,
  SEARCH_LABEL,
} from '../GlobalSearchView';
import type { SearchGroup, SearchRow } from '../searchModel';

/**
 * Global search on a phone (board 9.6), props only — the same props, groups and rows as the desktop
 * plate, laid out for a thumb. Closed, it's the underline field that fills the phone's top bar.
 * Open, it takes the whole screen: Back, the query (16 px, so a phone doesn't zoom into it), and
 * Clear across the top over a full-width rule; the groups under it, rows 56 px tall.
 *
 * A modal kit Dialog holding Base UI Autocomplete inline (as the kit's command palette does): the
 * field keeps focus while ↑↓ walk the rows, ↵ opens one, Esc (or Back) closes and gives focus
 * back to the field in the bar.
 */
export function PhoneSearchView({
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
  const inputRef = useRef<HTMLInputElement>(null);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-slot="phone-search-trigger"
        data-attr="search"
        aria-label={SEARCH_LABEL}
        onClick={() => onOpenChange(true)}
        className={cn(
          // Tight enough that the board's whole wording fits at 390 px: a 6 px icon gap, no inset.
          'flex h-8.5 w-full min-w-0 cursor-pointer items-center gap-(--space-1_5) px-0',
          'rounded-control border-0 border-b border-solid border-line2 bg-transparent text-left',
          'text-assist leading-none whitespace-nowrap text-fg3 outline-none focus-visible:shadow-focus',
          className,
        )}
      >
        <FontAwesomeIcon
          icon={faMagnifyingGlass}
          aria-hidden="true"
          className="h-3.5 shrink-0 text-fg2"
        />
        <span className="min-w-0 truncate">{SEARCH_LABEL}</span>
      </button>
      <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
        <DialogContent
          container={container}
          size="viewer"
          initialFocus={inputRef}
          finalFocus={triggerRef}
          data-slot="phone-search"
          // Search text, lake and people's names: never autocaptured (D240).
          className="ph-no-capture inset-0 overflow-hidden border-0 bg-bg shadow-none"
        >
          <DialogTitle className="sr-only">{SEARCH_LABEL}</DialogTitle>
          <Autocomplete.Root
            inline
            open
            mode="none"
            items={groups as SearchGroup[]}
            value={query}
            onValueChange={(next, details) => {
              // Choosing a row would write its name into the field; the query stays what was typed.
              if (details.reason !== 'item-press') onQueryChange(next);
            }}
            itemToStringValue={(row: SearchRow) => row.name}
            autoHighlight="always"
            keepHighlight
          >
            <div
              data-slot="phone-search-top"
              className="flex h-14 shrink-0 items-center gap-(--space-2) border-0 border-b border-solid border-fg pr-(--space-3) pl-(--space-1_5)"
            >
              <IconButton label="Back" attr="phone-search-back" onClick={() => onOpenChange(false)}>
                <FontAwesomeIcon icon={faArrowLeft} />
              </IconButton>
              <Autocomplete.Input
                ref={inputRef}
                aria-label={SEARCH_LABEL}
                placeholder={SEARCH_LABEL}
                className="ph-no-capture h-full min-w-0 flex-1 bg-transparent p-0 text-[1rem] leading-none text-fg caret-fg outline-none placeholder:text-fg3"
              />
              <span
                aria-hidden="true"
                className={cn('shrink-0 text-fg3', !(loading && count > 0) && 'hidden')}
              >
                <FontAwesomeIcon
                  icon={faSpinnerThird}
                  className="h-[1em] motion-safe:animate-spin"
                />
              </span>
              {query !== '' && (
                <IconButton
                  label="Clear"
                  attr="phone-search-clear"
                  onClick={() => {
                    onQueryChange('');
                    inputRef.current?.focus();
                  }}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </IconButton>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <Autocomplete.List
                data-slot="phone-search-list"
                className="outline-none [&_[data-slot=global-search-row]]:h-14 [&_[data-slot=global-search-row]]:rounded-none"
              >
                {(group: SearchGroup) => (
                  <Autocomplete.Group key={group.id} items={group.items}>
                    <Autocomplete.GroupLabel className="flex items-center px-(--space-4) pt-(--space-4) pb-(--space-1_5) text-[0.625rem] leading-none font-medium tracking-kick text-fg3 uppercase">
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
            </div>
          </Autocomplete.Root>
        </DialogContent>
      </Dialog>
    </>
  );
}

function IconButton({
  label,
  attr,
  onClick,
  children,
}: {
  label: string;
  attr: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-attr={attr}
      onClick={onClick}
      className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-row text-fg1 outline-none hover:text-fg focus-visible:shadow-focus"
    >
      {children}
    </button>
  );
}
