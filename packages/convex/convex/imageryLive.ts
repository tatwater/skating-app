/**
 * Live imagery — the season's satellite passes, cut as they are published (A06i §5, **D214**).
 *
 * > **D214 — Once an admin presses *Start imagery*, the season's imagery runs itself from Convex:
 * > a 6-hourly catalog poll, one Fly Machine per new pass, and an index rebuilt by listing R2.**
 *
 * ## Three functions, and only one of each ever running
 *
 * 1. **`poll`** (cron, every 6 hours, and on *Start*): asks Earth Search for new Sentinel-2 L2A and
 *    Sentinel-1 GRD items over the mask extent since the last window, selects them with A06e's
 *    rules (now in core), queues each new slot once — oldest first, at most `POLL_CAP` — and wakes
 *    the pump. It always wakes the pump, so a pump chain that died is restarted within six hours.
 * 2. **`pump`** — the only thing that touches Fly. Under a lease (never two at once), it settles
 *    the cuts in flight, then, only while imagery is running, starts new ones up to the live-Machine
 *    cap, and reschedules itself while anything is queued or cutting.
 * 3. **`buildIndex`** — under its own lease: lists `frames/<season>/` in R2, reads only manifests it
 *    has not seen, drops rows whose manifest is gone, and writes `index/<season>.json` — and
 *    `index/latest.json` on turnover. Built from the bucket, never from what was launched (A06e).
 *
 * ⚠ **Why one pump and not a chain per step** (the first build's review, 2026-10-06). Separate
 * self-rescheduling spawn and reconcile chains multiplied — every poll and every retry started
 * another — and each sized its spawn batch from its own reading of live Machines, which is the
 * overshoot `fan-out.sh` measured (58–71 Machines alive against a cap of 50) and the dropped frames
 * that came with it. They also kept spawning after *Pause*, retried a dead token every two minutes
 * forever, and lost the reconcile on one transient error. A single leased pump fixes all of that at
 * once: the cap is read and spent by one actor, *Pause* is one check, and every failure is a backoff
 * with one admin email a day.
 *
 * ## How a cut settles
 *
 * A granule has *landed* when its manifest is in the bucket. A Machine gone without one is retried
 * once; on the second miss, an exit code of zero (or none at all) is *empty* — the cutter exits 0 on
 * "nothing to cut" — and a non-zero one is *failed*, which emails the admins. A spawn the Fly API
 * refuses does not spend the granule's attempts: three refusals in a row trip a breaker, the pump
 * backs off for half an hour, and the admins hear once a day.
 *
 * ## Why a poll, not a prediction
 *
 * Sentinel orbits are predictable to the minute, but the moment that matters is when the processed
 * granule appears in the catalog — hours to a day after the pass, and not on a schedule. Asking every
 * six hours is one cheap request when there is nothing new. A 5-day overlap on each window catches
 * items published late with an earlier capture date; the slot dedupe makes the overlap free.
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

/** Days each window reaches back past the last one, for items published after their capture. */
export const LATE_PUBLISH_OVERLAP_DAYS = 5;

/** Items per `queueGranules` call — two indexed reads each, well inside a mutation's budget. */
const QUEUE_BATCH = 100;

/** Spawned granules one pump checks — a HEAD and perhaps a Machine read each. */
const RECONCILE_BATCH = 100;

/** How soon after a spawn the pump bothers to look: a cut takes 20 s to a few minutes. */
const MIN_CUT_MS = 3 * 60_000;

/** A claim with no Machine id after this long is a spawn that died mid-call — requeue it. */
const LOST_CLAIM_MS = 10 * 60_000;

/** The pump's beat while there is work, and its backoff when Fly or the archive is failing. */
const PUMP_INTERVAL_MS = 3 * 60_000;
const BACKOFF_MS = 30 * 60_000;

/** Consecutive refused spawns that trip the breaker for this pump. */
const SPAWN_BREAKER = 3;

/** Under Convex's 10-minute action limit, so a crashed holder's lease lapses before anyone waits long. */
const LEASE_MS = 9 * 60_000;

/** Manifests fetched at once while indexing. */
const MANIFEST_CONCURRENCY = 8;

type Outcome = Doc<'imageryRuns'>['outcome'];
type Status = Doc<'imageryGranules'>['status'];

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

/** Take a named lease, or say it is held. A holder that crashed loses it after `LEASE_MS`. */
export const acquireLease = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now();
    const row = await ctx.db
      .query('imageryLeases')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    if (row && row.leaseUntil > now) {
      // Someone is working: leave a note so they run once more when they finish.
      await ctx.db.patch(row._id, { pending: true });
      return false;
    }
    if (row) await ctx.db.patch(row._id, { leaseUntil: now + LEASE_MS, pending: false });
    else await ctx.db.insert('imageryLeases', { key, leaseUntil: now + LEASE_MS, pending: false });
    return true;
  },
});

/** Give a lease back. Returns whether anyone asked for another run while it was held. */
export const releaseLease = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query('imageryLeases')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    if (!row) return false;
    await ctx.db.patch(row._id, { leaseUntil: 0, pending: false });
    return row.pending;
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

/** Keep the per-season ledger totals beside every status change, so the page never counts rows. */
async function move(ctx: MutationCtx, season: string, from: Status | null, to: Status | null) {
  const row = await ctx.db
    .query('imageryCounts')
    .withIndex('by_season', (q) => q.eq('season', season))
    .unique();
  const counts = {
    queued: row?.queued ?? 0,
    spawned: row?.spawned ?? 0,
    landed: row?.landed ?? 0,
    empty: row?.empty ?? 0,
    failed: row?.failed ?? 0,
  };
  if (from) counts[from] = Math.max(0, counts[from] - 1);
  if (to) counts[to] += 1;
  if (row) await ctx.db.patch(row._id, counts);
  else await ctx.db.insert('imageryCounts', { season, ...counts });
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
      await move(ctx, item.season, null, 'queued');
      queued++;
      newest = item.capturedAt;
    }
    return { queued, known, newest };
  },
});

/**
 * Claim up to `limit` queued granules for spawning. Only the pump calls this, under its lease, so a
 * claim is never raced; it is still a mutation so that "claimed" and "counted" commit together.
 */
export const claimForSpawn = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    if (limit <= 0) return [];
    const rows = await ctx.db
      .query('imageryGranules')
      .withIndex('by_status', (q) => q.eq('status', 'queued'))
      .take(limit);
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        status: 'spawned',
        attempts: row.attempts + 1,
        spawnedAt: now,
        machineId: undefined,
      });
      await move(ctx, row.season, 'queued', 'spawned');
    }
    return rows.map((r) => ({ id: r._id, granuleId: r.granuleId, attempt: r.attempts + 1 }));
  },
});

/**
 * Record a spawn's result. A refused spawn goes back to the queue **without spending the attempt** —
 * the Fly API refusing is about Fly, not the granule; the breaker in `pump` is what stops a dead
 * token from being hammered.
 */
export const settleSpawn = internalMutation({
  args: {
    id: v.id('imageryGranules'),
    machineId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, machineId, error }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== 'spawned') return null;
    if (machineId) {
      await ctx.db.patch(id, { machineId });
      return null;
    }
    await ctx.db.patch(id, {
      status: 'queued',
      attempts: Math.max(0, row.attempts - 1),
      lastError: error ?? 'spawn refused',
    });
    await move(ctx, row.season, 'spawned', 'queued');
    return null;
  },
});

export const settleGranule = internalMutation({
  args: {
    id: v.id('imageryGranules'),
    status: literals(['queued', 'landed', 'empty', 'failed'] as const),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, error }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== 'spawned') return null;
    await ctx.db.patch(id, {
      status,
      ...(status === 'queued' ? { machineId: undefined } : { settledAt: Date.now() }),
      ...(error ? { lastError: error } : {}),
    });
    await move(ctx, row.season, 'spawned', status);
    return null;
  },
});

export const granulesByStatus = internalQuery({
  args: { status: literals(['queued', 'spawned'] as const), limit: v.number() },
  handler: async (ctx, { status, limit }) =>
    await ctx.db
      .query('imageryGranules')
      .withIndex('by_status', (q) => q.eq('status', status))
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
    const season = archiveSeasonAt(startedAt);
    // Whatever happens below, the pump gets a turn: it settles cuts in flight even when nothing new
    // is queued, and this is what restarts a pump chain that died since the last poll.
    try {
      return await pollOnce(ctx, season, startedAt);
    } finally {
      await ctx.scheduler.runAfter(0, internal.imageryLive.pump, {});
    }
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
    // next poll then starts from there (less the overlap) and picks up the rest; advancing to today
    // would put everything over the cap more than five days behind the next window, gone for good —
    // and "running it late loses nothing" is a promise the imagery email makes.
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
        detail: `${items.length - examined} more passes between ${from} and ${today} are waiting. Nothing is lost: each 6-hourly check picks up where the last one stopped, oldest first.`,
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
  requeued: number;
  empty: number;
  failed: number;
  unknown: number;
  live: number;
  spawned: number;
  refused: number;
}

export const pump = internalAction({
  args: {},
  handler: async (ctx): Promise<PumpCounts | { skipped: string }> => {
    if (!(await ctx.runMutation(internal.imageryLive.acquireLease, { key: 'pump' }))) {
      return { skipped: 'another pump is running' };
    }
    let next: number | null = null;
    try {
      const outcome = await pumpOnce(ctx);
      next = outcome.next;
      return outcome.result;
    } finally {
      const asked = await ctx.runMutation(internal.imageryLive.releaseLease, { key: 'pump' });
      if (next === null && asked) next = 0;
      if (next !== null) await ctx.scheduler.runAfter(next, internal.imageryLive.pump, {});
    }
  },
});

async function pumpOnce(
  ctx: ActionCtx,
): Promise<{ result: PumpCounts | { skipped: string }; next: number | null }> {
  const startedAt = Date.now();
  const season = archiveSeasonAt(startedAt);
  const config = configured();
  // `poll` refuses and alerts on configuration; the pump just has nothing it can do.
  if (!config.ok) return { result: { skipped: 'unconfigured' }, next: null };

  const counts: PumpCounts = {
    landed: 0,
    running: 0,
    requeued: 0,
    empty: 0,
    failed: 0,
    unknown: 0,
    live: 0,
    spawned: 0,
    refused: 0,
  };
  const failures: string[] = [];
  let backoff = false;

  // ── Settle what is cutting ──
  const inFlight: Doc<'imageryGranules'>[] = await ctx.runQuery(
    internal.imageryLive.granulesByStatus,
    { status: 'spawned', limit: RECONCILE_BATCH },
  );
  for (const granule of inFlight) {
    const age = startedAt - (granule.spawnedAt ?? 0);
    if (granule.machineId && age < MIN_CUT_MS) {
      counts.running++;
      continue;
    }
    let landed: boolean;
    try {
      landed = await publicExists(config.r2, `frames/${granule.season}/${granule.granuleId}.json`);
    } catch {
      counts.unknown++; // the archive blinked; look again next beat
      continue;
    }
    if (landed) {
      await ctx.runMutation(internal.imageryLive.settleGranule, {
        id: granule._id,
        status: 'landed',
      });
      counts.landed++;
      continue;
    }
    let exitCode: number | null = null;
    if (granule.machineId) {
      let machine: Awaited<ReturnType<typeof getMachine>>;
      try {
        machine = await getMachine(config.fly, granule.machineId);
      } catch {
        counts.unknown++;
        continue;
      }
      if (machine && LIVE_STATES.has(machine.state)) {
        counts.running++;
        continue;
      }
      exitCode = machine?.exitCode ?? null;
    } else if (age < LOST_CLAIM_MS) {
      counts.running++; // a claim whose spawn call may still be returning
      continue;
    }
    // Gone without a manifest. The first miss is always retried: a spawn that never started and a
    // genuinely empty granule look the same from here, and a retry costs seconds.
    if (granule.attempts < MAX_ATTEMPTS) {
      await ctx.runMutation(internal.imageryLive.settleGranule, {
        id: granule._id,
        status: 'queued',
        ...(exitCode ? { error: `exit ${exitCode}` } : {}),
      });
      counts.requeued++;
    } else if (exitCode !== null && exitCode !== 0) {
      await ctx.runMutation(internal.imageryLive.settleGranule, {
        id: granule._id,
        status: 'failed',
        error: `exit ${exitCode}`,
      });
      counts.failed++;
      failures.push(`${granule.granuleId} (exit ${exitCode})`);
    } else {
      // `cut-granule` exits 0 on "nothing to cut" — a footprint that misses every body.
      await ctx.runMutation(internal.imageryLive.settleGranule, {
        id: granule._id,
        status: 'empty',
      });
      counts.empty++;
    }
  }
  if (counts.unknown > 0 && counts.landed + counts.requeued + counts.empty + counts.failed === 0) {
    backoff = true;
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-archive',
      season,
      problem: 'Cuts in flight cannot be checked',
      detail: `${counts.unknown} cut${counts.unknown === 1 ? '' : 's'} could not be checked against the archive or the Fly API. The pump backs off for half an hour and tries again.`,
    });
  }

  // ── Start new cuts — only while imagery is running ──
  const state = await ctx.runQuery(internal.imageryLive.liveState, { season });
  if (state.runnable && !backoff) {
    // ⚠ **Throttle on Machines alive, never on calls made.** A spawn returns in under a second while
    // its job runs for minutes — `fan-out.sh` saw 2,345 spawns under a call cap pile up into
    // thousands of live Machines and land 359 of ~1,523 frames.
    let live: number | null = null;
    try {
      live = liveCutMachines(await listMachines(config.fly));
    } catch (error) {
      backoff = true;
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-fly',
        season,
        problem: 'The Fly API is refusing the imagery job',
        detail: `Listing Machines failed: ${error instanceof Error ? error.message : String(error)}. Check FLY_API_TOKEN. Nothing new is cut until it works; the pump retries every half hour.`,
      });
    }
    if (live !== null) {
      counts.live = live;
      const claims = await ctx.runMutation(internal.imageryLive.claimForSpawn, {
        limit: Math.max(0, MAX_LIVE_MACHINES - live),
      });
      let streak = 0;
      let lastError = '';
      for (const claim of claims) {
        if (streak >= SPAWN_BREAKER) {
          // The breaker is open: hand the rest back untouched.
          await ctx.runMutation(internal.imageryLive.settleSpawn, {
            id: claim.id,
            error: 'not attempted — spawn breaker open',
          });
          continue;
        }
        try {
          const machineId = await createCutMachine(config.fly, {
            granuleId: claim.granuleId,
            maskSeason: season,
            attempt: claim.attempt,
          });
          await ctx.runMutation(internal.imageryLive.settleSpawn, { id: claim.id, machineId });
          counts.spawned++;
          streak = 0;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await ctx.runMutation(internal.imageryLive.settleSpawn, {
            id: claim.id,
            error: lastError,
          });
          counts.refused++;
          streak++;
        }
      }
      if (streak >= SPAWN_BREAKER) {
        backoff = true;
        await ctx.runMutation(internal.imageryLive.alertAdmins, {
          key: 'imagery-spawn',
          season,
          problem: 'Fly is refusing new satellite cuts',
          detail: `${SPAWN_BREAKER} spawns in a row were refused, most recently: ${lastError}. Check FLY_IMAGE and FLY_API_TOKEN. The queue is kept; the pump retries every half hour.`,
        });
      }
    }
  }

  if (counts.landed > 0) await ctx.scheduler.runAfter(0, internal.imageryLive.buildIndex, {});
  if (failures.length > 0) {
    await ctx.runMutation(internal.imageryLive.alertAdmins, {
      key: 'imagery-cut-failed',
      season,
      problem: `${failures.length} satellite cut${failures.length === 1 ? '' : 's'} failed twice`,
      detail: `${failures.slice(0, 10).join(', ')}${failures.length > 10 ? ', …' : ''}. Read the Machine logs with \`fly logs --app skating-imagery\` while they last; *Retry failed* on the Seasons page queues them again.`,
    });
  }
  const touched =
    counts.landed +
    counts.requeued +
    counts.empty +
    counts.failed +
    counts.spawned +
    counts.refused;
  if (touched > 0 || backoff) {
    await ctx.runMutation(internal.imageryLive.recordRun, {
      season,
      kind: 'pump',
      startedAt,
      outcome: backoff || failures.length > 0 ? 'failed' : 'ok',
      ...(backoff ? { detail: 'backing off 30 minutes' } : {}),
      counts: { ...counts },
    });
  }

  // Keep beating while anything is cutting, or queued and allowed to start.
  const queued = await ctx.runQuery(internal.imageryLive.granulesByStatus, {
    status: 'queued',
    limit: 1,
  });
  const cutting = await ctx.runQuery(internal.imageryLive.granulesByStatus, {
    status: 'spawned',
    limit: 1,
  });
  const work = cutting.length > 0 || (queued.length > 0 && state.runnable);
  return {
    result: counts,
    next: backoff ? BACKOFF_MS : work ? PUMP_INTERVAL_MS : null,
  };
}

/** *Retry failed* on the page: every failed granule back in the queue with fresh attempts. */
export const retryFailed = mutation({
  args: {},
  handler: async (ctx) => {
    await requireContributorRole(ctx, 'admin');
    const rows = await ctx.db
      .query('imageryGranules')
      .withIndex('by_status', (q) => q.eq('status', 'failed'))
      .take(500);
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: 'queued', attempts: 0, settledAt: undefined });
      await move(ctx, row.season, 'failed', 'queued');
    }
    if (rows.length > 0) await ctx.scheduler.runAfter(0, internal.imageryLive.pump, {});
    return { requeued: rows.length };
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
 * Rebuild this season's index. Under its own lease — two builds writing `index/<season>.json` out of
 * order would let an older listing overwrite a newer one — and a build asked for while one runs is
 * run once more when it finishes, so no landed frame waits for a later cut to be indexed.
 */
export const buildIndex = internalAction({
  args: {},
  handler: async (ctx): Promise<{ frames: number } | null> => {
    if (!(await ctx.runMutation(internal.imageryLive.acquireLease, { key: 'index' }))) return null;
    try {
      return await buildIndexOnce(ctx);
    } finally {
      if (await ctx.runMutation(internal.imageryLive.releaseLease, { key: 'index' })) {
        await ctx.scheduler.runAfter(0, internal.imageryLive.buildIndex, {});
      }
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

/** Recent runs and this season's ledger totals, for `/admin/seasons`. */
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
      .withIndex('by_status', (q) => q.eq('status', 'failed'))
      .order('desc')
      .take(10);
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
      configured: configured().ok,
      pollCap: POLL_CAP,
      maxLive: MAX_LIVE_MACHINES,
    };
  },
});
