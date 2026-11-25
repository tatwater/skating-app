import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type WaterBodyClass, waterBodyClassLabel, waterBodyDisplayName } from '@skating/core';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useCallback, useMemo } from 'react';

import { useDecisionRunner } from '../../../actions/useDecisionRunner';
import { landedOn } from '../taskItem';
import type { ClassesItem, ClassLever } from './classesModel';
import { CLASS_WORDS as W } from './classWords';

/**
 * **The Class conflicts handler's one write** (board 4.3): `corpusWrites.decideClass` with the
 * task and the class — another class (`setClass`, the body reclassed) or its own (`keepClass`, the
 * question settled with nothing changed). Through the shared decision runner, as the Names
 * handler's: a refusal one toast (D268), the receipt in the present tense with Undo on the row the
 * write answered with.
 */

export type ClassAnswer = FunctionReturnType<typeof api.corpusWrites.decideClass>;

export type ClassServer = {
  decideClass: (args: {
    taskId: Id<'corpusTasks'>;
    bodyClass: WaterBodyClass;
  }) => Promise<ClassAnswer>;
};

export const DECIDE_CLASS = api.corpusWrites.decideClass;

export function useClassServer(): ClassServer {
  const decideClass = useMutation(DECIDE_CLASS);
  return useMemo(() => ({ decideClass }), [decideClass]);
}

export function useClassWrites(
  item: Pick<ClassesItem, 'taskId' | 'body' | 'ladder'>,
  server: ClassServer,
): { decide: (lever: ClassLever) => Promise<boolean>; pending: ClassLever['verb'] | null } {
  const { run, pending } = useDecisionRunner<ClassLever['verb']>({
    itemId: item.taskId,
    subject: waterBodyDisplayName(item.body.name),
  });
  const decide = useCallback(
    async (lever: ClassLever) => {
      const label = waterBodyClassLabel(lever.bodyClass);
      const rung = item.ladder.find((r) => r.cls === lever.bodyClass);
      return run({
        act: lever.verb,
        what: W.theDecision,
        write: async () =>
          landedOn(
            item.body.id,
            await server.decideClass({ taskId: item.taskId, bodyClass: lever.bodyClass }),
          ),
        receipt:
          lever.verb === 'keepClass'
            ? { title: W.receiptKept(label), description: W.receiptSettled }
            : {
                title: W.receiptSet(label),
                ...(rung !== undefined ? { description: rung.consequence.words } : {}),
              },
      });
    },
    [run, server, item.taskId, item.body.id, item.ladder],
  );
  return { decide, pending };
}
