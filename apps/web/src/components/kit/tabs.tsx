import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { createContext, type ReactNode, useContext } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Tabs: shadcn's Base UI tabs, re-skinned to the boards' mode rows.
 *
 * - **Joined boxes, the chosen one filled** — no pill, no shadow, no underlined link. The chosen
 *   tab is a plate in the second ink with the field's ink knocked out of it.
 * - **Two rows.** `joined` (the default): a row of boxes at their natural width sharing one edge
 *   (Overview's Home | Metrics, a filter row). `grid`: equal columns over a hairline lattice (the
 *   Body inspector's tab grid), wrapping to as many rows as it needs.
 * - **A gap flag**: a tab can carry the amber square that says its section is missing something.
 * - **No tooltips in a tab row**, and no counts on filter tabs: a tab is a word.
 * - The row is pressable, so its outer corners take the control radius (square on the console).
 */
const listVariants = cva('relative', {
  variants: {
    variant: {
      joined: 'inline-flex w-fit items-center',
      grid: 'grid grid-cols-[repeat(var(--tab-columns),minmax(0,1fr))] gap-px bg-line p-px',
    },
  },
  defaultVariants: { variant: 'joined' },
});

type ListVariant = NonNullable<VariantProps<typeof listVariants>['variant']>;
const ListVariantContext = createContext<ListVariant>('joined');

const tabVariants = cva(
  [
    'relative inline-flex h-btn-sm cursor-pointer items-center justify-center gap-[0.7em] whitespace-nowrap select-none outline-none',
    'text-kick leading-none font-semibold uppercase text-fg3',
    'transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard',
    'lit:not-data-active:bg-lift-05 lit:not-data-active:text-fg1',
    'pressed:not-data-active:bg-lift-08',
    'data-active:bg-fg1 data-active:text-bg',
    'focus-visible:z-1 focus-visible:shadow-focus',
    'data-disabled:cursor-default data-disabled:text-fg-disabled',
  ],
  {
    variants: {
      variant: {
        // Boxes share an edge: each but the first pulls left by its rim.
        joined: [
          'px-[1.1em] tracking-head border border-solid border-line -ml-px first:ml-0',
          'first:rounded-l-control last:rounded-r-control data-active:border-fg1',
        ],
        // Cells sit on the lattice; the hairline between them is the list's ground.
        grid: 'px-[0.6em] tracking-label bg-bg',
      },
    },
    defaultVariants: { variant: 'joined' },
  },
);

/** The tabs and their panels. `defaultValue` / `value` name the chosen tab. */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-heading', className)}
      {...props}
    />
  );
}

type TabsListProps = TabsPrimitive.List.Props & {
  variant?: ListVariant;
  /** `grid` only: how many columns the lattice has (3, as the Body inspector draws it). */
  columns?: number;
};

/** The row of tabs. Arrow keys move between them; Enter or Space chooses. */
function TabsList({ className, variant = 'joined', columns = 3, style, ...props }: TabsListProps) {
  return (
    <ListVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(listVariants({ variant }), className)}
        // Base UI's `style` may be a function of the list's state; keep it either way.
        style={(state) => ({
          ...(typeof style === 'function' ? style(state) : style),
          ['--tab-columns' as string]: columns,
        })}
        {...props}
      />
    </ListVariantContext.Provider>
  );
}

type TabsTabProps = TabsPrimitive.Tab.Props & {
  /** The section is missing something: the amber square, with this text for a screen reader. */
  flag?: string;
};

function TabsTab({ className, flag, children, ...props }: TabsTabProps) {
  const variant = useContext(ListVariantContext);
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(tabVariants({ variant }), className)}
      {...props}
    >
      {children}
      {flag !== undefined && <Flag label={flag} />}
    </TabsPrimitive.Tab>
  );
}

function Flag({ label }: { label: string }): ReactNode {
  return (
    <>
      <span aria-hidden="true" data-slot="tabs-flag" className="size-[0.5em] shrink-0 bg-warn" />
      <span className="sr-only">({label})</span>
    </>
  );
}

/** A tab's content. Takes focus as a whole, so a keyboard reader lands in it after the row. */
function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn('outline-none focus-visible:shadow-focus', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, type TabsListProps, TabsPanel, TabsTab, type TabsTabProps };
