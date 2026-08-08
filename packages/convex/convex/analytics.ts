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
import { internalMutation, mutation, query } from './_generated/server';
import { requireProfile, requireRole } from './lib/auth';
import { bumpMetricCounter, writeMetricSnapshot } from './lib/metrics';

/**
 * The only metrics a client may report. Kept as an explicit allowlist rather than "any counter key" so
 * the channel can't be widened by accident into a way to write arbitrary analytics from a browser.
 */
const CLIENT_SIGNALS = ['report_rejected_future_skate'] as const satisfies readonly MetricKey[];

/** Per-user rate limit on the client signal — generous for a real clock-skew streak, tight on abuse. */
const CLIENT_SIGNAL_WINDOW_MS = 60 * 60 * 1000; // 1h
const CLIENT_SIGNAL_MAX_PER_WINDOW = 10;

/**
 * Record one client-observed signal against today's counter. Authenticated, allowlisted, additive —
 * and **per-user rate-limited** (mirroring `supportTickets`), so one caller can't inflate an advisory
 * chart past a plausible clock-skew streak. Over the cap it **silently drops** rather than throwing:
 * the caller is fire-and-forget telemetry, and a real user who legitimately hit the form's future-skate
 * guard should never see an error because they hit it a few times. See the module note on why this
 * single metric is client-reported and why that's contained.
 */
export const recordClientSignal = mutation({
  args: { signal: v.union(...CLIENT_SIGNALS.map((s) => v.literal(s))) },
  handler: async (ctx, { signal }) => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    const recent = await ctx.db
      .query('clientSignalEvents')
      .withIndex('by_user_created', (q) =>
        q.eq('userId', profile._id).gte('createdAt', now - CLIENT_SIGNAL_WINDOW_MS),
      )
      .take(CLIENT_SIGNAL_MAX_PER_WINDOW);
    if (recent.length >= CLIENT_SIGNAL_MAX_PER_WINDOW) return; // over the cap — drop, don't error

    await ctx.db.insert('clientSignalEvents', { userId: profile._id, signal, createdAt: now });
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
 * Record one measurement of a third-party catalogue (N7).
 *
 * **`internalMutation`, so it is reachable only from `convex run` with an admin key** — the same
 * channel `@skating/run-log` already uses. The measurement is taken by an ETL pass against an archive
 * on disk, so there is no server-side path that could compute it and no client that should be able to
 * assert it.
 *
 * **Refuses anything that is not an `external` metric.** A rollup or a counter arriving here would be
 * a number the cron or the event site also writes, and two writers on one series is how a chart starts
 * disagreeing with itself. The rejection is loud (throws) rather than a warn-and-drop, because unlike
 * a fire-and-forget client signal this is a deliberate operator action whose silent failure would look
 * exactly like "the catalogue hasn't changed".
 *
 * Idempotent per `date` — `writeMetricSnapshot` replaces. Re-measuring the same release overwrites
 * rather than accumulating, so a corrected run is just a re-run.
 */
export const recordCatalogueSnapshot = internalMutation({
  args: {
    metric: v.string(),
    date: v.string(),
    scalar: v.optional(v.number()),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, { metric, date, scalar, meta }) => {
    const spec = METRIC_SPECS[metric as MetricKey];
    if (!spec) throw new Error(`unknown metric "${metric}"`);
    if (spec.kind !== 'external') {
      throw new Error(
        `metric "${metric}" is a ${spec.kind}, not an external catalogue measurement — it is written by ${
          spec.kind === 'counter' ? 'the event site' : 'the daily cron'
        }, and a second writer would make the series disagree with itself.`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
    await writeMetricSnapshot(ctx, metric as MetricKey, date, { scalar, meta });
    return { metric, date, scalar: scalar ?? null };
  },
});

/**
 * Hard ceiling on a `catalogueHistory` read.
 *
 * An `external` metric gets one row per third-party release — 3DHP publishes annually — so 200 rows is
 * two centuries of a yearly cadence, or a decade if something starts publishing monthly. It is a
 * backstop against a mis-scoped writer, not a real limit anyone will reach.
 */
const MAX_CATALOGUE_HISTORY = 200;

/**
 * The full history of an `external` metric — every snapshot, oldest first, with no day-range
 * densification.
 *
 * **Separate from `series` because the shape of the data is different, not because it is convenient.**
 * `series` generates a dense run of `YYYY-MM-DD` keys and fills the gaps with nulls, which is right
 * for a daily rollup: a quiet day is a real zero. An external catalogue is measured **when its
 * publisher ships a release**, so the gaps between rows are years of nothing happening, not years of
 * zeroes. Rendering them through `series` would either cap at `MAX_SERIES_DAYS` (365 — losing every
 * prior year, which is the entire point of the metric) or draw 730 empty days between two points.
 *
 * Returns the rows as measured. The chart plots the points and connects them; it does not pretend to
 * know what the value was in between.
 */
export const catalogueHistory = query({
  args: { metric: v.string() },
  handler: async (ctx, { metric }) => {
    await requireRole(ctx, 'admin');
    if (!(metric in METRICS)) return [];
    const rows = await ctx.db
      .query('metricSnapshots')
      .withIndex('by_metric_date', (q) => q.eq('metric', metric))
      .take(MAX_CATALOGUE_HISTORY);
    // The index orders by date ascending, and dates are `YYYY-MM-DD`, so this is chronological.
    return rows.map((row) => ({
      date: row.date,
      scalar: row.scalar ?? null,
      meta: (row.meta ?? null) as Record<string, unknown> | null,
    }));
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
 * Ceiling on the *reaction* documents (corroboration events + thumbs) the trend fans out to read.
 * Classifying a report as "good" scans its `pointEvents` and `reportRatings`, so a prolific,
 * high-reaction contributor could otherwise push a single trend query past Convex's per-transaction
 * document-read budget and fail to render. We walk newest-first and stop once this budget is hit —
 * the same "most recent history only" degradation the report cap already applies, surfaced via
 * `truncated`. Sized to leave headroom under the ~16k read limit after the ≤300 report + ≤300 flag reads.
 */
const TREND_REACTION_READ_BUDGET = 12_000;

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
    let truncated = reports.length === TREND_REPORT_CAP;
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

    // Walk newest-first (the `.take` above is `order('desc')`), keeping the reaction fan-out inside a
    // read budget so the query stays under Convex's per-transaction document-read limit. Each source is
    // read with `.take(remaining + 1)`, not `.collect()` — so a single high-reaction report can't blow
    // the limit on its own — and a report is committed to a bucket only after it classifies *fully*
    // within budget. When a source would exceed the remaining budget we stop before counting that
    // report (drop it whole, never half-count): total reaction docs read is capped at the budget + 1.
    // The oldest surviving month may be partial and older months drop out entirely — like the report
    // cap — both disclosed via `truncated`.
    let reactionReads = 0;
    const hitBudget = () => {
      truncated = true;
      console.warn(
        `analytics.contributorTrend hit the ${TREND_REACTION_READ_BUDGET}-reaction read budget for ${userId}; the trend covers their most recent history only.`,
      );
    };
    for (const report of reports) {
      if (report.contradiction) {
        const entry = bucket(report.skateEndTime);
        entry.total++;
        entry.bad++; // a settled contradiction is not also counted as good, and costs no reaction reads
        continue;
      }

      // Corroboration: read at most the remaining budget (+1 to detect overflow). Bail before counting
      // this report if its events alone would exceed what's left.
      const corroborations = await ctx.db
        .query('pointEvents')
        .withIndex('by_ref', (q) => q.eq('refId', report._id))
        .take(TREND_REACTION_READ_BUDGET - reactionReads + 1);
      if (corroborations.length > TREND_REACTION_READ_BUDGET - reactionReads) {
        hitBudget();
        break;
      }
      reactionReads += corroborations.length;

      // Thumbs: same bounded read. Inlined (not `tallyThumbs`) because we need `.take`, not `.collect`.
      const ratings = await ctx.db
        .query('reportRatings')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', report._id))
        .take(TREND_REACTION_READ_BUDGET - reactionReads + 1);
      if (ratings.length > TREND_REACTION_READ_BUDGET - reactionReads) {
        hitBudget();
        break;
      }
      reactionReads += ratings.length;

      const entry = bucket(report.skateEndTime);
      entry.total++;
      const corroborated = corroborations.some((e) => e.reason === 'report_corroborated');
      let helpful = 0;
      let unhelpful = 0;
      for (const r of ratings) {
        if (r.verdict === 'helpful') helpful++;
        else unhelpful++;
      }
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
