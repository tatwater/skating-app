import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import { cn } from '@/lib/utils';

/**
 * The kit's ScrollArea: shadcn's Scroll Area on Base UI, re-skinned to the console's pane scroller
 * (and the log box's drawn thumb).
 *
 * - **A thin, square thumb**: a `stroke-run` bar in the faint ink on a `raise` track, inset
 *   `space-1` from the edge and `space-1_5` from the ends — no rounded pill. It brightens while
 *   held or hovered.
 * - **Seen only when it matters**: the bar fades in while the pointer is over the area, while it
 *   scrolls, or while the viewport has keyboard focus, and fades out after. `always` keeps it in
 *   view, for a box whose still render must show it scrolls (the log).
 * - **A stable gutter** (`gutter`, on by default): the viewport always reserves the bar's lane on
 *   its scrolling edge, whether or not there is anything to scroll, so content never shifts or
 *   slides under the bar as it comes and goes. `gutter={false}` lets the bar overlay the content
 *   (a map, an image) — still no shift, but nothing is kept clear.
 * - **Either axis or both** (`axes`): the other axis clips. Both draws the corner.
 * - **Keyboard**: the viewport takes focus when it scrolls (arrows, Page keys, Space), with an
 *   inset hairline in the bright ink as its focus mark — a pane's own edge would clip a ring.
 * - The fade rides the motion tokens, so it's instant under reduced motion.
 */

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  /** Which way it scrolls. */
  axes?: 'y' | 'x' | 'both';
  /** Reserve the bar's lane so content never shifts (default), or let the bar overlay it. */
  gutter?: boolean;
  /** Keep the bar in view (a box whose still render must show it scrolls). */
  always?: boolean;
  /** The viewport's classes (its inset, where content padding belongs). */
  viewportClassName?: string;
};

/**
 * The bar's lane (`--scroll-lane`): the thumb's stroke plus its inset on either side. The gutter
 * the viewport keeps clear is exactly this, so the reserved space and the drawn bar can't drift
 * apart.
 */
const LANE = '[--scroll-lane:calc(var(--stroke-run)+2*var(--space-1))]';

function ScrollArea({
  className,
  axes = 'y',
  gutter = true,
  always = false,
  viewportClassName,
  children,
  ...props
}: ScrollAreaProps) {
  const y = axes !== 'x';
  const x = axes !== 'y';
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      data-axes={axes}
      data-always={always ? '' : undefined}
      className={cn('group/scroll relative min-h-0 min-w-0 overflow-hidden', LANE, className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          'size-full overscroll-contain rounded-[inherit] outline-none',
          'focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
          // One axis scrolls; the other clips (Base UI's viewport scrolls both by default).
          !x && 'overflow-x-hidden!',
          !y && 'overflow-y-hidden!',
          gutter && y && 'pr-(--scroll-lane)',
          gutter && x && 'pb-(--scroll-lane)',
          viewportClassName,
        )}
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          // A one-axis area wraps its content to the viewport instead of growing sideways.
          className={cn(!x && 'min-w-0!')}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {y && <ScrollBar orientation="vertical" always={always} />}
      {x && <ScrollBar orientation="horizontal" always={always} />}
      {x && y && <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />}
    </ScrollAreaPrimitive.Root>
  );
}

type ScrollBarProps = ScrollAreaPrimitive.Scrollbar.Props & { always?: boolean };

/** The lane and its thumb. The track is the lane's content box, painted in `raise`. */
function ScrollBar({
  className,
  orientation = 'vertical',
  always = false,
  ...props
}: ScrollBarProps) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none bg-raise bg-clip-content select-none',
        'transition-opacity duration-(--duration-base) ease-standard',
        always
          ? 'opacity-100'
          : [
              'opacity-0 delay-(--duration-slow)',
              'data-hovering:opacity-100 data-hovering:delay-0',
              'data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-(--duration-fast)',
              'group-has-[[data-slot=scroll-area-viewport]:focus-visible]/scroll:opacity-100 group-has-[[data-slot=scroll-area-viewport]:focus-visible]/scroll:delay-0',
            ],
        orientation === 'vertical'
          ? 'w-(--scroll-lane) px-(--space-1) py-(--space-1_5)'
          : 'h-(--scroll-lane) flex-col px-(--space-1_5) py-(--space-1)',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          'relative flex-1 rounded-none bg-fg3',
          'transition-[background-color] duration-(--duration-fast) ease-standard',
          '[@media(hover:hover)]:hover:bg-fg2 active:bg-fg1',
          // The thumb is a few px wide: its pointer area reaches the lane's edges.
          orientation === 'vertical'
            ? 'w-full before:absolute before:inset-y-0 before:-inset-x-(--space-1)'
            : 'h-full before:absolute before:inset-x-0 before:-inset-y-(--space-1)',
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, type ScrollAreaProps, ScrollBar };
