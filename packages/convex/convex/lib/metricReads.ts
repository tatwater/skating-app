/**
 * Reading `metricSnapshots` for the console (B01): one metric's latest row, or its rows over a run of
 * days. Every read is one `by_metric_date` range, bounded by the days asked for — a season is at most
 * 366 rows of one metric.
 */

import type { MetricKey } from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

type Snapshot = Doc<'metricSnapshots'>;

/** A metric's newest row, whatever day it was written for; `null` if it never has been. */
export async function latestMetric(ctx: QueryCtx, metric: MetricKey): Promise<Snapshot | null> {
  return ctx.db
    .query('metricSnapshots')
    .withIndex('by_metric_date', (q) => q.eq('metric', metric))
    .order('desc')
    .first();
}

/**
 * A metric's rows over `days` (ascending metric days, as `seasonRecordWindow` and `lastDays` give
 * them), aligned with `days`: a day no row was written for is `null` — not recorded, never zero.
 */
export async function metricOverDays(
  ctx: QueryCtx,
  metric: MetricKey,
  days: readonly string[],
): Promise<Array<Snapshot | null>> {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return [];
  const rows = await ctx.db
    .query('metricSnapshots')
    .withIndex('by_metric_date', (q) => q.eq('metric', metric).gte('date', first).lte('date', last))
    .take(days.length);
  const byDay = new Map(rows.map((r) => [r.date, r]));
  return days.map((day) => byDay.get(day) ?? null);
}

/** The newest row of a metric dated on one of `days`, or `null`. */
export async function latestMetricIn(
  ctx: QueryCtx,
  metric: MetricKey,
  days: readonly string[],
): Promise<Snapshot | null> {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return null;
  return ctx.db
    .query('metricSnapshots')
    .withIndex('by_metric_date', (q) => q.eq('metric', metric).gte('date', first).lte('date', last))
    .order('desc')
    .first();
}
