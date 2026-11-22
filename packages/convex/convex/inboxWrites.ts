/**
 * **The Inbox's decisions on a flagged item** (B01-5, *Decisions made from the Inbox* in the B01 phase
 * doc). The boards decide a flagged item with the content's own levers (2.1: *Dismiss*, *Hide*,
 * *Remove*; 2.6: *Unpin*, *Retract*; 2.7: *Hide*, *Remove*), and nothing else closes the flag, so
 * each lever is **one mutation** that writes the content's verdict through its existing path and
 * closes the flags with it:
 *
 * - `dismissFlags` closes only that item's flags, each `dismissed`;
 * - `takeDown` hides or removes the content, then closes **every** open flag on it, in every lane,
 *   each `actioned`, each user-origin flagger told (the founder's call, 2026-11-20);
 * - `alertVerdict` unpins or retracts an access alert, then closes its flags the same way;
 * - `restoreAndDismiss` is for an item whose content is already down (a flag filed before the
 *   takedown): the content restored, the item's flags dismissed;
 * - `ruleAccess` rules on an Access item's body (2.2): no public access, accessible, or the ruling
 *   cleared — through the body's own ruling (`setPublicAccessImpl`), after the Inbox's rule;
 * - `mergeDrawn` merges a skater's drawing into the known body it overlaps (2.5, B01-5d) — through
 *   the body merge (`mergeBodyInto`), after the Inbox's rule.
 *
 * Every write asks the Inbox's one rule per verb (`lib/inboxRules.ts`) before it writes, so a lever
 * the read offered is the write the server accepts; a refusal is the server's sentence, thrown as a
 * `ConvexError` the console's write helper turns into a toast (D268), never a fake success. A write on
 * a decided item is refused (D283); no staffer decides content they wrote or a flag about them (D269),
 * nor a flag they filed (D289).
 *
 * Each answers in the house result shape (`RecordWriteResult`'s): the item, the audit row the toast
 * undoes, and — only when this viewer can undo that row right now — whether the undo asks a reason.
 *
 * **These types are a published contract** (the web builders take them as landed): a change to any
 * argument or result here is called out as a contract change.
 */

import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation } from './_generated/server';
import { retractAlertImpl, setOfficialImpl } from './accessAlerts';
import { auditContextArgs, checkedReason, composed } from './lib/audit';
import { requireCapability } from './lib/auth';
import { PUBLIC_ACCESS_VERDICTS } from './lib/enums';
import {
  closeFlagsRestPage,
  closeFlagsUnder,
  isOpenFlag,
  openFlagsOn,
  reopenFlagsRestPage,
} from './lib/inboxFlags';
import { MAX_MEMBERS } from './lib/inboxItems';
import {
  assertInboxVerb,
  DECIDED_REFUSAL,
  drawnMergeFacts,
  drawnSurvivorOf,
  type InboxRuleFacts,
  SURVIVOR_CHANGED_REFUSAL,
} from './lib/inboxRules';
import { reasonFor } from './lib/peopleCan';
import { closeRequestsRestPage, decisionArgs } from './lib/requestDecisions';
import { reopenRequestsRestPage } from './lib/undoHandlersCorpus';
import { literals } from './lib/validators';
import {
  type ContentTargetType,
  RESTORE_DEFAULT_REASON,
  setContentStatus,
  undoOfferAfterWrite,
} from './moderation';
import { assertMergeFits, mergeBodyInto, setPublicAccessImpl } from './waterBodies';

// ── Results ────────────────────────────────────────────────────────────────────────────────────

/**
 * What every Inbox write answers: the item it decided, the audit row the toast's Undo undoes (the
 * first flag's for a dismissal, the content's for a takedown, the alert's for a verdict), and whether
 * this viewer can undo that row now, with whether the undo asks a reason (D226).
 */
export type InboxWriteResult = {
  itemId: Id<'inboxItems'>;
  actionId: Id<'moderationActions'>;
  /** How many flags this write closed (in every lane, for a takedown or an alert verdict). */
  flagsClosed: number;
} & ({ undoable: true; undoNeedsReason: boolean } | { undoable: false });

/** `dismissFlags`' answer: the item's flags dismissed, the first flag's row the toast's. */
export type DismissFlagsResult = InboxWriteResult;

/** `takeDown`'s answer: the content's own row the toast's, and the status it now has. */
export type TakeDownResult = InboxWriteResult & { status: 'hidden' | 'removed' };

/** `alertVerdict`'s answer: the alert's own row the toast's, and which verdict it was. */
export type AlertVerdictResult = InboxWriteResult & { verb: 'pin' | 'unpin' | 'retract' };

/** `restoreAndDismiss`'s answer: the content's restore the toast's, the item's flags dismissed. */
export type RestoreAndDismissResult = InboxWriteResult;

/**
 * `ruleAccess`'s answer: the ruling's row the toast's, and how many of the body's reports it closed —
 * every open one for a ruling either way, none for a clear (which leaves the question open again, so
 * the item stays open).
 */
export type RuleAccessResult = InboxWriteResult & { verdict: 'none' | 'open' | null };

/**
 * `mergeDrawn`'s answer: the merge's `merge_waterbody` row the toast's (its undo is the unmerge), no
 * flags closed — and which body the drawing went into, for the receipt.
 */
export type MergeDrawnResult = InboxWriteResult & { survivorId: Id<'waterBodies'> };

/** What a dismissal's row says when the moderator gave no reason (a dismissal takes nothing away). */
export const DISMISS_DEFAULT_REASON = 'Dismissed';

// ── The item, its flags, its facts ─────────────────────────────────────────────────────────────

type FlagItem = {
  item: Doc<'inboxItems'>;
  /** The item's open flags, oldest first. */
  open: Doc<'contentFlags'>[];
  targetType: Doc<'contentFlags'>['targetType'];
  targetId: string;
  facts: InboxRuleFacts;
};

/**
 * A flag item as a write reads it: the item, its open flags, the content they are about, and the facts
 * the Inbox's rule reads (`lib/inboxRules`) — the same facts the item's read draws its levers from.
 */
async function flagItemOf(ctx: MutationCtx, itemId: Id<'inboxItems'>): Promise<FlagItem> {
  const item = await ctx.db.get(itemId);
  if (!item) throw new ConvexError('No such item.');
  if (item.kind !== 'flag') throw new ConvexError('This item is not a flag on content.');
  const members = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_item_status', (q) => q.eq('itemId', itemId).eq('status', 'open'))
    .take(MAX_MEMBERS);
  const anyMember =
    members[0] ??
    (await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_item_status', (q) => q.eq('itemId', itemId).eq('status', 'closed'))
      .first());
  const open: Doc<'contentFlags'>[] = [];
  for (const m of members) {
    const id = ctx.db.normalizeId('contentFlags', m.sourceId);
    const flag = id ? await ctx.db.get(id) : null;
    if (flag && isOpenFlag(flag)) open.push(flag);
  }
  const someFlagId = anyMember ? ctx.db.normalizeId('contentFlags', anyMember.sourceId) : null;
  const some = open[0] ?? (someFlagId ? await ctx.db.get(someFlagId) : null);
  if (!some) throw new ConvexError('No such item.');
  const { targetType, targetId } = some;
  return { item, open, targetType, targetId, facts: await factsOf(ctx, targetType, targetId) };
}

const CONTENT_TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
} as const;

/** The facts the rule's preconditions read for a flag's target, as the item's read derives them. */
async function factsOf(
  ctx: MutationCtx,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
): Promise<InboxRuleFacts> {
  if (targetType === 'accessAlert') {
    const id = ctx.db.normalizeId('accessAlerts', targetId);
    const alert = id ? await ctx.db.get(id) : null;
    return {
      targetType,
      alert: alert ? { status: alert.status, pinned: alert.pinnedByUserId !== undefined } : null,
    };
  }
  if (targetType in CONTENT_TABLE) {
    const table = CONTENT_TABLE[targetType as keyof typeof CONTENT_TABLE];
    const id = ctx.db.normalizeId(table, targetId);
    const doc = id ? await ctx.db.get(id) : null;
    return {
      targetType,
      targetStatus:
        (doc as { moderationStatus?: 'visible' | 'hidden' | 'removed' } | null)?.moderationStatus ??
        null,
    };
  }
  // A photo (no moderation axis yet), a person, a body: no status the levers read.
  return { targetType, targetStatus: null };
}

/** The house answer: the item, the toast's row, the flags closed, and the undo on offer now. */
async function resultOf(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  itemId: Id<'inboxItems'>,
  actionId: Id<'moderationActions'>,
  flagsClosed: number,
): Promise<InboxWriteResult> {
  return {
    itemId,
    actionId,
    flagsClosed,
    ...(await undoOfferAfterWrite(ctx, actor._id, actionId)),
  };
}

// ── The writes ─────────────────────────────────────────────────────────────────────────────────

/**
 * *Dismiss* (2.1, 2.6, 2.7): every open flag of this item closed `dismissed`, each its own
 * `dismiss_flag` row — the first the toast's, the rest naming it (`withActionId`) — so the first's
 * undo reopens them all. Only this item's flags: a takedown is the lever that closes the content's
 * other lanes too. A dismissal takes nothing away from skaters, so its reason is optional (D226),
 * defaulted and marked so History can leave it out; the flagger hears the verdict, never the reason.
 */
export const dismissFlags = mutation({
  args: { itemId: v.id('inboxItems'), reason: v.optional(v.string()) },
  handler: async (ctx, { itemId, reason: given }): Promise<DismissFlagsResult> => {
    const actor = await requireCapability(ctx, 'inbox.flag');
    const it = await flagItemOf(ctx, itemId);
    await assertInboxVerb(ctx, actor, it.item, 'dismiss', it.facts);
    const { reason, defaulted } = reasonFor(given, false, DISMISS_DEFAULT_REASON);
    if (it.open.length === 0) throw new ConvexError('This has already been decided.');
    const lead = await closeFlagsUnder(ctx, actor, it.open, {
      resolution: 'dismissed',
      decision: 'dismissed',
      reason: checkedReason(reason),
      defaulted,
      now: Date.now(),
    });
    return resultOf(ctx, actor, itemId, lead as Id<'moderationActions'>, it.open.length);
  },
});

/**
 * *Hide* or *Remove* (2.1, 2.7): the content's status through its own writer (`setContentStatus`:
 * reports, Posts, comments, hazards — its own refusals included, D269 and D248), then **every** open
 * flag on that content closed `actioned`, in every lane, each user-origin flagger told. The content's
 * row is the toast's; each flag's `resolve_flag` row names it (`withActionId`) and each flag's Inbox
 * member is stamped with it, so its one undo restores the content and reopens them all. A takedown
 * takes something away, so it asks a reason (D226).
 */
export const takeDown = mutation({
  args: {
    itemId: v.id('inboxItems'),
    status: literals(['hidden', 'removed'] as const),
    reason: v.string(),
  },
  handler: async (ctx, { itemId, status, reason: given }): Promise<TakeDownResult> => {
    const actor = await requireCapability(ctx, 'content.moderate');
    const it = await flagItemOf(ctx, itemId);
    await assertInboxVerb(ctx, actor, it.item, status === 'hidden' ? 'hide' : 'remove', it.facts);
    const { reason } = reasonFor(given, true, '');
    const typed = checkedReason(reason);
    const now = Date.now();
    const { actionId } = await setContentStatus(ctx, actor, {
      targetType: it.targetType as ContentTargetType,
      targetId: it.targetId,
      status,
      reason: typed,
    });
    const flags = await openFlagsOn(ctx, it.targetType, it.targetId);
    await closeFlagsUnder(ctx, actor, flags, {
      resolution: 'actioned',
      decision: status,
      reason: typed,
      defaulted: false,
      now,
      lead: actionId,
    });
    return { ...(await resultOf(ctx, actor, itemId, actionId, flags.length)), status };
  },
});

/**
 * *Pin*, *Unpin* or *Retract* on a flagged access alert (2.6): the alert's own verdict through its own
 * writer — a pin (`setOfficialImpl`: official, no lapse, the moderator's name on it), a release, or a
 * moderator's retraction (which records the alert's `prev`, so its undo puts it back) — then every open
 * flag on the alert, in every lane, closed with it, each flagger told once:
 * - a pin sides with the alert, so its flags close `dismissed` and the item is decided `pinned` (a
 *   pinned alert with open flags against it would be an item nobody could finish);
 * - an unpin or a retraction sides with the flags: `actioned`, decided `unpinned` / `retracted`.
 * The alert's row is the toast's. Each asks a reason (as `setOfficial` always has; a retraction takes
 * the claim away). The pin's own refusals hold — the moderator's own alert (D269), a retracted one
 * (D248: and an author's "it's open" still resolves a pinned alert), one already pinned.
 */
export const alertVerdict = mutation({
  args: {
    itemId: v.id('inboxItems'),
    verb: literals(['pin', 'unpin', 'retract'] as const),
    reason: v.string(),
  },
  handler: async (ctx, { itemId, verb, reason: given }): Promise<AlertVerdictResult> => {
    const actor = await requireCapability(ctx, 'access.alert');
    const it = await flagItemOf(ctx, itemId);
    await assertInboxVerb(ctx, actor, it.item, verb, it.facts);
    const { reason } = reasonFor(given, true, '');
    const typed = checkedReason(reason);
    const accessAlertId = it.targetId as Id<'accessAlerts'>;
    const actionId =
      verb === 'retract'
        ? await retractAlertImpl(ctx, actor, { accessAlertId, reason: typed })
        : await setOfficialImpl(ctx, actor, {
            accessAlertId,
            official: verb === 'pin',
            reason: typed,
          });
    const flags = await openFlagsOn(ctx, it.targetType, it.targetId);
    await closeFlagsUnder(ctx, actor, flags, {
      resolution: verb === 'pin' ? 'dismissed' : 'actioned',
      decision: verb === 'pin' ? 'pinned' : verb === 'unpin' ? 'unpinned' : 'retracted',
      reason: typed,
      defaulted: false,
      now: Date.now(),
      lead: actionId,
    });
    return { ...(await resultOf(ctx, actor, itemId, actionId, flags.length)), verb };
  },
});

/**
 * *Restore* (2.1, 2.7) for an item whose content is already down — flagged before a takedown made from
 * elsewhere: the content restored through its own writer (a Post that would come back empty is
 * refused, D247 — its Restore is on the record sheet, where the choice lives), then the item's flags
 * closed `dismissed`, stamped with the restore's row. The restore's row is the toast's. A restore gives
 * something back, so a reason is optional (D226), defaulted as the record sheet's restore defaults it.
 */
export const restoreAndDismiss = mutation({
  args: { itemId: v.id('inboxItems'), reason: v.optional(v.string()) },
  handler: async (ctx, { itemId, reason: given }): Promise<RestoreAndDismissResult> => {
    const actor = await requireCapability(ctx, 'content.moderate');
    const it = await flagItemOf(ctx, itemId);
    await assertInboxVerb(ctx, actor, it.item, 'restore', it.facts);
    const { reason, defaulted } = reasonFor(given, false, RESTORE_DEFAULT_REASON);
    const typed = checkedReason(reason);
    const { actionId } = await setContentStatus(ctx, actor, {
      targetType: it.targetType as ContentTargetType,
      targetId: it.targetId,
      status: 'visible',
      reason: typed,
      ...(defaulted ? { reasonDefaulted: true } : {}),
    });
    await closeFlagsUnder(ctx, actor, it.open, {
      resolution: 'dismissed',
      decision: 'restored',
      reason: typed,
      defaulted,
      now: Date.now(),
      lead: actionId,
    });
    return resultOf(ctx, actor, itemId, actionId, it.open.length);
  },
});

/** Each ruling's verb in the Inbox's rule (`lib/inboxRules`). */
const RULING_VERB = { none: 'ruleClosed', open: 'ruleAccessible', clear: 'clearRuling' } as const;

/**
 * *No public access*, *Accessible* or *Clear the ruling* on an Access item (2.2): the Inbox's rule
 * first (D217; a decided item, D283; a report the viewer filed, D289; the body's own preconditions),
 * then the body's own ruling (`setPublicAccessImpl`, as the Body console's lever runs it). A ruling
 * either way closes every open report on the body — `actioned` (`ruled_closed`) or `dismissed`
 * (`ruled_accessible`), each reporter told, each report's Inbox member stamped with the ruling's row —
 * so the item is decided by it. A clear leaves the reports open: the question is unsettled again, and
 * the item stays open. The ruling's row is the toast's; its undo rules `prev` again and reopens the
 * reports and the item. *No public access* takes the body off the active map, so it asks a reason
 * (D226); the others take one if given.
 */
export const ruleAccess = mutation({
  args: {
    itemId: v.id('inboxItems'),
    verdict: v.union(literals(PUBLIC_ACCESS_VERDICTS), v.null()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { itemId, verdict, reason: given }): Promise<RuleAccessResult> => {
    const actor = await requireCapability(ctx, 'access.rule');
    const item = await ctx.db.get(itemId);
    if (!item) throw new ConvexError('No such item.');
    if (item.kind !== 'access' || item.waterBodyId === undefined) {
      throw new ConvexError('This item is not an access question.');
    }
    const waterBodyId = item.waterBodyId;
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    await assertInboxVerb(ctx, actor, item, RULING_VERB[verdict ?? 'clear'], {
      hasRuling: body.publicAccess !== undefined,
    });
    const typed = given?.trim() ? checkedReason(given) : undefined;
    if (verdict === 'none' && typed === undefined) throw new ConvexError('A reason is required');
    const open = verdict === null ? 0 : (await openAccessReports(ctx, waterBodyId)).length;
    const actionId = await setPublicAccessImpl(ctx, actor, {
      waterBodyId,
      verdict,
      ...(typed !== undefined ? { reason: typed } : {}),
    });
    return { ...(await resultOf(ctx, actor, itemId, actionId, open)), verdict };
  },
});

/**
 * *Merge into ‹body›* on a Drawn item (2.5, B01-5d): the skater's drawing merged into the known body
 * it overlaps. In order:
 *
 * 1. **The Inbox's rule** (`lib/inboxRules`), as every write here asks it: both capabilities
 *    (`inbox.drawnBody`, `corpus.duplicates`), a decided item (D283), the viewer's own drawing (D289),
 *    and an overlap — the drawing's live survivor (`drawnSurvivorOf`), the one function the item's
 *    `can` and its bar read too.
 * 2. **The survivor the bar showed is still that survivor**: the page may be minutes old, and a merge
 *    into a body the moderator didn't see is refused, never redirected.
 * 3. **The merge fits one transaction** (`lib/mergeLoad`, the preview's own answer).
 *
 * Then `mergeBodyInto`: every child re-pointed, `reviewStatus: 'merged'`, the item decided with the
 * merge's row, the drawer told through the settle queue (D285). A reason is optional — the merge's row
 * says what it did — and the merge's row is the toast's.
 */
export const mergeDrawn = mutation({
  args: {
    itemId: v.id('inboxItems'),
    /** The survivor the bar showed; refused if the drawing's live survivor is now another body. */
    survivorId: v.id('waterBodies'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { itemId, survivorId, reason: given }): Promise<MergeDrawnResult> => {
    const actor = await requireCapability(ctx, 'inbox.drawnBody');
    const item = await ctx.db.get(itemId);
    if (!item) throw new ConvexError('No such item.');
    if (item.kind !== 'drawn' || item.waterBodyId === undefined) {
      throw new ConvexError('This item is not a drawn body.');
    }
    const drawn = await ctx.db.get(item.waterBodyId);
    if (!drawn) throw new ConvexError('Water body not found');
    const live = await drawnSurvivorOf(drawn, (id) => ctx.db.get(id));
    await assertInboxVerb(ctx, actor, item, 'mergeDrawn', drawnMergeFacts(drawn, live));
    if (!live || live.survivor._id !== survivorId) throw new ConvexError(SURVIVOR_CHANGED_REFUSAL);
    // Reviewed or merged since the item was decided by the reconcile's last look: the rule's word.
    if (drawn.reviewStatus !== 'pending' || drawn.dedupStatus === 'merged') {
      throw new ConvexError(DECIDED_REFUSAL);
    }
    const typed = given?.trim() ? checkedReason(given) : undefined;
    // The overlap was measured above, in this transaction: both outlines are the geometry's too.
    await assertMergeFits(ctx, drawn, live.survivor, { overlap: true });
    const { actionId } = await mergeBodyInto(ctx, {
      survivor: live.survivor,
      loser: drawn,
      actorId: actor._id,
      reason: typed ?? composed`Merged into ${live.survivor.name}`,
    });
    return { ...(await resultOf(ctx, actor, itemId, actionId, 0)), survivorId };
  },
});

/** The body's open reports a ruling closes (the same range `setPublicAccessImpl` reads). */
function openAccessReports(ctx: MutationCtx, waterBodyId: Id<'waterBodies'>) {
  return ctx.db
    .query('contentFlags')
    .withIndex('by_target_status_reason', (q) =>
      q
        .eq('targetType', 'waterbody')
        .eq('targetId', waterBodyId as string)
        .eq('status', 'open')
        .eq('reason', 'no_public_access'),
    )
    .collect();
}

/**
 * A flag decision's later page (`lib/inboxFlags.closeFlagsUnder`): the flags its first page had no
 * room for, closed under the same decision row, page by page, until none is left — or stopped once the
 * decision is undone.
 */
export const closeFlagsRest = internalMutation({
  args: {
    ...auditContextArgs,
    actorId: v.id('profiles'),
    flagIds: v.array(v.id('contentFlags')),
    resolution: literals(['actioned', 'dismissed'] as const),
    decision: literals([
      'dismissed',
      'actioned',
      'hidden',
      'removed',
      'pinned',
      'unpinned',
      'retracted',
      'restored',
      'ruled_closed',
      'ruled_accessible',
    ] as const),
    reason: v.string(),
    defaulted: v.boolean(),
    now: v.number(),
    lead: v.id('moderationActions'),
    perFlagRows: v.boolean(),
  },
  handler: async (ctx, args) => {
    await closeFlagsRestPage(ctx, args);
  },
});

/**
 * A request decision's undo, a later page (`lib/undoHandlersCorpus.reopenRequestPage`): the asks its
 * first page had no room for, reopened page by page — or stopped once the reopen is undone.
 */
export const reopenRequestsRest = internalMutation({
  args: {
    ...auditContextArgs,
    decisionId: v.id('moderationActions'),
    reopenRowId: v.id('moderationActions'),
    ids: v.array(v.id('waterBodyRequests')),
    actorId: v.id('profiles'),
  },
  handler: async (ctx, args) => {
    await reopenRequestsRestPage(ctx, args);
  },
});

/**
 * Named asks closed under a decision, a later page (`lib/requestDecisions.closeRequestPage` — a
 * re-decline over what a reopen reopened), or stopped once that decision is undone.
 */
export const closeRequestsRest = internalMutation({
  args: { ...decisionArgs, ids: v.array(v.id('waterBodyRequests')) },
  handler: async (ctx, args) => {
    await closeRequestsRestPage(ctx, args);
  },
});

/**
 * A flag decision's undo, a later page (`lib/inboxFlags.reopenFlagStep`): the flags its first page had
 * no room for, each reopened while the decision still holds it closed.
 */
export const reopenFlagsRest = internalMutation({
  args: {
    ...auditContextArgs,
    actorId: v.id('profiles'),
    actionId: v.id('moderationActions'),
    flagIds: v.array(v.id('contentFlags')),
    reason: v.string(),
    alsoFlagId: v.optional(v.id('contentFlags')),
    withUndoOf: v.boolean(),
    reopenedAll: v.array(v.id('contentFlags')),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await reopenFlagsRestPage(ctx, args);
  },
});
