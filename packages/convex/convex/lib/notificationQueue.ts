/**
 * The actor-triggered half of the notification queue (N8 / D169): enqueue with a settle window,
 * re-read the trigger at flush, and only then build the payload the inbox stores.
 *
 * ## Why every producer goes through here
 *
 * A misclick is a normal thing to do — thumb the wrong hazard, notice, click again to undo. Until N8
 * the thumb inserted a `notifications` row on the spot and the undo could not recall it, so the
 * author was told someone found their report helpful, by someone who no longer does. Now every
 * actor-triggered notification sits in `notificationQueue` for `SETTLE_MS` and the flush asks *"is
 * this still true?"* before it delivers — re-reading the rating, the comment, the hazard's phase, the
 * flag's verdict, the bounty's status.
 *
 * **Re-check at send rather than cancel at undo.** Cancelling means every undo path — retract a
 * thumb, flip a verdict, delete a comment, hide a report — has to know the queue exists and find
 * the right row; miss one and a phantom notification ships. Re-check is one place, it covers paths
 * nobody thought of, and it covers content that vanished for reasons that were never an "undo".
 *
 * ## Coalescing
 *
 * Rows key on `(recipient, target, kind)`, so five thumbs inside a minute become one *"5 people found
 * this helpful"* rather than five rows. The ids accumulate on the `trigger` and each is re-verified at
 * flush individually: helpful → unhelpful → helpful inside one window is one row whose actor still
 * reads `helpful` ⇒ exactly one notification; helpful → unhelpful drops out of the list, and a list
 * with nobody left on it drops the row.
 *
 * The report-audience buckets (`favorite` / `digest` / `great`) live in `notifications.ts` — they
 * predate this and carry no trigger; their re-check is the recipient's eligibility, which every row
 * gets in the flush.
 */

import {
  type HazardLifecyclePhase,
  hazardLifecyclePhase,
  isPassageMarker,
  NOTIFICATION_PREF_KEY_FOR,
  type NotificationType,
} from '@skating/core';
import type { Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { canReceiveNotifications } from './auth';
import { loadBlockedAuthorIds } from './reportVisibility';
import type { notificationTrigger } from './validators';

export type NotificationTrigger = Infer<typeof notificationTrigger>;
export type ActorQueueKind = NotificationTrigger['kind'];

/**
 * The `notifications.type` each actor kind flushes to — and therefore the pref toggle it gates on.
 * Derived here rather than passed by each producer: the pair is a fact about the kind, and a producer
 * that could spell it differently is a producer that could gate on the wrong toggle and hand the
 * resolver a payload its type doesn't parse.
 */
export const TYPE_FOR_KIND: Record<ActorQueueKind, NotificationType> = {
  thumb: 'report_rated',
  corroboration: 'report_rated',
  comment: 'report_commented',
  reply: 'report_commented',
  hazard_lifecycle: 'hazard_confirmation',
  flag_resolved: 'content_flag_resolved',
  bounty_request: 'bounty_request',
  bounty_answered: 'bounty_answered',
  activity: 'activity_detected',
};

/**
 * How long an actor-triggered notification settles before it can send. The founder's instinct was
 * "a few seconds", and a few seconds is the *real* window — a misclick is corrected almost at once.
 * Sixty is what ships anyway because the flush cron ticks once a minute (`crons.ts`), so anything
 * shorter buys nothing measurable: effective latency is 0–60 s either way. Sixty also covers the
 * slower version of the same mistake — reading the hazard properly, realising you voted wrong,
 * fixing it.
 */
export const SETTLE_MS = 60 * 1000;

/** `(recipient, target, kind)` — the collapse-id seed, same shape the report buckets use. */
export function actorCoalesceKey(
  userId: Id<'profiles'>,
  targetId: string,
  kind: ActorQueueKind,
): string {
  return `${userId}:${targetId}:${kind}`;
}

/**
 * Merge a fresh trigger into the one already queued under the same key. Id lists union (so a second
 * thumb inside the window joins the first), scalar state overwrites (a hazard that moved phase twice
 * inside a minute is news about where it *ended up*).
 */
export function mergeTriggers(
  existing: NotificationTrigger,
  incoming: NotificationTrigger,
): NotificationTrigger {
  if (existing.kind !== incoming.kind) return incoming;
  switch (incoming.kind) {
    case 'thumb':
      return existing.kind === 'thumb'
        ? { ...incoming, actorIds: union(existing.actorIds, incoming.actorIds) }
        : incoming;
    case 'corroboration':
      return existing.kind === 'corroboration'
        ? { ...incoming, byReportIds: union(existing.byReportIds, incoming.byReportIds) }
        : incoming;
    case 'comment':
    case 'reply':
      return existing.kind === 'comment' || existing.kind === 'reply'
        ? {
            ...incoming,
            commentIds: union(existing.commentIds, incoming.commentIds),
            actorIds: union(existing.actorIds, incoming.actorIds),
          }
        : incoming;
    case 'bounty_answered':
      return existing.kind === 'bounty_answered'
        ? { ...incoming, reportIds: union(existing.reportIds, incoming.reportIds) }
        : incoming;
    case 'hazard_lifecycle':
      // The phase is scalar (where the pin ended up); the voters who moved it accumulate, so the
      // flush's block check has the whole window's actors to apply it to.
      return existing.kind === 'hazard_lifecycle'
        ? { ...incoming, actorIds: union(existing.actorIds, incoming.actorIds) }
        : incoming;
    case 'flag_resolved':
    case 'bounty_request':
    case 'activity':
      return incoming;
  }
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  const out = [...a];
  for (const item of b) if (!out.includes(item)) out.push(item);
  return out;
}

/** How many events a trigger currently represents — the `count` the inbox row will carry. */
export function triggerCount(trigger: NotificationTrigger): number {
  switch (trigger.kind) {
    case 'thumb':
      return trigger.actorIds.length;
    case 'corroboration':
      return trigger.byReportIds.length;
    case 'comment':
    case 'reply':
      return trigger.commentIds.length;
    case 'bounty_answered':
      return trigger.reportIds.length;
    case 'hazard_lifecycle':
    case 'flag_resolved':
    case 'bounty_request':
    case 'activity':
      return 1;
  }
}

/**
 * What `settleTrigger` spends in document reads, for the flush's per-transaction tally: the target
 * (report, hazard, bounty, flag, activity), then one read per coalesced id. Charged whether or not
 * the settle short-circuits before it gets there — a burst is priced by what it *could* read, so
 * the tally is a floor on headroom. Lives beside `settleTrigger` rather than at its call site so a
 * kind whose re-check grows (a second read per id, say) changes both in one place.
 */
export function settleReadCost(trigger: NotificationTrigger): number {
  return 1 + triggerCount(trigger);
}

/**
 * Queue an actor-triggered notification for `recipientId`, applying every enqueue-time gate in one
 * place: never self, recipient exists and can receive, the type's toggle is on, and the actor isn't
 * blocked either way (block == mute, Phase 3 — the inbox's read-time filter is a backstop for old
 * rows, not a substitute for this).
 *
 * Returns whether a row was written or bumped. The gates are re-applied at flush — a person can
 * toggle the pref, block the actor, or request deletion inside the window — so this is the cheap
 * early exit, not the guarantee.
 */
export async function enqueueActorNotification(
  ctx: MutationCtx,
  args: {
    recipientId: Id<'profiles'>;
    /** The person whose action this is, when there is one — for the self/block gates. */
    actorId?: Id<'profiles'>;
    /** What the coalesce key is scoped to: the report, hazard, bounty, flag, or activity id. */
    targetId: string;
    trigger: NotificationTrigger;
    now?: number;
    /** Override the settle window — the `activity` sweep, for instance, has already waited hours. */
    flushAfter?: number;
  },
): Promise<boolean> {
  const now = args.now ?? Date.now();
  const kind = args.trigger.kind;
  const type = TYPE_FOR_KIND[kind];
  if (args.actorId !== undefined && args.actorId === args.recipientId) return false;
  const recipient = await ctx.db.get(args.recipientId);
  if (!recipient) return false;
  if (!recipientWants(recipient, type)) return false;
  if (args.actorId !== undefined) {
    const blocked = await loadBlockedAuthorIds(ctx, args.recipientId);
    if (blocked.has(args.actorId)) return false;
  }

  const coalesceKey = actorCoalesceKey(args.recipientId, args.targetId, kind);
  const flushAfter = args.flushAfter ?? now + SETTLE_MS;
  const existing = await ctx.db
    .query('notificationQueue')
    .withIndex('by_coalesce', (q) => q.eq('coalesceKey', coalesceKey))
    .first();
  if (existing) {
    const trigger = existing.trigger ? mergeTriggers(existing.trigger, args.trigger) : args.trigger;
    await ctx.db.patch(existing._id, {
      trigger,
      count: triggerCount(trigger),
      // Keep the earliest while the row is still settling: a burst settles from its *first* event,
      // so a busy report can't be starved of its notification by a stream of later ones each
      // pushing the window out. But a row that is already *due* — its window has passed and the
      // cron simply hasn't ticked yet — must not lend its expired deadline to a fresh action: the
      // new thumb would flush on the next tick with seconds of settle rather than the window it
      // was promised. So a due row takes the incoming deadline instead. Starvation can't come back
      // through this: the row only moves when it was already flushable, so each extension costs one
      // more window and needs a new action to land in the gap between due and the next tick.
      flushAfter:
        existing.flushAfter <= now ? flushAfter : Math.min(existing.flushAfter, flushAfter),
    });
    return true;
  }
  await ctx.db.insert('notificationQueue', {
    userId: args.recipientId,
    kind,
    type,
    coalesceKey,
    count: triggerCount(args.trigger),
    flushAfter,
    createdAt: now,
    trigger: args.trigger,
  });
  return true;
}

/** Active, not departing, and the type's toggle is on. Shared by enqueue and flush. */
export function recipientWants(profile: Doc<'profiles'>, type: NotificationType): boolean {
  if (!canReceiveNotifications(profile)) return false;
  return profile.notificationPrefs[NOTIFICATION_PREF_KEY_FOR[type]] === true;
}

// ── Re-check at flush ────────────────────────────────────────────────────────────────────────────

/**
 * The payload an inbox row stores for an actor-triggered notification, built **from the settled
 * trigger** so it only ever names things that were still true at delivery. Parsed back by
 * `lib/notificationResolve.ts`; the two are the boundary that keeps `notifications.payload` typed
 * despite the column being `v.any()`.
 */
export type ActorPayload =
  | {
      kind: 'thumb';
      targetType: 'report' | 'hazard';
      targetId: string;
      actorIds: Id<'profiles'>[];
      count: number;
    }
  | { kind: 'corroboration'; reportId: Id<'reports'>; byReportIds: Id<'reports'>[]; count: number }
  | {
      kind: 'comment';
      reply: boolean;
      reportId: Id<'reports'>;
      commentIds: Id<'comments'>[];
      actorIds: Id<'profiles'>[];
      count: number;
    }
  | { kind: 'hazard_lifecycle'; hazardId: Id<'hazards'>; phase: HazardLifecyclePhase }
  | { kind: 'flag_resolved'; flagId: Id<'contentFlags'>; resolution: 'actioned' | 'dismissed' }
  | {
      kind: 'bounty_request';
      bountyId: Id<'bounties'>;
      waterBodyId: Id<'waterBodies'>;
      requesterId: Id<'profiles'>;
    }
  | {
      kind: 'bounty_answered';
      bountyId: Id<'bounties'>;
      waterBodyId: Id<'waterBodies'>;
      reportIds: Id<'reports'>[];
      count: number;
    }
  | {
      kind: 'activity';
      activityId: Id<'gpsActivities'>;
      waterBodyId?: Id<'waterBodies'>;
      startTime: number;
    };

/**
 * Re-read a settled trigger and return the payload to deliver, or `null` to drop the row (E2). The
 * table of "deliver only if" per kind is the whole contract:
 *
 * | kind | still true when |
 * |---|---|
 * | thumb | the target is visible and ≥1 listed actor still has a `helpful` rating on it |
 * | corroboration | your report is visible and ≥1 corroborating report still is |
 * | comment / reply | the report is visible and ≥1 listed comment still exists, visible, unblocked |
 * | hazard_lifecycle | the hazard is visible, its phase is still the one that triggered this, and ≥1 listed voter is unblocked |
 * | flag_resolved | the flag's status is still that resolution |
 * | bounty_request | the bounty is still open and the requester is unblocked |
 * | bounty_answered | the bounty is still open and ≥1 listed report still visible |
 * | activity | the activity exists and is still un-linked and un-dismissed |
 *
 * `blocked` is the recipient's block set (either direction), loaded once per recipient per tick by
 * the flush; an actor in it drops out of the list exactly as a retracted thumb does. Every kind
 * with an actor applies it here — the enqueue gate only sees the block set as it stood when the
 * action happened, and block == mute has to hold for a block placed inside the window too.
 */
export async function settleTrigger(
  ctx: MutationCtx,
  trigger: NotificationTrigger,
  blocked: ReadonlySet<string>,
): Promise<ActorPayload | null> {
  switch (trigger.kind) {
    case 'thumb': {
      const visible = await targetVisible(ctx, trigger.targetType, trigger.targetId);
      if (!visible) return null;
      const actorIds: Id<'profiles'>[] = [];
      for (const actorId of trigger.actorIds) {
        if (blocked.has(actorId)) continue;
        const rating = await ctx.db
          .query('reportRatings')
          .withIndex('by_rater_target', (q) =>
            q
              .eq('raterId', actorId)
              .eq('targetType', trigger.targetType)
              .eq('targetId', trigger.targetId),
          )
          .first();
        if (rating?.verdict === 'helpful') actorIds.push(actorId);
      }
      if (actorIds.length === 0) return null;
      return {
        kind: 'thumb',
        targetType: trigger.targetType,
        targetId: trigger.targetId,
        actorIds,
        count: actorIds.length,
      };
    }
    case 'corroboration': {
      const report = await ctx.db.get(trigger.reportId);
      if (report?.moderationStatus !== 'visible') return null;
      const byReportIds: Id<'reports'>[] = [];
      for (const id of trigger.byReportIds) {
        const by = await ctx.db.get(id);
        if (by?.moderationStatus === 'visible' && !blocked.has(by.authorId)) byReportIds.push(id);
      }
      if (byReportIds.length === 0) return null;
      return {
        kind: 'corroboration',
        reportId: trigger.reportId,
        byReportIds,
        count: byReportIds.length,
      };
    }
    case 'comment':
    case 'reply': {
      const report = await ctx.db.get(trigger.reportId);
      if (report?.moderationStatus !== 'visible') return null;
      const commentIds: Id<'comments'>[] = [];
      const actorIds: Id<'profiles'>[] = [];
      for (const id of trigger.commentIds) {
        const comment = await ctx.db.get(id);
        if (comment?.moderationStatus !== 'visible') continue;
        if (blocked.has(comment.authorId)) continue;
        // A departed author's comment is redacted, not deleted — still a comment, still theirs.
        commentIds.push(id);
        if (!actorIds.includes(comment.authorId)) actorIds.push(comment.authorId);
      }
      if (commentIds.length === 0) return null;
      return {
        kind: 'comment',
        reply: trigger.kind === 'reply',
        reportId: trigger.reportId,
        commentIds,
        actorIds,
        count: commentIds.length,
      };
    }
    case 'hazard_lifecycle': {
      const hazard = await ctx.db.get(trigger.hazardId);
      if (hazard?.moderationStatus !== 'visible') return null;
      // A merged-away pin is a tombstone; its lifecycle is no longer the one the author is watching.
      if (hazard.mergedIntoHazardId !== undefined) return null;
      const phase = hazardLifecyclePhase(
        {
          status: hazard.status,
          healingState: hazard.healingState ?? 'none',
          confirmCount: hazard.confirmCount,
        },
        isPassageMarker(hazard.type),
      );
      if (phase !== trigger.phase) return null;
      // The phase is a consensus, but the notification is still "someone's vote moved your pin":
      // if everyone who voted inside the window is now blocked, it's muted like their thumbs are.
      if (!trigger.actorIds.some((actorId) => !blocked.has(actorId))) return null;
      return { kind: 'hazard_lifecycle', hazardId: trigger.hazardId, phase };
    }
    case 'flag_resolved': {
      const flag = await ctx.db.get(trigger.flagId);
      if (flag?.status !== trigger.resolution) return null;
      return { kind: 'flag_resolved', flagId: trigger.flagId, resolution: trigger.resolution };
    }
    case 'bounty_request': {
      const bounty = await ctx.db.get(trigger.bountyId);
      if (bounty?.status !== 'open') return null;
      if (blocked.has(trigger.requesterId)) return null;
      return {
        kind: 'bounty_request',
        bountyId: trigger.bountyId,
        waterBodyId: trigger.waterBodyId,
        requesterId: trigger.requesterId,
      };
    }
    case 'bounty_answered': {
      const bounty = await ctx.db.get(trigger.bountyId);
      // Still open means the requester hasn't ruled yet — the one state where "a report came in,
      // mark it helpful" is actionable. Fulfilled inside the window means they already did.
      if (bounty?.status !== 'open') return null;
      const reportIds: Id<'reports'>[] = [];
      for (const id of trigger.reportIds) {
        const report = await ctx.db.get(id);
        if (report?.moderationStatus === 'visible' && !blocked.has(report.authorId))
          reportIds.push(id);
      }
      if (reportIds.length === 0) return null;
      return {
        kind: 'bounty_answered',
        bountyId: trigger.bountyId,
        waterBodyId: trigger.waterBodyId,
        reportIds,
        count: reportIds.length,
      };
    }
    case 'activity': {
      const activity = await ctx.db.get(trigger.activityId);
      if (!activity) return null;
      if (activity.linkedReportId !== undefined || activity.promptState === 'dismissed')
        return null;
      return {
        kind: 'activity',
        activityId: trigger.activityId,
        ...(activity.waterBodyId !== undefined ? { waterBodyId: activity.waterBodyId } : {}),
        startTime: activity.startTime,
      };
    }
  }
}

/** Moderation-visible, for the two thumb-able target tables. */
async function targetVisible(
  ctx: MutationCtx,
  targetType: 'report' | 'hazard',
  targetId: string,
): Promise<boolean> {
  const id = ctx.db.normalizeId(targetType === 'report' ? 'reports' : 'hazards', targetId);
  if (!id) return false;
  const doc = await ctx.db.get(id);
  return doc?.moderationStatus === 'visible';
}
