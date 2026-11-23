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
import { askerShown, type FailedWhy, type ReplyStatus, type TicketItem } from './ticketModel';
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
/** A note or a reply, and the press's own key: the same press sent twice writes once (the server's). */
type MessageArgs = TicketArgs & { body: string; clientKey: string };
type MessageIdArgs = { messageId: Id<'supportMessages'> };

/** What `support.reply` answers of the reply as it stands. */
export type ReplyAnswer = WriteAnswer & {
  status: ReplyStatus;
  failedWhy?: FailedWhy | null | undefined;
};

/** The six writes, as the handler calls them (a story or a test fakes them). */
export type TicketServer = {
  reply: (args: MessageArgs) => Promise<ReplyAnswer>;
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

/** A reply's receipt from what `support.reply` answered (a repeat key answers the reply as it stands). */
export function replyReceipt(answer: Pick<ReplyAnswer, 'status' | 'failedWhy'> | null): {
  title: string;
  description?: string;
} {
  switch (answer?.status) {
    case 'failed':
      return answer.failedWhy === 'outcomeUnknown'
        ? { title: W.outcomeUnknown }
        : {
            title: W.replySaved,
            description: W.replyWontSend(
              answer.failedWhy == null ? W.notSentUnknown : W.notSentWhy[answer.failedWhy],
            ),
          };
    case 'sent':
      return { title: W.sent };
    case 'canceled':
      return { title: W.replyCanceled, description: W.replyCanceledDetail };
    default:
      return { title: W.replyQueued, description: W.replyQueuedDetail };
  }
}

export type TicketAct = 'reply' | 'note' | 'resolve' | 'reopen' | 'removeNote' | 'cancelReply';

/** Every write lands on the ticket: the receipt's Undo looks there, and History files it there. */
const landedOn = (ticketId: string, answer: WriteAnswer): Landed => ({
  target: { targetType: 'supportTicket', targetId: ticketId } satisfies UndoTarget,
  answer,
});

export type TicketWrites = {
  /** Each resolves whether it landed: the dock clears its draft only on `true`. */
  reply: (body: string, clientKey: string) => Promise<boolean>;
  note: (body: string, clientKey: string) => Promise<boolean>;
  resolve: () => Promise<boolean>;
  reopen: () => Promise<boolean>;
  removeNote: (messageId: string) => Promise<boolean>;
  cancelReply: (messageId: string) => Promise<boolean>;
  pending: TicketAct | null;
};

export function useTicketWrites(
  item: Pick<TicketItem, 'itemId' | 'ticket' | 'person'>,
  server: TicketServer,
): TicketWrites {
  const { run, pending } = useDecisionRunner<TicketAct>({
    itemId: item.itemId,
    subject: W.subject(askerShown(item)),
  });
  const ticketId = item.ticket.ticketId;
  const reply = useCallback(
    (body: string, clientKey: string) => {
      // The receipt is what the write answered: a reply the server stored as not sent (no sender or
      // email service set up, a test person's ticket) says so, never "sends in a minute".
      let answered: ReplyAnswer | null = null;
      return run({
        act: 'reply',
        what: W.theReply,
        write: async () => {
          answered = await server.reply({ ticketId, body, clientKey });
          return landedOn(ticketId, answered);
        },
        receipt: { title: W.replyQueued, description: W.replyQueuedDetail },
        receiptOf: () => replyReceipt(answered),
      } satisfies Decision<TicketAct>);
    },
    [run, server, ticketId],
  );
  const note = useCallback(
    (body: string, clientKey: string) =>
      run({
        act: 'note',
        what: W.theNote,
        write: async () => landedOn(ticketId, await server.addNote({ ticketId, body, clientKey })),
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
