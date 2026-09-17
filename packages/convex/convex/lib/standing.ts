/**
 * Standing transitions (A07b) — **the one way a body becomes active or dormant.**
 *
 * `standingOf` (`@skating/core`) is derived from four fields, and three of them have their own
 * mutations already (`remove` / `restore`, `setPublicAccess`, the review triad). What this module
 * owns is everything that has to move *together* when standing changes, whichever field moved it:
 *
 *  1. the re-score — `minVisibleZoom` is `DORMANT_MIN_VISIBLE_ZOOM` for anything not active, and
 *     the browsable bucket (with richness, since this is one body under one transition) otherwise;
 *  2. the cell rows — the rung is part of `by_cell`'s range, so a stale copy shows or hides the
 *     body at the wrong zoom (A01);
 *  3. the sub-areas — a bay is reachable only while its lake is active (Decision 11, extended);
 *  4. the weather registry — an active body occupies a cell the daily sweep pays Open-Meteo for,
 *     a dormant one does not (the founder's "trimming the corpus should save us on crons");
 *  5. the audit row — a corpus that changes shape without a row saying so is one nobody can check.
 *
 * Every caller — the evidence hooks in `reports` / `gpsActivities` / `putIns`, the season cron, the
 * prunes, the seed, the moderator mutation, `remove` / `restore`, `setPublicAccess` — comes through
 * `transitionStanding`, directly or via `activateBody` / `demoteBody`. Nothing else writes `dormant`
 * or `activatedAt`, and nothing else decides what a standing change costs.
 */

import {
  type DormancyReason,
  isActive,
  isReachable,
  reactivatesOnEvidence,
  standingOf,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { syncCellsForParent } from '../subAreas';
import { syncWaterBodyCells } from './cellIndex';
import { isListed } from './listing';
import { bodyWeatherCell } from './sampling';
import { richnessFor, scoreFields } from './scoring';

/**
 * What brought a body back. Recorded on the audit row so the standing page can show *why* a lake
 * re-appeared, and so a moderator reading "activated by a track" can go and look at the track.
 */
export type ActivationEvidence =
  | 'report'
  | 'track'
  | 'hazard'
  | 'put_in'
  | 'access_confirmed'
  | 'restore'
  | 'moderator'
  | 'request'
  | 'seed';

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The most recent evidence that someone was on this water: the latest report's skate end, the
 * latest matched track's end, the latest hazard's first sighting. Three index reads, each `first()`
 * on a descending time key, so the cost is constant per body — which is what lets the season cron
 * ask it of every active body.
 *
 * Deliberately **not** favourites (intent, not presence — and they retain through `retainsActive`
 * separately), not bounties (a request to go, not a going), not comments.
 */
export async function lastActivityAt(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<number | undefined> {
  const report = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
    .order('desc')
    .first();
  // `by_water_body` orders by ingest, not by skate — an old track pushed from a watch last week
  // would sort first. There is no end-time index, so read the newest few by ingest and take the
  // latest *skate* among them: a body with more than this many tracks in the window is retained
  // by any one of them.
  const tracks = await ctx.db
    .query('gpsActivities')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .order('desc')
    .take(RECENT_TRACKS_READ);
  const hazard = await ctx.db
    .query('hazards')
    .withIndex('by_water_body_first_reported', (q) => q.eq('waterBodyId', waterBodyId))
    .order('desc')
    .first();
  const candidates = [
    report?.skateEndTime,
    ...tracks.map((t) => t.endTime),
    hazard?.firstReportedAt,
  ].filter((t): t is number => t !== undefined);
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/** Tracks read per body by `lastActivityAt` — a read bound, not a claim about the world. */
const RECENT_TRACKS_READ = 25;

/** Has anyone at all favourited this body? One index probe. */
export async function anyFavorite(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<boolean> {
  const row = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  return row !== null;
}

// ── The shared write ───────────────────────────────────────────────────────────────────────────

/**
 * Apply a standing-bearing patch and move everything that depends on standing with it — **the one
 * write every transition goes through**, whichever field carried it.
 *
 * Returns the row as it now stands and which way it crossed, so a caller can keep going without a
 * re-read and can write its own audit row when it has a more specific one (`remove`,
 * `setPublicAccess`). With `audit` left on, a crossing writes `activate_body` / `demote_body`.
 *
 * The richness read is paid here on purpose — this is one body under one transition, not the
 * import (see `richnessFor` for why the bulk paths omit it), and re-scoring a body that just came
 * back *without* the reports that brought it back would land it a rung lower than it has earned.
 *
 * `activatedAt` is stamped by this function and nowhere else, on the crossing into active — so it
 * is right for a restore, a cleared ruling, an admitted request and an evidence hook alike.
 */
export async function transitionStanding(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  patch: Partial<Doc<'waterBodies'>>,
  opts: {
    via?: ActivationEvidence;
    actorId?: Id<'profiles'>;
    reason?: string;
    /** `false` when the caller writes a more specific audit row of its own. Default `true`. */
    audit?: boolean;
    now?: number;
  } = {},
): Promise<{ body: Doc<'waterBodies'>; became: 'active' | 'inactive' | null }> {
  const now = opts.now ?? Date.now();
  const before = isActive(body);
  const after = isActive({ ...body, ...patch });
  const became = before === after ? null : after ? 'active' : 'inactive';
  const full: Partial<Doc<'waterBodies'>> = {
    ...patch,
    ...(became === 'active' ? { activatedAt: now } : {}),
  };

  const next: Doc<'waterBodies'> = { ...body, ...full };
  const scores = scoreFields({
    richness: await richnessFor(ctx, next),
    surfaceAreaSqM: next.surfaceAreaSqM,
    curatedBoost: next.curatedBoost,
    active: after,
  });
  await ctx.db.patch(body._id, { ...full, ...scores });
  await syncWaterBodyCells(ctx, body._id, {
    bbox: next.bbox,
    minVisibleZoom: scores.minVisibleZoom,
    listed: isListed(next),
  });
  // A bay is reachable only while its lake is active — see `subAreaListed`.
  await syncCellsForParent(ctx, body._id, next);

  if (became === 'active') await registerWeatherMembership(ctx, next, now);
  if (became === 'inactive') await dropWeatherMembership(ctx, body._id);

  if (became !== null && opts.audit !== false) {
    await ctx.db.insert('moderationActions', {
      ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
      action: became === 'active' ? 'activate_body' : opts.actorId ? 'set_standing' : 'demote_body',
      targetType: 'waterbody',
      targetId: body._id,
      reason:
        opts.reason ??
        (became === 'active'
          ? describeActivation(opts.via ?? 'moderator')
          : describeDemotion(next.dormant?.reason ?? 'moderator')),
      metadata: {
        ...(opts.via !== undefined ? { via: opts.via } : {}),
        prev: standingOf(body),
        next: standingOf(next),
      },
      createdAt: now,
    });
  }
  return { body: { ...next, ...scores }, became };
}

// ── Transitions ────────────────────────────────────────────────────────────────────────────────

/**
 * Make a body active.
 *
 * `extraPatch` is for the callers whose own field is what changes the standing — `restore` clears
 * `removedAt`, `setPublicAccess` writes an `open` verdict — so that the field, the `dormant` clear,
 * the re-score and the cells land in one write. Returns whether the body is active afterwards; it
 * may not be, if a stronger standing (a `none` ruling under a restore) still holds.
 *
 * **Coming back from `not_in_campaign` sets `includedByRequest`.** The prune demoted it because the
 * admission rules refuse it; evidence that somebody skates it is exactly A07b's override, and
 * without the flag the next campaign would demote it straight back.
 */
export async function activateBody(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  opts: {
    via: ActivationEvidence;
    actorId?: Id<'profiles'>;
    reason?: string;
    extraPatch?: Partial<Doc<'waterBodies'>>;
    audit?: boolean;
    now?: number;
  },
): Promise<boolean> {
  if (!isReachable(body)) {
    throw new Error(`activateBody: ${body._id} is unlisted (rejected or merged)`);
  }
  const wasNotInCampaign = body.dormant?.reason === 'not_in_campaign';
  const { body: next } = await transitionStanding(
    ctx,
    body,
    {
      ...(opts.extraPatch ?? {}),
      dormant: undefined,
      ...(wasNotInCampaign ? { includedByRequest: true } : {}),
    },
    opts,
  );
  return isActive(next);
}

/**
 * Make an active body dormant on this module's own field.
 *
 * Refuses nothing about the reason — the cron passes `inactive`, the prunes `not_in_campaign`, a
 * moderator `moderator` with a note — but does nothing to a body that is already not active: a
 * removed or `none` body has a stronger standing already, and stacking a dormancy under it would
 * only have to be cleared later. Returns whether anything changed.
 */
export async function demoteBody(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  dormancy: { reason: DormancyReason; byUserId?: Id<'profiles'>; note?: string },
  opts: { actorId?: Id<'profiles'>; reason?: string; now?: number } = {},
): Promise<boolean> {
  if (!isActive(body)) return false;
  const now = opts.now ?? Date.now();
  const { became } = await transitionStanding(
    ctx,
    body,
    {
      dormant: {
        since: now,
        reason: dormancy.reason,
        ...(dormancy.byUserId !== undefined ? { byUserId: dormancy.byUserId } : {}),
        ...(dormancy.note !== undefined ? { note: dormancy.note } : {}),
      },
    },
    { ...opts, now },
  );
  return became === 'inactive';
}

/**
 * The evidence hook — **a report, a track, a hazard or a put-in on a dormant body brings it back.**
 *
 * Gated on `reactivatesOnEvidence`: only the machine-written dormancies (`inactive`,
 * `not_in_campaign`) yield to evidence. A moderator's dormancy, a `none` ruling and a removal are
 * decisions, and the resident of a private lake skating it is not evidence the public may — their
 * report attaches, the ruling stands. Returns whether the body was activated.
 *
 * Called *after* the evidence row is written, so the re-score's richness read sees it.
 */
export async function activateOnEvidence(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  via: Exclude<ActivationEvidence, 'restore' | 'moderator' | 'request' | 'seed'>,
): Promise<boolean> {
  const body = await ctx.db.get(waterBodyId);
  if (!body || !reactivatesOnEvidence(body)) return false;
  return activateBody(ctx, body, { via });
}

// ── The weather registry ───────────────────────────────────────────────────────────────────────

/**
 * Put an activated body into the weather cell registry now, rather than waiting up to a week for
 * `maybeSyncWeatherCells` to notice it.
 *
 * Stamped with the tier's current claim so the next completed walk's prune (`pruneVacatedCells`,
 * `pruneVacatedMemberships`) keeps it — a row with a foreign run id is exactly what those delete.
 * When no walk has ever claimed the tier the registry is empty and the sweep self-heals, so the
 * stamp is a placeholder the first walk replaces.
 */
export async function registerWeatherMembership(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  nowMs: number,
): Promise<void> {
  for (const tier of ['browse', 'filter'] as const) {
    const claim = await ctx.db
      .query('weatherCellSyncs')
      .withIndex('by_tier', (q) => q.eq('tier', tier))
      .unique();
    const runId = claim?.runId ?? 'activation';
    const cell = bodyWeatherCell(body, tier);
    const existing = await ctx.db
      .query('weatherCells')
      .withIndex('by_key', (q) => q.eq('cellKey', cell.key))
      .first();
    if (existing) {
      // Re-stamped with the current claim: a walk in flight that has already passed this cell
      // would otherwise prune it as vacated at the end, membership and all (review, PR #61).
      if (existing.runId !== runId) {
        await ctx.db.patch(existing._id, { runId, updatedAt: nowMs });
      }
    } else {
      await ctx.db.insert('weatherCells', {
        cellKey: cell.key,
        tier,
        lat: cell.lat,
        lng: cell.lng,
        ...(cell.elevationM !== undefined ? { elevationM: cell.elevationM } : {}),
        bodyCount: 1,
        runId,
        updatedAt: nowMs,
      });
    }
    if (tier === 'filter') {
      const member = await ctx.db
        .query('bodyWeatherCells')
        .withIndex('by_body', (q) => q.eq('waterBodyId', body._id).eq('subAreaId', undefined))
        .first();
      if (member) {
        await ctx.db.patch(member._id, { cellKey: cell.key, runId, updatedAt: nowMs });
      } else {
        await ctx.db.insert('bodyWeatherCells', {
          cellKey: cell.key,
          waterBodyId: body._id,
          isBay: false,
          runId,
          updatedAt: nowMs,
        });
      }
    }
  }
}

/**
 * Take a demoted body out of weather discovery now. The cell itself stays registered until the next
 * walk finds it empty — one week of Open-Meteo for a vacated cell is the price of not re-deriving
 * `bodyCount` here.
 */
async function dropWeatherMembership(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<void> {
  const rows = await ctx.db
    .query('bodyWeatherCells')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

// ── Copy for the audit log ─────────────────────────────────────────────────────────────────────

function describeActivation(via: ActivationEvidence): string {
  switch (via) {
    case 'report':
      return 'Activated — a report was posted here';
    case 'track':
      return 'Activated — a recorded skate resolved to this body';
    case 'hazard':
      return 'Activated — a hazard was marked here';
    case 'put_in':
      return 'Activated — a put-in was placed on this body';
    case 'access_confirmed':
      return 'Activated — a moderator confirmed public access';
    case 'restore':
      return 'Activated — restored to the map';
    case 'moderator':
      return 'Activated by a moderator';
    case 'request':
      return 'Activated — a request was admitted';
    case 'seed':
      return 'Activated by the standing seed';
  }
}

function describeDemotion(reason: DormancyReason): string {
  switch (reason) {
    case 'inactive':
      return 'Set dormant — no activity in the retention window';
    case 'not_in_campaign':
      return 'Set dormant — the campaign no longer admits it';
    case 'moderator':
      return 'Set dormant by a moderator';
  }
}
