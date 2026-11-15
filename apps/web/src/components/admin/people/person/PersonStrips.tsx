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
  tenureLabel,
  timeToDecideFact,
  trendBars,
  trendLabel,
  trustPointsFact,
  weekBars,
  weeksTotal,
} from './personModel';
import { WORDS } from './personWords';

/**
 * The stat strips: the skater's (every person) and, under it on a staff page, the staffer's. Each
 * cell draws its own read's state — a skeleton in its final box, a dash and *Couldn’t be read* when
 * its read failed (the strip's note under it says so, with *Try again*), or its fact, which may be
 * one of the three answers that are not a number.
 */

/** A failed cell: the dash, and the words — its strip's note carries *Try again*. */
const FAILED: Fact = { value: '—', tone: 'dim', sub: WORDS.couldNotRead, state: 'unrecorded' };

function FactTile({ label, fact, slot }: { label: string; fact: Fact | undefined; slot: string }) {
  if (fact === undefined) {
    return <StatTile data-fact={slot} label={label} value="00" sub={WORDS.loading} loading />;
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

/**
 * A cell whose read answered `null` — nothing on record for this person (the reads answer `null`
 * for an id with no account, and the staff reads for someone not on staff). Not a failure: there is
 * nothing to try again.
 */
const UNRECORDED: Fact = { value: '—', tone: 'dim', sub: WORDS.notRecorded, state: 'unrecorded' };

/**
 * A fact from a loadable read: `undefined` while loading, the failed fact (whose strip note offers
 * *Try again*) only when the read failed, and *Not recorded yet* when it answered `null`.
 */
function factOf<T>(read: Loadable<T | null>, make: (value: T) => Fact): Fact | undefined {
  if (read === undefined) return undefined;
  if (isFailed(read)) return FAILED;
  if (read === null) return UNRECORDED;
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
            {trendValue === null ? WORDS.reportsByMonth : trendLabel(trendValue)}
          </span>
          {trendValue === null ? (
            <span className="text-trim text-assist leading-list text-fg3">
              {/* A read that answered `null` has nothing on record — never a failure. */}
              {trend === undefined
                ? WORDS.loading
                : trend === null
                  ? WORDS.notRecorded
                  : WORDS.couldNotRead}
            </span>
          ) : (
            <ReportTrend trend={trendValue} />
          )}
        </div>
      </StatGrid>
      <ReadNote reads={[trend]} data-slot="trend-error">
        {WORDS.reportsFailed}
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
                { label: WORDS.kept, value: b.kept.toLocaleString('en-US') },
                { label: WORDS.hidden, value: b.hidden.toLocaleString('en-US') },
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
          {WORDS.olderMonthsUnread}
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
  // Not staff after all (the role moved under the page): either staff read answering `null` says
  // so — the staff reads answer `null` for someone not on staff, never for a failure — so no strip.
  if (stats === null || season === null) return null;
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
          label={tenureLabel(person.role)}
          fact={factOf(stats, (s) => staffSinceFact(s, person.role, now, timeZone).fact)}
        />
        <div
          key="weeks"
          data-fact="decision-weeks"
          className="flex min-w-0 flex-col gap-(--space-1)"
        >
          <span className={KICK}>Decisions · {plural(bars.length || 9, 'week', 'weeks')}</span>
          {value === null ? (
            <span className="text-trim text-assist leading-list text-fg3">
              {stats === undefined ? WORDS.loading : WORDS.couldNotRead}
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
                          label: WORDS.decisions,
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
        {WORDS.staffFailed}
      </ReadNote>
    </div>
  );
}
