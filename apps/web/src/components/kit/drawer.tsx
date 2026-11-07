import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { type ComponentProps, createContext, useContext } from 'react';

import { cn } from '@/lib/utils';

import {
  SheetBody,
  type SheetBodyProps,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './sheet';

/**
 * The kit's Drawer: the skater app's bottom sheet on a phone — Base UI's Drawer (1.8, stable; not
 * `vaul`), which brings the swipe gesture and the snap points. The phone mocks are the reference:
 * the lake sheet over the map (half, then full under the top bar) and the avatar's menu sheet.
 *
 * - **A square top edge** on the void ground with a `line2` rule — a container, not a control.
 * - **The grab region** the mocks draw: a short bar centered at the top, in `line2`. It's where a
 *   mouse drags (a finger drags anywhere); it isn't a button.
 * - **Swipe down to dismiss**, or drag between snap points. `snapPoints` takes Base UI's values
 *   (a fraction of the drawer's viewport, px or rem); `DRAWER_SNAP_POINTS` is the mocks' pair —
 *   half, then full (under the top bar). Without snap points the sheet sizes to its content, up to
 *   that same full height.
 * - **The scrim token**, with Esc and a press on it closing the sheet; the scrim fades as the sheet
 *   is dragged down. A sheet that leaves what's behind it live (the lake sheet over the map) passes
 *   `modal={false}` to the root and `scrim={false}` here.
 * - **The head, body and foot are the Sheet's** (`DrawerHeader` is `SheetHeader`, with Close and
 *   its Esc key — the overlays keep the console's rule of no ×). `DrawerBody` scrolls, selects text
 *   under a mouse without starting a drag, and keeps its content's size while it loads.
 * - **It slides up** on the motion tokens. Under reduced motion it doesn't move: it fades, on the
 *   same tokens (which reduced motion zeroes, so the change is immediate). A drag still follows the
 *   finger.
 */

/** The phone mocks' snap points: half the screen, then full (the sheet stops under the top bar). */
const DRAWER_SNAP_POINTS: DrawerPrimitive.Root.SnapPoint[] = [0.5, 1];

/** Whether the root has snap points: the sheet then takes its full height and slides by offset. */
const SnapContext = createContext(false);

type DrawerProps = Omit<DrawerPrimitive.Root.Props, 'swipeDirection'>;

/** The root. A bottom sheet, so it always swipes down to dismiss. */
function Drawer({ snapPoints, ...props }: DrawerProps) {
  return (
    <SnapContext.Provider value={snapPoints !== undefined && snapPoints.length > 0}>
      <DrawerPrimitive.Root
        data-slot="drawer"
        swipeDirection="down"
        snapPoints={snapPoints}
        {...props}
      />
    </SnapContext.Provider>
  );
}

function DrawerTrigger(props: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerClose(props: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

type DrawerContentProps = DrawerPrimitive.Popup.Props &
  Pick<DrawerPrimitive.Portal.Props, 'container'> & {
    /** The scrim behind the sheet. Off for a sheet that leaves the page behind it live. */
    scrim?: boolean;
  };

function DrawerContent({
  className,
  container,
  scrim = true,
  children,
  ...props
}: DrawerContentProps) {
  const snaps = useContext(SnapContext);
  const position = container != null ? 'absolute' : 'fixed';
  return (
    <DrawerPrimitive.Portal container={container}>
      {scrim && (
        <DrawerPrimitive.Backdrop
          data-slot="drawer-scrim"
          className={cn(
            position,
            'inset-0 z-(--z-scrim) bg-scrim',
            // Fades out as the sheet is dragged down.
            'opacity-[calc(1-var(--drawer-swipe-progress,0))]',
            'transition-opacity duration-(--duration-slow) ease-enter',
            'data-starting-style:opacity-0 data-ending-style:opacity-0',
            'data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*var(--duration-base))] data-ending-style:ease-exit',
            'data-swiping:duration-0',
          )}
        />
      )}
      {/*
       * The viewport passes presses through to the scrim (the sheet takes its own back), and holds
       * the drag: Base UI listens on it for the sheet's pointer events.
       */}
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className={cn(position, 'pointer-events-none inset-0 z-(--z-sheet) overflow-clip')}
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          data-snaps={snaps ? '' : undefined}
          className={cn(
            'pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col outline-none',
            // Where the sheet sits: its snap offset plus the drag.
            '[--drawer-offset:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px))]',
            'rounded-none border-0 border-t border-solid border-line2 bg-bg',
            'font-(family-name:--family-sans) text-fg',
            // Full is the drawer's viewport less the top bar; with snap points it is that tall and
            // slides down by the snap offset, padding its foot back into view.
            snaps
              ? 'h-[calc(100%-var(--size-top))] pb-[max(0px,var(--drawer-offset))]'
              : 'max-h-[calc(100%-var(--size-top))]',
            'touch-none [transform:translateY(var(--drawer-offset))]',
            'transition-[transform,opacity] duration-(--duration-slow) ease-enter',
            'data-ending-style:ease-exit',
            'data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*var(--duration-base))]',
            'data-swiping:duration-0 data-swiping:select-none',
            // In and out: from below the edge — or, under reduced motion, a fade in place.
            'motion-safe:data-starting-style:[transform:translateY(100%)] motion-safe:data-ending-style:[transform:translateY(100%)]',
            'motion-reduce:data-starting-style:opacity-0 motion-reduce:data-ending-style:opacity-0',
            'data-starting-style:pb-0 data-ending-style:pb-0',
            className,
          )}
          {...props}
        >
          <DrawerGrab />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

/** The grab region: a bar centered in a strip at the sheet's top. Drawn, not a control. */
function DrawerGrab({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      data-slot="drawer-grab"
      className={cn(
        'flex h-(--space-4_5) shrink-0 cursor-grab items-center justify-center select-none',
        className,
      )}
      {...props}
    >
      <span
        data-slot="drawer-handle"
        className="block h-(--space-1) w-(--space-10) rounded-control bg-line2"
      />
    </div>
  );
}

/**
 * The scrolling body (`SheetBody` inside Base UI's drawer content): a mouse selects text in it
 * rather than dragging the sheet, and a finger scrolls it. `loading` keeps its content's place.
 */
function DrawerBody({ className, ...props }: SheetBodyProps) {
  return (
    <DrawerPrimitive.Content data-slot="drawer-body" className="flex min-h-0 flex-1 flex-col">
      <SheetBody className={cn('touch-auto overscroll-contain', className)} {...props} />
    </DrawerPrimitive.Content>
  );
}

/** The head: the Sheet's — the title, its sub-line, then Close · Esc. */
const DrawerHeader = SheetHeader;
/** The sheet's name. */
const DrawerTitle = SheetTitle;
/** What it's for, beside its name. */
const DrawerDescription = SheetDescription;
/** The foot: notes left, actions right. */
const DrawerFooter = SheetFooter;

export {
  DRAWER_SNAP_POINTS,
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  type DrawerContentProps,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  type DrawerProps,
  DrawerTitle,
  DrawerTrigger,
};
