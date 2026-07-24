/**
 * `metricSnapshots` write helpers (Phase 7b / D37) — the only sanctioned way a number enters the
 * operator surface.
 *
 * Two writers, deliberately kept apart:
 *   - `bumpMetricCounter` — **maintain-on-write**, called from the event site for the metrics whose
 *     events leave nothing behind to sweep for (a weather-explained contradiction is a `continue`; a
 *     truncated viewport is a `console.warn`). Forward-only by construction.
 *   - `writeMetricSnapshot` — **sweep-by-cron**, called from the daily rollup for the metrics whose
 *     source rows are still on disk and can be re-derived (and therefore backfilled).
 *
 * Both upsert on `(metric, date)`, so a re-run of the daily job is idempotent and a counter bump is
 * additive. This is the Phase-4 contribution-counter pattern (`bumpContributionCount`) generalized:
 * maintain the aggregate as it happens rather than reconstructing it from the corpus at read time.
 *
 * **Never throw.** Analytics is instrumentation hung off real user-facing paths, and a metric write
 * failing must never fail a bounty create or a contradiction settle. Every helper here is total: a
 * bad key is logged and dropped, not raised.
 */

import { METRICS, type MetricKey, metricDay } from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** The payload half of a snapshot row — whichever shape the metric's spec declares. */
export interface MetricPayload {
  scalar?: number;
  buckets?: number[];
  meta?: unknown;
}

/** Guard against a typo'd key silently creating a metric nothing renders. */
function isKnownMetric(metric: string): metric is MetricKey {
  return metric in METRICS;
}

/** The existing row for `(metric, date)`, if the day has been written yet. */
async function findSnapshot(
  ctx: QueryCtx,
  metric: string,
  date: string,
): Promise<Doc<'metricSnapshots'> | null> {
  return ctx.db
    .query('metricSnapshots')
    .withIndex('by_metric_date', (q) => q.eq('metric', metric).eq('date', date))
    .unique();
}

/**
 * Add `delta` to a counter metric's running total for the UTC day containing `at` (default now).
 *
 * Additive rather than set-valued so concurrent event sites can't clobber each other's contribution,
 * and so a bump is safe to call from anywhere on a hot path. `delta: 0` is a no-op that still won't
 * create an empty row — a day with no events should read as a generated zero from the chart's day
 * range, not as a row asserting we measured it.
 */
export async function bumpMetricCounter(
  ctx: MutationCtx,
  metric: MetricKey,
  delta = 1,
  at: number = Date.now(),
): Promise<void> {
  if (delta === 0) return;
  if (!isKnownMetric(metric)) {
    console.warn(`bumpMetricCounter: unknown metric "${metric}" — dropped.`);
    return;
  }
  const date = metricDay(at);
  const existing = await findSnapshot(ctx, metric, date);
  if (existing) {
    await ctx.db.patch(existing._id, {
      scalar: (existing.scalar ?? 0) + delta,
      updatedAt: Date.now(),
    });
    return;
  }
  await ctx.db.insert('metricSnapshots', {
    metric,
    date,
    scalar: delta,
    updatedAt: Date.now(),
  });
}

/**
 * Add `delta` to one key of a `meta`-shaped counter (e.g. flag dispositions by reason, weather-strip
 * renders by fresh/aged). Same additivity guarantee as the scalar bump, one level down: the record is
 * read, the single key incremented, and the whole record written back.
 */
export async function bumpMetricMetaCounter(
  ctx: MutationCtx,
  metric: MetricKey,
  key: string,
  delta = 1,
  at: number = Date.now(),
): Promise<void> {
  if (delta === 0) return;
  if (!isKnownMetric(metric)) {
    console.warn(`bumpMetricMetaCounter: unknown metric "${metric}" — dropped.`);
    return;
  }
  const date = metricDay(at);
  const existing = await findSnapshot(ctx, metric, date);
  const prior = (existing?.meta ?? {}) as Record<string, number>;
  const meta = { ...prior, [key]: (prior[key] ?? 0) + delta };
  if (existing) {
    await ctx.db.patch(existing._id, { meta, updatedAt: Date.now() });
    return;
  }
  await ctx.db.insert('metricSnapshots', { metric, date, meta, updatedAt: Date.now() });
}

/**
 * Write (or overwrite) a rollup metric's value for a day — the cron's writer. Overwriting rather than
 * accumulating is what makes the daily job **idempotent and re-runnable**: recomputing yesterday from
 * the same source rows must land on the same number, which is also what lets the backfill replay
 * history through the exact same code path as the live job.
 */
export async function writeMetricSnapshot(
  ctx: MutationCtx,
  metric: MetricKey,
  date: string,
  payload: MetricPayload,
): Promise<void> {
  if (!isKnownMetric(metric)) {
    console.warn(`writeMetricSnapshot: unknown metric "${metric}" — dropped.`);
    return;
  }
  const now = Date.now();
  const fields = {
    ...(payload.scalar !== undefined ? { scalar: payload.scalar } : {}),
    ...(payload.buckets !== undefined ? { buckets: payload.buckets } : {}),
    ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
    updatedAt: now,
  };
  const existing = await findSnapshot(ctx, metric, date);
  if (existing) {
    // `replace` rather than `patch`: a rollup that no longer produces (say) a `meta` must not leave
    // the previous run's stale one behind on the row.
    await ctx.db.replace(existing._id, { metric, date, ...fields });
    return;
  }
  await ctx.db.insert('metricSnapshots', { metric, date, ...fields });
}
