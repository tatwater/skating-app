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
 *    bucket, never from what was launched (A06e). A failed build is retried on the next tick.
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
  buildSeasonIndex,
  type FrameManifest,
  type GranuleCandidate,
  parseGranuleId,
  parseSarGranuleId,
  STAC_COLLECTIONS,
  type StacMission,
  searchStac,
  selectGranules,
  selectSarGranules,
  stacDayRange,
  tileSurveyKey,
} from '@skating/core';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from './_generated/server';
import { requireContributorRole, requireRole } from './lib/auth';
import { firstToday } from './lib/dailyThrottle';
import {
  createCutMachine,
  type FlyConfig,
  flyConfigFromEnv,
  getMachine,
  LIVE_STATES,
  listMachines,
  liveCutMachines,
} from './lib/fly';
import {
  beginRun,
  clearBackoff,
  endRun,
  jobRow,
  markDirty,
  SPAWN_BREAKER,
  takeDirty,
} from './lib/imageryPump';
import {
  getPublicJson,
  listKeys,
  publicExists,
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

/** Failed checks, with no answer among them, that mean the archive or Fly is down rather than blinking. */
const BLINKS_TO_BACK_OFF = 3;

/** How soon after a spawn the pump bothers to look: a cut takes 20 s to a few minutes. */
const MIN_CUT_MS = 3 * 60_000;

/** A claim with no Machine id after this long is a spawn that died mid-call — requeue it. */
const LOST_CLAIM_MS = 10 * 60_000;

/** Manifests fetched at once while indexing. */
const MANIFEST_CONCURRENCY = 8;

type Outcome = Doc<'imageryRuns'>['outcome'];
type Status = Doc<'imageryGranules'>['status'];
type Settled = 'queued' | 'landed' | 'empty' | 'failed';

// ─── State ──────────────────────────────────────────────────────────────────────────────────────

/** The season the live job serves right now, and whether it may start new cuts. */
export const liveState = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    const row = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    if (!row) return { runnable: false as const, reason: 'no watch is open' };
    if (row.closesOn !== undefined)
      return { runnable: false as const, reason: 'the watch has ended' };
    if (row.imageryStartedAt === undefined) {
      return { runnable: false as const, reason: 'imagery has not been started' };
    }
    if (row.imageryPausedAt !== undefined)
      return { runnable: false as const, reason: 'imagery is paused' };
    return { runnable: true as const, opensOn: row.opensOn, windowTo: row.imageryWindowTo ?? null };
  },
});

export const recordRun = internalMutation({
  args: {
    season: v.string(),
    kind: literals(['poll', 'pump', 'index'] as const),
    startedAt: v.number(),
    outcome: literals(['ok', 'capped', 'failed', 'refused', 'skipped'] as const),
    detail: v.optional(v.string()),
    counts: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('imageryRuns', { ...args, finishedAt: Date.now() });
    return null;
  },
});

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
      deepLinkPath: '/admin/seasons',
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

export const takeIndexDirty = internalMutation({
  args: {},
  handler: async (ctx) => await takeDirty(ctx, 'index'),
});

/** Whether a tick has anything to do: a cut in flight, or one queued and allowed to start. */
export const hasWork = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    const first = (status: 'queued' | 'spawned') =>
      ctx.db
        .query('imageryGranules')
        .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', status))
        .first();
    if (await first('spawned')) return true;
    if (!(await first('queued'))) return false;
    const row = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    return (
      row !== null &&
      row.closesOn === undefined &&
      row.imageryStartedAt !== undefined &&
      row.imageryPausedAt === undefined
    );
  },
});

export const indexDirty = internalQuery({
  args: {},
  handler: async (ctx) => (await jobRow(ctx, 'index'))?.dirty === true,
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

  constructor(private readonly ctx: MutationCtx) {}

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
    for (const [season, d] of this.deltas) {
      const row = await this.ctx.db
        .query('imageryCounts')
        .withIndex('by_season', (q) => q.eq('season', season))
        .unique();
      const next = {
        queued: (row?.queued ?? 0) + d.queued,
        spawned: (row?.spawned ?? 0) + d.spawned,
        landed: (row?.landed ?? 0) + d.landed,
        empty: (row?.empty ?? 0) + d.empty,
        failed: (row?.failed ?? 0) + d.failed,
      };
      if (row) await this.ctx.db.patch(row._id, next);
      else await this.ctx.db.insert('imageryCounts', { season, ...next });
    }
    this.deltas.clear();
  }
}

const queueItem = v.object({
  granuleId: v.string(),
  slot: v.string(),
  mission: literals(['s2', 's1'] as const),
  season: v.string(),
  capturedAt: v.string(),
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

/** Claim up to `limit` of this season's queued granules. Only the pump calls this, under its lease. */
export const claimForSpawn = internalMutation({
  args: { season: v.string(), limit: v.number() },
  handler: async (ctx, { season, limit }) => {
    if (limit <= 0) return [];
    const ledger = new Ledger(ctx);
    const rows = await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'queued'))
      .take(limit);
    const now = Date.now();
    for (const row of rows) {
      await ledger.set(row, 'spawned', {
        attempts: row.attempts + 1,
        spawnedAt: now,
        machineId: undefined,
      });
    }
    await ledger.flush();
    return rows.map((r) => ({ id: r._id, granuleId: r.granuleId, attempt: r.attempts + 1 }));
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
    machineId: v.optional(v.string()),
    error: v.optional(v.string()),
    untried: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, machineId, error, untried }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== 'spawned') return { failed: false };
    if (machineId) {
      await ctx.db.patch(id, { machineId });
      return { failed: false };
    }
    const ledger = new Ledger(ctx);
    const attempts = Math.max(0, row.attempts - 1);
    if (untried) {
      await ledger.set(row, 'queued', { attempts });
      await ledger.flush();
      return { failed: false };
    }
    const refusals = (row.refusals ?? 0) + 1;
    const failed = refusals >= MAX_REFUSALS;
    await ledger.set(row, failed ? 'failed' : 'queued', {
      attempts,
      refusals,
      lastError: error ?? 'spawn refused',
      ...(failed ? { settledAt: Date.now() } : { queuedAt: Date.now() }),
    });
    await ledger.flush();
    return { failed };
  },
});

/** Apply one pump's verdicts on the cuts it checked, in one transaction. */
export const settleMany = internalMutation({
  args: {
    settled: v.array(
      v.object({
        id: v.id('imageryGranules'),
        status: literals(['queued', 'landed', 'empty', 'failed'] as const),
        error: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { settled }) => {
    const ledger = new Ledger(ctx);
    const now = Date.now();
    for (const s of settled) {
      const row = await ctx.db.get(s.id);
      if (row?.status !== 'spawned') continue;
      await ledger.set(row, s.status, {
        ...(s.status === 'queued' ? { machineId: undefined } : { settledAt: now }),
        ...(s.error ? { lastError: s.error } : {}),
      });
    }
    await ledger.flush();
    return null;
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

export const poll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ outcome: Outcome; detail?: string }> => {
    const startedAt = Date.now();
    // The pump's own 3-minute tick picks up whatever this queues.
    return await pollOnce(ctx, archiveSeasonAt(startedAt), startedAt);
  },
});

async function pollOnce(
  ctx: ActionCtx,
  season: string,
  startedAt: number,
): Promise<{ outcome: Outcome; detail?: string }> {
  const state = await ctx.runQuery(internal.imageryLive.liveState, { season });
  // Not started (or paused, or over) is the normal state most of the year — no run row, no noise.
  if (!state.runnable) return { outcome: 'skipped', detail: state.reason };

  const finish = async (outcome: Outcome, detail?: string, counts?: Record<string, number>) => {
    await ctx.runMutation(internal.imageryLive.recordRun, {
      season,
      kind: 'poll',
      startedAt,
      outcome,
      ...(detail ? { detail } : {}),
      ...(counts ? { counts } : {}),
    });
    return { outcome, ...(detail ? { detail } : {}) };
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
    const from = overlap > state.opensOn ? overlap : state.opensOn;
    const datetime = stacDayRange(from, today);
    const search = async (mission: StacMission) =>
      (
        await searchStac(fetch, {
          collection: STAC_COLLECTIONS[mission],
          bbox: plan.bbox,
          datetime,
        })
      ).items;
    const [s2, s1] = await Promise.all([search('s2'), search('s1')]);

    // A06e's selection, unchanged: no cloud gate (we cut and keep everything), the empty-tile
    // prefilter for optical, the DV/IW/GRDH filter for radar.
    const s2Selected = selectGranules(s2, { emptyTiles: new Set(plan.emptyTiles) });
    const s1Selected = selectSarGranules(s1);
    const byId = new Map<string, GranuleCandidate>([...s2, ...s1].map((c) => [c.id, c]));
    const items = [...s2Selected.selected, ...s1Selected.selected]
      .flatMap((granuleId) => {
        const key = slotOf(granuleId);
        const candidate = byId.get(granuleId);
        if (!key || !candidate) return [];
        return [
          {
            granuleId,
            slot: key.slot,
            mission: key.mission,
            // The frame season comes from the capture date — where `cut-granule` files it.
            season: archiveSeasonAt(Date.parse(candidate.datetime)),
            capturedAt: candidate.datetime,
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

    // ⚠ **A capped poll advances its window only to the newest pass it queued**, never to today. The
    // next poll starts from there (less the overlap) and picks up the rest; advancing to today would
    // put everything past the cap more than five days behind the next window, gone for good — and
    // "running it late loses nothing" is a promise the imagery email makes. Some of what was not
    // examined may already be queued; the next poll skips those for two index reads each.
    const windowTo = capped && newest ? newest.slice(0, 10) : today;
    await ctx.runMutation(internal.imageryLive.setWindowTo, { season, windowTo });

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
}

/** An aborted fetch — `AbortSignal.timeout` throws a `TimeoutError`, an abort an `AbortError`. */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

type Verdict =
  | {
      kind: 'settle';
      id: Id<'imageryGranules'>;
      status: Settled;
      error?: string;
      granuleId: string;
    }
  | { kind: 'running' | 'young' | 'unknown' };

/** What the bucket and Fly say about one cut in flight. Never throws: a failed read is `unknown`. */
async function check(
  config: { fly: FlyConfig; r2: R2Config },
  granule: Doc<'imageryGranules'>,
  now: number,
): Promise<Verdict> {
  const age = now - (granule.spawnedAt ?? 0);
  if (granule.machineId && age < MIN_CUT_MS) return { kind: 'young' };
  const settle = (status: Settled, error?: string): Verdict => ({
    kind: 'settle',
    id: granule._id,
    status,
    granuleId: granule.granuleId,
    ...(error ? { error } : {}),
  });
  try {
    if (await publicExists(config.r2, `frames/${granule.season}/${granule.granuleId}.json`)) {
      return settle('landed');
    }
    let exitCode: number | null = null;
    if (granule.machineId) {
      const machine = await getMachine(config.fly, granule.machineId);
      if (machine && LIVE_STATES.has(machine.state)) return { kind: 'running' };
      exitCode = machine?.exitCode ?? null;
    } else if (age < LOST_CLAIM_MS) {
      return { kind: 'young' }; // a claim whose spawn call may still be returning
    }
    // Gone without a manifest. The first miss is always retried: a spawn that never started and a
    // genuinely empty granule look the same from here, and a retry costs seconds.
    if (granule.attempts < MAX_ATTEMPTS) {
      return settle('queued', exitCode ? `exit ${exitCode}` : undefined);
    }
    if (exitCode !== null && exitCode !== 0) return settle('failed', `exit ${exitCode}`);
    // `cut-granule` exits 0 on "nothing to cut" — a footprint that misses every body.
    return settle('empty');
  } catch {
    return { kind: 'unknown' }; // the archive or the Fly API blinked; look again next beat
  }
}

interface RunOutcome {
  backoff?: boolean;
  refusalStreak?: number;
}

export const pump = internalAction({
  args: {},
  handler: async (ctx): Promise<PumpCounts | { skipped: string }> => {
    const startedAt = Date.now();
    const season = archiveSeasonAt(startedAt);
    // Most ticks: nothing queued or cutting — one read, no lease, no write.
    if (!(await ctx.runQuery(internal.imageryLive.hasWork, { season }))) {
      return { skipped: 'nothing to do' };
    }
    const token = crypto.randomUUID();
    const begun = await ctx.runMutation(internal.imageryLive.begin, { key: 'pump', token });
    if (!begun.ok) return { skipped: begun.reason };
    // ⚠ A run that throws backs off, leaves a run row, and tells the admins — the same as any
    // other failure, rather than a silent gap.
    let outcome: RunOutcome = { backoff: true };
    try {
      const result = await pumpOnce(ctx, season, begun.refusalStreak);
      outcome = result.outcome;
      return result.counts;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.imageryLive.recordRun, {
        season,
        kind: 'pump',
        startedAt,
        outcome: 'failed',
        detail: `threw: ${detail} — backing off 30 minutes`,
      });
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-pump-error',
        season,
        problem: 'The imagery pump hit an error',
        detail: `${detail}. It backs off for half an hour and tries again.`,
      });
      throw error;
    } finally {
      await ctx.runMutation(internal.imageryLive.end, { key: 'pump', token, ...outcome });
    }
  },
});

async function pumpOnce(
  ctx: ActionCtx,
  season: string,
  refusalStreakIn: number,
): Promise<{ counts: PumpCounts | { skipped: string }; outcome: RunOutcome }> {
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
  };
  const failures: string[] = [];
  let backoff = false;
  let streak = refusalStreakIn;

  // ── Settle what is cutting: CHECK_CONCURRENCY checks at a time, then one transaction ──
  const inFlight: Doc<'imageryGranules'>[] = await ctx.runQuery(
    internal.imageryLive.granulesByStatus,
    { season, status: 'spawned', limit: RECONCILE_BATCH },
  );
  const verdicts: Verdict[] = [];
  for (let i = 0; i < inFlight.length; i += CHECK_CONCURRENCY) {
    verdicts.push(
      ...(await Promise.all(
        inFlight.slice(i, i + CHECK_CONCURRENCY).map((g) => check(config, g, startedAt)),
      )),
    );
  }
  const settled: { id: Id<'imageryGranules'>; status: Settled; error?: string }[] = [];
  for (const verdict of verdicts) {
    if (verdict.kind !== 'settle') {
      counts[verdict.kind]++;
      continue;
    }
    settled.push({
      id: verdict.id,
      status: verdict.status,
      ...(verdict.error ? { error: verdict.error } : {}),
    });
    counts[verdict.status === 'queued' ? 'requeued' : verdict.status]++;
    if (verdict.status === 'failed') failures.push(`${verdict.granuleId} (${verdict.error})`);
  }
  if (settled.length > 0) await ctx.runMutation(internal.imageryLive.settleMany, { settled });

  // Back off only when nothing could be answered **and** at least `BLINKS_TO_BACK_OFF` checks
  // failed. One blink — beside answers, beside cuts too young to check, or alone — is the next
  // tick's job, three minutes away; a backoff is thirty, and a false one idles the whole fleet.
  if (counts.unknown >= BLINKS_TO_BACK_OFF && settled.length + counts.running === 0) {
    backoff = true;
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-archive',
      season,
      problem: 'Cuts in flight cannot be checked',
      detail: `None of ${counts.unknown} cut${counts.unknown === 1 ? '' : 's'} in flight could be checked against the archive or the Fly API. The pump backs off for half an hour and tries again.`,
    });
  }

  // ── Start new cuts — only while imagery is running ──
  const state = await ctx.runQuery(internal.imageryLive.liveState, { season });
  if (state.runnable && !backoff) {
    const spawn = await startCuts(ctx, config.fly, season, streak, counts, failures);
    streak = spawn.streak;
    backoff = spawn.backoff;
  }

  if (counts.landed > 0) await ctx.runMutation(internal.imageryLive.markIndexDirty, {});
  if (failures.length > 0) {
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-cut-failed',
      season,
      problem: `${failures.length} satellite cut${failures.length === 1 ? '' : 's'} failed`,
      detail: `${failures.slice(0, 10).join(', ')}${failures.length > 10 ? ', …' : ''}. Read the Machine logs with \`fly logs --app skating-imagery\` while they last; *Retry failed* on the Seasons page queues them again.`,
    });
  }
  if (settled.length + counts.spawned + counts.refused > 0 || backoff) {
    await ctx.runMutation(internal.imageryLive.recordRun, {
      season,
      kind: 'pump',
      startedAt,
      outcome: backoff || failures.length > 0 ? 'failed' : 'ok',
      ...(backoff ? { detail: 'backing off 30 minutes' } : {}),
      counts: { ...counts },
    });
  }
  return { counts, outcome: { backoff, refusalStreak: streak } };
}

/**
 * Start cuts up to the live cap. ⚠ **Throttle on Machines alive, never on calls made.** A spawn
 * returns in under a second while its job runs for minutes — `fan-out.sh` saw 2,345 spawns under a
 * call cap pile up into thousands of live Machines and land 359 of ~1,523 frames.
 */
async function startCuts(
  ctx: ActionCtx,
  fly: FlyConfig,
  season: string,
  streakIn: number,
  counts: PumpCounts,
  failures: string[],
): Promise<{ streak: number; backoff: boolean }> {
  let live: number;
  try {
    live = liveCutMachines(await listMachines(fly));
  } catch (error) {
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-fly',
      season,
      problem: 'The Fly API is refusing the imagery job',
      detail: `Listing Machines failed: ${error instanceof Error ? error.message : String(error)}. Check FLY_API_TOKEN. Nothing new is cut until it works; the pump retries every half hour, or at once when you press Try again now on the Seasons page.`,
    });
    return { streak: streakIn, backoff: true };
  }
  counts.live = live;
  const claims = await ctx.runMutation(internal.imageryLive.claimForSpawn, {
    season,
    limit: Math.max(0, MAX_LIVE_MACHINES - live),
  });
  let streak = streakIn;
  let lastError = '';
  for (const claim of claims) {
    if (streak >= SPAWN_BREAKER) {
      await ctx.runMutation(internal.imageryLive.settleSpawn, { id: claim.id, untried: true });
      continue;
    }
    try {
      const machineId = await createCutMachine(fly, {
        granuleId: claim.granuleId,
        // The newest masks, as for any cut: they are the best shape of the lakes we hold (README,
        // "MASK_SEASON is not the frame's season"). Live cuts are all this season's.
        maskSeason: season,
        attempt: claim.attempt,
      });
      await ctx.runMutation(internal.imageryLive.settleSpawn, { id: claim.id, machineId });
      counts.spawned++;
      streak = 0;
    } catch (error) {
      // ⚠ **A timeout is not a refusal.** Fly may have created the Machine and answered late; the
      // claim stays in flight with no Machine id, and the settle pass decides it once the archive
      // can say — landed, or requeued under a new name (`-r<attempt>`) after `LOST_CLAIM_MS`.
      if (isTimeout(error)) {
        counts.unconfirmed++;
        continue;
      }
      lastError = error instanceof Error ? error.message : String(error);
      const result = await ctx.runMutation(internal.imageryLive.settleSpawn, {
        id: claim.id,
        error: lastError,
      });
      if (result.failed) failures.push(`${claim.granuleId} (refused ${MAX_REFUSALS} times)`);
      counts.refused++;
      streak++;
    }
  }
  // The streak persists across beats, so a refusal that comes one or two at a time still trips.
  if (streak < SPAWN_BREAKER) return { streak, backoff: false };
  await ctx.runMutation(internal.imageryLive.alertAdmins, {
    key: 'imagery-spawn',
    season,
    problem: 'Fly is refusing new satellite cuts',
    detail: `${streak} spawns in a row were refused${lastError ? `, most recently: ${lastError}` : ''}. Check FLY_IMAGE and FLY_API_TOKEN. The queue is kept; after half an hour the pump tries one spawn, or at once when you press Try again now on the Seasons page.`,
  });
  return { streak, backoff: true };
}

/**
 * *Retry failed* on the page: this season's failed cuts back in the queue with fresh attempts. An
 * admin pressing it has usually just fixed what was failing, so it also clears any backoff.
 * The pump's next tick, at most three minutes away, starts them.
 */
export const retryFailed = mutation({
  args: {},
  handler: async (ctx) => {
    await requireContributorRole(ctx, 'admin');
    const season = archiveSeasonAt(Date.now());
    const ledger = new Ledger(ctx);
    const rows = await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'failed'))
      .take(500);
    for (const row of rows) {
      await ledger.set(row, 'queued', {
        attempts: 0,
        refusals: 0,
        settledAt: undefined,
        queuedAt: Date.now(),
      });
    }
    await ledger.flush();
    await clearBackoff(ctx, 'pump');
    return { requeued: rows.length };
  },
});

/** *Try again now*: an admin who fixed what was failing ends the backoff and closes the breaker. */
export const tryAgainNow = mutation({
  args: {},
  handler: async (ctx) => {
    await requireContributorRole(ctx, 'admin');
    await clearBackoff(ctx, 'pump');
    return null;
  },
});

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
export function frameFromManifest(manifestKey: string, m: FrameManifest) {
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
  };
}

/**
 * Rebuild this season's index when a frame has landed — under its own lease, because two builds
 * writing `index/<season>.json` out of order would let an older listing overwrite a newer one. The
 * dirty flag is taken at the start, so a frame that lands during the build marks it again, and a
 * build that fails puts it back, so the next tick retries rather than leaving the index short.
 */
export const buildIndex = internalAction({
  args: {},
  handler: async (ctx): Promise<{ frames: number } | null> => {
    if (!(await ctx.runQuery(internal.imageryLive.indexDirty, {}))) return null;
    const token = crypto.randomUUID();
    const begun = await ctx.runMutation(internal.imageryLive.begin, { key: 'index', token });
    if (!begun.ok) return null;
    let took = false;
    let result: { frames: number } | null = null;
    try {
      took = await ctx.runMutation(internal.imageryLive.takeIndexDirty, {});
      if (!took) return null;
      result = await buildIndexOnce(ctx);
      return result;
    } finally {
      if (took && result === null) await ctx.runMutation(internal.imageryLive.markIndexDirty, {});
      await ctx.runMutation(internal.imageryLive.end, { key: 'index', token });
    }
  },
});

async function buildIndexOnce(ctx: ActionCtx): Promise<{ frames: number } | null> {
  const startedAt = Date.now();
  const season = archiveSeasonAt(startedAt);
  const config = configured();
  if (!config.ok) return null;
  try {
    const listed = (await listKeys(config.r2, `frames/${season}/`)).filter((k) =>
      k.endsWith('.json'),
    );
    const listedSet = new Set(listed);

    const rows: Doc<'imageryFrames'>[] = [];
    let cursor: string | null = null;
    do {
      const page: { page: Doc<'imageryFrames'>[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.imageryLive.framesPage, { season, cursor });
      rows.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);

    const known = new Set(rows.map((r) => r.manifestKey));
    const remove = rows
      .filter((r) => !listedSet.has(r.manifestKey))
      .map((r) => r._id as Id<'imageryFrames'>);
    const fresh = listed.filter((k) => !known.has(k));
    const added: ReturnType<typeof frameFromManifest>[] = [];
    let unreadable = 0;
    for (let i = 0; i < fresh.length; i += MANIFEST_CONCURRENCY) {
      const batch = await Promise.all(
        fresh.slice(i, i + MANIFEST_CONCURRENCY).map(async (key) => {
          try {
            const manifest = await getPublicJson<FrameManifest>(config.r2, key);
            return manifest ? frameFromManifest(key, manifest) : null;
          } catch {
            return null;
          }
        }),
      );
      for (const row of batch) {
        if (row) added.push(row);
        else unreadable++;
      }
    }
    for (let i = 0; i < Math.max(added.length, remove.length); i += 100) {
      await ctx.runMutation(internal.imageryLive.syncFrames, {
        add: added.slice(i, i + 100),
        remove: remove.slice(i, i + 100),
      });
    }

    const keep = rows.filter((r) => listedSet.has(r.manifestKey));
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

    await ctx.runMutation(internal.imageryLive.recordRun, {
      season,
      kind: 'index',
      startedAt,
      outcome: 'ok',
      ...(turnedOver ? { detail: `index/latest.json → ${season}` } : {}),
      counts: {
        manifests: listed.length,
        added: added.length,
        removed: remove.length,
        unreadable,
        frames: index.frames.length,
      },
    });
    return { frames: index.frames.length };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-index-failed',
      season,
      problem: 'The imagery index could not be rebuilt',
      detail,
    });
    await ctx.runMutation(internal.imageryLive.recordRun, {
      season,
      kind: 'index',
      startedAt,
      outcome: 'failed',
      detail,
    });
    return null;
  }
}

// ─── The admin page ─────────────────────────────────────────────────────────────────────────────

/** Recent runs and this season's ledger, for `/admin/seasons`. */
export const activity = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'admin');
    const season = archiveSeasonAt(Date.now());
    const runs = await ctx.db.query('imageryRuns').withIndex('by_started').order('desc').take(40);
    const ledger = await ctx.db
      .query('imageryCounts')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    const failed = await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', season).eq('status', 'failed'))
      .order('desc')
      .take(10);
    const pump = await jobRow(ctx, 'pump');
    return {
      runs,
      counts: {
        queued: ledger?.queued ?? 0,
        spawned: ledger?.spawned ?? 0,
        landed: ledger?.landed ?? 0,
        empty: ledger?.empty ?? 0,
        failed: ledger?.failed ?? 0,
      },
      failed: failed.map((g) => ({ granuleId: g.granuleId, lastError: g.lastError ?? null })),
      backoffUntil: pump?.backoffUntil ?? null,
      configured: configured().ok,
      pollCap: POLL_CAP,
      maxLive: MAX_LIVE_MACHINES,
    };
  },
});
