/**
 * Access alerts — "temporarily inaccessible" as a decaying community claim (N6d Workstream C / D73).
 *
 * ## Why this is not a note
 *
 * *"Road closed south of the gate until repairs are done"* is the most useful sentence on a lake page
 * and the one most certain to be wrong. It is correct the day it is written and wrong by spring, and
 * nothing in the system knows the difference — because nothing is ever asked. So a blocker is modelled
 * like a hazard: somebody asserts it, others confirm or deny, and absent either it expires on its own.
 * Freshness is enforced by the people who benefit from it, which is the only enforcement that scales.
 *
 * ## The two things this deliberately does NOT borrow from hazards
 *
 * **1. The decay.** A locked gate does not thaw. Applying D56's weather multiplier would let a warm
 * week silently expire every road closure in the corpus, and the failure would be invisible because
 * expiring is what an alert is *supposed* to do. The lifecycle math lives in `@skating/core`'s
 * `accessAlert.ts`, which imports nothing from `hazardWeatherDecay`.
 *
 * **2. The vote asymmetry.** Hazards need two votes to retire and one to confirm, because a wrong
 * "all clear" on ice can kill someone. A gate is not ice: being wrong in either direction costs a
 * wasted drive. Importing that caution here would be caution with nothing to protect.
 *
 * ## And the one thing it never does
 *
 * **An alert annotates; it never suppresses.** A blocked launch on a lake with three others must not
 * silence the lake in drive-time notifications, for the same reason a hazard never hides a body. Every
 * read here returns alerts *alongside* access points — nothing in this module filters one out.
 */

import {
  ACCESS_ALERT_TTL_MS,
  accessAlertExpiryFor,
  type AccessAlertVote,
  accessAlertIsLive,
  currentSeason,
  deriveAccessAlertLifecycle,
  isMinor,
  seasonEndMs,
  seasonOf,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
  mutation,
  query,
} from './_generated/server';
import { requireContributor, requireContributorRole } from './lib/auth';
import { ACCESS_ALERT_REASONS, ACCESS_ALERT_TARGETS, ACCESS_ALERT_VERDICTS } from './lib/enums';
import { literals } from './lib/validators';

/** Free text has to be bounded somewhere; this is a sentence about a gate, not an essay. */
export const MAX_ALERT_NOTE_LENGTH = 500;

/** Recompute one alert from its full vote set and persist the result. Returns the new row. */
async function recomputeAlert(
  ctx: MutationCtx,
  alert: Doc<'accessAlerts'>,
): Promise<Doc<'accessAlerts'>> {
  const rows = await ctx.db
    .query('accessAlertVotes')
    .withIndex('by_alert', (q) => q.eq('accessAlertId', alert._id))
    .collect();
  const votes: AccessAlertVote[] = rows.map((r) => ({
    userId: r.userId,
    verdict: r.verdict,
    observedAt: r.observedAt,
  }));
  const next = deriveAccessAlertLifecycle(alert, votes, seasonEndMs(alert.season));
  await ctx.db.patch(alert._id, {
    status: next.status,
    expiresAt: next.expiresAt,
    confirmCount: next.confirmCount,
    denyCount: next.denyCount,
    lastConfirmedAt: next.lastConfirmedAt,
  });
  return (await ctx.db.get(alert._id)) as Doc<'accessAlerts'>;
}

/**
 * Post an access alert on a put-in or a parking area.
 *
 * Rides **D57's existing posting permission** rather than inventing one — the same call D88 made for
 * access photos, and for the same reason: a permission that is always equal to another permission is
 * one that will drift out of sync and confuse somebody in a year. Minors are read-only (Phase 3).
 */
export const create = mutation({
  args: {
    targetType: literals(ACCESS_ALERT_TARGETS),
    putInId: v.optional(v.id('putIns')),
    parkingAreaId: v.optional(v.id('parkingAreas')),
    reason: literals(ACCESS_ALERT_REASONS),
    note: v.optional(v.string()),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post access alerts');
    }

    // Resolve the target and, with it, the body. `waterBodyId` is denormalized onto the row so the
    // per-lake read is one index range rather than a fan-out over every access point on the body.
    let waterBodyId: Id<'waterBodies'>;
    if (args.targetType === 'put_in') {
      if (!args.putInId) throw new ConvexError('A put-in is required');
      const putIn = await ctx.db.get(args.putInId);
      if (!putIn || putIn.status !== 'visible') throw new ConvexError('Put-in not found');
      waterBodyId = putIn.waterBodyId;
    } else {
      if (!args.parkingAreaId) throw new ConvexError('A parking area is required');
      const lot = await ctx.db.get(args.parkingAreaId);
      if (!lot || lot.status !== 'visible') throw new ConvexError('Parking area not found');
      // A lot can serve several bodies (D72 amendment). The alert is about the *lot*, so it is filed
      // against one body for the read path and shown on every body the lot serves — picking the
      // first association rather than fanning out a row per body, which would make one locked gate
      // look like three.
      const link = await ctx.db
        .query('parkingAreaBodies')
        .withIndex('by_parking_area', (q) => q.eq('parkingAreaId', args.parkingAreaId as Id<'parkingAreas'>))
        .first();
      if (!link) throw new ConvexError('This parking area is not associated with any water body');
      waterBodyId = link.waterBodyId;
    }

    const note = args.note?.trim().slice(0, MAX_ALERT_NOTE_LENGTH) || undefined;
    // Clamped rather than trusted: a future timestamp is device skew, or a client trying to freeze an
    // alert as permanently fresh.
    const at = Math.min(args.observedAt ?? now, now);
    const season = seasonOf(at);

    return ctx.db.insert('accessAlerts', {
      targetType: args.targetType,
      putInId: args.putInId,
      parkingAreaId: args.parkingAreaId,
      waterBodyId,
      reason: args.reason,
      note,
      createdByUserId: profile._id,
      createdAt: at,
      season,
      expiresAt: accessAlertExpiryFor(at, seasonEndMs(season)),
      status: 'active',
      confirmCount: 0,
      denyCount: 0,
    });
  },
});

/**
 * "Still blocked" / "it's open" — the confirm-deny half, reusing Phase 9's shape.
 *
 * **One vote row per user per alert**, so a queued confirmation replayed on flush updates the same row
 * and re-derives the same counts. A lost ack can never double-count toward resolution, which is the
 * offline-path twin of the same-account abuse the distinct-user derivation prevents.
 */
export const vote = mutation({
  args: {
    accessAlertId: v.id('accessAlerts'),
    verdict: literals(ACCESS_ALERT_VERDICTS),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, { accessAlertId, verdict, observedAt }) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot vote on access alerts');
    }
    const alert = await ctx.db.get(accessAlertId);
    if (!alert) throw new ConvexError('Access alert not found');
    if (alert.status === 'retracted' || alert.status === 'hidden') {
      throw new ConvexError('This alert is no longer open to votes');
    }

    const at = Math.min(observedAt ?? now, now);
    const existing = await ctx.db
      .query('accessAlertVotes')
      .withIndex('by_alert_user', (q) =>
        q.eq('accessAlertId', accessAlertId).eq('userId', profile._id),
      )
      .unique();
    if (existing) {
      // `observedAt` stays monotonic so a late-arriving offline replay cannot drag an observation
      // backward — the same rule `hazardConfirmations` applies to `createdAt`.
      await ctx.db.patch(existing._id, { verdict, observedAt: Math.max(existing.observedAt, at) });
    } else {
      await ctx.db.insert('accessAlertVotes', {
        accessAlertId,
        userId: profile._id,
        verdict,
        observedAt: at,
        createdAt: now,
      });
    }

    return recomputeAlert(ctx, alert);
  },
});

/**
 * "This never existed" — D65's verdict, applied to access.
 *
 * Distinct from letting it expire, and the distinction is the point: **expiry says the claim stopped
 * being true; retraction says it never was.** A skater who drops an alert on the wrong lot should be
 * able to take it back rather than watch a wrong claim decay over thirty days, and N5b made exactly
 * that argument for hazards.
 *
 * The author may retract their own; a moderator may retract anyone's. Never a delete — the row is the
 * record that something was claimed and withdrawn, which is what makes a pattern of bad claims
 * visible.
 */
export const retract = mutation({
  args: { accessAlertId: v.id('accessAlerts'), reason: v.optional(v.string()) },
  handler: async (ctx, { accessAlertId, reason }) => {
    const profile = await requireContributor(ctx);
    const alert = await ctx.db.get(accessAlertId);
    if (!alert) throw new ConvexError('Access alert not found');

    const isAuthor = alert.createdByUserId === profile._id;
    const isModerator = profile.role === 'moderator' || profile.role === 'admin';
    if (!isAuthor && !isModerator) {
      throw new ConvexError('Only the author or a moderator can retract an alert');
    }

    await ctx.db.patch(accessAlertId, {
      status: 'retracted',
      retractedByUserId: profile._id,
      expiresAt: undefined,
    });

    if (isModerator && !isAuthor) {
      await ctx.db.insert('moderationActions', {
        actorId: profile._id,
        action: 'retract_access_alert',
        targetType: 'accessAlert',
        targetId: accessAlertId,
        reason: reason ?? 'Retracted an access alert',
        metadata: { waterBodyId: alert.waterBodyId, alertReason: alert.reason },
        createdAt: Date.now(),
      });
    }
  },
});

/**
 * Moderator: pin an alert as `official`, or release it.
 *
 * **A pinned alert never expires** (founder call, 2026-08-10) — not on the TTL and not at the season
 * boundary. It is the analogue of an `official` put-in: a named claim with an audit row behind it,
 * which is a different kind of thing from a passer-by's observation and outranks the community
 * lifecycle rather than participating in it.
 *
 * That exemption is also why `official` is a status rather than a flag: it keeps pinned rows out of
 * the expiry sweep's index range entirely, so their survival does not depend on the sweep remembering
 * to skip them.
 */
export const setOfficial = mutation({
  args: { accessAlertId: v.id('accessAlerts'), official: v.boolean(), reason: v.string() },
  handler: async (ctx, { accessAlertId, official, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const alert = await ctx.db.get(accessAlertId);
    if (!alert) throw new ConvexError('Access alert not found');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');

    if (official) {
      await ctx.db.patch(accessAlertId, {
        status: 'official',
        pinnedByUserId: actor._id,
        expiresAt: undefined,
      });
    } else {
      // Released back into the community lifecycle, with the clock restarted from now rather than
      // from the original assertion — an alert a moderator vouched for until today is not
      // simultaneously thirty days stale.
      const now = Date.now();
      await ctx.db.patch(accessAlertId, {
        status: 'active',
        pinnedByUserId: undefined,
        expiresAt: accessAlertExpiryFor(now, seasonEndMs(alert.season)),
      });
    }

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: official ? 'pin_access_alert' : 'unpin_access_alert',
      targetType: 'accessAlert',
      targetId: accessAlertId,
      reason,
      metadata: { waterBodyId: alert.waterBodyId, alertReason: alert.reason },
      createdAt: Date.now(),
    });
  },
});

/** An alert as a client renders it, with the target resolved to something nameable. */
export interface AccessAlertView {
  id: Id<'accessAlerts'>;
  targetType: 'put_in' | 'parking_area';
  putInId?: Id<'putIns'>;
  parkingAreaId?: Id<'parkingAreas'>;
  reason: string;
  note?: string;
  status: string;
  official: boolean;
  createdAt: number;
  lastConfirmedAt?: number;
  expiresAt?: number;
  confirmCount: number;
  denyCount: number;
}

function toView(alert: Doc<'accessAlerts'>): AccessAlertView {
  return {
    id: alert._id,
    targetType: alert.targetType,
    putInId: alert.putInId,
    parkingAreaId: alert.parkingAreaId,
    reason: alert.reason,
    note: alert.note,
    status: alert.status,
    official: alert.status === 'official',
    createdAt: alert.createdAt,
    lastConfirmedAt: alert.lastConfirmedAt,
    expiresAt: alert.expiresAt,
    confirmCount: alert.confirmCount,
    denyCount: alert.denyCount,
  };
}

/**
 * Every live alert annotating an access point on this body.
 *
 * Liveness is re-checked here and not left to the sweep, because **the cron's schedule must never be a
 * visible behaviour**: a row whose expiry passed an hour ago stops annotating the moment it passes,
 * not the moment a job next runs.
 */
export async function loadLiveAlertsForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  now: number = Date.now(),
): Promise<AccessAlertView[]> {
  const rows = await ctx.db
    .query('accessAlerts')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  return rows
    .filter((r) => accessAlertIsLive(r, now))
    .sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'official' ? -1 : 1))
    .map(toView);
}

/** Public: live access alerts for a body. Returns `[]` for an unknown body. */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<AccessAlertView[]> => {
    const body = await ctx.db.get(waterBodyId);
    if (!body) return [];
    return loadLiveAlertsForBody(ctx, waterBodyId);
  },
});

/**
 * Expire lapsed alerts (cron).
 *
 * The range is `eq('status', 'active').lte('expiresAt', now)` — and the equality prefix is doing real
 * work, not decoration. Convex indexes on optional fields **are not sparse**, so an absent `expiresAt`
 * sorts *first*: a bare `lte(now)` over the whole table would sweep every `official` pin, which is
 * precisely the set exempt from expiry. Leading with `status` puts them in a different prefix, so the
 * range cannot reach them at all.
 *
 * The season boundary needs no separate job: `accessAlertExpiryFor` already clamps every write to
 * `min(TTL, season end)`, so a season rollover is just a batch of alerts whose expiry has passed.
 */
export const expireLapsedAlerts = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const due = await ctx.db
      .query('accessAlerts')
      .withIndex('by_status_expires_at', (q) => q.eq('status', 'active').lte('expiresAt', now))
      .take(limit ?? 200);

    let expired = 0;
    let seasonExpired = 0;
    const season = currentSeason(now);
    for (const alert of due) {
      await ctx.db.patch(alert._id, { status: 'expired' });
      expired++;
      // Counted apart because they mean different things operationally: a TTL expiry is one alert
      // nobody re-confirmed, and a wave of season expiries is the map being deliberately cleared.
      if (alert.season < season) seasonExpired++;
    }
    return { expired, seasonExpired, ttlMs: ACCESS_ALERT_TTL_MS };
  },
});
