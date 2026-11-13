/**
 * The Overview's Metrics tab (B01 §5.1, board 1.4): three reads, one per section — *Keeping up*,
 * *Showing up*, *Coverage by state* — each shaped like the tab's props (`metricsModel.ts` in the web
 * app), so the page swaps a section's `null`s for its read.
 *
 * **`null` means not recorded, never zero.** A day no rollup wrote, a figure whose read stopped
 * short, a season total the walk hasn't produced, a record that began partway through the week —
 * each is `null`, which the tab draws as absent. A zero is a measured zero.
 *
 * **Every season-ranged figure takes the season** (`season`, the year it began; absent or
 * unnameable reads the season now falls in). Its window is `seasonRecordWindow`: 1 October through
 * today, or a past season whole; empty from 1 July to 30 September, when the tab says when the
 * record begins. The *now* and *this week* figures read the same whichever season is shown.
 *
 * **Moderators read it** (`metrics.read`). Support's half carries what only an admin may see about
 * the support queue (PII, D37): without `inbox.support.read` it is `null`, as the tab expects.
 *
 * Everything is a bounded read: rollup rows over the window's days (at most a season of one metric
 * each), a few capped index ranges for *now* and *this week*, and point reads for names.
 */

import {
  lastDays,
  type MetricKey,
  OBSERVED_FROM,
  type ObservedFrom,
  resolveSeason,
  type Season,
  seasonOf,
  seasonRecordWindow,
  sumRecorded,
} from '@skating/core';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { hasCapability, requireCapability } from './lib/auth';
import { accountsTotal, latestMetric, latestMetricIn, metricOverDays } from './lib/metricReads';
import { flagBodyId, readOpenFlags } from './lib/openFlags';
import { isCountedComment } from './lib/pulse';

/** Past this many open flags, *Open flags* is not recorded rather than a floor. */
const OPEN_FLAG_CAP = 1_000;
/** Past this many open tickets, likewise. */
const OPEN_TICKET_CAP = 1_000;
/** The most rows one *this week* figure reads before it says *not recorded*. */
const WEEK_CAP = 2_000;
/** The most contributors *first-time* looks up (three point reads each). */
const FIRST_TIME_CAP = 300;

const seasonArg = { season: v.optional(v.number()) };

/** The season asked for, its window, and the instant they're read at. */
function windowOf(season: number | undefined) {
  const now = Date.now();
  const s: Season = resolveSeason(season, seasonOf(now));
  return { now, season: s, ...seasonRecordWindow(s, now) };
}

/** The scalars of a metric's rows over `days`, aligned; `null` for a day not recorded. */
async function scalarsOver(
  ctx: QueryCtx,
  metric: Parameters<typeof metricOverDays>[1],
  days: readonly string[],
): Promise<Array<number | null>> {
  return (await metricOverDays(ctx, metric, days)).map((r) => r?.scalar ?? null);
}

/** A season-stamped point-in-time row (`season_reach`, `most_reported`) for `season`, or `null`. */
async function seasonRow<T extends { season: number }>(
  ctx: QueryCtx,
  metric: 'season_reach' | 'most_reported',
  season: Season,
  days: readonly string[],
): Promise<T | null> {
  const row = await latestMetricIn(ctx, metric, days);
  const meta = row?.meta as T | undefined;
  return meta !== undefined && meta.season === season ? meta : null;
}

/** What `season_reach` stores (`seasonReach.reachMeta`). */
type Reach = {
  season: number;
  counts: { reports: number; comments: number; kudos: number; photos: number; hazards: number };
  over: { reports: number; comments: number; kudos: number; photos: number; hazards: number };
  people: { signedIn: number; contributors: number };
  vantage: Record<string, number>;
  states: Record<
    string,
    { reports: number; comments: number; photos: number; kudos: number; contributors: number }
  >;
  capped: string[];
};

/** A body's name for a row that names it; `null` if the body is gone. */
async function bodyName(ctx: QueryCtx, id: Id<'waterBodies'> | null): Promise<string | null> {
  if (id === null) return null;
  return (await ctx.db.get(id))?.name ?? null;
}

// ── Keeping up ──────────────────────────────────────────────────────────────────────────────────

const SUPPORT_KEYS = ['bug', 'account', 'other', 'safety'] as const;
type SupportKey = (typeof SUPPORT_KEYS)[number];

/** Support's half of Keeping up, as the tab's `SupportMetrics`. */
type SupportMetrics = {
  open: number | null;
  oldestOpenedAt: number | null;
  resolveSeason: number[] | null;
  depthByDay: Array<Partial<Record<SupportKey, number>> | null>;
};

export const keepingUp = query({
  args: seasonArg,
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'metrics.read');
    const { now, season, opensOn, days } = windowOf(args.season);
    const week = lastDays(now, 7);

    // Now: the queue as it stands. Open means `open` or `reviewing` (`lib/openFlags`).
    const open = await readOpenFlags(ctx, OPEN_FLAG_CAP);
    const oldest = open.flags[0];
    const openFlags = open.capped
      ? null
      : {
          total: open.flags.length,
          safety: open.flags.filter((f) => f.reason === 'unsafe_false_report').length,
        };
    const oldestOpenFlag =
      open.capped || oldest === undefined
        ? null
        : { openedAt: oldest.createdAt, where: await bodyName(ctx, await flagBodyId(ctx, oldest)) };

    // The season: the rollup's rows over the window, and the last seven days.
    const resolvedWeek = sumRecorded(
      (await metricOverDays(ctx, 'flag_time_to_resolution_h', week.days)).map((r) => r?.buckets),
    );
    const resolvedSeason = sumRecorded(
      (await metricOverDays(ctx, 'flag_time_to_resolution_h', days)).map((r) => r?.buckets),
    );
    const oldestHours = await scalarsOver(ctx, 'flag_oldest_open_age_h', days);
    const depth = await metricOverDays(ctx, 'flag_queue_depth', days);
    const queueByDay = days.map((_, i) => {
      const hours = oldestHours[i];
      const meta = depth[i]?.meta as { priority?: number; standard?: number } | undefined;
      if (hours == null || meta === undefined) return null;
      return { oldestHours: hours, standard: meta.standard ?? 0, safety: meta.priority ?? 0 };
    });

    let support: SupportMetrics | null = null;
    if (hasCapability(viewer, 'inbox.support.read')) {
      const waiting: Doc<'supportTickets'>[] = [];
      let capped = false;
      for (const status of ['open', 'in_progress'] as const) {
        const page = await ctx.db
          .query('supportTickets')
          .withIndex('by_status', (q) => q.eq('status', status))
          .take(OPEN_TICKET_CAP + 1);
        capped ||= page.length > OPEN_TICKET_CAP;
        waiting.push(...page);
      }
      const depthRows = await metricOverDays(ctx, 'support_queue_depth', days);
      support = {
        open: capped ? null : waiting.length,
        oldestOpenedAt:
          capped || waiting.length === 0 ? null : Math.min(...waiting.map((t) => t.createdAt)),
        resolveSeason: sumRecorded(
          (await metricOverDays(ctx, 'support_time_to_resolution_h', days)).map((r) => r?.buckets),
        ),
        depthByDay: depthRows.map((r) => {
          if (r === null) return null;
          const meta = (r.meta ?? {}) as Record<string, number>;
          return Object.fromEntries(
            SUPPORT_KEYS.filter((k) => (meta[k] ?? 0) > 0).map((k) => [k, meta[k] as number]),
          ) as Partial<Record<SupportKey, number>>;
        }),
      };
    }

    return {
      season,
      opensOn,
      days,
      keepingUp: {
        openFlags,
        oldestOpenFlag,
        resolvedWeek,
        resolveSeason: resolvedSeason,
        queueByDay,
        support,
      },
    };
  },
});

// ── Showing up ──────────────────────────────────────────────────────────────────────────────────

const PULSE_KEYS = [
  'reports',
  'comments',
  'kudos',
  'photos',
  'hazards',
  'accounts',
  'signedIn',
  'contributors',
] as const;
type PulseKey = (typeof PULSE_KEYS)[number];
type PulseSeries = { daily: Array<number | null>; total: number; over?: number };

/** Each strip's daily rollup. */
const PULSE_METRIC = {
  reports: 'reports_created',
  comments: 'comments_created',
  kudos: 'positive_reactions',
  photos: 'photos_added',
  hazards: 'hazards_created',
  accounts: 'signups',
  signedIn: 'signed_in',
  contributors: 'daily_contributors',
} as const satisfies Record<PulseKey, MetricKey>;

/** The `season_reach` id set each strip's *over* (or distinct total) is counted from. */
const OVER_SET = {
  reports: 'posts',
  comments: 'commented',
  kudos: 'kudosPeople',
  photos: 'photographed',
  hazards: 'hazardBodies',
} as const;

/**
 * The strips from their daily rows and the season's reach. A count strip's total and *over* come
 * from the reach (the whole season, exactly); a people strip's total is the reach's distinct count;
 * new accounts add up their days, so they are a total only when every day was recorded. Without
 * what a strip's total needs — the reach not yet walked, or its set capped — the strip is `null`,
 * never a zero beside real days.
 */
function pulseFrom(
  daily: Record<PulseKey, Array<number | null>>,
  reach: Reach | null,
  days: readonly string[],
): Record<PulseKey, PulseSeries | null> {
  const out = {} as Record<PulseKey, PulseSeries | null>;
  const uncapped = (name: string) => reach !== null && !reach.capped.includes(name);
  for (const key of PULSE_KEYS) {
    if (days.length === 0) {
      out[key] = null;
      continue;
    }
    if (key === 'accounts') {
      const recorded = daily.accounts.every((n) => n !== null);
      out[key] = recorded
        ? { daily: daily.accounts, total: daily.accounts.reduce<number>((a, n) => a + (n ?? 0), 0) }
        : null;
    } else if (key === 'signedIn' || key === 'contributors') {
      out[key] =
        reach !== null && uncapped(key) ? { daily: daily[key], total: reach.people[key] } : null;
    } else {
      out[key] =
        reach !== null && uncapped(OVER_SET[key])
          ? { daily: daily[key], total: reach.counts[key], over: reach.over[key] }
          : null;
    }
  }
  return out;
}

export const showingUp = query({
  args: seasonArg,
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'metrics.read');
    const { now, season, opensOn, days } = windowOf(args.season);
    const week = lastDays(now, 7);

    // ── This week (not season-ranged) ────────────────────────────────────────────────────────
    const weekReports = await ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q
          .eq('moderationStatus', 'visible')
          .gte('skateEndTime', week.from)
          .lt('skateEndTime', week.to),
      )
      .take(WEEK_CAP + 1);
    const reportsCapped = weekReports.length > WEEK_CAP;
    const reports = reportsCapped
      ? null
      : { count: weekReports.length, people: new Set(weekReports.map((r) => r.authorId)).size };

    const added = await ctx.db
      .query('profiles')
      .withIndex('by_created_at', (q) => q.gte('createdAt', week.from))
      .take(WEEK_CAP + 1);
    const total = await accountsTotal(ctx);
    const accounts =
      added.length > WEEK_CAP || total === null || total.capped
        ? null
        : { added: added.length, total: total.count };

    const signedIn = await weekSignIns(ctx, week.days);
    const contributors = reportsCapped ? null : await weekContributors(ctx, week, weekReports);

    // ── The season ───────────────────────────────────────────────────────────────────────────
    const daily = Object.fromEntries(
      await Promise.all(
        PULSE_KEYS.map(
          async (key) => [key, await scalarsOver(ctx, PULSE_METRIC[key], days)] as const,
        ),
      ),
    ) as Record<PulseKey, Array<number | null>>;
    const reach =
      days.length === 0 ? null : await seasonRow<Reach>(ctx, 'season_reach', season, days);

    const vantage =
      reach === null
        ? null
        : {
            ...(Object.fromEntries(OBSERVED_FROM.map((k) => [k, reach.vantage[k] ?? 0])) as Record<
              ObservedFrom,
              number
            >),
            unstated: reach.vantage.unstated ?? 0,
          };

    return {
      season,
      opensOn,
      days,
      showingUp: {
        week: { reports, accounts, signedIn, contributors },
        pulse: pulseFrom(daily, reach, days),
        vantage,
        mostReported: days.length === 0 ? null : await mostReportedRows(ctx, season, days),
      },
    };
  },
});

/**
 * *Signed in* this week, and *on two days or more* of it. `null` unless the sign-in record covers
 * the whole week (it began with B01-1, so its first week is partial) and the read was whole.
 */
async function weekSignIns(
  ctx: QueryCtx,
  days: readonly string[],
): Promise<{ people: number; twoDaysOrMore: number } | null> {
  const first = days[0] as string;
  const last = days[days.length - 1] as string;
  const began = await ctx.db.query('signInDays').withIndex('by_day').first();
  if (began === null || began.day > first) return null;
  const rows = await ctx.db
    .query('signInDays')
    .withIndex('by_day', (q) => q.gte('day', first).lte('day', last))
    .take(WEEK_CAP + 1);
  if (rows.length > WEEK_CAP) return null;
  const perPerson = new Map<string, number>();
  for (const r of rows) perPerson.set(r.userId, (perPerson.get(r.userId) ?? 0) + 1);
  return {
    people: perPerson.size,
    twoDaysOrMore: [...perPerson.values()].filter((n) => n >= 2).length,
  };
}

/**
 * *Contributors* this week — anyone who posted a visible report (by skate end), a hazard or a
 * visible comment, the pulse's rule — and how many of them contributed for the first time: their
 * earliest report, hazard and comment of any kind all fall inside the week.
 */
async function weekContributors(
  ctx: QueryCtx,
  week: { from: number; to: number },
  reports: readonly Doc<'reports'>[],
): Promise<{ people: number; firstTime: number } | null> {
  const hazards = await ctx.db
    .query('hazards')
    .withIndex('by_created_at', (q) => q.gte('createdAt', week.from).lt('createdAt', week.to))
    .take(WEEK_CAP + 1);
  const comments = await ctx.db
    .query('comments')
    .withIndex('by_created_at', (q) => q.gte('createdAt', week.from).lt('createdAt', week.to))
    .take(WEEK_CAP + 1);
  if (hazards.length > WEEK_CAP || comments.length > WEEK_CAP) return null;
  const people = new Set<Id<'profiles'>>([
    ...reports.map((r) => r.authorId),
    ...hazards.map((h) => h.createdByUserId),
    ...comments.filter(isCountedComment).map((c) => c.authorId),
  ]);
  if (people.size > FIRST_TIME_CAP) return null;
  let firstTime = 0;
  for (const id of people) {
    const firstReport = await ctx.db
      .query('reports')
      .withIndex('by_author', (q) => q.eq('authorId', id))
      .first();
    const firstHazard = await ctx.db
      .query('hazards')
      .withIndex('by_author_created', (q) => q.eq('createdByUserId', id))
      .first();
    const firstComment = await ctx.db
      .query('comments')
      .withIndex('by_author', (q) => q.eq('authorId', id))
      .first();
    const earliest = Math.min(
      firstReport?.createdAt ?? Number.POSITIVE_INFINITY,
      firstHazard?.createdAt ?? Number.POSITIVE_INFINITY,
      firstComment?.createdAt ?? Number.POSITIVE_INFINITY,
    );
    if (earliest >= week.from) firstTime++;
  }
  return { people: people.size, firstTime };
}

/** The season's most-reported bodies, named; `null` until the walk has ranked them whole. */
async function mostReportedRows(ctx: QueryCtx, season: Season, days: readonly string[]) {
  const ranked = await seasonRow<{
    season: number;
    capped: boolean;
    rows: Array<{
      bodyId: Id<'waterBodies'>;
      reports: number;
      photos: number;
      people: number;
      lastReportAt: number;
    }>;
  }>(ctx, 'most_reported', season, days);
  if (ranked === null || ranked.capped) return null;
  const out = [];
  for (const row of ranked.rows) {
    const name = await bodyName(ctx, row.bodyId);
    if (name !== null) out.push({ ...row, bodyId: row.bodyId as string, name });
  }
  return out;
}

// ── Coverage by state ───────────────────────────────────────────────────────────────────────────

/**
 * Listed bodies, each counted once, and per state: its listed bodies (from the weekly corpus sweep —
 * a property of the corpus, not of the season) and the season's reports, comments, photos, kudos
 * and contributors, by the state each report was filed from. `listedBodies` is `null`, with no rows,
 * until the sweep has run; a state's activity is `null` until the season's walk has.
 */
export const coverage = query({
  args: seasonArg,
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'metrics.read');
    const { season, opensOn, days } = windowOf(args.season);
    const bands = await latestMetric(ctx, 'zoom_band_distribution');
    const states = await latestMetric(ctx, 'state_coverage');
    if (bands?.scalar === undefined || states === null) {
      return { season, opensOn, days, coverage: { listedBodies: null, states: [] } };
    }
    const reach =
      days.length === 0 ? null : await seasonRow<Reach>(ctx, 'season_reach', season, days);
    const bodies = Object.entries((states.meta ?? {}) as Record<string, number>)
      .filter(([key]) => key.endsWith(':bodies') && !key.startsWith('unknown:'))
      .map(([key, n]) => [key.slice(0, -':bodies'.length), n] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      season,
      opensOn,
      days,
      coverage: {
        listedBodies: bands.scalar,
        states: bodies.map(([state, n]) => {
          const s = reach?.states[state];
          const of = (k: 'reports' | 'comments' | 'photos' | 'kudos') =>
            reach === null ? null : (s?.[k] ?? 0);
          return {
            state,
            bodies: n,
            reports: of('reports'),
            comments: of('comments'),
            photos: of('photos'),
            kudos: of('kudos'),
            contributors:
              reach === null || reach.capped.includes(`states.${state}.contributors`)
                ? null
                : (s?.contributors ?? 0),
          };
        }),
      },
    };
  },
});
