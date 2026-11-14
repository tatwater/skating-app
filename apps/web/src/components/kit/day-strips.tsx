import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Day strips** — a few series on one day axis, a baseline with a bar per day and the months under
 * the last (the Hazards tab's winters), with what an entry whose span isn't recorded needs: a mark
 * on the one day it began. A strip with no marks is drawn as plain day strips.
 *
 * - **A day's known count is the solid bar**, a step per count, as in the kit: an entry whose span
 *   is known is a bar on every day of it.
 * - **An entry whose span isn't recorded is one mark, on the day it was first reported** — a block
 *   a step tall with a gap above, stacked on that day's bar, brighter than it — and nothing on the
 *   days after: no tower of "may have been" days. A mark with nothing after it must not read as an
 *   end, so whenever a mark is drawn the strips carry their `caption`, which says what a mark is
 *   and that how long it lasted isn't recorded; a day's words say the rest.
 * - **The step shrinks to fit, never the count.** A strip whose tallest day would climb into the
 *   strip above draws every bar of that strip on a smaller step, so each day keeps its proportion;
 *   a reader hears the numbers, not the heights. On a step too small for a block to read, a day's
 *   marks are one brighter bar of the same height, which counts them all.
 *   However small the step, a marked day's bar is never thinner than {@link MIN_MARK}, so a day
 *   that holds a hazard never reads as empty beside a much taller one.
 *   The first strip has nothing above it but the page, so the drawing grows upward to hold it.
 * - **A day that hasn't happened is `null`**: the baseline goes dotted from the last real day on,
 *   and nothing is drawn — never a zero.
 * - **Each marked day carries its words** (`dayTitle`), as an SVG title a pointer or a reader finds.
 *
 * Tokens only (ink by `fill`/`stroke` classes); the geometry is the SVG's own units, the kit's.
 */

export type DayStrip = {
  key: string;
  /** The strip's name in the label column ("2026–27"). */
  label: string;
  /** The known count per day of the axis; `null` where the day hasn't happened. */
  values: readonly (number | null)[];
  /**
   * Entries first reported each day whose span isn't recorded: one mark each, on that day only.
   * Absent: none.
   */
  marks?: readonly number[];
  /**
   * How many more each day may have held, beside its known count. **Never drawn** — a day of these
   * alone is no bar and no mark — but such a day keeps its words: an unseen target carries its
   * `dayTitle`, so a pointer or a reader still finds what it may have held. Absent: none.
   */
  unknown?: readonly number[];
  /** Brighter label and baseline: the strip being read now. */
  current?: boolean;
  /** The day index of today, marked with a tick and the word. */
  today?: number;
  /** The day index something opened on, marked with a short tick. */
  opens?: number;
  /** What a reader hears for the strip. Default: its known total. */
  summary?: string;
  /** A marked day's words ("2 reported on the lake, 1 first reported this day"), its title. */
  dayTitle?: (day: number) => string;
};

type DayStripsProps = Omit<ComponentProps<'svg'>, 'children'> & {
  strips: readonly DayStrip[];
  /** Month ticks under the last strip: day index and label ("OCT"). */
  months: readonly { at: number; label: string }[];
  /** The days on the axis. */
  days: number;
  /** The word on the today tick. Default "Today". */
  todayLabel?: string;
  /**
   * What a mark is, drawn under the strips whenever any strip carries one — so a mark with nothing
   * after it never stands without the words that say it isn't an end. Required with marks.
   */
  caption?: string;
};

/* The kit's geometry (`day-strips.tsx`), in the SVG's own units. */
const STRIPS_WIDTH = 340;
const STRIPS_LABEL = 58;
const STRIPS_PITCH = 30;
const STRIPS_TOP = 14;
const STRIPS_STEP = 3;
const STRIPS_FOOT = 18;
/** The tallest a day may climb before the strip's step shrinks: clear of the strip above. */
const STRIPS_HEADROOM = STRIPS_PITCH - 6;
/** The gap over each mark, as a share of its step. */
const MARK_GAP = 1 / 3;
/** The smallest step marks are drawn on block by block; below it, one bar a day counts them. */
const MARK_BLOCK_STEP = 1.5;
/**
 * The least height a marked day's known bar, or its one bar of marks, is drawn at: on a step shrunk
 * for a very tall day, one hazard's share would otherwise be a sliver no one can see, and a day
 * that holds a hazard would read as an empty one.
 */
export const MIN_MARK = 1;

/** One day's known count and marks, as the strip draws them, and its unknown part, which it doesn't. */
export function dayParts(
  strip: DayStrip,
  day: number,
): { known: number; marks: number; unknown: number } | null {
  const v = strip.values[day];
  if (v === null || v === undefined) return null;
  return {
    known: Math.max(0, v),
    marks: Math.max(0, strip.marks?.[day] ?? 0),
    unknown: Math.max(0, strip.unknown?.[day] ?? 0),
  };
}

/** Does any strip carry a mark on a day it draws — the caption's rule. */
export function anyMark(strips: readonly DayStrip[]): boolean {
  return strips.some((s) => s.values.some((_, i) => (dayParts(s, i)?.marks ?? 0) > 0));
}

/** A strip's tallest day, known and marks together. */
function tallestDay(strip: DayStrip): number {
  let tallest = 0;
  for (let i = 0; i < strip.values.length; i++) {
    const p = dayParts(strip, i);
    if (p !== null) tallest = Math.max(tallest, p.known + p.marks);
  }
  return tallest;
}

/** The step a strip draws on: the kit's, or smaller when its tallest day would leave its room. */
export function stripStep(strip: DayStrip): number {
  const tallest = tallestDay(strip);
  return tallest * STRIPS_STEP <= STRIPS_HEADROOM ? STRIPS_STEP : STRIPS_HEADROOM / tallest;
}

/** How far the first strip's tallest day climbs above the drawing's top edge: the room it needs. */
export function roomAbove(strips: readonly DayStrip[]): number {
  const first = strips[0];
  if (first === undefined) return 0;
  return Math.max(0, tallestDay(first) * stripStep(first) - STRIPS_TOP);
}

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
  caption,
  className,
  ...props
}: DayStripsProps) {
  const room = roomAbove(strips);
  const height = STRIPS_TOP + (strips.length - 1) * STRIPS_PITCH + STRIPS_FOOT;
  const dx = (STRIPS_WIDTH - STRIPS_LABEL) / Math.max(1, days);
  const lastBase = STRIPS_TOP + (strips.length - 1) * STRIPS_PITCH;
  const width = Math.max(0.4, dx - 0.4);
  const marked = anyMark(strips);
  return (
    <>
      <svg
        data-slot="day-strips"
        viewBox={`0 ${-room} ${STRIPS_WIDTH} ${height + room}`}
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
          const step = stripStep(s);
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
              {s.values.map((_, i) => {
                const p = dayParts(s, i);
                if (p === null || p.known + p.marks + p.unknown === 0) return null;
                const x = dayX(i, days) + 0.2;
                const title = s.dayTitle?.(i);
                if (p.known + p.marks === 0) {
                  // Nothing to draw, but the day keeps its words where a pointer can find them.
                  return (
                    <g
                      // biome-ignore lint/suspicious/noArrayIndexKey: a day is its index
                      key={i}
                      data-slot="day-strip-day"
                      data-day={i}
                      data-known={0}
                      data-unknown={p.unknown}
                    >
                      {title !== undefined && <title>{title}</title>}
                      <rect
                        data-slot="day-strip-target"
                        x={x}
                        y={base - 0.5 - STRIPS_STEP * 2}
                        width={width}
                        height={STRIPS_STEP * 2}
                        className="fill-transparent"
                      />
                    </g>
                  );
                }
                // A marked day is never drawn thinner than a mark can be seen.
                const knownHeight = p.known > 0 ? Math.max(p.known * step, MIN_MARK) : 0;
                const marksHeight = Math.max(p.marks * step, MIN_MARK);
                const top = base - 0.5 - knownHeight;
                return (
                  <g
                    // A day is its index.
                    // biome-ignore lint/suspicious/noArrayIndexKey: a day is its index
                    key={i}
                    data-slot="day-strip-day"
                    data-day={i}
                    data-known={p.known}
                    data-marks={p.marks > 0 ? p.marks : undefined}
                    data-unknown={p.unknown > 0 ? p.unknown : undefined}
                  >
                    {title !== undefined && <title>{title}</title>}
                    {p.known > 0 && (
                      <rect
                        data-slot="day-strip-bar"
                        x={x}
                        y={top}
                        width={width}
                        height={knownHeight}
                        className="fill-fg3"
                      />
                    )}
                    {step >= MARK_BLOCK_STEP
                      ? Array.from({ length: p.marks }, (_, u) => (
                          <rect
                            // A mark is its place in the stack.
                            // biome-ignore lint/suspicious/noArrayIndexKey: a mark is its place
                            key={u}
                            data-slot="day-strip-mark"
                            x={x}
                            y={top - (u + 1) * step}
                            width={width}
                            height={step * (1 - MARK_GAP)}
                            className="fill-fg1"
                          />
                        ))
                      : p.marks > 0 && (
                          <rect
                            data-slot="day-strip-mark"
                            data-count={p.marks}
                            x={x}
                            y={top - marksHeight}
                            width={width}
                            height={marksHeight}
                            className="fill-fg1"
                          />
                        )}
                  </g>
                );
              })}
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
      {marked && caption !== undefined && (
        <p
          data-slot="day-strips-caption"
          className="m-0 text-assist leading-(--lead-list) text-fg3"
        >
          {caption}
        </p>
      )}
    </>
  );
}

export { DayStrips, type DayStripsProps };
