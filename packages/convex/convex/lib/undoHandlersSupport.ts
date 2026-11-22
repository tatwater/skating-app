/**
 * **The support verbs' undos** (B01-5f, D284) — the code half of their `undoPolicy.ts` rows:
 *
 * - `support_note` → the note soft-removed (`remove_support_note`); that removal's undo puts it back,
 *   writing `support_note` again for the same note;
 * - `support_reply` → canceled (`cancel_support_reply`) while it settles; once it went, or is on its
 *   way, refused: "Sent replies can't be unsent". A cancel has no undo of its own (the policy's `none`);
 * - `resolve_ticket` → reopened (`reopen_ticket`), whose undo resolves it again.
 *
 * **The offer and the run share one refusal** (`lib/supportThread.supportUndoRefusal`) in one order:
 * the capability, the ticket's own state for its state verbs, the staffer's own filing (D289), then the
 * message as it stands. A note's or a reply's row names its ticket, which every other message also
 * names, so it isn't overtaken by them (`overtakenByTarget: false`): its refusal reads its own message
 * instead.
 */

import type { Doc, Id } from '../_generated/dataModel';
import {
  cancelReplyImpl,
  removeNoteImpl,
  reopenTicketImpl,
  resolveTicketImpl,
  restoreNoteImpl,
} from '../support';
import { ROW_MAX } from './readBudget';
import { type SupportUndoVerb, supportUndoRefusal } from './supportThread';
import { UNDO_POLICY } from './undoPolicy';
import { meta, type UndoCall, type UndoHandler } from './undoTypes';

const ticketIdOf = (row: Doc<'moderationActions'>) => row.targetId as Id<'supportTickets'>;
const messageIdOf = (row: Doc<'moderationActions'>) =>
  meta(row).messageId as Id<'supportMessages'> | undefined;

/** A row from before its message was named can't say which message to undo. */
const MESSAGE_UNNAMED = 'This row doesn’t name its message, so it can’t be undone here.';

/** A support undo: its refusal over the ticket (and message) as they stand, and its run. */
function supportUndo(
  verb: SupportUndoVerb,
  takesAway: () => boolean,
  run: (
    call: UndoCall,
    ticketId: Id<'supportTickets'>,
    messageId: Id<'supportMessages'>,
  ) => Promise<unknown>,
): UndoHandler {
  const onMessage = verb === 'removeNote' || verb === 'restoreNote' || verb === 'cancelReply';
  return {
    ...(onMessage ? { overtakenByTarget: false as const } : {}),
    blocked: (row) => (onMessage && messageIdOf(row) === undefined ? MESSAGE_UNNAMED : null),
    undoTakesAway: takesAway,
    refusalCost: () => ({
      bytes: ROW_MAX.supportTicket + (onMessage ? ROW_MAX.supportMessage : 0),
      reads: onMessage ? 2 : 1,
    }),
    refusal: async (_ctx, row, read, viewer) => {
      const ticket = await read.row<'supportTickets'>('supportTicket', ticketIdOf(row));
      const messageId = messageIdOf(row);
      const message =
        onMessage && messageId
          ? await read.row<'supportMessages'>('supportMessage', messageId)
          : undefined;
      return supportUndoRefusal(viewer, verb, {
        ticket,
        ...(onMessage ? { message: message ?? null } : {}),
        now: Date.now(),
      });
    },
    run: async (call) => {
      await run(call, ticketIdOf(call.row), messageIdOf(call.row) as Id<'supportMessages'>);
    },
  };
}

export const SUPPORT_UNDO_HANDLERS = {
  support_note: supportUndo(
    'removeNote',
    () => UNDO_POLICY.support_note.takesAway(),
    ({ ctx, actor }, ticketId, messageId) =>
      removeNoteImpl(ctx, actor, { ticketId, messageId, now: Date.now() }),
  ),
  remove_support_note: supportUndo(
    'restoreNote',
    () => UNDO_POLICY.remove_support_note.takesAway(),
    ({ ctx, actor }, ticketId, messageId) =>
      restoreNoteImpl(ctx, actor, { ticketId, messageId, now: Date.now() }),
  ),
  support_reply: supportUndo(
    'cancelReply',
    () => UNDO_POLICY.support_reply.takesAway(),
    ({ ctx, actor }, ticketId, messageId) =>
      cancelReplyImpl(ctx, actor, { ticketId, messageId, now: Date.now() }),
  ),
  resolve_ticket: supportUndo(
    'reopen',
    () => UNDO_POLICY.resolve_ticket.takesAway(),
    ({ ctx, actor }, ticketId) =>
      reopenTicketImpl(ctx, actor, { ticketId, now: Date.now(), asUndo: true }),
  ),
  reopen_ticket: supportUndo(
    'resolve',
    () => UNDO_POLICY.reopen_ticket.takesAway(),
    ({ ctx, actor }, ticketId) =>
      resolveTicketImpl(ctx, actor, { ticketId, now: Date.now(), asUndo: true }),
  ),
} satisfies Record<string, UndoHandler>;
