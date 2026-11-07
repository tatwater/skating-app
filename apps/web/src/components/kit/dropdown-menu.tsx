import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faAngleDown } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * The kit's DropdownMenu: shadcn's Dropdown Menu on Base UI's Menu, re-skinned to the boards'
 * action menus (the log's copy menu, the ⋯ menu that holds a rare destructive page action).
 *
 * - **A square plate**: the panel ground, a `line2` edge, the plate shadow, no arrow. Rows are a
 *   table row tall in the assist step; the highlighted row is a lift plate in the bright ink.
 * - **Three fixed columns** shared by every row (a CSS subgrid): an icon slot, the label, and a
 *   key slot as wide as the widest key, right-aligned. A column nobody uses takes no room, and
 *   keys line up down the menu however long the labels are — slots, never a gap.
 * - **Kicker group heads** (`DropdownMenuLabel`) and hairline separators.
 * - **No red at rest.** A `danger` item reads like any other until it is highlighted, then its
 *   label turns red. It never deletes on its own: its handler opens the confirm (an alert dialog),
 *   which is where the armed step lives.
 * - **The keyboard** is Base UI's: ↑↓ move, typing jumps to a label (keys in the row are left out
 *   of the match), ⏎ or Space chooses, Esc closes and gives focus back to the trigger.
 * - **An empty or loading menu** shows one `DropdownMenuNote` row the height of an item.
 * - The trigger brings its own look — usually a kit `Button` through `render`, ending in
 *   `DropdownMenuCaret` (FontAwesome Sharp Regular's angle-down).
 */

const DropdownMenu = MenuPrimitive.Root;

/** The control that opens the menu. Pass `render={<Button … />}` for the button look. */
function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/** A menu button's caret: the angle-down, a kicker tall, in the trigger's own ink. */
function DropdownMenuCaret({ className }: { className?: string }) {
  return (
    <FontAwesomeIcon
      data-slot="dropdown-menu-caret"
      icon={faAngleDown}
      aria-hidden="true"
      className={cn('h-(--type-kick)', className)}
    />
  );
}

type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> &
  Pick<MenuPrimitive.Portal.Props, 'container'>;

function DropdownMenuContent({
  className,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  alignOffset = 0,
  container,
  ...props
}: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        // Over sheets and viewers too: a menu belongs to whatever opened it.
        className="isolate z-[calc(var(--z-viewer)+1)] outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'grid grid-cols-[auto_minmax(0,1fr)_auto] content-start',
            'max-h-(--available-height) min-w-[max(var(--anchor-width),12rem)] overflow-y-auto py-(--space-1) outline-none',
            'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
            'font-(family-name:--family-sans) text-assist leading-none font-medium tracking-normal normal-case',
            'transition-opacity duration-(--duration-fast) ease-standard',
            'data-starting-style:opacity-0 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** A row's box: spans the plate and shares its three columns. */
const ROW = 'col-span-full grid grid-cols-subgrid items-center h-td px-[1.15em]';

type DropdownMenuItemProps = Omit<MenuPrimitive.Item.Props, 'children'> & {
  children: ReactNode;
  /** A glyph before the label, in its fixed slot. */
  icon?: ReactNode;
  /**
   * The key that does this without the menu ("C", "⇧ D"): a cap in the key column. Name it with
   * `aria-keyshortcuts` too, for a screen reader; the cap itself is decoration.
   */
  kbd?: string;
  /** Destructive: red only while highlighted, and its handler opens a confirm. */
  variant?: 'default' | 'danger';
};

function DropdownMenuItem({
  className,
  icon,
  kbd,
  variant = 'default',
  label,
  children,
  ...props
}: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      // Type-ahead matches the words, not the key cap beside them.
      label={label ?? (typeof children === 'string' ? children : undefined)}
      className={cn(
        ROW,
        'cursor-pointer text-fg1 outline-none select-none',
        'transition-[background-color,color] duration-(--duration-instant) ease-standard',
        'data-highlighted:bg-lift-08 data-highlighted:text-fg',
        'data-[variant=danger]:data-highlighted:text-bad',
        'data-disabled:cursor-default data-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    >
      <span data-slot="dropdown-menu-icon" className="flex items-center text-fg2">
        {icon != null && (
          <span className="mr-[0.75em] inline-flex w-[1.1em] justify-center [&_svg]:h-[1em]">
            {icon}
          </span>
        )}
      </span>
      <span data-slot="dropdown-menu-text" className="min-w-0 truncate">
        {children}
      </span>
      <span data-slot="dropdown-menu-kbd" className="flex justify-end">
        {kbd !== undefined && (
          <Kbd
            aria-hidden="true"
            variant="dim"
            className="ml-(--space-4) in-data-highlighted:bg-fg2 in-data-highlighted:text-panel"
          >
            {kbd}
          </Kbd>
        )}
      </span>
    </MenuPrimitive.Item>
  );
}

function DropdownMenuGroup({ className, ...props }: MenuPrimitive.Group.Props) {
  return (
    <MenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn('col-span-full grid grid-cols-subgrid', className)}
      {...props}
    />
  );
}

/** A group's kicker, aligned to the items' edge. Goes inside a `DropdownMenuGroup`. */
function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn(
        'col-span-full px-[calc(var(--type-assist)*1.15)] pt-(--space-2_5) pb-(--space-1_5)',
        'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('col-span-full my-(--space-1) h-px bg-line', className)}
      {...props}
    />
  );
}

/** A row that isn't an action — "Loading…", "Nothing to copy yet" — an item's height. */
function DropdownMenuNote({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dropdown-menu-note"
      role="presentation"
      className={cn(ROW, 'flex font-regular text-fg3', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  type DropdownMenuContentProps,
  DropdownMenuGroup,
  DropdownMenuItem,
  type DropdownMenuItemProps,
  DropdownMenuLabel,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
