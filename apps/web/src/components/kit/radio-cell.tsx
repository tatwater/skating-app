import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from './badge';

/**
 * Beside `radio`'s `RadioRow`: a value you can pick, as a boxed table cell —
 * Body › Water's depth ladder, where each source offers a mean and a max and each column is one
 * radio group (`RadioGroup` from the kit holds them; arrow keys move the pick down a column).
 *
 * - **The cell is the radio.** A hairline box, the value in mono at the right with its unit in the
 *   gray slot (a unit sits 7 px from its value, no space character), a table row tall.
 * - **The chosen cell lights the whole cell** (Review 8): the box and the value turn the bright
 *   ink, and the one in use wears **Now** at its left — the outlined lit badge, as on every choice.
 * - **An estimate reads as one**: `estimate` prefixes the value with `~`.
 * - **Read-only** when its group is (nothing to apply the pick with): it still shows which is in
 *   use, but no pointer and no hover.
 * - **Picking moves the pick**; applying it is a button's job, never the cell's.
 */

type RadioCellProps = Omit<RadioPrimitive.Root.Props, 'children'> & {
  /** The radio's identity in its group (a source id). */
  value: string;
  /** The number as it should read ("9.4"). */
  figure: string;
  /** Its unit ("m"), in the gray slot. */
  unit?: string;
  /** The value is modeled, not measured: reads "~9.4". */
  estimate?: boolean;
  /** This is the value in use: wears Now. */
  now?: boolean;
  /** The words a reader hears for it, when the column's head isn't enough. */
  'aria-label'?: string;
  /** Extra content at the left (rarely: Now is drawn by `now`). */
  lead?: ReactNode;
};

/** The unit's gap: the boards' value-to-unit spacing (Review 8), the `gap.unit` token. */
const UNIT_GAP = 'ms-unit';

function RadioCell({
  figure,
  unit,
  estimate = false,
  now = false,
  lead,
  className,
  ...props
}: RadioCellProps) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-cell"
      data-now={now ? '' : undefined}
      className={cn(
        'group/cell flex h-btn-xs w-full min-w-0 items-center justify-end gap-(--space-1) px-(--space-2)',
        'cursor-pointer rounded-control inset-ring inset-ring-line outline-none',
        'font-(family-name:--family-mono) text-mono-sm leading-none font-medium text-fg2 tabular-nums',
        'transition-[background-color,box-shadow,color] duration-(--duration-fast) ease-standard',
        'lit:not-data-checked:bg-lift-05 focus-visible:shadow-focus',
        'data-checked:text-fg data-checked:inset-ring-fg',
        'data-readonly:cursor-default data-readonly:lit:bg-transparent',
        className,
      )}
      {...props}
    >
      {now && (
        <Badge variant="outline" tone="lit" className="me-auto">
          Now
        </Badge>
      )}
      {lead}
      <span data-slot="radio-cell-value">
        {estimate ? '~' : ''}
        {figure}
      </span>
      {unit !== undefined && (
        <span
          data-slot="radio-cell-unit"
          className={cn(UNIT_GAP, 'font-regular text-fg3 group-data-checked/cell:text-fg3')}
        >
          {unit}
        </span>
      )}
    </RadioPrimitive.Root>
  );
}

export { RadioCell, type RadioCellProps };
