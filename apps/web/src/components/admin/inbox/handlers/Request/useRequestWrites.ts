import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback, useMemo } from 'react';

import { type Landed, useDecisionRunner, type WriteAnswer } from '../../actions/useDecisionRunner';
import {
  primaryAsk,
  type RequestItem,
  type RequestWrite,
  receiptOf,
  subjectOf,
} from './requestModel';
import { REQUEST_HANDLER_WORDS as W } from './requestWords';

/**
 * **The request handler's one write path** — the corpus request writes, sent for the ask the server
 * names (`primaryRequestId`: the newest open one served; the decision closes every ask of its
 * question, its siblings paged by the server):
 * `corpusRequests.approve` (a takedown's with its reason, as the note the asker reads),
 * `corpusRequests.decline` (with the note the asker reads), and `corpusRequests.reresolve` (*Look up
 * again*). Each asks the Inbox's own rule on the item before it writes (`assertMayDecide`), so a lever
 * the item drew is never one its write refuses, and one that is refused anyway says why.
 *
 * Through the Inbox's one decision runner (`actions/useDecisionRunner`, D268): a refusal is one toast
 * naming the item, in the server's words, never printed in place; the lever learns only that it
 * didn't land. A landed decision raises the shell's receipt with Undo from the write's own answer —
 * the ask's audit row and this viewer's undo offer, never looked up. A lookup decides nothing, so
 * its receipt offers no Undo. **Nothing optimistic**: the
 * item's read draws what changed.
 */

/**
 * The three writes, as this path calls them (a story or a test fakes them): a decision answers its
 * own row and undo offer (`InboxDecisionResult`); a lookup decides nothing and answers none.
 */
export type RequestServer = {
  approve: (args: {
    requestId: Id<'waterBodyRequests'>;
    note?: string;
  }) => Promise<{ requestId: Id<'waterBodyRequests'> } & WriteAnswer>;
  decline: (args: {
    requestId: Id<'waterBodyRequests'>;
    note: string;
  }) => Promise<{ requestId: Id<'waterBodyRequests'> } & WriteAnswer>;
  reresolve: (args: { requestId: Id<'waterBodyRequests'> }) => Promise<unknown>;
};

/** The mutations the handler writes through (a test holds the handler to them). */
export const REQUEST_WRITES = {
  approve: api.corpusRequests.approve,
  decline: api.corpusRequests.decline,
  reresolve: api.corpusRequests.reresolve,
} as const;

/** The real server: the three mutations. */
export function useRequestServer(): RequestServer {
  const approve = useMutation(REQUEST_WRITES.approve);
  const decline = useMutation(REQUEST_WRITES.decline);
  const reresolve = useMutation(REQUEST_WRITES.reresolve);
  return useMemo(() => ({ approve, decline, reresolve }), [approve, decline, reresolve]);
}

/** The write a lever sends, with the ask it is sent for; a typed note trimmed, an empty one left out. */
export function callOf(requestId: Id<'waterBodyRequests'>, write: RequestWrite) {
  switch (write.kind) {
    case 'approve': {
      const note = write.note?.trim() ?? '';
      return { kind: 'approve', args: { requestId, ...(note !== '' && { note }) } } as const;
    }
    case 'decline':
      return { kind: 'decline', args: { requestId, note: write.note.trim() } } as const;
    case 'lookUpAgain':
      return { kind: 'reresolve', args: { requestId } } as const;
  }
}

export function useRequestWrites({
  item,
  server,
}: {
  item: RequestItem;
  server: RequestServer;
}): (write: RequestWrite) => Promise<boolean> {
  const { run } = useDecisionRunner<RequestWrite['kind']>({
    itemId: item.itemId,
    subject: subjectOf(item),
  });
  return useCallback(
    async (write: RequestWrite): Promise<boolean> => {
      const ask = primaryAsk(item);
      // An item with no ask can't be decided from here; its read is mid-change.
      if (ask === null) return false;
      // The ask the server names for the decision (`primaryRequestId`), from the item.
      const requestId = item.primaryRequestId;
      const call = callOf(requestId, write);
      const receipt = receiptOf(item, write);
      return run({
        act: write.kind,
        what: write.kind === 'lookUpAgain' ? W.theLookup : W.theDecision,
        write: async (): Promise<Landed> => {
          // The decision's row is the ask's own (`approve_request` / `decline_request`).
          const target = { targetType: 'waterBodyRequest', targetId: requestId } as const;
          switch (call.kind) {
            case 'approve':
              return { target, answer: await server.approve(call.args) };
            case 'decline':
              return { target, answer: await server.decline(call.args) };
            case 'reresolve':
              // A lookup decides nothing: no row to undo.
              await server.reresolve(call.args);
              return { target, answer: null };
          }
        },
        receipt: { title: receipt.title, description: receipt.description },
      });
    },
    [item, server, run],
  );
}
