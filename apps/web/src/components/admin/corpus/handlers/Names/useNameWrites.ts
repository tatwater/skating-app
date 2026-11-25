import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { waterBodyDisplayName } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import { useMutation } from 'convex/react';
import { useCallback, useMemo } from 'react';

import { useDecisionRunner } from '../../../actions/useDecisionRunner';
import { landedOn } from '../taskItem';
import type { NameLever, NamesItem } from './namesModel';
import { NAME_WORDS as W } from './nameWords';

/**
 * **The Name conflicts handler's one write** (board 4.2): `corpusWrites.decideName` with the task
 * and the pick — a catalog spelling (`pickName`, the body renamed) or `'shown'` (`keepName`, the
 * question settled with nothing changed). Through the shared decision runner: a refusal is one
 * toast (D268), a landed decision the shell's receipt in the present tense with Undo on the row the
 * write answered with, never looked up. Nothing optimistic: the item's read draws what changed.
 */

export type DecisionAnswer = FunctionReturnType<typeof api.corpusWrites.decideName>;

/** The write, as the handler calls it (a story or a test fakes it). */
export type NameServer = {
  decideName: (args: { taskId: Id<'corpusTasks'>; pick: string }) => Promise<DecisionAnswer>;
};

/** The mutation the handler decides through (a test holds the handler to it). */
export const DECIDE_NAME = api.corpusWrites.decideName;

export function useNameServer(): NameServer {
  const decideName = useMutation(DECIDE_NAME);
  return useMemo(() => ({ decideName }), [decideName]);
}

export function useNameWrites(
  item: Pick<NamesItem, 'taskId' | 'body' | 'names'>,
  server: NameServer,
): { decide: (lever: NameLever) => Promise<boolean>; pending: NameLever['verb'] | null } {
  const { run, pending } = useDecisionRunner<NameLever['verb']>({
    itemId: item.taskId,
    subject: waterBodyDisplayName(item.body.name),
  });
  const decide = useCallback(
    async (lever: NameLever) => {
      const others = item.names.filter((n) => n.value !== lever.name).map((n) => n.value);
      return run({
        act: lever.verb,
        what: W.theDecision,
        write: async () =>
          landedOn(item.body.id, await server.decideName({ taskId: item.taskId, pick: lever.pick })),
        receipt:
          lever.verb === 'keepName'
            ? { title: W.receiptKeeps(lever.name), description: W.receiptSettled }
            : {
                title: W.receiptDisplays(lever.name),
                ...(others.length > 0 ? { description: W.receiptAlias(others.join(', ')) } : {}),
              },
      });
    },
    [run, server, item.taskId, item.body.id, item.names],
  );
  return { decide, pending };
}
