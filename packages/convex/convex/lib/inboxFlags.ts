/**
 * **A flag decision's two halves, shared by the Inbox's writes and their undos** (B01-5): closing a
 * set of flags under one decision, and reopening the flags a decision closed. In `lib/` so the undo
 * handlers reach it without importing the mutation modules back (`inboxWrites.ts`, `moderation.ts`).
 */

import { AUDIT_REASON_MAX, metricDay } from '@skating/core';
import { ConvexError } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { type AuditContext, asContinuationOf, auditContextOf, writeAudit } from './audit';
import { holdMoved } from './eraseClock';
import { closeFlag, FlagCloseEffects, type FlagResolution } from './flagResolution';
import { flagSubject } from './flagSubject';
import {
  batchHasRoom,
  flagSource,
  inboxBatch,
  owedRefreshes,
  pageIsFull,
  refreshCost,
  reopenReads,
  syncReopened,
  type TxCost,
} from './inboxItems';
import { OWN_FILING_REFUSAL } from './inboxRules';
import { bumpMetricMetaCounter } from './metrics';
import { OPEN_FLAG_STATUSES } from './openFlags';
import { ownContentRefusal } from './ownContent';
import { ROW_MAX } from './readBudget';

/** The most open flags of one status a takedown or an alert verdict gathers on its target. */
export const FLAGS_READ = 500;

/**
 * **The most flags one decision closes** — the writers' cap an undo's gather is sized to (PR #170): a
 * takedown or an alert verdict gathers {@link FLAGS_READ} a status (`openFlagsOn`), a dismissal an
 * item's open members (`MAX_MEMBERS`), a ruling `RULING_REPORTS_READ`, a re-close what its reopen
 * reopened. `inboxReopenRule.test.ts` holds each at or under it; past it an undo refuses
 * ({@link UNDO_TOO_LARGE}) rather than reopen some and leave the rest closed unsaid.
 */
export const DECISION_FLAGS_MAX = OPEN_FLAG_STATUSES.length * FLAGS_READ;

/** Room an undo keeps past its flags: the items' refreshes, the holds, the counters. */
export const REOPEN_HEADROOM = 2 * 1024 * 1024;

/** An undo whose flags, at their real weight, would pass the transaction's limits. */
export const UNDO_TOO_LARGE =
  'This undo reopens more than fits at once; reopen the flags from the Inbox instead.';

/** The automatic flag's `origin` values: `'auto'`, and absent (a row from before the field). */
const AUTO_ORIGINS = ['auto', undefined] as const;

/** The most one-row reads {@link reopenFactsOf} makes (one flag's kind reads only its half). */
export const REOPEN_FACT_READS = 1 + OPEN_FLAG_STATUSES.length * AUTO_ORIGINS.length;

/**
 * What reopening one flag costs an undo's page, at its worst: the flag read whole twice — by the
 * refusal check and by its patch (its reconcile reads it from the patched copy, `syncReopened`) — the
 * reopen rule's exact facts ({@link REOPEN_FACT_READS} one-row reads, each matched row read whole),
 * its member, and its writes: the flag back whole, its `reopen_flag` row, its member. Held above what
 * an undo is measured to read per flag (`inboxBatch.test.ts`); a page reopens while the transaction
 * still holds one more of these.
 */
export const FLAG_REOPEN_COST: TxCost = {
  bytesRead: (2 + REOPEN_FACT_READS) * ROW_MAX.contentFlag + 2 * ROW_MAX.inboxMember,
  documentsRead: 14 + REOPEN_FACT_READS,
  databaseQueries: 7 + REOPEN_FACT_READS,
  documentsWritten: 4,
  // The flag written back whole, its member, and its `reopen_flag` row: a reason of at most the cap
  // and a small metadata object (the lead's list of every flag it reopens is one row, in headroom).
  bytesWritten: ROW_MAX.contentFlag + ROW_MAX.inboxMember + AUDIT_REASON_MAX * 4 + 8 * 1024,
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
  // The flag patched whole, its member, its audit row (a reason of at most the cap), the verdict queued.
  bytesWritten: ROW_MAX.contentFlag + ROW_MAX.inboxMember + 2 * ROW_MAX.small,
};

/** What a page's settle reads once: each target's hold (its row and a few holds), the counters. */
const FLAG_SETTLE_COST: TxCost = {
  bytesRead: ROW_MAX.report + 32 * ROW_MAX.small,
  documentsRead: 64,
  databaseQueries: 32,
  documentsWritten: 16,
  bytesWritten: 16 * ROW_MAX.small,
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
      if (
        closed > 0 &&
        (pageIsFull(closed) || !(await batchHasRoom(ctx, FLAG_CLOSE_COST, FLAG_SETTLE_COST)))
      ) {
        break;
      }
      lead = await closeOne(ctx, actor, flag, { ...opts, lead }, effects);
      closed++;
    }
  });
  await effects.settle(ctx, opts.now);
  const rest = flags.slice(closed);
  if (rest.length > 0 && lead !== undefined) {
    await ctx.scheduler.runAfter(0, internal.inboxWrites.closeFlagsRest, {
      ...(await auditContextOf(ctx)),
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
  args: Omit<FlagCloseOpts, 'lead'> &
    AuditContext & {
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
  const { actorId: _a, flagIds: _f, undoOf, via, ...opts } = args;
  // Written under the undo and `via` its first page had (a re-close inside an undo of a reopen).
  await asContinuationOf(ctx, { undoOf, via }, () => closeFlagsUnder(ctx, actor, flags, opts));
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

/** What the reopen rule asks of a flag's target, each answered exactly. */
export type ReopenFacts = {
  /** A newer flag names this one as the flag it replaced (`supersedesFlagId`). */
  superseded: boolean;
  /** The same person has another open flag of their own on the target (any reason). */
  reporterOpen: boolean;
  /** An automatic flag of the same reason is open on the target. */
  autoOpen: boolean;
};

/** A one-row read, charged as the caller charges (an undo's offer through its reservation). */
export type OneRead = <T>(read: () => Promise<T[]>) => Promise<T[]>;
const plainOne: OneRead = (read) => read();

/**
 * **The reopen rule's facts, each an indexed point read** (PR #170) — never a scan of the target's
 * newest flags, which a much-flagged target's own rows can push the deciding one out of. Whatever the
 * target holds — one flag or five thousand — the same answer, `eq` on every field of each index:
 * `by_supersedes` (does a row name it), `by_target_flagger_status_origin` (the person's own open
 * filing on the target, an open status at a time), `by_target_status_reason_origin` (an automatic flag
 * of its reason open on the target — `origin` `'auto'` or absent, the field being optional). Each
 * `take(1)` asks "is there one", never "the first few". At most five reads.
 */
export async function reopenFactsOf(
  ctx: QueryCtx,
  flag: Doc<'contentFlags'>,
  one: OneRead = plainOne,
): Promise<ReopenFacts> {
  const t = { type: flag.targetType, id: flag.targetId };
  const superseded =
    (
      await one(() =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_supersedes', (q) => q.eq('supersedesFlagId', flag._id))
          .take(1),
      )
    ).length > 0;
  let reporterOpen = false;
  let autoOpen = false;
  for (const status of OPEN_FLAG_STATUSES) {
    if (flag.origin === 'user' && !reporterOpen) {
      const mine = await one(() =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_target_flagger_status_origin', (q) =>
            q
              .eq('targetType', t.type)
              .eq('targetId', t.id)
              .eq('flaggerId', flag.flaggerId)
              .eq('status', status)
              .eq('origin', 'user'),
          )
          .take(1),
      );
      reporterOpen = mine.some((f) => f._id !== flag._id);
    }
    if (flag.origin !== 'user') {
      for (const origin of AUTO_ORIGINS) {
        if (autoOpen) break;
        const auto = await one(() =>
          ctx.db
            .query('contentFlags')
            .withIndex('by_target_status_reason_origin', (q) =>
              q
                .eq('targetType', t.type)
                .eq('targetId', t.id)
                .eq('status', status)
                .eq('reason', flag.reason)
                .eq('origin', origin),
            )
            .take(1),
        );
        autoOpen = auto.some((f) => f._id !== flag._id);
      }
    }
  }
  return { superseded, reporterOpen, autoOpen };
}

/**
 * **Why `flag` can't reopen now, or `null`** (B01-5) — the one rule an undo's offer and its write both
 * ask. It must still be closed as a decision left it, and reopening it must not put a second open row
 * where the code keeps one: refused when a newer flag supersedes it (`supersedesFlagId`); for an
 * automatic flag, when an open automatic flag of its reason is on the target now (the auto-flag
 * bundling keeps one per target and reason, `lib/autoFlag`); for a person's flag, when that person
 * has an open flag on the target now (one open flag per flagger per target, `contentFlags.flag`).
 * Other people's open flags beside it are the ordinary case — several reporters, one item. `facts` are
 * {@link reopenFactsOf}'s exact answers.
 */
export function flagReopenRefusalOf(
  flag: Doc<'contentFlags'> | null,
  facts: ReopenFacts | null,
): string | null {
  if (!flag) return 'The flag no longer exists.';
  if (flag.status !== 'actioned' && flag.status !== 'dismissed') {
    return 'The flag has changed since, so it can’t be reopened.';
  }
  if (facts?.superseded) {
    return 'A newer flag has taken this one’s place, so it can’t be reopened.';
  }
  if (flag.origin === 'user') {
    if (facts?.reporterOpen) {
      return 'The same person has flagged this again since, so this one can’t be reopened beside it.';
    }
  } else if (facts?.autoOpen) {
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
 * Each flag is checked as the page that reaches it runs ({@link flagReopenRefusalOf} on exact facts,
 * {@link flagActorRefusal}). The lead flag of a flag decision's own undo (`alsoFlagId`) — the one the
 * undo's offer checks — refuses the whole undo when it can't reopen, so the offer and the run agree
 * (D217). Any other flag that can't, and every flag inside another undo (`withUndoOf`: a ruling's, a
 * takedown's, an alert verdict's, a restore's), is **skipped** — left closed — and named with why on
 * the undo's lead row (`metadata.flagsLeftClosed`), so the undo runs: a person who has filed again
 * already holds their question open. The gather is sized to the most any decision closes
 * ({@link DECISION_FLAGS_MAX}); past it the undo refuses. Each reopened source is synced through the
 * one writer after, so its item follows it whatever stamp its member carries (a decision from before
 * the Inbox stamped none).
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
): Promise<void> {
  const { alsoFlagId } = opts;
  const members = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_closed_by', (q) => q.eq('closedByActionId', actionId))
    .take(DECISION_FLAGS_MAX + 1);
  // More than any decision closes: refused whole, never a window's worth reopened.
  if (members.length > DECISION_FLAGS_MAX) throw new ConvexError(UNDO_TOO_LARGE);
  const ids = new Set<Id<'contentFlags'>>(alsoFlagId ? [alsoFlagId] : []);
  for (const m of members) {
    if (m.sourceTable !== 'contentFlags') continue;
    const id = ctx.db.normalizeId('contentFlags', m.sourceId);
    if (id) ids.add(id);
  }
  // Each flag checked against the reopen rule — exactly (`reopenFactsOf`) — and reopened in the
  // transaction that reaches it, a page at a time: this first page refuses a flag decision's own undo
  // whole on any flag it can't reopen; inside another undo, and on every later page, such a flag is
  // left closed and named on the undo's lead row.
  await reopenFlagStep(ctx, actor, actionId, [...ids], reason, {
    ...(alsoFlagId !== undefined ? { alsoFlagId } : {}),
    withUndoOf: opts.withUndoOf === true,
    reopenedAll: [...ids],
    now: Date.now(),
    first: true,
  });
}

/**
 * Flags an undo left closed, named on its lead row — the first row it wrote on the undone row's own
 * target (a flag decision's own undo: the lead flag's `reopen_flag` row; inside another undo, that
 * undo's row) — and taken off that row's `reopened` list, so the undo of the undo closes only what
 * reopened. The first page records what its check refused; a later page what its own check refuses
 * then (PR #170). Pages run one after another — each scheduled by the last, after it committed — so
 * no two write the row at once.
 */
async function recordLeftClosed(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  leftClosed: readonly { flagId: Id<'contentFlags'>; why: string }[],
): Promise<void> {
  if (leftClosed.length === 0) return;
  const lead = await leadRowOf(ctx, actionId);
  if (!lead) return;
  const meta = (lead.metadata ?? {}) as {
    flagsLeftClosed?: { flagId: Id<'contentFlags'>; why: string }[];
    reopened?: Id<'contentFlags'>[];
  };
  const left = new Set<string>(leftClosed.map((l) => l.flagId));
  await ctx.db.patch(lead._id, {
    metadata: {
      ...meta,
      flagsLeftClosed: [...(meta.flagsLeftClosed ?? []), ...leftClosed],
      ...(meta.reopened ? { reopened: meta.reopened.filter((id) => !left.has(id)) } : {}),
    },
  });
}

/**
 * An undo's lead row: the first row it wrote on the undone row's own target (a flag decision's own
 * undo: the lead flag's `reopen_flag` row; inside another undo, that undo's row).
 */
async function leadRowOf(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
): Promise<Doc<'moderationActions'> | undefined> {
  const undone = await ctx.db.get(actionId);
  const tagged = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', actionId))
    .take(LEAD_ROW_READ);
  return tagged.find((r) => r.targetType === undone?.targetType && r.targetId === undone?.targetId);
}

/** How one page of a flag reopen goes on: the decision's lead flag, and every flag it reopens. */
type ReopenPageOpts = {
  alsoFlagId?: Id<'contentFlags'>;
  withUndoOf: boolean;
  /** Every flag the undo reopens — this page's and the pages after — named on its lead row. */
  reopenedAll: Id<'contentFlags'>[];
  now: number;
};

/**
 * **A flag decision's undo, one page of its flags** (PR #170) — the same act on every page. Each flag
 * the page reaches is checked in this transaction, as the first page checks it: still closed by this
 * decision (a later page: its member stamped with it — an undo of the undo, or a colleague's decision,
 * stamps another), still closed at all, and able to reopen beside what is open on its target now
 * (`reopenFactsOf`, exact point reads; the actor check). One that can't is refused — the lead flag of
 * a flag decision's own undo throws, rolling the whole undo back — or left closed and recorded on the
 * lead row. One that can is put back to open, its `reopen_flag` row written, its member reconciled
 * from the patched copy (`syncReopened`) as one batch, while the transaction's live metrics hold one
 * more flag's check and reopen at their worst and every refresh the batch owes — always one at
 * least. Each target's hold and each counter moved once a page. The rest follow in
 * `inboxWrites.reopenFlagsRest`, which stops once the undo's lead row is itself undone.
 */
async function reopenFlagStep(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  actionId: Id<'moderationActions'>,
  ids: readonly Id<'contentFlags'>[],
  reason: string,
  opts: ReopenPageOpts & { first: boolean },
): Promise<void> {
  const { now, alsoFlagId } = opts;
  const targets = new Map<string, { type: string; id: string }>();
  const counted = new Map<string, { count: number; at: number }>();
  const leftClosed: { flagId: Id<'contentFlags'>; why: string }[] = [];
  let done = 0;
  const reads = reopenReads(ctx);
  await inboxBatch(ctx, async () => {
    for (const id of ids) {
      if (done > 0 && pageIsFull(done)) break;
      if (done > 0) {
        const m = await ctx.meta.getTransactionMetrics();
        const refreshes = (owedRefreshes(ctx) + 1) * refreshCost().bytesRead;
        if (
          m.bytesRead.remaining < FLAG_REOPEN_COST.bytesRead + refreshes + REOPEN_HEADROOM ||
          m.bytesWritten.remaining < FLAG_REOPEN_COST.bytesWritten + REOPEN_HEADROOM ||
          m.databaseQueries.remaining < FLAG_REOPEN_COST.databaseQueries + QUERY_HEADROOM ||
          m.documentsRead.remaining < FLAG_REOPEN_COST.documentsRead + QUERY_HEADROOM
        ) {
          break;
        }
      }
      done++;
      if (!opts.first) {
        const member = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', id))
          .first();
        if (member?.closedByActionId !== actionId) continue;
      }
      const flag = await ctx.db.get(id);
      if (!opts.first && (!flag || isOpenFlag(flag) || flag.status === 'retracted')) continue;
      const why =
        flagReopenRefusalOf(flag, flag ? await reopenFactsOf(ctx, flag) : null) ??
        flagActorRefusal(actor, flag as Doc<'contentFlags'>);
      if (why !== null) {
        // The lead flag of a flag decision's own undo: the one its offer checks (D217), so the undo
        // is refused whole. Any other flag is left closed and named.
        if (id === alsoFlagId && !opts.withUndoOf) throw new ConvexError(why);
        leftClosed.push({ flagId: id, why });
        continue;
      }
      const open = flag as Doc<'contentFlags'>;
      const resolution = open.status as FlagResolution;
      await ctx.db.patch(open._id, {
        status: 'open',
        resolvedByUserId: undefined,
        resolvedAt: undefined,
      });
      targets.set(`${open.targetType}:${open.targetId}`, {
        type: open.targetType,
        id: open.targetId,
      });
      if (open.resolvedAt !== undefined && metricDay(open.resolvedAt) === metricDay(now)) {
        const key = `${open.reason}:${resolution}`;
        counted.set(key, { count: (counted.get(key)?.count ?? 0) + 1, at: open.resolvedAt });
      }
      // A flag decision's own undo: the undone row's flag carries every reopened flag (`reopened`),
      // so the undo of this undo closes them all again in one act; the others undo with it. Inside
      // another undo, each undoes with that one.
      const lead = open._id === alsoFlagId && !opts.withUndoOf;
      await writeAudit(ctx, {
        actorId: actor._id,
        action: 'reopen_flag',
        targetType: 'contentFlag',
        targetId: open._id,
        reason,
        metadata: {
          reopens: actionId,
          prev: { status: resolution },
          ...(lead ? { reopened: opts.reopenedAll } : { withActionId: actionId }),
        },
        createdAt: now,
      });
      // Its member reopens (its item with it) from the patched copy, whatever stamp it carries.
      await syncReopened(
        ctx,
        flagSource(open._id),
        { ...open, status: 'open', resolvedByUserId: undefined, resolvedAt: undefined },
        reads,
      );
    }
  });
  // The lead row names what this page left closed (and drops it from its `reopened` list).
  await recordLeftClosed(ctx, actionId, leftClosed);
  // An open complaint holds withdrawn content back from erasure again (D248).
  for (const { type, id } of targets.values()) await holdMoved(ctx, type, id, now);
  for (const [key, { count, at }] of counted) {
    await bumpMetricMetaCounter(ctx, 'flag_dispositions', key, -count, at);
  }
  const rest = ids.slice(done);
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, internal.inboxWrites.reopenFlagsRest, {
      ...(await auditContextOf(ctx)),
      actorId: actor._id,
      actionId,
      flagIds: [...rest],
      reason,
      ...(alsoFlagId !== undefined ? { alsoFlagId } : {}),
      withUndoOf: opts.withUndoOf,
      reopenedAll: opts.reopenedAll,
      now,
    });
  }
}

/** Index ranges and documents a page keeps past its flags. */
const QUERY_HEADROOM = 200;

/**
 * A flag decision's undo, a later page: unless its lead row was undone since, the rest checked and
 * reopened as the first page does, under the undo and `via` it had.
 */
export async function reopenFlagsRestPage(
  ctx: MutationCtx,
  args: Omit<ReopenPageOpts, 'alsoFlagId'> &
    AuditContext & {
      actorId: Id<'profiles'>;
      actionId: Id<'moderationActions'>;
      flagIds: Id<'contentFlags'>[];
      reason: string;
      alsoFlagId?: Id<'contentFlags'>;
    },
): Promise<void> {
  const actor = await ctx.db.get(args.actorId);
  if (!actor) return;
  const { actorId: _a, actionId, flagIds, reason, undoOf, via, ...opts } = args;
  const lead = await leadRowOf(ctx, actionId);
  if (lead) {
    const undone = await ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', lead._id))
      .first();
    if (undone !== null) return;
  }
  await asContinuationOf(ctx, { undoOf, via }, () =>
    reopenFlagStep(ctx, actor, actionId, flagIds, reason, { ...opts, first: false }),
  );
}
