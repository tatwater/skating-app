import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Popover: shadcn's Base UI popover, re-skinned to the console's menu plate — the Bodies
 * lookup, the Filter menu and the month grid.
 *
 * - **A square plate** on the panel ground with a `line2` edge and the plate shadow — **no arrow**.
 * - **Kicker title convention** (as the Tooltip's): an optional head with a lit caps title and a
 *   dim note at its right, ruled from the body; an optional foot for keys, ruled above.
 * - **Focus is trapped** inside while it's open (`modal="trap-focus"`, Base UI's), without locking
 *   the page's scroll; Esc or a press outside closes it and focus returns to the trigger. A close
 *   only screen readers reach is built in, for touch readers who can't press Esc.
 * - It sits 6 px off its trigger, fades on the motion tokens, and scrolls inside when it would run
 *   past the viewport.
 */

function Popover({ modal = 'trap-focus', ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" modal={modal} {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverClose(props: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

type PopoverContentProps = PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> &
  Pick<PopoverPrimitive.Portal.Props, 'container'> & {
    /** The screen-reader close's name. */
    closeLabel?: string;
  };

function PopoverContent({
  className,
  side = 'bottom',
  // 6 px: the month grid's drop under its field (a drawing offset; Floating UI takes px).
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  container,
  closeLabel = 'Close',
  children,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        // Over sheets and viewers too: a popover belongs to whatever opened it.
        className="isolate z-[calc(var(--z-viewer)+1)] outline-none"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'flex max-h-(--available-height) max-w-(--available-width) flex-col overflow-hidden',
            'rounded-container border border-solid border-line2 bg-panel shadow-plate',
            'font-(family-name:--family-sans) text-fg outline-none',
            'transition-opacity duration-(--duration-fast) ease-standard',
            'data-starting-style:opacity-0 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
          <PopoverPrimitive.Close tabIndex={-1} className="sr-only">
            {closeLabel}
          </PopoverPrimitive.Close>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

type PopoverHeaderProps = ComponentProps<'div'> & {
  /** A dim note at the head's right ("3 applied"). */
  note?: ReactNode;
};

/** The head: the title (a `PopoverTitle`) and a note, ruled from the body. */
function PopoverHeader({ className, note, children, ...props }: PopoverHeaderProps) {
  return (
    <div
      data-slot="popover-header"
      className={cn(
        'flex shrink-0 items-center gap-(--space-2_5) border-b border-solid border-line px-(--space-3_5) py-(--space-3)',
        className,
      )}
      {...props}
    >
      {children}
      {note != null && (
        <span data-slot="popover-note" className="ml-auto text-assist leading-none text-fg3">
          {note}
        </span>
      )}
    </div>
  );
}

/** The lit kicker title. */
function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn(
        'm-0 text-kick leading-none font-semibold tracking-kick text-fg uppercase',
        className,
      )}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn('m-0 text-assist leading-body text-fg2', className)}
      {...props}
    />
  );
}

/** The content, padded and scrolling on its own when the plate runs out of room. */
function PopoverBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-body"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-(--space-2) overflow-y-auto p-(--space-2_5)',
        'text-row leading-list text-fg1',
        className,
      )}
      {...props}
    />
  );
}

/** The foot: keys and hints, dim, ruled above. */
function PopoverFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-footer"
      className={cn(
        'flex shrink-0 items-center gap-(--space-2_5) border-t border-solid border-line px-(--space-3_5) py-(--space-2)',
        'text-assist leading-none text-fg3',
        className,
      )}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverBody,
  PopoverClose,
  PopoverContent,
  type PopoverContentProps,
  PopoverDescription,
  PopoverFooter,
  PopoverHeader,
  type PopoverHeaderProps,
  PopoverTitle,
  PopoverTrigger,
};
