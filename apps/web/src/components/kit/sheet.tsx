import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import { DialogFooter, type DialogFooterProps, OverlayBusy } from './dialog';
import { Kbd } from './kbd';

/**
 * The kit's Sheet: shadcn's Sheet (a Base UI dialog), re-skinned to the console's sheet — the Rates
 * sheet over the cost ledger is the reference.
 *
 * - **Docked to an edge, full height**, on the void ground with a `line2` edge and the sheet shadow.
 *   Its width is fixed per sheet (`sm`, `default`, `drawer` — the size tokens), never sized to its
 *   content, so it holds its size while what fills it loads.
 * - **Over `main` only.** Pass `container` (the main region, positioned) and the scrim and sheet sit
 *   inside it, so the rail and the status bar stay lit. Without one it covers the viewport.
 * - **The scrim token, no blur. No ×**: the head carries Close with its Esc key.
 * - **Stacked sheets**: a sheet opened from inside another (Change rate over Rates) is a nested
 *   dialog; the one beneath dims under the scrim while it's covered. Make the top one narrower.
 * - **It slides** in from its edge on the motion tokens (instant under reduced motion), and ends in
 *   the sheet foot, never a floating action bar.
 */

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

const MOTION =
  'duration-(--duration-slow) ease-enter data-ending-style:ease-exit data-ending-style:duration-(--duration-base)';

const WIDTH = { sm: 'w-sheet-sm', default: 'w-sheet', drawer: 'w-drawer' } as const;

type SheetContentProps = SheetPrimitive.Popup.Props &
  Pick<SheetPrimitive.Portal.Props, 'container'> & {
    /** The edge it docks to: `right` (the console's sheets) or `bottom` (a phone's sheet). */
    side?: 'right' | 'bottom';
    /** A right sheet's fixed width. */
    size?: keyof typeof WIDTH;
  };

function SheetContent({
  className,
  side = 'right',
  size = 'default',
  container,
  children,
  ...props
}: SheetContentProps) {
  const position = container != null ? 'absolute' : 'fixed';
  return (
    <SheetPrimitive.Portal container={container}>
      <SheetPrimitive.Backdrop
        data-slot="sheet-scrim"
        className={cn(
          position,
          'inset-0 z-(--z-scrim) bg-scrim transition-opacity',
          MOTION,
          'data-starting-style:opacity-0 data-ending-style:opacity-0',
        )}
      />
      {/*
       * The viewport clips the sheet while it slides in. It can't be scrolled (`overflow: clip`):
       * focus moving into a sheet still off its edge would otherwise scroll the container under it
       * by the sheet's width. It passes presses through, so the scrim still takes them.
       */}
      <SheetPrimitive.Viewport
        data-slot="sheet-viewport"
        className={cn(position, 'pointer-events-none inset-0 z-(--z-sheet) overflow-clip')}
      >
        <SheetPrimitive.Popup
          data-slot="sheet-content"
          data-side={side}
          data-size={side === 'right' ? size : undefined}
          className={cn(
            'pointer-events-auto absolute flex flex-col border-solid border-line2 bg-bg font-(family-name:--family-sans) text-fg outline-none',
            'transition-[translate]',
            MOTION,
            side === 'right' && [
              'inset-y-0 right-0 max-w-full border-0 border-l shadow-sheet',
              WIDTH[size],
              'data-starting-style:translate-x-full data-ending-style:translate-x-full',
            ],
            side === 'bottom' && [
              'inset-x-0 bottom-0 max-h-[85%] border-0 border-t shadow-modal',
              'data-starting-style:translate-y-full data-ending-style:translate-y-full',
            ],
            // Covered by a sheet stacked on top: the scrim over this one too.
            "after:pointer-events-none after:absolute after:inset-0 after:bg-scrim after:opacity-0 after:content-['']",
            'after:transition-opacity after:duration-(--duration-base) after:ease-standard',
            'data-nested-dialog-open:after:opacity-100',
            className,
          )}
          {...props}
        >
          {children}
        </SheetPrimitive.Popup>
      </SheetPrimitive.Viewport>
    </SheetPrimitive.Portal>
  );
}

type SheetHeaderProps = ComponentProps<'div'> & {
  /** The head's Close, with its Esc key. `false` only where the sheet ends in another way out. */
  close?: boolean;
  /** Close's label. */
  closeLabel?: ReactNode;
};

/** The head: one bar the top bar's height — the title, its sub-line, then Close · Esc at the right. */
function SheetHeader({
  className,
  close = true,
  closeLabel = 'Close',
  children,
  ...props
}: SheetHeaderProps) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        'flex h-top shrink-0 items-center gap-(--space-2_5) border-b border-solid border-line px-gutter',
        className,
      )}
      {...props}
    >
      {children}
      {close && (
        <SheetPrimitive.Close
          data-slot="sheet-close"
          className="ml-auto"
          render={<Button size="sm" aria-keyshortcuts="Escape" />}
        >
          {closeLabel}
          <Kbd variant="dim" aria-hidden="true">
            Esc
          </Kbd>
        </SheetPrimitive.Close>
      )}
    </div>
  );
}

/** The sheet's name: a lit kicker. */
function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        'm-0 shrink-0 text-kick leading-none font-semibold tracking-kick whitespace-nowrap text-fg uppercase',
        className,
      )}
      {...props}
    />
  );
}

/** What the sheet is for, beside its name: a dim caps sub-line. */
function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn(
        'm-0 min-w-0 truncate text-kick leading-none font-medium tracking-label text-fg3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

type SheetBodyProps = ComponentProps<'div'> & {
  /** Busy: the content keeps its place, unseen, under a spinner. */
  loading?: boolean;
};

/** The scrolling middle. Pads by the gutter; a table inside insets by it, never its cells. */
function SheetBody({ className, loading = false, children, ...props }: SheetBodyProps) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'relative flex min-h-0 flex-1 flex-col gap-(--space-4) overflow-y-auto p-gutter',
        'text-row leading-body text-fg1',
        className,
      )}
      {...props}
    >
      <OverlayBusy loading={loading}>{children}</OverlayBusy>
    </div>
  );
}

/** The sheet foot: a ruled strip on the void, notes left, actions right. */
function SheetFooter({ className, ...props }: DialogFooterProps) {
  return <DialogFooter data-slot="sheet-footer" className={cn('bg-bg', className)} {...props} />;
}

export {
  Sheet,
  SheetBody,
  type SheetBodyProps,
  SheetClose,
  SheetContent,
  type SheetContentProps,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  type SheetHeaderProps,
  SheetTitle,
  SheetTrigger,
};
