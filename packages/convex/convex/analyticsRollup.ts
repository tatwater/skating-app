/**
 * The analytics rollups (Phase 07-2 / D37) — the **sweep-by-cron** half of the metric pipeline.
 *
 * Every number here is derivable from rows that are still on disk, so it's computed on a schedule
 * instead of maintained on write. That split is the whole design: charts read `metricSnapshots`, never
 * the live corpus, so a chart's cost stays flat as the corpus grows (the `listInViewport` read-cap
 * lesson from PRs #10/#11, applied before it bites). Everything in here is **bounded** — a day-scoped
 * index range, or a capped scan that logs when it truncates rather than silently charting a slice (D5).
 *
 * Three crons, on three cadences, for three different reasons:
 *
 *   - **`runRollup` (every 6h)** recomputes *today and yesterday* plus the point-in-time metrics. It
 *     doesn't do the work inline — it **fans out to per-transaction jobs** (`rollupDayJob` ×2 and the
 *     three point-in-time chunks), so no single mutation reads past Convex's per-transaction budget
 *     even as the corpus grows. Writes replace rather than accumulate, so re-running is idempotent —
 *     near-live dashboard numbers without a separate live-query path, and a missed tick self-heals.
 *   - **`sweepCorpus` (weekly, self-chaining)** computes the two whole-corpus figures. They change
 *     only when the ETL imports or an operator re-curates, so a daily full sweep would be waste; and
 *     the water-body corpus is far past what one transaction can read, so it pages through with a
 *     cursor and schedules its own continuation.
 *   - **`pruneGateEvents` (daily)** enforces `bountyGateEvents` retention. It's the one append-per-
 *     attempt table here, and it carries `requesterId` — so bounding it is both a storage decision and
 *     a "don't keep a permanent behavioral record" one.
 *
 * `backfill` likewise self-chains one UTC day per transaction (`backfillStep`). So every entry point
 * here keeps a single transaction's read load bounded by *one* day or *one* point-in-time chunk, never
 * the whole run.
 */

import {
  CONTRADICTION_COUNT_BUCKETS,
  countBy,
  HOUR_BUCKETS,
  histogram,
  hoursBetween,
  metricDay,
  metricDayStart,
  positiveReactionOf,
  REPUTATION_POINT_BUCKETS,
  rate,
  reportStripState,
  seasonOf,
  signInRetentionFrom,
  standingOf,
  wasOpenDuring,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { contributorsBetween } from './lib/contributions';
import { isListed } from './lib/listing';
import { writeMetricSnapshot } from './lib/metrics';
import { readOpenFlags } from './lib/openFlags';
import { isCountedComment } from './lib/pulse';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Ceilings on any single scan. Far above real alpha volume; their job is to make a runaway impossible
 * rather than to be reached. Hitting one is logged, never silent (D5) — a chart drawn from a truncated
 * scan is worse than a missing chart, because it looks authoritative.
 *
 * Each cap bounds ONE job's scan, and every job is its own transaction (the entry points fan out /
 * self-chain — see the module note), so a cap sits comfortably under Convex's per-transaction read
 * budget (~16k documents) with a single day or point-in-time chunk in flight. The cap is a
 * runaway-backstop, not the real ceiling; the fan-out is what keeps the transaction safe.
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
 *
 * Reports, hazards and signups are three of the Metrics pulse's strips, so they follow the pulse's
 * rule (`rollupPulseDay`): a count whose read hits `cap` is saved with no number, never as the day.
 * `cap` bounds those three reads only, so a test can reach it without thousands of rows.
 */
export async function rollupDay(
  ctx: MutationCtx,
  date: string,
  cap: number = DAY_SCAN_CAP,
): Promise<void> {
  const from = metricDayStart(date);
  const to = from + DAY_MS;

  // --- Activity -------------------------------------------------------------
  // Reports are keyed on **skate-end time**, not creation: the number that matters is how much ice
  // got read that day, and an offline report that syncs on Tuesday still describes Monday's ice.
  const reports = await wholeDay(
    ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q.eq('moderationStatus', 'visible').gte('skateEndTime', from).lt('skateEndTime', to),
      ),
    cap,
    `reports on ${date}`,
  );
  await writeMetricSnapshot(
    ctx,
    'reports_created',
    date,
    reports === null ? NOT_RECORDED : { scalar: reports.length },
  );

  const hazards = await wholeDay(
    ctx.db
      .query('hazards')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to)),
    cap,
    `hazards on ${date}`,
  );
  await writeMetricSnapshot(
    ctx,
    'hazards_created',
    date,
    hazards === null ? NOT_RECORDED : { scalar: hazards.length },
  );

  // The accounts strip adds these days up, so a partial day here would undercount its total.
  const signups = await wholeDay(
    ctx.db
      .query('profiles')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to)),
    cap,
    `signups on ${date}`,
  );
  await writeMetricSnapshot(
    ctx,
    'signups',
    date,
    signups === null ? NOT_RECORDED : { scalar: signups.length },
  );

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

  // --- Hazard merges (A05c / D80) -------------------------------------------
  // Auto-merge is the one mechanism in the phase that changes a row without a human, and the unmerge
  // rate is the only empirical check on its bar. Read off the audit table's day slice — every merge
  // writes a row precisely so this can be counted rather than guessed.
  const mergeActions = await capped(
    ctx.db
      .query('moderationActions')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .filter((q) =>
        q.or(q.eq(q.field('action'), 'merge_hazards'), q.eq(q.field('action'), 'unmerge_hazards')),
      )
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `hazard merges on ${date}`,
  );
  const merges: Record<string, number> = {};
  for (const action of mergeActions) {
    // Split automatic from moderator-initiated: a moderator merging two pins by hand is a healthy
    // signal, and an automatic merge they later undo is the one that says the bar is wrong.
    const key =
      action.action === 'unmerge_hazards'
        ? 'unmerged'
        : action.actorId === undefined
          ? 'merged:automatic'
          : 'merged:moderator';
    merges[key] = (merges[key] ?? 0) + 1;
  }
  await writeMetricSnapshot(ctx, 'hazard_merges', date, { meta: merges });

  // --- Cross-season recurrence (A05c / D78) --------------------------------
  // A distribution rather than a count, because the number an operator actually needs is "how many
  // patterns would go public if I moved the bar", and that is only answerable as a histogram. Read off
  // the precomputed table for the current season — bounded by clusters, never by the hazard corpus.
  const clusters = await capped(
    ctx.db
      .query('hazardRecurrence')
      .withIndex('by_computed_season_and_priority', (q) =>
        q.eq('computedForSeason', seasonOf(to - 1)),
      )
      .take(DAY_SCAN_CAP),
    DAY_SCAN_CAP,
    `recurrence clusters on ${date}`,
  );
  const bySeasons: Record<string, number> = {};
  for (const cluster of clusters) {
    // Suppressed and promoted rows are excluded: neither can ever go public, so counting them would
    // inflate the very number this chart exists to make honest.
    if (cluster.suppressedAt !== undefined || cluster.promotedToFeatureId !== undefined) continue;
    const key = `${Math.min(cluster.seasonsObserved.length, cluster.windowSeasons)} of ${cluster.windowSeasons}`;
    bySeasons[key] = (bySeasons[key] ?? 0) + 1;
  }
  await writeMetricSnapshot(ctx, 'recurrence_clusters_by_seasons', date, { meta: bySeasons });

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

/**
 * The Overview's daily pulse (B01, Metrics' *Each day*): the day's comments, report photos, kudos,
 * sign-ins and contributors. Replayable like the rest of the day, so the day backfill fills a past
 * season from the rows still on disk — except sign-ins before their record began, which stay
 * unwritten (read as *not recorded*, never as a day nobody came).
 *
 * Its own transaction (`rollupPulseDayJob`), beside `rollupDay`'s: each day job stays one day's
 * scans. A contributor is anyone with a standing contribution this day (`lib/contributions`, D253):
 * a report whose skate ended on it, or a hazard, an access alert, a "not publicly accessible" report,
 * a put-in placed or a corpus request made on it. Comments are not contributions.
 *
 * A count whose read hits `cap` is saved with **no number** (`meta.capped`), and the other fields of
 * the day still save: a slice of a day is never written as the day, and the chart draws that day
 * *Not recorded yet*. A day's rows only grow, so under the same cap a re-run (the next tick, the
 * backfill) caps again: the gap is filled only by a run under a higher cap. `cap` is a parameter so
 * a test can reach it without thousands of rows.
 */
export async function rollupPulseDay(
  ctx: MutationCtx,
  date: string,
  cap: number = DAY_SCAN_CAP,
): Promise<void> {
  const from = metricDayStart(date);
  const to = from + DAY_MS;

  // Each read is the day's rows or `null` (capped); every check below is against `null`.
  const comments = await wholeDay(
    ctx.db
      .query('comments')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to)),
    cap,
    `comments on ${date}`,
  );
  const counted = comments === null ? null : comments.filter(isCountedComment);
  await writeMetricSnapshot(
    ctx,
    'comments_created',
    date,
    counted === null
      ? NOT_RECORDED
      : { scalar: counted.length, meta: { reports: new Set(counted.map((c) => c.reportId)).size } },
  );

  // A photo counts once it belongs to a report: an upload never attached is not a contribution.
  const uploads = await wholeDay(
    ctx.db
      .query('photos')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to)),
    cap,
    `photos on ${date}`,
  );
  const photos = uploads === null ? null : uploads.filter((p) => p.reportId !== undefined);
  await writeMetricSnapshot(
    ctx,
    'photos_added',
    date,
    photos === null
      ? NOT_RECORDED
      : { scalar: photos.length, meta: { reports: new Set(photos.map((p) => p.reportId)).size } },
  );

  // Kudos are positive reactions (the founder, 2026-11-13): a thumbs-down is never counted.
  const ratings = await wholeDay(
    ctx.db
      .query('reportRatings')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to)),
    cap,
    `ratings on ${date}`,
  );
  const kinds =
    ratings === null
      ? null
      : ratings.flatMap((r) => {
          const kind = positiveReactionOf(r.verdict);
          return kind === null ? [] : [kind];
        });
  await writeMetricSnapshot(
    ctx,
    'positive_reactions',
    date,
    kinds === null ? NOT_RECORDED : { scalar: kinds.length, meta: countBy(kinds) },
  );

  const contributors = await contributorsBetween(ctx, from, to, cap);
  if (contributors.capped) warnCapped(`contributors on ${date}`, cap);
  await writeMetricSnapshot(
    ctx,
    'daily_contributors',
    date,
    contributors.capped ? NOT_RECORDED : { scalar: contributors.people.size },
  );

  // Sign-ins are forward-only (B01-1): a day before the record's first row was never measured.
  const firstRecorded = await ctx.db.query('signInDays').withIndex('by_day').first();
  if (firstRecorded !== null && firstRecorded.day <= date) {
    const signIns = await wholeDay(
      ctx.db.query('signInDays').withIndex('by_day', (q) => q.eq('day', date)),
      cap,
      `sign-ins on ${date}`,
    );
    await writeMetricSnapshot(
      ctx,
      'signed_in',
      date,
      signIns === null ? NOT_RECORDED : { scalar: signIns.length },
    );
  }
}

/** A pulse field whose read hit its cap: no number, so the day reads *not recorded*, never a floor. */
const NOT_RECORDED = { meta: { capped: true } } as const;

function warnCapped(label: string, cap: number): void {
  console.warn(
    `analyticsRollup: ${label} hit the ${cap}-row scan cap — saved as not recorded rather than a partial count.`,
  );
}

/**
 * A day's rows, or `null` when `cap` is what stopped the read. It asks for one row past the cap, so
 * a day with exactly `cap` rows is whole, not capped.
 */
async function wholeDay<T>(
  query: { take(n: number): Promise<T[]> },
  cap: number,
  label: string,
): Promise<T[] | null> {
  const rows = await query.take(cap + 1);
  if (rows.length <= cap) return rows;
  warnCapped(label, cap);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Point-in-time rollups — "what is true right now", stamped on today
// ─────────────────────────────────────────────────────────────────────────────

// The point-in-time metrics are stamped on *today* and simply overwritten by the next tick — the
// series is a record of what each day looked like when we last measured it, not a replayable history
// (a histogram of *current* reputation can't be reconstructed for last Tuesday). They're split into
// three functions of roughly equal read weight so each can run as its own scheduled mutation and stay
// well inside Convex's per-transaction read budget (see the scan-cap note above); `runRollup` and
// `backfill` fan them out rather than calling all three in one transaction.

/** Contributor distributions — one full-`profiles` scan, two histograms. The heaviest single scan. */
async function rollupDistributions(ctx: MutationCtx, now: number): Promise<void> {
  const date = metricDay(now);
  // Deleted accounts are excluded: a distribution meant to answer "do the class thresholds spread
  // people?" shouldn't be diluted by rows that represent nobody.
  const profiles = await capped(
    ctx.db.query('profiles').take(PROFILE_SCAN_CAP),
    PROFILE_SCAN_CAP,
    'profile distributions',
  );
  const live = profiles.filter((p) => p.status !== 'deleted');
  // Every account that exists, for the Overview's *N users* and Metrics' *total*. A floor once the
  // scan stops short, and it says so.
  await writeMetricSnapshot(ctx, 'accounts_total', date, {
    scalar: live.length,
    ...(profiles.length >= PROFILE_SCAN_CAP ? { meta: { capped: true } } : {}),
  });
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
}

/** Activity + reputation flow — active contributors, the bounty funnel, and point-source composition. */
async function rollupActivity(ctx: MutationCtx, now: number): Promise<void> {
  const date = metricDay(now);

  // Distinct people with a standing contribution in the trailing window — the one rule every
  // contributors figure reads (D253): a person who did two kinds is one contributor.
  const since = now - ACTIVE_CONTRIBUTOR_DAYS * DAY_MS;
  const { people: contributors, capped: contributorsCapped } = await contributorsBetween(
    ctx,
    since,
    now + 1,
    WINDOW_SCAN_CAP,
  );
  if (contributorsCapped) {
    console.warn(
      `analyticsRollup: active contributors hit the ${WINDOW_SCAN_CAP}-row scan cap — computed from a partial slice.`,
    );
  }
  await writeMetricSnapshot(ctx, 'active_contributors', date, { scalar: contributors.size });

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
}

/** Operational health — flag-queue depth/age, support-queue depth, weather-strip coverage, orphaned photos. */
async function rollupOperational(ctx: MutationCtx, now: number): Promise<void> {
  const date = metricDay(now);

  // Open means `open` or `reviewing` — the one definition every count of open flags reads.
  const { flags: openFlags, capped: flagsCapped } = await readOpenFlags(ctx, DAY_SCAN_CAP);
  if (flagsCapped) {
    console.warn(
      `analyticsRollup: open flags hit the ${DAY_SCAN_CAP}-row scan cap — the flag queue is computed from a partial slice.`,
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

  await rollupSupportQueue(ctx, now);

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

  await writeMetricSnapshot(ctx, 'photo_orphans', date, {
    scalar: await countOrphanPhotos(ctx, now),
  });
}

/** The statuses a ticket waits in — everything but `resolved`. */
const OPEN_TICKET_STATUSES = ['open', 'in_progress'] as const;

/**
 * The support queue's daily depth (`support_queue_depth`, B01): every ticket open at any point of
 * the day, by category — for **today so far and yesterday**, re-measured on every tick.
 *
 * A ticket's open span runs from `createdAt` to `resolvedAt` (no reopen path exists), so the tickets
 * open at any point of a day since yesterday began are exactly those open now and those resolved
 * since then — two bounded, indexed reads, never the ticket history. Yesterday is in the pass because
 * the last tick before midnight can't see the hours after it: the first tick of a day closes the day
 * before, and the day after that no tick touches it again. Not in `rollupDay`, so the backfill never
 * replays it: tickets are erased with their submitter's account (D33), and a replay over a thinned
 * table would overwrite the days this series alone remembers.
 */
async function rollupSupportQueue(ctx: MutationCtx, now: number): Promise<void> {
  const today = metricDayStart(metricDay(now));
  const yesterday = today - DAY_MS;

  const candidates: Doc<'supportTickets'>[] = [];
  for (const status of OPEN_TICKET_STATUSES) {
    candidates.push(
      ...(await capped(
        ctx.db
          .query('supportTickets')
          .withIndex('by_status', (q) => q.eq('status', status))
          .take(DAY_SCAN_CAP),
        DAY_SCAN_CAP,
        `${status} support tickets`,
      )),
    );
  }
  // `resolvedAt` is optional, so the range carries its lower bound: a bare range would also match
  // every resolved row lacking the field, which sorts first.
  candidates.push(
    ...(await capped(
      ctx.db
        .query('supportTickets')
        .withIndex('by_status_resolved_at', (q) =>
          q.eq('status', 'resolved').gte('resolvedAt', yesterday),
        )
        .take(DAY_SCAN_CAP),
      DAY_SCAN_CAP,
      'support tickets resolved since yesterday',
    )),
  );

  for (const from of [yesterday, today]) {
    const open = candidates.filter((t) =>
      wasOpenDuring({ openedAt: t.createdAt, closedAt: t.resolvedAt }, from, from + DAY_MS),
    );
    await writeMetricSnapshot(ctx, 'support_queue_depth', metricDay(from), {
      meta: countBy(open.map((t) => t.category)),
      scalar: open.length,
    });
  }
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
// Scheduled jobs — each is its own transaction, so no single mutation reads past the budget
// ─────────────────────────────────────────────────────────────────────────────

/** One UTC day of the day-scoped rollups, as a schedulable unit. */
export const rollupDayJob = internalMutation({
  args: { date: v.string() },
  handler: (ctx, { date }) => rollupDay(ctx, date),
});

/** One UTC day of the Overview's pulse (B01), its own transaction beside `rollupDayJob`. */
export const rollupPulseDayJob = internalMutation({
  args: { date: v.string() },
  handler: (ctx, { date }) => rollupPulseDay(ctx, date),
});

/** The point-in-time chunks, each a separate transaction (see the scan-cap note). */
export const rollupDistributionsJob = internalMutation({
  args: {},
  handler: (ctx) => rollupDistributions(ctx, Date.now()),
});
export const rollupActivityJob = internalMutation({
  args: {},
  handler: (ctx) => rollupActivity(ctx, Date.now()),
});
export const rollupOperationalJob = internalMutation({
  args: {},
  handler: (ctx) => rollupOperational(ctx, Date.now()),
});

/** The five point-in-time + two-day jobs a full rollup fans out to (`runAfter(0)`, so no ordering). */
async function scheduleRollupJobs(ctx: MutationCtx, now: number): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupDayJob, {
    date: metricDay(now - DAY_MS),
  });
  await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupDayJob, { date: metricDay(now) });
  for (const date of [metricDay(now - DAY_MS), metricDay(now)]) {
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupPulseDayJob, { date });
  }
  await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupDistributionsJob, {});
  await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupActivityJob, {});
  await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupOperationalJob, {});
  // The season so far, counted once each (B01): its own self-chaining walk (`seasonReach.ts`).
  await ctx.scheduler.runAfter(0, internal.seasonReach.start, {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scheduled rollup (cron entry). Recomputes **today and yesterday** plus the point-in-time
 * metrics, but **fans each out to its own transaction** rather than running them inline — a single
 * mutation running every scan at once would, at scale, exceed Convex's per-transaction read budget
 * before the scan caps ever engaged (see the scan-cap note). The jobs write disjoint metric keys, so
 * order doesn't matter and a `runAfter(0)` fan-out is safe. Snapshot writes replace, so running it four
 * times a day is idempotent and gives the dashboard near-live numbers without a corpus-scanning read
 * path. Yesterday is included so a day still accumulating at the last tick before midnight completes.
 */
export const runRollup = internalMutation({
  args: {},
  handler: (ctx) => scheduleRollupJobs(ctx, Date.now()),
});

/**
 * Replay the day-scoped rollups over the last `days` UTC days — for a fresh deployment, or after a
 * metric's definition changes. **Self-chains one day per transaction** (like `sweepCorpus`): a single
 * mutation looping hundreds of days would blow the per-transaction read budget on cumulative reads even
 * at modest per-day volume. Each step does one day, then schedules the next; the last step fans out the
 * point-in-time jobs. Only the day-scoped half is replayable (a histogram of *current* reputation has
 * no meaning for last Tuesday), and only from rows that still exist: `bountyGateEvents` is forward-only,
 * so backfilled days predating it show honest zeroes. Run with
 * `pnpm exec convex run analyticsRollup:backfill '{"days":30}'`.
 */
export const backfill = internalMutation({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const count = Math.min(Math.max(1, days ?? TRAILING_30_DAYS), 365);
    // Kick the chain at the oldest day; each step walks one day newer until offset 0 (today).
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.backfillStep, { offset: count - 1 });
    return { days: count };
  },
});

/**
 * One day of the backfill chain: roll up `today − offset`, then schedule the next-newer day — or, at
 * offset 0, fan out the point-in-time jobs (stamped today, once, at the end). `now` is re-read each
 * step; across a multi-second backfill the day keys are stable enough (the boundary case just
 * recomputes an adjacent day on the next scheduled rollup).
 */
export const backfillStep = internalMutation({
  args: { offset: v.number() },
  handler: async (ctx, { offset }) => {
    const now = Date.now();
    const date = metricDay(now - offset * DAY_MS);
    await rollupDay(ctx, date);
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupPulseDayJob, { date });
    if (offset > 0) {
      await ctx.scheduler.runAfter(0, internal.analyticsRollup.backfillStep, {
        offset: offset - 1,
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupDistributionsJob, {});
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupActivityJob, {});
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupOperationalJob, {});
    await ctx.scheduler.runAfter(0, internal.seasonReach.start, {});
  },
});

/**
 * `bountyGateEvents` retention. The one append-per-attempt table in the analytics set, and the one
 * carrying `requesterId` — so the bound is as much "don't accumulate a permanent behavioral record"
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

/** How long a `clientSignalEvents` rate-limit row lives — just past the window, then it's noise. */
const CLIENT_SIGNAL_RETENTION_DAYS = 2;

/**
 * `clientSignalEvents` retention. These rows exist only to rate-limit the client analytics signal, so
 * they're worthless once past the (1h) window — kept a couple days for margin, then dropped. Bounded
 * page per run, daily cadence; a backlog drains over days rather than blowing a transaction.
 */
export const pruneClientSignals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - CLIENT_SIGNAL_RETENTION_DAYS * DAY_MS;
    const stale = await ctx.db
      .query('clientSignalEvents')
      .withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
      .take(DAY_SCAN_CAP);
    for (const row of stale) await ctx.db.delete(row._id);
    // The sign-in record's retention rides this daily prune (D254): its own transaction.
    await ctx.scheduler.runAfter(0, internal.analyticsRollup.pruneSignInDays, {});
    return { deleted: stale.length };
  },
});

/**
 * `signInDays` retention (the founder, 2026-11-13; D254): the current season and one past season
 * are kept — "one past season seems like it should be fine" — and every day before the previous
 * season's 1 July is erased. A page per transaction: a full page schedules the next, so a backlog
 * drains in one run without any one transaction reading past the cap. The day range carries its
 * lower bound, as every range over this index does.
 */
export const pruneSignInDays = internalMutation({
  args: {},
  handler: async (ctx) => {
    const keepFrom = signInRetentionFrom(Date.now());
    const stale = await ctx.db
      .query('signInDays')
      .withIndex('by_day', (q) => q.gte('day', '0000-01-01').lt('day', keepFrom))
      .take(DAY_SCAN_CAP);
    for (const row of stale) await ctx.db.delete(row._id);
    if (stale.length === DAY_SCAN_CAP) {
      await ctx.scheduler.runAfter(0, internal.analyticsRollup.pruneSignInDays, {});
    }
    return { deleted: stale.length, keepFrom };
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
      // Rejected / merged bodies aren't coverage, and neither is a removed one (A07b: reachable, but
      // a takedown is not a lake we cover). A dormant body IS counted — it lands in the z16 band,
      // which is how the chart shows the active/dormant split without a second sweep.
      if (!isListed(body) || standingOf(body).standing === 'removed') continue;
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
