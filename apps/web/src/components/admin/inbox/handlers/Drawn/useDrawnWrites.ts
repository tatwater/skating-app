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
import type { DrawnItem } from './drawnModel';
import { DRAWN_WORDS as W } from './drawnWords';

/**
 * **The drawn handler's writes** (board 2.5): *Approve as new* is `waterBodies.approve`, *Reject*
 * `waterBodies.reject` with the reason the drawer reads — each asks the Inbox's rule first (a
 * drawing the viewer drew is refused, and so is one a colleague already reviewed), so the lever and
 * the write say one thing. *Merge* has no write here yet (the next slice's `mergeDrawn`). Each runs
 * through `useDecisionRunner`: refusals to a toast, the receipt with Undo on the decision's row
 * (`return_to_review`).
 */

export type DrawnAct = 'approve' | 'reject';

/** The two writes, as the handler calls them (a story or a test fakes them). */
export type DrawnServer = {
  approve: (args: {
    waterBodyId: Id<'waterBodies'>;
  }) => Promise<{ waterBodyId: Id<'waterBodies'> } & WriteAnswer>;
  reject: (args: {
    waterBodyId: Id<'waterBodies'>;
    reason?: string;
  }) => Promise<{ waterBodyId: Id<'waterBodies'> } & WriteAnswer>;
};

/** The mutations the handler decides through (a test holds the handler to them). */
export const DRAWN_APPROVE = api.waterBodies.approve;
export const DRAWN_REJECT = api.waterBodies.reject;

export function useDrawnServer(): DrawnServer {
  const approve = useMutation(DRAWN_APPROVE);
  const reject = useMutation(DRAWN_REJECT);
  return useMemo(() => ({ approve, reject }), [approve, reject]);
}

/** What landed: the drawn body the write answered with, and its own answer (the row, its offer). */
const landed = (answer: { waterBodyId: string } & WriteAnswer): Landed => ({
  target: { targetType: 'waterbody', targetId: answer.waterBodyId } satisfies UndoTarget,
  answer,
});

export function useDrawnWrites(
  item: Pick<DrawnItem, 'itemId' | 'body'>,
  server: DrawnServer,
): {
  approve: () => Promise<boolean>;
  reject: (reason: string) => Promise<boolean>;
  pending: DrawnAct | null;
} {
  const { run, pending } = useDecisionRunner<DrawnAct>({
    itemId: item.itemId,
    subject: item.body.name,
  });
  const waterBodyId = item.body.waterBodyId;
  const approve = useCallback(
    () =>
      run({
        act: 'approve',
        what: W.theDecision,
        write: async () => landed(await server.approve({ waterBodyId })),
        receipt: { title: W.approved, description: W.approvedDetail },
      } satisfies Decision<DrawnAct>),
    [run, server, waterBodyId],
  );
  const reject = useCallback(
    (reason: string) =>
      run({
        act: 'reject',
        what: W.theDecision,
        write: async () => landed(await server.reject({ waterBodyId, reason: reason.trim() })),
        receipt: { title: W.rejected, description: W.rejectedDetail },
      }),
    [run, server, waterBodyId],
  );
  return { approve, reject, pending };
}
