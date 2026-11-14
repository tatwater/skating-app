import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * **The list tools** — what a list says about the filters on it (Bodies 5.2; Inbox, Reports and
 * People take the same row).
 *
 * - **`FilterChip`** — one applied option: the facet as a kicker, the option in the row's words,
 *   and a remove × that is its own button. Square, on the `raise` ground with a `line2` edge —
 *   a container that holds a control, not a control itself.
 * - **`FilterChipRow`** — the chips in a row, with the row's own action (*Clear*) at its end.
 * - **`FilterCount`** — the applied count on a Filter button: a solid white square in a key
 *   hint's shape, but with square corners (a count, not a key), mono.
 */

type FilterChipProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The facet ("Size"), written capitalized; set as a kicker. */
  facet: string;
  /** The option, in the row's words ("1,000 ac and up"). */
  children: ReactNode;
  /** Take the option off. */
  onRemove: () => void;
};

function FilterChip({ facet, children, onRemove, className, ...props }: FilterChipProps) {
  return (
    <span
      data-slot="filter-chip"
      className={cn(
        'inline-flex h-(--size-btn-sm) shrink-0 items-center gap-(--space-2) rounded-container ps-(--space-2_5) pe-(--space-1)',
        'bg-raise text-row leading-none whitespace-nowrap text-fg',
        'shadow-[inset_0_0_0_var(--stroke-hair)_var(--line2)]',
        className,
      )}
      {...props}
    >
      <span
        data-slot="filter-chip-facet"
        className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
      >
        {facet}
      </span>
      <span data-slot="filter-chip-value">{children}</span>
      <button
        type="button"
        data-slot="filter-chip-remove"
        aria-label={`Remove ${facet}: ${typeof children === 'string' ? children : 'filter'}`}
        onClick={onRemove}
        className={cn(
          'inline-flex size-(--space-4) cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-fg2 outline-none',
          'transition-[color,background-color] duration-(--duration-fast) ease-standard',
          'lit:bg-lift-08 lit:text-fg focus-visible:shadow-focus',
          '[&_svg]:h-(--space-2)',
        )}
      >
        <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
      </button>
    </span>
  );
}

function FilterChipRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="filter-chip-row"
      className={cn('flex min-w-0 flex-wrap items-center gap-(--space-2)', className)}
      {...props}
    />
  );
}

type FilterCountProps = Omit<ComponentProps<'span'>, 'children'> & { count: number };

function FilterCount({ count, className, ...props }: FilterCountProps) {
  return (
    <span
      data-slot="filter-count"
      className={cn(
        'inline-flex h-(--size-key) min-w-(--size-key) items-center justify-center rounded-container bg-fg px-(--space-0_5)',
        'font-(family-name:--family-mono) text-kick leading-none font-semibold text-bg tabular-nums',
        className,
      )}
      {...props}
    >
      {count}
    </span>
  );
}

export { FilterChip, type FilterChipProps, FilterChipRow, FilterCount, type FilterCountProps };
