import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { useMemo, useState } from 'react';
import { read, useConsoleReadSet } from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import { arrivalSearch, validateBodySearch } from '../../frame/bodySearch';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useTabAction } from '../useTabAction';
import { PlacesView } from './PlacesView';
import { litId, type PlacesData, placesFrom, placesMapScene, rowsOf } from './placesModel';
import { useLandmarkTask } from './useLandmarkTask';

/**
 * The Places tab's reads and its data — the landmarks with when and by whom each was added, the
 * bays they fall in, the emailed names, the skaters' proposals and who asked for each — memoized
 * on the reads, so the map's `useData` keeps its identity until one changes. Who asked is read only
 * for a viewer who can see the asks (`inbox.read`); without it the tab has no askers at all.
 */
export function usePlacesRead(bodyId: string): {
  data: PlacesData;
  retry: () => void;
  pending: boolean;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can, isLoading } = useRole();
  const seesAskers = can('inbox.read');
  const { reads, retry, pending } = useConsoleReadSet({
    landmarks: read(api.landmarks.listForEditor, { waterBodyId }),
    bays: read(api.subAreas.listForBody, { waterBodyId }),
    names: read(api.corpusPlaceNames.openForBody, { waterBodyId }),
    proposals: read(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId }),
    provenance: read(api.bodyConsole.landmarkProvenance, { waterBodyId }),
    proposers: seesAskers ? read(api.bodyConsole.landmarkProposers, { waterBodyId }) : null,
  });
  const { landmarks, bays, names, proposals, provenance, proposers } = reads;
  // While the role loads, who asked is on its way, not withheld.
  const askers = seesAskers ? proposers : isLoading ? undefined : 'hidden';
  const data = useMemo(
    () => placesFrom({ landmarks, bays, names, proposals, provenance, proposers: askers }),
    [landmarks, bays, names, proposals, provenance, askers],
  );
  return { data, retry, pending };
}

/** The drawing's data: the tab's, as the map reads it. */
export function usePlacesData(bodyId: string): PlacesData | undefined {
  return usePlacesRead(bodyId).data;
}

/**
 * Body › Places, wired. Reads: the landmarks (`landmarks.listForEditor`) and when and by whom each
 * was added (`bodyConsole.landmarkProvenance`), the bays they fall in (`subAreas.listForBody`), the
 * emails' open names (`corpusPlaceNames.openForBody`), the skaters' open proposals
 * (`corpusRequests.openLandmarkRequestsForBody`) and who asked for each
 * (`bodyConsole.landmarkProposers`, `inbox.read`). Each read says in place when it is loading or
 * failed, and the tab's note offers *Try again*. Writes, each behind its capability and announced
 * for undo: a landmark's name, spellings and kind (`landmarks.update`, `body.places`); filing or
 * dismissing an emailed name (`corpusPlaceNames.fileAsSpelling` / `dismiss`,
 * `corpus.placeNames`); answering a proposal with the landmark already there or declining it
 * (`corpusRequests.approve` / `decline`, `inbox.request`). *Draw as a bay* opens the Shape tab's
 * bay task with the landmark (`?promote=`, B01-6a, `body.shape`).
 *
 * **The map's landmark tools** (B01-6b, `useLandmarkTask`, `body.places`): dropping a landmark
 * (`landmarks.create`), placing an emailed name with it (also `corpus.placeNames`, as filing one
 * is) and adding a skater's proposal (also `inbox.request`, as answering one is) — the server asks
 * for the same pair — and an Inbox landmark ask arriving to be placed (`?landmarkAsk=`); moving a
 * landmark (`landmarks.update` with its point, each move saved) and removing it with a reason
 * (`landmarks.remove`). Each is announced with Undo.
 */
export function PlacesTab({ bodyId, lit = null, onLitChange }: BodyTabProps) {
  const { data, retry, pending } = usePlacesRead(bodyId);
  // A row's hover washes its row; the frame's contract has no hovered item yet to carry it to the
  // marker (a contract request), so it stays the view's.
  const [hovered, setHovered] = useState<string | null>(null);
  const update = useMutation(api.landmarks.update);
  const fileAsSpelling = useMutation(api.corpusPlaceNames.fileAsSpelling);
  const dismiss = useMutation(api.corpusPlaceNames.dismiss);
  const approve = useMutation(api.corpusRequests.approve);
  const decline = useMutation(api.corpusRequests.decline);
  const remove = useMutation(api.landmarks.remove);
  const { act } = useTabAction(bodyId);
  const { can, isLoading: roleLoading } = useRole();
  const navigate = useNavigate();
  const canPlace = can('body.places');
  const tools = useLandmarkTask({
    bodyId,
    landmarks: rowsOf(data.landmarks),
    lit,
    onLitChange,
    // An Inbox ask arriving to be placed takes what *Add* on a proposal takes, as the server does.
    canAnswerAsk: roleLoading ? undefined : canPlace && can('inbox.request'),
  });

  const nameOf = (id: string) =>
    rowsOf(data.landmarks).find((l) => l.id === id)?.name ?? 'the landmark';
  const askName = (id: string) => rowsOf(data.asks).find((a) => a.id === id)?.name ?? '';

  return (
    <PlacesView
      data={data}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      onLitChange={onLitChange}
      hovered={hovered}
      onHoverChange={setHovered}
      canPlace={canPlace}
      drop={tools.drop}
      moving={tools.moving}
      {...(canPlace
        ? {
            onDropLandmark: tools.startDrop,
            onMoveLandmark: tools.toggleMove,
            onRemoveLandmark: async (id: string, reason: string) => {
              const name = nameOf(id);
              const landed = await act(
                () => remove({ landmarkId: id as Id<'bodyLandmarks'>, reason }),
                {
                  title: `Removed · ${name}`,
                  target: { targetType: 'bodyLandmark', targetId: id },
                },
              );
              // Its card goes with it: nothing is lit that the list no longer holds.
              if (landed && lit === litId.landmark(id)) onLitChange?.(null);
              return landed;
            },
            ...(can('corpus.placeNames') ? { onPlaceName: tools.placeName } : {}),
            ...(can('inbox.request') ? { onAddProposal: tools.addProposal } : {}),
          }
        : {})}
      onEditLandmark={
        canPlace
          ? (id, edit) =>
              act(() => update({ landmarkId: id as Id<'bodyLandmarks'>, ...edit }), {
                title: `Saved · ${'name' in edit ? edit.name : nameOf(id)}`,
                target: { targetType: 'bodyLandmark', targetId: id },
              })
          : undefined
      }
      {...(can('body.shape') && can('body.places')
        ? {
            onDrawAsBay: (id: string) =>
              void navigate({
                to: '.',
                search: (prev: Record<string, unknown>) =>
                  arrivalSearch(validateBodySearch(prev), { promote: id }),
              } as never),
          }
        : {})}
      onFileAsSpelling={
        can('corpus.placeNames')
          ? (askId, landmarkId) =>
              void act(
                () =>
                  fileAsSpelling({
                    id: askId as Id<'corpusPlaceNames'>,
                    landmarkId: landmarkId as Id<'bodyLandmarks'>,
                  }),
                {
                  title: `Filed “${askName(askId)}” as a spelling of ${nameOf(landmarkId)}`,
                  target: { targetType: 'corpusPlaceName', targetId: askId },
                },
              )
          : undefined
      }
      onDismissName={
        can('corpus.placeNames')
          ? (askId, reason, note) =>
              act(
                () =>
                  dismiss({
                    id: askId as Id<'corpusPlaceNames'>,
                    reason,
                    ...(note !== '' ? { note } : {}),
                  }),
                {
                  title: `Dismissed “${askName(askId)}”`,
                  target: { targetType: 'corpusPlaceName', targetId: askId },
                },
              )
          : undefined
      }
      onSamePlace={
        can('inbox.request')
          ? (ask) =>
              void act(
                () =>
                  approve({
                    requestId: ask.id as Id<'waterBodyRequests'>,
                    ...(ask.existingLandmarkId === null && ask.similar !== null
                      ? {
                          sameAs: {
                            landmarkId: ask.similar.landmarkId as Id<'bodyLandmarks'>,
                            name: ask.similar.name,
                            point: ask.similar.point,
                          },
                        }
                      : {}),
                  }),
                {
                  title: `Answered “${ask.name}” with the landmark already there`,
                  target: { targetType: 'waterBodyRequest', targetId: ask.id },
                },
              )
          : undefined
      }
      onDecline={
        can('inbox.request')
          ? (askId, note) =>
              act(() => decline({ requestId: askId as Id<'waterBodyRequests'>, note }), {
                title: `Declined “${askName(askId)}”`,
                target: { targetType: 'waterBodyRequest', targetId: askId },
              })
          : undefined
      }
    />
  );
}

/** The Places tab's registration in the frame's registry. */
export const PLACES_TAB: BodyTabRegistration<PlacesData> = {
  Wiring: PlacesTab,
  map: { useData: usePlacesData, describe: placesMapScene },
};
