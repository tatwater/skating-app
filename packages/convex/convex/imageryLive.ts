/**
 * Live imagery — the season's satellite passes, cut as they are published (A06i §5, **D214**).
 *
 * > **D214 — Once an admin presses *Start imagery*, the season's imagery runs itself from Convex:
 * > a 6-hourly catalog poll, one Fly Machine per new pass, and an index rebuilt by listing R2.**
 *
 * ## Three functions
 *
 * 1. **`poll`** (cron, every 6 hours, and on *Start*): asks Earth Search for new Sentinel-2 L2A and
 *    Sentinel-1 GRD items over the mask extent since the last window, selects them with A06e's
 *    rules (now in core), and queues each new slot once — oldest first, at most `POLL_CAP`.
 *    Overlapping polls are harmless: queueing is idempotent by granule and slot.
 * 2. **`pump`** (cron, every 3 minutes) — the only thing that touches Fly, under a lease
 *    (`lib/imageryPump`): it settles this season's cuts in flight, then, only while imagery is
 *    running, starts new ones up to the live-Machine cap. With nothing queued or cutting, a tick is
 *    one read.
 * 3. **`buildIndex`** (cron, every 10 minutes, when a frame has landed) — under its own lease: lists
 *    `frames/<season>/` in R2, reads only manifests it has not seen, drops rows whose manifest is
 *    gone, and writes `index/<season>.json` — and `index/latest.json` on turnover. Built from the
 *    bucket, never from what was launched (A06e). A failed build is retried on the next tick; a
 *    manifest it could not read, after a wait that doubles while it stays unreadable.
 *
 * ⚠ **Why one leased pump on a fixed tick** (three self-review rounds, 2026-10-06). Separate
 * self-rescheduling spawn and reconcile chains multiplied, each sized its spawn batch from its own
 * reading of live Machines — the overshoot `fan-out.sh` measured (58–71 alive against a cap of 50)
 * and the dropped frames that came with it — and kept spawning after *Pause*. Single pumps that
 * scheduled their own next beat then kept finding new ways to lose, stack or wedge it. A fixed cron
 * tick cannot be lost or doubled; the lease means one actor holds the cap; every failure is one
 * backoff and one email a day.
 *
 * ## How a cut settles
 *
 * A granule has *landed* when its manifest is in the bucket. A Machine gone without one is retried
 * once; on the second miss, an exit code of zero (or none at all) is *empty* — the cutter exits 0 on
 * "nothing to cut" — and a non-zero one is *failed*. A spawn the Fly API refuses spends no attempt and
 * goes to the back of the queue; three refusals of one granule fail it, and three in a row across
 * any granules trip a breaker that backs the pump off for half an hour, then lets one probe through.
 * A spawn that times out is not a refusal: the Machine may exist, so the claim is left in flight
 * and settled like any other once the archive or Fly can say what became of it.
 *
 * ## Why a poll, not a prediction
 *
 * Sentinel orbits are predictable to the minute, but the moment that matters is when the processed
 * granule appears in the catalog — hours to a day after the pass, and not on a schedule. A 5-day
 * overlap on each window catches items published late with an earlier capture date.
 *
 * A season cuts for about $1.50 of Fly compute (A06e).
 */

import {
  addDaysIso,
  archiveSeasonAt,
  attemptMachineMs,
  buildSeasonIndex,
  type CronReport,
  type CronReportLine,
  type CutExit,
  type CutterLogLine,
  cutLogKey,
  durationInWords,
  type FrameManifest,
  mergeCutLog,
  type PumpLogLine,
  parseCutterLog,
  parseGranuleId,
  parseSarGranuleId,
  STAC_COLLECTIONS,
  type StacCandidate,
  type StacMission,
  searchStac,
  selectGranules,
  selectSarGranules,
  stacDayRange,
  tileSurveyKey,
  withCronReport,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { typed, writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { firstToday } from './lib/dailyThrottle';
import {
  createCutMachine,
  destroyMachine,
  FLY_VM_SIZE_LABEL,
  type FlyConfig,
  type FlyMachine,
  type FlyMachineLogLine,
  flyConfigFromEnv,
  getMachine,
  isCutMachine,
  LIVE_STATES,
  listMachines,
  liveCutMachines,
  type MachineRun,
  machineLogs,
  machineName,
  STOPPED_STATES,
} from './lib/fly';
import {
  beginRun,
  clearBackoff,
  endRun,
  jobRow,
  markBuilt,
  markDirty,
  outstanding,
  retryNow,
  SPAWN_BREAKER,
} from './lib/imageryPump';
import {
  deleteObject,
  exists,
  getJson,
  getPublicJson,
  getText,
  listObjects,
  putJson,
  type R2Config,
  r2ConfigFromEnv,
} from './lib/r2';
import { composeImageryAlert } from './lib/seasonWatchEmails';
import { geoJson, literals } from './lib/validators';

/** The most granules one poll may queue — a spend guard, not a throttle. */
export const POLL_CAP = 300;

/** `fan-out.sh`'s `MAX_PARALLEL`: Machines alive at once. Past this, cuts silently fail to land. */
export const MAX_LIVE_MACHINES = 25;

/** Attempts per granule before a miss is settled as empty or failed. */
export const MAX_ATTEMPTS = 2;

/** Refusals of one granule before it is failed. (In a row across granules: `SPAWN_BREAKER`.) */
export const MAX_REFUSALS = 3;

/** Days each window reaches back past the last one, for items published after their capture. */
export const LATE_PUBLISH_OVERLAP_DAYS = 5;

/** Items per `queueGranules` call — two indexed reads each, well inside a mutation's budget. */
const QUEUE_BATCH = 100;

/** Spawned granules one pump checks, and how many checks run at once. */
const RECONCILE_BATCH = 100;
const CHECK_CONCURRENCY = 8;

/**
 * Runs in a row in which no cut in flight could be checked at all — three ticks, about nine minutes —
 * before the pump calls the archive or Fly down. One blind run is a blink; a backoff is thirty
 * minutes of the whole fleet idle, so it waits to be sure — and still comes, however few cuts are
 * in flight.
 */
const BLIND_RUNS_TO_BACK_OFF = 3;

/**
 * How long one run may spend starting cuts. A Fly create can hang to its 30 s timeout, and 25 of
 * those in a row would outlive Convex's 10-minute action limit — killing the run before `end`, with
 * no backoff, no record and the lease held. Claims past the budget go back untried.
 */
const SPAWN_BUDGET_MS = 4 * 60_000;

/**
 * The whole run's deadline, from its start — the checks and the spawns share it. ⚠ **Well inside the
 * 10-minute action limit**: a check is up to three 30 s reads and a spawn one 30 s create, so past
 * these marks one more group can still be in flight, and the writes after it must land before
 * Convex stops the action — or the landed frames are never marked dirty and the lease is held.
 * Checks stop starting at the first mark, spawns at the second; each group of checks is settled as
 * it finishes (Greptile, PR #85).
 */
const CHECK_DEADLINE_MS = 3 * 60_000;
const RUN_DEADLINE_MS = 6 * 60_000;

/** Timeouts in one run that stop it starting more: Fly answering nothing is not a refusal, but it
 * is not working either. */
const TIMEOUTS_TO_STOP = 2;

/** How soon after a spawn the pump bothers to look: a cut takes 20 s to a few minutes. */
const MIN_CUT_MS = 3 * 60_000;

/** A claim with no Machine id after this long is a spawn that died mid-call — requeue it. */
const LOST_CLAIM_MS = 10 * 60_000;

/** Manifests fetched at once while indexing. */
const MANIFEST_CONCURRENCY = 8;

/**
 * How long one build may spend reading manifests, from its start. ⚠ **Well inside the 10-minute
 * action limit**, with room for one more group's reads (30 s each, at most), the index write and
 * `latest`: a build killed mid-read saves nothing and the next repeats it, for ever (Greptile,
 * PR #85). Each group is saved as it lands, so a build out of time keeps what it read; the rest
 * wait, and the request stands for the next tick.
 */
const READ_BUDGET_MS = 4 * 60_000;

type Outcome = Doc<'imageryRuns'>['outcome'];
type Status = Doc<'imageryGranules'>['status'];
type Settled = 'queued' | 'landed' | 'empty' | 'failed';

// ─── State ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The one rule for whether new cuts may start — `liveState`, `hasWork` and Machinery's *Run now*
 * (`machineryImagery.pollNow`) all ask it.
 */
export function whyNotRunnable(row: Doc<'imageryIngestSeasons'> | null): string | null {
  if (!row) return 'no watch is open';
  if (row.closesOn !== undefined) return 'the watch has ended';
  if (row.imageryStartedAt === undefined) return 'imagery has not been started';
  if (row.imageryPausedAt !== undefined) return 'imagery is paused';
  return null;
}

export async function seasonRowFor(ctx: QueryCtx, season: string) {
  return await ctx.db
    .query('imageryIngestSeasons')
    .withIndex('by_season', (q) => q.eq('season', season))
    .unique();
}

/** The season the live job serves right now, and whether it may start new cuts. */
export const liveState = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    const row = await seasonRowFor(ctx, season);
    const reason = whyNotRunnable(row);
    if (reason !== null || !row) return { runnable: false as const, reason: reason ?? '' };
    return { runnable: true as const, opensOn: row.opensOn, windowTo: row.imageryWindowTo ?? null };
  },
});

/**
 * **The three imagery crons' registered names** (`cronJobs.ts`), by the `imageryRuns` kind each
 * replaced. Since B01-8b (D347) their runs are the cron backbone's: each job returns its run as a
 * `cronReport` and the dispatcher writes it to `cronRuns`; `imageryRuns` is no longer written, and
 * `cronRunJobs.copyImageryRuns` carries its history over. A press (*Start imagery*, *Retry failed*,
 * *Try again now*) schedules the dispatcher with `trigger: 'manual'` and the person, so it is a
 * recorded run with who pressed it.
 */
export const IMAGERY_CRON_JOBS = {
  poll: 'poll for new satellite imagery',
  pump: 'pump live satellite imagery',
  index: 'rebuild the live imagery index',
} as const;

/** Where every imagery alert sends its reader: Machinery › Imagery (B01-8b-2). */
export const IMAGERY_PAGE_PATH = '/admin/machinery/imagery';

/**
 * Email the admins, at most once per `key` per New York day. A misconfigured job polls four times a
 * day, and four identical emails is how an inbox learns to ignore the fifth.
 */
export const alertAdmins = internalMutation({
  args: { key: v.string(), season: v.string(), problem: v.string(), detail: v.string() },
  handler: async (ctx, { key, season, problem, detail }) => {
    if (!(await firstToday(ctx, key))) return { sent: false };
    const email = composeImageryAlert(season, problem, detail);
    await ctx.scheduler.runAfter(0, internal.operatorAlerts.broadcastToStaff, {
      subject: email.subject,
      heading: email.heading,
      blocks: email.blocks,
      deepLinkPath: IMAGERY_PAGE_PATH,
      roles: ['admin'],
    });
    return { sent: true };
  },
});

const jobKey = literals(['pump', 'index'] as const);

export const begin = internalMutation({
  args: { key: jobKey, token: v.string() },
  handler: async (ctx, { key, token }) => await beginRun(ctx, key, token),
});

export const end = internalMutation({
  args: {
    key: jobKey,
    token: v.string(),
    backoff: v.optional(v.boolean()),
    refusalStreak: v.optional(v.number()),
    blindTicks: v.optional(v.number()),
    stoppedMachines: v.optional(v.number()),
  },
  handler: async (ctx, { key, token, ...outcome }) => {
    await endRun(ctx, key, token, outcome);
    return null;
  },
});

export const markIndexDirty = internalMutation({
  args: {},
  handler: async (ctx) => {
    await markDirty(ctx, 'index');
    return null;
  },
});

export const markIndexBuilt = internalMutation({
  args: { seq: v.number(), unreadable: v.optional(v.number()), complete: v.optional(v.boolean()) },
  handler: async (ctx, { seq, unreadable, complete }) =>
    await markBuilt(ctx, 'index', seq, unreadable ?? 0, complete ?? true),
});

/** A season's known-unreadable manifests, least recently tried first. */
export const unreadablePage = internalQuery({
  args: { season: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { season, cursor }) =>
    await ctx.db
      .query('imageryUnreadable')
      .withIndex('by_season_tried', (q) => q.eq('season', season))
      .paginate({ cursor, numItems: 1000 }),
});

/**
 * Remember the manifests a build could not read — tried now, so behind every other known one next
 * time — and forget the ones that read, or are gone or current again.
 */
export const recordUnreadable = internalMutation({
  args: { season: v.string(), failed: v.array(v.string()), cleared: v.array(v.string()) },
  handler: async (ctx, { season, failed, cleared }) => {
    const now = Date.now();
    const rowOf = (manifestKey: string) =>
      ctx.db
        .query('imageryUnreadable')
        .withIndex('by_manifest', (q) => q.eq('manifestKey', manifestKey))
        .first();
    for (const manifestKey of failed) {
      const row = await rowOf(manifestKey);
      if (row) await ctx.db.patch(row._id, { triedAt: now });
      else await ctx.db.insert('imageryUnreadable', { season, manifestKey, triedAt: now });
    }
    for (const manifestKey of cleared) {
      const row = await rowOf(manifestKey);
      if (row) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * Whether a tick has anything to do: a cut in flight, a cut's log still owed (B01-8b-2), cut Machines
 * left stopped when it last listed (the sweep's), or one queued and allowed to start. Reads only, so a
 * quiet tick writes nothing.
 */
export const hasWork = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    const first = (status: 'queued' | 'spawned') =>
      ctx.db
        .query('imageryGranules')
        .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', status))
        .first();
    if (await first('spawned')) return true;
    const owed = await ctx.db
      .query('imageryAttempts')
      .withIndex('by_log_settled', (q) => q.eq('log', 'pending').gt('settledAt', 0))
      .first();
    if (owed) return true;
    if (((await jobRow(ctx, 'pump'))?.stoppedMachines ?? 0) > 0) return true;
    if (!(await first('queued'))) return false;
    return whyNotRunnable(await seasonRowFor(ctx, season)) === null;
  },
});

/** The rebuild the index tick should satisfy, or `null`. */
export const indexOutstanding = internalQuery({
  // ⚠ `now` is an argument, not `Date.now()` in the query: a query's result is cached on what it
  // reads, and a retry coming due is a change in the clock, not in any row.
  args: { now: v.number() },
  handler: async (ctx, { now }) => outstanding(await jobRow(ctx, 'index'), now),
});

/**
 * Hand untried claims back to the queue unchanged, in one transaction — and delete the attempt each
 * claim opened (`attemptIds`), since nothing was tried: an untried claim is no attempt.
 */
export const handBack = internalMutation({
  args: {
    ids: v.array(v.id('imageryGranules')),
    attemptIds: v.optional(v.array(v.id('imageryAttempts'))),
  },
  handler: async (ctx, { ids, attemptIds }) => {
    const ledger = new Ledger(ctx);
    const handed = new Set<string>();
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row?.status !== 'spawned' || row.machineId) continue;
      await ledger.set(row, 'queued', { attempts: Math.max(0, row.attempts - 1) });
      handed.add(id);
    }
    for (const attemptId of attemptIds ?? []) {
      const attempt = await ctx.db.get(attemptId);
      if (
        attempt?.verdict === 'cutting' &&
        !attempt.machineId &&
        handed.has(attempt.granuleRowId)
      ) {
        await ctx.db.delete(attemptId);
      }
    }
    await ledger.flush();
    return null;
  },
});

export const setWindowTo = internalMutation({
  args: { season: v.string(), windowTo: v.string() },
  handler: async (ctx, { season, windowTo }) => {
    const row = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    if (row) await ctx.db.patch(row._id, { imageryWindowTo: windowTo });
    return null;
  },
});

// ─── The ledger ─────────────────────────────────────────────────────────────────────────────────

type Counts = Record<Status, number>;

/**
 * Status changes and the page's totals, kept together: every status write in this module goes
 * through {@link Ledger.set}, which patches the row and counts the move, and {@link Ledger.flush}
 * writes each season's totals once per mutation. No clamp: a total that drifts negative is a bug to
 * see, not to hide.
 */
class Ledger {
  private readonly deltas = new Map<string, Counts>();
  /** Machine time settled per season (D346): added to `imageryCounts.machineMs`, never scanned. */
  private readonly machineMs = new Map<string, number>();

  constructor(private readonly ctx: MutationCtx) {}

  addMachineMs(season: string, ms: number) {
    if (!(ms > 0)) return;
    this.machineMs.set(season, (this.machineMs.get(season) ?? 0) + ms);
  }

  count(season: string, from: Status | null, to: Status | null) {
    const d = this.deltas.get(season) ?? { queued: 0, spawned: 0, landed: 0, empty: 0, failed: 0 };
    if (from) d[from] -= 1;
    if (to) d[to] += 1;
    this.deltas.set(season, d);
  }

  async set(
    row: Doc<'imageryGranules'>,
    to: Status,
    patch: Partial<Doc<'imageryGranules'>> = {},
  ): Promise<void> {
    await this.ctx.db.patch(row._id, { ...patch, status: to });
    if (row.status !== to) this.count(row.season, row.status, to);
  }

  async flush(): Promise<void> {
    const seasons = new Set([...this.deltas.keys(), ...this.machineMs.keys()]);
    for (const season of seasons) {
      const d = this.deltas.get(season) ?? {
        queued: 0,
        spawned: 0,
        landed: 0,
        empty: 0,
        failed: 0,
      };
      const row = await this.ctx.db
        .query('imageryCounts')
        .withIndex('by_season', (q) => q.eq('season', season))
        .unique();
      const ms = this.machineMs.get(season);
      const next = {
        queued: (row?.queued ?? 0) + d.queued,
        spawned: (row?.spawned ?? 0) + d.spawned,
        landed: (row?.landed ?? 0) + d.landed,
        empty: (row?.empty ?? 0) + d.empty,
        failed: (row?.failed ?? 0) + d.failed,
        ...(ms !== undefined ? { machineMs: (row?.machineMs ?? 0) + ms } : {}),
      };
      if (row) await this.ctx.db.patch(row._id, next);
      else await this.ctx.db.insert('imageryCounts', { season, ...next });
    }
    this.deltas.clear();
    this.machineMs.clear();
  }
}

const queueItem = v.object({
  granuleId: v.string(),
  slot: v.string(),
  mission: literals(['s2', 's1'] as const),
  season: v.string(),
  capturedAt: v.string(),
  /** When the catalog published the pass (the STAC item's `created`), when it said (B01-8b-2). */
  catalogedAt: v.optional(v.number()),
});

/**
 * Queue each granule whose id **and** slot are unseen, up to `cap` new ones, and report the newest
 * capture date it queued.
 *
 * ⚠ **The slot, not just the id.** ESA reprocesses: the same tile on the same day reappears as
 * `…_1_L2A` after `…_0_L2A` was cut. Two frames on one date is a correctness bug in a scrubber where
 * the date is the content (A06e §3.4), so a later version of a slot already queued is skipped.
 */
export const queueGranules = internalMutation({
  args: { items: v.array(queueItem), cap: v.number() },
  handler: async (ctx, { items, cap }) => {
    const ledger = new Ledger(ctx);
    let queued = 0;
    let known = 0;
    let newest: string | null = null;
    const now = Date.now();
    for (const item of items) {
      if (queued >= cap) break;
      const byId = await ctx.db
        .query('imageryGranules')
        .withIndex('by_granule', (q) => q.eq('granuleId', item.granuleId))
        .first();
      const seen =
        byId ??
        (await ctx.db
          .query('imageryGranules')
          .withIndex('by_slot', (q) => q.eq('slot', item.slot))
          .first());
      if (seen) {
        known++;
        continue;
      }
      await ctx.db.insert('imageryGranules', {
        ...item,
        status: 'queued',
        attempts: 0,
        queuedAt: now,
      });
      ledger.count(item.season, null, 'queued');
      queued++;
      newest = item.capturedAt;
    }
    await ledger.flush();
    return { queued, known, newest };
  },
});

/**
 * The number a granule's next attempt takes: one past its newest attempt row, or past its `attempts`
 * count when it was tried before attempts were recorded — never reused (see the schema's note).
 */
async function nextAttemptNumber(ctx: QueryCtx, row: Doc<'imageryGranules'>): Promise<number> {
  const newest = await ctx.db
    .query('imageryAttempts')
    .withIndex('by_granule_attempt', (q) => q.eq('granuleRowId', row._id))
    .order('desc')
    .first();
  return Math.max(newest?.attempt ?? 0, row.attempts) + 1;
}

/**
 * Claim up to `limit` of this season's queued granules, opening an attempt for each (`cutting`, D348).
 * Only the pump calls this, under its lease. Also stamps the pump's row with what it just learned:
 * the Machines it saw live (`live`, the page's *2/25 live*) and the image it spawns with (`image`,
 * with when it was first seen — the page's *cutter pinned 11 Oct*, Ma6).
 */
export const claimForSpawn = internalMutation({
  args: {
    season: v.string(),
    limit: v.number(),
    image: v.optional(v.string()),
    live: v.optional(v.number()),
  },
  handler: async (ctx, { season, limit, image, live }) => {
    const now = Date.now();
    const pump = live !== undefined || image !== undefined ? await jobRow(ctx, 'pump') : null;
    const ledger = new Ledger(ctx);
    const rows =
      limit <= 0
        ? []
        : await ctx.db
            .query('imageryGranules')
            .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'queued'))
            .take(limit);
    const claims: {
      id: Id<'imageryGranules'>;
      granuleId: string;
      season: string;
      attempt: number;
      attemptId: Id<'imageryAttempts'>;
    }[] = [];
    for (const row of rows) {
      const attempt = await nextAttemptNumber(ctx, row);
      await ledger.set(row, 'spawned', {
        attempts: row.attempts + 1,
        spawnedAt: now,
        machineId: undefined,
      });
      const attemptId = await ctx.db.insert('imageryAttempts', {
        granuleRowId: row._id,
        granuleId: row.granuleId,
        season: row.season,
        attempt,
        machineName: machineName(row.granuleId, attempt),
        ...(image !== undefined ? { image } : {}),
        spawnedAt: now,
        verdict: 'cutting',
        log: 'pending',
      });
      claims.push({
        id: row._id,
        granuleId: row.granuleId,
        season: row.season,
        attempt,
        attemptId,
      });
    }
    await ledger.flush();
    if (pump !== null) {
      await ctx.db.patch(pump._id, {
        ...(live !== undefined ? { liveMachines: live, liveMachinesAt: now } : {}),
        // The image is recorded the first time it spawns a cut, and its first sighting kept after.
        ...(image !== undefined && rows.length > 0 && pump.image !== image
          ? { image, imageSeenAt: now }
          : {}),
      });
    }
    return claims;
  },
});

/**
 * Record a spawn's result. A refusal is about Fly, not the granule, so it spends no attempt; the
 * granule goes to the **back** of the queue (so one Fly refuses every time cannot be claimed first
 * forever), and on its `MAX_REFUSALS`th refusal it is failed. `untried` hands a claim back unchanged.
 */
export const settleSpawn = internalMutation({
  args: {
    id: v.id('imageryGranules'),
    /** The claim's attempt (absent from a caller before B01-8b-2): stamped, closed or deleted with it. */
    attemptId: v.optional(v.id('imageryAttempts')),
    machineId: v.optional(v.string()),
    error: v.optional(v.string()),
    untried: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, attemptId, machineId, error, untried }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== 'spawned') return { failed: false };
    const attempt = attemptId === undefined ? null : await ctx.db.get(attemptId);
    const open = attempt?.granuleRowId === id && attempt.verdict === 'cutting' ? attempt : null;
    if (machineId) {
      await ctx.db.patch(id, { machineId });
      if (open) await ctx.db.patch(open._id, { machineId });
      return { failed: false };
    }
    const ledger = new Ledger(ctx);
    const attempts = Math.max(0, row.attempts - 1);
    if (untried) {
      await ledger.set(row, 'queued', { attempts });
      await ledger.flush();
      if (open && !open.machineId) await ctx.db.delete(open._id);
      return { failed: false };
    }
    const now = Date.now();
    const refusals = (row.refusals ?? 0) + 1;
    const failed = refusals >= MAX_REFUSALS;
    await ledger.set(row, failed ? 'failed' : 'queued', {
      attempts,
      refusals,
      lastError: error ?? 'spawn refused',
      ...(failed ? { settledAt: now } : { queuedAt: now }),
    });
    await ledger.flush();
    // A refusal is an attempt that never ran: no Machine, no log, no machine time.
    if (open) {
      await ctx.db.patch(open._id, {
        verdict: 'refused',
        error: trimError(error ?? 'spawn refused'),
        settledAt: now,
        log: 'none',
      });
    }
    return { failed };
  },
});

/** An attempt's error, trimmed as a run's is. */
function trimError(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text;
}

/** What a settle records on the attempt it closes (D348): Fly's word on its exit, and its time. */
const attemptClose = v.object({
  id: v.id('imageryAttempts'),
  verdict: literals(['landed', 'empty', 'requeued', 'failed', 'unconfirmed'] as const),
  exitCode: v.optional(v.number()),
  oomKilled: v.optional(v.boolean()),
  exitedAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  machineMs: v.optional(v.number()),
  machineMsFrom: v.optional(literals(['fly', 'cutter', 'settle'] as const)),
  /**
   * `pending` while its lines are still to be copied; `none` when there is nothing to copy (a spawn
   * never confirmed ran no Machine).
   */
  log: literals(['pending', 'none'] as const),
});

/**
 * Apply one pump's verdicts on the cuts it checked, in one transaction — and close each one's
 * attempt with what Fly said about its exit and its machine time, adding that time to the season's
 * total (D346). **The exit is on the attempt once this commits**: only then may its Machine be
 * destroyed. Returns the attempts it closed (a row another run settled first is skipped, with its
 * attempt).
 */
export const settleMany = internalMutation({
  args: {
    settled: v.array(
      v.object({
        id: v.id('imageryGranules'),
        status: literals(['queued', 'landed', 'empty', 'failed'] as const),
        error: v.optional(v.string()),
        /** The cutter's empty marker's reason (Ma7), copied onto an empty granule. */
        emptyReason: v.optional(v.string()),
        attempt: v.optional(attemptClose),
      }),
    ),
  },
  handler: async (ctx, { settled }) => {
    const ledger = new Ledger(ctx);
    const now = Date.now();
    const closed: Id<'imageryAttempts'>[] = [];
    for (const s of settled) {
      const row = await ctx.db.get(s.id);
      if (row?.status !== 'spawned') continue;
      await ledger.set(row, s.status, {
        ...(s.status === 'queued' ? { machineId: undefined } : { settledAt: now }),
        ...(s.error ? { lastError: s.error } : {}),
        ...(s.status === 'empty' && s.emptyReason ? { emptyReason: trimError(s.emptyReason) } : {}),
      });
      const a = s.attempt;
      if (a === undefined) continue;
      const attempt = await ctx.db.get(a.id);
      if (attempt?.granuleRowId !== s.id || attempt.verdict !== 'cutting') continue;
      const { id: _id, ...fields } = a;
      await ctx.db.patch(a.id, {
        ...fields,
        ...(s.error ? { error: trimError(s.error) } : {}),
        settledAt: now,
      });
      if (a.machineMs !== undefined) ledger.addMachineMs(row.season, a.machineMs);
      closed.push(a.id);
    }
    await ledger.flush();
    return { closed };
  },
});

/** The attempts' rows the pump needs to settle or capture, by id. */
export const attemptsById = internalQuery({
  args: { ids: v.array(v.id('imageryAttempts')) },
  handler: async (ctx, { ids }) => {
    const out: Doc<'imageryAttempts'>[] = [];
    for (const id of ids) {
      const a = await ctx.db.get(id);
      if (a) out.push(a);
    }
    return out;
  },
});

/**
 * The cuts in flight, each with its open attempt: the granule's newest attempt row, when it is still
 * `cutting` (a granule spawned before B01-8b-2 has none, and settles without one).
 */
export const inFlight = internalQuery({
  args: { season: v.string(), limit: v.number() },
  handler: async (ctx, { season, limit }) => {
    const rows = await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'spawned'))
      .take(limit);
    const out: { granule: Doc<'imageryGranules'>; attempt: Doc<'imageryAttempts'> | null }[] = [];
    for (const granule of rows) {
      const newest = await ctx.db
        .query('imageryAttempts')
        .withIndex('by_granule_attempt', (q) => q.eq('granuleRowId', granule._id))
        .order('desc')
        .first();
      out.push({ granule, attempt: newest?.verdict === 'cutting' ? newest : null });
    }
    return out;
  },
});

/** Captures still owed, oldest settle first (`by_log_settled`, floored at `settledAt > 0`). */
export const pendingCaptures = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) =>
    await ctx.db
      .query('imageryAttempts')
      .withIndex('by_log_settled', (q) => q.eq('log', 'pending').gt('settledAt', 0))
      .take(limit),
});

/**
 * For the sweep: each stopped Machine's attempt by its Machine id (`by_machine`, `eq` on a defined
 * id), as `settled` (its exit is on it, or it never needed one) or `open`; absent: no attempt claims
 * that Machine.
 */
export const attemptsByMachine = internalQuery({
  args: { machineIds: v.array(v.string()) },
  handler: async (ctx, { machineIds }) => {
    const out: {
      machineId: string;
      attemptId: Id<'imageryAttempts'>;
      settled: boolean;
      exitRecorded: boolean;
    }[] = [];
    for (const machineId of machineIds) {
      const a = await ctx.db
        .query('imageryAttempts')
        .withIndex('by_machine', (q) => q.eq('machineId', machineId))
        .order('desc')
        .first();
      if (!a) continue;
      out.push({
        machineId,
        attemptId: a._id,
        settled: a.settledAt !== undefined,
        exitRecorded:
          a.exitedAt !== undefined || a.exitCode !== undefined || a.oomKilled !== undefined,
      });
    }
    return out;
  },
});

/**
 * Record what Fly says about a settled attempt's exit, read late by the sweep (a settle that couldn't
 * reach Fly): only fields not yet on it, so an earlier, better reading is never overwritten.
 */
export const recordAttemptExit = internalMutation({
  args: {
    id: v.id('imageryAttempts'),
    exitCode: v.optional(v.number()),
    oomKilled: v.optional(v.boolean()),
    exitedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const a = await ctx.db.get(id);
    if (!a) return null;
    const patch: Partial<Doc<'imageryAttempts'>> = {};
    for (const k of ['exitCode', 'oomKilled', 'exitedAt', 'startedAt'] as const) {
      if (fields[k] !== undefined && a[k] === undefined) Object.assign(patch, { [k]: fields[k] });
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(id, patch);
    return null;
  },
});

/** Lines one `appendAttemptLines` writes: well inside a mutation's limits at 500 characters each. */
export const ATTEMPT_LINES_APPEND = 500;

const attemptLine = v.object({
  origin: literals(['cutter', 'fly', 'pump'] as const),
  kind: literals(['line', 'warn', 'fail', 'stage'] as const),
  loggedAt: v.number(),
  text: v.string(),
});

/**
 * Write one chunk of an attempt's merged log at `from` (0-based `seq`). **Idempotent**: a line already
 * at one of those seqs (a capture retried after a partial write) is replaced, never doubled.
 */
export const appendAttemptLines = internalMutation({
  args: {
    attemptId: v.id('imageryAttempts'),
    from: v.number(),
    lines: v.array(attemptLine),
    keepUntil: v.number(),
  },
  handler: async (ctx, { attemptId, from, lines, keepUntil }) => {
    if (lines.length > ATTEMPT_LINES_APPEND) {
      throw new Error(`appendAttemptLines: ${lines.length} lines is over ${ATTEMPT_LINES_APPEND}`);
    }
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.log !== 'pending') return null;
    const existing = await ctx.db
      .query('runEvents')
      .withIndex('by_attempt_seq', (q) =>
        q
          .eq('attemptId', attemptId)
          .gte('seq', from)
          .lt('seq', from + lines.length),
      )
      .take(lines.length);
    for (const row of existing) await ctx.db.delete(row._id);
    const at = Date.now();
    for (const [i, line] of lines.entries()) {
      await ctx.db.insert('runEvents', {
        attemptId,
        seq: from + i,
        at,
        loggedAt: line.loggedAt,
        kind: line.kind,
        text: line.text.slice(0, 500),
        origin: line.origin,
        keepUntil,
      });
    }
    return null;
  },
});

/**
 * Close an attempt's log: `kept` (the cutter's upload copied with the rest) or `none` (no upload
 * existed; Fly's and the pump's lines are still kept), dropping any line at or past `total` that an
 * earlier, longer try wrote; or `missing`, the copy given up on. Only from `pending`.
 */
export const closeAttemptLog = internalMutation({
  args: {
    attemptId: v.id('imageryAttempts'),
    log: literals(['kept', 'none', 'missing'] as const),
    total: v.number(),
  },
  handler: async (ctx, { attemptId, log, total }) => {
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.log !== 'pending') return { closed: false };
    const stale = await ctx.db
      .query('runEvents')
      .withIndex('by_attempt_seq', (q) => q.eq('attemptId', attemptId).gte('seq', total))
      .take(ATTEMPT_LINES_APPEND * 4);
    for (const row of stale) await ctx.db.delete(row._id);
    await ctx.db.patch(attemptId, { log });
    return { closed: true };
  },
});

export const granulesByStatus = internalQuery({
  args: { season: v.string(), status: literals(['queued', 'spawned'] as const), limit: v.number() },
  handler: async (ctx, { season, status, limit }) =>
    await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', status))
      .take(limit),
});

// ─── Config ─────────────────────────────────────────────────────────────────────────────────────

interface SearchPlan {
  season: string;
  surveyKey: string;
  bbox: [number, number, number, number];
  emptyTiles: string[];
}

type Configured = { ok: true; fly: FlyConfig; r2: R2Config } | { ok: false; detail: string };

function configured(): Configured {
  const fly = flyConfigFromEnv();
  const r2 = r2ConfigFromEnv();
  const missing = [...(fly.ok ? [] : fly.missing), ...(r2.ok ? [] : r2.missing)];
  if (!fly.ok || !r2.ok) {
    return {
      ok: false,
      detail: `The live imagery job is missing Convex environment variables: ${missing.join(', ')}. Set them on the deployment and it will run on the next check.`,
    };
  }
  return { ok: true, fly: fly.config, r2: r2.config };
}

/** `S2C_19TEM_20251101_0_L2A` → `S2C_19TEM_20251101`; `S1A_…_<start>_…` → `S1A_<start>`. */
export function slotOf(granuleId: string): { slot: string; mission: StacMission } | null {
  const s2 = parseGranuleId(granuleId);
  if (s2) return { slot: `${s2.platform}_${s2.tile}_${s2.date}`, mission: 's2' };
  const s1 = parseSarGranuleId(granuleId);
  if (s1) return { slot: `${s1.platform}_${s1.startedAt}`, mission: 's1' };
  return null;
}

// ─── 1. Poll ────────────────────────────────────────────────────────────────────────────────────

const pollArgs = {};

/**
 * The poll's cron body. (Exported as `pollHandler`, so the cron dispatcher runs it in-process:
 * `cronRuns.tickAction`, D347.)
 */
export async function pollHandler(ctx: ActionCtx): Promise<PollResult> {
  const startedAt = Date.now();
  // The pump's own 3-minute tick picks up whatever this queues.
  return await pollOnce(ctx, archiveSeasonAt(startedAt), startedAt);
}

export const poll = internalAction({ args: pollArgs, handler: pollHandler });

/** What a poll answers: its outcome, and (when it ran) its report for the cron dispatcher. */
type PollResult = { outcome: Outcome; detail?: string; cronReport?: CronReport };

async function pollOnce(ctx: ActionCtx, season: string, startedAt: number): Promise<PollResult> {
  const state = await ctx.runQuery(internal.imageryLive.liveState, { season });
  // Not started (or paused, or over) is the normal state most of the year — no run row, no noise.
  if (!state.runnable) return { outcome: 'skipped', detail: state.reason };

  // The run's log (D347): what it did, in order — the window, each mission's search, the queue.
  const lines: CronReportLine[] = [];
  const log = (text: string, kind: CronReportLine['kind'] = 'line') =>
    lines.push({ kind, text, loggedAt: Date.now() });
  const finish = async (
    outcome: Exclude<Outcome, 'skipped'>,
    detail?: string,
    counts?: Record<string, number>,
  ): Promise<PollResult> => {
    if (outcome === 'failed' || outcome === 'refused') log(detail ?? outcome, 'fail');
    const cronReport: CronReport = {
      worked: true,
      outcome,
      season,
      ...(detail ? { detail } : {}),
      ...(counts ? { counts } : {}),
      lines,
    };
    return { outcome, ...(detail ? { detail } : {}), cronReport };
  };
  const refuse = async (key: string, problem: string, detail: string) => {
    await ctx.runMutation(internal.imageryLive.alertAdmins, { key, season, problem, detail });
    return await finish('refused', detail);
  };

  const config = configured();
  if (!config.ok) {
    return await refuse('imagery-config', 'Satellite imagery is not configured', config.detail);
  }

  try {
    // The masks a cut clips against are this season's bake; the sidecar's `waterMasks` is the
    // interlock `bake-masks` publishes last, and the search plan must be for that same bake.
    const sidecar = await getPublicJson<{ season?: string; bodies?: number; waterMasks?: boolean }>(
      config.r2,
      `masks/${season}.json`,
    );
    if (!sidecar?.waterMasks || typeof sidecar.bodies !== 'number') {
      return await refuse(
        'imagery-masks',
        `No ${season} masks are staged`,
        `masks/${season}.json is missing or predates the water-mask split. Run \`pnpm --filter @skating/imagery bake-masks --upload\`, then \`publish-search-plan\`.`,
      );
    }
    const plan = await getPublicJson<SearchPlan>(config.r2, `masks/${season}-search.json`);
    if (!plan || plan.surveyKey !== tileSurveyKey(season, sidecar.bodies)) {
      return await refuse(
        'imagery-search-plan',
        'The search plan does not match the masks',
        `masks/${season}-search.json is missing or was surveyed against a different bake. Run \`pnpm --filter @skating/imagery publish-search-plan\`.`,
      );
    }

    const today = new Date(startedAt).toISOString().slice(0, 10);
    const overlap = state.windowTo
      ? addDaysIso(state.windowTo, -LATE_PUBLISH_OVERLAP_DAYS)
      : state.opensOn;
    // Never before the watch opened: frames from before it are last season's business.
    // biome-ignore lint/complexity/useMathMinMax: ISO days compare lexically; Math.max returns NaN.
    const from = overlap > state.opensOn ? overlap : state.opensOn;
    const datetime = stacDayRange(from, today);
    log(`Window ${from} → ${today}`, 'stage');
    const search = async (mission: StacMission) =>
      (
        await searchStac(fetch, {
          collection: STAC_COLLECTIONS[mission],
          bbox: plan.bbox,
          datetime,
        })
      ).items;
    const [s2, s1] = await Promise.all([search('s2'), search('s1')]);
    log(`Sentinel-2: ${s2.length} passes found`);
    log(`Sentinel-1: ${s1.length} passes found`);

    // A06e's selection, unchanged: no cloud gate (we cut and keep everything), the empty-tile
    // prefilter for optical, the DV/IW/GRDH filter for radar.
    const s2Selected = selectGranules(s2, { emptyTiles: new Set(plan.emptyTiles) });
    const s1Selected = selectSarGranules(s1);
    const byId = new Map<string, StacCandidate>([...s2, ...s1].map((c) => [c.id, c]));
    const items = [...s2Selected.selected, ...s1Selected.selected]
      .flatMap((granuleId) => {
        const key = slotOf(granuleId);
        const candidate = byId.get(granuleId);
        if (!key || !candidate) return [];
        const catalogedAt =
          candidate.created === undefined ? Number.NaN : Date.parse(candidate.created);
        return [
          {
            granuleId,
            slot: key.slot,
            mission: key.mission,
            // The frame season comes from the capture date — where `cut-granule` files it.
            season: archiveSeasonAt(Date.parse(candidate.datetime)),
            capturedAt: candidate.datetime,
            ...(Number.isFinite(catalogedAt) ? { catalogedAt } : {}),
          },
        ];
      })
      // Oldest first, so a capped catch-up resumes exactly where it stopped.
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

    let queued = 0;
    let known = 0;
    let newest: string | null = null;
    let examined = 0;
    for (let i = 0; i < items.length && queued < POLL_CAP; i += QUEUE_BATCH) {
      const batch = items.slice(i, i + QUEUE_BATCH);
      const result = await ctx.runMutation(internal.imageryLive.queueGranules, {
        items: batch,
        cap: POLL_CAP - queued,
      });
      queued += result.queued;
      known += result.known;
      newest = result.newest ?? newest;
      examined = i + Math.min(batch.length, result.queued + result.known);
    }
    const capped = examined < items.length;
    log(`Selected ${items.length}; queued ${queued}, already queued ${known}`);
    if (capped)
      log(`Hit the cap of ${POLL_CAP}; ${items.length - examined} left for the next poll`, 'warn');

    // ⚠ **A capped poll advances its window only to the newest pass it queued**, never to today. The
    // next poll starts from there (less the overlap) and picks up the rest; advancing to today would
    // put everything past the cap more than five days behind the next window, gone for good — and
    // "running it late loses nothing" is a promise the imagery email makes. Some of what was not
    // examined may already be queued; the next poll skips those for two index reads each.
    const windowTo = capped && newest ? newest.slice(0, 10) : today;
    await ctx.runMutation(internal.imageryLive.setWindowTo, { season, windowTo });
    // Start on what was just queued now rather than at the next 3-minute tick; the lease makes it
    // safe whether or not a tick is already running.
    //
    // ⚠ **`manual`, never `cron`** (Ma27 (b)): a `cron` tick's `begin` calls a `cron` stamp it finds
    // killed at any age, on the rule that Convex never runs a cron over itself — and this run is not
    // Convex's cron, so it may overlap the pump's own tick. Marked manual (with no presser), the
    // stamps keep the age rule between them.
    if (queued > 0) {
      await ctx.scheduler.runAfter(0, internal.cronRuns.tickAction, {
        job: IMAGERY_CRON_JOBS.pump,
        trigger: 'manual',
      });
    }

    const counts = {
      s2Considered: s2Selected.counts.considered,
      s1Considered: s1Selected.counts.considered,
      selected: items.length,
      queued,
      alreadyQueued: known,
      notYetExamined: items.length - examined,
    };
    if (capped) {
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-cap',
        season,
        problem: `A satellite check hit its cap of ${POLL_CAP}`,
        detail: `It queued ${queued} passes and left ${items.length - examined} more in the window unexamined. Nothing is lost: each 6-hourly check picks up where the last one stopped, oldest first.`,
      });
      return await finish('capped', `window ${from} → ${windowTo}`, counts);
    }
    return await finish('ok', `window ${from} → ${today}`, counts);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-poll-failed',
      season,
      problem: 'A satellite catalog check failed',
      detail,
    });
    return await finish('failed', detail);
  }
}

// ─── 2. Pump ────────────────────────────────────────────────────────────────────────────────────

interface PumpCounts {
  landed: number;
  running: number;
  young: number;
  requeued: number;
  empty: number;
  failed: number;
  unknown: number;
  live: number;
  spawned: number;
  refused: number;
  unconfirmed: number;
  /** Attempts whose log was copied into Convex this run (D348), the first try or a retry. */
  captured: number;
  /** Captures still owed at the run's end (each retried for an hour, then marked missing). */
  capturesOwed: number;
  /** Stopped cut Machines destroyed this run, by the settle or the sweep. */
  destroyed: number;
  /** Stopped cut Machines still waiting after the run's sweep. */
  stopped: number;
}

/** An aborted fetch — `AbortSignal.timeout` throws a `TimeoutError`, an abort an `AbortError`. */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * **How long a capture is retried** (D348): a log the pump couldn't copy (R2 or Convex blinked) is
 * tried again on each run for an hour from its settle, then marked `missing`.
 */
export const CAPTURE_RETRY_MS = 60 * 60_000;
/** Owed captures one run retries, oldest first. */
const CAPTURES_PER_RUN = 10;
/** Stopped cut Machines one run's sweep looks at. */
const SWEEP_PER_RUN = 25;
/**
 * A stopped cut Machine no attempt claims — a spawn whose answer never came, or a Machine from before
 * B01-8b-2 — is destroyed once Fly says it has been stopped this long: nothing can ever settle it.
 */
export const ORPHAN_STOPPED_MS = 60 * 60_000;
/**
 * **The bound on stopped Machines** (D348's keep rule): past this many stopped cut Machines at once —
 * destroys failing while spawns still succeed — the pump starts no new cut and tells the admins, so a
 * failing capture can never pile up Machines without end. Twice the live cap.
 */
export const MAX_STOPPED_MACHINES = 2 * MAX_LIVE_MACHINES;
/**
 * A cut whose frame landed but whose Machine is still live: the pump waits for its exit (so the
 * attempt gets Fly's exit event and the whole log), but no longer than this from its spawn — a cutter
 * hung after its upload must not keep a landed frame out of the index.
 */
const LANDED_WAIT_MS = 15 * 60_000;
/** How long an attempt's lines are kept (D348): a failed one's the season, the rest a month. */
export const FAILED_LOG_DAYS = 200;
export const KEPT_LOG_DAYS = 30;
const DAY_MS = 86_400_000;

type Verdict =
  | {
      kind: 'settle';
      id: Id<'imageryGranules'>;
      status: Settled;
      error?: string;
      granuleId: string;
      /** The empty marker's reason (Ma7). */
      emptyReason?: string;
      /** The settle's reading for the attempt it closes; `null` for a granule with no open attempt. */
      capture: Capture | null;
    }
  | { kind: 'running' | 'young' | 'unknown' };

/** What a settle read for the attempt it closes (D348). */
interface Capture {
  attempt: Doc<'imageryAttempts'>;
  /** Fly's word on the run (its exit event and start), or `null` when Fly wasn't read or knew nothing. */
  run: MachineRun | null;
  /** Fly said the Machine is done and still exists (stopped or failed): the settle destroys it. */
  destroyable: boolean;
  /** The cutter's upload: its text, `null` when there was none, `undefined` when it couldn't be read. */
  cutterText: string | null | undefined;
}

/**
 * Where the cutter records a granule it looked at and found nothing to cut under (`cut-granule.sh`,
 * `mark_nothing_to_cut`) — outside `frames/`, so the index's listing never mistakes it for a frame.
 */
export function emptyMarkerKey(season: string, granuleId: string): string {
  return `cuts/${season}/${granuleId}.empty.json`;
}

/** The granule's error for an exit: `exit 137 · out of memory`, `exit 1`. */
function exitError(run: MachineRun | null): string | undefined {
  if (!run || run.exitCode === null || run.exitCode === 0) {
    return run?.oomKilled === true ? 'out of memory' : undefined;
  }
  return run.oomKilled === true ? `exit ${run.exitCode} · out of memory` : `exit ${run.exitCode}`;
}

/**
 * What the bucket and Fly say about one cut in flight, and — for one that settles — what its attempt
 * needs: Fly's exit event and the cutter's upload. Never throws: a failed verdict read is `unknown`;
 * a failed capture read leaves the capture owed, never the verdict.
 *
 * ⚠ **Empty needs proof.** A cut gone without a frame is *empty* only on the cutter's nothing-to-cut
 * record or a seen zero exit; anything else, on its last attempt, is *failed* — an email and *Retry
 * failed*, rather than a real failure filed as an empty pass. Since B01-8b-2 a finished Machine is kept
 * stopped (`auto_destroy: false`), so its exit code is read here rather than lost; a Machine from an
 * older spawn, auto-destroyed, still reads as before.
 *
 * ⚠ **A landed cut waits for its Machine to exit** (up to `LANDED_WAIT_MS`), so the attempt keeps its
 * exit and its whole log. If Fly can't be read, the frame lands anyway: a frame is never held back by
 * Fly, and the sweep reads the exit before it destroys the Machine.
 */
async function check(
  config: { fly: FlyConfig; r2: R2Config },
  granule: Doc<'imageryGranules'>,
  attempt: Doc<'imageryAttempts'> | null,
  now: number,
): Promise<Verdict> {
  const age = now - (granule.spawnedAt ?? 0);
  if (granule.machineId && age < MIN_CUT_MS) return { kind: 'young' };
  let run = null as MachineRun | null;
  let destroyable = false;
  /** Fly's word on the Machine: `live`, or done (its run read when Fly still knows it). */
  const readFly = async (): Promise<'live' | 'done'> => {
    const machine = await getMachine(config.fly, granule.machineId as string);
    if (machine && LIVE_STATES.has(machine.state)) return 'live';
    if (machine) {
      run = {
        exitCode: machine.exitCode,
        oomKilled: machine.oomKilled,
        exitedAt: machine.exitedAt,
        startedAt: machine.startedAt,
      };
      destroyable = machine.state !== 'destroyed' && machine.state !== 'destroying';
    }
    return 'done';
  };
  const settle = async (
    status: Settled,
    error?: string,
    emptyReason?: string,
  ): Promise<Verdict> => {
    let cutterText: string | null | undefined;
    if (attempt?.machineId) {
      try {
        cutterText = await getText(
          config.r2,
          cutLogKey(attempt.season, attempt.granuleId, attempt.attempt),
        );
      } catch {
        cutterText = undefined; // owed: the next run reads it again
      }
    } else cutterText = null;
    return {
      kind: 'settle',
      id: granule._id,
      status,
      granuleId: granule.granuleId,
      ...(error ? { error } : {}),
      ...(emptyReason ? { emptyReason } : {}),
      capture: attempt ? { attempt, run, destroyable, cutterText } : null,
    };
  };
  try {
    // Asked of the bucket itself, signed: a CDN may have cached the 404 from before the upload,
    // and a landed cut read as missing would be recut — and its frame never indexed.
    if (await exists(config.r2, `frames/${granule.season}/${granule.granuleId}.json`)) {
      if (granule.machineId) {
        try {
          if ((await readFly()) === 'live' && age < LANDED_WAIT_MS) return { kind: 'running' };
        } catch {
          // Fly blinked: the frame lands without its exit; the sweep reads it before destroying.
        }
      }
      return await settle('landed');
    }
    if (granule.machineId) {
      if ((await readFly()) === 'live') return { kind: 'running' };
    } else if (age < LOST_CLAIM_MS) {
      return { kind: 'young' }; // a claim whose spawn call may still be returning
    }
    const exitCode = run?.exitCode ?? null;
    // Gone: did it record nothing to cut? Asked of the bucket, signed — a CDN may have cached the
    // 404 from while the cut was still running. Its `reason` is copied onto the granule (Ma7); a
    // marker that isn't JSON is still the cutter's record, with no reason.
    const marker = await getText(config.r2, emptyMarkerKey(granule.season, granule.granuleId));
    if (marker !== null) {
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(marker) as { reason?: unknown };
        if (typeof parsed?.reason === 'string' && parsed.reason.trim())
          reason = parsed.reason.trim();
      } catch {
        reason = undefined;
      }
      return await settle('empty', undefined, reason);
    }
    const fault = exitError(run);
    // Gone without a frame or a nothing-to-cut record. The first miss is always retried: a spawn
    // that never started, a crash and an image too old to write the record all look the same here.
    if (granule.attempts < MAX_ATTEMPTS) {
      return await settle(
        'queued',
        fault ?? (granule.machineId ? undefined : 'spawn never confirmed'),
      );
    }
    if (exitCode !== null && exitCode !== 0) return await settle('failed', fault);
    // ⚠ **Never confirmed is not empty.** A claim with no Machine id timed out or died mid-call: no
    // Machine was ever seen, so nothing says the granule had nothing to cut.
    if (!granule.machineId) return await settle('failed', 'spawn never confirmed');
    // An out-of-memory kill is a failure whatever its code.
    if (fault !== undefined) return await settle('failed', fault);
    // A seen zero exit with no record is a cutter image from before the record existed: it exits 0
    // on "nothing to cut" — a footprint that misses every body.
    if (exitCode === 0) return await settle('empty');
    return await settle('failed', 'gone with no frame and no nothing-to-cut record');
  } catch {
    return { kind: 'unknown' }; // the archive or the Fly API blinked; look again next beat
  }
}

/** The attempt verdict a granule's settle means. */
function attemptVerdictOf(
  status: Settled,
  attempt: Doc<'imageryAttempts'>,
): 'landed' | 'empty' | 'requeued' | 'failed' | 'unconfirmed' {
  if (status === 'landed') return 'landed';
  if (status === 'empty') return 'empty';
  if (!attempt.machineId) return 'unconfirmed';
  return status === 'queued' ? 'requeued' : 'failed';
}

/** The settle's close of an attempt: its verdict, Fly's exit, its machine time (D346). */
function attemptCloseOf(verdict: Extract<Verdict, { kind: 'settle' }>, now: number) {
  const capture = verdict.capture;
  if (capture === null) return undefined;
  const { attempt, run } = capture;
  const ran = attempt.machineId !== undefined;
  const ms = attemptMachineMs({
    startedAt: run?.startedAt ?? null,
    exitedAt: run?.exitedAt ?? null,
    cutter: typeof capture.cutterText === 'string' ? parseCutterLog(capture.cutterText) : [],
    spawnedAt: attempt.spawnedAt,
    settledAt: now,
    ran,
  });
  return {
    id: attempt._id,
    verdict: attemptVerdictOf(verdict.status, attempt),
    ...(run?.exitCode != null ? { exitCode: run.exitCode } : {}),
    ...(run?.oomKilled != null ? { oomKilled: run.oomKilled } : {}),
    ...(run?.exitedAt != null ? { exitedAt: run.exitedAt } : {}),
    ...(run?.startedAt != null ? { startedAt: run.startedAt } : {}),
    ...(ms !== null ? { machineMs: Math.round(ms.ms), machineMsFrom: ms.from } : {}),
    // Nothing ran, so there is nothing to copy.
    log: ran ? ('pending' as const) : ('none' as const),
  };
}

/** The pump's own lines around an attempt's log: what it asked for, and how it settled. */
export function pumpLinesOf(
  attempt: Doc<'imageryAttempts'>,
  emptyReason: string | null,
  notes: PumpLogLine[],
): PumpLogLine[] {
  const settledAt = attempt.settledAt ?? attempt.spawnedAt;
  const why = attempt.error ? `: ${attempt.error}` : '';
  const settled: PumpLogLine =
    attempt.verdict === 'landed'
      ? { loggedAt: settledAt, kind: 'stage', text: 'Settled: the frame landed' }
      : attempt.verdict === 'empty'
        ? {
            loggedAt: settledAt,
            kind: 'stage',
            text: `Settled: nothing to cut${emptyReason ? ` · ${emptyReason}` : ''}`,
          }
        : attempt.verdict === 'requeued'
          ? {
              loggedAt: settledAt,
              kind: 'warn',
              text: `Settled: no frame, so it goes back in line for another attempt${why}`,
            }
          : attempt.verdict === 'unconfirmed'
            ? {
                loggedAt: settledAt,
                kind: 'fail',
                text: 'Settled: Fly never confirmed the Machine',
              }
            : { loggedAt: settledAt, kind: 'fail', text: `Settled failed${why || ': no frame'}` };
  return [
    {
      loggedAt: attempt.spawnedAt,
      kind: 'stage',
      text: `Asked Fly for ${attempt.machineName} on ${FLY_VM_SIZE_LABEL}${attempt.image ? ` · ${attempt.image}` : ''}`,
    },
    ...notes,
    settled,
  ];
}

/**
 * **Copy one settled attempt's log into Convex** (D348): the cutter's upload (read again unless the
 * settle just read it), Fly's own lines for a cut that didn't land, the exit the settle recorded, and
 * the pump's framing lines, merged by core's `mergeCutLog` and written under the attempt in chunks of
 * `ATTEMPT_LINES_APPEND`; then the R2 object is deleted. Answers what became of it: `kept` / `none`
 * (written; `none` when the cutter uploaded nothing), or `owed` (a read or write failed — the attempt
 * stays `pending`, retried by a later run, and the R2 object is left for it).
 */
async function captureLog(
  ctx: ActionCtx,
  config: { fly: FlyConfig; r2: R2Config },
  attempt: Doc<'imageryAttempts'>,
  emptyReason: string | null,
  cutterRead: string | null | undefined,
): Promise<'kept' | 'none' | 'owed'> {
  const key = cutLogKey(attempt.season, attempt.granuleId, attempt.attempt);
  let cutterText = cutterRead;
  if (cutterText === undefined) {
    try {
      cutterText = attempt.machineId ? await getText(config.r2, key) : null;
    } catch {
      return 'owed';
    }
  }
  const notes: PumpLogLine[] = [];
  let fly: FlyMachineLogLine[] = [];
  // Fly's own lines only for a cut that didn't land: the only place a kill of the whole VM is named.
  // Optional: a refusal (the token can't read the log API) keeps the exit and loses only these.
  if (attempt.machineId && attempt.verdict !== 'landed') {
    try {
      fly = await machineLogs(config.fly, attempt.machineId);
    } catch (error) {
      notes.push({
        loggedAt: attempt.settledAt ?? attempt.spawnedAt,
        kind: 'warn',
        text: `Fly's own log lines couldn't be read: ${errorMessage(error).slice(0, 200)}`,
      });
    }
  }
  if (attempt.machineId && cutterText === null) {
    notes.push({
      loggedAt: attempt.spawnedAt,
      kind: 'warn',
      text: "The cutter didn't upload a log: its image may be from before logs were kept",
    });
  }
  const cutter: CutterLogLine[] = cutterText ? parseCutterLog(cutterText) : [];
  const exit: CutExit | null =
    attempt.exitCode === undefined &&
    attempt.oomKilled === undefined &&
    attempt.exitedAt === undefined
      ? null
      : {
          exitCode: attempt.exitCode ?? null,
          oomKilled: attempt.oomKilled ?? null,
          exitedAt: attempt.exitedAt ?? null,
        };
  const merged = mergeCutLog({ cutter, fly, exit, pump: pumpLinesOf(attempt, emptyReason, notes) });
  const keep =
    attempt.verdict === 'landed' || attempt.verdict === 'empty' ? KEPT_LOG_DAYS : FAILED_LOG_DAYS;
  const keepUntil = (attempt.settledAt ?? Date.now()) + keep * DAY_MS;
  try {
    for (let i = 0; i < merged.lines.length; i += ATTEMPT_LINES_APPEND) {
      await ctx.runMutation(internal.imageryLive.appendAttemptLines, {
        attemptId: attempt._id,
        from: i,
        lines: merged.lines.slice(i, i + ATTEMPT_LINES_APPEND),
        keepUntil,
      });
    }
    await ctx.runMutation(internal.imageryLive.closeAttemptLog, {
      attemptId: attempt._id,
      log: cutterText === null ? 'none' : 'kept',
      total: merged.lines.length,
    });
  } catch {
    return 'owed';
  }
  if (cutterText !== null) {
    try {
      await deleteObject(config.r2, key);
    } catch (error) {
      // Copied already; the bucket's 30-day rule on `logs/` is the net for the object.
      console.warn(
        `imagery pump: the copied log ${key} could not be deleted: ${errorMessage(error)}`,
      );
    }
  }
  return cutterText === null ? 'none' : 'kept';
}

/**
 * Retry the captures still owed, oldest first: each for an hour from its settle, then `missing`.
 * Bounded by count and by the run's check deadline.
 */
async function retryCaptures(
  ctx: ActionCtx,
  config: { fly: FlyConfig; r2: R2Config },
  startedAt: number,
  counts: PumpCounts,
): Promise<void> {
  const owed: Doc<'imageryAttempts'>[] = await ctx.runQuery(internal.imageryLive.pendingCaptures, {
    limit: CAPTURES_PER_RUN,
  });
  for (const attempt of owed) {
    if (Date.now() - startedAt >= CHECK_DEADLINE_MS) break;
    if (startedAt - (attempt.settledAt ?? startedAt) > CAPTURE_RETRY_MS) {
      await ctx.runMutation(internal.imageryLive.closeAttemptLog, {
        attemptId: attempt._id,
        log: 'missing',
        total: 0,
      });
      continue;
    }
    const granule = await ctx.runQuery(internal.imageryLive.granuleOf, {
      id: attempt.granuleRowId,
    });
    const result = await captureLog(ctx, config, attempt, granule?.emptyReason ?? null, undefined);
    if (result !== 'owed') counts.captured++;
  }
}

export const granuleOf = internalQuery({
  args: { id: v.id('imageryGranules') },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

/**
 * **The stopped-Machine sweep** (D348's keep rule), over one listing:
 *
 * - a stopped cut Machine whose attempt is settled is destroyed — after its exit is read onto the
 *   attempt, if the settle couldn't reach Fly (`recordAttemptExit`); a Fly that can't be read now
 *   leaves it for the next run;
 * - one whose attempt is still open is left: the settle reads its exit first;
 * - one no attempt claims (a spawn whose answer never came, a Machine from before attempts) is
 *   destroyed once Fly says it has been stopped `ORPHAN_STOPPED_MS`.
 *
 * At most `SWEEP_PER_RUN` a run, `CHECK_CONCURRENCY` at a time, none started past `deadline`.
 * Answers how many stopped cut Machines are left.
 */
async function sweepStopped(
  ctx: ActionCtx,
  fly: FlyConfig,
  machines: readonly FlyMachine[],
  now: number,
  deadline: number,
  counts: PumpCounts,
): Promise<number> {
  const stopped = machines.filter((m) => isCutMachine(m) && STOPPED_STATES.has(m.state));
  if (stopped.length === 0) return 0;
  const batch = stopped.slice(0, SWEEP_PER_RUN);
  const known = await ctx.runQuery(internal.imageryLive.attemptsByMachine, {
    machineIds: batch.map((m) => m.id),
  });
  const byMachine = new Map(known.map((k) => [k.machineId, k]));
  let destroyed = 0;
  for (let i = 0; i < batch.length; i += CHECK_CONCURRENCY) {
    if (Date.now() >= deadline) break;
    const results = await Promise.all(
      batch.slice(i, i + CHECK_CONCURRENCY).map(async (m) => {
        try {
          const a = byMachine.get(m.id);
          if (a) {
            if (!a.settled) return false;
            if (!a.exitRecorded) {
              const machine = await getMachine(fly, m.id);
              if (machine === null) return false; // already gone
              await ctx.runMutation(internal.imageryLive.recordAttemptExit, {
                id: a.attemptId,
                ...(machine.exitCode !== null ? { exitCode: machine.exitCode } : {}),
                ...(machine.oomKilled !== null ? { oomKilled: machine.oomKilled } : {}),
                ...(machine.exitedAt !== null ? { exitedAt: machine.exitedAt } : {}),
                ...(machine.startedAt !== null ? { startedAt: machine.startedAt } : {}),
              });
            }
          } else if (m.updatedAt === null || now - m.updatedAt <= ORPHAN_STOPPED_MS) {
            return false;
          } else {
            console.log(
              `imagery pump: destroying ${m.name} (${m.id}), stopped over an hour with no attempt claiming it`,
            );
          }
          await destroyMachine(fly, m.id);
          return true;
        } catch {
          return false; // Fly blinked: the next run's sweep tries again
        }
      }),
    );
    destroyed += results.filter(Boolean).length;
  }
  counts.destroyed += destroyed;
  return stopped.length - destroyed;
}

interface RunOutcome {
  backoff?: boolean;
  refusalStreak?: number;
  blindTicks?: number;
  /** Cut Machines left stopped at this run's listing; absent when it didn't list. */
  stoppedMachines?: number;
}

const pumpArgs = {};

/**
 * The pump's cron body. (Exported as `pumpHandler`, so the cron dispatcher runs it in-process:
 * `cronRuns.tickAction`, D347.)
 */
export async function pumpHandler(
  ctx: ActionCtx,
): Promise<(PumpCounts & { cronReport?: CronReport }) | { skipped: string }> {
  const startedAt = Date.now();
  const season = archiveSeasonAt(startedAt);
  // Most ticks: nothing queued or cutting — one read, no lease, no write.
  if (!(await ctx.runQuery(internal.imageryLive.hasWork, { season }))) {
    return { skipped: 'nothing to do' };
  }
  const token = crypto.randomUUID();
  const begun = await ctx.runMutation(internal.imageryLive.begin, { key: 'pump', token });
  if (!begun.ok) return { skipped: begun.reason };
  // ⚠ A run that throws backs off, tells the admins, and rethrows: the cron dispatcher records it
  // as a failed run with its message (D347) — the same as any other failure, never a silent gap.
  let outcome: RunOutcome = { backoff: true };
  try {
    const result = await pumpOnce(
      ctx,
      season,
      begun.refusalStreak,
      begun.blindTicks,
      begun.stoppedMachines,
    );
    outcome = result.outcome;
    if ('skipped' in result.counts) return result.counts;
    return result.cronReport ? { ...result.counts, cronReport: result.cronReport } : result.counts;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The run row keeps what the Seasons panel showed before the backbone: that it backs off.
    const failure = withCronReport(error, {
      worked: true,
      outcome: 'failed',
      season,
      detail: `threw: ${detail} — backing off 30 minutes unless an admin says try again`,
    });
    // The pump's own error stays the run's word: an alert that fails too is logged, never thrown in
    // its place (before the backbone, the run row was written before the alert was tried).
    try {
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-pump-error',
        season,
        problem: 'The imagery pump hit an error',
        detail: `${detail}. It backs off for half an hour and tries again.`,
      });
    } catch (alertError) {
      console.error(
        `imagery pump: the admins' alert failed too: ${alertError instanceof Error ? alertError.message : String(alertError)}`,
      );
    }
    throw failure;
  } finally {
    await ctx.runMutation(internal.imageryLive.end, { key: 'pump', token, ...outcome });
  }
}

export const pump = internalAction({ args: pumpArgs, handler: pumpHandler });

async function pumpOnce(
  ctx: ActionCtx,
  season: string,
  refusalStreakIn: number,
  blindTicksIn: number,
  stoppedIn: number,
): Promise<{
  counts: PumpCounts | { skipped: string };
  outcome: RunOutcome;
  /** Present when the run did something (settled, spawned, was refused) or backed off. */
  cronReport?: CronReport;
}> {
  const startedAt = Date.now();
  const config = configured();
  // `poll` refuses and alerts on configuration; the pump just has nothing it can do.
  if (!config.ok) return { counts: { skipped: 'unconfigured' }, outcome: {} };

  const counts: PumpCounts = {
    landed: 0,
    running: 0,
    young: 0,
    requeued: 0,
    empty: 0,
    failed: 0,
    unknown: 0,
    live: 0,
    spawned: 0,
    refused: 0,
    unconfirmed: 0,
    captured: 0,
    capturesOwed: 0,
    destroyed: 0,
    stopped: 0,
  };
  const failures: string[] = [];
  let backoff = false;
  let streak = refusalStreakIn;

  // ── Captures an earlier run owes first (each for an hour from its settle): a few, bounded ──
  await retryCaptures(ctx, config, startedAt, counts);

  // ── Settle what is cutting: CHECK_CONCURRENCY checks at a time, each group settled as it lands,
  //    and no group started past the check deadline (the rest are checked next tick) ──
  const inFlight: { granule: Doc<'imageryGranules'>; attempt: Doc<'imageryAttempts'> | null }[] =
    await ctx.runQuery(internal.imageryLive.inFlight, { season, limit: RECONCILE_BATCH });
  const settled: { id: Id<'imageryGranules'>; status: Settled; error?: string }[] = [];
  for (let i = 0; i < inFlight.length; i += CHECK_CONCURRENCY) {
    if (Date.now() - startedAt >= CHECK_DEADLINE_MS) break;
    const verdicts = await Promise.all(
      inFlight
        .slice(i, i + CHECK_CONCURRENCY)
        .map((f) => check(config, f.granule, f.attempt, startedAt)),
    );
    const now = Date.now();
    const group: {
      id: Id<'imageryGranules'>;
      status: Settled;
      error?: string;
      emptyReason?: string;
      attempt?: NonNullable<ReturnType<typeof attemptCloseOf>>;
    }[] = [];
    const settling: Extract<Verdict, { kind: 'settle' }>[] = [];
    for (const verdict of verdicts) {
      if (verdict.kind !== 'settle') {
        counts[verdict.kind]++;
        continue;
      }
      const close = attemptCloseOf(verdict, now);
      group.push({
        id: verdict.id,
        status: verdict.status,
        ...(verdict.error ? { error: verdict.error } : {}),
        ...(verdict.emptyReason ? { emptyReason: verdict.emptyReason } : {}),
        ...(close ? { attempt: close } : {}),
      });
      settling.push(verdict);
      counts[verdict.status === 'queued' ? 'requeued' : verdict.status]++;
      if (verdict.status === 'failed') failures.push(`${verdict.granuleId} (${verdict.error})`);
    }
    if (group.length === 0) continue;
    const { closed } = await ctx.runMutation(internal.imageryLive.settleMany, { settled: group });
    // A frame that landed asks for its index build at once, not only if the run gets to its end.
    if (group.some((g) => g.status === 'landed')) {
      await ctx.runMutation(internal.imageryLive.markIndexDirty, {});
    }
    settled.push(
      ...group.map(({ id, status, error }) => ({ id, status, ...(error ? { error } : {}) })),
    );

    // ── Each closed attempt: its log copied, then its Machine destroyed (its exit is on the attempt
    //    now). Past the check deadline both wait: a later run copies, the sweep destroys. ──
    if (Date.now() - startedAt >= CHECK_DEADLINE_MS) continue;
    const closedSet = new Set<string>(closed);
    const fresh: Doc<'imageryAttempts'>[] = await ctx.runQuery(internal.imageryLive.attemptsById, {
      ids: closed,
    });
    const freshById = new Map(fresh.map((a) => [a._id as string, a]));
    await Promise.all(
      settling.map(async (verdict) => {
        const capture = verdict.capture;
        if (capture === null || !closedSet.has(capture.attempt._id)) return;
        const attempt = freshById.get(capture.attempt._id);
        if (!attempt) return;
        // The log first, while Fly still has the Machine (its own lines are read by instance), then
        // the Machine — whatever became of the copy: its exit is on the attempt already.
        const result =
          attempt.log === 'pending'
            ? await captureLog(
                ctx,
                config,
                attempt,
                verdict.emptyReason ?? null,
                capture.cutterText,
              )
            : null;
        if (capture.destroyable && attempt.machineId) {
          try {
            await destroyMachine(config.fly, attempt.machineId);
            counts.destroyed++;
          } catch {
            // Left stopped: the sweep destroys it (its attempt is settled).
          }
        }
        if (result !== null && result !== 'owed') counts.captured++;
      }),
    );
  }

  // A run is *blind* when it had cuts to check and could check none. Back off on the third blind
  // run in a row — not the first, which is a blink, and not never, which with one or two cuts in
  // flight is what a threshold on the count would do.
  const blind = counts.unknown > 0 && settled.length + counts.running === 0;
  const blindTicks = blind ? blindTicksIn + 1 : 0;
  if (blindTicks >= BLIND_RUNS_TO_BACK_OFF) {
    backoff = true;
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-archive',
      season,
      problem: 'Cuts in flight cannot be checked',
      detail: `For ${blindTicks} checks in a row, none of the cuts in flight could be checked against the archive or the Fly API. The pump backs off for half an hour and tries again.`,
    });
  }

  // ── List the Machines once: the sweep of stopped cuts, then new cuts while imagery is running.
  //    Listed too while Machines were left stopped last time, paused or not: none waits a season. ──
  const state = await ctx.runQuery(internal.imageryLive.liveState, { season });
  const mayStart = state.runnable && !backoff && Date.now() - startedAt < RUN_DEADLINE_MS;
  let listed = false;
  if (mayStart || inFlight.length > 0 || stoppedIn > 0) {
    let machines: FlyMachine[] | null = null;
    let listError: string | null = null;
    try {
      machines = await listMachines(config.fly);
    } catch (error) {
      listError = errorMessage(error);
    }
    if (machines !== null) {
      listed = true;
      counts.stopped = await sweepStopped(
        ctx,
        config.fly,
        machines,
        Date.now(),
        startedAt + RUN_DEADLINE_MS,
        counts,
      );
    }
    if (mayStart && listError !== null) {
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-fly',
        season,
        problem: 'The Fly API is refusing the imagery job',
        detail: `Listing Machines failed: ${listError}. Check FLY_API_TOKEN. Nothing new is cut until it works; the pump retries every half hour, or at once when you press Try again now on the Imagery page in Machinery.`,
      });
      backoff = true;
    } else if (mayStart && machines !== null && counts.stopped >= MAX_STOPPED_MACHINES) {
      // The keep rule's bound: stopped Machines aren't going away, so no more are made.
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-stopped',
        season,
        problem: 'Finished satellite cuts are not being cleared',
        detail: `${counts.stopped} finished cut Machines are still stopped on Fly, and the pump couldn't destroy them. No new cuts start until fewer than ${MAX_STOPPED_MACHINES} are left; each check tries again. Check FLY_API_TOKEN, or destroy them with \`fly machine destroy\`.`,
      });
    } else if (mayStart && machines !== null) {
      const spawn = await startCuts(
        ctx,
        config.fly,
        season,
        streak,
        machines,
        counts,
        failures,
        startedAt + RUN_DEADLINE_MS,
      );
      streak = spawn.streak;
      backoff = spawn.backoff;
    }
  }
  counts.capturesOwed = (
    await ctx.runQuery(internal.imageryLive.pendingCaptures, { limit: CAPTURES_PER_RUN })
  ).length;

  if (failures.length > 0) {
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-cut-failed',
      season,
      problem: `${failures.length} satellite cut${failures.length === 1 ? '' : 's'} failed`,
      detail: `${failures.slice(0, 10).join(', ')}${failures.length > 10 ? ', …' : ''}. The failed attempts' logs are on the Imagery page in Machinery, where *Retry failed* queues them again.`,
    });
  }
  const runOutcome: RunOutcome = {
    backoff,
    refusalStreak: streak,
    blindTicks,
    ...(listed ? { stoppedMachines: counts.stopped } : {}),
  };
  const did = settled.length + counts.spawned + counts.refused + counts.captured + counts.destroyed;
  if (did === 0 && !backoff) {
    return { counts, outcome: runOutcome };
  }
  const at = Date.now();
  const cronReport: CronReport = {
    worked: true,
    outcome: backoff || failures.length > 0 ? 'failed' : 'ok',
    season,
    ...(backoff ? { detail: 'backing off 30 minutes' } : {}),
    counts: { ...counts },
    lines: [
      {
        kind: 'stage',
        text: `Checked ${inFlight.length} cut${inFlight.length === 1 ? '' : 's'} in flight`,
        loggedAt: at,
      },
      {
        kind: 'line',
        text: `Landed ${counts.landed}, empty ${counts.empty}, requeued ${counts.requeued}, failed ${counts.failed}; ${counts.running} still running, ${counts.unknown} not checked`,
        loggedAt: at,
      },
      ...failures.slice(0, 50).map((f) => ({ kind: 'fail' as const, text: f, loggedAt: at })),
      {
        kind: 'line',
        text: `Logs copied ${counts.captured}, still owed ${counts.capturesOwed}; Machines cleared ${counts.destroyed}, ${counts.stopped} still stopped`,
        loggedAt: at,
      },
      {
        kind: 'line',
        text: `Started ${counts.spawned}, refused ${counts.refused}, unconfirmed ${counts.unconfirmed}; ${counts.live} live of ${MAX_LIVE_MACHINES}`,
        loggedAt: at,
      },
      ...(backoff ? [{ kind: 'warn' as const, text: 'Backing off 30 minutes', loggedAt: at }] : []),
    ],
  };
  return { counts, outcome: runOutcome, cronReport };
}

/**
 * Start cuts up to the live cap, from the run's one listing. ⚠ **Throttle on Machines alive, never
 * on calls made.** A spawn returns in under a second while its job runs for minutes — `fan-out.sh`
 * saw 2,345 spawns under a call cap pile up into thousands of live Machines and land 359 of ~1,523
 * frames.
 */
async function startCuts(
  ctx: ActionCtx,
  fly: FlyConfig,
  season: string,
  streakIn: number,
  machines: readonly FlyMachine[],
  counts: PumpCounts,
  failures: string[],
  /** The run's deadline (`RUN_DEADLINE_MS`): no spawn starts past it. */
  deadline: number,
): Promise<{ streak: number; backoff: boolean }> {
  const live = liveCutMachines(machines);
  counts.live = live;
  // Half-open (one refusal short of tripping): claim exactly one — the probe.
  const room = Math.max(0, MAX_LIVE_MACHINES - live);
  const claims = await ctx.runMutation(internal.imageryLive.claimForSpawn, {
    season,
    limit: streakIn >= SPAWN_BREAKER - 1 ? Math.min(1, room) : room,
    image: fly.image,
    live,
  });
  let streak = streakIn;
  let lastError = '';
  let timeouts = 0;
  const started = Date.now();
  let next = 0;
  try {
    for (; next < claims.length; next++) {
      const claim = claims[next] as (typeof claims)[number];
      const stop =
        streak >= SPAWN_BREAKER ||
        timeouts >= TIMEOUTS_TO_STOP ||
        Date.now() - started > SPAWN_BUDGET_MS ||
        Date.now() >= deadline;
      if (stop) break;
      // ⚠ **Ask again before every spawn.** A batch can run for minutes, and *Pause*, a reset or the
      // watch ending commits in the middle of it; claims taken before that must not start after it.
      if (!(await ctx.runQuery(internal.imageryLive.liveState, { season })).runnable) break;
      try {
        const machineId = await createCutMachine(fly, {
          granuleId: claim.granuleId,
          // The newest masks, as for any cut: they are the best shape of the lakes we hold (README,
          // "MASK_SEASON is not the frame's season"). Live cuts are all this season's.
          maskSeason: season,
          attempt: claim.attempt,
          logKey: cutLogKey(claim.season, claim.granuleId, claim.attempt),
        });
        await ctx.runMutation(internal.imageryLive.settleSpawn, {
          id: claim.id,
          attemptId: claim.attemptId,
          machineId,
        });
        counts.spawned++;
        streak = 0;
      } catch (error) {
        // ⚠ **A timeout is not a refusal.** Fly may have created the Machine and answered late; the
        // claim stays in flight with no Machine id, and the settle pass decides it once the archive
        // can say — landed, requeued under a new name (`-r<attempt>`), or failed as never confirmed.
        if (isTimeout(error)) {
          counts.unconfirmed++;
          timeouts++;
          continue;
        }
        lastError = errorMessage(error);
        const result = await ctx.runMutation(internal.imageryLive.settleSpawn, {
          id: claim.id,
          attemptId: claim.attemptId,
          error: lastError,
        });
        if (result.failed) failures.push(`${claim.granuleId} (refused ${MAX_REFUSALS} times)`);
        counts.refused++;
        streak++;
      }
    }
  } finally {
    // Whatever stopped the loop — the breaker, timeouts, the budget, imagery stopping, or a throw — the claims never
    // tried go back to the queue unchanged, rather than waiting out `LOST_CLAIM_MS` in flight.
    const untried = claims.slice(next);
    if (untried.length > 0) {
      await ctx.runMutation(internal.imageryLive.handBack, {
        ids: untried.map((c) => c.id),
        attemptIds: untried.map((c) => c.attemptId),
      });
    }
  }
  if (timeouts >= TIMEOUTS_TO_STOP) {
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-fly-slow',
      season,
      problem: 'Fly is not answering spawns',
      detail: `${timeouts} spawns in one check timed out after 30 seconds. Those cuts may still run; the rest wait for the next check, three minutes away.`,
    });
  }
  // The streak persists across beats, so a refusal that comes one or two at a time still trips.
  if (streak < SPAWN_BREAKER) return { streak, backoff: false };
  await ctx.runMutation(internal.imageryLive.alertAdmins, {
    key: 'imagery-spawn',
    season,
    problem: 'Fly is refusing new satellite cuts',
    detail: `${streak} spawns in a row were refused${lastError ? `, most recently: ${lastError}` : ''}. Check FLY_IMAGE and FLY_API_TOKEN. The queue is kept; after half an hour the pump tries one spawn, or at once when you press Try again now on the Imagery page in Machinery.`,
  });
  return { streak, backoff: true };
}

// ─── The triggers (Machinery › Imagery's bar) ────────────────────────────────────────────────────

/** The refusals the bar's triggers throw, in words a person can read (D268, toasts on the web). */
export const NO_FAILED_CUTS = 'No cuts failed this season, so there’s nothing to retry.';
export const NOTHING_WAITING =
  'Nothing is waiting: the pump isn’t backing off and the index has nothing to read again.';

/** The audit row every imagery trigger leaves, on the season (`imagerySeason`, its id the season). */
export async function auditImagery(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  entry: {
    action:
      | 'start_imagery'
      | 'pause_imagery'
      | 'poll_imagery'
      | 'retry_failed_cuts'
      | 'retry_imagery_now';
    season: string;
    reason: string;
    metadata: Record<string, unknown>;
    now: number;
  },
): Promise<Id<'moderationActions'>> {
  return await writeAudit(ctx, {
    actorId: actor._id,
    action: entry.action,
    targetType: 'imagerySeason',
    targetId: entry.season,
    reason: typed(entry.reason),
    metadata: entry.metadata,
    createdAt: entry.now,
  });
}

/**
 * *Retry failed*: this season's failed cuts back in the queue with fresh attempts (at most 500 a
 * press). An admin pressing it has usually just fixed what was failing, so it also clears any backoff
 * and runs the pump at once, through the dispatcher with who pressed it. Refused with no failed cut.
 */
export async function retryFailedImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
): Promise<{ actionId: Id<'moderationActions'>; requeued: number }> {
  const now = Date.now();
  const season = archiveSeasonAt(now);
  const ledger = new Ledger(ctx);
  const rows = await ctx.db
    .query('imageryGranules')
    .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'failed'))
    .take(500);
  if (rows.length === 0) throw new ConvexError(NO_FAILED_CUTS);
  for (const row of rows) {
    await ledger.set(row, 'queued', {
      attempts: 0,
      refusals: 0,
      settledAt: undefined,
      queuedAt: now,
    });
  }
  await ledger.flush();
  await clearBackoff(ctx, 'pump');
  const actionId = await auditImagery(ctx, actor, {
    action: 'retry_failed_cuts',
    season,
    reason: 'Sent the failed cuts back in line',
    metadata: { requeued: rows.length },
    now,
  });
  // Safe at once: if a run holds the lease this one skips, and that run is already working.
  await ctx.scheduler.runAfter(0, internal.cronRuns.tickAction, {
    job: IMAGERY_CRON_JOBS.pump,
    trigger: 'manual',
    byUserId: actor._id,
  });
  return { actionId, requeued: rows.length };
}

/**
 * *Try again now*: an admin who fixed what was failing ends the pump's backoff and closes the
 * breaker — and makes a pending re-read of unreadable manifests due, with a build to do it. Refused
 * when nothing waits: no backoff, no breaker streak, no blind run counted, no re-read pending.
 */
export async function tryAgainNowImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
): Promise<{ actionId: Id<'moderationActions'> }> {
  const now = Date.now();
  const pump = await jobRow(ctx, 'pump');
  const index = await jobRow(ctx, 'index');
  const backingOff = pump?.backoffUntil !== undefined && pump.backoffUntil > now;
  const tripping = (pump?.refusalStreak ?? 0) > 0 || (pump?.blindTicks ?? 0) > 0;
  const reread = index?.retryAt !== undefined;
  if (!backingOff && !tripping && !reread) throw new ConvexError(NOTHING_WAITING);
  await clearBackoff(ctx, 'pump');
  await retryNow(ctx, 'index');
  const actionId = await auditImagery(ctx, actor, {
    action: 'retry_imagery_now',
    season: archiveSeasonAt(now),
    reason: 'Lifted the imagery pump’s wait',
    metadata: {
      prev: {
        backoffUntil: pump?.backoffUntil ?? null,
        refusalStreak: pump?.refusalStreak ?? 0,
        blindTicks: pump?.blindTicks ?? 0,
        indexRetryAt: index?.retryAt ?? null,
      },
    },
    now,
  });
  for (const job of [IMAGERY_CRON_JOBS.pump, IMAGERY_CRON_JOBS.index]) {
    await ctx.scheduler.runAfter(0, internal.cronRuns.tickAction, {
      job,
      trigger: 'manual',
      byUserId: actor._id,
    });
  }
  return { actionId };
}

// ─── 3. Index ───────────────────────────────────────────────────────────────────────────────────

export const framesPage = internalQuery({
  args: { season: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { season, cursor }) =>
    await ctx.db
      .query('imageryFrames')
      .withIndex('by_season', (q) => q.eq('season', season))
      .paginate({ cursor, numItems: 500 }),
});

const frameRow = v.object({
  season: v.string(),
  manifestKey: v.string(),
  granuleId: v.string(),
  capturedAt: v.string(),
  cloudCoverPct: v.union(v.number(), v.null()),
  bodyCount: v.number(),
  bands: v.array(v.string()),
  footprint: v.optional(geoJson),
  orbitDirection: v.optional(v.string()),
  etag: v.optional(v.string()),
});

export const syncFrames = internalMutation({
  args: { add: v.array(frameRow), remove: v.array(v.id('imageryFrames')) },
  handler: async (ctx, { add, remove }) => {
    for (const id of remove) await ctx.db.delete(id);
    for (const row of add) {
      const existing = await ctx.db
        .query('imageryFrames')
        .withIndex('by_manifest', (q) => q.eq('manifestKey', row.manifestKey))
        .first();
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert('imageryFrames', row);
    }
    return null;
  },
});

/** A manifest reduced to what the season index carries — the per-body stats stay in R2. */
export function frameFromManifest(manifestKey: string, m: FrameManifest, etag?: string) {
  return {
    season: m.season,
    manifestKey,
    granuleId: m.granuleId,
    capturedAt: m.capturedAt,
    cloudCoverPct: m.cloudCoverPct ?? null,
    bodyCount: m.bodyCount,
    bands: m.bands ?? [m.band ?? 'visual'],
    ...(m.footprint ? { footprint: m.footprint } : {}),
    ...(m.orbitDirection ? { orbitDirection: m.orbitDirection } : {}),
    ...(etag ? { etag } : {}),
  };
}

const buildIndexArgs = {};

/**
 * Rebuild this season's index when a frame has landed — under its own lease, because two builds
 * writing `index/<season>.json` out of order would let an older listing overwrite a newer one.
 * **Compare-and-clear**: the request it satisfies is marked built only after the build succeeds, so
 * a failed build — or one killed by the action limit — leaves it standing for the next tick.
 *
 * (Its body is exported as `buildIndexHandler`, so the cron dispatcher runs it in-process:
 * `cronRuns.tickAction`, D347.)
 */
export async function buildIndexHandler(
  ctx: ActionCtx,
): Promise<{ frames?: number; cronReport: CronReport } | null> {
  const seq = await ctx.runQuery(internal.imageryLive.indexOutstanding, { now: Date.now() });
  if (seq === null) return null;
  const token = crypto.randomUUID();
  const begun = await ctx.runMutation(internal.imageryLive.begin, { key: 'index', token });
  if (!begun.ok) return null;
  try {
    const result = await buildIndexOnce(ctx);
    if (result === null) return null;
    if ('failed' in result) return { cronReport: result.cronReport };
    // Built even with a manifest it could not read, so a frame landing later is not held back;
    // what it could not read is retried after a wait that doubles while it keeps failing. With
    // readable manifests still unread (the read budget ran out) the request stands, and the next
    // tick goes on — the unreadable ones get their wait and alert all the same.
    const { retryInMs } = await ctx.runMutation(internal.imageryLive.markIndexBuilt, {
      seq,
      unreadable: result.unreadable,
      complete: result.deferred === 0,
    });
    if (retryInMs !== null) {
      const n = result.unreadable;
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-index-unreadable',
        season: result.season,
        problem: 'Some cut frames cannot be read into the imagery index',
        detail: `${n} manifest${n === 1 ? '' : 's'} in frames/${result.season}/ could not be read: a new frame stays off the public timeline until it reads, and a recut one keeps its old details. The index reads ${n === 1 ? 'it' : 'them'} again in ${durationInWords(retryInMs)}, then less often while ${n === 1 ? 'it stays' : 'they stay'} unreadable; Try again now on the Imagery page in Machinery retries at once.`,
      });
    }
    return { frames: result.frames, cronReport: result.cronReport };
  } finally {
    await ctx.runMutation(internal.imageryLive.end, { key: 'index', token });
  }
}

export const buildIndex = internalAction({ args: buildIndexArgs, handler: buildIndexHandler });

async function buildIndexOnce(ctx: ActionCtx): Promise<
  | {
      frames: number;
      unreadable: number;
      deferred: number;
      season: string;
      cronReport: CronReport;
    }
  | { failed: true; cronReport: CronReport }
  | null
> {
  const startedAt = Date.now();
  const season = archiveSeasonAt(startedAt);
  const config = configured();
  if (!config.ok) return null;
  try {
    const objects = (await listObjects(config.r2, `frames/${season}/`)).filter((o) =>
      o.key.endsWith('.json'),
    );
    const listed = objects.map((o) => o.key);
    const listedSet = new Set(listed);
    const etagOf = new Map(objects.map((o) => [o.key, o.etag]));

    const rows: Doc<'imageryFrames'>[] = [];
    let cursor: string | null = null;
    do {
      const page: { page: Doc<'imageryFrames'>[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.imageryLive.framesPage, { season, cursor });
      rows.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);

    // ⚠ **A saved row is reused only while its manifest is unchanged.** A recut (`backfill`) writes
    // the same key again; its ETag is what says so, and a stale row would carry the old bands,
    // footprint and body count into the index — over the CLI's corrected one.
    // A row written before ETags were kept is stale too — it may predate a recut — and is read
    // again. Reading is bounded by time, not count (`READ_BUDGET_MS`).
    const current = (r: Doc<'imageryFrames'>) => {
      const etag = etagOf.get(r.manifestKey);
      return etag === undefined || r.etag === etag;
    };
    const byKey = new Map(rows.map((r) => [r.manifestKey, r]));
    const remove = rows
      .filter((r) => !listedSet.has(r.manifestKey))
      .map((r) => r._id as Id<'imageryFrames'>);
    const unseen = listed.filter((k) => !byKey.has(k));
    const stale = listed.filter((k) => {
      const row = byKey.get(k);
      return row !== undefined && !current(row);
    });
    // New frames first — a frame missing from the timeline matters more than a recut's details —
    // and ⚠ **manifests the last build could not read last of all**: every build starts from the
    // top, so one that stalls at the front would spend every budget, and the good frames behind it
    // would never be reached (Greptile, PR #85).
    //
    // Among themselves they rotate: least recently tried first (`imageryUnreadable`), so a stalling
    // few cannot keep a repaired one behind them unread, build after build — however many there are.
    const failingOrder: string[] = [];
    let failingCursor: string | null = null;
    do {
      const page: {
        page: Doc<'imageryUnreadable'>[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.imageryLive.unreadablePage, {
        season,
        cursor: failingCursor,
      });
      failingOrder.push(...page.page.map((r) => r.manifestKey));
      failingCursor = page.isDone ? null : page.continueCursor;
    } while (failingCursor);
    const failing = new Set(failingOrder);
    const pending = new Set([...unseen, ...stale]);
    const fresh = [
      ...unseen.filter((k) => !failing.has(k)),
      ...stale.filter((k) => !failing.has(k)),
      ...failingOrder.filter((k) => pending.has(k)),
    ];
    for (let i = 0; i < remove.length; i += 100) {
      await ctx.runMutation(internal.imageryLive.syncFrames, {
        add: [],
        remove: remove.slice(i, i + 100),
      });
    }
    const added: ReturnType<typeof frameFromManifest>[] = [];
    const reread = new Set<string>();
    const failedNow: string[] = [];
    let next = 0;
    while (next < fresh.length && Date.now() - startedAt < READ_BUDGET_MS) {
      const group = fresh.slice(next, next + MANIFEST_CONCURRENCY);
      next += group.length;
      const batch = await Promise.all(
        group.map(async (key) => {
          try {
            // Signed, past the CDN: a recut read through a cache could still be the old manifest.
            const manifest = await getJson<FrameManifest>(config.r2, key);
            return manifest ? frameFromManifest(key, manifest, etagOf.get(key)) : null;
          } catch {
            return null;
          }
        }),
      );
      const landed = batch.filter((row): row is NonNullable<typeof row> => row !== null);
      group.forEach((key, j) => {
        if (batch[j] === null) failedNow.push(key);
      });
      // Saved as it lands: a build stopped by the clock keeps what it read.
      if (landed.length > 0) {
        await ctx.runMutation(internal.imageryLive.syncFrames, { add: landed, remove: [] });
      }
      for (const row of landed) {
        added.push(row);
        reread.add(row.manifestKey);
      }
    }
    // Unread for want of time: readable ones are deferred (the request stands); known-unreadable
    // ones are still unreadable, and wait for their retry like the ones that failed just now.
    const unread = fresh.slice(next);
    const deferred = unread.filter((k) => !failing.has(k)).length;
    const unreadable = unread.filter((k) => failing.has(k)).length + failedNow.length;
    // Failed now: tried now, so behind the others next time. Read now, or no longer waiting to be
    // read (gone from the listing, or current again): forgotten. Not reached: left as they were.
    const cleared = failingOrder.filter((k) => reread.has(k) || !pending.has(k));
    for (let i = 0; i < Math.max(failedNow.length, cleared.length); i += 100) {
      await ctx.runMutation(internal.imageryLive.recordUnreadable, {
        season,
        failed: failedNow.slice(i, i + 100),
        cleared: cleared.slice(i, i + 100),
      });
    }

    // A changed manifest that could not be read keeps its old row until it can (counted unreadable,
    // so it is retried): an older description of the frame beats no frame.
    const keep = rows.filter((r) => listedSet.has(r.manifestKey) && !reread.has(r.manifestKey));
    const manifests: FrameManifest[] = [...keep, ...added].map((r) => ({
      granuleId: r.granuleId,
      capturedAt: r.capturedAt,
      cloudCoverPct: r.cloudCoverPct,
      season: r.season,
      bodyCount: r.bodyCount,
      bands: r.bands,
      ...(r.footprint ? { footprint: r.footprint as FrameManifest['footprint'] } : {}),
      ...(r.orbitDirection ? { orbitDirection: r.orbitDirection } : {}),
    }));
    const index = buildSeasonIndex(season, manifests);
    await putJson(config.r2, `index/${season}.json`, index);

    // D149's turnover: `latest` is the newest season with frames (`latestSeasonWithFrames`'s rule —
    // labels sort as strings), so this season takes it the moment it has one, and never before.
    const latest = await getPublicJson<{ season?: string }>(config.r2, 'index/latest.json');
    const turnedOver = index.frames.length > 0 && (!latest?.season || season > latest.season);
    if (turnedOver) await putJson(config.r2, 'index/latest.json', { season });

    const details = [
      ...(turnedOver ? [`index/latest.json → ${season}`] : []),
      ...(unreadable > 0
        ? [
            `${unreadable} manifest${unreadable === 1 ? '' : 's'} unreadable — the rest indexed, those re-read later`,
          ]
        : []),
    ];
    const at = Date.now();
    const cronReport: CronReport = {
      worked: true,
      outcome: unreadable > 0 ? 'failed' : 'ok',
      season,
      ...(details.length > 0 ? { detail: details.join('; ') } : {}),
      counts: {
        manifests: listed.length,
        added: added.length,
        removed: remove.length,
        unreadable,
        ...(deferred > 0 ? { deferred } : {}),
        frames: index.frames.length,
      },
      lines: [
        {
          kind: 'stage',
          text: `Listed ${listed.length} manifests in frames/${season}/`,
          loggedAt: at,
        },
        {
          kind: 'line',
          text: `Read ${added.length} new or changed, removed ${remove.length}; the index holds ${index.frames.length} frames`,
          loggedAt: at,
        },
        ...(deferred > 0
          ? [
              {
                kind: 'line' as const,
                text: `${deferred} left for the next build (out of time)`,
                loggedAt: at,
              },
            ]
          : []),
        ...(unreadable > 0
          ? [{ kind: 'warn' as const, text: `${unreadable} manifests unreadable`, loggedAt: at }]
          : []),
        ...(turnedOver
          ? [{ kind: 'line' as const, text: `index/latest.json → ${season}`, loggedAt: at }]
          : []),
      ],
    };
    return { frames: index.frames.length, unreadable, deferred, season, cronReport };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-index-failed',
      season,
      problem: 'The imagery index could not be rebuilt',
      detail,
    });
    return {
      failed: true,
      cronReport: {
        worked: true,
        outcome: 'failed',
        season,
        detail,
        lines: [{ kind: 'fail', text: detail, loggedAt: Date.now() }],
      },
    };
  }
}
