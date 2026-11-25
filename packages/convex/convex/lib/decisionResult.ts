/**
 * **What a decision answers** — the Inbox's (`InboxDecisionResult`) and, from B01-6a, Corpus's
 * (`CorpusDecisionResult`), side by side; the Inbox's name is kept, since its importers predate the
 * second mode.
 *
 * **A request or drawing decision** (B01-5c): the Inbox writes' shape (`InboxWriteResult`
 * in `inboxWrites.ts`) — the item the decision decided, the decision's own audit row (the one the
 * toast's Undo undoes), and whether this viewer can undo that row now, read by the undo engine's own
 * rule (`undoOfferAfterWrite`, the reading `undo.run` makes) — asked through `ctx.runQuery`
 * (`moderation.undoOfferForRow`), never imported: the engine's handlers import `waterBodies.ts`, one
 * of this module's callers, so a static import here would close a cycle. So the toast never looks up "the latest
 * action on the ask", a second rule that another staffer's later action or a paged drain can make
 * disagree with the write.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { InboxSource } from './inboxItems';

/** What the undo engine offers this viewer for a row, now. */
export type UndoOffer = { undoable: true; undoNeedsReason: boolean } | { undoable: false };

export type InboxDecisionResult = {
  /** The Inbox item the decision decided; `null` for a source that is no item (a script's ask, D289). */
  itemId: Id<'inboxItems'> | null;
  /** The decision's own audit row: the primary ask's `approve_request` / `decline_request`, or the drawing's review. */
  actionId: Id<'moderationActions'>;
} & UndoOffer;

/** The answer for `source`'s decision, written as `actionId` by `actorId`. */
export async function inboxDecisionResult(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  source: InboxSource,
  actionId: Id<'moderationActions'>,
): Promise<InboxDecisionResult> {
  // One member a source (`by_source` is the member's identity), so `first()` is the lookup.
  const member = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_source', (q) => q.eq('sourceTable', source.table).eq('sourceId', source.id))
    .first();
  // A nested query in this transaction: it reads the decision just written.
  const offer: UndoOffer = await ctx.runQuery(internal.moderation.undoOfferForRow, {
    actorId,
    actionId,
  });
  return { itemId: member?.itemId ?? null, actionId, ...offer };
}

/**
 * **What a Corpus task decision answers** (B01-6a): the task it decided, the audit row the decision
 * wrote (the domain write's own row — `set_water_body_name`, `set_class` — or `settle_review_reason`
 * for a settle-only outcome; the toast's Undo undoes it), and the undo offer, read as
 * `inboxDecisionResult` reads it.
 */
export type CorpusDecisionResult = {
  taskId: Id<'corpusTasks'>;
  actionId: Id<'moderationActions'>;
} & UndoOffer;

/** The answer for the decision on `taskId`, written as `actionId` by `actorId`. */
export async function corpusDecisionResult(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  taskId: Id<'corpusTasks'>,
  actionId: Id<'moderationActions'>,
): Promise<CorpusDecisionResult> {
  // A nested query in this transaction: it reads the decision just written.
  const offer: UndoOffer = await ctx.runQuery(internal.moderation.undoOfferForRow, {
    actorId,
    actionId,
  });
  return { taskId, actionId, ...offer };
}
