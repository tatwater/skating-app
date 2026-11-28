import {
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { CellLoader } from '@/components/kit/meter';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';

import { clock } from '../corpus/runFormat';
import { axisDay, plateWhen, tookWords } from './cronFormat';
import {
  placeTicks,
  TICK_KINDS,
  type TickKind,
  type TickMark,
  tickAt,
  tickCounts,
} from './cronModel';
import type { CronTickView } from './cronViews';
import { CRON_WORDS, TICK_WORDS } from './cronWords';

/**
 * **A cron's ticks over a range** (the runs drawer's strip, boards 6.4 *Runs* and *Runs · Pump*;
 * Weather and Health reuse it) — a **kit candidate**, kit-shaped here until the governor promotes
 * it. Every recorded tick is a mark at its time:
 *
 * - **Tall where it did something, short where it had nothing to do**; a refusal amber and broken,
 *   a failure red with a square cap, a kill red with a hollow cap — the shape says it as well as
 *   the color does, and the legend draws each shape.
 * - **What the record holds, nothing more.** A cron recorded `sparse` keeps one quiet tick an hour,
 *   so its strip says so beside the axis: the gaps between its quiet marks are not missed runs. A
 *   range the read cut short (`truncated`) says that its oldest ticks aren't drawn.
 * - **Hover or arrow to a tick** for its plate: when, what it was, and how long it took — no
 *   duration where none was measured (a mutation job's is `null`, never "0 ms").
 * - **Readable without sight or color**: the strip is a focusable group named by its counts per
 *   kind; the arrow keys move from tick to tick and each one's plate is announced.
 *
 * Ticks may arrive in any order (a row is in recorded order); they are sorted here.
 */

export type CronTickStripProps = Omit<ComponentProps<'section'>, 'title'> & {
  /** The ticks, any order; `undefined` while they load. */
  ticks: readonly CronTickView[] | undefined;
  from: number;
  to: number;
  /** The read stopped before the range's oldest ticks. */
  truncated?: boolean;
  /** The cron keeps one quiet tick an hour. */
  sparse?: boolean;
  /** The range in words, capitalized ("The last 12 hours", "Since the start"). */
  label: string;
  now: number;
  timeZone?: string;
  /** More lines for a tick's plate (its run's headline), under its kind. */
  describe?: (tick: CronTickView) => readonly string[];
  /** The strip's height in px, from the board (34). */
  height?: number;
};

const TALL = 30;
const SHORT = 10;

export function CronTickStrip({
  ticks,
  from,
  to,
  truncated = false,
  sparse = false,
  label,
  now,
  timeZone,
  describe,
  height = 34,
  className,
  ...props
}: CronTickStripProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const marks = useMemo(
    () => (ticks === undefined ? [] : placeTicks(ticks, from, to, width)),
    [ticks, from, to, width],
  );
  const counts = useMemo(() => tickCounts(marks), [marks]);
  const shown = hovered === null ? null : (marks[hovered] ?? null);
  const summary = CRON_WORDS.stripSummary(
    TICK_KINDS.filter((k) => counts[k] > 0).map((k) =>
      CRON_WORDS.tickCount(counts[k], TICK_WORDS[k]),
    ),
  );
  const plate = shown === null ? null : plateLines(shown, now, timeZone, describe);
  const longRange = to - from >= 36 * 3_600_000;
  const fromWords = longRange ? axisDay(from, timeZone) : clock(from, timeZone);
  const toWords =
    Math.abs(now - to) < 60_000
      ? CRON_WORDS.now
      : longRange
        ? axisDay(to, timeZone)
        : clock(to, timeZone);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = tickAt(marks, e.clientX - rect.left);
    setHovered(hit === null ? null : marks.indexOf(hit));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (marks.length === 0) return;
    const last = marks.length - 1;
    const step: Record<string, number | undefined> = {
      ArrowRight: 1,
      ArrowLeft: -1,
    };
    let next: number | null = null;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape' && hovered !== null) next = -1;
    else if (step[e.key] !== undefined) {
      const d = step[e.key] as number;
      next = hovered === null ? (d > 0 ? 0 : last) : Math.min(last, Math.max(0, hovered + d));
    }
    if (next === null) return;
    e.preventDefault();
    if (e.key === 'Escape') e.stopPropagation();
    setHovered(next < 0 ? null : next);
  };

  return (
    <Section
      title={label}
      end={<Legend />}
      data-slot="cron-tick-strip"
      className={cn('min-w-0', className)}
      {...props}
    >
      <div className="relative">
        <div
          ref={box}
          data-slot="cron-tick-marks"
          data-loading={ticks === undefined ? '' : undefined}
          className="relative w-full border-b border-solid border-line2"
          style={{ height }}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHovered(null)}
        >
          {ticks === undefined ? (
            <span className="absolute inset-0 flex items-center">
              <CellLoader label={CRON_WORDS.loadingOlder} />
            </span>
          ) : (
            width > 0 && (
              <svg
                aria-hidden="true"
                width={width}
                height={height}
                className="absolute inset-0 overflow-visible"
              >
                {marks.map((m, i) => (
                  <Mark key={m.at * 8 + m.code} mark={m} height={height} hovered={i === hovered} />
                ))}
                {shown !== null && (
                  <rect
                    data-slot="cron-tick-hair"
                    x={shown.x}
                    y={-6}
                    width={1}
                    height={height + 12}
                    className="fill-fg2"
                  />
                )}
              </svg>
            )
          )}
          {ticks !== undefined && marks.length === 0 && (
            <span
              data-slot="cron-tick-empty"
              className="absolute bottom-(--space-1_5) left-0 text-assist leading-none text-fg3"
            >
              {CRON_WORDS.stripEmpty}
            </span>
          )}
          {/* The strip's one stop: named by its counts, its arrows step from tick to tick. */}
          <button
            type="button"
            data-slot="cron-tick-focus"
            aria-label={`${CRON_WORDS.stripLabel(label)}: ${summary}`}
            className="absolute inset-0 cursor-default border-0 bg-transparent p-0 outline-none focus-visible:shadow-focus"
            onKeyDown={onKeyDown}
            onBlur={() => setHovered(null)}
          />
        </div>
        {plate !== null && shown !== null && <TickPlate lines={plate} x={shown.x} width={width} />}
        <p aria-live="polite" className="sr-only">
          {plate === null ? '' : plate.join('. ')}
        </p>
        <div
          data-slot="cron-tick-axis"
          className="flex items-baseline justify-between gap-(--space-3) pt-(--space-1_5) font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
        >
          <span data-slot="cron-tick-from">{fromWords}</span>
          {(truncated || sparse) && (
            <span
              data-slot="cron-tick-note"
              className="min-w-0 truncate font-(family-name:--family-sans) normal-case tracking-normal"
            >
              {truncated ? CRON_WORDS.stripTruncated : CRON_WORDS.sparseStrip}
            </span>
          )}
          <span data-slot="cron-tick-to">{toWords}</span>
        </div>
      </div>
    </Section>
  );
}

/** A tick's plate: when, then what it was and how long it took, then the caller's lines. */
function plateLines(
  m: TickMark,
  now: number,
  timeZone: string | undefined,
  describe: CronTickStripProps['describe'],
): string[] {
  const more = describe?.(m) ?? [];
  return [
    plateWhen(m.at, now, timeZone),
    ...(more.length > 0 ? more : [TICK_WORDS[m.kind]]),
    ...(m.ms === null ? [] : [CRON_WORDS.took(tookWords(m.ms))]),
  ];
}

const FILL: Record<TickKind, string> = {
  quiet: 'fill-line2',
  worked: 'fill-fg2',
  refused: 'fill-warn',
  failed: 'fill-bad',
  killed: 'fill-bad',
};

/** One tick's mark, in its kind's shape. */
function Mark({
  mark,
  height,
  hovered,
  tallH = TALL,
  shortH = SHORT,
  legend = false,
}: {
  mark: TickMark;
  height: number;
  hovered: boolean;
  tallH?: number;
  shortH?: number;
  /** A legend's swatch: no slot, so it isn't counted among the strip's ticks. */
  legend?: boolean;
}) {
  const tall = mark.kind !== 'quiet';
  const h = tall ? tallH : shortH;
  const w = hovered ? 3 : 1;
  const x = hovered ? mark.x - 1 : mark.x;
  const y = height - h;
  const common = {
    'data-slot': legend ? 'cron-tick-swatch' : 'cron-tick',
    'data-kind': mark.kind,
    'data-at': mark.at,
    className: FILL[mark.kind],
  };
  if (mark.kind === 'refused') {
    // Broken: four on, two off, from the foot up.
    const dashes: number[] = [];
    for (let top = height - 4; top > y - 4; top -= 6) dashes.push(top);
    return (
      <g {...common}>
        {dashes.map((top) => (
          <rect key={top} x={x} y={Math.max(y, top)} width={w} height={Math.min(4, top + 4 - y)} />
        ))}
      </g>
    );
  }
  if (mark.kind === 'failed' || mark.kind === 'killed') {
    return (
      <g {...common}>
        <rect x={x} y={y} width={w} height={h} />
        {mark.kind === 'failed' ? (
          <rect x={mark.x - 1} y={y - 3} width={3} height={3} />
        ) : (
          <rect
            x={mark.x - 2}
            y={y - 5}
            width={5}
            height={5}
            className="fill-none stroke-bad"
            strokeWidth={1}
          />
        )}
      </g>
    );
  }
  return <rect {...common} x={x} y={y} width={w} height={h} />;
}

/** The hover plate, beside its tick: right of it, or left near the strip's right edge. */
function TickPlate({ lines, x, width }: { lines: readonly string[]; x: number; width: number }) {
  const [when, ...rest] = lines;
  const right = x > width - 240;
  return (
    <div
      data-slot="cron-tick-plate"
      aria-hidden="true"
      className="pointer-events-none absolute -top-(--space-1_5) z-2 flex flex-col gap-(--space-1_5) border border-solid border-line2 bg-plate-solid px-(--space-3) pt-(--space-2_5) pb-(--space-2_5) whitespace-nowrap shadow-plate"
      style={right ? { right: width - x + 10 } : { left: x + 10 }}
    >
      <span className="mb-(--space-0_5) text-kick leading-none font-medium tracking-head text-fg uppercase">
        {when}
      </span>
      {rest.map((l) => (
        <span key={l} className="text-assist leading-snug text-fg2">
          {l}
        </span>
      ))}
    </div>
  );
}

/** The legend: each kind's mark, in its shape, with its words. */
function Legend() {
  return (
    <span
      data-slot="cron-tick-legend"
      className="flex items-center gap-(--space-4) text-kick leading-none font-medium tracking-label text-fg3 uppercase"
    >
      {TICK_KINDS.map((k) => (
        <span key={k} className="inline-flex items-center gap-(--space-1_5)">
          <Swatch kind={k} />
          {TICK_WORDS[k]}
        </span>
      ))}
    </span>
  );
}

function Swatch({ kind }: { kind: TickKind }) {
  return (
    <svg aria-hidden="true" width={7} height={12} className="shrink-0 overflow-visible">
      <Mark
        mark={{ at: 0, code: 0, ms: null, kind, x: 3 }}
        height={12}
        hovered={false}
        tallH={kind === 'failed' || kind === 'killed' ? 7 : 10}
        shortH={4}
        legend
      />
    </svg>
  );
}
