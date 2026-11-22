import { Meter as MeterPrimitive } from '@base-ui/react/meter';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Kit candidate: **the overlap gauge** (the Inbox's 2.5, `.ovl`) — how much of one shape lies inside
 * another, as a share read against the threshold past which something is suggested.
 *
 * - **The figure on the left**: the share as a whole percent in the stat's mono (`text-stat`), its
 *   unit after it, and under it what the share is of ("Of the drawing is Caspian Lake").
 * - **The gauge on the right**: the meter's 4 px track (`--stroke-now`), filled in the field's ink
 *   to the share; the threshold a tick across it, with its label over the track ending on the tick
 *   ("Merge suggested from 80 %"); the scale's two ends under it. The threshold's label is lit
 *   (`fg`) once the share has reached it (`reached`), quiet (`fg3`) short of it.
 * - **The number is the caller's**: `share` is drawn as given, floored to a whole percent so the
 *   readout never claims a share it doesn't have (79.9 % reads "79", never "80" beside the 80 %
 *   tick). Whether the threshold is reached is the caller's to say (`reached`) — the server's
 *   answer, never re-decided from the rounded figure.
 * - **A meter, never a progress bar** (`role="meter"`, Base UI's Meter): a reader hears the
 *   percentage and the sub-line as its name.
 * - **Narrow**: under 26 rem of its own width the figure stacks over the gauge (a container query),
 *   so the scale keeps its room on a phone's page.
 *
 * Tokens only; the words are props (the handler's), so it is promoted unchanged.
 */

type OverlapGaugeProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The share inside, 0–1 (clamped to it). */
  share: number;
  /** The threshold, 0–1: the tick, and where its label ends. */
  threshold: number;
  /** Whether the share has reached the threshold (the caller's answer). Lights the label. */
  reached: boolean;
  /** What the share is of, under the figure ("Of the drawing is Caspian Lake"). */
  sub: ReactNode;
  /** The threshold's label over the track ("Merge suggested from 80 %"). */
  thresholdLabel: ReactNode;
  /** The scale's ends under the track. */
  minLabel?: ReactNode;
  maxLabel?: ReactNode;
  /** The unit after the figure. */
  unit?: ReactNode;
};

/**
 * A share as a whole percent, floored — exported for its property test. Rounded to a millionth
 * first, so a share a float renders as 0.57 → 56.999… still reads 57.
 */
function sharePercent(share: number): number {
  if (!Number.isFinite(share)) return 0;
  const clamped = Math.min(1, Math.max(0, share));
  return Math.floor(Math.round(clamped * 1_000_000) / 10_000);
}

const pct = (v: number) => `${Math.min(100, Math.max(0, v * 100))}%`;

/** The scale's ends: on the baseline of the sub-line beside them (the board's 34 px, a token sum). */
const ENDS = { top: 'calc(var(--space-8) + var(--space-0_5))' } as const;

const LABEL =
  'absolute text-kick leading-none font-semibold tracking-kick whitespace-nowrap uppercase';

function OverlapGauge({
  share,
  threshold,
  reached,
  sub,
  thresholdLabel,
  minLabel = '0 %',
  maxLabel = '100 %',
  unit = '%',
  className,
  ...props
}: OverlapGaugeProps) {
  const figure = sharePercent(share);
  return (
    <div data-slot="overlap-gauge" className={cn('@container', className)} {...props}>
      <MeterPrimitive.Root
        value={figure}
        min={0}
        max={100}
        className="grid grid-cols-1 items-end gap-(--space-4) @[26rem]:grid-cols-[10.625rem_minmax(0,1fr)] @[26rem]:gap-(--space-6)"
      >
        <div className="flex min-w-0 flex-col gap-(--space-1_5)">
          <span
            data-slot="overlap-gauge-value"
            className="font-(family-name:--family-mono) text-stat leading-none font-medium whitespace-nowrap text-fg"
          >
            <span className="tracking-value tabular-nums">{figure}</span>
            <span className="ms-unit text-row font-light tracking-normal text-fg3">{unit}</span>
          </span>
          <MeterPrimitive.Label
            data-slot="overlap-gauge-sub"
            className="text-assist leading-list text-fg3"
          >
            {sub}
          </MeterPrimitive.Label>
        </div>
        <div
          data-slot="overlap-gauge-scale"
          className="relative"
          // The board's 46 px: the label row, the track, the ends (a token sum; inline, since a
          // class's arbitrary value reads a token's `_` as a space).
          style={{ height: 'calc(var(--space-10) + var(--space-1_5))' }}
        >
          <span
            data-slot="overlap-gauge-threshold"
            data-reached={reached ? '' : undefined}
            className={cn(LABEL, 'top-0 text-fg3 data-reached:text-fg')}
            style={{ right: pct(1 - threshold) }}
          >
            {thresholdLabel}
          </span>
          <MeterPrimitive.Track
            data-slot="overlap-gauge-track"
            className="absolute inset-x-0 top-(--space-5) h-(--stroke-now) bg-line"
          >
            <MeterPrimitive.Indicator data-slot="overlap-gauge-fill" className="h-full bg-fg" />
          </MeterPrimitive.Track>
          <span
            data-slot="overlap-gauge-tick"
            aria-hidden="true"
            className="absolute top-(--space-3_5) h-(--space-4) w-(--stroke-hair) bg-fg2"
            style={{ left: pct(threshold) }}
          />
          <span className={cn(LABEL, 'start-0 text-fg3')} style={ENDS}>
            {minLabel}
          </span>
          <span className={cn(LABEL, 'end-0 text-fg3')} style={ENDS}>
            {maxLabel}
          </span>
        </div>
      </MeterPrimitive.Root>
    </div>
  );
}

export { OverlapGauge, type OverlapGaugeProps, sharePercent };
