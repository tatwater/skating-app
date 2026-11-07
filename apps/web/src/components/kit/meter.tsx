import { Meter as MeterPrimitive } from '@base-ui/react/meter';
import { tokens } from '@skating/design';
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';

import { useReducedMotion } from '@/lib/useReducedMotion';
import { cn } from '@/lib/utils';

/**
 * The kit's Meter: Base UI's Meter (shadcn doesn't wrap it), drawn as the boards' quota bar — a
 * measurement, so `role="meter"`, never a progress bar.
 *
 * - **One height everywhere: 4 px** (`--stroke-now`), the Health quota bar. The track is the
 *   hairline ground (`line`), the fill the list-body ink (`fg2`) — a quiet gray, not a color.
 * - **Amber and red at thresholds.** `warnAt` and `badAt` (in the meter's own units) tint the fill
 *   once the value reaches them — amber waits on a person, red won't recover without one. A `mark`
 *   draws the threshold as an amber tick across the track (Machinery's 70 % line).
 * - **Labeled or bare.** `label` sets a kicker over the track; `showValue` sets the mono readout at
 *   its right. A bare meter must be named (`aria-label`) — it sits under a value that says what it is.
 * - **It never animates under reduced motion**; otherwise the fill eases on the base duration.
 *
 * `CellLoader` is the indeterminate form: seven cells that fill from the middle out.
 */

type MeterTone = 'default' | 'warn' | 'bad';

const FILL: Record<MeterTone, string> = {
  default: 'bg-fg2',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

/** The tone a value earns from its thresholds; an explicit tone wins. Exported for its test. */
function meterTone(
  value: number,
  { warnAt, badAt }: { warnAt?: number; badAt?: number },
): MeterTone {
  if (badAt !== undefined && value >= badAt) return 'bad';
  if (warnAt !== undefined && value >= warnAt) return 'warn';
  return 'default';
}

type MeterProps = Omit<MeterPrimitive.Root.Props, 'children'> & {
  /** A kicker over the track ("R2 storage"). Written capitalized; the kicker sets it in caps. */
  label?: ReactNode;
  /**
   * The mono readout at the label row's right. `true` shows Base UI's formatted value — a percent
   * of the range unless `format` says otherwise; a function renders its own from the raw value
   * (`(_, v) => \`${v} of 10 GB\``).
   */
  showValue?: boolean | ((formatted: string, value: number) => ReactNode);
  /** The value at which the fill turns amber. */
  warnAt?: number;
  /** The value at which the fill turns red. */
  badAt?: number;
  /** Forces a tone, past the thresholds. */
  tone?: MeterTone;
  /** A threshold drawn as an amber tick across the track, in the meter's units. */
  mark?: number;
};

function Meter({
  label,
  showValue = false,
  warnAt,
  badAt,
  tone,
  mark,
  min = 0,
  max = 100,
  value,
  className,
  ...props
}: MeterProps) {
  const resolved = tone ?? meterTone(value, { warnAt, badAt });
  const hasHeader = label != null || showValue !== false;
  return (
    <MeterPrimitive.Root
      data-slot="meter"
      data-tone={resolved}
      min={min}
      max={max}
      value={value}
      className={cn('flex w-full flex-col gap-(--space-1_5)', className)}
      {...props}
    >
      {hasHeader && (
        <span
          data-slot="meter-header"
          className="flex items-baseline justify-between gap-(--space-3)"
        >
          {label != null && (
            <MeterPrimitive.Label
              data-slot="meter-label"
              className="min-w-0 text-kick leading-(--lead-snug) font-semibold tracking-kick text-fg3 uppercase"
            >
              {label}
            </MeterPrimitive.Label>
          )}
          {showValue !== false && (
            <MeterPrimitive.Value
              data-slot="meter-value"
              className="ms-auto shrink-0 font-(family-name:--family-mono) text-mono-sm leading-none tracking-value whitespace-nowrap text-fg1 tabular-nums"
            >
              {typeof showValue === 'function' ? showValue : null}
            </MeterPrimitive.Value>
          )}
        </span>
      )}
      <MeterPrimitive.Track
        data-slot="meter-track"
        className="relative h-(--stroke-now) w-full bg-line"
      >
        <MeterPrimitive.Indicator
          data-slot="meter-fill"
          className={cn(
            'h-full transition-[width,background-color] duration-(--duration-base) ease-standard motion-reduce:transition-none',
            FILL[resolved],
          )}
        />
        {mark !== undefined && (
          <span
            data-slot="meter-mark"
            aria-hidden="true"
            className="absolute -top-(--stroke-run) h-[calc(var(--stroke-now)+2*var(--stroke-run))] w-(--stroke-hair) bg-warn"
            style={{ left: `${(100 * (mark - min)) / (max - min)}%` }}
          />
        )}
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  );
}

// ── The middle-out cell loader ───────────────────────────────────────────────────────────────

const CELLS = 7;
const MIDDLE = (CELLS - 1) / 2;
/** Steps in one fill: none lit, then 4, then 3–5, then 2–6, then all seven. */
const STEPS = MIDDLE + 2;

/** Whether cell `i` (0-based) is lit at `step`: the middle first, then outward a pair at a time. */
function cellLit(i: number, step: number): boolean {
  return Math.abs(i - MIDDLE) < step;
}

type CellLoaderProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** What is loading ("Loading runs"): the loader's accessible name. */
  label?: string;
};

/**
 * Something is loading and how long is unknown: seven cells (the LED segments' drawing) that fill
 * from the middle out — cell 4, then 3 and 5, then 2 and 6, then 1 and 7 — and start again, one
 * step per slow beat. Under reduced motion it holds still on the middle cell: still "working", no
 * motion. An indeterminate `progressbar` (no value), so a reader hears it once.
 */
function CellLoader({ label = 'Loading', className, ...props }: CellLoaderProps) {
  const reduced = useReducedMotion();
  const [beat, setBeat] = useState(1);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setBeat((s) => (s + 1) % STEPS), tokens.duration.slow);
    return () => window.clearInterval(id);
  }, [reduced]);
  const step = reduced ? 1 : beat;
  return (
    <span
      role="progressbar"
      aria-label={label}
      data-slot="cell-loader"
      data-step={step}
      className={cn('inline-flex items-end gap-(--space-0_5)', className)}
      {...props}
    >
      {Array.from({ length: CELLS }, (_, i) => (
        <span
          // Cells are positional: the index is the cell.
          // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its index
          key={i}
          data-slot="cell"
          data-lit={cellLit(i, step) ? '' : undefined}
          className="block h-[calc(var(--type-kick)*0.8)] w-[calc(var(--type-kick)*0.7)] bg-line data-lit:bg-fg2"
        />
      ))}
    </span>
  );
}

export { CellLoader, type CellLoaderProps, cellLit, Meter, type MeterProps, meterTone };
