import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback, useMemo } from 'react';

import type { UndoTarget } from '../../../shell/undo';
import { type Landed, useDecisionRunner } from '../../actions/useDecisionRunner';
import { type LandmarkLookalike, type PlaceItem, primaryAsk } from './placeModel';
import { PLACE_WORDS as W } from './placeWords';

/**
 * **The place handler's writes** (board 2.4): *Same place* and *Approve* are
 * `corpusRequests.approve` — *Same place* carrying `sameAs` (the lookalike's id, the name and the
 * point the moderator saw it by) — and *Decline* is `corpusRequests.decline` with the note the
 * asker reads. Each is written on the item's first ask, the one its rule was read from; the server
 * closes its siblings with it. Each asks the Inbox's rule first, so the lever and the write say one
 * thing; each runs through `useDecisionRunner` (refusals to a toast, the receipt with Undo on the
 * decision's row, `reopen_request`).
 */

export type PlaceAct = 'samePlace' | 'approve' | 'decline';

type SameAs = {
  landmarkId: Id<'bodyLandmarks'>;
  name: string;
  point: { lat: number; lng: number };
};

/** The two writes, as the handler calls them (a story or a test fakes them). */
export type PlaceServer = {
  approve: (args: {
    requestId: Id<'waterBodyRequests'>;
    sameAs?: SameAs;
  }) => Promise<{ requestId: Id<'waterBodyRequests'> }>;
  decline: (args: {
    requestId: Id<'waterBodyRequests'>;
    note: string;
  }) => Promise<Id<'waterBodyRequests'>>;
};

/** The mutations the handler decides through (a test holds the handler to them). */
export const PLACE_APPROVE = api.corpusRequests.approve;
export const PLACE_DECLINE = api.corpusRequests.decline;

export function usePlaceServer(): PlaceServer {
  const approve = useMutation(PLACE_APPROVE);
  const decline = useMutation(PLACE_DECLINE);
  return useMemo(() => ({ approve, decline }), [approve, decline]);
}

/** A decision's Undo target: the ask the write answered with. */
const askTarget = (id: string): Landed => ({
  target: { targetType: 'waterBodyRequest', targetId: id } satisfies UndoTarget,
});

export function usePlaceWrites(
  item: Pick<PlaceItem, 'itemId' | 'asks' | 'memberCount' | 'memberCountIsFloor' | 'body'>,
  server: PlaceServer,
): {
  samePlace: (l: LandmarkLookalike) => Promise<boolean>;
  approve: () => Promise<boolean>;
  decline: (note: string) => Promise<boolean>;
  pending: PlaceAct | null;
} {
  const ask = primaryAsk(item);
  const name = ask?.name ?? '';
  const { run, pending } = useDecisionRunner<PlaceAct>({
    itemId: item.itemId,
    subject: name !== '' ? `“${name}” · ${item.body.name}` : item.body.name,
  });
  const requestId = ask?.requestId;
  const closes = W.closesAsks(item.memberCount, item.memberCountIsFloor);
  const samePlace = useCallback(
    async (l: LandmarkLookalike) => {
      if (requestId === undefined) return false;
      return run({
        act: 'samePlace',
        what: W.theDecision,
        write: async () =>
          askTarget(
            (
              await server.approve({
                requestId,
                sameAs: { landmarkId: l.landmarkId, name: l.name, point: l.point },
              })
            ).requestId,
          ),
        receipt: { title: W.receiptSamePlace, description: closes },
      });
    },
    [run, server, requestId, closes],
  );
  const approve = useCallback(async () => {
    if (requestId === undefined) return false;
    return run({
      act: 'approve',
      what: W.theDecision,
      write: async () => askTarget((await server.approve({ requestId })).requestId),
      receipt: { title: W.receiptApproved, description: closes },
    });
  }, [run, server, requestId, closes]);
  const decline = useCallback(
    async (note: string) => {
      if (requestId === undefined) return false;
      return run({
        act: 'decline',
        what: W.theDecision,
        write: async () => askTarget(await server.decline({ requestId, note: note.trim() })),
        receipt: { title: W.receiptDeclined, description: closes },
      });
    },
    [run, server, requestId, closes],
  );
  return { samePlace, approve, decline, pending };
}
