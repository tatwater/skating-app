import { Meter as MeterPrimitive } from '@base-ui/react/meter';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A kit candidate: the **threshold meter** — the kit `Meter`'s 4 px quota bar with the gate it
 * must clear drawn as a **white tick** standing over the track (the kit's `mark` is an amber
 * threshold; this one is a pass line, and passing is not a warning). Body › Imagery's two gates
 * (board 5.4.6: *Clear of cloud*, needs 60%; *Lake in the pass*, needs 50%) are its first use.
 *
 * - **One row**: the name over what it needs, the meter, the value with its unit.
 * - **A value under its gate is the bright one**: the name and the figure go to the bright ink and
 *   the fill steps back a shade — the failing figure is what the eye should find.
 * - **Not measured is absent**, never zero: an empty track, no figure, and a reader hears so.
 *
 * Tokens only; generic props — a value, a range and a threshold.
 */

/*
 * Values the token library lacks yet (the mock's, body-tab-imagery-v5.js `.gate`), set as custom
 * properties on the row so the classes read names.
 */
/** The name column: 104 px. */
const THRESHOLD_LABEL_WIDTH = '6.5rem';
/** The value column: 46 px. */
const THRESHOLD_VALUE_WIDTH = '2.875rem';

const VARS = {
  '--threshold-label-width': THRESHOLD_LABEL_WIDTH,
  '--threshold-value-width': THRESHOLD_VALUE_WIDTH,
} as CSSProperties;

type ThresholdMeterProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What is measured ("Clear of cloud"). */
  label: ReactNode;
  /** The value, in `[min, max]`; `null` when it was not measured. */
  value: number | null;
  /** The gate the value must reach. */
  threshold: number;
  min?: number;
  max?: number;
  /** The unit after the figure ("%"). */
  unit?: string;
  /** The line under the name. Default "Needs {threshold}{unit}". */
  detail?: ReactNode;
};

/** Where `v` falls on `[min, max]` as a percentage, clamped. */
export function meterPercent(v: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return Math.min(100, Math.max(0, (100 * (v - min)) / (max - min)));
}

function ThresholdMeter({
  label,
  value,
  threshold,
  min = 0,
  max = 100,
  unit = '',
  detail,
  className,
  style,
  ...props
}: ThresholdMeterProps) {
  const fails = value !== null && value < threshold;
  return (
    <div
      data-slot="threshold-meter"
      data-fails={fails ? '' : undefined}
      data-unmeasured={value === null ? '' : undefined}
      className={cn(
        'group/threshold grid grid-cols-[var(--threshold-label-width)_minmax(0,1fr)_var(--threshold-value-width)] items-center gap-x-(--space-3)',
        className,
      )}
      style={{ ...VARS, ...style }}
      {...props}
    >
      <span className="flex flex-col gap-(--space-1)">
        <span
          data-slot="threshold-label"
          className="text-assist leading-(--lead-snug) whitespace-nowrap text-fg1 group-data-fails/threshold:text-fg"
        >
          {label}
        </span>
        <span className="text-kick leading-(--lead-snug) whitespace-nowrap text-fg3">
          {detail ?? `Needs ${threshold}${unit}`}
        </span>
      </span>
      {value === null ? (
        <span data-slot="threshold-track" className="relative h-(--stroke-now) bg-line">
          <span className="sr-only">Not measured</span>
          <Tick at={meterPercent(threshold, min, max)} />
        </span>
      ) : (
        <MeterPrimitive.Root
          value={Math.min(max, Math.max(min, value))}
          min={min}
          max={max}
          getAriaValueText={() => `${value}${unit}, needs ${threshold}${unit}`}
          aria-label={typeof label === 'string' ? label : undefined}
          render={<span />}
        >
          <MeterPrimitive.Track
            data-slot="threshold-track"
            render={<span />}
            className="relative block h-(--stroke-now) bg-line"
          >
            <MeterPrimitive.Indicator
              data-slot="threshold-fill"
              render={<span />}
              className="absolute inset-y-0 left-0 bg-fg2 group-data-fails/threshold:bg-fg3"
            />
            <Tick at={meterPercent(threshold, min, max)} />
          </MeterPrimitive.Track>
        </MeterPrimitive.Root>
      )}
      <span
        data-slot="threshold-value"
        aria-hidden="true"
        className="text-right font-(family-name:--family-mono) text-mono-sm leading-none font-medium whitespace-nowrap text-fg2 tabular-nums group-data-fails/threshold:text-fg"
      >
        {value !== null && (
          <>
            {value}
            {unit !== '' && <span className="ms-[0.6em] text-fg3">{unit}</span>}
          </>
        )}
      </span>
    </div>
  );
}

/** The gate: a white tick standing over the track, three track-heights tall. */
function Tick({ at }: { at: number }) {
  return (
    <span
      data-slot="threshold-tick"
      aria-hidden="true"
      className="absolute -top-(--stroke-now) h-[calc(3*var(--stroke-now))] w-(--stroke-hair) -translate-x-1/2 bg-fg"
      style={{ left: `${at}%` }}
    />
  );
}

export { ThresholdMeter, type ThresholdMeterProps };
