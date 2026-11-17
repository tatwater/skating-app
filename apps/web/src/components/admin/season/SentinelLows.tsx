import { type ComponentProps, useLayoutEffect, useRef, useState } from 'react';
import { LineChart, usePlotArea, useXAxisScale, useYAxisScale } from 'recharts';

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
import { MatrixChart, MatrixLegend } from '@/components/kit/matrix-chart';
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
 * - **Readable without color**: every cell is in the matrix's grid with its night, its sentinel and
 *   its value spoken; the cells write their value whenever it fits.
 * - **Narrow** (`useColumnsFit`, the console's rule): below the chart and its end labels' width, the
 *   end labels go (the matrix names each row and its plate says each value); nothing scrolls sideways.
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
/** A marked night's words, per character: the mono kicker's advance and its tracking (10 px type). */
const WORDS_CHAR_PX = 8.3;
/** The narrowest cell that still writes its value (two mono digits and a hair either side). */
const VALUE_CELL_PX = 18;

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
  const data = view.nights.map((night, n) => ({
    night,
    ...Object.fromEntries(view.rows.map((r, i) => [`s${i}`, r.values[n] ?? null])),
  }));
  const legend: LegendItem[] = [
    ...view.rows.map((r) => ({ label: r.label, ink: TONE_INK[r.tone], mark: 'line' as const })),
    { label: view.lines.watchWords, ink: 'var(--fg3)', mark: 'line', pattern: 'dashed' },
    { label: view.lines.imageryWords, ink: 'var(--warn)', mark: 'line', pattern: 'dashed' },
  ];
  const ticks = view.ticks;
  const minorTicks = view.nights.length <= 31;
  const cells = useCellWidth(view.nights.length);
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
            top: wide ? EVENT_ROOM : EVENT_ROOM + WORDS_LINE,
            right: wide ? END_GUTTER : 8,
            bottom: 0,
            left: 0,
          }}
        >
          <ChartXAxis
            dataKey="night"
            ticks={minorTicks ? view.nights : view.labeled.map((i) => view.nights[i] as string)}
            interval={0}
            tickLine={false}
            tick={
              <NightTick labeled={new Set(view.labeled.map((i) => view.nights[i] as string))} />
            }
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
          <LowsMarks view={view} endLabels={wide} />
          <ChartTooltip labelFormatter={(night) => dayLabel(String(night))} />
        </LineChart>
      </ChartContainer>
      <div ref={cells.ref}>
        <MatrixChart
          aria-label={lowsMatrixLabel(view.period)}
          rows={view.rows.map((r) => ({ key: r.key, label: r.label, values: r.values }))}
          columns={view.nights.map((night, n) => ({ key: night, label: view.labels[n] as string }))}
          kickerSide={wide ? 'right' : 'left'}
          columnKickers="none"
          showValues={cells.fits}
        />
      </div>
      <MatrixLegend />
    </div>
  );
}

/** Whether a matrix cell is wide enough to write its value: the matrix's width over its nights. */
function useCellWidth(nights: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    /* v8 ignore next */
    if (el === null) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The matrix's kicker column (3.75 rem at least) and its gaps come out of the width; until it is
  // measured (and in a test page with no layout), a cell is taken to fit, as the board draws it.
  const cell = (width - 75) / Math.max(1, nights) - 4;
  return { ref, fits: width === 0 || cell >= VALUE_CELL_PX };
}

type NightTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value: string };
  labeled: ReadonlySet<string>;
};

/** A night on the x axis: a short tick each night, a longer one and its date on the labeled nights. */
function NightTick({ x = 0, y = 0, payload, labeled }: NightTickProps) {
  const night = payload?.value ?? '';
  const major = labeled.has(night);
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
function LowsMarks({ view, endLabels }: { view: LowsView; endLabels: boolean }) {
  const plot = usePlotArea();
  const x = useXAxisScale();
  const y = useYAxisScale();
  if (plot === undefined || x === undefined || y === undefined) return null;
  const xAt = (night: string) => x(night) as number | undefined;
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
    const at = e.event === null ? undefined : xAt(e.event.night);
    return e.event === null || at === undefined ? [] : [{ ...e, event: e.event, at }];
  });
  // Each label's width from its characters: the mono kicker's advance and tracking, as drawn.
  const places = placeEventWords(
    events.map((e) => ({ x: e.at, width: e.event.words.length * WORDS_CHAR_PX })),
    plot.x + plot.width + (endLabels ? END_GUTTER : 8),
  );
  return (
    <g data-slot="lows-marks" className="font-(family-name:--family-mono) text-kick">
      {events.map(({ key, event, at, ink, mark }, k) => (
        <EventRule
          key={key}
          event={event}
          at={at}
          place={places[k] as WordsPlace}
          top={plot.y - (endLabels ? EVENT_ROOM : EVENT_ROOM + WORDS_LINE) + 2}
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
