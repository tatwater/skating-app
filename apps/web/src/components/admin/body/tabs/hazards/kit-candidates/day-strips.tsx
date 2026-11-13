import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A kit candidate: **day strips** — a few series on one day axis, stacked, each a baseline with a
 * bar per day (a step per count), the months under the last. Body › Hazards' empty winter is its
 * first use (board 5.4.7: this winter so far, bare, over last winter's record — the same months a
 * year apart).
 *
 * - **A day that hasn't happened is `null`**: the baseline goes dotted from the last real day on,
 *   and no bar is drawn — never a zero. A real zero is the solid baseline with nothing on it.
 * - **Marks on a strip**: `today` (a bright tick and the word, on the strip that has one) and
 *   `opens` (a short tick where something began, the watch's opening).
 * - **Values on hover are the caller's** (no plate here): the strip is a picture of a season's
 *   shape; a reader hears each strip's label and its total.
 *
 * Tokens only (ink by `fill`/`stroke` custom properties); the geometry is the SVG's own units.
 */

export type DayStrip = {
  key: string;
  /** The strip's name in the label column ("2026–27"). */
  label: string;
  /** One value per day of the axis; `null` where the day hasn't happened. */
  values: readonly (number | null)[];
  /** Brighter label and baseline: the strip being read now. */
  current?: boolean;
  /** The day index of today, marked with a tick and the word. */
  today?: number;
  /** The day index something opened on, marked with a short tick. */
  opens?: number;
  /** What a reader hears for the strip ("No hazards marked yet"). Default: its total. */
  summary?: string;
};

type DayStripsProps = Omit<ComponentProps<'svg'>, 'children'> & {
  strips: readonly DayStrip[];
  /** Month ticks under the last strip: day index and label ("OCT"). */
  months: readonly { at: number; label: string }[];
  /** The days on the axis. */
  days: number;
  /** The word on the today tick. Default "Today". */
  todayLabel?: string;
};

/*
 * The strips' geometry, in the SVG's own units (the mock's, body-tab-hazards-v5.js `twoWinters`):
 * one-off measures the token library has no names for.
 */
/** The drawing's width; it scales to its box. */
const STRIPS_WIDTH = 340;
/** The label column. */
const STRIPS_LABEL = 58;
/** From one strip's baseline to the next. */
const STRIPS_PITCH = 30;
/** The first baseline, from the top. */
const STRIPS_TOP = 14;
/** One count's step. */
const STRIPS_STEP = 3;
/** Room under the last baseline for the months. */
const STRIPS_FOOT = 18;

/** The x of day `i` on an axis of `days`. */
export function dayX(i: number, days: number): number {
  const w = STRIPS_WIDTH - STRIPS_LABEL;
  return STRIPS_LABEL + (days <= 0 ? 0 : (i * w) / days);
}

/** The last day with a value, or -1. */
export function lastReal(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

const MONO = 'font-(family-name:--family-mono)';

function DayStrips({
  strips,
  months,
  days,
  todayLabel = 'Today',
  className,
  ...props
}: DayStripsProps) {
  const height = STRIPS_TOP + (strips.length - 1) * STRIPS_PITCH + STRIPS_FOOT;
  const dx = (STRIPS_WIDTH - STRIPS_LABEL) / Math.max(1, days);
  const lastBase = STRIPS_TOP + (strips.length - 1) * STRIPS_PITCH;
  return (
    <svg
      data-slot="day-strips"
      viewBox={`0 0 ${STRIPS_WIDTH} ${height}`}
      role="img"
      aria-label={strips
        .map(
          (s) =>
            `${s.label}: ${s.summary ?? `${s.values.reduce<number>((a, v) => a + (v ?? 0), 0)} in all`}`,
        )
        .join('; ')}
      className={cn('block h-auto w-full overflow-visible', className)}
      {...props}
    >
      {strips.map((s, k) => {
        const base = STRIPS_TOP + k * STRIPS_PITCH + 0.5;
        const real = lastReal(s.values);
        const solidTo = real < 0 ? STRIPS_LABEL : dayX(real + 1, days);
        return (
          <g key={s.key} data-slot="day-strip" data-current={s.current ? '' : undefined}>
            <text
              x={0}
              y={base - 0.5}
              className={cn(MONO, 'text-kick', s.current ? 'fill-fg1' : 'fill-fg3')}
            >
              {s.label}
            </text>
            <line
              data-slot="day-strip-base"
              x1={STRIPS_LABEL}
              x2={solidTo}
              y1={base}
              y2={base}
              className={s.current ? 'stroke-fg2' : 'stroke-line2'}
            />
            {solidTo < STRIPS_WIDTH && (
              <line
                data-slot="day-strip-ahead"
                x1={solidTo}
                x2={STRIPS_WIDTH}
                y1={base}
                y2={base}
                strokeDasharray="1 3"
                className="stroke-fg3"
              />
            )}
            {s.values.map((v, i) =>
              v === null || v <= 0 ? null : (
                <rect
                  // A day is its index.
                  // biome-ignore lint/suspicious/noArrayIndexKey: a bar is its day
                  key={i}
                  data-slot="day-strip-bar"
                  x={dayX(i, days) + 0.2}
                  y={base - 0.5 - v * STRIPS_STEP}
                  width={Math.max(0.4, dx - 0.4)}
                  height={v * STRIPS_STEP}
                  className="fill-fg3"
                />
              ),
            )}
            {s.opens !== undefined && (
              <line
                data-slot="day-strip-opens"
                x1={dayX(s.opens, days)}
                x2={dayX(s.opens, days)}
                y1={base - 4.5}
                y2={base - 0.5}
                className="stroke-fg2"
              />
            )}
            {s.today !== undefined && (
              <g data-slot="day-strip-today">
                <rect
                  x={dayX(s.today + 1, days) - 1}
                  y={base - 9.5}
                  width={2}
                  height={10}
                  className="fill-fg"
                />
                <text
                  x={dayX(s.today + 1, days) + 6}
                  y={base - 3.5}
                  className={cn(MONO, 'fill-fg text-kick uppercase')}
                >
                  {todayLabel}
                </text>
              </g>
            )}
          </g>
        );
      })}
      {months.map((m) => (
        <g key={m.at} data-slot="day-strip-month">
          <line
            x1={dayX(m.at, days)}
            x2={dayX(m.at, days)}
            y1={lastBase + 1}
            y2={lastBase + 5}
            className="stroke-fg3"
          />
          <text
            x={dayX(m.at, days) + 3}
            y={lastBase + 15}
            className={cn(MONO, 'fill-fg3 text-kick')}
          >
            {m.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export { DayStrips, type DayStripsProps };
