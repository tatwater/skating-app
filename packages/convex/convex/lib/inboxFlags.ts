/**
 * **A flag decision's two halves, shared by the Inbox's writes and their undos** (B01-5): closing a
 * set of flags under one decision, and reopening the flags a decision closed. In `lib/` so the undo
 * handlers reach it without importing the mutation modules back (`inboxWrites.ts`, `moderation.ts`).
 */

import { metricDay } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { writeAudit } from './audit';
import { holdMoved } from './eraseClock';
import { closeFlag, type FlagResolution } from './flagResolution';
import { flagSubject } from './flagSubject';
import { flagSource, reopenItem, syncInboxSource } from './inboxItems';
import { OWN_FILING_REFUSAL } from './inboxRules';
import { bumpMetricMetaCounter } from './metrics';
import { OPEN_FLAG_STATUSES } from './openFlags';
import { ownContentRefusal } from './ownContent';

/** The most open flags one target's takedown closes in one write, and an undo reopens. */
const FLAGS_READ = 500;

/** A flag's status counts as open (`reviewing` too, until it is narrowed out, D283). */
export const isOpenFlag = (f: Pick<Doc<'contentFlags'>, 'status'>): boolean =>
  (OPEN_FLAG_STATUSES as readonly string[]).includes(f.status);

/** The decision a closed flag's Inbox item records (`INBOX_DECISIONS`, the flag half). */
export type FlagDecision =
  | 'dismissed'
  | 'actioned'
  | 'hidden'
  | 'removed'
  | 'unpinned'
  | 'retracted'
  | 'restored';

/** Every open flag on a target, in every lane (both open statuses, every reason), oldest first. */
export async function openFlagsOn(
  ctx: MutationCtx,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
): Promise<Doc<'contentFlags'>[]> {
  const rows: Doc<'contentFlags'>[] = [];
  for (const status of OPEN_FLAG_STATUSES) {
    rows.push(
      ...(await ctx.db
        .query('contentFlags')
        .withIndex('by_target_status_reason', (q) =>
          q.eq('targetType', targetType).eq('targetId', targetId).eq('status', status),
        )
        .take(FLAGS_READ)),
    );
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Close `flags` under one decision: each its own `resolve_flag` / `dismiss_flag` row naming the
 * decision's row (`withActionId`) — the first flag's own row is the decision's when no other row is
 * (a dismissal) — and each through `closeFlag`, which closes its Inbox member stamped with the
 * decision's row, moves the hold and the metric, and tells a user-origin flagger. Returns the
 * decision's row.
 */
export async function closeFlagsUnder(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  flags: readonly Doc<'contentFlags'>[],
  opts: {
    resolution: FlagResolution;
    decision: FlagDecision;
    reason: string;
    defaulted: boolean;
    now: number;
    /** The decision's own row (the content's, the alert's); absent: the first flag's row is it. */
    lead?: Id<'moderationActions'>;
  },
): Promise<Id<'moderationActions'> | undefined> {
  let lead = opts.lead;
  for (const flag of flags) {
    const id = await writeAudit(ctx, {
      actorId: actor._id,
      action: opts.resolution === 'actioned' ? 'resolve_flag' : 'dismiss_flag',
      targetType: 'contentFlag',
      targetId: flag._id,
      reason: opts.reason,
      metadata: {
        // When it was filed, for a staffer's time to decide (People).
        filedAt: flag.createdAt,
        inboxDecision: opts.decision,
        ...(opts.defaulted ? { reasonDefaulted: true } : {}),
        ...(lead !== undefined ? { withActionId: lead } : {}),
      },
      createdAt: opts.now,
    });
    lead ??= id;
    await closeFlag(ctx, flag, opts.resolution, actor._id, opts.now, {
      actionId: lead,
      decision: opts.decision,
    });
  }
  return lead;
}

/** The newest flags on a target read to find one that would break the bundling rule. */
export const NEWER_FLAGS_READ = 100;

/** The newest flags on `flag`'s target, for {@link flagReopenRefusalOf}. */
export function newerFlagsOn(
  ctx: QueryCtx,
  flag: Pick<Doc<'contentFlags'>, 'targetType' | 'targetId'>,
  n: number = NEWER_FLAGS_READ,
): Promise<Doc<'contentFlags'>[]> {
  return ctx.db
    .query('contentFlags')
    .withIndex('by_target', (q) =>
      q.eq('targetType', flag.targetType).eq('targetId', flag.targetId),
    )
    .order('desc')
    .take(n);
}

/**
 * **Why `flag` can't reopen now, or `null`** (B01-5) — the one rule an undo's offer and its write both
 * ask. It must still be closed as a decision left it, and reopening it must not put a second open row
 * where the code keeps one: refused when a newer flag supersedes it (`supersedesFlagId`); for an
 * automatic flag, when an open automatic flag of its reason is on the target now (the auto-flag
 * bundling keeps one per target and reason, `lib/autoFlag`); for a person's flag, when that person
 * has an open flag on the target now (one open flag per flagger per target, `contentFlags.flag`).
 * Other people's open flags beside it are the ordinary case — several reporters, one item.
 * `newer` is the target's newest flags ({@link newerFlagsOn}).
 */
export function flagReopenRefusalOf(
  flag: Doc<'contentFlags'> | null,
  newer: readonly Doc<'contentFlags'>[],
): string | null {
  if (!flag) return 'The flag no longer exists.';
  if (flag.status !== 'actioned' && flag.status !== 'dismissed') {
    return 'The flag has changed since, so it can’t be reopened.';
  }
  if (newer.some((f) => f.supersedesFlagId === flag._id)) {
    return 'A newer flag has taken this one’s place, so it can’t be reopened.';
  }
  const others = newer.filter((f) => f._id !== flag._id && isOpenFlag(f));
  if (flag.origin === 'user') {
    if (others.some((f) => f.origin === 'user' && f.flaggerId === flag.flaggerId)) {
      return 'The same person has flagged this again since, so this one can’t be reopened beside it.';
    }
  } else if (others.some((f) => f.origin !== 'user' && f.reason === flag.reason)) {
    return 'A flag of the same kind is open on this now, so this one can’t be reopened beside it.';
  }
  return null;
}

/**
 * Whether `actor` may reopen `flag` at all: no staffer decides a flag they filed (D289) or one about
 * them or their content (D269) — and an undo is a decision too.
 */
export function flagActorRefusal(actor: Doc<'profiles'>, flag: Doc<'contentFlags'>): string | null {
  if (flag.origin === 'user' && flag.flaggerId === actor._id) return OWN_FILING_REFUSAL;
  return ownContentRefusal(actor, flagSubject(flag) ?? undefined);
}

/**
 * **The flags a decision closed, reopened** — the undo of a dismissal, a flag's resolution, a takedown
 * made from the Inbox, an alert verdict, a restore-and-dismiss. Each flag the decision's row closed
 * (its Inbox members, stamped with that row; `alsoFlagId` for a flag closed before the members were)
 * goes back to `open` with its resolver cleared, its erasure hold put back, and the day's disposition
 * metric moved back when it was counted today (a past day's count stands: it was resolved that day).
 * Each gets a `reopen_flag` row; then the item reopens (`reopenItem`). A verdict message still in its
 * settle window is dropped at its flush (the flag's status is no longer that resolution).
 *
 * A flag that can't reopen ({@link flagReopenRefusalOf}, {@link flagActorRefusal}) refuses a flag
 * decision's own undo, the whole of it. As part of another undo (`withUndoOf`: a ruling's, a
 * takedown's, an alert verdict's, a restore's) it is **skipped** — left closed — and named with why on
 * that undo's own row (`metadata.flagsLeftClosed`), so the parent's undo runs: a person who has filed
 * again already holds their question open. Each reopened source is synced through the one writer
 * after, so its item follows it whatever stamp its member carries (a decision from before the Inbox
 * stamped none). Returns how many reopened.
 */
export async function reopenFlagsClosedBy(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  actionId: Id<'moderationActions'>,
  reason: string,
  opts: {
    /** The flag a flag decision's own row names (closed before the members were stamped). */
    alsoFlagId?: Id<'contentFlags'>;
    /**
     * The flags reopen as part of another undo (a takedown's, an alert verdict's, a restore's): each
     * `reopen_flag` row then names it, and undoes with it rather than on its own.
     */
    withUndoOf?: boolean;
  } = {},
): Promise<number> {
  const { alsoFlagId } = opts;
  const members = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_closed_by', (q) => q.eq('closedByActionId', actionId))
    .take(FLAGS_READ);
  const ids = new Set<Id<'contentFlags'>>(alsoFlagId ? [alsoFlagId] : []);
  for (const m of members) {
    if (m.sourceTable !== 'contentFlags') continue;
    const id = ctx.db.normalizeId('contentFlags', m.sourceId);
    if (id) ids.add(id);
  }
  const now = Date.now();
  const flags: Doc<'contentFlags'>[] = [];
  const leftClosed: { flagId: Id<'contentFlags'>; why: string }[] = [];
  for (const id of ids) {
    const flag = await ctx.db.get(id);
    const why =
      flagReopenRefusalOf(flag, flag ? await newerFlagsOn(ctx, flag) : []) ??
      flagActorRefusal(actor, flag as Doc<'contentFlags'>);
    if (why === null) flags.push(flag as Doc<'contentFlags'>);
    else if (opts.withUndoOf) leftClosed.push({ flagId: id, why });
    else throw new ConvexError(why);
  }
  // The parent undo's own row says which flags it left closed: written before this, it is the newest
  // row tagged as that undo (the `reopen_flag` rows below come after).
  if (leftClosed.length > 0) {
    const undoRow = await ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', actionId))
      .order('desc')
      .first();
    if (undoRow) {
      await ctx.db.patch(undoRow._id, {
        metadata: { ...(undoRow.metadata ?? {}), flagsLeftClosed: leftClosed },
      });
    }
  }
  const reopenedIds: Id<'contentFlags'>[] = [];
  for (const flag of flags) {
    const resolution = flag.status as FlagResolution;
    await ctx.db.patch(flag._id, {
      status: 'open',
      resolvedByUserId: undefined,
      resolvedAt: undefined,
    });
    // An open complaint holds withdrawn content back from erasure again (D248).
    await holdMoved(ctx, flag.targetType, flag.targetId, now);
    if (flag.resolvedAt !== undefined && metricDay(flag.resolvedAt) === metricDay(now)) {
      await bumpMetricMetaCounter(
        ctx,
        'flag_dispositions',
        `${flag.reason}:${resolution}`,
        -1,
        flag.resolvedAt,
      );
    }
    reopenedIds.push(flag._id);
    // A flag decision's own undo: the undone row's flag carries every reopened flag (`reopened`), so
    // the undo of this undo closes them all again in one act; the others undo with it. Inside another
    // undo, each undoes with that one.
    const lead = flag._id === alsoFlagId && !opts.withUndoOf;
    await writeAudit(ctx, {
      actorId: actor._id,
      action: 'reopen_flag',
      targetType: 'contentFlag',
      targetId: flag._id,
      reason,
      metadata: {
        reopens: actionId,
        prev: { status: resolution },
        ...(lead ? { reopened: flags.map((f) => f._id) } : { withActionId: actionId }),
      },
      createdAt: now,
    });
  }
  await reopenItem(ctx, actionId, { now });
  // Whatever its member's stamp — a decision from before the Inbox stamped none — each item follows.
  for (const id of reopenedIds) await syncInboxSource(ctx, flagSource(id), { now });
  return flags.length;
}
