import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';
import { cn } from '@/lib/utils';

/**
 * **`PhotoStage`** (board 2.7; first used by the Inbox's photo flag and the record sheet) — a photo
 * **pixelated until the viewer chooses to look**, and the thumbnails drawn the same way
 * (`PhotoThumb`, `PixelatedImage`). Every word is the caller's.
 *
 * **How the full image stays out of reach until it is shown:**
 * - **Never fetched.** Before the reveal the full image's address is not in the page at all — no
 *   `<img>`, no `src`, no `srcset`, no CSS `url()`, no attribute holds it. Only the *thumbnail* is
 *   fetched, by a detached `Image` that is never put in the document.
 * - **Never painted.** The thumbnail is drawn into a canvas whose bitmap is the mosaic itself (24
 *   cells across on the stage, 12 on a thumbnail): the canvas's own `width` and `height` are the
 *   cell counts, and CSS scales it up with `image-rendering: pixelated`. There is no finer copy in
 *   the page to unblur — not a CSS filter over a sharp image.
 * - **Not reachable.** The canvas is `aria-hidden` with no text alternative, so the accessibility tree
 *   holds the stage's label, never the image; right-click on it offers only the mosaic, and with no
 *   `<img>` there is no "Open image in new tab" to the address.
 * - **On reveal,** the full image mounts as an ordinary `<img>` with its alternative text.
 */

/**
 * Words set over the photo: a backing in the page's own ground, so they read in either mode over
 * whatever the photo is (in dark mode it all but vanishes, as the board draws them bare).
 */
const ON_PHOTO = 'bg-bg/75 px-(--space-1_5) py-(--space-1)';

/** Cells across the stage's mosaic, and a thumbnail's (the board's 36 px and 11 px blocks). */
export const STAGE_CELLS = 24;
export const THUMB_CELLS = 12;

/** The mosaic's grid for a box: `cols` across, rows by the box's shape (never 0). */
export function mosaicGrid(cols: number, width: number, height: number) {
  const c = Math.max(1, Math.round(cols));
  if (!(width > 0) || !(height > 0)) return { cols: c, rows: Math.max(1, Math.round(c * 0.6)) };
  return { cols: c, rows: Math.max(1, Math.round((c * height) / width)) };
}

/** The part of an image that covers a box of `cols × rows` (centered, as `object-fit: cover`). */
export function coverCrop(imgW: number, imgH: number, cols: number, rows: number) {
  if (!(imgW > 0) || !(imgH > 0)) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  const target = cols / rows;
  const source = imgW / imgH;
  if (source > target) {
    const sw = imgH * target;
    return { sx: (imgW - sw) / 2, sy: 0, sw, sh: imgH };
  }
  const sh = imgW / target;
  return { sx: 0, sy: (imgH - sh) / 2, sw: imgW, sh };
}

export type PixelatedImageProps = Omit<
  ComponentProps<'canvas'>,
  'children' | 'width' | 'height'
> & {
  /** The thumbnail's address — never the full image's. `null` draws an empty field. */
  src: string | null;
  /** Cells across. */
  cells: number;
};

/**
 * The mosaic: a detached image of `src` drawn into a canvas of `cells` across, scaled up by CSS
 * without smoothing. `data-drawn` marks the moment the mosaic is painted (a story waits on it).
 */
export function PixelatedImage({ src, cells, className, ...props }: PixelatedImageProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [grid, setGrid] = useState(() => mosaicGrid(cells, 0, 0));
  const [drawn, setDrawn] = useState<string | null>(null);

  // The grid follows the box's shape: measured on mount and whenever the box resizes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const next = mosaicGrid(cells, el.clientWidth, el.clientHeight);
      setGrid((g) => (g.cols === next.cols && g.rows === next.rows ? g : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cells]);

  useEffect(() => {
    setDrawn(null);
    const el = ref.current;
    if (el === null || src === null) return;
    // Detached: never in the document, so never in the accessibility tree or a context menu.
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    let live = true;
    img.onload = () => {
      if (!live) return;
      const ctx = el.getContext('2d');
      if (ctx === null) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, grid.cols, grid.rows);
      const c = coverCrop(img.naturalWidth, img.naturalHeight, grid.cols, grid.rows);
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, 0, 0, grid.cols, grid.rows);
      setDrawn(`${grid.cols}x${grid.rows}`);
    };
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
      img.removeAttribute('src');
    };
  }, [src, grid]);

  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas with no tabindex takes no focus; hidden, it keeps the image out of the accessibility tree.
    <canvas
      ref={ref}
      aria-hidden="true"
      data-slot="photo-mosaic"
      data-cells={grid.cols}
      data-drawn={drawn ?? undefined}
      width={grid.cols}
      height={grid.rows}
      className={cn('block size-full bg-raise [image-rendering:pixelated]', className)}
      {...props}
    />
  );
}

export type PhotoStageProps = {
  /** The thumbnail, the only image fetched before the reveal. */
  thumb: string | null;
  /** The full image's address; put in the page only once `shown`. */
  full: string | null;
  shown: boolean;
  onShow: () => void;
  onPixelate: () => void;
  /** The revealed image's text alternative. */
  alt: string;
  /** The stage's accessible name while pixelated (what it is, never what it shows). */
  label: string;
  /** The veil's line and its button's words. */
  veil: string;
  showLabel: string;
  pixelateLabel: string;
  /** The key the reveal is bound to, drawn on its button (the caller binds it). */
  showKey?: string;
  /** Bottom-left: when and where. */
  caption?: ReactNode;
  /** Bottom-right: its place on the report. */
  place?: ReactNode;
  className?: string;
};

/**
 * **The stage**: the mosaic under a veil with *Show the photo*; once shown, the photo itself (fit
 * whole, never cropped) and *Pixelate again*. Focus follows the press: the button that replaces the
 * pressed one takes it.
 */
export function PhotoStage({
  thumb,
  full,
  shown,
  onShow,
  onPixelate,
  alt,
  label,
  veil,
  showLabel,
  pixelateLabel,
  showKey,
  caption,
  place,
  className,
}: PhotoStageProps) {
  const showRef = useRef<HTMLButtonElement>(null);
  const pixelateRef = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  // The pressed button unmounts as the stage flips, dropping focus to the page: the button that
  // replaces it takes it. A flip from the bound key while focus is elsewhere moves nothing.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const at = document.activeElement;
    if (at === null || at === document.body) (shown ? pixelateRef : showRef).current?.focus();
  }, [shown]);
  const src = shown ? (full ?? thumb) : null;
  return (
    <figure
      aria-label={shown ? alt : label}
      data-slot="photo-stage"
      data-shown={shown ? '' : undefined}
      className={cn(
        'relative m-0 h-60 min-w-0 @[45rem]:h-[22.5rem] overflow-hidden border-0 border-b border-solid border-line bg-raise',
        className,
      )}
    >
      {shown && src !== null ? (
        <img
          data-slot="photo-full"
          src={src}
          alt={alt}
          decoding="async"
          draggable={false}
          className="block size-full object-contain"
        />
      ) : (
        <>
          <PixelatedImage src={shown ? null : thumb} cells={STAGE_CELLS} />
          {/* The board's dimming over the mosaic. */}
          <span aria-hidden="true" className="absolute inset-0 bg-bg/20" />
        </>
      )}
      {shown ? (
        <Button
          ref={pixelateRef}
          size="xs"
          data-slot="photo-pixelate"
          className="absolute end-(--space-3) top-(--space-3) z-1 bg-bg/80"
          aria-keyshortcuts={showKey}
          onClick={onPixelate}
        >
          {pixelateLabel}
          {showKey !== undefined && (
            <Kbd variant="dim" aria-hidden="true">
              {showKey}
            </Kbd>
          )}
        </Button>
      ) : (
        <div
          data-slot="photo-veil"
          className="absolute start-1/2 top-1/2 z-1 flex max-w-[calc(100%-2*var(--space-3))] -translate-1/2 flex-col items-center gap-(--space-2_5) border border-solid border-line2 bg-bg/80 px-(--space-5) py-(--space-4) text-center"
        >
          <span className="text-row leading-snug text-fg1">{veil}</span>
          <Button
            ref={showRef}
            size="sm"
            data-slot="photo-show"
            aria-keyshortcuts={showKey}
            onClick={onShow}
          >
            {showLabel}
            {showKey !== undefined && (
              <Kbd variant="dim" aria-hidden="true">
                {showKey}
              </Kbd>
            )}
          </Button>
        </div>
      )}
      {(caption != null || place != null) && (
        // One line at the foot: when and where on the left, the place on the report on the right;
        // the caption gives way (truncates) before the two can meet on a narrow pane.
        <div className="pointer-events-none absolute inset-x-(--space-2) bottom-(--space-1_5) z-1 flex items-baseline justify-between gap-(--space-3) font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg2 uppercase">
          {caption != null && (
            <span data-slot="photo-caption" className={cn('min-w-0 truncate', ON_PHOTO)}>
              {caption}
            </span>
          )}
          {place != null && (
            <span data-slot="photo-place" className={cn('ms-auto shrink-0', ON_PHOTO)}>
              {place}
            </span>
          )}
        </div>
      )}
    </figure>
  );
}

export type PhotoThumbProps = {
  thumb: string | null;
  shown: boolean;
  /** Its accessible name while pixelated; `alt` once shown. */
  label: string;
  alt: string;
  /** The photo the stage holds: drawn with the lit rule. */
  selected?: boolean;
  className?: string;
};

/**
 * A thumbnail (132 × 80, the board's), pixelated as the stage is until the stage is shown. No address
 * served (a viewer who can't see photos, a file deleted): an empty dashed frame, never an image.
 */
export function PhotoThumb({
  thumb,
  shown,
  label,
  alt,
  selected = false,
  className,
}: PhotoThumbProps) {
  return (
    <span
      data-slot="photo-thumb"
      data-selected={selected ? '' : undefined}
      data-shown={shown ? '' : undefined}
      className={cn(
        'relative block h-20 w-[8.25rem] shrink-0 overflow-hidden border border-solid bg-raise',
        selected ? 'border-fg' : 'border-line2',
        thumb === null && 'border-dashed',
        className,
      )}
    >
      {thumb === null ? null : shown ? (
        <img
          src={thumb}
          alt={alt}
          decoding="async"
          draggable={false}
          className="block size-full object-cover"
        />
      ) : (
        <>
          <PixelatedImage src={thumb} cells={THUMB_CELLS} />
          <span role="img" aria-label={label} className="absolute inset-0" />
        </>
      )}
    </span>
  );
}
