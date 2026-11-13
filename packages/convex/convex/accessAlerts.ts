/**
 * Access alerts — "temporarily inaccessible" as a decaying community claim (A06d Workstream 3 / D73).
 *
 * ## Why this is not a note
 *
 * *"Road closed south of the gate until repairs are done"* is the most useful sentence on a lake page
 * and the one most certain to be wrong. It is correct the day it is written and wrong by spring, and
 * nothing in the system knows the difference — because nothing is ever asked. So a blocker is modeled
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
 *
 * ## How long a withdrawn claim is kept
 *
 * **An alert its author retracted is kept 30 days, then erased** (D248; founder call 2026-11-13:
 * "follow the 30-day pattern"), and longer only while something holds it: an open flag on it, or a
 * moderator's verdict — a retraction recorded on the withdrawn alert, kept as evidence of a pattern of
 * bad claims, until a moderator overturns it. A moderator's own retraction of someone else's live
 * alert is their decision on the claim, not the author's withdrawal: that row stays.
 */

import {
  ACCESS_ALERT_TTL_MS,
  type AccessAlertKind,
  type AccessAlertVote,
  accessAlertExpiryFor,
  accessAlertIsLive,
  accessAlertKindOf,
  alertRetractionByAuthor,
  currentSeason,
  deriveAccessAlertLifecycle,
  isMinor,
  RETRACT_REFUSALS,
  seasonEndMs,
  seasonOf,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { MAX_ACCESS_ROWS_PER_BODY, MAX_LOT_LINKS_SCANNED } from './lib/accessLimits';
import { writeAudit } from './lib/audit';
import { getCurrentProfile, requireCapability, requireContributor } from './lib/auth';
import { recordVerdict } from './lib/contentVerdicts';
import {
  ACCESS_ALERT_KINDS,
  ACCESS_ALERT_TARGETS,
  ACCESS_ALERT_VERDICTS,
  ACCESS_REASONS,
} from './lib/enums';
import { refreshEraseClock, withdrawnAtOf } from './lib/eraseClock';
import { literals } from './lib/validators';

/** Free text has to be bounded somewhere; this is a sentence about a gate, not an essay. */
export const MAX_ALERT_NOTE_LENGTH = 500;

/**
 * Recompute one alert from its full vote set and persist the result. Returns the new row.
 * `authorsWordCounts: false` derives it as if no one had posted it, so the author's standing "it's
 * open" does not settle it (see `vote`).
 */
async function recomputeAlert(
  ctx: MutationCtx,
  alert: Doc<'accessAlerts'>,
  authorsWordCounts = true,
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
  const { createdByUserId: _, ...anonymous } = alert;
  const next = deriveAccessAlertLifecycle(
    authorsWordCounts ? alert : anonymous,
    votes,
    seasonEndMs(alert.season),
  );
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
 * Post an access alert on a put-in or a parking area — a blocker from the access layer, or a
 * condition from the report sheet (A10 / D197): the same row, so a plank and a locked gate decay
 * and corroborate the same way, and only `blockedIds` tells them apart.
 *
 * Rides **D57's existing posting permission** rather than inventing one — the same call D88 made for
 * access photos, and for the same reason: a permission that is always equal to another permission is
 * one that will drift out of sync and confuse somebody in a year. Minors are read-only (Phase 03).
 */
export const create = mutation({
  args: {
    targetType: literals(ACCESS_ALERT_TARGETS),
    putInId: v.optional(v.id('putIns')),
    parkingAreaId: v.optional(v.id('parkingAreas')),
    reason: literals(ACCESS_REASONS),
    note: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    /** The author's own Report this was filed from (A10 §7.2) — provenance the reader can see. */
    reportId: v.optional(v.id('reports')),
    /** The offline queue's dedup key (A10 §9.1): a replayed flush returns the same row. */
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();

    // A replayed flush returns the row it already filed (the `reports.create` rule, D30): a claim
    // that corroborates itself is exactly the shape the vote counts exist to prevent. Author-scoped.
    if (args.idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query('accessAlerts')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
        .unique();
      if (existing) {
        if (existing.createdByUserId !== profile._id)
          throw new ConvexError('Idempotency key conflict');
        return existing._id;
      }
    }

    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post access alerts');
    }

    // Provenance is the author's own Report, on the body the alert is about (checked below once the
    // target resolves) — never someone else's skate lent to a claim.
    const report = args.reportId !== undefined ? await ctx.db.get(args.reportId) : null;
    if (args.reportId !== undefined && report?.authorId !== profile._id) {
      throw new ConvexError('Not your report');
    }

    // ⚠ **The off-target id is refused, not ignored** (PR #43 review, security).
    //
    // `targetType` selects which id is *validated*, and persisting the other one unchecked is the
    // whole exploit: an alert filed as `put_in` against a launch you can see, carrying the
    // `parkingAreaId` of a lot on a lake you have never been to, is reachable from that lake through
    // `loadLiveAlertsForBody`'s independent by-parking-area range. A contributor could publish
    // "gate locked" on any lake in the corpus, attributed to nothing that lake can name.
    //
    // Refused rather than silently dropped, because a client sending both is confused about what it
    // is claiming and should hear so. The insert below then writes **only** the field `targetType`
    // names, so the row cannot contradict itself even if this check is ever loosened.
    if (args.targetType === 'put_in' && args.parkingAreaId !== undefined) {
      throw new ConvexError('A put-in alert cannot also name a parking area');
    }
    if (args.targetType === 'parking_area' && args.putInId !== undefined) {
      throw new ConvexError('A parking-area alert cannot also name a put-in');
    }

    // Resolve the target and, with it, the body. `waterBodyId` is denormalized onto the row so the
    // per-lake read is one index range rather than a fan-out over every access point on the body.
    let waterBodyId: Id<'waterBodies'>;
    if (args.targetType === 'put_in') {
      if (!args.putInId) throw new ConvexError('A put-in is required');
      const putIn = await ctx.db.get(args.putInId);
      if (putIn?.status !== 'visible') throw new ConvexError('Put-in not found');
      waterBodyId = putIn.waterBodyId;
    } else {
      if (!args.parkingAreaId) throw new ConvexError('A parking area is required');
      const lot = await ctx.db.get(args.parkingAreaId);
      if (lot?.status !== 'visible') throw new ConvexError('Parking area not found');
      // A lot can serve several bodies (D72 amendment). The alert is about the *lot*, so it is filed
      // against one body for the read path and shown on every body the lot serves — picking the
      // first association rather than fanning out a row per body, which would make one locked gate
      // look like three.
      const link = await ctx.db
        .query('parkingAreaBodies')
        .withIndex('by_parking_area', (q) =>
          q.eq('parkingAreaId', args.parkingAreaId as Id<'parkingAreas'>),
        )
        .first();
      if (!link) throw new ConvexError('This parking area is not associated with any water body');
      waterBodyId = link.waterBodyId;
    }

    if (report && report.waterBodyId !== waterBodyId) {
      throw new ConvexError('That report is about another water body');
    }

    const note = args.note?.trim().slice(0, MAX_ALERT_NOTE_LENGTH) || undefined;
    // Clamped rather than trusted: a future timestamp is device skew, or a client trying to freeze an
    // alert as permanently fresh.
    const at = Math.min(args.observedAt ?? now, now);
    const season = seasonOf(at);

    return ctx.db.insert('accessAlerts', {
      targetType: args.targetType,
      // Only the field `targetType` names — the row is incapable of carrying a second target.
      ...(args.targetType === 'put_in'
        ? { putInId: args.putInId }
        : { parkingAreaId: args.parkingAreaId }),
      waterBodyId,
      reason: args.reason,
      kind: accessAlertKindOf(args.reason),
      note,
      createdByUserId: profile._id,
      ...(report ? { reportId: report._id } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
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
 * "Still blocked" / "it's open" — the confirm-deny half, reusing Phase 09a's shape.
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
    if (alert.status === 'retracted') {
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

    // On a pinned alert the author's word counts only when it is the author voting now: an "it's
    // open" they said before a moderator pinned it — or pinned it again after they released it — is
    // not a word about that pin, and must not release it the next time anyone else votes.
    const authorsTurn = alert.status !== 'official' || alert.createdByUserId === profile._id;
    const next = await recomputeAlert(ctx, alert, authorsTurn);
    // The author's own "it's open" releases a moderator's pin (founder ruling, 2026-11-13): the
    // reporter saw it plowed. The release is on the record, so the moderator who pinned it sees it
    // and can pin it again if it still stands.
    if (alert.status === 'official' && next.status === 'resolved') {
      await ctx.db.patch(accessAlertId, { pinnedByUserId: undefined });
      await writeAudit(ctx, {
        actorId: profile._id,
        action: 'author_resolve_access_alert',
        targetType: 'accessAlert',
        targetId: accessAlertId,
        reason: 'The person who reported it marked it open again',
        metadata: {
          waterBodyId: alert.waterBodyId,
          alertReason: alert.reason,
          prev: { status: alert.status, pinnedByUserId: alert.pinnedByUserId ?? null },
        },
        createdAt: now,
      });
      return (await ctx.db.get(accessAlertId)) as Doc<'accessAlerts'>;
    }
    return next;
  },
});

/** How far back an alert's history is read for a pin. An alert carries a handful of rows. */
const PIN_HISTORY_LIMIT = 200;

/**
 * Whether a moderator ever pinned this alert, and the pin was not undone (an undo is "I didn't mean
 * to"). Read from the history, newest first and bounded; a history longer than the bound counts as
 * pinned — refusing a retraction keeps a claim up, and its author can still mark it open.
 */
async function everPinned(ctx: QueryCtx, accessAlertId: Id<'accessAlerts'>): Promise<boolean> {
  const rows = await ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', 'accessAlert').eq('targetId', accessAlertId))
    .order('desc')
    .take(PIN_HISTORY_LIMIT);
  const undone = new Set(rows.flatMap((r) => (r.undoesActionId ? [r.undoesActionId] : [])));
  if (rows.some((r) => r.action === 'pin_access_alert' && !undone.has(r._id))) return true;
  return rows.length >= PIN_HISTORY_LIMIT;
}

/**
 * "This never existed" — D65's verdict, applied to access.
 *
 * Distinct from letting it expire, and the distinction is the point: **expiry says the claim stopped
 * being true; retraction says it never was.** A skater who drops an alert on the wrong lot should be
 * able to take it back rather than watch a wrong claim decay over thirty days, and A05b made exactly
 * that argument for hazards.
 *
 * The author may retract their own; a moderator may retract anyone's. Never a delete at the time —
 * the row is the record that something was claimed and withdrawn. **An author's retraction is kept 30
 * days, then erased** (D248), and longer only while held: an open flag on it, or a moderator's
 * retraction recorded on the withdrawn alert (below), which keeps it as evidence of a pattern of bad
 * claims until a moderator overturns it. A moderator's retraction of a live alert is kept.
 *
 * **The author's retraction is a withdrawal until the claim is acted on** (D248): only a live
 * community claim (`active`). A moderator's pin is the claim acted on, so it is refused after one; a
 * resolved, expired or already retracted alert has nothing left to retract. "It's over" is a
 * different statement from "it never was", and that one is always the author's: their own `open`
 * vote resolves the alert, pinned or not. A moderator's own retraction is a moderator's verdict and
 * is unchanged. The author's retraction is final and starts the 30-day erasure clock; a retracted
 * alert reads exactly as before — it leaves every live read, and nothing says the way is clear.
 * A moderator retracting an alert its author already retracted, with a reason, records a verdict on
 * it instead of moving it (`contentVerdicts`, kind `retracted`): the row stays as its author left it.
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
    if (alert.status === 'retracted') {
      // A moderator's word on an alert its author already retracted is a verdict kept as evidence —
      // a pattern of bad claims — and it holds the alert from erasure until a moderator overturns it
      // (founder call, 2026-11-13). The row stays exactly as its author left it: a second retraction
      // must never turn the author's final withdrawal into a moderator's (and so a pinnable) one.
      // A verdict takes a reason, as every verdict does: a bare retract (the lake page's button,
      // which sends none) that lands just after the author's own is not a decision about them.
      const verdictReason = reason?.trim() ?? '';
      const authorWithdrew = withdrawnAtOf('accessAlert', alert) !== undefined;
      if (isModerator && !isAuthor && authorWithdrew && verdictReason.length > 0) {
        const now = Date.now();
        const actionId = await writeAudit(ctx, {
          actorId: profile._id,
          action: 'retract_access_alert',
          targetType: 'accessAlert',
          targetId: accessAlertId,
          reason: verdictReason,
          metadata: {
            waterBodyId: alert.waterBodyId,
            alertReason: alert.reason,
            onAuthorWithdrawn: true,
          },
          createdAt: now,
        });
        await recordVerdict(ctx, {
          subjectUserId: alert.createdByUserId,
          targetType: 'accessAlert',
          targetId: accessAlertId,
          actionId,
          kind: 'retracted',
          at: now,
        });
      }
      // Anything else: nothing left to retract.
      return;
    }
    // On their own alert a moderator is its author, and takes back what they posted by the author's
    // rule — a pin someone else made of it is a shared record (D248) — so the clock and the record
    // never disagree about whose withdrawal it was.
    if (isAuthor) {
      // The history is read only where it can change the answer: a live community claim.
      const pinnedOnce = alert.status === 'active' && (await everPinned(ctx, alert._id));
      const rule = alertRetractionByAuthor(alert.status, pinnedOnce);
      if (rule === 'already') return;
      if (rule !== 'retract') throw new ConvexError(RETRACT_REFUSALS[rule]);
    }

    const now = Date.now();
    await ctx.db.patch(accessAlertId, {
      status: 'retracted',
      retractedByUserId: profile._id,
      retractedAt: now,
      expiresAt: undefined,
    });
    // Only an author's own retraction is a withdrawal with a clock (`lib/eraseClock`).
    await refreshEraseClock(ctx, 'accessAlert', accessAlertId, now);

    if (isModerator && !isAuthor) {
      await writeAudit(ctx, {
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
    const actor = await requireCapability(ctx, 'access.alert');
    await setOfficialImpl(ctx, actor, { accessAlertId, official, reason });
  },
});

/**
 * `setOfficial`'s body — also what undoing a pin or an unpin runs (D226). The row records the alert's
 * prior `status` and `expiresAt` as `prev`, so an undo can tell whether the release it is about to
 * perform would put back what was there.
 */
export async function setOfficialImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  {
    accessAlertId,
    official,
    reason,
  }: { accessAlertId: Id<'accessAlerts'>; official: boolean; reason: string },
): Promise<void> {
  const alert = await ctx.db.get(accessAlertId);
  if (!alert) throw new ConvexError('Access alert not found');
  if (reason.trim().length === 0) throw new ConvexError('A reason is required');
  // The author's retraction is final (D248): no moderator puts a withdrawn claim back up — not by
  // pinning it, and not by releasing it, which would put it back in the community lifecycle.
  if (alert.status === 'retracted' && alert.retractedByUserId === alert.createdByUserId) {
    throw new ConvexError(
      official
        ? 'Its author retracted this alert, so it can’t be pinned.'
        : 'Its author retracted this alert, so it can’t be released.',
    );
  }

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

  await writeAudit(ctx, {
    actorId: actor._id,
    action: official ? 'pin_access_alert' : 'unpin_access_alert',
    targetType: 'accessAlert',
    targetId: accessAlertId,
    reason,
    metadata: {
      waterBodyId: alert.waterBodyId,
      alertReason: alert.reason,
      prev: { status: alert.status, expiresAt: alert.expiresAt ?? null },
    },
    createdAt: Date.now(),
  });
}

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
 * The statuses a live alert can hold — **the only two rows either read path needs to see.**
 *
 * `expired`, `resolved` and `retracted` are settled and can never come back on their own, so reading
 * them costs the cap and buys nothing. Kept beside `accessAlertIsLive` in spirit: that function
 * decides whether a row *is* live, this one decides which rows are worth asking about.
 */
const LIVE_STATUSES = ['active', 'official'] as const;

/**
 * The two live reads — **the range is what makes the cap correct, not the filter after it.**
 *
 * Written out per index rather than parameterized: threading the index name and its leading field
 * through arguments defeats Convex's index typing and buys one `any` plus a suppression, which is a
 * poor trade for a few duplicated lines on the query this file most needs to be obviously correct.
 *
 * Three properties, and each one is a bug that shipped in an earlier draft of this function:
 *
 * 1. **The statuses are queried separately and each capped**, so a busy season of `active` rows can
 *    never crowd out a moderator's pin — the reason `official` is a status rather than a flag,
 *    applied to the read side.
 * 2. **`active` is bounded by `gt('expiresAt', now)`**, so a row the six-hourly sweep has not reached
 *    yet cannot occupy a slot it is about to be filtered out of. Status alone does not exclude a
 *    lapsed row; only the clock does.
 * 3. **Ordering is by expiry**, which is derived from `max(createdAt, lastConfirmedAt)` and is
 *    therefore a better recency than `createdAt`: a backdated observation sorts down, and a
 *    confirmation — which `createdAt` cannot see at all — moves a row up.
 *
 * The pinned read deliberately has no clock bound: a pin carries no expiry and outranks the
 * lifecycle rather than participating in it.
 */
/**
 * 4. **Blockers and conditions are capped separately, in the range** (A10-3 §7.2, the cap the
 *    A10-2 build owed). Both kinds ride the same rows, so once the sheet files conditions a lake
 *    with many live "plank needed" rows could push a live "gate locked" out of one shared window —
 *    and `blockedIds` is built from that window. The first cut took two windows over one range,
 *    each filtered to its reason set before the take; that bounded the answer but not the read —
 *    a lake of live planks was a scan to find its gate (PR #75 review). `kind` is now an index key
 *    (`accessAlerts.kind`), so each `(status, kind)` range holds only its kind and the take is the
 *    whole read. Four ranges per target, as before — not one per reason, which the lot walk below
 *    (up to `MAX_LOT_LINKS_SCANNED` lots) would multiply past a function's call budget.
 */

/**
 * The `(status, kind)` pages one live read takes — every status × every kind, because `setOfficial`
 * pins whatever row a moderator names, a condition as readily as a blocker; a page left out here is
 * a pinned row that vanishes from the lake.
 */
const LIVE_PAGES: readonly { status: (typeof LIVE_STATUSES)[number]; kind: AccessAlertKind }[] =
  LIVE_STATUSES.flatMap((status) => ACCESS_ALERT_KINDS.map((kind) => ({ status, kind })));

async function liveAlertsByBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  now: number,
): Promise<Doc<'accessAlerts'>[]> {
  const pages = await Promise.all(
    LIVE_PAGES.map(({ status, kind }) =>
      ctx.db
        .query('accessAlerts')
        .withIndex('by_water_body_status_kind_expires_at', (q) => {
          const scoped = q.eq('waterBodyId', waterBodyId).eq('status', status).eq('kind', kind);
          return status === 'active' ? scoped.gt('expiresAt', now) : scoped;
        })
        .order('desc')
        .take(MAX_ACCESS_ROWS_PER_BODY),
    ),
  );
  return pages.flat();
}

async function liveAlertsByParkingArea(
  ctx: QueryCtx,
  parkingAreaId: Id<'parkingAreas'>,
  now: number,
): Promise<Doc<'accessAlerts'>[]> {
  const pages = await Promise.all(
    LIVE_PAGES.map(({ status, kind }) =>
      ctx.db
        .query('accessAlerts')
        .withIndex('by_parking_area_status_kind_expires_at', (q) => {
          const scoped = q.eq('parkingAreaId', parkingAreaId).eq('status', status).eq('kind', kind);
          return status === 'active' ? scoped.gt('expiresAt', now) : scoped;
        })
        .order('desc')
        .take(MAX_ACCESS_ROWS_PER_BODY),
    ),
  );
  return pages.flat();
}

/** Whether a lot is (still) associated with a body — the target, not the alert's column, decides. */
async function lotServesBody(
  ctx: QueryCtx,
  parkingAreaId: Id<'parkingAreas'>,
  waterBodyId: Id<'waterBodies'>,
): Promise<boolean> {
  const link = await ctx.db
    .query('parkingAreaBodies')
    .withIndex('by_parking_area_water_body', (q) =>
      q.eq('parkingAreaId', parkingAreaId).eq('waterBodyId', waterBodyId),
    )
    .unique();
  return link !== null;
}

/**
 * Whether this alert annotates this body, as `loadLiveAlertsForBody` shows it — the one rule, so the
 * viewer's own-alerts read can't name an alert the shared read hides. A lot's alert counts on every
 * body the lot still serves; a launch's only on the body its column names *and* the launch is still
 * on (the shared read reaches it through the column alone, so a moved launch's alert is nowhere).
 */
async function alertAnnotatesBody(
  ctx: QueryCtx,
  alert: Doc<'accessAlerts'>,
  waterBodyId: Id<'waterBodies'>,
): Promise<boolean> {
  if (alert.parkingAreaId !== undefined) {
    return lotServesBody(ctx, alert.parkingAreaId, waterBodyId);
  }
  if (alert.waterBodyId !== waterBodyId) return false;
  if (alert.putInId === undefined) return true;
  return (await ctx.db.get(alert.putInId))?.waterBodyId === waterBodyId;
}

/**
 * Every live alert annotating an access point on this body.
 *
 * Liveness is re-checked here and not left to the sweep, because **the cron's schedule must never be a
 * visible behavior**: a row whose expiry passed an hour ago stops annotating the moment it passes,
 * not the moment a job next runs.
 */
export async function loadLiveAlertsForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  now: number = Date.now(),
): Promise<AccessAlertView[]> {
  // Capped for the same reason the parking read is (see `MAX_ACCESS_ROWS_PER_BODY`): alerts are
  // user-generated, so "how many can one lake have" is not a number we control.
  //
  // ⚠ **The cap must bound the answer, not the history** (PR #43 review). Nothing here is ever
  // deleted — expiring flips a status — so a lake's rows accumulate across seasons, and the original
  // unqualified body index took the *oldest* page and only then filtered for liveness. Two winters
  // in, that is a page of expired rows and a locked gate nobody hears about. The range is now scoped
  // by status *and* bounded by the expiry clock, so every row it can return is already live and the
  // cap spends itself on answers. See `liveAlertsByBody`.
  const direct = await liveAlertsByBody(ctx, waterBodyId, now);

  // ── The shared-lot half, and it is not an optimization ────────────────────────────────────────
  //
  // An alert on a **parking area** is filed against one body — the first the lot is associated with —
  // because fanning out a row per body would make one locked gate look like three. But a trailhead lot
  // serving three ponds is the normal case here (D72 amendment), and reading only the body-scoped
  // range would warn skaters heading to *one* of them and silently fail the other two. A gate is
  // locked for everybody who parks there.
  //
  // So the lot's alerts are pulled through its associations as well, and the two sets are deduped: an
  // alert filed against this body **and** sitting on a lot linked to it appears in both.
  //
  // ⚠ **This walk is bounded by `MAX_LOT_LINKS_SCANNED`, not by the render cap**, and conflating the
  // two was a real omission: the render cap exists to stop a drawer returning 160 parking markers,
  // while every association skipped *here* is a locked gate somebody is not told about. Champlain
  // carries 160 associations, so at 64 the corpus's biggest lakes could not see a warning on their
  // own parking. The direct read above rescues an alert filed against *this* body; a shared lot's
  // alert is filed against whichever body came first, so on the other lake this walk is the only way
  // to it.
  const links = await ctx.db
    .query('parkingAreaBodies')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(MAX_LOT_LINKS_SCANNED);
  const byId = new Map<Id<'accessAlerts'>, Doc<'accessAlerts'>>();

  // ⚠ **`waterBodyId` is a denormalization, and denormalizations go stale — so the *target* decides
  // which lake an alert belongs to, and the column is only an index key.**
  //
  // The row records which body the alert was filed against at `create` time. Two ordinary things move
  // the target out from under it afterwards:
  //
  // - `setOfficialParking` deletes an association, a moderator narrowing a lot to the lakes it really
  //   serves; and
  // - `matchAndImportPutIns` re-imports a launch whose OSM coordinate moved, which can attach it to a
  //   different body entirely.
  //
  // Either way the row goes on naming a lake its target has nothing to do with, and this read would
  // go on warning that lake about a gate nobody parks at — the same "an alert on a lake it does not
  // belong to" failure as the contradictory-target hole, arrived at from the write side. Re-checking
  // costs one bounded lookup per alert on a page that is itself capped.
  //
  // What this buys is that the **wrong lake stops being warned**. It does not move the alert to the
  // right one: the read is keyed on the denormalized column, so a moved target's row is unreachable
  // from its new body until something rewrites the column. That asymmetry is the right way round —
  // silence beats a locked gate shown to people going somewhere else.
  const directHere = await Promise.all(
    direct.map((alert) => alertAnnotatesBody(ctx, alert, waterBodyId)),
  );
  direct.forEach((alert, i) => {
    if (directHere[i]) byId.set(alert._id, alert);
  });

  // Issued together rather than in sequence: they are independent indexed ranges that return nothing
  // for the overwhelming majority of lots, so the cost is round trips rather than documents.
  const lotPages = await Promise.all(
    links.map((link) => liveAlertsByParkingArea(ctx, link.parkingAreaId, now)),
  );
  for (const page of lotPages) for (const alert of page) byId.set(alert._id, alert);

  return [...byId.values()]
    .filter((r) => accessAlertIsLive(r, now))
    .sort((a, b) =>
      a.status === b.status ? b.createdAt - a.createdAt : a.status === 'official' ? -1 : 1,
    )
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
 * How many of one person's alerts `myAlertIdsForBody` reads per live status — far past anyone's.
 * Exported for the test that files more settled alerts than this after a pin.
 */
export const MY_ALERTS_SCAN = 500;

/**
 * The viewer's own live alerts on this body — the one viewer-specific fact the access drawer needs
 * (D248): on a pinned alert its author alone keeps "It's open". Kept out of `accessForBody` and
 * `listForBody` on purpose: those are the lake page's shared reads, and reading the signed-in person
 * there would cache a copy per viewer and re-run them per viewer on every alert change.
 *
 * Read by `(author, status)`, each live status capped on its own and `active` bounded by its clock
 * as the per-lake reads are, so **the cap bounds their live alerts, not their history**: settled alert
 * rows are kept (only an author's own retraction is erased, D248), and the sheet's condition chips
 * file them too, so a cap over every row they ever filed would push a pin (which never expires) out
 * behind the settled rows filed since — and a status-only range would spend it on lapsed rows the
 * sweep has not reached. Which body an alert
 * annotates is `alertAnnotatesBody`, the shared read's own rule. Signed out, or none of their own: `[]`.
 */
export const myAlertIdsForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<Id<'accessAlerts'>[]> => {
    const viewer = await getCurrentProfile(ctx);
    if (!viewer) return [];
    const now = Date.now();
    const pages = await Promise.all(
      LIVE_STATUSES.map((status) =>
        ctx.db
          .query('accessAlerts')
          .withIndex('by_author_status_expires_at', (q) => {
            const scoped = q.eq('createdByUserId', viewer._id).eq('status', status);
            return status === 'active' ? scoped.gt('expiresAt', now) : scoped;
          })
          .order('desc')
          .take(MY_ALERTS_SCAN),
      ),
    );
    const live = pages.flat().filter((alert) => accessAlertIsLive(alert, now));
    const here = await Promise.all(
      live.map((alert) => alertAnnotatesBody(ctx, alert, waterBodyId)),
    );
    return live.filter((_, i) => here[i]).map((alert) => alert._id);
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
