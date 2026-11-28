/**
 * **Machinery › Imagery's reads and writes** (D344, D346, D348, B01-8b-2): the season's live imagery
 * as the page draws it — its state, the head's stats, its three crons' cards, the granules, one
 * granule's attempts and an attempt's log — and the five writes in its floating bar.
 *
 * Reads are gated `machinery.read`; writes `machinery.imagery`, each one audit row (`auditImagery`,
 * target `imagerySeason`, its id the season), refusals thrown as sentences (toasts on the web). Start
 * and Pause are each other's undo (`lib/undoHandlersMachinery.ts`); *Run now*, *Retry failed* and
 * *Try again now* are audited triggers with no inverse. Every read is a bounded `.take()` or one
 * `.paginate()`; the page reads only Convex (no action on a read, no signed URL in a browser).
 *
 * Granules cut before B01-8b-2 have no attempts and no log: `granule` says `before8b`, the head's
 * machine-minutes say when they were first counted (`fly.countedFrom`).
 */

import {
  addDaysIso,
  archiveSeasonAt,
  CRON_KILLED_AFTER_MS,
  callerNow,
  DEFAULT_SEASON_WATCH_SETTINGS,
  seasonStartYear,
  worstCronJob,
} from '@skating/core';
import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import {
  auditImagery,
  IMAGERY_CRON_JOBS,
  MAX_LIVE_MACHINES,
  retryFailedImpl,
  seasonRowFor,
  tryAgainNowImpl,
  whyNotRunnable,
} from './imageryLive';
import { requireCapability } from './lib/auth';
import type { JobState } from './lib/cronJobState';
import { flyConfigFromEnv } from './lib/fly';
import { clearBackoff, jobRow } from './lib/imageryPump';
import { r2ConfigFromEnv } from './lib/r2';
import { literals } from './lib/validators';
import { type CronJobView, cronJobViews, personOf } from './machineryCrons';
import type { PersonView, RunEventView } from './machineryRuns';
import { readSentinelLows } from './sentinelLows';

// ── The views ──────────────────────────────────────────────────────────────────────────────────

/**
 * The season's imagery as the page reads it: `noWatch` (no season row yet), `notStarted` (the watch
 * is waiting for cold, or crossed and ready to start), `running`, `paused`, `ended`.
 */
export type ImageryState = 'notStarted' | 'running' | 'paused' | 'ended' | 'noWatch';

/** The granule list's filters; `cutting` is the `spawned` status. */
export const GRANULE_FILTERS = ['all', 'queued', 'cutting', 'empty', 'failed'] as const;
export type GranuleFilter = (typeof GRANULE_FILTERS)[number];

/** The granule list's page; `failedFirst`'s bound. */
export const GRANULES_PAGE_SIZE = 25;
export const FAILED_FIRST_LIMIT = 50;
/** The attempts one granule's detail reads (`by_granule_attempt`). */
export const GRANULE_ATTEMPTS_LIMIT = 10;
/** An attempt log's page (as a cron run's). */
export const ATTEMPT_LOG_PAGE_SIZE = 200;

/**
 * The waiting and crossed states' facts (*Waiting for cold*, *Line crossed*), from the season watch's
 * own reads: the watch's row, the imagery line, the night it was crossed (if it was), the coldest
 * sentinel night so far, and when the staff emails went. Air temperature at named sites, never ice
 * (D3): nothing here says any water froze.
 */
export type WatchFacts = {
  season: string;
  /** The watch's opening night (`YYYY-MM-DD`, the row's `opensOn`), or `null` with no watch open. */
  opensOn: string | null;
  /** When the watch's row was recorded (`detectedAt`), or `null` with no watch open. */
  openedAt: number | null;
  /** The imagery line the watch decides on, °C (the settings that decided the season, else current). */
  lineC: number;
  /**
   * The first sentinel night at or below the imagery line, with the sentinels that reached it — the
   * *Line crossed* state — or `null` while it waits for cold.
   */
  crossed: { on: string; sites: { name: string; lowC: number }[] } | null;
  /**
   * The coldest stored sentinel night so far this season (the closest to the line), or `null` before
   * the first; read only in the not-started states (`null` once imagery has started).
   */
  closestNight: { date: string; lowC: number; site: string } | null;
  /** When the *Time to start satellite imagery* email went (`emailsSent`, kind `imagery`), or `null`. */
  staffEmailAt: number | null;
  /** When the *Ice watch has begun* email went (kind `opened`), or `null`. */
  openedEmailAt: number | null;
};

/**
 * The page's head and frame. `fly.countedFrom`: when attempts (and so machine-minutes) began to be
 * recorded, if this season cut before then — the head's *Counted from <day>*; `null` when the season's
 * every cut is counted.
 */
export type ImageryPageView = {
  season: string;
  state: ImageryState;
  startedBy: PersonView | null;
  startedAt: number | null;
  /** The season's ledger (`imageryCounts`). */
  counts: { queued: number; spawned: number; landed: number; empty: number; failed: number };
  /** Machines live when the pump last listed them, of the cap; `null` before the first listing. */
  machines: { live: number | null; cap: number; at: number | null };
  /** The live index: built, its frame count, and when a stalled rebuild next re-reads. */
  index: { built: boolean; frames: number; retryAt: number | null };
  /** Fly this season, in machine-minutes only (ms); `countedFrom` when it began before 8b. */
  fly: { machineMs: number; countedFrom: number | null };
  /** The cutter image the pump spawns with, and when it first saw it. */
  image: { ref: string; seenAt: number } | null;
  /** The poll, the pump and the index, in that order (`machineryCrons.cronJobViews`). */
  crons: CronJobView[];
  backoffUntil: number | null;
  /** Whether Fly and R2 are configured on this deployment (names only, never values). */
  configured: boolean;
  watch: WatchFacts | null;
};

/** A row of the granule list. */
export type GranuleRowView = {
  id: Id<'imageryGranules'>;
  granuleId: string;
  mission: Doc<'imageryGranules'>['mission'];
  season: string;
  capturedAt: string;
  status: Doc<'imageryGranules'>['status'];
  attempts: number;
  refusals: number;
  queuedAt: number;
  spawnedAt: number | null;
  settledAt: number | null;
  /** When the catalog published the pass; `null` on rows queued before 8b. */
  catalogedAt: number | null;
  lastError: string | null;
  /** An empty cut's reason (the marker's), or `null`. */
  emptyReason: string | null;
};

/** One attempt, as the granule's *Attempts* and *What to check* read it. */
export type AttemptView = {
  id: Id<'imageryAttempts'>;
  attempt: number;
  machineName: string;
  machineId: string | null;
  image: string | null;
  spawnedAt: number;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  verdict: Doc<'imageryAttempts'>['verdict'];
  error: string | null;
  machineMs: number | null;
  machineMsFrom: Doc<'imageryAttempts'>['machineMsFrom'] | null;
  log: Doc<'imageryAttempts'>['log'];
  settledAt: number | null;
};

/**
 * A granule's detail: its row, its attempts oldest first (the newest {@link GRANULE_ATTEMPTS_LIMIT}),
 * and `before8b` — it was tried before attempts were recorded, so the earliest of its tries aren't
 * listed (the row's `attempts` count and `lastError` are what they kept).
 */
export type GranuleView = { row: GranuleRowView; attempts: AttemptView[]; before8b: boolean };

/**
 * Machinery's *Imagery* lane tail (`machineryRuns.lanes`): `notStarted` (no watch, or not pressed;
 * `ready` once a sentinel crossed the imagery line, so a start waits on a person), `paused`,
 * `ended`, or — running — the worst of its three crons' card states (core's `worstCronJob`, the
 * Overview card's rule), with when; `crons` carries the three views while running, so the sidebar
 * re-reads them on its own clock.
 */
export type ImageryLaneTail = {
  state: 'notStarted' | 'paused' | 'ended' | JobState;
  at: number | null;
  crons: CronJobView[] | null;
  ready: boolean;
};

/** A line of an attempt's log: a run's line, and who wrote it. */
export type AttemptLogLineView = RunEventView & { origin: Doc<'runEvents'>['origin'] | null };

/** Every write's receipt: the audit row it wrote. */
export type ImageryReceipt = { actionId: Id<'moderationActions'> };

// ── The refusals, in words a person can read (D268, toasts on the web) ─────────────────────────────

export const NO_WATCH = (season: string) =>
  `No watch is open for ${season}, so there's nothing to start.`;
export const NO_WATCH_TO_PAUSE = (season: string) =>
  `No watch is open for ${season}, so there's nothing to pause.`;
export const WATCH_ENDED = (season: string) =>
  `The ${season} watch has ended, so its imagery has stopped for the season.`;
export const ALREADY_RUNNING = 'Imagery is already running.';
export const NOT_STARTED = 'Imagery hasn’t been started, so there’s nothing to pause.';
export const ALREADY_PAUSED = 'Imagery is already paused.';
export const POLL_NOT_RUNNING =
  'Imagery isn’t running, so a catalog check now would do nothing. Start or resume it first.';
export const POLL_RUNNING = 'A catalog check is already running.';
export { NO_FAILED_CUTS, NOTHING_WAITING } from './imageryLive';

/** How far the caller's clock may sit from the server's (`callerNow`). */
const CLOCK_SLACK_MS = 60_000;

// ── The state ──────────────────────────────────────────────────────────────────────────────────

/** The season's imagery state from its watch row (the page's and the lane's one rule). */
export function imageryStateOf(row: Doc<'imageryIngestSeasons'> | null): ImageryState {
  if (row === null) return 'noWatch';
  if (row.closesOn !== undefined) return 'ended';
  if (row.imageryStartedAt === undefined) return 'notStarted';
  if (row.imageryPausedAt !== undefined) return 'paused';
  return 'running';
}

/** The three imagery crons, in the page's order. */
const IMAGERY_JOBS = [IMAGERY_CRON_JOBS.poll, IMAGERY_CRON_JOBS.pump, IMAGERY_CRON_JOBS.index];

/** The lane's tail, from the season's row and (while running) its crons (`ImageryLaneTail`). */
export async function imageryLaneTail(ctx: QueryCtx, now: number): Promise<ImageryLaneTail> {
  const row = await seasonRowFor(ctx, archiveSeasonAt(now));
  const state = imageryStateOf(row);
  if (state !== 'running') {
    return {
      state: state === 'noWatch' ? 'notStarted' : state,
      at: null,
      crons: null,
      ready: state === 'notStarted' && row?.imageryNudgeOn !== undefined,
    };
  }
  const crons = await cronJobViews(ctx, IMAGERY_JOBS, now);
  return { ...worstCronJob(crons), crons, ready: false };
}

// ── The views from rows ──────────────────────────────────────────────────────────────────────────

export function granuleRowView(g: Doc<'imageryGranules'>): GranuleRowView {
  return {
    id: g._id,
    granuleId: g.granuleId,
    mission: g.mission,
    season: g.season,
    capturedAt: g.capturedAt,
    status: g.status,
    attempts: g.attempts,
    refusals: g.refusals ?? 0,
    queuedAt: g.queuedAt,
    spawnedAt: g.spawnedAt ?? null,
    settledAt: g.settledAt ?? null,
    catalogedAt: g.catalogedAt ?? null,
    lastError: g.lastError ?? null,
    emptyReason: g.emptyReason ?? null,
  };
}

export function attemptView(a: Doc<'imageryAttempts'>): AttemptView {
  return {
    id: a._id,
    attempt: a.attempt,
    machineName: a.machineName,
    machineId: a.machineId ?? null,
    image: a.image ?? null,
    spawnedAt: a.spawnedAt,
    startedAt: a.startedAt ?? null,
    exitedAt: a.exitedAt ?? null,
    exitCode: a.exitCode ?? null,
    oomKilled: a.oomKilled ?? null,
    verdict: a.verdict,
    error: a.error ?? null,
    machineMs: a.machineMs ?? null,
    machineMsFrom: a.machineMsFrom ?? null,
    log: a.log,
    settledAt: a.settledAt ?? null,
  };
}

/** The watch's facts for the page (`WatchFacts`); the sentinels' coldest night only before Start. */
async function watchFactsOf(
  ctx: QueryCtx,
  season: string,
  row: Doc<'imageryIngestSeasons'> | null,
  readNights: boolean,
  now: number,
): Promise<WatchFacts> {
  const settings =
    row?.settings ??
    (await ctx.db.query('seasonWatchSettings').withIndex('by_version').order('desc').first())
      ?.settings ??
    DEFAULT_SEASON_WATCH_SETTINGS;
  const sent = (kind: string) =>
    (row?.emailsSent ?? []).filter((e) => e.kind === kind).at(-1)?.sentAt ?? null;
  let closestNight: WatchFacts['closestNight'] = null;
  if (readNights) {
    const lows = await readSentinelLows(ctx, { season: seasonStartYear(season), now });
    if (lows.state === 'value') {
      for (const sentinel of lows.sentinels) {
        sentinel.lows.forEach((lowC, i) => {
          if (lowC === null) return;
          if (closestNight === null || lowC < closestNight.lowC) {
            closestNight = { date: addDaysIso(lows.firstDate, i), lowC, site: sentinel.name };
          }
        });
      }
    }
  }
  return {
    season,
    opensOn: row?.opensOn ?? null,
    openedAt: row?.detectedAt ?? null,
    lineC: settings.imageryNudgeC,
    crossed:
      row?.imageryNudgeOn === undefined
        ? null
        : {
            on: row.imageryNudgeOn,
            sites: (row.imageryNudgeSites ?? []).map((s) => ({ name: s.name, lowC: s.lowC })),
          },
    closestNight,
    staffEmailAt: sent('imagery'),
    openedEmailAt: sent('opened'),
  };
}

/**
 * When machine-minutes began to be counted, if this season cut before then: the first attempt ever
 * recorded (the deploy that began recording), when the season's oldest granule was **tried** before
 * it — tried (it was cut, refused or settled) yet with no attempt numbered 1, since an attempt's number
 * continues from the granule's old count. A granule merely queued before its first spawn, as every
 * granule is, counts nothing early. With no attempt yet: now, if the season already settled cuts.
 * `null`: every cut counted.
 */
async function countedFromOf(
  ctx: QueryCtx,
  season: string,
  counts: Doc<'imageryCounts'> | null,
  now: number,
): Promise<number | null> {
  const first = await ctx.db.query('imageryAttempts').order('asc').first();
  if (first === null) {
    const settled = (counts?.landed ?? 0) + (counts?.empty ?? 0) + (counts?.failed ?? 0);
    return settled > 0 ? now : null;
  }
  const oldest = await ctx.db
    .query('imageryGranules')
    .withIndex('by_season_queued', (q) => q.eq('season', season))
    .order('asc')
    .first();
  if (oldest === null || oldest.queuedAt >= first.spawnedAt) return null;
  const tried = oldest.attempts > 0 || (oldest.refusals ?? 0) > 0 || oldest.status !== 'queued';
  if (!tried) return null;
  const firstOfItsOwn = await ctx.db
    .query('imageryAttempts')
    .withIndex('by_granule_attempt', (q) => q.eq('granuleRowId', oldest._id).eq('attempt', 1))
    .first();
  return firstOfItsOwn === null ? first.spawnedAt : null;
}

/** The live index for the season: the index cron's newest run that counted this season's frames. */
async function indexFactsOf(ctx: QueryCtx, season: string) {
  const runs = await ctx.db
    .query('cronRuns')
    .withIndex('by_job_started', (q) => q.eq('job', IMAGERY_CRON_JOBS.index))
    .order('desc')
    .take(INDEX_RUNS_LOOKBACK);
  const built = runs.find((r) => r.season === season && typeof r.counts?.frames === 'number');
  return { built: built !== undefined, frames: built?.counts?.frames ?? 0 };
}

/** The index cron's runs the head looks back over for the season's frame count. */
const INDEX_RUNS_LOOKBACK = 10;

// ── The reads ──────────────────────────────────────────────────────────────────────────────────

/**
 * The page's head, crons and the watch's facts for the season now is in. Never `null`: with no watch
 * the state is `noWatch`. At most about twenty point reads, plus the sentinel lows' own bounded read
 * (`readSentinelLows`) in the two not-started states only.
 */
export const page = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<ImageryPageView> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const season = archiveSeasonAt(now);
    const row = await seasonRowFor(ctx, season);
    const state = imageryStateOf(row);
    const counts = await ctx.db
      .query('imageryCounts')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    const pump = await jobRow(ctx, 'pump');
    const index = await jobRow(ctx, 'index');
    const fly = flyConfigFromEnv();
    const r2 = r2ConfigFromEnv();
    return {
      season,
      state,
      startedBy:
        row?.imageryStartedBy === undefined ? null : await personOf(ctx, row.imageryStartedBy),
      startedAt: row?.imageryStartedAt ?? null,
      counts: {
        queued: counts?.queued ?? 0,
        spawned: counts?.spawned ?? 0,
        landed: counts?.landed ?? 0,
        empty: counts?.empty ?? 0,
        failed: counts?.failed ?? 0,
      },
      machines: {
        live: pump?.liveMachines ?? null,
        cap: MAX_LIVE_MACHINES,
        at: pump?.liveMachinesAt ?? null,
      },
      index: {
        ...(await indexFactsOf(ctx, season)),
        retryAt: index?.retryAt ?? null,
      },
      fly: {
        machineMs: counts?.machineMs ?? 0,
        countedFrom: await countedFromOf(ctx, season, counts, now),
      },
      image:
        pump?.image !== undefined && pump.imageSeenAt !== undefined
          ? { ref: pump.image, seenAt: pump.imageSeenAt }
          : null,
      crons: await cronJobViews(ctx, IMAGERY_JOBS, now),
      backoffUntil:
        pump?.backoffUntil !== undefined && pump.backoffUntil > now ? pump.backoffUntil : null,
      configured: fly.ok && r2.ok,
      watch: await watchFactsOf(
        ctx,
        season,
        row,
        state === 'notStarted' || state === 'noWatch',
        now,
      ),
    };
  },
});

/**
 * The season's granules, newest first, 25 a page: one `.paginate()` over `by_season_queued` (*All*)
 * or `by_season_status` (each filter). *All* leaves the failed ones out — they are `failedFirst`'s,
 * drawn above it — so an *All* page can come back short (even empty, with more to load); the
 * *Failed* filter lists every failed one.
 */
export const granules = query({
  args: { filter: literals(GRANULE_FILTERS), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<GranuleRowView>> => {
    await requireCapability(ctx, 'machinery.read');
    const season = archiveSeasonAt(Date.now());
    const opts = {
      ...args.paginationOpts,
      numItems: Math.max(1, Math.min(GRANULES_PAGE_SIZE, args.paginationOpts.numItems)),
    };
    const status: Doc<'imageryGranules'>['status'] | null =
      args.filter === 'all' ? null : args.filter === 'cutting' ? 'spawned' : args.filter;
    const result =
      status === null
        ? await ctx.db
            .query('imageryGranules')
            .withIndex('by_season_queued', (q) => q.eq('season', season))
            .order('desc')
            .paginate(opts)
        : await ctx.db
            .query('imageryGranules')
            .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', status))
            .order('desc')
            .paginate(opts);
    const page = result.page
      .filter((g) => status !== null || g.status !== 'failed')
      .map(granuleRowView);
    return { ...result, page };
  },
});

/** The season's failed granules, newest first, at most 50: drawn above the list. */
export const failedFirst = query({
  args: {},
  handler: async (ctx): Promise<GranuleRowView[]> => {
    await requireCapability(ctx, 'machinery.read');
    const season = archiveSeasonAt(Date.now());
    const rows = await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'failed'))
      .order('desc')
      .take(FAILED_FIRST_LIMIT);
    return rows.map(granuleRowView);
  },
});

/**
 * One granule, its newest attempts (at most 10, oldest first) and whether it predates them. The id
 * comes from the page's URL, so it is taken as a string and normalized: one that names no granule (a
 * mistyped link, another table's id) is `null`, the page's *missing*, never a validator throw that
 * retrying can't fix.
 */
export const granule = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<GranuleView | null> => {
    await requireCapability(ctx, 'machinery.read');
    const id = ctx.db.normalizeId('imageryGranules', args.id);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null) return null;
    const newest = await ctx.db
      .query('imageryAttempts')
      .withIndex('by_granule_attempt', (q) => q.eq('granuleRowId', row._id))
      .order('desc')
      .take(GRANULE_ATTEMPTS_LIMIT);
    const first = await ctx.db
      .query('imageryAttempts')
      .withIndex('by_granule_attempt', (q) => q.eq('granuleRowId', row._id))
      .order('asc')
      .first();
    const tried = row.attempts > 0 || (row.refusals ?? 0) > 0 || row.status !== 'queued';
    return {
      row: granuleRowView(row),
      attempts: newest.reverse().map(attemptView),
      // Tried before attempts were kept: none recorded though it was tried, or its first recorded
      // one numbered past 1 (numbers continue from the granule's old count).
      before8b: first === null ? tried : first.attempt > 1,
    };
  },
});

/** An attempt's log, newest first, 200 a page; the web reverses each page. */
export const attemptLog = query({
  args: { attemptId: v.id('imageryAttempts'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<AttemptLogLineView>> => {
    await requireCapability(ctx, 'machinery.read');
    const result = await ctx.db
      .query('runEvents')
      .withIndex('by_attempt_seq', (q) => q.eq('attemptId', args.attemptId))
      .order('desc')
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(ATTEMPT_LOG_PAGE_SIZE, args.paginationOpts.numItems)),
      });
    return {
      ...result,
      page: result.page.map((e) => ({
        seq: e.seq,
        loggedAt: e.loggedAt,
        kind: e.kind,
        text: e.text,
        dropped: e.dropped ?? null,
        origin: e.origin ?? null,
      })),
    };
  },
});

// ── The writes ─────────────────────────────────────────────────────────────────────────────────

async function watchRow(
  ctx: MutationCtx,
  season: string,
  refusal: (season: string) => string,
): Promise<Doc<'imageryIngestSeasons'>> {
  const row = await seasonRowFor(ctx, season);
  if (row === null) throw new ConvexError(refusal(season));
  return row;
}

/**
 * *Start imagery* (D214), and *Resume*: from now until the watch ends, the 6-hourly poll cuts each new
 * pass; the press runs a poll at once (through the dispatcher, with who pressed it) and clears any
 * backoff — pressing it is also how an admin says "I fixed it". Refused with no watch, once the watch
 * has ended, or while already running. Undone by {@link pauseImageryImpl}.
 */
export async function startImageryImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { season: string },
): Promise<ImageryReceipt> {
  const row = await watchRow(ctx, args.season, NO_WATCH);
  const state = imageryStateOf(row);
  if (state === 'ended') throw new ConvexError(WATCH_ENDED(args.season));
  if (state === 'running') throw new ConvexError(ALREADY_RUNNING);
  const now = Date.now();
  const actionId = await auditImagery(ctx, actor, {
    action: 'start_imagery',
    season: args.season,
    reason: state === 'paused' ? 'Resumed the satellite imagery' : 'Started the satellite imagery',
    metadata: {
      prev: {
        startedAt: row.imageryStartedAt ?? null,
        startedBy: row.imageryStartedBy ?? null,
        pausedAt: row.imageryPausedAt ?? null,
      },
    },
    now,
  });
  await ctx.db.patch(row._id, {
    imageryStartedAt: row.imageryStartedAt ?? now,
    imageryStartedBy: row.imageryStartedBy ?? actor._id,
    imageryPausedAt: undefined,
  });
  // Through the cron dispatcher (D347): the press is a recorded poll run, with who pressed it.
  await ctx.scheduler.runAfter(0, internal.cronRuns.tickAction, {
    job: IMAGERY_CRON_JOBS.poll,
    trigger: 'manual',
    byUserId: actor._id,
  });
  await clearBackoff(ctx, 'pump');
  return { actionId };
}

/**
 * *Pause*: no new cut starts (the cuts in flight still settle). Refused with no watch, once it has
 * ended, before it was started, or while already paused. Undone by {@link startImageryImpl}.
 */
export async function pauseImageryImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { season: string },
): Promise<ImageryReceipt> {
  const row = await watchRow(ctx, args.season, NO_WATCH_TO_PAUSE);
  const state = imageryStateOf(row);
  if (state === 'ended') throw new ConvexError(WATCH_ENDED(args.season));
  if (state === 'notStarted') throw new ConvexError(NOT_STARTED);
  if (state === 'paused') throw new ConvexError(ALREADY_PAUSED);
  const now = Date.now();
  const actionId = await auditImagery(ctx, actor, {
    action: 'pause_imagery',
    season: args.season,
    reason: 'Paused the satellite imagery',
    metadata: { prev: { pausedAt: null } },
    now,
  });
  await ctx.db.patch(row._id, { imageryPausedAt: now });
  return { actionId };
}

/**
 * *Run now* on the poll: a catalog check at once, through the dispatcher (`trigger: 'manual'`, who
 * pressed it). Refused unless imagery is running — a poll then would skip silently, so the waiting
 * states draw no *Run now* — or while a poll is already under way (its heartbeat's stamp, inside the
 * action limit).
 */
export async function pollNowImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
): Promise<ImageryReceipt> {
  const now = Date.now();
  const season = archiveSeasonAt(now);
  const row = await seasonRowFor(ctx, season);
  if (whyNotRunnable(row) !== null) throw new ConvexError(POLL_NOT_RUNNING);
  const hb = await ctx.db
    .query('cronHeartbeats')
    .withIndex('by_job', (q) => q.eq('job', IMAGERY_CRON_JOBS.poll))
    .first();
  if (hb?.runningSince !== undefined && now - hb.runningSince <= CRON_KILLED_AFTER_MS) {
    throw new ConvexError(POLL_RUNNING);
  }
  const actionId = await auditImagery(ctx, actor, {
    action: 'poll_imagery',
    season,
    reason: 'Checked the satellite catalogs now',
    metadata: {},
    now,
  });
  await ctx.scheduler.runAfter(0, internal.cronRuns.tickAction, {
    job: IMAGERY_CRON_JOBS.poll,
    trigger: 'manual',
    byUserId: actor._id,
  });
  return { actionId };
}

/** Start the season's imagery (moved from `seasonWatch.startImagery`); undone by `pauseImagery`. */
export const startImagery = mutation({
  args: { season: v.string() },
  handler: async (ctx, args): Promise<ImageryReceipt> => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return await startImageryImpl(ctx, actor, args);
  },
});

/** Pause the season's imagery (moved); undone by `startImagery` (*Resume*). */
export const pauseImagery = mutation({
  args: { season: v.string() },
  handler: async (ctx, args): Promise<ImageryReceipt> => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return await pauseImageryImpl(ctx, actor, args);
  },
});

/** Check the catalogs now: the poll's dispatcher, `trigger: 'manual'`. No inverse. */
export const pollNow = mutation({
  args: {},
  handler: async (ctx): Promise<ImageryReceipt> => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return await pollNowImpl(ctx, actor);
  },
});

/** Send the season's failed cuts back in line (moved); the receipt says how many. No inverse. */
export const retryFailed = mutation({
  args: {},
  handler: async (ctx): Promise<ImageryReceipt & { requeued: number }> => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return await retryFailedImpl(ctx, actor);
  },
});

/** Lift the pump's backoff and the index's wait (moved). No inverse. */
export const tryAgainNow = mutation({
  args: {},
  handler: async (ctx): Promise<ImageryReceipt> => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return await tryAgainNowImpl(ctx, actor);
  },
});
