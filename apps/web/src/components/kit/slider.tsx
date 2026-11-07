import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Slider: shadcn's Base UI slider, re-skinned to the boards' map-boost slider
 * (`.slider2`) — a value you scrub, never a knob with a ring.
 *
 * - **A thin track and a grippy rectangular thumb.** The track is a `stroke-note` line in `line2`,
 *   filled to the value in the second ink. The thumb is a raised, square plate a kicker and a half
 *   wide and the surface's smallest button tall, rimmed in the bright ink with its glow, three
 *   grip lines across it. Square, like every control on the console.
 * - **A slider's ticks are its stops** (`ticks`): one under the track per step, the ends and the
 *   middle taller. Base UI has no marks, so they're drawn here — only for a range with a few stops.
 * - **The value reads out in mono** at the head's right end, in a slot as wide as the longest value
 *   it can show, so the head never shifts while you drag; the ends can be labeled too.
 * - **The keyboard**: ←→ (and ↑↓) step, ⇧ with an arrow takes a big step (five stops by
 *   default), Home and End go to the ends.
 * - **Disabled** dims the fill, the rim and the grip, and the thumb loses its glow.
 * - **Optical spacing (D234)**: the thumb's box is what it draws; its pointer area grows by the
 *   hit pad (`hit`), so a thin slider is still easy to catch.
 */

type SliderProps = Omit<SliderPrimitive.Root.Props<number>, 'children'> & {
  /** The kicker over the track ("Map boost"). Also the slider's accessible name. */
  label: ReactNode;
  /** Draw a tick per stop under the track (for up to 40 stops). */
  ticks?: boolean;
  /** Label the two ends ("0" and "1") in mono beside the track. */
  ends?: boolean;
};

/** More stops than this, and ticks would be a texture, not stops. */
const MAX_TICKS = 40;

function Slider({
  className,
  label,
  ticks = false,
  ends = false,
  min = 0,
  max = 100,
  step = 1,
  largeStep,
  format,
  disabled,
  ...props
}: SliderProps) {
  // Without a format, show as many decimals as the step has, so values don't change width.
  const decimals = (String(step).split('.')[1] ?? '').length;
  const shown: Intl.NumberFormatOptions = format ?? {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  };
  const fmt = new Intl.NumberFormat(undefined, shown);
  // The ends are fixed labels, written plainly ("0" and "1", as the boards do).
  const endFmt = format
    ? fmt
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals });
  const widest = Math.max(fmt.format(min).length, fmt.format(max).length);
  const stops = Math.round((max - min) / step);
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      min={min}
      max={max}
      step={step}
      largeStep={largeStep ?? step * 5}
      format={shown}
      disabled={disabled}
      className={cn('group/slider flex w-full flex-col gap-(--space-2)', className)}
      {...props}
    >
      <div className="flex items-baseline justify-between gap-(--space-3)">
        <SliderPrimitive.Label
          data-slot="slider-label"
          className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase group-data-disabled/slider:text-fg-disabled"
        >
          {label}
        </SliderPrimitive.Label>
        <SliderPrimitive.Value
          data-slot="slider-value"
          // `ch` is the mono digit's advance: the slot holds the widest value exactly.
          style={{ minWidth: `${widest}ch` }}
          className="text-right font-(family-name:--family-mono) text-mono-sm leading-none text-fg tabular-nums group-data-disabled/slider:text-fg-disabled"
        />
      </div>
      <div className="flex items-center gap-(--space-3_5)">
        {ends && <End>{endFmt.format(min)}</End>}
        <SliderPrimitive.Control
          data-slot="slider-control"
          className="relative flex h-btn-xs min-w-0 flex-1 cursor-pointer touch-none items-center select-none group-data-disabled/slider:cursor-default"
        >
          <SliderPrimitive.Track
            data-slot="slider-track"
            className="relative h-(--stroke-note) w-full bg-line2"
          >
            <SliderPrimitive.Indicator
              data-slot="slider-fill"
              className="h-full bg-fg1 group-data-disabled/slider:bg-fg-disabled"
            />
            {ticks && stops <= MAX_TICKS && <Ticks stops={stops} />}
            <SliderPrimitive.Thumb
              data-slot="slider-thumb"
              className={cn(
                'hit flex h-btn-xs w-[calc(var(--type-kick)*1.4)] items-center justify-center gap-(--space-0_5) outline-none',
                'border border-solid border-fg bg-raise',
                'shadow-[0_0_0_3px_var(--lift-05),var(--box-shadow-glow-w)]',
                'transition-[box-shadow,border-color,background-color] duration-(--duration-fast) ease-standard',
                'has-focus-visible:shadow-focus',
                'data-dragging:bg-panel',
                'data-disabled:border-line2 data-disabled:shadow-none',
              )}
            >
              <Grip />
              <Grip />
              <Grip />
            </SliderPrimitive.Thumb>
          </SliderPrimitive.Track>
        </SliderPrimitive.Control>
        {ends && <End>{endFmt.format(max)}</End>}
      </div>
    </SliderPrimitive.Root>
  );
}

/** One grip line: a hairline a kicker tall; brightens while the thumb is held or hovered. */
function Grip() {
  return (
    <span
      aria-hidden="true"
      data-slot="slider-grip"
      className={cn(
        'h-(--type-kick) w-px bg-fg2 transition-[background-color] duration-(--duration-fast) ease-standard',
        '[@media(hover:hover)]:group-hover/slider:not-group-data-disabled/slider:bg-fg',
        'in-data-dragging:bg-fg group-data-disabled/slider:bg-line2',
      )}
    />
  );
}

/** The ticks, a `stroke-run` under the track: one per stop, the ends and the middle taller. */
function Ticks({ stops }: { stops: number }) {
  // Each tick is named by where it sits along the track (a percent), which never repeats.
  const marks = Array.from({ length: stops + 1 }, (_, i) => ({
    at: (i / stops) * 100,
    major: i === 0 || i === stops || i * 2 === stops,
  }));
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-full">
      {marks.map(({ at, major }) => (
        <span
          key={at}
          data-slot="slider-tick"
          data-major={major ? '' : undefined}
          style={{ left: `${at}%` }}
          className={cn(
            'absolute top-(--stroke-run) w-px -translate-x-1/2',
            major ? 'h-(--stroke-tick) bg-fg3' : 'h-(--stroke-now) bg-line2',
          )}
        />
      ))}
    </span>
  );
}

function End({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      data-slot="slider-end"
      className="font-(family-name:--family-mono) text-kick leading-none text-fg3"
    >
      {children}
    </span>
  );
}

export { Slider, type SliderProps };
