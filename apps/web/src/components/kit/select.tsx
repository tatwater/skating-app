import { Select as SelectPrimitive } from '@base-ui/react/select';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faAngleDown } from '@fortawesome/sharp-regular-svg-icons';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Select: shadcn's Base UI select, re-skinned to the boards' two selects.
 *
 * - **Two triggers.** `underline` (the default) is the form field — the boards' `.sel3`: the value
 *   in body type over one rule, as the standard input is drawn (so a select and an input in one
 *   form read as one family, and share the surface's button height). `boxed` is the toolbar
 *   select — `.sel2`: the value in caps on a hairline box with the control corner (square on the
 *   console, 2 px on skater).
 * - **The caret is FontAwesome Sharp Regular's angle-down**, never a chevron or a "▾" glyph.
 * - **The list is a square plate** — the panel ground, a `line2` edge, the plate shadow — that
 *   drops below the trigger (never laid over it), at least as wide as the trigger.
 * - **The chosen option carries the inset bar** — the selection rule the console's lists wear —
 *   and the bright ink, with no check column. The highlight under the pointer or the arrow keys is
 *   a lift plate; the two compose, so the chosen option stays marked while it's highlighted.
 * - **Groups take a kicker** (`SelectGroupLabel`); a disabled option keeps its place, dimmed.
 * - **An empty or loading list** shows one `SelectNote` row the height of an option, so the plate
 *   never collapses to a sliver.
 * - Density is the surface's: option rows are a table row tall (`h-td`), in the assist step.
 */

/** The select's state: `value` / `defaultValue`, `items` (for the trigger's label), `disabled`. */
const Select = SelectPrimitive.Root;

const triggerVariants = cva(
  [
    'group/select relative inline-flex h-btn w-full min-w-0 cursor-pointer items-center justify-between gap-(--space-2) whitespace-nowrap select-none outline-none',
    'transition-[background-color,border-color,box-shadow,color] duration-(--duration-fast) ease-standard',
    'data-disabled:cursor-default data-disabled:text-fg-disabled',
  ],
  {
    variants: {
      variant: {
        /** The form field: the value over one rule (`.sel3`). */
        underline: [
          'border-0 border-b border-solid border-line2 rounded-none px-0',
          'text-body leading-none font-regular text-fg',
          // Hover only (as the input's rule): focus has its own, stronger look below.
          '[@media(hover:hover)]:hover:not-data-disabled:border-fg3 data-popup-open:border-fg',
          'focus-visible:border-fg focus-visible:shadow-[0_1px_0_0_var(--fg)]',
          'aria-invalid:border-bad data-invalid:border-bad',
          'data-disabled:border-line',
        ],
        /** The toolbar select: caps on a hairline box (`.sel2`). */
        boxed: [
          'rounded-control inset-ring inset-ring-line2 px-[1.2em]',
          'text-kick leading-none font-medium tracking-head uppercase text-fg1',
          'lit:bg-lift-05 lit:text-fg pressed:bg-lift-08',
          'data-popup-open:bg-lift-05 data-popup-open:text-fg data-popup-open:inset-ring-fg3',
          'focus-visible:shadow-focus',
          'aria-invalid:inset-ring-bad data-invalid:inset-ring-bad',
          'data-disabled:inset-ring-line',
        ],
      },
    },
    defaultVariants: { variant: 'underline' },
  },
);

type SelectTriggerProps = SelectPrimitive.Trigger.Props & VariantProps<typeof triggerVariants>;

/** The control. Holds a `SelectValue`; ends in the caret. */
function SelectTrigger({
  className,
  variant = 'underline',
  children,
  ...props
}: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      className={cn(triggerVariants({ variant }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        data-slot="select-caret"
        className="flex shrink-0 items-center text-fg2 group-data-disabled/select:text-fg-disabled"
      >
        <FontAwesomeIcon icon={faAngleDown} className="h-(--type-kick)" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The chosen option's label, or the `placeholder` in the faint ink until one is chosen. */
function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('min-w-0 truncate text-left data-placeholder:text-fg3', className)}
      {...props}
    />
  );
}

type SelectContentProps = SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> &
  Pick<SelectPrimitive.Portal.Props, 'container'>;

/** The plate of options, dropped below the trigger. */
function SelectContent({
  className,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  alignOffset = 0,
  container,
  children,
  ...props
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={false}
        // Over sheets and viewers too: the list belongs to the field that opened it.
        className="isolate z-[calc(var(--z-viewer)+1)] outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(PLATE, className)}
          {...props}
        >
          <SelectPrimitive.List data-slot="select-list" className="outline-none">
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/** The plate a list of options sits on. Shared look with the kit's DropdownMenu. */
const PLATE = [
  'max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto py-(--space-1) outline-none',
  'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
  'font-(family-name:--family-sans) text-assist leading-none font-medium tracking-normal normal-case',
  'transition-opacity duration-(--duration-fast) ease-standard',
  'data-starting-style:opacity-0 data-ending-style:opacity-0',
];

/** A row's box: a table row tall, inset like the boards' menu rows. */
const ROW = 'flex h-td items-center px-[1.15em]';

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        ROW,
        'relative cursor-pointer gap-(--space-2) text-fg1 outline-none select-none',
        'transition-[background-color,color] duration-(--duration-instant) ease-standard',
        'data-highlighted:bg-lift-08 data-highlighted:text-fg',
        'data-selected:text-fg data-selected:shadow-select-rule',
        'data-disabled:cursor-default data-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 truncate">{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

/** A group's kicker. */
function SelectGroupLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn(KICKER_ROW, className)}
      {...props}
    />
  );
}

/** The kicker row a group opens with, aligned to the options' text. */
const KICKER_ROW =
  'px-[calc(var(--type-assist)*1.15)] pt-(--space-2_5) pb-(--space-1_5) text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('my-(--space-1) h-px bg-line', className)}
      {...props}
    />
  );
}

/** A row that isn't an option — "Loading…", "No providers yet" — an option's height. */
function SelectNote({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="select-note"
      role="presentation"
      className={cn(ROW, 'font-regular text-fg3', className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  type SelectContentProps,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectNote,
  SelectSeparator,
  SelectTrigger,
  type SelectTriggerProps,
  SelectValue,
};
