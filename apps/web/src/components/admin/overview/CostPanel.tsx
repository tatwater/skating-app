import type { ComponentProps } from 'react';
import { BarChart } from 'recharts';

import { ChartBar, type ChartConfig, ChartContainer, ChartTooltip } from '@/components/kit/chart';
import { ChartNote } from '@/components/kit/chart-legend';
import { Meter } from '@/components/kit/meter';
import { Section } from '@/components/kit/section-slug';
import { StatTile } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';

import { RowLink } from './CountCard';
import { type CostData, type CostMonth, dollars } from './overviewData';
import { monthName } from './overviewModel';

/**
 * Home's cost: what each service has cost this season and how near its free tier's ceiling it
 * runs, then the spend by month — always the last three full months and this one, stacked by
 * service. The ledger has the rest.
 */

// ── This season, by service ──────────────────────────────────────────────────────────────────

type CostSectionProps = Omit<ComponentProps<'section'>, 'title' | 'children'> & {
  /** `undefined` while it loads; `null` until a read serves the ledger (no link to a ledger yet). */
  data: CostData | null | undefined;
};

export function CostSection({ data, className, ...props }: CostSectionProps) {
  if (data === null) {
    return (
      <Section title="Cost · this season" data-slot="cost-section" className={className} {...props}>
        <p data-slot="cost-absent" className="m-0 text-assist leading-none text-fg3">
          Not recorded yet
        </p>
      </Section>
    );
  }
  return (
    <Section
      title="Cost · this season"
      end={
        <RowLink to={{ kind: 'ledger' }} inRow={false}>
          Ledger
        </RowLink>
      }
      data-slot="cost-section"
      className={className}
      {...props}
    >
      <div
        data-slot="cost-services"
        className="grid grid-cols-2 gap-x-(--space-8) gap-y-(--space-5_5)"
      >
        {data === undefined
          ? ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => (
              <StatTile key={k} loading label=" " value="$00.00" sub="Loading" />
            ))
          : data.services.map((service) => (
              <div
                key={service.id}
                data-slot="cost-service"
                className="flex flex-col gap-(--space-1)"
              >
                <StatTile
                  label={service.label}
                  value={service.amount ?? 'free'}
                  tone={service.amount === null ? 'dim' : 'default'}
                  sub={service.sub}
                />
                {service.meter && (
                  <Meter
                    aria-label={service.meter.label}
                    value={service.meter.value}
                    max={service.meter.max}
                    // Amber from 70 % of the ceiling (Machinery's line); red at it.
                    warnAt={service.meter.max * 0.7}
                    badAt={service.meter.max}
                  />
                )}
              </div>
            ))}
      </div>
    </Section>
  );
}

// ── By month ─────────────────────────────────────────────────────────────────────────────────

const SPEND: ChartConfig = {
  hosting: { label: 'Hosting', tone: 'muted', format: dollars },
  ai: { label: 'AI', tone: 'faint', format: dollars },
  compute: { label: 'Compute', tone: 'lead', format: dollars },
};

/** The legend: each series' word and its swatch, in the same ink the chart maps its tone to. */
const LEGEND = [
  { key: 'hosting', label: 'Hosting', swatch: 'bg-fg2' },
  { key: 'ai', label: 'AI', swatch: 'bg-fg3' },
  { key: 'compute', label: 'Compute', swatch: 'bg-fg' },
] as const;

/** The legend at the section's end: a square and a word per service. */
function SpendLegend() {
  return (
    <span data-slot="spend-legend" className="flex items-center gap-(--space-3_5)">
      {LEGEND.map(({ key, label, swatch }) => (
        <span
          key={key}
          className="inline-flex items-center gap-(--space-1_5) font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase"
        >
          <span aria-hidden="true" className={cn('size-(--space-2) shrink-0', swatch)} />
          {label}
        </span>
      ))}
    </span>
  );
}

const monthTotal = (m: CostMonth) => m.hosting + m.ai + m.compute;

type MonthlySpendProps = Omit<ComponentProps<'section'>, 'title' | 'children'> & {
  /** `undefined` while it loads; `null` until a read serves the ledger. */
  months: readonly CostMonth[] | null | undefined;
};

/**
 * The spend by month: one stacked bar per month, filling its column, heights as shares of the
 * tallest month; under each, its month and total. The bars grow to whatever height the page leaves
 * them. Hovering a bar shows the month's split.
 */
export function MonthlySpend({ months, className, ...props }: MonthlySpendProps) {
  const rows = (months ?? []).map((m) => ({ ...m, name: monthName(m.at) }));
  return (
    <Section
      title="By month"
      end={<SpendLegend />}
      data-slot="monthly-spend"
      aria-busy={months === undefined || undefined}
      className={cn('min-h-0', className)}
      {...props}
    >
      <div className="relative flex min-h-[3.75rem] flex-1 flex-col">
        {months === null && (
          <ChartNote title="Spend by month lands here" detail="Not recorded yet" />
        )}
        <ChartContainer
          config={SPEND}
          // The chart's bands are the label columns plus half a gap each side, so the bars line up
          // with the labels under them and run flush to the section's edges.
          className="-mx-[0.6875rem] h-auto min-h-0 w-auto flex-1 p-0"
        >
          <BarChart
            data={rows}
            margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={11}
          >
            <ChartTooltip labelFormatter={(label) => label} />
            <ChartBar dataKey="hosting" stackId="month" maxBarSize={10_000} />
            <ChartBar dataKey="ai" stackId="month" maxBarSize={10_000} />
            <ChartBar dataKey="compute" stackId="month" maxBarSize={10_000} />
          </BarChart>
        </ChartContainer>
        <ol
          data-slot="spend-labels"
          className="m-0 grid list-none gap-x-(--space-5_5) p-0"
          style={{ gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(0, 1fr))` }}
        >
          {rows.map((m) => {
            const total = monthTotal(m);
            return (
              <li
                key={m.at}
                className="flex items-baseline justify-between border-t border-solid border-line2 pt-(--space-1_5)"
              >
                <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
                  {m.name}
                </span>
                <b
                  className={cn(
                    'font-(family-name:--family-mono) text-assist leading-none font-medium tracking-value tabular-nums',
                    total === 0 ? 'text-fg3' : 'text-fg',
                  )}
                >
                  {dollars(total)}
                </b>
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}
