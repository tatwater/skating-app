import { type ComponentProps, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { LineChart, useMargin, usePlotArea, useXAxisScale, useYAxisScale } from 'recharts';

import { dayLabel } from '@/components/admin/metrics/metricsModel';
import { SpanTag } from '@/components/admin/metrics/metricsParts';
import { useColumnsFit } from '@/components/admin/shell/columnsFit';
import {
  type ChartConfig,
  ChartContainer,
  ChartLine,
  ChartRule,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from '@/components/kit/chart';
import { ChartLegend, ChartNote, type LegendItem } from '@/components/kit/chart-legend';
import { MatrixChart, MatrixLegend, type MatrixTrack } from '@/components/kit/matrix-chart';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import { spreadLabels } from '@/components/kit/trace-chart';
import { cn } from '@/lib/utils';

import {
  type LowsEvent,
  type LowsState,
  type LowsTone,
  type LowsView,
  placeEventWords,
  type WordsPlace,
} from './sentinelLowsModel';
import {
  LOWS_FAILED,
  LOWS_LAND_HERE,
  LOWS_NOT_RECORDED,
  LOWS_TITLE,
  LOWS_UNIT,
  lowsChartLabel,
  lowsMatrixLabel,
  recordBeginsWords,
} from './sentinelWords';

/**
 * **Overnight Lows at the Sentinels** (B01-2b) — the Seasons board's row, on the Overview's Home: each
 * sentinel's overnight low a night this season as a line (the board's white, `g6`, `g5`), the watch's
 * freezing line (dashed, faint) and the imagery line (dashed, amber), the two nights the season record
 * marks (a rule, its words, a ⊗ on each sentinel the record named), each line's end label; and under
 * it the same lows as the kit's temperature matrix with its scale.
 *
 * ⚠ **Air temperature at named sites, never ice (D3).** The lines are the watch's thresholds, named
 * for the watch; the scale is the kit's reading, the same in every theme; nothing here says a lake
 * froze or will.
 *
 * - **Four answers** (`LowsState`): on its way (the frame, its box held), failed (a note with Try
 *   again), nothing recorded (before the season's floor: *Record begins 1 Oct*; after it with nothing
 *   stored: *Not recorded yet*) and the lows. Every one keeps the same box, so the page doesn't move.
 * - **A gap is a gap**: no line across it, an empty cell, never zero.
 * - **One night, one column**: the x axis gives each night a band and draws its point at the band's
 *   center; the matrix's cells are pinned to the plot (`track`), so each cell sits under its night.
 * - **Readable without color**: the cells are color alone, but every cell is in the matrix's grid
 *   with its night, its sentinel and its value spoken, and its plate says the value on hover.
 * - **Narrow** (`useColumnsFit`, the console's rule): below the chart and its end labels' width, the
 *   end labels go and the matrix's names move left, the plot making room for them beside the y axis;
 *   nothing scrolls sideways.
 */

/** The board's plot height (158 px), and the room the event words take over it. */
const CHART_HEIGHT = 'h-[9.875rem]';
const EVENT_ROOM = 18;
/** A second line of the marked nights' words. */
const WORDS_LINE = 12;
/** The room the end labels take right of the plot (the board's 126 px), wide. */
const END_GUTTER = 120;
/** The widths the chart needs to keep its end labels (the console's tokens). */
const WIDE_TOKENS = ['--size-list', '--size-inspector'] as const;
/**
 * A marked night's words, per character, until they are measured as drawn: the mono kicker's advance
 * and its tracking (10 px type). The face lands late and its advance isn't this everywhere, so the
 * chart measures the words it drew and places them again on that (`onCharPx`).
 */
const WORDS_CHAR_PX = 8.3;
/** The plot's right room, narrow (no end labels). */
const NARROW_GUTTER = 8;
/** The plot's left rule (`border-s`): the SVG starts this far into the row. */
const PLOT_EDGE = 1;
/** The matrix's names and their gap until measured: the kit's 3.75 rem kicker column and its gap. */
const KICKER_ROOM = 70;

const TONE_INK: Record<LowsTone, string> = {
  lead: 'var(--fg)',
  muted: 'var(--fg2)',
  faint: 'var(--fg3)',
};

type SentinelLowsProps = Omit<ComponentProps<'section'>, 'children'> & { state: LowsState };

export function SentinelLows({ state, className, ...props }: SentinelLowsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useColumnsFit(ref, WIDE_TOKENS);
  const view = state.kind === 'value' ? state.view : null;
  return (
    <Section
      data-slot="sentinel-lows"
      data-state={state.kind}
      title={LOWS_TITLE}
      end={<SpanTag>{view === null ? LOWS_UNIT : `${LOWS_UNIT} · ${view.period}`}</SpanTag>}
      className={className}
      {...props}
    >
      {/* The row keeps the board's box in every answer, so nothing under it moves as it lands. */}
      <div ref={ref} data-slot="sentinel-lows-body" className="relative min-h-[16.5625rem] min-w-0">
        {state.kind === 'value' ? (
          <LowsBody view={state.view} wide={wide} />
        ) : (
          <LowsFrame state={state} />
        )}
      </div>
    </Section>
  );
}

/** Every answer but the lows: the plot's box, empty, with what lands there and why it is empty. */
function LowsFrame({ state }: { state: Exclude<LowsState, { kind: 'value' }> }) {
  return (
    <div className="flex flex-col gap-(--space-3)">
      <div
        className={cn(
          'relative w-full',
          CHART_HEIGHT,
          'mt-[1.4375rem] border-s border-b border-line2',
        )}
      >
        {state.kind === 'loading' && (
          <Skeleton data-slot="sentinel-lows-loading" className="absolute inset-0 opacity-40" />
        )}
        {state.kind === 'before' && (
          <ChartNote title={LOWS_LAND_HERE} detail={recordBeginsWords(state.countsFrom)} />
        )}
        {state.kind === 'none' && <ChartNote title={LOWS_LAND_HERE} detail={LOWS_NOT_RECORDED} />}
        {state.kind === 'failed' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <RetryNote onRetry={state.retry} pending={state.pending}>
              {LOWS_FAILED}
            </RetryNote>
          </div>
        )}
      </div>
      <MatrixLegend />
    </div>
  );
}

function LowsBody({ view, wide }: { view: LowsView; wide: boolean }) {
  const config: ChartConfig = Object.fromEntries(
    view.rows.map((r, i) => [`s${i}`, { label: r.label, tone: r.tone, unit: ' °F' }]),
  );
  // The x axis is the night's index: a band each, its point at the band's center (−½ … n − ½).
  const data = view.nights.map((_, n) => ({
    n,
    ...Object.fromEntries(view.rows.map((r, i) => [`s${i}`, r.values[n] ?? null])),
  }));
  const legend: LegendItem[] = [
    ...view.rows.map((r) => ({ label: r.label, ink: TONE_INK[r.tone], mark: 'line' as const })),
    { label: view.lines.watchWords, ink: 'var(--fg3)', mark: 'line', pattern: 'dashed' },
    { label: view.lines.imageryWords, ink: 'var(--warn)', mark: 'line', pattern: 'dashed' },
  ];
  const ticks = view.ticks;
  const count = view.nights.length;
  const minorTicks = count <= 31;
  const [plot, setPlot] = useState<PlotSpan | null>(null);
  const [charPx, setCharPx] = useState(WORDS_CHAR_PX);
  const matrix = useRef<HTMLDivElement>(null);
  const kickers = useKickerRoom(matrix);
  // The plot makes room for the matrix's names on their side: right of it beside the end labels,
  // wide; left of it, narrow, where the y axis already takes part of their room.
  const left = wide ? 0 : Math.max(0, kickers - (plot?.axis ?? 0));
  const right = wide ? Math.max(END_GUTTER, kickers) : NARROW_GUTTER;
  // Whether the marked nights' words take two lines at this width (narrow, they always may): the
  // room over the plot is kept for the second, decided from the plot as soon as it is laid out.
  const twoLines = !wide || wordsTakeTwoLines(view, plot, right, charPx);
  const track: MatrixTrack | undefined =
    plot === null ? undefined : { start: PLOT_EDGE + plot.x, width: plot.width };
  return (
    <div className="flex flex-col gap-(--space-3)">
      <ChartLegend items={legend} className="justify-end" />
      <ChartContainer
        config={config}
        role="img"
        aria-label={lowsChartLabel(view.period)}
        className={cn(CHART_HEIGHT, 'border-s border-b border-line2 p-0')}
      >
        <LineChart
          data={data}
          // Narrow, the marked nights' words may need a second line: the room is kept for it.
          margin={{
            top: twoLines ? EVENT_ROOM + WORDS_LINE : EVENT_ROOM,
            right,
            bottom: 0,
            left,
          }}
        >
          <ChartXAxis
            dataKey="n"
            type="number"
            domain={[-0.5, count - 0.5]}
            ticks={minorTicks ? view.nights.map((_, n) => n) : view.labeled}
            interval={0}
            tickLine={false}
            tick={<NightTick nights={view.nights} labeled={new Set(view.labeled)} />}
          />
          <ChartYAxis
            ticks={ticks}
            domain={[ticks[0] ?? 0, ticks.at(-1) ?? 40]}
            allowDataOverflow
          />
          <ChartRule y={view.lines.watchF} tone="faint" />
          <ChartRule y={view.lines.imageryF} tone="warn" />
          {view.rows.map((r, i) => (
            <ChartLine
              key={r.key}
              dataKey={`s${i}`}
              connectNulls={false}
              strokeWidth={r.tone === 'lead' ? 1.3 : 1}
            />
          ))}
          <LowsMarks
            view={view}
            endLabels={wide}
            right={right}
            room={twoLines ? EVENT_ROOM + WORDS_LINE : EVENT_ROOM}
            charPx={charPx}
            onCharPx={setCharPx}
          />
          <ChartTooltip labelFormatter={(n) => nightLabel(view, n)} />
          <PlotProbe onPlot={setPlot} />
        </LineChart>
      </ChartContainer>
      <div ref={matrix}>
        <MatrixChart
          aria-label={lowsMatrixLabel(view.period)}
          rows={view.rows.map((r) => ({ key: r.key, label: r.label, values: r.values }))}
          columns={view.nights.map((night, n) => ({ key: night, label: view.labels[n] as string }))}
          kickerSide={wide ? 'right' : 'left'}
          columnKickers="none"
          showValues={false}
          track={track}
        />
      </div>
      <MatrixLegend />
    </div>
  );
}

/** The plot as Recharts laid it out (SVG px): its left edge, its width, and the y axis' share of the left. */
type PlotSpan = { x: number; width: number; axis: number };

/** The night an x value (an index) names, as the tooltip titles it. */
function nightLabel(view: LowsView, n: unknown): string {
  const night = view.nights[Number(n)];
  return night === undefined ? '' : dayLabel(night);
}

/** Where a night's point sits in the plot: the center of its band. */
const bandCenter = (plot: PlotSpan, index: number, count: number) =>
  plot.x + ((index + 0.5) / Math.max(1, count)) * plot.width;

/**
 * Whether the two marked nights' words would take two lines over the plot with `right` px of room
 * after it: the rules at their nights' band centers, the words placed as the chart places them.
 * `false` until the plot is laid out.
 */
function wordsTakeTwoLines(
  view: LowsView,
  plot: PlotSpan | null,
  right: number,
  charPx: number,
): boolean {
  const events = [view.opened, view.imagery].filter((e): e is LowsEvent => e !== null);
  if (plot === null || events.length < 2) return false;
  return placeEventWords(
    events.map((e) => ({
      x: bandCenter(plot, e.index, view.nights.length),
      width: e.words.length * charPx,
    })),
    plot.x + plot.width + right,
  ).some((p) => p.line === 1);
}

/**
 * Reports the plot's span out of the chart when it moves, so the matrix can sit under it. The y
 * axis' share is read against the margin the chart laid out with (its store lags the prop). A plot
 * with no width is the chart before it is measured (its 1 × 1 first draw), never reported: the
 * matrix keeps its own layout until the plot is real.
 */
function PlotProbe({ onPlot }: { onPlot: (plot: PlotSpan) => void }) {
  const area = usePlotArea();
  const left = useMargin()?.left ?? 0;
  const x = area?.x;
  const width = area?.width;
  useLayoutEffect(() => {
    if (x === undefined || width === undefined || width <= 0) return;
    onPlot({ x, width, axis: x - left });
  }, [x, width, left, onPlot]);
  return null;
}

/**
 * The room the matrix's names take beside the cells: the widest name and the column gap, measured
 * (names can be any sentinel's, and the font lands late); the kit's minimum until it is. Measured
 * after every commit, since the names move sides and change with the rows, and again when a font
 * lands: a name's box is its column's, pinned to the plot, so a wider face never resizes it.
 */
function useKickerRoom(ref: RefObject<HTMLDivElement | null>): number {
  const [room, setRoom] = useState(KICKER_ROOM);
  useLayoutEffect(() => {
    const box = ref.current;
    /* v8 ignore next */
    if (box === null) return;
    const grid = box.querySelector<HTMLElement>('[data-slot="matrix-chart"]');
    const names = [...box.querySelectorAll<HTMLElement>('[data-slot="matrix-row-kicker"]')];
    const measure = () => {
      // The text's own width: a name is a grid item, stretched to its column, which this sizes.
      const range = document.createRange();
      // A page with no layout (jsdom has no range boxes) measures nothing: the minimum stands.
      /* v8 ignore next */
      if (typeof range.getBoundingClientRect !== 'function') return;
      const widest = Math.max(
        0,
        ...names.map((n) => {
          range.selectNodeContents(n);
          return range.getBoundingClientRect().width;
        }),
      );
      const gap = grid === null ? 0 : Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
      // Names with no box (none drawn, or the row hidden) measure nothing: the last room stands.
      if (widest > 0) setRoom(Math.ceil(widest + gap));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const n of names) observer.observe(n);
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.addEventListener('loadingdone', measure);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener('loadingdone', measure);
    };
  });
  return room;
}

type NightTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value: number };
  nights: readonly string[];
  labeled: ReadonlySet<number>;
};

/** A night on the x axis: a short tick each night, a longer one and its date on the labeled nights. */
function NightTick({ x = 0, y = 0, payload, nights, labeled }: NightTickProps) {
  const index = payload?.value ?? -1;
  const night = nights[index] ?? '';
  const major = labeled.has(index);
  const top = Number(y) - 6;
  return (
    <g data-slot="night-tick" data-major={major ? '' : undefined}>
      <line
        x1={Number(x)}
        x2={Number(x)}
        y1={top}
        y2={top + (major ? 7 : 4)}
        className="recharts-cartesian-axis-tick-line"
      />
      {major && (
        <text
          x={Number(x)}
          y={Number(y) + 8}
          dy="0.71em"
          textAnchor="middle"
          className="recharts-cartesian-axis-tick-value"
        >
          {dayLabel(night)}
        </text>
      )}
    </g>
  );
}

/**
 * The chart's own marks over Recharts' plot: the two marked nights (a rule the plot's height, its
 * words at the top, a ⊗ on each sentinel the record named), and each line's end label right of the
 * plot, pushed apart so two never overlap.
 */
function LowsMarks({
  view,
  endLabels,
  right,
  room,
  charPx,
  onCharPx,
}: {
  view: LowsView;
  endLabels: boolean;
  /** The room right of the plot. */
  right: number;
  /** The room over the plot the words have. */
  room: number;
  /** The words' width per character, as last measured. */
  charPx: number;
  /** The words as drawn measured a different width per character: place them again on it. */
  onCharPx: (px: number) => void;
}) {
  const marks = useRef<SVGGElement>(null);
  // The words' real advance, read after each draw (the face may have landed since): the widest per
  // character of those drawn. A change of under a tenth of a pixel is noise, never a re-place.
  useLayoutEffect(() => {
    const texts = [
      ...(marks.current?.querySelectorAll<SVGTextElement>('[data-slot="lows-event-words"]') ?? []),
    ];
    const per = Math.max(
      0,
      ...texts.map((t) => {
        const n = t.textContent?.length ?? 0;
        // A page with no layout (jsdom) measures nothing: the estimate stands.
        /* v8 ignore next */
        if (n === 0 || typeof t.getComputedTextLength !== 'function') return 0;
        return t.getComputedTextLength() / n;
      }),
    );
    if (per > 0 && Math.abs(per - charPx) > 0.1) onCharPx(per);
  });
  const plot = usePlotArea();
  const x = useXAxisScale();
  const y = useYAxisScale();
  if (plot === undefined || x === undefined || y === undefined) return null;
  const xAt = (index: number) => x(index) as number | undefined;
  const ends = view.rows.map((r) => (r.end === null ? null : (y(r.end.value) as number)));
  const drawn = ends.flatMap((e, i) => (e == null ? [] : [{ i, y: e }]));
  const spread = spreadLabels(
    drawn.map((d) => d.y),
    11,
    plot.y,
    plot.y + plot.height,
  );
  const events = [
    { key: 'opened', event: view.opened, ink: 'var(--fg2)', mark: 'var(--fg2)' },
    { key: 'imagery', event: view.imagery, ink: 'var(--warn)', mark: 'var(--fg)' },
  ].flatMap((e) => {
    const at = e.event === null ? undefined : xAt(e.event.index);
    return e.event === null || at === undefined ? [] : [{ ...e, event: e.event, at }];
  });
  // Each label's width from its characters: the mono kicker's advance and tracking, as drawn.
  const places = placeEventWords(
    events.map((e) => ({ x: e.at, width: e.event.words.length * charPx })),
    plot.x + plot.width + right,
  );
  return (
    <g ref={marks} data-slot="lows-marks" className="font-(family-name:--family-mono) text-kick">
      {events.map(({ key, event, at, ink, mark }, k) => (
        <EventRule
          key={key}
          event={event}
          at={at}
          place={places[k] as WordsPlace}
          top={plot.y - room + 2}
          bottom={plot.y + plot.height}
          ink={ink}
          mark={mark}
          yOf={(v) => y(v) as number}
        />
      ))}
      {endLabels &&
        drawn.map((d, k) => {
          const row = view.rows[d.i];
          if (row?.end == null) return null;
          return (
            <text
              key={row.key}
              data-slot="lows-end-label"
              x={plot.x + plot.width + 7}
              y={spread[k]}
              dy="0.35em"
              className="tracking-micro uppercase"
              style={{ fill: TONE_INK[row.tone] }}
            >
              {row.end.text}
            </text>
          );
        })}
    </g>
  );
}

function EventRule({
  event,
  at,
  place,
  top,
  bottom,
  ink,
  mark,
  yOf,
}: {
  event: LowsEvent;
  at: number;
  place: WordsPlace;
  top: number;
  bottom: number;
  ink: string;
  mark: string;
  yOf: (v: number) => number;
}) {
  return (
    <g data-slot="lows-event">
      <line x1={at} x2={at} y1={top} y2={bottom} stroke="var(--line2)" strokeWidth={1} />
      <text
        x={place.x}
        y={top + 8 + place.line * WORDS_LINE}
        textAnchor={place.anchor}
        className="tracking-kick uppercase"
        style={{ fill: ink }}
        data-slot="lows-event-words"
      >
        {event.words}
      </text>
      {event.marks.map((m) => (
        <g key={m.row} data-slot="lows-event-mark" transform={`translate(${at} ${yOf(m.value)})`}>
          <circle r={4.5} fill="var(--bg)" stroke={mark} strokeWidth={1} />
          <path d="M-2.5 -2.5 l5 5 M2.5 -2.5 l-5 5" stroke={mark} strokeWidth={1} fill="none" />
        </g>
      ))}
    </g>
  );
}
