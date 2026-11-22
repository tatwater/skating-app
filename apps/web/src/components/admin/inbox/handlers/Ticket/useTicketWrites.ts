import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { type FunctionReference, makeFunctionReference } from 'convex/server';
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
 * note* `support.addNote`, *Resolve* `support.resolve` (R), *Reopen* `support.reopen` — each with
 * the open item's ticket id, each through the Inbox's decision runner (`useDecisionRunner`): a
 * refusal is one toast in the server's words (D268), never printed in place; a landed write raises
 * the shell's receipt, its Undo from the write's own answer — a note's removes it, a reply's cancels
 * it while it settles (once sent, the server's undo refuses: "Sent replies can't be unsent"), a
 * resolve's reopens. Nothing optimistic: the thread draws what the read says.
 *
 * **The functions, by name.** S6 writes them beside this (B01-5f); until the published `api` has
 * them, each is referenced by its name with the argument and answer types the brief pack gives, and
 * the integrator swaps each for `api.support.*` (a type error then names any drift).
 */

/** What a note or reply write answers: the message it wrote, its audit row and the Undo offer. */
export type MessageAnswer = { messageId: string } & WriteAnswer;
/** What a resolve or reopen answers: the ticket, its audit row and the Undo offer. */
export type TicketAnswer = { ticketId: string } & WriteAnswer;

type TicketArgs = { ticketId: Id<'supportTickets'> };
type MessageArgs = TicketArgs & { body: string };

// INTEGRATOR: swap each for `api.support.reply` / `addNote` / `resolve` / `reopen` once S6 lands.
export const TICKET_REPLY = makeFunctionReference<'mutation', MessageArgs, MessageAnswer>(
  'support:reply',
) as FunctionReference<'mutation', 'public', MessageArgs, MessageAnswer>;
export const TICKET_NOTE = makeFunctionReference<'mutation', MessageArgs, MessageAnswer>(
  'support:addNote',
) as FunctionReference<'mutation', 'public', MessageArgs, MessageAnswer>;
export const TICKET_RESOLVE = makeFunctionReference<'mutation', TicketArgs, TicketAnswer>(
  'support:resolve',
) as FunctionReference<'mutation', 'public', TicketArgs, TicketAnswer>;
export const TICKET_REOPEN = makeFunctionReference<'mutation', TicketArgs, TicketAnswer>(
  'support:reopen',
) as FunctionReference<'mutation', 'public', TicketArgs, TicketAnswer>;

/** The four writes, as the handler calls them (a story or a test fakes them). */
export type TicketServer = {
  reply: (args: MessageArgs) => Promise<MessageAnswer>;
  addNote: (args: MessageArgs) => Promise<MessageAnswer>;
  resolve: (args: TicketArgs) => Promise<TicketAnswer>;
  reopen: (args: TicketArgs) => Promise<TicketAnswer>;
};

export function useTicketServer(): TicketServer {
  const reply = useMutation(TICKET_REPLY);
  const addNote = useMutation(TICKET_NOTE);
  const resolve = useMutation(TICKET_RESOLVE);
  const reopen = useMutation(TICKET_REOPEN);
  return useMemo(() => ({ reply, addNote, resolve, reopen }), [reply, addNote, resolve, reopen]);
}

export type TicketAct = 'reply' | 'note' | 'resolve' | 'reopen';

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
    (body: string) =>
      run({
        act: 'reply',
        what: W.theReply,
        write: async () => landedOn(ticketId, await server.reply({ ticketId, body })),
        receipt: { title: W.replyQueued, description: W.replyQueuedDetail },
      } satisfies Decision<TicketAct>),
    [run, server, ticketId],
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
  return { reply, note, resolve, reopen, pending };
}
