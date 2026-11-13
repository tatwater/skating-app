import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate** — the LED row: a measurement in whole parts, one segment per part, lit for each
 * part that is there (the boards' `.led`). Where the kit's `Meter` is a continuous quota bar, this
 * counts things — *Complete · 9 / 10* — so a reader sees which part is missing, not just how much.
 *
 * - **Spans its column** (Review 12 #6): the segments share the width evenly, a hair apart.
 * - **Lit is the bright ink with its glow; missing is the hairline ground; unknown is dashed** —
 *   a part nobody can say about yet is drawn as absent, never as missing (and never as zero).
 * - A note that belongs to the row (`children`) hangs 2 px inside its ends.
 * - `role="meter"`: a reader hears the count, the label naming it.
 *
 * Board: 5.4.1 Body | Shape (the completeness lane); 5.1–5.3 Bodies' completeness column.
 */

export type SegmentState = 'on' | 'off' | 'unknown';

type SegmentMeterProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** One state per segment, in order. */
  segments: readonly SegmentState[];
  /** The kicker over the row ("Complete · 9 / 10"). Also the meter's name. */
  label: ReactNode;
  /** What hangs under the row (the amber note of what's missing). */
  children?: ReactNode;
};

function SegmentMeter({ segments, label, children, className, ...props }: SegmentMeterProps) {
  const on = segments.filter((s) => s === 'on').length;
  const labelId = useId();
  return (
    <div
      data-slot="segment-meter"
      className={cn('flex min-w-0 flex-col gap-(--space-1_5)', className)}
      {...props}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: `<meter>` draws its own bar; this one is the LED row */}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={segments.length}
        aria-valuenow={on}
        aria-valuetext={`${on} of ${segments.length}`}
        aria-labelledby={labelId}
        className="flex flex-col gap-(--space-1_5)"
      >
        <span
          id={labelId}
          data-slot="segment-meter-label"
          className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
        >
          {label}
        </span>
        <span
          aria-hidden="true"
          data-slot="segment-meter-row"
          className="grid w-full gap-[0.1875rem]"
          style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
        >
          {segments.map((state, i) => (
            <i
              // Segments are positional: the index is the part.
              // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its index
              key={i}
              data-slot="segment"
              data-state={state}
              className={cn(
                'block h-[calc(var(--type-kick)*0.8)]',
                state === 'on' && 'bg-fg shadow-glow-w',
                state === 'off' && 'bg-line',
                state === 'unknown' && 'border border-dashed border-line2 bg-transparent',
              )}
            />
          ))}
        </span>
      </div>
      {children != null && <div className="mx-(--space-0_5)">{children}</div>}
    </div>
  );
}

export { SegmentMeter, type SegmentMeterProps };
