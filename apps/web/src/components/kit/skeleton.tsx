import * as tokens from '@skating/design/tokens';
import { type ComponentProps, useEffect, useRef } from 'react';

import { useReducedMotion } from '@/lib/useReducedMotion';
import { cn } from '@/lib/utils';

/**
 * The kit's Skeleton: the reserved-size loading rule made reusable. **A skeleton takes the exact
 * box of what it replaces** — same height, same width where the width is known — so nothing on the
 * page moves when the content arrives. That is its whole contract; a skeleton that is "about the
 * right size" is a bug.
 *
 * - **A wash, not a shape.** One quiet lift of the ink (`lift-08`) on whatever ground it sits on,
 *   at the surface's control radius (square on the console, 2 px on skater) — the mocks' `.sk`.
 * - **Text runs** are one line box tall per line (`1lh` of the type they're given), and paint only
 *   the cap-height band inside it, so a run of skeleton lines sits where the text will.
 * - **Shimmer only when motion is allowed**: a band sweeps on the lamp timing, every skeleton on
 *   the page in step. Under reduced motion the wash holds still — no shimmer, no pulse.
 * - **Never announced.** Skeletons are `aria-hidden`; the region that's loading carries
 *   `aria-busy` and its own label, so a reader hears "loading" once, not a list of empty boxes.
 */

/**
 * The shimmer: a band of the wash sweeping left to right on the lamp's timing. Started at the
 * document timeline's zero, so every skeleton on the page sweeps in step, whenever it mounted.
 */
function useShimmer(on: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || el === null) return;
    const anim = el.animate([{ backgroundPosition: '150% 0' }, { backgroundPosition: '-50% 0' }], {
      duration: tokens.duration.lamp,
      easing: `cubic-bezier(${tokens.easing.lamp.join(',')})`,
      iterations: Number.POSITIVE_INFINITY,
    });
    anim.startTime = 0;
    return () => anim.cancel();
  }, [on]);
  return ref;
}

/** The wash, and — while shimmering — the band over it. */
const WASH = [
  'block shrink-0 rounded-control bg-lift-08',
  'data-shimmer:bg-[linear-gradient(90deg,transparent_25%,var(--lift-08)_50%,transparent_75%)]',
  'data-shimmer:bg-size-[200%_100%] data-shimmer:bg-no-repeat',
];

type SkeletonProps = ComponentProps<'span'>;

/** A bare block: size it to the box it replaces (`className` or `style`). */
function Skeleton({ className, ...props }: SkeletonProps) {
  const reduced = useReducedMotion();
  const ref = useShimmer(!reduced);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="skeleton"
      data-shimmer={reduced ? undefined : ''}
      className={cn(WASH, className)}
      {...props}
    />
  );
}

type SkeletonTextProps = Omit<SkeletonProps, 'children'> & {
  /**
   * The type of the text it replaces — the same font-size and leading classes (`text-row
   * leading-list`) — so each line is exactly that text's line box.
   */
  className?: string;
  /** How wide the run is, as a CSS length (`12ch`, `62%`). Default: the full width. */
  width?: string;
  /** Lines in the run; the last one stops at 60%, as a paragraph's last line does. */
  lines?: number;
};

/** One line, a line box tall, painted in its cap-height band. */
const LINE = 'h-[1lh] bg-clip-content py-[calc((1lh-1cap)/2)]';

/** A run of text: `lines` line boxes of the type it's given. */
function SkeletonText({
  className,
  width = '100%',
  lines = 1,
  style,
  ...props
}: SkeletonTextProps) {
  if (lines <= 1) {
    return <Skeleton className={cn(LINE, className)} style={{ width, ...style }} {...props} />;
  }
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton-text"
      className={cn('block', className)}
      style={{ width, ...style }}
      {...props}
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          // Lines are positional and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: a line is its index
          key={i}
          className={LINE}
          style={{ width: i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
    </span>
  );
}

type SkeletonStatProps = Omit<SkeletonProps, 'children'> & {
  /** How many characters the value will have (`$75.80` is 6): mono digits make this exact. */
  chars: number;
};

/**
 * A stat value: the stat step in mono, one line box tall, exactly `chars` mono characters wide
 * (each character's advance plus the value tracking, as the real value sets it).
 *
 * The width is laid out from `chars` invisible mono zeros, not computed as `calc(n * 1ch)`: an empty
 * box's `ch` was resolved once against whatever face was there, and Chromium left it on the
 * fallback's after Martian Mono loaded (13 px short on `$75.80`, about one run in five on a cold
 * cache). Text is re-laid out when its face arrives, and asking for the glyphs is what loads the
 * face at all. Mono digits, `$` and `.` share one advance, so the box is the value's.
 */
function SkeletonStat({ chars, className, ...props }: SkeletonStatProps) {
  return (
    <Skeleton
      className={cn(
        LINE,
        'w-fit font-(family-name:--family-mono) text-stat leading-none tracking-value',
        'whitespace-nowrap text-transparent select-none',
        className,
      )}
      {...props}
    >
      {'0'.repeat(Math.max(0, chars))}
    </Skeleton>
  );
}

type SkeletonRowProps = ComponentProps<'span'> & {
  /** Each cell's width, as CSS lengths; the row's type is the table's (`text-row`). */
  cells: readonly string[];
};

/**
 * A list or table row: the surface's row height (`size-td`), full width, its cells set on the row
 * gap with text runs in the row type. In a real `<table>`, put `SkeletonText` in the `<td>`s
 * instead, so the table keeps its columns.
 */
function SkeletonRow({ cells, className, ...props }: SkeletonRowProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton-row"
      className={cn(
        'flex h-td w-full items-center gap-(--space-3) text-row leading-list',
        className,
      )}
      {...props}
    >
      {cells.map((w, i) => (
        // Cells are positional and never reorder.
        // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its index
        <SkeletonText key={i} width={w} />
      ))}
    </span>
  );
}

/**
 * A map or chart: a full-width block. Give it the height (or aspect) of the map or chart it holds
 * the place of — the same class the real one takes.
 */
function SkeletonBlock({ className, ...props }: SkeletonProps) {
  return <Skeleton className={cn('w-full', className)} {...props} />;
}

export {
  Skeleton,
  SkeletonBlock,
  type SkeletonProps,
  SkeletonRow,
  type SkeletonRowProps,
  SkeletonStat,
  type SkeletonStatProps,
  SkeletonText,
  type SkeletonTextProps,
};
