import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate** — the LED strip: a count out of a whole, drawn as one segment per part, the
 * parts it has lit (the boards' `.led`; Bodies' completeness in its rows and its preview, the Body
 * console's *Complete · 9 / 10*). A measurement, so `role="meter"` with the value and the whole.
 *
 * - **`row`** sits in a table cell: small segments on the row's baseline, lit in the list ink
 *   (`fg2`) over the hairline ground (`line`) — a row is read, not admired.
 * - **`full`** spans its column: one segment per part across the whole width, a step taller, lit
 *   segments in the bright ink with the lit glow — the record's own strip, in a preview or a
 *   left panel.
 * - Unrecorded is the caller's to leave out: a strip always has a value.
 */

/** A row segment's width: 5 px (`v5-pages.css` `.t td .led i`). No space step is 5 px. */
const LED_ROW_SEGMENT_WIDTH = '0.3125rem';
/** The full strip's gap: 3 px (`bodies-v5.html` `.complete .segs`). No space step is 3 px. */
const LED_FULL_GAP = '0.1875rem';

type LedStripProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** How many parts are lit. Clamped to `0…max`. */
  value: number;
  /** How many parts there are. */
  max: number;
  /** In a table row, or across a column. Default `row`. */
  size?: 'row' | 'full';
  /** What it measures, for a reader ("Complete"). */
  label: string;
};

function LedStrip({ value, max, size = 'row', label, className, style, ...props }: LedStripProps) {
  const parts = Math.max(0, Math.floor(max));
  const lit = Math.max(0, Math.min(parts, Math.floor(value)));
  const full = size === 'full';
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> draws one bar; this is a run of segments
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={parts}
      aria-valuenow={lit}
      aria-valuetext={`${lit} of ${parts}`}
      data-slot="led-strip"
      data-size={size}
      className={cn(
        full ? 'grid w-full' : 'inline-flex items-end gap-(--space-0_5) align-baseline',
        className,
      )}
      style={
        full
          ? { gridTemplateColumns: `repeat(${parts}, minmax(0, 1fr))`, gap: LED_FULL_GAP, ...style }
          : style
      }
      {...props}
    >
      {Array.from({ length: parts }, (_, i) => (
        <i
          // Segments are positional: the i-th part of the whole.
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its index
          key={i}
          data-slot="led-segment"
          data-lit={i < lit ? '' : undefined}
          className={cn(
            'block bg-line',
            full ? 'h-(--space-2_5)' : 'h-(--space-2)',
            full ? 'data-lit:bg-fg data-lit:shadow-[0_0_5px_var(--acc-glow)]' : 'data-lit:bg-fg2',
          )}
          style={full ? undefined : { width: LED_ROW_SEGMENT_WIDTH }}
        />
      ))}
    </span>
  );
}

export { LED_FULL_GAP, LED_ROW_SEGMENT_WIDTH, LedStrip, type LedStripProps };
