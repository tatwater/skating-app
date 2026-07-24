/**
 * The analytics rollups (Phase 7b / D37) — the **sweep-by-cron** half of the metric pipeline.
 *
 * Every number here is derivable from rows that are still on disk, so it's computed on a schedule
 * instead of maintained on write. That split is the whole design: charts read `metricSnapshots`, never
 * the live corpus, so a chart's cost stays flat as the corpus grows (the `listInViewport` read-cap
 * lesson from PRs #10/#11, applied before it bites). Everything in here is **bounded** — a day-scoped
 * index range, or a capped scan that logs when it truncates rather than silently charting a slice (D5).
 *
 * Three jobs, on three cadences, for three different reasons:
 *
 *   - **`runRollup` (every 6h)** recomputes *today and yesterday*. Writes replace rather than
 *     accumulate, so re-running is idempotent — which buys near-live dashboard numbers without a
 *     separate live-query path, and self-heals a tick that was missed or ran mid-write.
 *   - **`sweepCorpus` (weekly, self-chaining)** computes the two whole-corpus figures. They change
 *     only when the ETL imports or an operator re-curates, so a daily full sweep would be waste; and
 *     the water-body corpus is far past what one transaction can read, so it pages through with a
 *     cursor and schedules its own continuation.
 *   - **`pruneGateEvents` (daily)** enforces `bountyGateEvents` retention. It's the one append-per-
 *     attempt table here, and it carries `requesterId` — so bounding it is both a storage decision and
 *     a "don't keep a permanent behavioural record" one.
 */

import {
  CONTRADICTION_COUNT_BUCKETS,
  countBy,
  HOUR_BUCKETS,
  histogram,
  hoursBetween,
  metricDay,
  metricDayStart,
  REPUTATION_POINT_BUCKETS,
  rate,
  reportStripState,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { isListed } from './lib/listing';
import { writeMetricSnapshot } from './lib/metrics';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Ceilings on any single scan. Far above real alpha volume; their job is to make a runaway impossible
 * rather than to be reached. Hitting one is logged, never silent (D5) — a chart drawn from a truncated
 * scan is worse than a missing chart, because it looks authoritative.
 *
 * ⚠ **Scaling boundary (documented, not yet hit).** `runRollup` executes `rollupDay`×2 + `rollupNow` in
 * ONE mutation, and `backfill` loops `rollupDay` over N days in one mutation — so the *binding* limit at
 * scale is Convex's per-transaction read budget (~16k documents), which is smaller than the sum of these
 * caps across a run. At alpha scale (hundreds of rows, prod undeployed) neither is close; the plan's
 * settled position is "daily forever is fine at alpha scale; revisit if it grows". When it grows, the
 * fix is to split each phase — and `rollupNow`'s ~nine scans — into their own scheduled mutations, the
 * way `sweepCorpus` already self-chains, rather than to raise these caps. `backfill` should likewise
 * schedule one day per mutation. Until then these caps bound a runaway, not the transaction.
 */
const DAY_SCAN_CAP = 5_000;
/** Ceiling on the profile scan behind the two distribution histograms. */
const PROFILE_SCAN_CAP = 5_000;
/** Ceiling on the trailing-window scans (point events, bounties, strip coverage). */
const WINDOW_SCAN_CAP = 10_000;

/** How long a `bountyGateEvents` row is kept. Long enough to tune a season; short enough not to be a record. */
const GATE_EVENT_RETENTION_DAYS = 180;

/** Trailing window for the bounty outcome funnel — long enough to include expiries at a 30d lifetime. */
const BOUNTY_FUNNEL_DAYS = 90;
/** Trailing window for point-source composition, time-to-fulfillment, and strip coverage. */
const TRAILING_30_DAYS = 30;
/** The "are people still showing up?" window behind `active_contributors`. */
const ACTIVE_CONTRIBUTOR_DAYS = 7;

/** `.take(cap)` with the truncation surfaced. Every scan in this module goes through it. */
async function capped<T>(rows: Promise<T[]>, cap: number, label: string): Promise<T[]> {
  const out = await rows;
  if (out.length >= cap) {
    console.warn(
      `analyticsRollup: ${label} hit the ${cap}-row scan cap — its metric is computed from a partial slice.`,
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-scoped rollups — "what happened on this UTC day"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute every day-scoped metric for one UTC day. Split out from the point-in-time metrics because
 * only these are replayable: their inputs are timestamped rows, so the backfill runs this same code
 * over past days and lands on the same numbers the live job would have.
 */
async function rollupDay(ctx: MutationCtx, date: string): Promise<void> {
  const from = metricDayStart(date);
  const to = from + DAY_MS;

  // --- Activity -------------------------------------------------------------
  // Reports are keyed on **skate-end time**, not creation: the number that matters is how much ice
  // got read that day, and an offline report that syncs on Tuesday still describes Monday's ice.
  const reports = await capped(
    ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q.eq('moderationStatus', 'visible').gte('skateEndTime', from).lt('skateEndTime', to),
      )
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `reports on ${date}`,
  );
  await writeMetricSnapshot(ctx, 'reports_created', date, { scalar: reports.length });

  const hazards = await capped(
    ctx.db
      .query('hazards')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `hazards on ${date}`,
  );
  await writeMetricSnapshot(ctx, 'hazards_created', date, { scalar: hazards.length });

  const signups = await capped(
    ctx.db
      .query('profiles')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `signups on ${date}`,
  );
  await writeMetricSnapshot(ctx, 'signups', date, { scalar: signups.length });

  // --- Bounty gate ----------------------------------------------------------
  const gateEvents = await capped(
    ctx.db
      .query('bountyGateEvents')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `bounty gate events on ${date}`,
  );
  await writeMetricSnapshot(ctx, 'bounty_gate_decisions', date, {
    meta: countBy(gateEvents.map((e) => e.decision)),
    scalar: gateEvents.length,
  });
  await writeMetricSnapshot(ctx, 'bounty_weather_reopen_rate', date, {
    scalar: rate(gateEvents.filter((e) => e.weatherReopened).length, gateEvents.length),
  });
  await writeMetricSnapshot(ctx, 'bounty_cap_hit_rate', date, {
    scalar: rate(gateEvents.filter((e) => e.decision === 'capped').length, gateEvents.length),
  });

  // --- Hazard confirmations -------------------------------------------------
  // Joined back to the hazard for its type and first-report time: the per-type verdict mix and the
  // age at which confirmations arrive are the only empirical check on the whole D52 decay table.
  const confirmations = await capped(
    ctx.db
      .query('hazardConfirmations')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `hazard confirmations on ${date}`,
  );
  const outcomes: Record<string, number> = {};
  const confirmAges: number[] = [];
  for (const c of confirmations) {
    const hazard = await ctx.db.get(c.hazardId);
    if (!hazard) continue;
    const key = `${hazard.type}:${c.verdict}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    confirmAges.push(hoursBetween(hazard.firstReportedAt, c.createdAt));
  }
  await writeMetricSnapshot(ctx, 'hazard_confirm_outcomes', date, { meta: outcomes });
  await writeMetricSnapshot(ctx, 'hazard_age_at_confirm_h', date, {
    buckets: histogram(confirmAges, HOUR_BUCKETS),
  });

  // --- Operational latency --------------------------------------------------
  // Read off `by_status_resolved_at` per terminal status, so the scan touches only the flags resolved
  // on this day. `actioned`/`dismissed` accumulate forever; a scan of all of them would grow unbounded.
  const resolvedFlags: Doc<'contentFlags'>[] = [];
  for (const status of ['actioned', 'dismissed'] as const) {
    resolvedFlags.push(
      ...(await capped(
        ctx.db
          .query('contentFlags')
          .withIndex('by_status_resolved_at', (q) =>
            q.eq('status', status).gte('resolvedAt', from).lt('resolvedAt', to),
          )
          .take(DAY_SCAN_CAP),
        DAY_SCAN_CAP,
        `${status} flags on ${date}`,
      )),
    );
  }
  await writeMetricSnapshot(ctx, 'flag_time_to_resolution_h', date, {
    buckets: histogram(
      resolvedFlags.map((f) => hoursBetween(f.createdAt, f.resolvedAt ?? f.createdAt)),
      HOUR_BUCKETS,
    ),
  });

  const tickets = await capped(
    ctx.db
      .query('supportTickets')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `support tickets on ${date}`,
  );
  await writeMetricSnapshot(ctx, 'support_volume', date, {
    meta: countBy(tickets.map((t) => t.category)),
    scalar: tickets.length,
  });

  const resolvedTickets = await capped(
    ctx.db
      .query('supportTickets')
      .withIndex('by_status_resolved_at', (q) =>
        q.eq('status', 'resolved').gte('resolvedAt', from).lt('resolvedAt', to),
      )
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `resolved tickets on ${date}`,
  );
  await writeMetricSnapshot(ctx, 'support_time_to_resolution_h', date, {
    buckets: histogram(
      resolvedTickets.map((t) => hoursBetween(t.createdAt, t.resolvedAt ?? t.createdAt)),
      HOUR_BUCKETS,
    ),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Point-in-time rollups — "what is true right now", stamped on today
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distributions and queue state as of now. Not replayable (a histogram of *current* reputation can't
 * be reconstructed for last Tuesday), so these are always stamped on today and simply overwritten by
 * the next tick — the series is a record of what each day looked like when we last measured it.
 */
async function rollupNow(ctx: MutationCtx, now: number): Promise<void> {
  const date = metricDay(now);

  // --- Contributor distributions -------------------------------------------
  // One scan, two histograms. Deleted accounts are excluded: a distribution meant to answer "do the
  // class thresholds spread people?" shouldn't be diluted by rows that represent nobody.
  const profiles = await capped(
    ctx.db.query('profiles').take(PROFILE_SCAN_CAP),
    PROFILE_SCAN_CAP,
    'profile distributions',
  );
  const live = profiles.filter((p) => p.status !== 'deleted');
  await writeMetricSnapshot(ctx, 'reputation_points_hist', date, {
    buckets: histogram(
      live.map((p) => p.reputationPoints),
      REPUTATION_POINT_BUCKETS,
    ),
    scalar: live.length,
  });
  await writeMetricSnapshot(ctx, 'contradiction_count_hist', date, {
    buckets: histogram(
      live.map((p) => p.contradictionCount ?? 0),
      CONTRADICTION_COUNT_BUCKETS,
    ),
    scalar: live.length,
  });

  // --- Active contributors --------------------------------------------------
  // Distinct authors across reports AND hazards in the trailing window — one person who did both is
  // one contributor, which is why this is a set union and not the sum of two counts.
  const since = now - ACTIVE_CONTRIBUTOR_DAYS * DAY_MS;
  const recentReports = await capped(
    ctx.db
      .query('reports')
      .withIndex('by_created_at', (q) => q.gte('createdAt', since))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'recent reports (active contributors)',
  );
  const recentHazards = await capped(
    ctx.db
      .query('hazards')
      .withIndex('by_created_at', (q) => q.gte('createdAt', since))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'recent hazards (active contributors)',
  );
  const contributors = new Set<string>([
    ...recentReports.map((r) => r.authorId as string),
    ...recentHazards.map((h) => h.createdByUserId as string),
  ]);
  await writeMetricSnapshot(ctx, 'active_contributors', date, { scalar: contributors.size });

  // --- Bounty funnel + time to fulfillment ---------------------------------
  const bounties = await capped(
    ctx.db
      .query('bounties')
      .withIndex('by_created_at', (q) => q.gte('createdAt', now - BOUNTY_FUNNEL_DAYS * DAY_MS))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'bounty funnel',
  );
  await writeMetricSnapshot(ctx, 'bounty_outcomes', date, {
    meta: countBy(bounties.map((b) => b.status)),
    scalar: bounties.length,
  });
  // Forward-only: bounties fulfilled before `fulfilledAt` shipped carry no timestamp and are left out
  // rather than guessed at from `_creationTime` — a fabricated duration would read as real data.
  const fulfillmentHours = bounties
    .filter((b) => b.fulfilledAt !== undefined && b.fulfilledAt >= now - TRAILING_30_DAYS * DAY_MS)
    .map((b) => hoursBetween(b.createdAt, b.fulfilledAt as number));
  await writeMetricSnapshot(ctx, 'bounty_time_to_fulfillment_h', date, {
    buckets: histogram(fulfillmentHours, HOUR_BUCKETS),
    scalar: fulfillmentHours.length,
  });

  // --- Point-source composition --------------------------------------------
  // Summed by *delta*, not by row count: the question is which reasons the points came from, and
  // POINT_WEIGHTS deliberately makes a corroboration worth more than a submission.
  const pointEvents = await capped(
    ctx.db
      .query('pointEvents')
      .withIndex('by_created_at', (q) => q.gte('createdAt', now - TRAILING_30_DAYS * DAY_MS))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'point-source composition',
  );
  const bySource: Record<string, number> = {};
  for (const e of pointEvents) bySource[e.reason] = (bySource[e.reason] ?? 0) + e.delta;
  await writeMetricSnapshot(ctx, 'point_source_composition', date, { meta: bySource });

  // --- Flag queue health ----------------------------------------------------
  const openFlags: Doc<'contentFlags'>[] = [];
  for (const status of ['open', 'reviewing'] as const) {
    openFlags.push(
      ...(await capped(
        ctx.db
          .query('contentFlags')
          .withIndex('by_status', (q) => q.eq('status', status))
          .take(DAY_SCAN_CAP),
        DAY_SCAN_CAP,
        `${status} flags`,
      )),
    );
  }
  // Split by the safety lane, because the two have different urgency: a backlog of spam flags is a
  // workload problem, a backlog of `unsafe_false_report` is a safety one (D3).
  const priority = openFlags.filter((f) => f.reason === 'unsafe_false_report');
  await writeMetricSnapshot(ctx, 'flag_queue_depth', date, {
    meta: { priority: priority.length, standard: openFlags.length - priority.length },
    scalar: openFlags.length,
  });
  const oldest = openFlags.reduce<number | null>(
    (acc, f) => (acc === null || f.createdAt < acc ? f.createdAt : acc),
    null,
  );
  await writeMetricSnapshot(ctx, 'flag_oldest_open_age_h', date, {
    scalar: oldest === null ? 0 : hoursBetween(oldest, now),
  });

  // --- Weather-strip coverage ----------------------------------------------
  // The trailing-30d corpus classified by the strip state it would render in *right now*. Reports
  // older than the window are all `aged` by definition, so scanning further would only pad one bar.
  const stripReports = await capped(
    ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q.eq('moderationStatus', 'visible').gte('skateEndTime', now - TRAILING_30_DAYS * DAY_MS),
      )
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'weather-strip coverage',
  );
  await writeMetricSnapshot(ctx, 'weather_strip_coverage', date, {
    meta: countBy(stripReports.map((r) => reportStripState(r.skateEndTime, now).kind)),
    scalar: stripReports.length,
  });

  // --- Orphaned photos ------------------------------------------------------
  await writeMetricSnapshot(ctx, 'photo_orphans', date, {
    scalar: await countOrphanPhotos(ctx, now),
  });
}

/**
 * Photos referenced by no report or hazard — the number that decides whether the deferred GC cron is
 * worth building.
 *
 * Windowed on both sides so the scan stays bounded and the answer stays honest. Photos are counted
 * from a **30-day window ending 24h ago**: a photo uploaded minutes ago is mid-submission, not
 * abandoned, and counting it would make the metric a measure of how recently someone opened the form.
 * References are gathered from a *wider* 31-day window, since a photo is uploaded before the report
 * that attaches it and an offline draft can flush a day or more later — a narrower reference window
 * would count attached photos as orphans.
 */
async function countOrphanPhotos(ctx: MutationCtx, now: number): Promise<number> {
  const photoFrom = now - TRAILING_30_DAYS * DAY_MS;
  const photoTo = now - DAY_MS;
  const photos = await capped(
    ctx.db
      .query('photos')
      .withIndex('by_created_at', (q) => q.gte('createdAt', photoFrom).lt('createdAt', photoTo))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'photo orphan sweep',
  );
  if (photos.length === 0) return 0;

  const refFrom = photoFrom - DAY_MS;
  const referenced = new Set<string>();
  const reports = await capped(
    ctx.db
      .query('reports')
      .withIndex('by_created_at', (q) => q.gte('createdAt', refFrom))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'photo references (reports)',
  );
  for (const r of reports) for (const id of r.photoIds) referenced.add(id);
  const hazards = await capped(
    ctx.db
      .query('hazards')
      .withIndex('by_created_at', (q) => q.gte('createdAt', refFrom))
      .take(WINDOW_SCAN_CAP),
    WINDOW_SCAN_CAP,
    'photo references (hazards)',
  );
  for (const h of hazards) for (const id of h.photoIds) referenced.add(id);

  return photos.filter((p) => !referenced.has(p._id)).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scheduled rollup. Recomputes **today and yesterday** plus the point-in-time metrics; snapshot
 * writes replace, so running it four times a day is idempotent and gives the dashboard near-live
 * numbers without a second, corpus-scanning read path. Yesterday is included so a day that was still
 * accumulating at the last tick before midnight ends up complete.
 */
export const runRollup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    await rollupDay(ctx, metricDay(now - DAY_MS));
    await rollupDay(ctx, metricDay(now));
    await rollupNow(ctx, now);
  },
});

/**
 * Replay the day-scoped rollups over the last `days` UTC days — for a fresh deployment, or after a
 * metric's definition changes. Only the day-scoped half is replayable (a histogram of *current*
 * reputation has no meaning for last Tuesday), and only from rows that still exist: `bountyGateEvents`
 * is forward-only, so backfilled days predating it show honest zeroes rather than invented gate
 * decisions. Run with `pnpm exec convex run analyticsRollup:backfill '{"days":30}'`.
 */
export const backfill = internalMutation({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const now = Date.now();
    const count = Math.min(Math.max(1, days ?? TRAILING_30_DAYS), 365);
    for (let i = count - 1; i >= 0; i--) await rollupDay(ctx, metricDay(now - i * DAY_MS));
    await rollupNow(ctx, now);
    return { days: count };
  },
});

/**
 * `bountyGateEvents` retention. The one append-per-attempt table in the analytics set, and the one
 * carrying `requesterId` — so the bound is as much "don't accumulate a permanent behavioural record"
 * as it is storage. Deletes a bounded page per run; the daily cadence keeps up with any real volume,
 * and a backlog just takes a few days to drain rather than blowing one transaction.
 */
export const pruneGateEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - GATE_EVENT_RETENTION_DAYS * DAY_MS;
    const stale = await ctx.db
      .query('bountyGateEvents')
      .withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
      .take(DAY_SCAN_CAP);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-corpus sweep (weekly, self-chaining)
// ─────────────────────────────────────────────────────────────────────────────

/** Water bodies read per tick. Kept modest because each row carries a full polygon. */
const SWEEP_PAGE_SIZE = 400;
/** Backstop on the chain length — 400 × 400 = 160k bodies, well past the planned regions. */
const SWEEP_MAX_PAGES = 400;

const counterRecord = v.record(v.string(), v.number());

/**
 * One page of the whole-corpus sweep behind `state_coverage` and `zoom_band_distribution`.
 *
 * The water-body corpus is far past what a single Convex transaction can read, so this pages with a
 * cursor and schedules its own continuation, carrying the two (tiny — a handful of states, ~9 zoom
 * bands) accumulators through its own args. Nothing partial is ever written: the snapshots land only
 * on the final tick, so a chart never shows a half-swept corpus as if it were the whole thing.
 *
 * Weekly rather than daily because both figures are properties of the *import*, not of user activity —
 * they move when the ETL runs or an operator re-curates, not when someone posts a report.
 */
export const sweepCorpus = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    page: v.optional(v.number()),
    states: v.optional(counterRecord),
    bands: v.optional(counterRecord),
  },
  handler: async (ctx, args) => {
    const page = args.page ?? 0;
    const states: Record<string, number> = { ...(args.states ?? {}) };
    const bands: Record<string, number> = { ...(args.bands ?? {}) };

    const result = await ctx.db
      .query('waterBodies')
      .paginate({ cursor: args.cursor ?? null, numItems: SWEEP_PAGE_SIZE });

    for (const body of result.page) {
      if (!isListed(body)) continue; // removed / rejected / merged bodies aren't coverage
      for (const state of body.states ?? ['unknown']) {
        states[state] = (states[state] ?? 0) + 1;
      }
      // A body with no computed `minVisibleZoom` predates the D49 curve and is always visible —
      // bucketed as `always` rather than dropped, so the bands still sum to the corpus.
      const band = body.minVisibleZoom === undefined ? 'always' : `z${body.minVisibleZoom}`;
      bands[band] = (bands[band] ?? 0) + 1;
    }

    const done = result.isDone || page + 1 >= SWEEP_MAX_PAGES;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.analyticsRollup.sweepCorpus, {
        cursor: result.continueCursor,
        page: page + 1,
        states,
        bands,
      });
      return { done: false, page };
    }
    if (!result.isDone) {
      console.warn(
        `analyticsRollup.sweepCorpus stopped at the ${SWEEP_MAX_PAGES}-page backstop; coverage is computed from a partial corpus.`,
      );
    }

    // Final tick: pair the body counts with trailing-30d report counts per state, then publish both
    // snapshots together.
    const now = Date.now();
    const date = metricDay(now);
    const recent = await capped(
      ctx.db
        .query('reports')
        .withIndex('by_moderation_and_skate_end_time', (q) =>
          q.eq('moderationStatus', 'visible').gte('skateEndTime', now - TRAILING_30_DAYS * DAY_MS),
        )
        .take(WINDOW_SCAN_CAP),
      WINDOW_SCAN_CAP,
      'state coverage (reports)',
    );
    const coverage: Record<string, number> = {};
    for (const [state, count] of Object.entries(states)) coverage[`${state}:bodies`] = count;
    for (const r of recent) {
      const key = `${r.place?.state ?? 'unknown'}:reports`;
      coverage[key] = (coverage[key] ?? 0) + 1;
    }
    await writeMetricSnapshot(ctx, 'state_coverage', date, { meta: coverage });
    await writeMetricSnapshot(ctx, 'zoom_band_distribution', date, {
      meta: bands,
      scalar: Object.values(bands).reduce((a, b) => a + b, 0),
    });
    return { done: true, page };
  },
});
