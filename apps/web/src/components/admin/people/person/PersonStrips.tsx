import { ChartLegend } from '@/components/kit/chart-legend';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { SparkbarSet, Sparkbars } from '@/components/kit/trace-chart';

import { isFailed, type Loadable } from '../../reads/consoleReads';
import { ReadNote } from '../../reads/ReadNote';
import {
  contradictionsFact,
  countText,
  decisionsFact,
  type Fact,
  openFlagsFact,
  overturnedFact,
  type PersonRead,
  plural,
  reportsFact,
  type StaffSeasonRead,
  type StaffStatsRead,
  staffSinceFact,
  type TrendRead,
  timeToDecideFact,
  trendBars,
  trendLabel,
  trustPointsFact,
  weekBars,
  weeksTotal,
} from './personModel';

/**
 * The stat strips: the skater's (every person) and, under it on a staff page, the staffer's. Each
 * cell draws its own read's state — a skeleton in its final box, a dash and *Couldn’t be read* when
 * its read failed (the strip's note under it says so, with *Try again*), or its fact, which may be
 * one of the three answers that are not a number.
 */

/** A failed cell: the dash, and the words — its strip's note carries *Try again*. */
const FAILED: Fact = { value: '—', tone: 'dim', sub: 'Couldn’t be read', state: 'unrecorded' };

function FactTile({ label, fact, slot }: { label: string; fact: Fact | undefined; slot: string }) {
  if (fact === undefined) {
    return <StatTile data-fact={slot} label={label} value="00" sub="Loading" loading />;
  }
  return (
    <StatTile
      data-fact={slot}
      data-state={fact.state}
      label={label}
      value={fact.value}
      {...(fact.unit !== undefined && { unit: fact.unit })}
      tone={fact.tone}
      {...(fact.sub !== undefined && { sub: fact.sub })}
    />
  );
}

/** A fact from a loadable read: `undefined` while loading, the failed fact if it failed. */
function factOf<T>(read: Loadable<T | null>, make: (value: T) => Fact): Fact | undefined {
  if (read === undefined) return undefined;
  if (isFailed(read)) return FAILED;
  if (read === null) return FAILED;
  return make(read as T);
}

/** The columns: the stat cells, then the trend a quarter wider (the boards' strip). */
const columns = (cells: number) => `repeat(${cells}, minmax(0, 1fr)) minmax(0, 1.25fr)`;

const KICK = 'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';

// ── The skater strip ─────────────────────────────────────────────────────────────────────────

export function SkaterStrip({
  person,
  trend,
}: {
  person: PersonRead;
  trend: Loadable<TrendRead | null>;
}) {
  const points = person.strip.trustPoints;
  const cells = points === null ? 3 : 4;
  const trendValue = trend === undefined || isFailed(trend) || trend === null ? null : trend;
  return (
    <div data-slot="skater-strip" className="flex flex-col gap-(--space-2)">
      <StatGrid
        columns={cells + 1}
        style={{ gridTemplateColumns: columns(cells) }}
        className="py-(--space-3)"
      >
        <FactTile
          key="contradictions"
          slot="contradictions"
          label="Contradictions"
          fact={contradictionsFact(person.strip.contradictions)}
        />
        <FactTile
          key="flags"
          slot="open-flags"
          label="Open flags"
          fact={openFlagsFact(person.strip.openFlags, person.pending.includes('flagSubjects'))}
        />
        <FactTile key="reports" slot="reports" label="Reports" fact={factOf(trend, reportsFact)} />
        {points !== null && (
          <FactTile
            key="points"
            slot="trust-points"
            label="Trust points"
            fact={trustPointsFact(points)}
          />
        )}
        <div key="trend" data-fact="report-trend" className="flex min-w-0 flex-col gap-(--space-1)">
          <span className={KICK}>
            {trendValue === null ? 'Reports by month' : trendLabel(trendValue)}
          </span>
          {trendValue === null ? (
            <span className="text-trim text-assist leading-list text-fg3">
              {trend === undefined ? 'Loading' : 'Couldn’t be read'}
            </span>
          ) : (
            <ReportTrend trend={trendValue} />
          )}
        </div>
      </StatGrid>
      <ReadNote reads={[trend]} data-slot="trend-error">
        Their reports couldn’t be read
      </ReadNote>
    </div>
  );
}

/** Kept against hidden, month by month, with the hover plate. */
function ReportTrend({ trend }: { trend: TrendRead }) {
  const bars = trendBars(trend);
  return (
    <div className="flex flex-col gap-(--space-1_5)">
      <SparkbarSet
        length={bars.length}
        aria-label="Reports by month, kept and hidden"
        title={(i) => bars[i]?.title ?? ''}
        rows={(i) => {
          const b = bars[i];
          return b === undefined
            ? []
            : [
                { label: 'Kept', value: b.kept.toLocaleString('en-US') },
                { label: 'Hidden', value: b.hidden.toLocaleString('en-US') },
              ];
        }}
      >
        <Sparkbars
          aria-label="Reports by month"
          values={bars.map((b) => ({ value: b.kept + b.hidden, bad: b.hidden }))}
        />
      </SparkbarSet>
      <ChartLegend
        data-slot="trend-legend"
        items={[
          { label: `${countText(trend.kept)} kept`, ink: 'var(--fg3)' },
          ...(trend.hidden.count > 0
            ? [{ label: `${countText(trend.hidden)} hidden`, ink: 'var(--bad)' }]
            : []),
        ]}
      />
      {trend.monthsCapped && (
        <span data-slot="trend-capped" className="text-assist leading-list text-fg3">
          Older months not all read
        </span>
      )}
    </div>
  );
}

// ── The staff strip ──────────────────────────────────────────────────────────────────────────

export function StaffStrip({
  person,
  stats,
  season,
  now,
  timeZone,
}: {
  person: PersonRead;
  stats: Loadable<StaffStatsRead | null>;
  season: Loadable<StaffSeasonRead | null>;
  now: number;
  timeZone?: string;
}) {
  // Not staff after all (the role moved under the page): no strip.
  if (stats === null) return null;
  const value = stats === undefined || isFailed(stats) ? null : stats;
  const bars = value === null ? [] : weekBars(value, now);
  return (
    <div data-slot="staff-strip" className="flex flex-col gap-(--space-2)">
      <StatGrid columns={5} style={{ gridTemplateColumns: columns(4) }} className="py-(--space-3)">
        <FactTile
          key="decisions"
          slot="decisions"
          label="Decisions"
          fact={factOf(stats, decisionsFact)}
        />
        <FactTile
          key="ttd"
          slot="time-to-decide"
          label="Time to decide"
          fact={factOf(stats, timeToDecideFact)}
        />
        <FactTile
          key="over"
          slot="overturned"
          label="Overturned"
          fact={factOf(season, overturnedFact)}
        />
        <FactTile
          key="since"
          slot="staff-since"
          label="Staff since"
          fact={factOf(stats, (s) => staffSinceFact(s, person.role, now, timeZone))}
        />
        <div
          key="weeks"
          data-fact="decision-weeks"
          className="flex min-w-0 flex-col gap-(--space-1)"
        >
          <span className={KICK}>Decisions · {plural(bars.length || 9, 'week', 'weeks')}</span>
          {value === null ? (
            <span className="text-trim text-assist leading-list text-fg3">
              {stats === undefined ? 'Loading' : 'Couldn’t be read'}
            </span>
          ) : (
            <>
              <SparkbarSet
                length={bars.length}
                aria-label="Decisions each week"
                title={(i) => bars[i]?.title ?? ''}
                rows={(i) => {
                  const b = bars[i];
                  return b === undefined
                    ? []
                    : [
                        {
                          label: 'Decisions',
                          value: countText({ count: b.count, capped: b.capped }),
                        },
                      ];
                }}
              >
                <Sparkbars
                  aria-label="Decisions each week"
                  values={bars.map((b) => b.count)}
                  lightLatest
                />
              </SparkbarSet>
              <span className="text-trim text-assist leading-list text-fg3">
                {weeksTotal(value)}
              </span>
            </>
          )}
        </div>
      </StatGrid>
      <ReadNote reads={[stats, season]} data-slot="staff-error">
        Their staff figures couldn’t be read
      </ReadNote>
    </div>
  );
}
