import { useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '../ui/card';
import { CHART_TOKENS, type ChartStatus, chartSeries, statusColor } from './palette';

/**
 * The operator chart kit (Phase 7b) — thin, themed wrappers over Recharts (the shadcn `chart` house
 * choice), one per data shape the analytics layer produces: a time series, a histogram, a composition,
 * a scatter. Every chart follows the dataviz rules: recessive grid/axis, a legend + a table view so
 * identity is never color-alone (D34), fixed categorical order, and colors stepped for dark mode rather
 * than flipped. Text always wears a text token; only marks carry a series hue.
 */

/** Resolve the palette + token set for the active theme once, shared by every chart. */
function useChartTheme() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  return { dark, series: chartSeries(dark) };
}

/** A titled chart container with a description and a collapsible table view (the a11y fallback). */
export function ChartCard({
  title,
  description,
  note,
  table,
  children,
}: {
  title: string;
  description?: string;
  note?: ReactNode;
  /** The same data as a plain table — the non-visual path every chart must offer (D34). */
  table?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-medium text-foreground text-sm">{title}</h3>
          {description ? <p className="text-foreground-muted text-xs">{description}</p> : null}
        </div>
        {children}
        {note ? <p className="text-foreground-muted text-xs">{note}</p> : null}
        {table ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-foreground-muted hover:text-foreground">
              View as table
            </summary>
            <div className="mt-2 overflow-x-auto">{table}</div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The friendly empty state a forward-only metric shows until it has collected anything. */
export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-40 items-center justify-center text-center text-foreground-muted text-xs">
      {children}
    </div>
  );
}

/** Shared tooltip — surface card, text-token labels, never a series color on the text. */
const tooltipStyle = {
  backgroundColor: CHART_TOKENS.tooltipBg,
  border: `1px solid ${CHART_TOKENS.tooltipBorder}`,
  borderRadius: 8,
  color: CHART_TOKENS.tooltipText,
  fontSize: 12,
};

const axisProps = {
  stroke: CHART_TOKENS.axis,
  tick: { fill: CHART_TOKENS.axis, fontSize: 11 },
  tickLine: false,
} as const;

/** A small legend row (dataviz: always present for ≥2 series, so identity isn't color-alone). */
export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-foreground-muted text-xs">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-[2px]"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Time series (scalar-per-day) — the app-health strip + the reopen/cap rates
// ─────────────────────────────────────────────────────────────────────────────

export interface SeriesLine {
  key: string;
  label: string;
  /** Optional status hue for a semantically-loaded line (a rate); otherwise a categorical slot. */
  status?: ChartStatus;
}

/**
 * One or more scalar-per-day lines over the same date axis. Rows are `{ date, [key]: number }`. Values
 * that were never measured (a gap-filled null) break the line rather than dropping to zero, so a
 * not-yet-collected day reads as absent, not as a real trough.
 */
export function TimeSeriesChart({
  data,
  lines,
  height = 200,
  yFormatter,
}: {
  data: Array<Record<string, number | string | null>>;
  lines: SeriesLine[];
  height?: number;
  yFormatter?: (v: number) => string;
}) {
  const { dark, series } = useChartTheme();
  const color = (line: SeriesLine, i: number) =>
    line.status ? statusColor(line.status, dark) : (series[i % series.length] as string);
  return (
    <>
      {lines.length > 1 ? (
        <ChartLegend items={lines.map((l, i) => ({ label: l.label, color: color(l, i) }))} />
      ) : null}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="date" {...axisProps} minTickGap={24} tickFormatter={shortDate} />
          <YAxis
            {...axisProps}
            width={40}
            allowDecimals={false}
            {...(yFormatter ? { tickFormatter: yFormatter } : {})}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            {...(yFormatter ? { formatter: (v: number) => yFormatter(v) } : {})}
          />
          {lines.map((line, i) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.label}
              stroke={color(line, i)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Histogram (bucketed) — reputation, contradiction counts, hour distributions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bucket histogram. `labels` are the axis categories (from the metric catalogue, so the axis can't
 * drift from what the rollup bucketed), `counts` the parallel values. `markers` overlays a labelled
 * vertical reference at a named bucket edge — how the trust-class cutoffs are drawn *onto* the
 * reputation distribution, which is the whole point of that chart.
 */
export function HistogramChart({
  labels,
  counts,
  height = 200,
  markers,
  color,
}: {
  labels: string[];
  counts: number[];
  height?: number;
  markers?: { atLabel: string; label: string }[];
  color?: ChartStatus;
}) {
  const { dark, series } = useChartTheme();
  const fill = color ? statusColor(color, dark) : (series[1] as string);
  const data = labels.map((label, i) => ({ label, count: counts[i] ?? 0 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" {...axisProps} interval={0} />
        <YAxis {...axisProps} width={40} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--color-surface-muted)' }} />
        <Bar dataKey="count" fill={fill} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        {markers?.map((m) => (
          <ReferenceLine
            key={m.label}
            x={m.atLabel}
            stroke={CHART_TOKENS.axis}
            strokeDasharray="3 3"
            label={{ value: m.label, position: 'top', fill: CHART_TOKENS.axis, fontSize: 10 }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition (a labelled record) — funnels, gate mix, point sources, dispositions
// ─────────────────────────────────────────────────────────────────────────────

export interface CompositionSlice {
  key: string;
  label: string;
  value: number;
  status?: ChartStatus;
}

/**
 * A horizontal composition — the shape a `meta` record wants when the categories are few and named (a
 * gate mix, a disposition split, a point-source breakdown). Horizontal so long category labels read
 * straight. Each slice can carry a status hue where the category has inherent polarity.
 */
export function CompositionChart({
  slices,
  height,
}: {
  slices: CompositionSlice[];
  height?: number;
}) {
  const { dark, series } = useChartTheme();
  const rows = [...slices].sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, s) => sum + s.value, 0);
  const color = (s: CompositionSlice, i: number) =>
    s.status ? statusColor(s.status, dark) : (series[i % series.length] as string);
  const barHeight = 22;
  return (
    <div className="flex flex-col gap-1.5" style={height ? { minHeight: height } : undefined}>
      {rows.length === 0 ? (
        <ChartEmpty>No data yet.</ChartEmpty>
      ) : (
        rows.map((s, i) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <span className="w-40 shrink-0 truncate text-foreground-muted" title={s.label}>
                {s.label}
              </span>
              <div className="relative h-[22px] flex-1 overflow-hidden rounded bg-surface-muted">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${Math.max(pct, s.value > 0 ? 2 : 0)}%`,
                    height: barHeight,
                    backgroundColor: color(s, i),
                  }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-foreground">
                {s.value.toLocaleString()}
                <span className="ml-1 text-foreground-muted">{pct.toFixed(0)}%</span>
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scatter — the bounty suppression chart
// ─────────────────────────────────────────────────────────────────────────────

export interface ScatterPoint {
  x: number;
  y: number;
  status: ChartStatus;
}

/**
 * An (x, y) scatter with a **y = x reference diagonal** — the bounty suppression chart (roadmap D56
 * §7c). A point above the line is a report older than the window applied to it (a bounty allowed
 * through); below, one still inside its window (blocked). The diagonal is the decision boundary, so
 * drawing it is what makes the dots legible without reading their color.
 */
export function DiagonalScatter({
  points,
  xLabel,
  yLabel,
  height = 260,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  height?: number;
}) {
  const { dark } = useChartTheme();
  const max = Math.max(1, ...points.map((p) => Math.max(p.x, p.y)));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 16, left: 0 }}>
        <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="2 4" />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          domain={[0, Math.ceil(max)]}
          {...axisProps}
          label={{
            value: xLabel,
            position: 'insideBottom',
            offset: -8,
            fill: CHART_TOKENS.axis,
            fontSize: 11,
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          domain={[0, Math.ceil(max)]}
          width={40}
          {...axisProps}
        />
        <ZAxis range={[36, 36]} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: '3 3' }} />
        <ReferenceLine
          segment={[
            { x: 0, y: 0 },
            { x: Math.ceil(max), y: Math.ceil(max) },
          ]}
          stroke={CHART_TOKENS.axis}
          strokeDasharray="4 4"
        />
        <Scatter data={points} isAnimationActive={false}>
          {points.map((p, i) => (
            // A scatter is unordered points with no identity — two attempts can share a coordinate, so
            // position is the only key available and reordering never happens (the array is rebuilt whole).
            // biome-ignore lint/suspicious/noArrayIndexKey: positional data, no stable id exists
            <Cell key={i} fill={statusColor(p.status, dark)} fillOpacity={0.75} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped/stacked month bars — the contributor good-vs-bad trend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tenure-aware good-vs-bad trend (D57). Stacked bars per month — good below, bad above — so the
 * ratio at a glance is the shape, and a `sinceLabel` marker anchors when the account was created, which
 * is the tenure half of "tenure-aware": the same raw bad count reads very differently against a long
 * green history than against a one-month bar.
 */
export function TrendBars({
  data,
  height = 220,
}: {
  data: Array<{ month: string; good: number; bad: number }>;
  height?: number;
}) {
  const { dark } = useChartTheme();
  return (
    <>
      <ChartLegend
        items={[
          { label: 'Good (corroborated / net-helpful)', color: statusColor('good', dark) },
          { label: 'Bad (contradiction / upheld flag)', color: statusColor('bad', dark) },
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="month" {...axisProps} minTickGap={16} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--color-surface-muted)' }} />
          <Bar
            dataKey="good"
            stackId="trend"
            fill={statusColor('good', dark)}
            isAnimationActive={false}
          />
          <Bar
            dataKey="bad"
            stackId="trend"
            fill={statusColor('bad', dark)}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

/** A short `YYYY-MM-DD` → `M/D` for a dense date axis. */
function shortDate(date: string): string {
  const parts = date.split('-');
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : date;
}

/** Small helper: a plain table body from label/value pairs, for a chart's "view as table". */
export function MiniTable({ rows, headers }: { rows: (string | number)[][]; headers: string[] }) {
  return (
    <table className={cn('w-full text-left text-foreground text-xs')}>
      <thead>
        <tr>
          {headers.map((h) => (
            <th
              key={h}
              className="border-border border-b py-1 pr-3 font-medium text-foreground-muted"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          // The first cell is the row's label (a day / bucket / category) — unique within the table.
          <tr key={String(row[0])}>
            {row.map((cell, j) => (
              // Cells are fixed positional columns; the header at that index names them.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed column position, no id
              <td key={j} className="border-border/40 border-b py-1 pr-3 tabular-nums">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
