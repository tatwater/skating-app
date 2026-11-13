import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { useMemo } from 'react';

import { useRole } from '@/lib/useRole';

import { useTabAction } from '../names/useTabAction';
import { PlacesView } from './PlacesView';
import { landmarkRows, type PlacesData, placeAsks } from './placesModel';

/**
 * Body › Places, wired. Reads: the landmarks with their provenance (`landmarks.listForEditor`),
 * the bays they fall in (`subAreas.listForBody`), the emails' open names
 * (`corpusPlaceNames.openForBody`) and the skaters' open proposals
 * (`corpusRequests.openLandmarkRequestsForBody`). Writes, each behind its capability and announced
 * for undo: a landmark's name, spellings and kind (`landmarks.update`, `body.places`); filing or
 * dismissing an emailed name (`corpusPlaceNames.fileAsSpelling` / `dismiss`,
 * `corpus.placeNames`); answering a proposal with the landmark already there or declining it
 * (`corpusRequests.approve` / `decline`, `inbox.request`). The map tools are task modes, not built.
 */
export function PlacesTab({
  bodyId,
  lit = null,
  onLitChange,
  hovered = null,
  onHoverChange,
}: {
  bodyId: string;
  lit?: string | null;
  onLitChange?: (id: string | null) => void;
  hovered?: string | null;
  onHoverChange?: (id: string | null) => void;
}) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const landmarks = useQuery(api.landmarks.listForEditor, { waterBodyId });
  const bays = useQuery(api.subAreas.listForBody, { waterBodyId });
  const names = useQuery(api.corpusPlaceNames.openForBody, { waterBodyId });
  const proposals = useQuery(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId });
  const update = useMutation(api.landmarks.update);
  const fileAsSpelling = useMutation(api.corpusPlaceNames.fileAsSpelling);
  const dismiss = useMutation(api.corpusPlaceNames.dismiss);
  const approve = useMutation(api.corpusRequests.approve);
  const decline = useMutation(api.corpusRequests.decline);
  const { act, actInDialog } = useTabAction();
  const { can } = useRole();

  const data = useMemo<PlacesData | undefined>(() => {
    if (landmarks === undefined || names === undefined || proposals === undefined) return undefined;
    const bayNames = bays ? new Map(bays.map((b) => [b._id as string, b.name])) : null;
    return {
      asks: placeAsks(names, proposals.proposals),
      landmarks: landmarkRows(landmarks, bayNames),
    };
  }, [landmarks, bays, names, proposals]);

  const nameOf = (id: string) => data?.landmarks.find((l) => l.id === id)?.name ?? 'the landmark';
  const askName = (id: string) => data?.asks.find((a) => a.id === id)?.name ?? '';

  return (
    <PlacesView
      data={data}
      lit={lit}
      onLitChange={onLitChange}
      hovered={hovered}
      onHoverChange={onHoverChange}
      canPlace={can('body.places')}
      onEditLandmark={
        can('body.places')
          ? (id, edit) =>
              void act(() => update({ landmarkId: id as Id<'bodyLandmarks'>, ...edit }), {
                title: `Saved · ${'name' in edit ? edit.name : nameOf(id)}`,
                target: { targetType: 'bodyLandmark', targetId: id },
              })
          : undefined
      }
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
              actInDialog(
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
              actInDialog(() => decline({ requestId: askId as Id<'waterBodyRequests'>, note }), {
                title: `Declined “${askName(askId)}”`,
                target: { targetType: 'waterBodyRequest', targetId: askId },
              })
          : undefined
      }
    />
  );
}
