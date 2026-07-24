import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';
import { ChartEmpty, MiniTable, TrendBars } from '../charts/Charts';

/**
 * The tenure-aware good-vs-bad trend (D57) — the contributor-trust panel's chart, moderator-visible
 * because restricting a posting right is a moderator's lever.
 *
 * Tenure is the whole point: a `contradictionCount` of 3 means opposite things for a ten-year
 * contributor with a long green history and a one-month account with five reports. So this pairs the
 * per-month good-vs-bad bars with the account's age, stated in words next to the chart, so the two
 * cases are impossible to confuse at a glance. The raw reputation number is deliberately absent (D50
 * keeps it admin-only, and the server doesn't return it here).
 */
export function ContributorTrend({ userId }: { userId: Id<'profiles'> }) {
  const trend = useQuery(api.analytics.contributorTrend, { userId });

  if (trend === undefined) {
    return <ChartEmpty>Loading trend…</ChartEmpty>;
  }
  if (trend === null) {
    return <ChartEmpty>No trend available.</ChartEmpty>;
  }

  const ageDays = Math.max(
    0,
    Math.round((Date.now() - trend.accountCreatedAt) / (24 * 60 * 60 * 1000)),
  );
  const ageLabel =
    ageDays < 60
      ? `${ageDays} days`
      : ageDays < 730
        ? `${Math.round(ageDays / 30)} months`
        : `${Math.round(ageDays / 365)} years`;
  const hasHistory = trend.months.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-foreground-muted text-xs">
        Account age <span className="font-medium text-foreground">{ageLabel}</span>. Good = reports
        corroborated or thumbed net-helpful; bad = settled contradictions + upheld safety flags.
        Read the <span className="font-medium text-foreground">shape against the age</span> — a
        stray bad month reads very differently on a long green history than on a short one.
        {trend.truncated ? ' Showing the most recent history only.' : ''}
      </p>
      {hasHistory ? (
        <>
          <TrendBars data={trend.months} />
          <details className="text-xs">
            <summary className="cursor-pointer text-foreground-muted hover:text-foreground">
              View as table
            </summary>
            <div className="mt-2 overflow-x-auto">
              <MiniTable
                headers={['Month', 'Good', 'Bad', 'Total']}
                rows={trend.months.map((m) => [m.month, m.good, m.bad, m.total])}
              />
            </div>
          </details>
        </>
      ) : (
        <ChartEmpty>No reports yet — nothing to trend.</ChartEmpty>
      )}
    </div>
  );
}
