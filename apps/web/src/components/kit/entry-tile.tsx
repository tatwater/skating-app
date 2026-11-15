import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';
import type { ToastManager } from './toast';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

import { NOT_YET, sayUnavailable } from './unavailable-button';

/**
 * The boards' way-in tile (`.way`): a button with the gesture drawn on it — a
 * small glyph, the action's name in caps, a sub-line, and its key at the far end. Body › Shape's
 * *Add a bay* tiles (chord, freehand, paste) and Access's *Add what a sign says* are the same
 * piece.
 *
 * - **A pressable thing**, so its corners are the control radius (square on the console), its
 *   edge the quiet rule, and hover or focus lifts it a step — never to the primary's face, since a
 *   stack of these are equal choices.
 * - **The glyph is the caller's** (an inline SVG drawn in the ink tokens), held in a fixed slot so
 *   a stack of tiles aligns.
 * - **`what` makes it an entry point to a tool that isn't built yet**: it rests exactly as drawn,
 *   says *Not available yet* on hover, focus and press (the same as `UnavailableButton`), and does
 *   nothing else — never a dead click.
 * - **`disabled`** is for a tile whose action the viewer can't take (no capability): faded and
 *   inert, its key dimmed with it.
 * - **`glyph="wide"`** holds a gesture drawn across (Shape's chord, freehand and paste, 66 px)
 *   instead of the square glyph slot.
 */

type EntryTileProps = Omit<ComponentProps<'button'>, 'title' | 'children'> & {
  /** The gesture, drawn small (an SVG in the ink tokens). */
  glyph: ReactNode;
  /** The action's name ("Add what a sign says"); set in caps by the tile. */
  title: string;
  /** What it is for, in a sub-line. */
  description?: ReactNode;
  /** Its key, a cap at the far end. */
  kbd?: string;
  /** The tool isn't built yet: what it will do. Makes the tile say so instead of acting. */
  what?: ReactNode;
  /** The glyph's slot: a square (default), or wide for a gesture drawn across. */
  glyphSlot?: 'square' | 'wide';
  manager?: ToastManager;
};

/**
 * The tile's height: the boards' 50 px `.way` (body-tab-access-v5.js; Shape's are 54). No size
 * token holds it yet — named here so the token lands in one place.
 */
const ENTRY_TILE_MIN_HEIGHT = 'min-h-[3.125rem]';

const TILE = [
  ENTRY_TILE_MIN_HEIGHT,
  'group/tile flex w-full cursor-pointer items-center gap-(--space-3) py-(--space-2) pr-(--space-3_5) pl-(--space-3)',
  'rounded-control border border-solid border-line2 bg-transparent text-left outline-none',
  'transition-[background-color,border-color] duration-(--duration-fast) ease-standard',
  'lit:bg-lift-05 lit:border-fg3 focus-visible:shadow-focus',
  'disabled:cursor-default disabled:opacity-(--opacity-muted)',
];

function EntryTile({
  glyph,
  title,
  description,
  kbd,
  what,
  glyphSlot = 'square',
  manager,
  className,
  onClick,
  ...props
}: EntryTileProps) {
  const unavailable = what != null;
  const tile = (
    <button
      type="button"
      data-slot="entry-tile"
      data-unavailable={unavailable ? '' : undefined}
      aria-disabled={unavailable || undefined}
      className={cn(TILE, className)}
      onClick={(event) => {
        if (unavailable) sayUnavailable(what, manager);
        else onClick?.(event);
      }}
      {...props}
    >
      <span
        data-slot="entry-tile-glyph"
        aria-hidden="true"
        className={cn(
          'flex h-(--space-8) shrink-0 items-center justify-center [&_svg]:size-full',
          // A gesture drawn across: the Shape board's 66 px, the tile's own dimension.
          glyphSlot === 'wide' ? 'w-[4.125rem]' : 'w-(--space-8)',
        )}
      >
        {glyph}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-1_5) pr-(--space-1)">
        <span
          data-slot="entry-tile-title"
          className="truncate text-kick leading-none font-semibold tracking-head text-fg uppercase"
        >
          {title}
        </span>
        {description != null && (
          <span
            data-slot="entry-tile-description"
            className="truncate text-assist leading-(--lead-snug) text-fg3"
          >
            {description}
          </span>
        )}
      </span>
      {kbd !== undefined && (
        <Kbd variant="dim" aria-hidden="true" disabled={props.disabled} className="shrink-0">
          {kbd}
        </Kbd>
      )}
    </button>
  );
  if (!unavailable) return tile;
  return (
    <Tooltip>
      <TooltipTrigger render={tile} />
      <TooltipContent title={NOT_YET}>{what}</TooltipContent>
    </Tooltip>
  );
}

export { EntryTile, type EntryTileProps };
