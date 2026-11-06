import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's radios: shadcn's Base UI radio group, re-skinned to the boards' choice rows (Body ›
 * Standing, the Corpus choices).
 *
 * - **A circle** one kicker across (10 px on the console), drawn from the root's state; the pick is
 *   a bright rim with a dot inset by two hairlines.
 * - **A list of states you can set is radios**, never a ladder that reads as a timeline.
 * - **Whole-row items.** `RadioRow` makes the row the radio, so the label and anything beside it
 *   (a Now or Suggested badge) are one press target. As a `list` row it sits on a dotted rule; as a
 *   `cell` (a tile) the chosen one lights the whole cell — a bright edge over a lifted ground.
 * - **Picking moves the pick**; applying it is the bar's button's job, so a group carries no submit.
 */

/** A group of radios. Arrow keys move the pick; Tab leaves the group. */
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

/**
 * The circle — drawn from the root's state (`group/radio`), so it serves both the bare radio and
 * a row. The rim reads `--rim`, which the root sets.
 */
function Dot() {
  return (
    <span
      data-slot="radio-dot"
      className={cn(
        'relative inline-flex size-(--type-kick) shrink-0 rounded-full border border-solid border-(--rim)',
        'transition-[border-color] duration-(--duration-instant) ease-standard',
      )}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-indicator"
        className="absolute inset-[2px] rounded-full bg-(--rim)"
      />
    </span>
  );
}

/** Rest, lit (hover or focus, while unpicked), picked, invalid and disabled rims. */
const ROOT = [
  'group/radio cursor-pointer outline-none data-disabled:cursor-default',
  '[--rim:var(--fg3)] lit:not-data-checked:[--rim:var(--fg2)] data-checked:[--rim:var(--fg)]',
  'aria-invalid:[--rim:var(--bad)] data-disabled:[--rim:var(--line2)]',
];

/** A bare radio: the box is the circle; the pointer area grows by the hit pad. Needs a name. */
function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn(ROOT, 'hit inline-flex rounded-full focus-visible:shadow-focus', className)}
      {...props}
    >
      <Dot />
    </RadioPrimitive.Root>
  );
}

const rowVariants = cva(
  [
    ROOT,
    'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-(--space-2_5)',
    'text-body leading-[1.25] text-fg1 data-checked:text-fg data-disabled:text-fg-disabled',
    'transition-[background-color,box-shadow,color] duration-(--duration-fast) ease-standard',
    'focus-visible:shadow-focus',
  ],
  {
    variants: {
      variant: {
        /** A choice row on a dotted rule (the last row has none). */
        // "Last" means no row after it: Base UI renders each radio's form input as a sibling.
        list: [
          'min-h-td py-(--space-1_5) border-b border-dotted border-line',
          '[&:not(:has(~[data-slot=radio-row]))]:border-b-0',
          'lit:bg-lift-05',
        ],
        /** A tile: the chosen one lights the whole cell. */
        cell: [
          'rounded-control p-(--space-2_5) inset-ring inset-ring-line2',
          'lit:not-data-checked:bg-lift-05 data-checked:bg-lift-08 data-checked:inset-ring-fg',
        ],
      },
    },
    defaultVariants: { variant: 'list' },
  },
);

type RadioRowProps = Omit<RadioPrimitive.Root.Props, 'children'> & {
  /** The choice ("Reservoir", "Lake Auburn"). */
  label: ReactNode;
  /** A sub-line under the label, written capitalized. */
  description?: ReactNode;
  /** What sits at the row's end — a Now or Suggested badge, a source tag. */
  aside?: ReactNode;
  variant?: 'list' | 'cell';
};

/** A whole-row radio: the circle on the label's first line, a sub-line, an aside at the end. */
function RadioRow({
  label,
  description,
  aside,
  variant = 'list',
  className,
  ...props
}: RadioRowProps) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-row"
      data-variant={variant}
      className={cn(rowVariants({ variant }), className)}
      {...props}
    >
      {/* One line of the label tall, so the circle centers on the first line. */}
      <span data-slot="radio-line" className="flex h-[1.25em] items-center">
        <Dot />
      </span>
      <span data-slot="radio-label" className="flex min-w-0 flex-col gap-(--space-1)">
        {label}
        {description != null && (
          <span
            data-slot="radio-description"
            className="text-assist leading-(--lead-list) text-fg3 group-data-checked/radio:text-fg2 group-data-disabled/radio:text-fg-disabled"
          >
            {description}
          </span>
        )}
      </span>
      {aside != null && (
        <span data-slot="radio-aside" className="flex h-[1.25em] items-center">
          {aside}
        </span>
      )}
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup, RadioRow, type RadioRowProps };
