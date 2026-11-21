/**
 * **A flag decision's two halves, shared by the Inbox's writes and their undos** (B01-5): closing a
 * set of flags under one decision, and reopening the flags a decision closed. In `lib/` so the undo
 * handlers reach it without importing the mutation modules back (`inboxWrites.ts`, `moderation.ts`).
 */

import { metricDay } from '@skating/core';
import { ConvexError } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { writeAudit } from './audit';
import { holdMoved } from './eraseClock';
import { closeFlag, FlagCloseEffects, type FlagResolution } from './flagResolution';
import { flagSubject } from './flagSubject';
import {
  batchHasRoom,
  flagSource,
  inboxBatch,
  reopenItem,
  syncInboxSource,
  type TxCost,
} from './inboxItems';
import { OWN_FILING_REFUSAL } from './inboxRules';
import { bumpMetricMetaCounter } from './metrics';
import { OPEN_FLAG_STATUSES } from './openFlags';
import { ownContentRefusal } from './ownContent';
import { ROW_MAX } from './readBudget';

/** The most open flags one target's takedown closes in one write, and an undo reopens. */
export const FLAGS_READ = 500;

/**
 * What reopening one flag costs an undo, which reopens them all in one transaction (it isn't paged):
 * the flag read and put back, its `reopen_flag` row, and its member reconciled under the reopen's
 * memoized reads (`reopenItem`). Held above what an undo is measured to read per flag
 * (`inboxBatch.test.ts`), and {@link FLAGS_READ} of them, with one refresh per item, inside Convex's
 * limits — the arithmetic that test asserts.
 */
export const FLAG_REOPEN_COST: TxCost = {
  bytesRead: 2 * ROW_MAX.contentFlag + 2 * ROW_MAX.inboxMember,
  documentsRead: 14,
  databaseQueries: 7,
  documentsWritten: 4,
};

/** A flag's status counts as open (`reviewing` too, until it is narrowed out, D283). */
export const isOpenFlag = (f: Pick<Doc<'contentFlags'>, 'status'>): boolean =>
  (OPEN_FLAG_STATUSES as readonly string[]).includes(f.status);

/** The decision a closed flag's Inbox item records (`INBOX_DECISIONS`, the flag half). */
export type FlagDecision =
  | 'dismissed'
  | 'actioned'
  | 'hidden'
  | 'removed'
  | 'pinned'
  | 'unpinned'
  | 'retracted'
  | 'restored'
  | 'ruled_closed'
  | 'ruled_accessible';

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

/** How a decision closes its flags (`closeFlagsUnder`), and what a later page needs to carry on. */
export type FlagCloseOpts = {
  resolution: FlagResolution;
  decision: FlagDecision;
  reason: string;
  defaulted: boolean;
  now: number;
  /** The decision's own row (the content's, the alert's, the ruling's); absent: the first flag's. */
  lead?: Id<'moderationActions'>;
  /**
   * Each flag its own `resolve_flag` / `dismiss_flag` row (the queue's decisions; the default). A
   * ruling writes none: its one row names the reports it closed, which are its consequence.
   */
  perFlagRows?: boolean;
};

/**
 * What closing one flag can cost beyond the batch's reconcile, at its worst: the flag read again, its
 * target (a report's body is read through it), the flagger the verdict goes to, the coalesce lookup,
 * and its writes — the patch, its member, its audit row, the queued verdict.
 */
export const FLAG_CLOSE_COST: TxCost = {
  bytesRead: 2 * ROW_MAX.contentFlag + ROW_MAX.report + ROW_MAX.profile + 4 * ROW_MAX.small,
  documentsRead: 12,
  databaseQueries: 12,
  documentsWritten: 6,
};

/** What a page's settle reads once: each target's hold (its row and a few holds), the counters. */
const FLAG_SETTLE_COST: TxCost = {
  bytesRead: ROW_MAX.report + 32 * ROW_MAX.small,
  documentsRead: 64,
  databaseQueries: 32,
  documentsWritten: 16,
};

/**
 * Close `flags` under one decision: each its own `resolve_flag` / `dismiss_flag` row naming the
 * decision's row (`withActionId`) — the first flag's own row is the decision's when no other row is
 * (a dismissal) — and each through `closeFlag`, which closes its Inbox member stamped with the
 * decision's row and tells a user-origin flagger. Returns the decision's row.
 *
 * **Paged, as one Inbox batch a page** (PR #170): a page closes flags while the transaction's live
 * budget holds one more and every item refresh it owes (`batchHasRoom`), recounts each item once at
 * its end, and moves each target's hold and the counters once (`FlagCloseEffects`); the flags it had
 * no room for follow in `inboxWrites.closeFlagsRest`, which stops if the decision was undone since.
 * A page always closes one at least, so it advances.
 */
export async function closeFlagsUnder(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  flags: readonly Doc<'contentFlags'>[],
  opts: FlagCloseOpts,
): Promise<Id<'moderationActions'> | undefined> {
  const effects = new FlagCloseEffects();
  let lead = opts.lead;
  let closed = 0;
  await inboxBatch(ctx, async () => {
    for (const flag of flags) {
      if (closed > 0 && !(await batchHasRoom(ctx, FLAG_CLOSE_COST, FLAG_SETTLE_COST))) break;
      lead = await closeOne(ctx, actor, flag, { ...opts, lead }, effects);
      closed++;
    }
  });
  await effects.settle(ctx, opts.now);
  const rest = flags.slice(closed);
  if (rest.length > 0 && lead !== undefined) {
    await ctx.scheduler.runAfter(0, internal.inboxWrites.closeFlagsRest, {
      actorId: actor._id,
      flagIds: rest.map((f) => f._id),
      resolution: opts.resolution,
      decision: opts.decision,
      reason: opts.reason,
      defaulted: opts.defaulted,
      now: opts.now,
      lead,
      perFlagRows: opts.perFlagRows !== false,
    });
  }
  return lead;
}

/**
 * A decision's later page: the flags still open of those it had no room for, closed as the first page
 * closed them — unless the decision was undone since (an undo row names its lead), when it stops: the
 * undo reopened what was closed, and the rest were never closed.
 */
export async function closeFlagsRestPage(
  ctx: MutationCtx,
  args: Omit<FlagCloseOpts, 'lead'> & {
    actorId: Id<'profiles'>;
    flagIds: Id<'contentFlags'>[];
    lead: Id<'moderationActions'>;
  },
): Promise<void> {
  const undone = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', args.lead))
    .first();
  if (undone !== null) return;
  const actor = await ctx.db.get(args.actorId);
  if (!actor) return;
  const flags: Doc<'contentFlags'>[] = [];
  for (const id of args.flagIds) {
    const flag = await ctx.db.get(id);
    if (flag && isOpenFlag(flag)) flags.push(flag);
  }
  const { actorId: _a, flagIds: _f, ...opts } = args;
  await closeFlagsUnder(ctx, actor, flags, opts);
}

/** One flag closed under the decision: its own row when the decision writes them, then `closeFlag`. */
async function closeOne(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  flag: Doc<'contentFlags'>,
  opts: FlagCloseOpts,
  effects: FlagCloseEffects,
): Promise<Id<'moderationActions'> | undefined> {
  let lead = opts.lead;
  if (opts.perFlagRows !== false) {
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
  }
  await closeFlag(
    ctx,
    flag,
    opts.resolution,
    actor._id,
    opts.now,
    { ...(lead !== undefined ? { actionId: lead } : {}), decision: opts.decision },
    effects,
  );
  return lead;
}

/** Rows tagged as one undo read to find its lead (a Post's undo writes at most ten members first). */
const LEAD_ROW_READ = 32;

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
  // A decision's flags share a target: its newest flags read once per target, not once per flag.
  const newerByTarget = new Map<string, Doc<'contentFlags'>[]>();
  const newerOf = async (flag: Doc<'contentFlags'>) => {
    const key = `${flag.targetType}:${flag.targetId}`;
    let newer = newerByTarget.get(key);
    if (newer === undefined) {
      newer = await newerFlagsOn(ctx, flag);
      newerByTarget.set(key, newer);
    }
    return newer;
  };
  for (const id of ids) {
    const flag = await ctx.db.get(id);
    const why =
      flagReopenRefusalOf(flag, flag ? await newerOf(flag) : []) ??
      flagActorRefusal(actor, flag as Doc<'contentFlags'>);
    if (why === null) flags.push(flag as Doc<'contentFlags'>);
    else if (opts.withUndoOf) leftClosed.push({ flagId: id, why });
    else throw new ConvexError(why);
  }
  // The parent undo's own row says which flags it left closed: its lead row — the first row it wrote
  // on the undone row's own target. Not merely the newest row tagged as the undo: a ruling's undo that
  // shelves the body again writes `set_standing` after its `set_public_access`, and a Post's undo
  // writes its members' rows on other targets.
  if (leftClosed.length > 0) {
    const undone = await ctx.db.get(actionId);
    const tagged = await ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', actionId))
      .take(LEAD_ROW_READ);
    const lead = tagged.find(
      (r) => r.targetType === undone?.targetType && r.targetId === undone?.targetId,
    );
    if (lead) {
      await ctx.db.patch(lead._id, {
        metadata: { ...(lead.metadata ?? {}), flagsLeftClosed: leftClosed },
      });
    }
  }
  const reopenedIds: Id<'contentFlags'>[] = [];
  // Each target's hold and each counter moved once, after every flag is back open (PR #170).
  const targets = new Map<string, { type: string; id: string }>();
  const counted = new Map<string, { count: number; at: number }>();
  for (const flag of flags) {
    const resolution = flag.status as FlagResolution;
    await ctx.db.patch(flag._id, {
      status: 'open',
      resolvedByUserId: undefined,
      resolvedAt: undefined,
    });
    targets.set(`${flag.targetType}:${flag.targetId}`, {
      type: flag.targetType,
      id: flag.targetId,
    });
    if (flag.resolvedAt !== undefined && metricDay(flag.resolvedAt) === metricDay(now)) {
      const key = `${flag.reason}:${resolution}`;
      counted.set(key, { count: (counted.get(key)?.count ?? 0) + 1, at: flag.resolvedAt });
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
  // An open complaint holds withdrawn content back from erasure again (D248).
  for (const { type, id } of targets.values()) await holdMoved(ctx, type, id, now);
  for (const [key, { count, at }] of counted) {
    await bumpMetricMetaCounter(ctx, 'flag_dispositions', key, -count, at);
  }
  // One batch with the reopen: every item it touches recounted once.
  await inboxBatch(ctx, async () => {
    const covered = new Set<string>();
    await reopenItem(ctx, actionId, { now, covered });
    // Whatever its member's stamp — a decision from before the Inbox stamped none — each item follows.
    for (const id of reopenedIds) {
      if (!covered.has(id)) await syncInboxSource(ctx, flagSource(id), { now });
    }
  });
  return flags.length;
}
