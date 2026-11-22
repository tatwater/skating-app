import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useCallback, useMemo } from 'react';

import type { UndoTarget } from '../../../shell/undo';
import {
  type Decision,
  type Landed,
  useDecisionRunner,
  type WriteAnswer,
} from '../../actions/useDecisionRunner';
import type { DrawnItem, DrawnSurvivor } from './drawnModel';
import { DRAWN_WORDS as W } from './drawnWords';

/**
 * **The drawn handler's writes** (board 2.5): *Merge into ‹body›* is `inboxWrites.mergeDrawn`, with
 * the item and the survivor the bar showed (refused if the drawing's live survivor is now another
 * body); *Approve as new* is `waterBodies.approve`; *Reject* `waterBodies.reject` with its reason
 * (kept in the audit log; the drawer is told only that it was rejected). Each asks the Inbox's rule
 * first (a drawing the viewer drew is refused, and so is one a colleague already reviewed), so the
 * lever and the write say one thing. Each runs through `useDecisionRunner`: refusals to a toast, the
 * receipt with Undo from the write's own answer (the merge's: the unmerge).
 */

export type DrawnAct = 'merge' | 'approve' | 'reject';

/** What `mergeDrawn` answers: the Inbox writes' shape (`InboxWriteResult`): the merge's own row. */
/** What `inboxWrites.mergeDrawn` answers, as the server types it. */
export type MergeDrawnAnswer = FunctionReturnType<typeof api.inboxWrites.mergeDrawn>;

/** The three writes, as the handler calls them (a story or a test fakes them). */
export type DrawnServer = {
  mergeDrawn: (args: {
    itemId: Id<'inboxItems'>;
    survivorId: Id<'waterBodies'>;
    reason?: string;
  }) => Promise<MergeDrawnAnswer>;
  approve: (args: {
    waterBodyId: Id<'waterBodies'>;
  }) => Promise<{ waterBodyId: Id<'waterBodies'> } & WriteAnswer>;
  reject: (args: {
    waterBodyId: Id<'waterBodies'>;
    reason?: string;
  }) => Promise<{ waterBodyId: Id<'waterBodies'> } & WriteAnswer>;
};

/** The mutations the handler decides through (a test holds the handler to them). */
export const DRAWN_MERGE = api.inboxWrites.mergeDrawn;
export const DRAWN_APPROVE = api.waterBodies.approve;
export const DRAWN_REJECT = api.waterBodies.reject;

export function useDrawnServer(): DrawnServer {
  const mergeDrawn = useMutation(DRAWN_MERGE);
  const approve = useMutation(DRAWN_APPROVE);
  const reject = useMutation(DRAWN_REJECT);
  return useMemo(() => ({ mergeDrawn, approve, reject }), [mergeDrawn, approve, reject]);
}

/** What landed on the drawing: its body (the merge's row targets the loser), and the write's answer. */
const landedOn = (waterBodyId: string, answer: WriteAnswer): Landed => ({
  target: { targetType: 'waterbody', targetId: waterBodyId } satisfies UndoTarget,
  answer,
});

export function useDrawnWrites(
  item: Pick<DrawnItem, 'itemId' | 'body'>,
  server: DrawnServer,
): {
  merge: (survivor: DrawnSurvivor) => Promise<boolean>;
  approve: () => Promise<boolean>;
  reject: (reason: string) => Promise<boolean>;
  pending: DrawnAct | null;
} {
  const { run, pending } = useDecisionRunner<DrawnAct>({
    itemId: item.itemId,
    subject: item.body.name,
  });
  const itemId = item.itemId;
  const waterBodyId = item.body.waterBodyId;
  const merge = useCallback(
    (survivor: DrawnSurvivor) =>
      run({
        act: 'merge',
        what: W.theDecision,
        // The item and the survivor the bar showed: the server refuses one that is no longer the
        // drawing's live survivor, so a stale bar can't fold it into another body.
        write: async () =>
          landedOn(
            waterBodyId,
            await server.mergeDrawn({ itemId, survivorId: survivor.waterBodyId }),
          ),
        // Both bodies named: the survivor here, the drawing as the receipt's subject.
        receipt: { title: W.mergedInto(survivor.name), description: W.mergedDetail },
      } satisfies Decision<DrawnAct>),
    [run, server, itemId, waterBodyId],
  );
  const approve = useCallback(
    () =>
      run({
        act: 'approve',
        what: W.theDecision,
        write: async () => {
          const answer = await server.approve({ waterBodyId });
          return landedOn(answer.waterBodyId, answer);
        },
        receipt: { title: W.approved, description: W.approvedDetail },
      } satisfies Decision<DrawnAct>),
    [run, server, waterBodyId],
  );
  const reject = useCallback(
    (reason: string) =>
      run({
        act: 'reject',
        what: W.theDecision,
        write: async () => {
          const answer = await server.reject({ waterBodyId, reason: reason.trim() });
          return landedOn(answer.waterBodyId, answer);
        },
        receipt: { title: W.rejected, description: W.rejectedDetail },
      }),
    [run, server, waterBodyId],
  );
  return { merge, approve, reject, pending };
}
