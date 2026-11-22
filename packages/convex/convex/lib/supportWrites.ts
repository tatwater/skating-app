/**
 * **The support writes an undo also runs** (B01-5f, D284): a ticket resolved or reopened, a note
 * removed or put back, a reply canceled — each its own audit row, each the one path both the forward
 * write (`support.ts`) and the undo handler (`lib/undoHandlersSupport`) take, so the undo runs the same
 * side effects (the Inbox item decided or reopened). Kept apart from `support.ts`, whose writes answer
 * with the undo engine's offer, so the engine's handlers import no module that imports the engine.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { writeAudit } from './audit';
import { decideItem, fileMember, ticketSource } from './inboxItems';
import {
  SUPPORT_REASONS,
  type SupportUndoVerb,
  supportUndoRefusal,
  TICKET_GONE_REFUSAL,
} from './supportThread';

type Actor = Doc<'profiles'>;

/**
 * Asks the support undo's one rule (`lib/supportThread.supportUndoRefusal`) inside the write itself, so
 * an undo whose offer was right when drawn still refuses in the same words if the row moved since.
 */
async function assertSupportUndo(
  ctx: MutationCtx,
  actor: Actor,
  verb: SupportUndoVerb,
  ticketId: Id<'supportTickets'>,
  messageId: Id<'supportMessages'> | undefined,
  now: number,
): Promise<{ ticket: Doc<'supportTickets'>; message: Doc<'supportMessages'> | null }> {
  const ticket = await ctx.db.get(ticketId);
  const message = messageId ? await ctx.db.get(messageId) : null;
  const refused = supportUndoRefusal(actor, verb, {
    ticket,
    ...(messageId ? { message } : {}),
    now,
  });
  if (refused !== null || !ticket) throw new ConvexError(refused ?? TICKET_GONE_REFUSAL);
  return { ticket, message };
}

/** The ticket resolved, its item decided by the row; returns the `resolve_ticket` row. */
export async function resolveTicketImpl(
  ctx: MutationCtx,
  actor: Actor,
  args: { ticketId: Id<'supportTickets'>; now: number; asUndo?: boolean },
): Promise<Id<'moderationActions'>> {
  const { ticket } = args.asUndo
    ? await assertSupportUndo(ctx, actor, 'resolve', args.ticketId, undefined, args.now)
    : { ticket: (await ctx.db.get(args.ticketId)) as Doc<'supportTickets'> };
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'resolve_ticket',
    targetType: 'supportTicket',
    targetId: args.ticketId,
    reason: SUPPORT_REASONS.resolve_ticket,
    metadata: { prev: { status: ticket.status }, reasonDefaulted: true },
    createdAt: args.now,
  });
  await ctx.db.patch(args.ticketId, {
    status: 'resolved',
    resolvedByUserId: actor._id,
    resolvedAt: args.now,
  });
  await decideItem(ctx, ticketSource(args.ticketId), {
    now: args.now,
    actorId: actor._id,
    actionId,
  });
  return actionId;
}

/** The ticket open again, its item reopened in place; returns the `reopen_ticket` row. */
export async function reopenTicketImpl(
  ctx: MutationCtx,
  actor: Actor,
  args: { ticketId: Id<'supportTickets'>; now: number; asUndo?: boolean },
): Promise<Id<'moderationActions'>> {
  const { ticket } = args.asUndo
    ? await assertSupportUndo(ctx, actor, 'reopen', args.ticketId, undefined, args.now)
    : { ticket: (await ctx.db.get(args.ticketId)) as Doc<'supportTickets'> };
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'reopen_ticket',
    targetType: 'supportTicket',
    targetId: args.ticketId,
    reason: SUPPORT_REASONS.reopen_ticket,
    metadata: {
      prev: {
        status: ticket.status,
        ...(ticket.resolvedAt !== undefined ? { resolvedAt: ticket.resolvedAt } : {}),
        ...(ticket.resolvedByUserId !== undefined
          ? { resolvedByUserId: ticket.resolvedByUserId }
          : {}),
      },
      reasonDefaulted: true,
    },
    createdAt: args.now,
  });
  // `open`, never `in_progress`; nothing writes an assignee (D284).
  await ctx.db.patch(args.ticketId, {
    status: 'open',
    resolvedByUserId: undefined,
    resolvedAt: undefined,
  });
  // Open again: its member reopens into its decided item, in place (or the newer open one).
  await fileMember(ctx, ticketSource(args.ticketId), { now: args.now });
  return actionId;
}

/** A note soft-removed (a note's undo); writes `remove_support_note`. */
export async function removeNoteImpl(
  ctx: MutationCtx,
  actor: Actor,
  args: { ticketId: Id<'supportTickets'>; messageId: Id<'supportMessages'>; now: number },
): Promise<Id<'moderationActions'>> {
  await assertSupportUndo(ctx, actor, 'removeNote', args.ticketId, args.messageId, args.now);
  await ctx.db.patch(args.messageId, { removedAt: args.now });
  return writeAudit(ctx, {
    actorId: actor._id,
    action: 'remove_support_note',
    targetType: 'supportTicket',
    targetId: args.ticketId,
    reason: SUPPORT_REASONS.remove_support_note,
    metadata: { messageId: args.messageId, kind: 'note', reasonDefaulted: true },
    createdAt: args.now,
  });
}

/** A removed note put back (a removal's undo); writes `support_note` again, naming the same note. */
export async function restoreNoteImpl(
  ctx: MutationCtx,
  actor: Actor,
  args: { ticketId: Id<'supportTickets'>; messageId: Id<'supportMessages'>; now: number },
): Promise<Id<'moderationActions'>> {
  await assertSupportUndo(ctx, actor, 'restoreNote', args.ticketId, args.messageId, args.now);
  await ctx.db.patch(args.messageId, { removedAt: undefined });
  return writeAudit(ctx, {
    actorId: actor._id,
    action: 'support_note',
    targetType: 'supportTicket',
    targetId: args.ticketId,
    reason: SUPPORT_REASONS.support_note,
    metadata: { messageId: args.messageId, kind: 'note', restored: true, reasonDefaulted: true },
    createdAt: args.now,
  });
}

/** A settling reply canceled (a reply's undo); writes `cancel_support_reply`. Nothing is sent. */
export async function cancelReplyImpl(
  ctx: MutationCtx,
  actor: Actor,
  args: { ticketId: Id<'supportTickets'>; messageId: Id<'supportMessages'>; now: number },
): Promise<Id<'moderationActions'>> {
  await assertSupportUndo(ctx, actor, 'cancelReply', args.ticketId, args.messageId, args.now);
  await ctx.db.patch(args.messageId, { status: 'canceled' });
  return writeAudit(ctx, {
    actorId: actor._id,
    action: 'cancel_support_reply',
    targetType: 'supportTicket',
    targetId: args.ticketId,
    reason: SUPPORT_REASONS.cancel_support_reply,
    metadata: { messageId: args.messageId, kind: 'reply', reasonDefaulted: true },
    createdAt: args.now,
  });
}
