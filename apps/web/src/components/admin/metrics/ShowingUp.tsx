import { createColumnHelper, metaHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { BarChart, Cell } from 'recharts';

import {
  ChartBar,
  type ChartConfig,
  ChartContainer,
  ChartXAxis,
  ChartYAxis,
} from '@/components/kit/chart';
import { Section } from '@/components/kit/section-slug';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { DataTable, type TableColumnMeta } from '@/components/kit/table';
import { cn } from '@/lib/utils';

import {
  type DayKey,
  dayLabel,
  dayTitle,
  instantLabel,
  type MostReportedRow,
  NOT_RECORDED,
  PULSE_KEYS,
  PULSE_LABELS,
  type PulseKey,
  type PulseSeries,
  pulseSub,
  pulseTicks,
  type ShowingUpData,
  VANTAGE_LABELS,
  type VantageCounts,
  vantageSegments,
} from './metricsModel';
import { ColumnHead, SpanTag, UnrecordedTile } from './metricsParts';

/**
 * Overview › Metrics, the right column: whether people are showing up. The top stats are the last
 * seven days; everything under them is the season.
 */

const KICK = 'text-kick leading-none font-medium tracking-head text-fg3 uppercase';

// ── The stats ────────────────────────────────────────────────────────────────────────────────

export function ShowingUpStats({ week }: { week: ShowingUpData['week'] }) {
  const { reports, accounts, signedIn, contributors } = week;
  return (
    <StatGrid columns={4}>
      {reports === null ? (
        <UnrecordedTile key="reports" label="Reports" />
      ) : (
        <StatTile
          key="reports"
          label="Reports"
          value={reports.count}
          unit="this week"
          sub={reports.people > 0 ? `By ${plural(reports.people, 'person', 'people')}` : undefined}
        />
      )}
      {accounts === null ? (
        <UnrecordedTile key="accounts" label="User accounts" />
      ) : (
        <StatTile
          key="accounts"
          label="User accounts"
          value={accounts.added}
          unit="new this week"
          sub={`${accounts.total.toLocaleString('en-US')} total`}
        />
      )}
      {signedIn === null ? (
        <UnrecordedTile key="signed" label="Signed in" />
      ) : (
        <StatTile
          key="signed"
          label="Signed in"
          value={signedIn.people}
          unit="this week"
          sub={
            signedIn.twoDaysOrMore > 0 ? `${signedIn.twoDaysOrMore} on two days or more` : undefined
          }
        />
      )}
      {contributors === null ? (
        <UnrecordedTile key="contributors" label="Contributors" />
      ) : (
        <StatTile
          key="contributors"
          label="Contributors"
          value={contributors.people}
          unit="this week"
          sub={
            contributors.firstTime > 0 ? `${contributors.firstTime} for the first time` : undefined
          }
        />
      )}
    </StatGrid>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── Each day: the season's pulse ─────────────────────────────────────────────────────────────

/** A strip's bar ink: a zero is a stub in the rule gray, the latest and the hovered day are lit. */
function barInk(value: number | null, latest: boolean, hovered: boolean): string {
  if (value === 0) return hovered ? 'var(--fg2)' : 'var(--line)';
  return latest || hovered ? 'var(--fg)' : 'var(--fg2)';
}

/**
 * The least a strip's scale tops out at: each strip scales to its own busiest day, but a strip
 * whose busiest day is one or two (a hazard, a new account) stands short rather than shouting.
 */
const PULSE_FLOOR = 3;

/** A zero still stands one hair tall, so a day with nothing reads as measured. */
const zeroStub = (value: unknown) => (value === 0 ? 1 : 0);

function Strip({
  pulseKey,
  series,
  days,
  active,
}: {
  pulseKey: PulseKey;
  series: PulseSeries;
  days: readonly DayKey[];
  active: number | null;
}) {
  const rows = days.map((day, i) => ({ day, v: series.daily[i] ?? null }));
  const max = Math.max(PULSE_FLOOR, ...series.daily.map((v) => v ?? 0));
  const config: ChartConfig = { v: { label: PULSE_LABELS[pulseKey], tone: 'muted' } };
  const last = days.length - 1;
  return (
    <ChartContainer config={config} className="h-full p-0">
      <BarChart data={rows} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={1.5}>
        <ChartXAxis dataKey="day" hide />
        <ChartYAxis hide domain={[0, max]} />
        <ChartBar dataKey="v" maxBarSize={400} minPointSize={zeroStub}>
          {rows.map((row, i) => (
            <Cell key={row.day} fill={barInk(row.v, i === last, i === active)} />
          ))}
        </ChartBar>
      </BarChart>
    </ChartContainer>
  );
}

const stripCount = PULSE_KEYS.length;

/**
 * One strip of daily bars per kind of activity, its season total beside it, all on one day axis.
 * Hovering anywhere over the strips — or stepping with ← → once the pulse has focus — draws one
 * hairline through every strip at that day and one plate with each strip's value. The strips are
 * small multiples of the kit `Chart`; the shared hover is the pulse's own, since a chart's tooltip
 * knows only its own series.
 */
export function PulseStrips({
  days,
  pulse,
  defaultActive = null,
}: {
  days: readonly DayKey[];
  pulse: ShowingUpData['pulse'];
  /** A day to show hovered from the start (a board's drawn hover state). */
  defaultActive?: number | null;
}) {
  const [active, setActive] = useState<number | null>(defaultActive);
  const column = useRef<HTMLDivElement>(null);
  const n = days.length;

  const dayAt = (clientX: number): number | null => {
    const box = column.current?.getBoundingClientRect();
    if (!box || box.width === 0 || n === 0) return null;
    const i = Math.floor(((clientX - box.left) / box.width) * n);
    return i >= 0 && i < n ? i : null;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => setActive(dayAt(event.clientX));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step !== undefined && n > 0) {
      event.preventDefault();
      setActive((at) => Math.max(0, Math.min(n - 1, (at ?? n) + step)));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : n - 1);
    } else if (event.key === 'Escape') setActive(null);
  };

  const x = active === null ? 0 : ((active + 0.5) / n) * 100;
  const onRight = active !== null && active < n / 2;
  const ticks = pulseTicks(days);

  return (
    // The pulse is read a day at a time, so to a keyboard and a screen reader it is a slider over
    // the season's days: ← → step, Home and End jump, and the day it rests on is spoken.
    <div
      data-slot="pulse"
      role="slider"
      tabIndex={0}
      aria-label="Each day"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, n - 1)}
      aria-valuenow={active ?? Math.max(0, n - 1)}
      aria-valuetext={n > 0 ? dayTitle(days[active ?? n - 1] as DayKey) : undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setActive(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
      className={cn(
        'relative grid items-end gap-x-(--space-3_5) gap-y-[0.5625rem] outline-none',
        'grid-cols-[6.875rem_minmax(0,1fr)_4rem]',
        'focus-visible:shadow-focus',
      )}
    >
      {PULSE_KEYS.map((key, r) => {
        const series = pulse[key];
        const row = { gridRow: r + 1 };
        return (
          <div key={key} className="contents" data-slot="pulse-strip" data-key={key}>
            <span className={cn(KICK, 'pb-[0.125rem]')} style={{ ...row, gridColumn: 1 }}>
              {PULSE_LABELS[key]}
            </span>
            <div
              data-slot="pulse-bars"
              data-recorded={series === null ? 'false' : 'true'}
              className="h-[1.875rem] min-w-0 border-0 border-b-(length:--stroke-hair) border-solid border-line2"
              style={{ ...row, gridColumn: 2 }}
            >
              {series === null ? (
                <span
                  data-slot="pulse-note"
                  className="flex h-full items-end pb-(--space-1) text-assist leading-none text-fg3"
                >
                  {NOT_RECORDED}
                </span>
              ) : (
                <Strip pulseKey={key} series={series} days={days} active={active} />
              )}
            </div>
            <span
              data-slot="pulse-total"
              className="flex flex-col items-end gap-[0.1875rem] text-right"
              style={{ ...row, gridColumn: 3 }}
            >
              <span
                className={cn(
                  'font-(family-name:--family-mono) text-[0.9375rem] leading-none font-medium tracking-value tabular-nums',
                  series === null ? 'text-fg3' : 'text-fg',
                )}
              >
                {series === null ? '—' : series.total.toLocaleString('en-US')}
              </span>
              {series !== null && (
                <small className="text-kick leading-[1.3] text-fg3">{pulseSub(key, series)}</small>
              )}
            </span>
          </div>
        );
      })}
      <div
        data-slot="pulse-axis"
        className="-mt-1 flex justify-between"
        style={{ gridRow: stripCount + 1, gridColumn: 2 }}
      >
        {ticks.map((day) => (
          <span
            key={day}
            className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
          >
            {dayLabel(day)}
          </span>
        ))}
      </div>
      <div
        ref={column}
        aria-hidden={active === null}
        className="pointer-events-none relative self-stretch"
        style={{ gridRow: `1 / span ${stripCount}`, gridColumn: 2 }}
      >
        {active !== null && days[active] !== undefined && (
          <>
            <span
              data-slot="pulse-hairline"
              className="absolute -top-1 bottom-0 w-(--stroke-hair) bg-fg2"
              style={{ left: `${x}%` }}
            />
            <div
              data-slot="pulse-plate"
              role="status"
              className={cn(
                'absolute -top-1 z-(--z-raised) grid w-max grid-cols-[auto_auto] gap-x-(--space-4_5) gap-y-(--space-1_5)',
                'px-(--space-3) py-(--space-2_5)',
                'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
              )}
              style={
                onRight
                  ? { left: `calc(${x}% + var(--space-2_5))` }
                  : { right: `calc(${100 - x}% + var(--space-2_5))` }
              }
            >
              <span
                data-slot="pulse-plate-title"
                className="col-span-2 text-kick leading-none font-medium tracking-head text-fg uppercase"
              >
                {dayTitle(days[active] as DayKey)}
              </span>
              {PULSE_KEYS.map((key) => {
                const value = pulse[key]?.daily[active] ?? null;
                return (
                  <span key={key} className="contents">
                    <span className="text-assist leading-none whitespace-nowrap text-fg2">
                      {PULSE_LABELS[key]}
                    </span>
                    <b
                      data-slot="pulse-plate-value"
                      className="text-right font-(family-name:--family-mono) text-mono-sm leading-none font-medium tracking-value text-fg tabular-nums"
                    >
                      {value === null ? '—' : value.toLocaleString('en-US')}
                    </b>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Reports by vantage ───────────────────────────────────────────────────────────────────────

const VANTAGE_INK: Record<keyof typeof VANTAGE_LABELS, string> = {
  on_ice: 'var(--fg)',
  shore: 'var(--fg3)',
  secondhand: 'var(--line)',
  unstated: 'transparent',
};

/**
 * How the season's reports saw the ice: one bar split by vantage, then each vantage's count. Reports
 * from before vantage was asked state none; they are drawn hollow, and only when there are some.
 */
export function VantageSplit({ counts }: { counts: VantageCounts | null }) {
  if (counts === null) {
    return (
      <div data-slot="vantage" data-unrecorded="" className="flex flex-col gap-(--space-2_5)">
        <i aria-hidden="true" className="block h-[1.375rem] bg-line" />
        <span className="text-assist leading-none text-fg3">{NOT_RECORDED}</span>
      </div>
    );
  }
  const segments = vantageSegments(counts);
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  return (
    <div data-slot="vantage" className="flex flex-col gap-(--space-2_5)">
      <div
        role="img"
        aria-label={segments.map((s) => `${VANTAGE_LABELS[s.key]} ${s.count}`).join(', ')}
        className="flex h-[1.375rem] gap-[0.125rem]"
      >
        {total === 0 ? (
          <i className="block flex-1 bg-line" />
        ) : (
          segments
            .filter((s) => s.count > 0)
            .map((s) => (
              <i
                key={s.key}
                data-slot="vantage-segment"
                data-key={s.key}
                className={cn(
                  'block min-w-[0.1875rem]',
                  s.key === 'unstated' && 'border border-solid border-line2',
                )}
                style={{ flexGrow: s.count, flexBasis: 0, background: VANTAGE_INK[s.key] }}
              />
            ))
        )}
      </div>
      <dl className="m-0 flex gap-(--space-7)">
        {segments.map((s) => (
          <div key={s.key} className="flex flex-col gap-[0.3125rem]">
            <dt
              className={cn(KICK, 'flex items-center gap-[0.4375rem] font-semibold tracking-kick')}
            >
              <i
                aria-hidden="true"
                className={cn(
                  'inline-block size-[0.5625rem]',
                  s.key === 'unstated' && 'border border-solid border-line2',
                )}
                style={{ background: VANTAGE_INK[s.key] }}
              />
              {VANTAGE_LABELS[s.key]}
            </dt>
            <dd className="m-0 font-(family-name:--family-mono) text-[0.9375rem] leading-none font-medium text-fg tabular-nums">
              {s.count.toLocaleString('en-US')}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── Most-reported ────────────────────────────────────────────────────────────────────────────

const mostFeatures = tableFeatures({ columnMeta: metaHelper<TableColumnMeta>() });
const mostColumn = createColumnHelper<typeof mostFeatures, MostReportedRow>();

function mostColumns(timeZone: string | undefined) {
  return mostColumn.columns([
    mostColumn.accessor('name', { header: 'Body', meta: { lead: true } }),
    mostColumn.accessor('reports', {
      header: 'Reports',
      cell: (c) => <span className="text-fg">{c.getValue()}</span>,
      meta: { align: 'end', mono: true, width: '5.125rem' },
    }),
    mostColumn.accessor('photos', {
      header: 'Photos',
      meta: { align: 'end', mono: true, width: '5.125rem' },
    }),
    mostColumn.accessor('people', {
      header: 'People',
      meta: { align: 'end', mono: true, width: '5.125rem' },
    }),
    mostColumn.accessor('lastReportAt', {
      header: 'Last report',
      cell: (c) => instantLabel(c.getValue(), timeZone),
      meta: { align: 'end', mono: true, width: '7.25rem' },
    }),
  ]);
}

/** The season's most-reported bodies, most first (the read ranks them). */
export function MostReported({
  rows,
  timeZone,
}: {
  /** `null` before a read ranks the season's bodies. */
  rows: MostReportedRow[] | null;
  timeZone?: string;
}) {
  const table = useTable({
    features: mostFeatures,
    columns: mostColumns(timeZone),
    data: rows ?? [],
    getRowId: (row) => row.bodyId,
  });
  return (
    <DataTable
      table={table}
      inset
      stickyHeader={false}
      className="px-0"
      empty={rows === null ? NOT_RECORDED : 'No reports this season'}
    />
  );
}

// ── The column ───────────────────────────────────────────────────────────────────────────────

export function ShowingUp({
  data,
  days,
  timeZone,
  pulseActive,
  className,
}: {
  data: ShowingUpData;
  days: readonly DayKey[];
  timeZone?: string;
  /** A pulse day to show hovered from the start (a board's drawn hover). */
  pulseActive?: number | null;
  className?: string;
}) {
  return (
    <div
      data-slot="metrics-showing-up"
      className={cn('flex min-w-0 flex-col gap-(--space-5_5)', className)}
    >
      <ColumnHead>Showing up</ColumnHead>
      <ShowingUpStats week={data.week} />
      <Section title="Each day">
        <PulseStrips days={days} pulse={data.pulse} defaultActive={pulseActive ?? null} />
      </Section>
      <Section title="Reports by vantage" end={<SpanTag>This season</SpanTag>}>
        <VantageSplit counts={data.vantage} />
      </Section>
      <Section title="Most-reported" end={<SpanTag>This season</SpanTag>}>
        <MostReported rows={data.mostReported} timeZone={timeZone} />
      </Section>
    </div>
  );
}
