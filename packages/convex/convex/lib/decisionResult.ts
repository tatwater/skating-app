/**
 * **What a request or drawing decision answers** (B01-5c): the Inbox writes' shape (`InboxWriteResult`
 * in `inboxWrites.ts`) — the item the decision decided, the decision's own audit row (the one the
 * toast's Undo undoes), and whether this viewer can undo that row now, read by the undo engine's own
 * rule (`undoOfferAfterWrite`, the reading `undo.run` makes). So the toast never looks up "the latest
 * action on the ask", a second rule that another staffer's later action or a paged drain can make
 * disagree with the write.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { undoOfferAfterWrite } from '../moderation';
import type { InboxSource } from './inboxItems';

export type InboxDecisionResult = {
  /** The Inbox item the decision decided; `null` for a source that is no item (a script's ask, D289). */
  itemId: Id<'inboxItems'> | null;
  /** The decision's own audit row: the primary ask's `approve_request` / `decline_request`, or the drawing's review. */
  actionId: Id<'moderationActions'>;
} & ({ undoable: true; undoNeedsReason: boolean } | { undoable: false });

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
  return {
    itemId: member?.itemId ?? null,
    actionId,
    ...(await undoOfferAfterWrite(ctx, actorId, actionId)),
  };
}
