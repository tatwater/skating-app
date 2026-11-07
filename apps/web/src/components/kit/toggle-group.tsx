import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cva } from 'class-variance-authority';
import { createContext, type ReactNode, useContext, useState } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * The kit's ToggleGroup: shadcn's Base UI toggle group, re-skinned to the boards' segmented mode
 * pickers — **one choice at a time, always one chosen**.
 *
 * - **The chosen option is filled**: a plate in the second ink with the field's ink knocked out of
 *   it, as every board draws `.seg … .on`, `.tabs2 … .on` and the skater app's `.seg … .on` — no
 *   pill, no shadow. The rest are caps words in the faint ink that light on hover or focus.
 * - **Two rows.** `joined` (the default): boxes at their natural width sharing one edge — a filter
 *   row over a list, the skater app's segments. `well`: the options sit in a sunken panel-ground
 *   well, a hairline apart (the console's in-form segments, the map's A / B switch).
 * - **The surface's small button height**, so a segment, a tab row and a small button line up.
 * - **A key hint sits on the option that isn't chosen** (the key switches to it): pass `hint`, and
 *   the cap shows only while its option is unchosen — keeping its room, so nothing shifts.
 * - **No counts in a filter row**, and choices are never written "A · B · C": each is a segment.
 * - Pressing the chosen option again keeps it (Base UI would empty a single group); this is a mode,
 *   and a mode always has a value.
 *
 * Arrow keys move along the row; Enter or Space chooses. Use a radio group instead when the value
 * belongs to a form that is submitted.
 */
const groupVariants = cva('relative inline-flex w-fit items-center', {
  variants: {
    variant: {
      joined: '',
      well: 'h-btn-sm gap-px bg-panel p-px inset-ring inset-ring-line',
    },
  },
  defaultVariants: { variant: 'joined' },
});

type Variant = 'joined' | 'well';
const VariantContext = createContext<Variant>('joined');

type ToggleGroupProps = Omit<
  ToggleGroupPrimitive.Props,
  'value' | 'defaultValue' | 'onValueChange' | 'multiple'
> & {
  variant?: Variant;
  /** The chosen option (controlled). */
  value?: string;
  /** The option chosen at first (uncontrolled). */
  defaultValue?: string;
  /** A different option was chosen. Never called with nothing chosen. */
  onValueChange?: (value: string) => void;
};

function ToggleGroup({
  className,
  variant = 'joined',
  value,
  defaultValue,
  onValueChange,
  ...props
}: ToggleGroupProps) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  return (
    <VariantContext.Provider value={variant}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-variant={variant}
        className={cn(groupVariants({ variant }), className)}
        value={current === undefined ? [] : [current]}
        onValueChange={(next) => {
          const [chosen] = next;
          // Pressing the chosen option would leave nothing chosen: keep it.
          if (chosen === undefined) return;
          setOwn(chosen);
          onValueChange?.(chosen);
        }}
        {...props}
      />
    </VariantContext.Provider>
  );
}

const itemVariants = cva(
  [
    'group/toggle relative inline-flex cursor-pointer items-center justify-center gap-[0.7em] whitespace-nowrap select-none outline-none',
    'text-kick leading-none font-semibold tracking-head uppercase text-fg3',
    'transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard',
    'lit:not-data-pressed:bg-lift-05 lit:not-data-pressed:text-fg1',
    'pressed:not-data-pressed:bg-lift-08',
    'data-pressed:bg-fg1 data-pressed:text-bg data-pressed:cursor-default',
    'focus-visible:z-1 focus-visible:shadow-focus',
    'data-disabled:cursor-default data-disabled:text-fg-disabled',
  ],
  {
    variants: {
      variant: {
        // Boxes share an edge: each but the first pulls left by its rim.
        joined: [
          'h-btn-sm px-[1.1em] border border-solid border-line -ml-px first:ml-0',
          'first:rounded-l-control last:rounded-r-control data-pressed:border-fg1',
        ],
        // Inside the well: the well's height less its two hairlines.
        well: 'h-full px-[1em] rounded-control',
      },
    },
    defaultVariants: { variant: 'joined' },
  },
);

type ToggleGroupItemProps = Omit<TogglePrimitive.Props, 'value'> & {
  value: string;
  /** The key that switches to this option, shown while it isn't chosen ("B"). */
  hint?: string;
};

function ToggleGroupItem({ className, hint, children, ...props }: ToggleGroupItemProps) {
  const variant = useContext(VariantContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      aria-keyshortcuts={hint}
      className={cn(itemVariants({ variant }), className)}
      {...props}
    >
      {children}
      {hint !== undefined && <Hint>{hint}</Hint>}
    </TogglePrimitive>
  );
}

/** The cap keeps its room when its option is chosen, so the row never changes width. */
function Hint({ children }: { children: ReactNode }) {
  return (
    <Kbd
      aria-hidden="true"
      variant="dim"
      data-slot="toggle-group-hint"
      // A disabled option keeps its key, faded (the page isn't listening for it).
      className="group-data-pressed/toggle:invisible group-data-disabled/toggle:opacity-(--opacity-disabled)"
    >
      {children}
    </Kbd>
  );
}

export { ToggleGroup, ToggleGroupItem, type ToggleGroupItemProps, type ToggleGroupProps };
