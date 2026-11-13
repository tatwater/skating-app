import type { CSSProperties } from 'react';
import { BarChart, ComposedChart, LabelList } from 'recharts';

import {
  ChartBar,
  type ChartConfig,
  ChartContainer,
  ChartGrid,
  ChartLine,
  ChartRule,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from '@/components/kit/chart';
import { Section } from '@/components/kit/section-slug';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';

import { ChartLegend, type LegendItem } from './ChartLegend';
import {
  ageParts,
  axisTicks,
  countTicks,
  type DayKey,
  dayTitle,
  type FlagQueueDay,
  foldResolveBuckets,
  hourTicks,
  type KeepingUpData,
  medianPhrase,
  NOT_RECORDED,
  oldestFlagTone,
  RESOLVE_BUCKETS,
  SUPPORT_CATEGORIES,
  type SupportCategory,
  shortAge,
} from './metricsModel';
import { AgeValue, ChartNote, ColumnHead, DayTick, UnrecordedTile } from './metricsParts';

/**
 * Overview › Metrics, the left column: how staff are keeping up. The top stats are the last seven
 * days (or now); the charts under them are the season, one day per bar.
 */

/** The room a season chart leaves its axes, as the boards draw it. */
const SEASON_MARGIN = { top: 4, right: 8, bottom: 0, left: 0 };

/** The first recorded day, when the series starts after the season did — the record's own start. */
function recordStart<T>(days: readonly DayKey[], series: ReadonlyArray<T | null>): DayKey | null {
  const first = series.findIndex((v) => v !== null);
  return first > 0 ? (days[first] ?? null) : null;
}

const noneRecorded = <T,>(series: ReadonlyArray<T | null>) => series.every((v) => v === null);

// ── The stats ────────────────────────────────────────────────────────────────────────────────

export function KeepingUpStats({ data, now }: { data: KeepingUpData; now: number }) {
  const { openFlags, oldestOpenFlag, resolvedWeek, support } = data;
  const oldestAge = oldestOpenFlag === null ? null : now - oldestOpenFlag.openedAt;
  return (
    <StatGrid columns={support === null ? 3 : 4}>
      {openFlags === null ? (
        <UnrecordedTile key="open" label="Open flags" />
      ) : (
        <StatTile
          key="open"
          label="Open flags"
          value={openFlags.total}
          sub={openFlags.safety > 0 ? `${openFlags.safety} safety` : undefined}
        />
      )}
      {/* With the queue unread, "nothing open" would be a guess. */}
      {openFlags === null ? (
        <UnrecordedTile key="oldest" label="Oldest open flag" />
      ) : oldestAge === null ? (
        <StatTile key="oldest" label="Oldest open flag" value="—" tone="dim" sub="Nothing open" />
      ) : (
        <StatTile
          key="oldest"
          label="Oldest open flag"
          value={<AgeValue parts={ageParts(oldestAge)} />}
          tone={oldestFlagTone(oldestAge)}
          sub={oldestOpenFlag?.where ?? undefined}
        />
      )}
      {resolvedWeek === null ? (
        <UnrecordedTile key="resolved" label="Flags resolved" />
      ) : (
        <StatTile
          key="resolved"
          label="Flags resolved"
          value={resolvedWeek.reduce((sum, n) => sum + n, 0)}
          unit="this week"
          sub={medianPhrase(resolvedWeek) ?? undefined}
        />
      )}
      {support !== null && support.open === null && (
        <UnrecordedTile key="tickets" label="Open tickets" />
      )}
      {support !== null && support.open !== null && (
        <StatTile
          key="tickets"
          label="Open tickets"
          value={support.open}
          sub={
            support.oldestOpenedAt === null
              ? undefined
              : `Oldest ${shortAge(now - support.oldestOpenedAt)}`
          }
        />
      )}
    </StatGrid>
  );
}

// ── Oldest open flag ─────────────────────────────────────────────────────────────────────────

const OLDEST_CONFIG: ChartConfig = {
  standard: { label: 'Open flags', tone: 'faint' },
  safety: { label: 'Safety', tone: 'bad' },
  hours: { label: 'Hours waiting', tone: 'lead', format: (v) => `${Math.floor(v)} h` },
};

/**
 * The open-flag bars sit on a scale of their own, low in the plot under the hours line: three flags
 * stand about a sixth of its height. The scale is never drawn — the hover plate says each count.
 */
const FLAG_HEADROOM = 5.5;

const OLDEST_LEGEND: LegendItem[] = [
  { label: 'Hours waiting', ink: 'var(--fg)', mark: 'line' },
  { label: 'Open flags', ink: 'var(--line2)' },
  { label: 'Safety', ink: 'var(--bad)' },
];

/** The quiet bar gray the boards count context in (`g4`), which the kit's tones stop short of. */
const QUIET_INK = 'var(--line2)';

type DotProps = { cx?: number; cy?: number; index?: number; value?: unknown };

export function OldestOpenFlagChart({
  days,
  queue,
}: {
  days: readonly DayKey[];
  queue: ReadonlyArray<FlagQueueDay | null>;
}) {
  const today = days[days.length - 1] ?? '';
  const rows = days.map((day, i) => {
    const q = queue[i] ?? null;
    return q === null
      ? { day, hours: null, standard: null, safety: null }
      : { day, hours: q.oldestHours, standard: q.standard, safety: q.safety };
  });
  const recorded = queue.filter((q): q is FlagQueueDay => q !== null);
  const maxHours = Math.max(0, ...recorded.map((q) => q.oldestHours));
  const maxFlags = Math.max(3, ...recorded.map((q) => q.standard + q.safety));
  const start = recordStart(days, queue);
  const hours = hourTicks(maxHours);
  const last = days.length - 1;
  const dot = ({ cx, cy, index, value }: DotProps) => {
    if (cx === undefined || cy === undefined || value == null) return <g key={`dot-${index}`} />;
    const isToday = index === last;
    return (
      <circle
        key={`dot-${index}`}
        data-slot="hours-dot"
        cx={cx}
        cy={cy}
        r={isToday ? 3.5 : 2}
        fill={isToday ? 'var(--fg)' : 'var(--bg)'}
        stroke="var(--fg)"
        strokeWidth={1}
      />
    );
  };
  return (
    <div className="relative">
      <ChartContainer
        config={OLDEST_CONFIG}
        className="h-[14.125rem]"
        style={{ '--color-standard': QUIET_INK } as CSSProperties}
      >
        <ComposedChart data={rows} margin={SEASON_MARGIN} barCategoryGap="28%">
          <ChartGrid yAxisId="hours" />
          <ChartXAxis
            dataKey="day"
            ticks={axisTicks(days.length).map((i) => days[i] as DayKey)}
            interval={0}
            tick={<DayTick today={today} />}
          />
          <ChartYAxis yAxisId="hours" ticks={hours} domain={[0, hours.at(-1) ?? 24]} />
          <ChartYAxis yAxisId="flags" hide domain={[0, maxFlags * FLAG_HEADROOM]} />
          {start !== null && <ChartRule yAxisId="hours" x={start} label="Record begins" />}
          <ChartBar yAxisId="flags" dataKey="standard" stackId="open" maxBarSize={18} />
          <ChartBar yAxisId="flags" dataKey="safety" stackId="open" maxBarSize={18} />
          <ChartLine
            yAxisId="hours"
            dataKey="hours"
            strokeWidth={1.3}
            dot={dot}
            connectNulls={false}
          />
          <ChartTooltip labelFormatter={(day) => dayTitle(String(day))} />
        </ComposedChart>
      </ChartContainer>
      {noneRecorded(queue) && (
        <ChartNote title="The flag queue lands here" detail="Not recorded yet" />
      )}
    </div>
  );
}

// ── Time to resolve ──────────────────────────────────────────────────────────────────────────

type LabelProps = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  value?: unknown;
};

/** A bar's count over its top: mono, the bright ink. A zero bar says nothing. */
function BarValue({ x = 0, y = 0, width = 0, value }: LabelProps) {
  if (!value) return null;
  return (
    <text
      data-slot="bar-value"
      x={Number(x) + Number(width) / 2}
      y={Number(y) - 5}
      textAnchor="middle"
      className="font-(family-name:--family-mono) text-kick tabular-nums"
      style={{ fill: 'var(--fg)' }}
    >
      {String(value)}
    </text>
  );
}

/**
 * How long things waited before someone resolved them, this season, in the board's six buckets.
 * The section's rule ends in how many were resolved.
 */
export function ResolveHistogram({
  title,
  noun,
  buckets,
  scaleMax,
}: {
  title: string;
  /** What each bar counts, for the hover plate ("Flags"). */
  noun: string;
  /** The season's eight-bucket `HOUR_BUCKETS` histogram; `null` before a read serves it. */
  buckets: readonly number[] | null;
  /** The tallest bar of every histogram beside this one, so side-by-side bars compare. */
  scaleMax?: number;
}) {
  const counts = foldResolveBuckets(buckets ?? []);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const rows = RESOLVE_BUCKETS.map((bucket, i) => ({ bucket, n: counts[i] ?? 0 }));
  const config: ChartConfig = { n: { label: noun, tone: 'muted' } };
  const ticks = countTicks(Math.max(scaleMax ?? 0, ...counts));
  return (
    <Section title={title} {...(buckets !== null && { count: total })}>
      <div className="relative">
        <ChartContainer config={config} className="h-[10.625rem]">
          <BarChart
            data={rows}
            margin={{ top: 14, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={5}
          >
            <ChartGrid />
            <ChartXAxis dataKey="bucket" interval={0} />
            <ChartYAxis ticks={ticks} domain={[0, ticks.at(-1) ?? 1]} />
            <ChartBar dataKey="n" maxBarSize={200}>
              <LabelList dataKey="n" content={<BarValue />} />
            </ChartBar>
            <ChartTooltip />
          </BarChart>
        </ChartContainer>
        {buckets === null ? (
          <ChartNote title="Time to resolve lands here" detail={NOT_RECORDED} />
        ) : (
          total === 0 && <ChartNote title="None resolved this season" />
        )}
      </div>
    </Section>
  );
}

// ── Open support tickets ─────────────────────────────────────────────────────────────────────

const TICKET_INK: Record<SupportCategory, string> = {
  bug: 'var(--fg2)',
  account: 'var(--fg3)',
  other: QUIET_INK,
  safety: 'var(--bad)',
};

const TICKET_LABEL: Record<SupportCategory, string> = {
  bug: 'Bug',
  account: 'Account',
  other: 'Other',
  safety: 'Safety',
};

const TICKET_CONFIG: ChartConfig = {
  bug: { label: 'Bug', tone: 'muted' },
  account: { label: 'Account', tone: 'faint' },
  other: { label: 'Other', tone: 'faint' },
  safety: { label: 'Safety', tone: 'bad' },
};

export const TICKET_LEGEND: LegendItem[] = SUPPORT_CATEGORIES.map((c) => ({
  label: TICKET_LABEL[c],
  ink: TICKET_INK[c],
}));

/** Tickets open at any point of each season day, stacked by kind. */
export function OpenTicketsChart({
  days,
  depth,
}: {
  days: readonly DayKey[];
  depth: ReadonlyArray<Partial<Record<SupportCategory, number>> | null>;
}) {
  const today = days[days.length - 1] ?? '';
  const rows = days.map((day, i) => {
    const d = depth[i] ?? null;
    return {
      day,
      ...Object.fromEntries(SUPPORT_CATEGORIES.map((c) => [c, d === null ? null : (d[c] ?? 0)])),
    };
  });
  const max = Math.max(
    0,
    ...depth.map((d) => (d === null ? 0 : SUPPORT_CATEGORIES.reduce((s, c) => s + (d[c] ?? 0), 0))),
  );
  const start = recordStart(days, depth);
  return (
    <div className="relative">
      <ChartContainer
        config={TICKET_CONFIG}
        className="h-[10.625rem]"
        style={{ '--color-other': QUIET_INK } as CSSProperties}
      >
        <BarChart data={rows} margin={SEASON_MARGIN} barCategoryGap="28%">
          <ChartGrid />
          <ChartXAxis
            dataKey="day"
            ticks={axisTicks(days.length).map((i) => days[i] as DayKey)}
            interval={0}
            tick={<DayTick today={today} />}
          />
          <ChartYAxis ticks={countTicks(max)} />
          {start !== null && <ChartRule x={start} label="Record begins" />}
          {SUPPORT_CATEGORIES.map((c) => (
            <ChartBar key={c} dataKey={c} stackId="open" maxBarSize={18} />
          ))}
          <ChartTooltip labelFormatter={(day) => dayTitle(String(day))} />
        </BarChart>
      </ChartContainer>
      {noneRecorded(depth) && (
        <ChartNote title="Open tickets land here" detail="Not recorded yet" />
      )}
    </div>
  );
}

// ── The column ───────────────────────────────────────────────────────────────────────────────

export function KeepingUp({
  data,
  days,
  now,
  className,
}: {
  data: KeepingUpData;
  days: readonly DayKey[];
  now: number;
  className?: string;
}) {
  // The two histograms share one scale, so a flag bar and a ticket bar compare at a glance.
  const tallest = Math.max(
    ...foldResolveBuckets(data.resolveSeason ?? []),
    ...(data.support === null ? [] : foldResolveBuckets(data.support.resolveSeason ?? [])),
  );
  return (
    <div
      data-slot="metrics-keeping-up"
      className={cn('flex min-w-0 flex-col gap-(--space-5_5)', className)}
    >
      <ColumnHead>Keeping up</ColumnHead>
      <KeepingUpStats data={data} now={now} />
      <Section title="Oldest open flag" end={<ChartLegend items={OLDEST_LEGEND} />}>
        <OldestOpenFlagChart days={days} queue={data.queueByDay} />
      </Section>
      <div
        className={cn(
          'grid gap-x-(--space-7)',
          data.support === null ? 'grid-cols-1' : 'grid-cols-2',
        )}
      >
        <div className="min-w-0">
          <ResolveHistogram
            title="Flags · time to resolve"
            noun="Flags"
            buckets={data.resolveSeason}
            scaleMax={tallest}
          />
        </div>
        {data.support !== null && (
          <div className="min-w-0">
            <ResolveHistogram
              title="Support · time to resolve"
              noun="Tickets"
              buckets={data.support.resolveSeason}
              scaleMax={tallest}
            />
          </div>
        )}
      </div>
      {data.support !== null && (
        <Section title="Open support tickets" end={<ChartLegend items={TICKET_LEGEND} />}>
          <OpenTicketsChart days={days} depth={data.support.depthByDay} />
        </Section>
      )}
    </div>
  );
}
