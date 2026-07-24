/**
 * Operator analytics (Phase 7b / D37) — the client-reported signals and, alongside them, the read side
 * the `/admin` charts consume.
 *
 * Most metrics are written server-side (see `lib/metrics.ts`): a counter at the event site, or a bounded
 * daily aggregate from the cron. **One isn't observable there at all**, and this module is where it comes
 * in from the client — the **future-skate-time rejection rate**. `reports.create` rejects by throwing,
 * and a thrown Convex mutation rolls its writes back, so the mutation can never count its own
 * rejections. (The bounty gate solves exactly this by returning a verdict instead of throwing; doing the
 * same to `reports.create` would ripple through the offline draft queue on both apps for a low-priority
 * stat, which isn't a trade worth making.) The client already handles the error, so it reports it.
 *
 * **This is an advisory number, deliberately.** It's client-asserted, so a determined caller can inflate
 * it. That's acceptable *here* and nowhere else: the allowlist admits exactly one counter that feeds
 * nothing but an admin chart, a bump touches one row per metric per day (so there's no growth vector),
 * and the caller must be authenticated. Nothing that gates content, trust, or moderation may ever be
 * reported this way.
 *
 * The D5 **viewport truncation** count deliberately does *not* come through here. `listInViewport` knows
 * when it capped a wide zoom but is a query and can't write, and the client can't infer it either — the
 * post-query bbox/listing refinement drops rows, so a truncated read usually comes back *under* the cap
 * and a count-based check would silently undercount. It stays a server log, and the tunable view of the
 * same question is the `zoom_band_distribution` rollup: how many bodies the displayScore curve makes
 * eligible at each zoom, which is what you'd actually move.
 */

import {
  bucketLabels,
  METRIC_SPECS,
  METRICS,
  type MetricKey,
  metricDay,
  metricDayRange,
  metricDayStart,
} from '@skating/core';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireProfile, requireRole } from './lib/auth';
import { bumpMetricCounter } from './lib/metrics';
import { tallyThumbs } from './lib/reputation';

/**
 * The only metrics a client may report. Kept as an explicit allowlist rather than "any counter key" so
 * the channel can't be widened by accident into a way to write arbitrary analytics from a browser.
 */
const CLIENT_SIGNALS = ['report_rejected_future_skate'] as const satisfies readonly MetricKey[];

/**
 * Record one client-observed signal against today's counter. Authenticated, allowlisted, and additive —
 * see the module note on why this one is client-reported and why that's contained.
 */
export const recordClientSignal = mutation({
  args: { signal: v.union(...CLIENT_SIGNALS.map((s) => v.literal(s))) },
  handler: async (ctx, { signal }) => {
    await requireProfile(ctx);
    await bumpMetricCounter(ctx, signal);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Read side — every chart in `/admin` comes through here
// ─────────────────────────────────────────────────────────────────────────────

/** How far back a series read may reach. A year of daily rows is 365 reads — bounded and cheap. */
const MAX_SERIES_DAYS = 365;
/** Default window for the dashboard's trend charts. */
const DEFAULT_SERIES_DAYS = 30;

/** One day of a metric, as the chart layer consumes it. */
interface MetricPoint {
  date: string;
  scalar: number | null;
  buckets: number[] | null;
  meta: Record<string, number> | null;
}

/**
 * A metric's daily series over a trailing window, **gap-filled** from a generated day range rather than
 * returned as whatever rows happen to exist. A day nobody wrote is a real zero (or a real "not
 * measured"), and collapsing it out of the axis would quietly turn a flat week into a dense one.
 */
export const series = query({
  args: { metrics: v.array(v.string()), days: v.optional(v.number()) },
  handler: async (ctx, { metrics, days }) => {
    await requireRole(ctx, 'admin');
    const now = Date.now();
    const window = Math.min(Math.max(1, days ?? DEFAULT_SERIES_DAYS), MAX_SERIES_DAYS);
    const dates = metricDayRange(now, window);
    const from = dates[0] as string;
    const to = dates[dates.length - 1] as string;

    const out: Record<string, MetricPoint[]> = {};
    for (const metric of metrics) {
      if (!(metric in METRICS)) continue; // unknown key ⇒ omitted, not an error the chart has to handle
      const rows = await ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) =>
          q.eq('metric', metric).gte('date', from).lte('date', to),
        )
        .collect();
      const byDate = new Map(rows.map((r) => [r.date, r]));
      out[metric] = dates.map((date) => toPoint(date, byDate.get(date)));
    }
    return { dates, series: out };
  },
});

function toPoint(date: string, row: Doc<'metricSnapshots'> | undefined): MetricPoint {
  return {
    date,
    scalar: row?.scalar ?? null,
    buckets: row?.buckets ?? null,
    meta: (row?.meta as Record<string, number> | undefined) ?? null,
  };
}

/**
 * The **latest** value of each requested metric — the shape the histograms and the per-type tables
 * want, which are snapshots of a current distribution rather than a trend. Reads backwards from today
 * over a short lookback so a metric whose rollup hasn't run yet today still renders yesterday's figure
 * (with the date it came from, so the UI can say so) instead of an empty chart.
 */
export const latest = query({
  args: { metrics: v.array(v.string()), lookbackDays: v.optional(v.number()) },
  handler: async (ctx, { metrics, lookbackDays }) => {
    await requireRole(ctx, 'admin');
    const now = Date.now();
    const window = Math.min(Math.max(1, lookbackDays ?? 7), MAX_SERIES_DAYS);
    const dates = metricDayRange(now, window);
    const from = dates[0] as string;
    const to = dates[dates.length - 1] as string;

    const out: Record<string, MetricPoint | null> = {};
    for (const metric of metrics) {
      if (!(metric in METRICS)) continue;
      const rows = await ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) =>
          q.eq('metric', metric).gte('date', from).lte('date', to),
        )
        .collect();
      const newest = rows.at(-1); // the index orders by date ascending
      out[metric] = newest ? toPoint(newest.date, newest) : null;
    }
    return out;
  },
});

/**
 * The metric catalogue — label, description, shape, and (for histograms) the axis labels derived from
 * the bucket edges. Served rather than imported directly by the web app so a chart's axis can never
 * drift from the edges the rollup actually bucketed against.
 */
export const catalogue = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'admin');
    return Object.entries(METRIC_SPECS).map(([key, spec]) => ({
      key: key as MetricKey,
      label: spec.label,
      description: spec.description,
      kind: spec.kind,
      shape: spec.shape,
      ...(spec.edges ? { bucketLabels: bucketLabels(spec.edges) } : {}),
    }));
  },
});

/** Hard ceiling on the gate-event scan behind the suppression scatter — one screen of dots, bounded. */
const GATE_EVENT_SCAN_CAP = 1000;

/**
 * The bounty-suppression scatter (roadmap D56 §7c): one dot per attempt over a trailing window, plotting
 * *report age at the attempt* against *the freshness window actually applied*. Dots above the diagonal
 * were blocked, below were allowed — and the vertical spread of the line itself shows how far trust and
 * thumbs are stretching the base `FRESH_REPORT_HOURS`.
 *
 * Reads raw `bountyGateEvents` rather than a snapshot because a scatter *is* the individual points; the
 * scan is capped and the window bounded, and the table is pruned by the daily cron, so the cost stays
 * flat. `requesterId` is deliberately **not** returned — the chart is about the constant, and the
 * per-requester question is answered by the cap-hit rate, not by putting names on a graph.
 */
export const bountyGateScatter = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    await requireRole(ctx, 'admin');
    const now = Date.now();
    const window = Math.min(Math.max(1, days ?? DEFAULT_SERIES_DAYS), MAX_SERIES_DAYS);
    const since = metricDayStart(metricDay(now - (window - 1) * 24 * 60 * 60 * 1000));

    const events = await ctx.db
      .query('bountyGateEvents')
      .withIndex('by_created_at', (q) => q.gte('createdAt', since))
      .take(GATE_EVENT_SCAN_CAP);
    const truncated = events.length === GATE_EVENT_SCAN_CAP;
    if (truncated) {
      // Never a silent cap (D5): the chart is told, and says so, rather than quietly plotting a slice.
      console.warn(
        `analytics.bountyGateScatter hit the ${GATE_EVENT_SCAN_CAP}-row cap; the scatter shows the oldest slice of the window.`,
      );
    }

    return {
      truncated,
      points: events
        .filter((e) => e.reportAgeH !== undefined && e.appliedWindowH !== undefined)
        .map((e) => ({
          reportAgeH: e.reportAgeH as number,
          appliedWindowH: e.appliedWindowH as number,
          decision: e.decision,
          weatherReopened: e.weatherReopened,
          netThumbs: e.netThumbs ?? 0,
          trustClass: e.trustClass ?? null,
          createdAt: e.createdAt,
        })),
    };
  },
});

/** Cap on a contributor's report history walked for the trend. Bounded; truncation is reported. */
const TREND_REPORT_CAP = 300;

/**
 * The **contributor-trust trend** behind the D57 panel (`/admin/users/$id`) — one bucket per calendar
 * month of a contributor's history, split good vs bad, returned alongside the account's creation date.
 *
 * Tenure-awareness is the entire point (D57). A raw `contradictionCount` of 3 means something very
 * different for a ten-year contributor with four hundred good reports than for a one-month account with
 * five — and a moderator deciding whether to pull a posting right is exactly the person who must not
 * confuse the two. So this deliberately returns the *shape over time* plus `accountCreatedAt`, never a
 * single score: the judgment stays human, and the chart's job is to make the two cases impossible to
 * mistake for each other at a glance.
 *
 * - **bad** = reports settled as weather-unexplained contradictions (D56 §7b), plus `unsafe_false_report`
 *   flags a moderator actually **upheld**. An open or dismissed flag is an accusation, not a finding, and
 *   counting it would let anyone darken someone's record by flagging them.
 * - **good** = reports the community corroborated or thumbed net-helpful. Volume alone is not good; this
 *   mirrors the D50 rule that reputation comes from peers' reactions, not from posting a lot.
 *
 * Moderator-gated: this is their lever's input. The raw `reputationPoints` number stays admin-only
 * (D50) and is not returned here.
 */
export const contributorTrend = query({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    await requireRole(ctx, 'moderator');
    const target = await ctx.db.get(userId);
    if (!target) return null;

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', userId))
      .order('desc')
      .take(TREND_REPORT_CAP);
    const truncated = reports.length === TREND_REPORT_CAP;
    if (truncated) {
      console.warn(
        `analytics.contributorTrend walked the ${TREND_REPORT_CAP}-report cap for ${userId}; the trend covers their most recent history only.`,
      );
    }

    const months = new Map<string, { good: number; bad: number; total: number }>();
    const bucket = (ms: number) => {
      const month = metricDay(ms).slice(0, 7); // 'YYYY-MM'
      const entry = months.get(month) ?? { good: 0, bad: 0, total: 0 };
      months.set(month, entry);
      return entry;
    };

    for (const report of reports) {
      const entry = bucket(report.skateEndTime);
      entry.total++;
      if (report.contradiction) {
        entry.bad++;
        continue; // a settled contradiction is not also counted as good
      }
      const corroborations = await ctx.db
        .query('pointEvents')
        .withIndex('by_ref', (q) => q.eq('refId', report._id))
        .collect();
      const corroborated = corroborations.some((e) => e.reason === 'report_corroborated');
      const { helpful, unhelpful } = await tallyThumbs(ctx, 'report', report._id);
      if (corroborated || helpful - unhelpful > 0) entry.good++;
    }

    // Upheld safety flags naming this user, bucketed by when the moderator ruled — the month the
    // finding was made, not the month the accusation was filed.
    const flags = await ctx.db
      .query('contentFlags')
      .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', userId))
      .take(TREND_REPORT_CAP);
    for (const flag of flags) {
      if (flag.status !== 'actioned' || flag.reason !== 'unsafe_false_report') continue;
      bucket(flag.resolvedAt ?? flag.createdAt).bad++;
    }

    return {
      accountCreatedAt: target.createdAt,
      contradictionCount: target.contradictionCount ?? 0,
      truncated,
      months: [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, counts]) => ({ month, ...counts })),
    };
  },
});
