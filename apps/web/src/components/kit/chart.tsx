import * as tokens from '@skating/design/tokens';
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
} from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';

import { useReducedMotion } from '@/lib/useReducedMotion';
import { cn } from '@/lib/utils';

/**
 * The kit's Chart: shadcn's Chart pattern (a config-driven container over Recharts v3), re-skinned
 * to the console's chart register — the season traces, the spend bars, the health lines.
 *
 * - **Tones, not colors.** A series names a tone slot; the container maps every slot to a
 *   `--chart-<tone>` variable over the theme's grayscale and meaning accents: `lead` (the bright
 *   ink, this season), `muted` and `faint` (comparisons, last season), `warn` and `bad` (by
 *   meaning only), and `water` — the ice accent, **only for water and transient modes**, never a
 *   date or a value. Each series then gets `--color-<key>`, so marks and the tooltip swatch share
 *   one source, and a light or dark map re-colors the chart without a prop.
 * - **Hover is a vertical hairline at the hovered x and a square plate** in the kit Tooltip's
 *   register (the plate ground, a `line2` edge, the plate shadow, no radius, no arrow): the x as
 *   a kicker title, ~6 px, then each series' name and its mono value. Never Recharts' default
 *   rounded box, never its band-shaped bar cursor.
 * - **Nothing clips at the plot's edge.** The SVG draws overflow, and the container's padding is
 *   the room a stroke or an active dot needs at a maximum point, so a line at the top of its domain
 *   keeps its full width and its dot.
 * - **Gridlines run unbroken**, top to bottom or edge to edge, solid hairlines in the rule gray —
 *   never dashes or ticks repeated per row. Horizontal by default.
 * - **Axes**: the x labels in kicker type, y tick numbers in mono, both in the faint ink, with short
 *   ticks and no axis line; an axis title is a kicker.
 * - **Motion**: series draw on the slow motion token; under reduced motion nothing animates
 *   (`isAnimationActive` off). The hover plate never animates — it snaps.
 * - Sizes are rem and tokens, so a skater surface and a raised font size scale the chart's type.
 */

// ── Config and tones ─────────────────────────────────────────────────────────────────────────

/** The slots a series can wear. `water` is the ice accent: water and transient modes only. */
type ChartTone = 'lead' | 'muted' | 'faint' | 'warn' | 'bad' | 'water';

const TONE_VARS: Record<ChartTone, string> = {
  lead: 'var(--fg)',
  muted: 'var(--fg2)',
  faint: 'var(--fg3)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  water: 'var(--acc)',
};

type ChartSeries = {
  /** The series' name, as the hover plate says it ("This winter"). */
  label: ReactNode;
  tone: ChartTone;
  /** A comparison line's pattern: `dotted` (last season), `dashed`. Solid by default. */
  pattern?: 'solid' | 'dotted' | 'dashed';
  /** Appended to the value in the plate (" °F", "%"); a currency prefix goes in `format`. */
  unit?: string;
  /** Formats the value for the plate (`$25.00`). */
  format?: (value: number) => string;
};

/** Every series the chart draws, by its data key. */
type ChartConfig = Record<string, ChartSeries>;

/** A key as a custom-property name (data keys are the caller's; property names are CSS's). */
const keyVar = (key: string) => `--color-${key.replace(/[^\w-]/g, '_')}`;

const DASH = { solid: undefined, dotted: '1.5 3', dashed: '3 4' } as const;

type ChartContextValue = { config: ChartConfig; animate: boolean };

const ChartContext = createContext<ChartContextValue | null>(null);

function useChart(): ChartContextValue {
  const context = useContext(ChartContext);
  if (context === null) throw new Error('Kit chart parts render inside a ChartContainer.');
  return context;
}

/** The series config for a key, or a faint unnamed series (a key the config forgot). */
function seriesOf(config: ChartConfig, key: unknown): ChartSeries {
  return config[String(key)] ?? { label: String(key), tone: 'faint' };
}

// ── Container ────────────────────────────────────────────────────────────────────────────────

/** The chart's furniture, styled through Recharts' own class names. */
const FURNITURE = [
  // Overflow drawn, never clipped: the container's padding is the room.
  '[&_.recharts-surface]:overflow-visible',
  '[&_.recharts-wrapper]:outline-none [&_.recharts-surface]:outline-none',
  // Gridlines: solid hairlines in the rule gray.
  '[&_.recharts-cartesian-grid_line]:stroke-(--chart-grid)',
  // Ticks and labels.
  '[&_.recharts-cartesian-axis-tick-line]:stroke-(--chart-axis)',
  '[&_.recharts-cartesian-axis-tick-value]:fill-(--chart-tick)',
  '[&_.recharts-xAxis-tick-labels_.recharts-cartesian-axis-tick-value]:text-kick',
  '[&_.recharts-xAxis-tick-labels_.recharts-cartesian-axis-tick-value]:font-medium',
  '[&_.recharts-xAxis-tick-labels_.recharts-cartesian-axis-tick-value]:tracking-head',
  '[&_.recharts-xAxis-tick-labels_.recharts-cartesian-axis-tick-value]:uppercase',
  '[&_.recharts-yAxis-tick-labels_.recharts-cartesian-axis-tick-value]:font-(family-name:--family-mono)',
  '[&_.recharts-yAxis-tick-labels_.recharts-cartesian-axis-tick-value]:text-mono-sm',
  '[&_.recharts-yAxis-tick-labels_.recharts-cartesian-axis-tick-value]:tracking-value',
  // Axis titles and reference-rule labels are kickers.
  '[&_.recharts-label]:text-kick [&_.recharts-label]:font-medium [&_.recharts-label]:tracking-kick [&_.recharts-label]:uppercase',
  '[&_.recharts-label]:fill-(--chart-tick)',
  // The tooltip's wrapper is only a position; the plate is the kit's.
  '[&_.recharts-tooltip-wrapper]:outline-none',
];

type ChartContainerProps = Omit<ComponentProps<'div'>, 'children'> & {
  config: ChartConfig;
  /** One Recharts chart (`LineChart`, `BarChart`, `AreaChart`, `ComposedChart`). */
  children: ReactNode;
};

function ChartContainer({ config, className, style, children, ...props }: ChartContainerProps) {
  const reduced = useReducedMotion();
  const series = Object.fromEntries(
    Object.entries(config).map(([key, s]) => [keyVar(key), `var(--chart-${s.tone})`]),
  );
  return (
    <ChartContext.Provider value={{ config, animate: !reduced }}>
      <div
        data-slot="chart"
        className={cn(
          'relative h-[10rem] w-full min-w-0 text-assist',
          // The room a stroke and an active dot need at the plot's edge.
          'p-(--space-1)',
          '[--chart-grid:var(--line)] [--chart-axis:var(--line2)] [--chart-tick:var(--fg3)]',
          FURNITURE,
          className,
        )}
        style={
          {
            ...Object.fromEntries(
              Object.entries(TONE_VARS).map(([tone, value]) => [`--chart-${tone}`, value]),
            ),
            ...series,
            ...style,
          } as CSSProperties
        }
        {...props}
      >
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

// ── Axes and grid ────────────────────────────────────────────────────────────────────────────

/** Tick length and the gap from tick to label, as drawing values (px, D233). */
const TICK = 4;
const TICK_GAP = 6;

/** The x axis: kicker labels under short ticks, no axis line. */
function ChartXAxis(props: ComponentProps<typeof XAxis>) {
  return (
    <XAxis
      axisLine={false}
      tickLine
      tickSize={TICK}
      tickMargin={TICK_GAP}
      minTickGap={TICK_GAP * 2}
      {...props}
    />
  );
}

/** The y axis: mono numbers beside short ticks, no axis line, as wide as its labels. */
function ChartYAxis(props: ComponentProps<typeof YAxis>) {
  return (
    <YAxis
      axisLine={false}
      tickLine
      tickSize={TICK}
      tickMargin={TICK_GAP}
      width="auto"
      {...props}
    />
  );
}

/** Gridlines: unbroken solid hairlines, horizontal unless asked. */
function ChartGrid(props: ComponentProps<typeof CartesianGrid>) {
  return <CartesianGrid vertical={false} strokeWidth={tokens.border.hair.value} {...props} />;
}

// ── Series ───────────────────────────────────────────────────────────────────────────────────

const [e1, e2, e3, e4] = tokens.easing.standard;
const ANIMATION = {
  animationDuration: tokens.duration.slow,
  animationEasing: `cubic-bezier(${e1},${e2},${e3},${e4})` as const,
};

/** The hovered point: a small dot on the ground, ringed in its series' tone. */
function activeDot(key: string) {
  return {
    r: 3,
    fill: 'var(--bg)',
    stroke: `var(${keyVar(key)})`,
    strokeWidth: tokens.border.hair.value,
  };
}

type SeriesProps<P> = Omit<P, 'dataKey' | 'ref'> & { dataKey: string };

/** A line series in its tone and pattern. */
function ChartLine({ dataKey, ...props }: SeriesProps<ComponentProps<typeof Line>>) {
  const { config, animate } = useChart();
  const s = seriesOf(config, dataKey);
  return (
    <Line
      dataKey={dataKey}
      name={dataKey}
      type="linear"
      stroke={`var(${keyVar(dataKey)})`}
      strokeWidth={tokens.border.hair.value}
      strokeDasharray={DASH[s.pattern ?? 'solid']}
      dot={false}
      activeDot={activeDot(dataKey)}
      isAnimationActive={animate}
      {...ANIMATION}
      {...props}
    />
  );
}

/** An area series: its line in the tone, a quiet fill of the same tone under it. */
function ChartArea({ dataKey, ...props }: SeriesProps<ComponentProps<typeof Area>>) {
  const { config, animate } = useChart();
  const s = seriesOf(config, dataKey);
  return (
    <Area
      dataKey={dataKey}
      name={dataKey}
      type="linear"
      stroke={`var(${keyVar(dataKey)})`}
      strokeWidth={tokens.border.hair.value}
      strokeDasharray={DASH[s.pattern ?? 'solid']}
      fill={`var(${keyVar(dataKey)})`}
      fillOpacity={0.12}
      dot={false}
      activeDot={activeDot(dataKey)}
      isAnimationActive={animate}
      {...ANIMATION}
      {...props}
    />
  );
}

/** A bar series: square bars in the tone. */
function ChartBar({ dataKey, ...props }: SeriesProps<ComponentProps<typeof Bar>>) {
  const { animate } = useChart();
  return (
    <Bar
      dataKey={dataKey}
      name={dataKey}
      fill={`var(${keyVar(dataKey)})`}
      radius={0}
      maxBarSize={24}
      isAnimationActive={animate}
      {...ANIMATION}
      {...props}
    />
  );
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────

type ChartRuleProps = Omit<ComponentProps<typeof ReferenceLine>, 'label' | 'ref'> & {
  tone?: ChartTone | 'rule';
  /** The rule's kicker ("32 °F", "Watch opened"), at its start. */
  label?: string;
};

/**
 * A reference rule: a threshold (`y`, dashed) or an event (`x`, solid). Neutral rules are the rule
 * gray; a tone colors one by meaning (the 20 °F line in `warn`).
 */
function ChartRule({ tone = 'rule', label, x, ...props }: ChartRuleProps) {
  const color = tone === 'rule' ? 'var(--line2)' : `var(--chart-${tone})`;
  const event = x !== undefined;
  return (
    <ReferenceLine
      x={x}
      stroke={color}
      strokeWidth={tokens.border.hair.value}
      strokeDasharray={event ? undefined : DASH.dashed}
      ifOverflow="extendDomain"
      label={
        label === undefined
          ? undefined
          : {
              value: label,
              position: event ? 'insideTopLeft' : 'insideBottomLeft',
              // Inline, so it wins over the container's label ink: a toned rule's label wears its
              // tone.
              style: { fill: tone === 'rule' ? 'var(--chart-tick)' : color },
            }
      }
      {...props}
    />
  );
}

// ── Hover ────────────────────────────────────────────────────────────────────────────────────

type CursorShape = {
  className?: string;
  points?: ReadonlyArray<{ x: number; y: number }>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  top?: number;
};

/**
 * The hover cursor: one vertical hairline at the hovered x, the plot's full height. A line or area
 * chart hands Recharts' cursor two points; a bar chart hands it the hovered band, whose middle is
 * the x.
 */
function ChartCursor({ className, points, x = 0, y = 0, width = 0, height = 0 }: CursorShape) {
  const [a, b] = points ?? [];
  const cx = a ? a.x : x + width / 2;
  const y1 = a ? a.y : y;
  const y2 = b ? b.y : y + height;
  return (
    <line
      data-slot="chart-cursor"
      className={className}
      x1={cx}
      x2={cx}
      y1={y1}
      y2={y2}
      stroke="var(--fg2)"
      strokeWidth={tokens.border.hair.value}
      pointerEvents="none"
    />
  );
}

type ChartTooltipContentProps = Partial<TooltipContentProps> & {
  /** Formats the hovered x for the plate's title ("4 Oct"). */
  labelFormatter?: (label: ReactNode) => ReactNode;
};

/** The hover plate: the x as a kicker title, then each series' name and its mono value. */
function ChartTooltipContent({ active, payload, label, labelFormatter }: ChartTooltipContentProps) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  return (
    <div
      data-slot="chart-tooltip"
      className={cn(
        'flex w-max min-w-[10rem] flex-col gap-(--space-1_5) px-(--space-3) py-(--space-2_5)',
        'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
      )}
    >
      {label != null && (
        <span
          data-slot="chart-tooltip-title"
          className="text-kick leading-none font-medium tracking-head text-fg uppercase"
        >
          {labelFormatter ? labelFormatter(label) : label}
        </span>
      )}
      {payload.map((item) => {
        const key = String(item.dataKey);
        const s = seriesOf(config, key);
        const value = typeof item.value === 'number' ? item.value : Number(item.value);
        const shown = s.format ? s.format(value) : `${value}${s.unit ?? ''}`;
        return (
          <span
            key={key}
            data-slot="chart-tooltip-item"
            className="flex items-center gap-(--space-2) text-assist leading-none whitespace-nowrap text-fg2"
          >
            <svg
              aria-hidden="true"
              data-slot="chart-tooltip-swatch"
              className="h-(--space-2) w-(--space-3) shrink-0 overflow-visible"
            >
              <line
                x1="0"
                x2="100%"
                y1="50%"
                y2="50%"
                stroke={`var(${keyVar(key)})`}
                strokeWidth={tokens.border.note.value}
                strokeDasharray={DASH[s.pattern ?? 'solid']}
              />
            </svg>
            <span>{s.label}</span>
            <span
              data-slot="chart-tooltip-value"
              className="ms-auto ps-(--space-3) font-(family-name:--family-mono) text-mono-sm tracking-value text-fg tabular-nums"
            >
              {shown}
            </span>
          </span>
        );
      })}
    </div>
  );
}

type ChartTooltipProps = Omit<ComponentProps<typeof Tooltip>, 'ref'> & {
  labelFormatter?: (label: ReactNode) => ReactNode;
};

/** Recharts' Tooltip with the kit's hairline cursor and plate; it snaps, never animates. */
function ChartTooltip({ labelFormatter, ...props }: ChartTooltipProps) {
  return (
    <Tooltip
      cursor={<ChartCursor />}
      content={<ChartTooltipContent labelFormatter={labelFormatter} />}
      isAnimationActive={false}
      offset={12}
      {...props}
    />
  );
}

export {
  ChartArea,
  ChartBar,
  type ChartConfig,
  ChartContainer,
  type ChartContainerProps,
  ChartCursor,
  ChartGrid,
  ChartLine,
  ChartRule,
  type ChartRuleProps,
  type ChartSeries,
  type ChartTone,
  ChartTooltip,
  ChartTooltipContent,
  type ChartTooltipContentProps,
  ChartXAxis,
  ChartYAxis,
};
