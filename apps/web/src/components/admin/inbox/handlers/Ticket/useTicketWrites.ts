import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback, useMemo } from 'react';

import type { UndoTarget } from '../../../shell/undo';
import {
  type Decision,
  type Landed,
  useDecisionRunner,
  type WriteAnswer,
} from '../../actions/useDecisionRunner';
import { askerShown, type TicketItem } from './ticketModel';
import { TICKET_WORDS as W } from './ticketWords';

/**
 * **The ticket handler's writes** (board 2.8, D284): *Send reply* is `support.reply` (⌘⏎), *Add
 * note* `support.addNote`, *Resolve* `support.resolve` (R), *Reopen* `support.reopen`, a note's
 * *Remove* `support.removeNote` and a settling reply's *Cancel* `support.cancelReply` — each with
 * the open item's ids, each through the Inbox's decision runner (`useDecisionRunner`): a refusal is
 * one toast in the server's words (D268), never printed in place; a landed write raises the shell's
 * receipt, its Undo from the write's own answer. Nothing optimistic: the thread draws what the read
 * says.
 */

type TicketArgs = { ticketId: Id<'supportTickets'> };
type MessageArgs = TicketArgs & { body: string };
type MessageIdArgs = { messageId: Id<'supportMessages'> };

/** The six writes, as the handler calls them (a story or a test fakes them). */
export type TicketServer = {
  reply: (args: MessageArgs) => Promise<WriteAnswer>;
  addNote: (args: MessageArgs) => Promise<WriteAnswer>;
  resolve: (args: TicketArgs) => Promise<WriteAnswer>;
  reopen: (args: TicketArgs) => Promise<WriteAnswer>;
  removeNote: (args: MessageIdArgs) => Promise<WriteAnswer>;
  cancelReply: (args: MessageIdArgs) => Promise<WriteAnswer>;
};

export function useTicketServer(): TicketServer {
  const reply = useMutation(api.support.reply);
  const addNote = useMutation(api.support.addNote);
  const resolve = useMutation(api.support.resolve);
  const reopen = useMutation(api.support.reopen);
  const removeNote = useMutation(api.support.removeNote);
  const cancelReply = useMutation(api.support.cancelReply);
  return useMemo(
    () => ({ reply, addNote, resolve, reopen, removeNote, cancelReply }),
    [reply, addNote, resolve, reopen, removeNote, cancelReply],
  );
}

export type TicketAct = 'reply' | 'note' | 'resolve' | 'reopen' | 'removeNote' | 'cancelReply';

/** Every write lands on the ticket: the receipt's Undo looks there, and History files it there. */
const landedOn = (ticketId: string, answer: WriteAnswer): Landed => ({
  target: { targetType: 'supportTicket', targetId: ticketId } satisfies UndoTarget,
  answer,
});

export type TicketWrites = {
  /** Each resolves whether it landed: the dock clears its draft only on `true`. */
  reply: (body: string) => Promise<boolean>;
  note: (body: string) => Promise<boolean>;
  resolve: () => Promise<boolean>;
  reopen: () => Promise<boolean>;
  removeNote: (messageId: string) => Promise<boolean>;
  cancelReply: (messageId: string) => Promise<boolean>;
  pending: TicketAct | null;
};

export function useTicketWrites(
  item: Pick<TicketItem, 'itemId' | 'ticket' | 'person' | 'replyBlocked'>,
  server: TicketServer,
): TicketWrites {
  const { run, pending } = useDecisionRunner<TicketAct>({
    itemId: item.itemId,
    subject: W.subject(askerShown(item)),
  });
  const ticketId = item.ticket.ticketId;
  // A reply the server won't send (no sender set up, a test person's ticket) is saved, never "on its
  // way": the receipt says what the read's `replyBlocked` says, as the dock did before it was written.
  const blocked = item.replyBlocked;
  const reply = useCallback(
    (body: string) =>
      run({
        act: 'reply',
        what: W.theReply,
        write: async () => landedOn(ticketId, await server.reply({ ticketId, body })),
        receipt:
          blocked === null
            ? { title: W.replyQueued, description: W.replyQueuedDetail }
            : { title: W.replySaved, description: W.replyWontSend(W.notSentWhy[blocked]) },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId, blocked],
  );
  const note = useCallback(
    (body: string) =>
      run({
        act: 'note',
        what: W.theNote,
        write: async () => landedOn(ticketId, await server.addNote({ ticketId, body })),
        receipt: { title: W.noteAdded, description: W.noteAddedDetail },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId],
  );
  const resolve = useCallback(
    () =>
      run({
        act: 'resolve',
        what: W.theDecision,
        write: async () => landedOn(ticketId, await server.resolve({ ticketId })),
        receipt: { title: W.resolved, description: W.resolvedDetail },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId],
  );
  const reopen = useCallback(
    () =>
      run({
        act: 'reopen',
        what: W.theDecision,
        write: async () => landedOn(ticketId, await server.reopen({ ticketId })),
        receipt: { title: W.reopened, description: W.reopenedDetail },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId],
  );
  const removeNote = useCallback(
    (messageId: string) =>
      run({
        act: 'removeNote',
        what: W.theRemoval,
        write: async () =>
          landedOn(
            ticketId,
            await server.removeNote({ messageId: messageId as Id<'supportMessages'> }),
          ),
        receipt: { title: W.noteRemovedReceipt },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId],
  );
  const cancelReply = useCallback(
    (messageId: string) =>
      run({
        act: 'cancelReply',
        what: W.theCancel,
        write: async () =>
          landedOn(
            ticketId,
            await server.cancelReply({ messageId: messageId as Id<'supportMessages'> }),
          ),
        receipt: { title: W.replyCanceled, description: W.replyCanceledDetail },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId],
  );
  return { reply, note, resolve, reopen, removeNote, cancelReply, pending };
}
