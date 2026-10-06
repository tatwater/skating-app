/**
 * Live imagery — the season's satellite passes, cut as they are published (A06i §5, **D214**).
 *
 * > **D214 — Once an admin presses *Start imagery*, the season's imagery runs itself from Convex:
 * > a 6-hourly catalog poll, one Fly Machine per new pass, and an index rebuilt by listing R2.**
 *
 * ## The four steps, each its own scheduled function
 *
 * 1. **`poll`** (cron, every 6 hours, and on *Start*): asks Earth Search for new Sentinel-2 L2A and
 *    Sentinel-1 GRD items over the mask extent since the last window, selects them with A06e's
 *    rules (now in core), and queues each new slot once.
 * 2. **`spawn`**: claims queued granules up to the live-Machine cap and starts one cut each, with
 *    exactly `fan-out.sh`'s Machine configuration (`lib/fly`). Reschedules itself while any are left.
 * 3. **`reconcile`** (20 minutes later): a granule has *landed* when its manifest is in the bucket.
 *    A Machine that is gone without one is retried once; on the second miss, an exit code of zero
 *    (or none at all) is recorded as *empty* — the cutter exits 0 on "nothing to cut" — and a
 *    non-zero one as *failed*, which emails the admins.
 * 4. **`buildIndex`**: lists `frames/<season>/` in R2, reads only manifests it has not seen, drops
 *    rows whose manifest is gone, and writes `index/<season>.json` — and `index/latest.json` when
 *    this season has frames — so a client sees the new pass. Built from the bucket, never from what
 *    was launched: A06e's rule, which the live job keeps.
 *
 * ## Why a poll, not a prediction
 *
 * Sentinel orbits are predictable to the minute, but the moment that matters is when the processed
 * granule appears in the catalog — hours to a day after the pass, and not on a schedule. Asking the
 * catalog every six hours is one cheap request when there is nothing new, and leaves a pass at most
 * ~6½ hours from publication to the app. A 5-day overlap on each window catches items published late
 * with an earlier capture date; the slot dedupe makes the overlap free.
 *
 * ## Guards
 *
 * `POLL_CAP` granules a poll at most (~1–2 days of passes is ~40; the first catch-up after *Start* is
 * a few hundred at worst), a missing credential refuses the run, and every alert is throttled to one
 * per kind per day (`operatorAlertThrottle`). A season cuts for about $1.50 of Fly compute (A06e).
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
import { internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { requireRole } from './lib/auth';
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
import { composeImageryAlert, newYorkDate } from './lib/seasonWatchEmails';
import { geoJson, literals } from './lib/validators';

/** The most granules one poll may queue — a spend guard, not a throttle. */
export const POLL_CAP = 300;

/** `fan-out.sh`'s `MAX_PARALLEL`: Machines alive at once. Past this, cuts silently fail to land. */
export const MAX_LIVE_MACHINES = 25;

/** Attempts per granule before it is settled as empty or failed. */
export const MAX_ATTEMPTS = 2;

/** Days each window reaches back past the last one, for items published after their capture. */
export const LATE_PUBLISH_OVERLAP_DAYS = 5;

const SPAWN_RETRY_MS = 2 * 60_000;
const RECONCILE_DELAY_MS = 20 * 60_000;
const RECONCILE_RETRY_MS = 10 * 60_000;
/** A claim with no Machine id after this long is a spawn that died mid-call — requeue it. */
const LOST_CLAIM_MS = 10 * 60_000;
/** Manifests fetched at once while indexing. */
const MANIFEST_CONCURRENCY = 8;

type Outcome = Doc<'imageryRuns'>['outcome'];

// ─── State ──────────────────────────────────────────────────────────────────────────────────────

/** The season the live job serves right now, and whether it may run. */
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
    kind: literals(['poll', 'spawn', 'reconcile', 'index'] as const),
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
    const today = newYorkDate(Date.now());
    const row = await ctx.db
      .query('operatorAlertThrottle')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    if (row?.lastSentOn === today) return { sent: false };
    if (row) await ctx.db.patch(row._id, { lastSentOn: today });
    else await ctx.db.insert('operatorAlertThrottle', { key, lastSentOn: today });
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

const queueItem = v.object({
  granuleId: v.string(),
  slot: v.string(),
  mission: literals(['s2', 's1'] as const),
  season: v.string(),
  capturedAt: v.string(),
});

/**
 * Queue each granule whose id **and** slot are unseen, oldest first, up to `cap` new ones.
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
    let overCap = 0;
    const now = Date.now();
    for (const item of [...items].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
      const byId = await ctx.db
        .query('imageryGranules')
        .withIndex('by_granule', (q) => q.eq('granuleId', item.granuleId))
        .first();
      const bySlot = byId
        ? byId
        : await ctx.db
            .query('imageryGranules')
            .withIndex('by_slot', (q) => q.eq('slot', item.slot))
            .first();
      if (bySlot) {
        known++;
        continue;
      }
      if (queued >= cap) {
        overCap++;
        continue;
      }
      await ctx.db.insert('imageryGranules', {
        ...item,
        status: 'queued',
        attempts: 0,
        queuedAt: now,
      });
      queued++;
    }
    return { queued, known, overCap };
  },
});

/**
 * Claim up to `limit` queued granules for spawning, atomically — two overlapping spawn passes must
 * never start the same cut twice. A claim is `spawned` with no Machine id until the call returns.
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
    }
    return rows.map((r) => ({ id: r._id, granuleId: r.granuleId, attempt: r.attempts + 1 }));
  },
});

export const settleSpawn = internalMutation({
  args: {
    id: v.id('imageryGranules'),
    machineId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, machineId, error }) => {
    const row = await ctx.db.get(id);
    if (!row) return null;
    if (machineId) {
      await ctx.db.patch(id, { machineId });
      return null;
    }
    await ctx.db.patch(id, {
      status: row.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      ...(row.attempts >= MAX_ATTEMPTS ? { settledAt: Date.now() } : {}),
      lastError: error ?? 'spawn failed',
    });
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
    await ctx.db.patch(id, {
      status,
      ...(status === 'queued' ? { machineId: undefined } : { settledAt: Date.now() }),
      ...(error ? { lastError: error } : {}),
    });
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
    if (!config.ok)
      return await refuse('imagery-config', 'Satellite imagery is not configured', config.detail);

    try {
      // The masks a cut clips against are this season's bake; the sidecar's `waterMasks` is the
      // interlock `bake-masks` publishes last, and the search plan must be for that same bake.
      const sidecar = await getPublicJson<{
        season?: string;
        bodies?: number;
        waterMasks?: boolean;
      }>(config.r2, `masks/${season}.json`);
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
      const items = [...s2Selected.selected, ...s1Selected.selected].flatMap((granuleId) => {
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
      });

      const queued = await ctx.runMutation(internal.imageryLive.queueGranules, {
        items,
        cap: POLL_CAP,
      });
      await ctx.runMutation(internal.imageryLive.setWindowTo, { season, windowTo: today });
      if (queued.queued > 0) await ctx.scheduler.runAfter(0, internal.imageryLive.spawn, {});

      const counts = {
        s2Considered: s2Selected.counts.considered,
        s1Considered: s1Selected.counts.considered,
        selected: items.length,
        queued: queued.queued,
        alreadyQueued: queued.known,
        overCap: queued.overCap,
      };
      if (queued.overCap > 0) {
        await ctx.runMutation(internal.imageryLive.alertAdmins, {
          key: 'imagery-cap',
          season,
          problem: `A satellite poll hit its cap of ${POLL_CAP}`,
          detail: `${queued.overCap} more new granules were found between ${from} and ${today} than one poll may queue. They stay unqueued; the next poll (6 hours) picks up from the overlap, or raise POLL_CAP if this is a deliberate catch-up.`,
        });
        return await finish('capped', `window ${from} → ${today}`, counts);
      }
      return await finish('ok', `window ${from} → ${today}`, counts);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-poll-failed',
        season,
        problem: 'A satellite catalog poll failed',
        detail,
      });
      return await finish('failed', detail);
    }
  },
});

// ─── 2. Spawn ───────────────────────────────────────────────────────────────────────────────────

export const spawn = internalAction({
  args: {},
  handler: async (ctx): Promise<{ spawned: number; failed: number; remaining: number }> => {
    const startedAt = Date.now();
    const season = archiveSeasonAt(startedAt);
    const config = configured();
    if (!config.ok) return { spawned: 0, failed: 0, remaining: 0 };

    // ⚠ **Throttle on Machines alive, never on calls made.** A detached spawn returns in under a
    // second while its job runs for minutes — `fan-out.sh` measured 2,345 spawns under a call cap
    // pile up into thousands of live Machines and land 359 of ~1,523 frames.
    let live: number;
    try {
      live = liveCutMachines(await listMachines(config.fly));
    } catch {
      // An API error is not zero Machines: wait rather than flood.
      await ctx.scheduler.runAfter(SPAWN_RETRY_MS, internal.imageryLive.spawn, {});
      return { spawned: 0, failed: 0, remaining: -1 };
    }
    const claims = await ctx.runMutation(internal.imageryLive.claimForSpawn, {
      limit: Math.max(0, MAX_LIVE_MACHINES - live),
    });
    let spawned = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        const machineId = await createCutMachine(config.fly, {
          granuleId: claim.granuleId,
          maskSeason: season,
          attempt: claim.attempt,
        });
        await ctx.runMutation(internal.imageryLive.settleSpawn, { id: claim.id, machineId });
        spawned++;
      } catch (error) {
        await ctx.runMutation(internal.imageryLive.settleSpawn, {
          id: claim.id,
          error: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }
    const left = await ctx.runQuery(internal.imageryLive.granulesByStatus, {
      status: 'queued',
      limit: 1,
    });
    if (left.length > 0)
      await ctx.scheduler.runAfter(SPAWN_RETRY_MS, internal.imageryLive.spawn, {});
    if (spawned > 0)
      await ctx.scheduler.runAfter(RECONCILE_DELAY_MS, internal.imageryLive.reconcile, {});
    if (claims.length > 0) {
      await ctx.runMutation(internal.imageryLive.recordRun, {
        season,
        kind: 'spawn',
        startedAt,
        outcome: failed > 0 && spawned === 0 ? 'failed' : 'ok',
        counts: { live, claimed: claims.length, spawned, failed },
      });
    }
    return { spawned, failed, remaining: left.length };
  },
});

// ─── 3. Reconcile ───────────────────────────────────────────────────────────────────────────────

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const season = archiveSeasonAt(startedAt);
    const config = configured();
    if (!config.ok) return null;

    const spawned: Doc<'imageryGranules'>[] = await ctx.runQuery(
      internal.imageryLive.granulesByStatus,
      { status: 'spawned', limit: 400 },
    );
    const counts = { landed: 0, running: 0, requeued: 0, empty: 0, failed: 0 };
    const failures: string[] = [];
    for (const granule of spawned) {
      if (await publicExists(config.r2, `frames/${granule.season}/${granule.granuleId}.json`)) {
        await ctx.runMutation(internal.imageryLive.settleGranule, {
          id: granule._id,
          status: 'landed',
        });
        counts.landed++;
        continue;
      }
      let exitCode: number | null = null;
      if (granule.machineId) {
        const machine = await getMachine(config.fly, granule.machineId).catch(() => undefined);
        if (machine === undefined || (machine && LIVE_STATES.has(machine.state))) {
          counts.running++; // still cutting — or the API blinked; look again shortly
          continue;
        }
        exitCode = machine?.exitCode ?? null;
      } else if (startedAt - (granule.spawnedAt ?? 0) < LOST_CLAIM_MS) {
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

    if (counts.running > 0) {
      await ctx.scheduler.runAfter(RECONCILE_RETRY_MS, internal.imageryLive.reconcile, {});
    }
    if (counts.requeued > 0) await ctx.scheduler.runAfter(0, internal.imageryLive.spawn, {});
    if (counts.landed > 0) await ctx.scheduler.runAfter(0, internal.imageryLive.buildIndex, {});
    if (failures.length > 0) {
      await ctx.runMutation(internal.imageryLive.alertAdmins, {
        key: 'imagery-cut-failed',
        season,
        problem: `${failures.length} satellite cut${failures.length === 1 ? '' : 's'} failed twice`,
        detail: `${failures.slice(0, 10).join(', ')}${failures.length > 10 ? ', …' : ''}. Read the Machine logs with \`fly logs --app skating-imagery\` while they last.`,
      });
    }
    if (spawned.length > 0) {
      await ctx.runMutation(internal.imageryLive.recordRun, {
        season,
        kind: 'reconcile',
        startedAt,
        outcome: failures.length > 0 ? 'failed' : 'ok',
        counts,
      });
    }
    return counts;
  },
});

// ─── 4. Index ───────────────────────────────────────────────────────────────────────────────────

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

export const buildIndex = internalAction({
  args: {},
  handler: async (ctx) => {
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
  },
});

// ─── The admin page ─────────────────────────────────────────────────────────────────────────────

/** Recent runs and the granule ledger's totals, for `/admin/seasons`. */
export const activity = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'admin');
    const runs = await ctx.db.query('imageryRuns').withIndex('by_started').order('desc').take(40);
    const counts: Record<string, number> = {};
    for (const status of ['queued', 'spawned', 'landed', 'empty', 'failed'] as const) {
      counts[status] = (
        await ctx.db
          .query('imageryGranules')
          .withIndex('by_status', (q) => q.eq('status', status))
          .take(20_000)
      ).length;
    }
    const failed = await ctx.db
      .query('imageryGranules')
      .withIndex('by_status', (q) => q.eq('status', 'failed'))
      .order('desc')
      .take(10);
    return {
      runs,
      counts,
      failed: failed.map((g) => ({ granuleId: g.granuleId, lastError: g.lastError ?? null })),
      configured: configured().ok,
      pollCap: POLL_CAP,
      maxLive: MAX_LIVE_MACHINES,
    };
  },
});
