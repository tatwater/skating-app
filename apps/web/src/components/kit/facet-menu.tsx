import { type ComponentProps, type KeyboardEvent, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { FootKey } from './search-parts';

/**
 * The facet menu: what sits behind a list's *Filter* button (Bodies 5.2; any
 * list with more facets than its tab row holds). Render it inside a kit `PopoverContent`; it draws
 * the head, the facets and the foot.
 *
 * - **A facet is a row**: its kicker over its options, each option a square box with its count in
 *   mono — a filter *menu* keeps its counts (a filter *tab* row doesn't). Rows are parted by dotted
 *   hairlines.
 * - **Applied** options are filled (the chosen-segment look). The **current facet** — where the
 *   keyboard is — wears the lit wash with the 2 px bar on its left edge, its kicker bright; the
 *   **focused option** carries the bright ring.
 * - **The two-way keyboard**: ↑↓ move between facets (keeping your place along the row as near as it
 *   goes), ←→ between a facet's options, Home/End to a row's ends, **Space** (or ⏎) applies or
 *   takes off the focused option; Esc closes (the popover's). One tab stop: focus roves.
 * - An option whose count is `0` stays pressable (the count says what it would leave); an option
 *   `disabled` (its fact isn't recorded) is inert and skipped.
 */

export interface FacetMenuOption {
  id: string;
  label: string;
  /** How many it would leave; absent when the read doesn't count. */
  count?: number;
  /** Inert, and skipped by the keys. */
  disabled?: boolean;
}

export interface FacetMenuFacet {
  id: string;
  /** The facet's kicker, written capitalized. */
  label: string;
  options: readonly FacetMenuOption[];
}

type FacetMenuProps = Omit<ComponentProps<'div'>, 'onToggle' | 'title'> & {
  /** The head's title. Default "Filter". */
  title?: string;
  facets: readonly FacetMenuFacet[];
  /** Applied option ids, per facet id. */
  selected: Readonly<Record<string, readonly string[] | undefined>>;
  /** An option was applied or taken off. */
  onToggle: (facet: string, option: string) => void;
};

type Spot = { row: number; col: number };

function FacetMenu({
  title = 'Filter',
  facets,
  selected,
  onToggle,
  className,
  ...props
}: FacetMenuProps) {
  const base = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const live = (row: number) =>
    (facets[row]?.options ?? []).flatMap((o, col) => (o.disabled ? [] : [col]));
  const firstSpot = (): Spot => {
    // Start on the first applied option, else the first live one.
    for (let row = 0; row < facets.length; row++) {
      const facet = facets[row] as FacetMenuFacet;
      const col = facet.options.findIndex(
        (o) => !o.disabled && selected[facet.id]?.includes(o.id) === true,
      );
      if (col !== -1) return { row, col };
    }
    const row = facets.findIndex((_, r) => live(r).length > 0);
    return { row: Math.max(0, row), col: live(Math.max(0, row))[0] ?? 0 };
  };
  const [spot, setSpot] = useState<Spot>(firstSpot);
  const key = (row: number, col: number) => `${row}:${col}`;

  const go = (next: Spot) => {
    setSpot(next);
    buttons.current.get(key(next.row, next.col))?.focus();
  };

  const nearest = (row: number, col: number): number | undefined => {
    const cols = live(row);
    if (cols.length === 0) return undefined;
    return cols.reduce((best, c) => (Math.abs(c - col) < Math.abs(best - col) ? c : best));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { row, col } = spot;
    const cols = live(row);
    const at = cols.indexOf(col);
    const vertical = (step: 1 | -1) => {
      for (let r = row + step; r >= 0 && r < facets.length; r += step) {
        const c = nearest(r, col);
        if (c !== undefined) return go({ row: r, col: c });
      }
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        return vertical(1);
      case 'ArrowUp':
        event.preventDefault();
        return vertical(-1);
      case 'ArrowRight':
        event.preventDefault();
        if (at < cols.length - 1) go({ row, col: cols[at + 1] as number });
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (at > 0) go({ row, col: cols[at - 1] as number });
        return;
      case 'Home':
        event.preventDefault();
        if (cols.length > 0) go({ row, col: cols[0] as number });
        return;
      case 'End':
        event.preventDefault();
        if (cols.length > 0) go({ row, col: cols.at(-1) as number });
        return;
      case ' ':
      case 'Enter': {
        event.preventDefault();
        const facet = facets[row];
        const option = facet?.options[col];
        if (facet && option && !option.disabled) onToggle(facet.id, option.id);
        return;
      }
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: its keys move focus between its own buttons
    <div
      data-slot="facet-menu"
      className={cn('flex min-w-0 flex-col', className)}
      onKeyDown={onKeyDown}
      {...props}
    >
      <div
        data-slot="facet-menu-head"
        className="flex h-(--size-btn) shrink-0 items-center border-0 border-b border-solid border-line px-(--space-3_5)"
      >
        <span className="text-kick leading-none font-semibold tracking-kick text-fg uppercase">
          {title}
        </span>
      </div>
      {facets.map((facet, row) => {
        const current = row === spot.row;
        const labelId = `${base}-${facet.id}`;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form fields; these apply at once
          <div
            key={facet.id}
            role="group"
            aria-labelledby={labelId}
            data-slot="facet-menu-facet"
            data-current={current ? '' : undefined}
            className={cn(
              'flex flex-col gap-(--space-2) px-(--space-3_5) pt-(--space-2_5) pb-(--space-3)',
              'border-0 border-b border-dotted border-line last-of-type:border-b-0',
              'data-current:bg-lift-05 data-current:shadow-select-rule',
            )}
          >
            <span
              id={labelId}
              data-slot="facet-menu-label"
              className={cn(
                'text-kick leading-none font-medium tracking-kick text-fg3 uppercase',
                current && 'text-fg',
              )}
            >
              {facet.label}
            </span>
            <span className="flex flex-wrap gap-(--space-1)">
              {facet.options.map((option, col) => {
                const on = selected[facet.id]?.includes(option.id) === true;
                const isSpot = current && col === spot.col;
                return (
                  <button
                    key={option.id}
                    ref={(el) => {
                      if (el === null) buttons.current.delete(key(row, col));
                      else buttons.current.set(key(row, col), el);
                    }}
                    type="button"
                    data-slot="facet-menu-option"
                    aria-pressed={on}
                    disabled={option.disabled}
                    tabIndex={isSpot ? 0 : -1}
                    onFocus={() => setSpot({ row, col })}
                    onClick={() => onToggle(facet.id, option.id)}
                    className={cn(
                      'group/option inline-flex h-btn-sm cursor-pointer items-center gap-(--space-1_5) rounded-control px-(--space-2) outline-none',
                      'border border-solid border-line2 bg-transparent text-assist leading-none whitespace-nowrap text-fg1',
                      'transition-[background-color,color,border-color,box-shadow] duration-(--duration-fast) ease-standard',
                      'lit:border-fg2 focus-visible:border-fg focus-visible:text-fg focus-visible:shadow-[0_0_0_var(--stroke-hair)_var(--fg)]',
                      'aria-pressed:border-fg1 aria-pressed:bg-fg1 aria-pressed:text-bg',
                      'disabled:cursor-default disabled:opacity-(--opacity-disabled)',
                    )}
                  >
                    {option.label}
                    {option.count !== undefined && (
                      <b
                        data-slot="facet-menu-count"
                        className="font-(family-name:--family-mono) text-kick leading-none font-medium text-fg3 tabular-nums group-aria-pressed/option:text-bg"
                      >
                        {option.count.toLocaleString('en-US')}
                      </b>
                    )}
                  </button>
                );
              })}
            </span>
          </div>
        );
      })}
      <div
        data-slot="facet-menu-foot"
        className="flex shrink-0 items-center gap-(--space-5) border-0 border-t border-solid border-line px-(--space-3_5) py-(--space-2) text-assist leading-none text-fg3"
      >
        <FootKey keys={['↑↓']}>Facet</FootKey>
        <FootKey keys={['←→']}>Option</FootKey>
        <FootKey keys={['Space']}>Apply</FootKey>
        <span className="ms-auto">
          <FootKey keys={['Esc']}>Close</FootKey>
        </span>
      </div>
    </div>
  );
}

export { FacetMenu, type FacetMenuProps };
