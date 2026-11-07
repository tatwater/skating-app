import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  duplicateNudge,
  findDuplicateCandidate,
  type HazardShape,
  type HazardType,
  type LatLng,
  relativeWhen,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useEffect, useRef, useState } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { type HazardDraft, useHazardDraftStore } from '@/stores/hazardDraftStore';
import { HazardFlowView, type NudgeView } from './HazardFlowView';
import {
  applyAreaRing,
  applyMapClick,
  type BodyPolygon,
  chooseDrawKind,
  chooseType,
  clearType,
  flipShore,
  resize,
  shapeOf,
  startDraft,
  stepOf,
  stopPlacing,
  undoPlacement,
} from './hazardFlowModel';
import { photoIdOf, uploadHazardPhotos, usePhotoPreviews } from './hazardPhotos';
import { type HazardInstrument, RegionFlowSpec, useHazardMap } from './useHazardMap';

/** How a flow ended, for a host that carries on from it (the report sheet, 5.10.1). */
export interface HazardFlowResult {
  outcome: 'filed' | 'confirmed';
  hazardId: string;
}

export interface HazardFlowProps {
  waterBodyId: string;
  /** The bay the lake is framed on (`?sub=`), so the flow's map keeps the same framing. */
  subAreaId?: string;
  /**
   * Stacked inside the report sheet (board 5.10.1): the flow renders where the host puts it, marks
   * the draft `stackedInReport`, leaves `hazard_flow_started` to the opener (which recorded it with
   * `entry: 'report_sheet'`), and never navigates — every way out is a callback.
   */
  stacked?: boolean;
  /**
   * The host's own map (the report sheet's instrument). Without it the flow draws on the region map
   * through the `flow` slot.
   */
  instrument?: HazardInstrument;
  /**
   * Leave the flow, keeping the draft (Back, Esc, the mode bar's Esc). Cancel discards first, then
   * calls this.
   */
  onClose: () => void;
  /**
   * Filed or confirmed. Defaults to `onClose`. `open` is false when the skater had already left
   * before the Post landed: the host still carries the result on, but has nothing to close — and
   * must not close whatever it has opened since.
   */
  onDone?: (result: HazardFlowResult, how: { open: boolean }) => void;
  /** A portal container for the tooltips (the host sheet's, or a story's themed quad). */
  container?: HTMLElement | null;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data.message ?? fallback);
  }
  return fallback;
}

/** The body's polygon, narrowed to the two shapes a lake is stored as. */
function polygonOf(geometry: unknown): BodyPolygon | null {
  const type = (geometry as { type?: string } | null)?.type;
  return type === 'Polygon' || type === 'MultiPolygon' ? (geometry as BodyPolygon) : null;
}

/**
 * Report a hazard (boards 3.1–3.8), connected: the draft store, the lake's outline for the shore
 * pick, the live hazards for the nearby nudge, `hazards.create`, and the map.
 */
export function HazardFlow({
  waterBodyId,
  subAreaId,
  stacked = false,
  instrument,
  onClose,
  onDone,
  container,
}: HazardFlowProps) {
  const { capture } = useAnalytics();
  const store = useHazardDraftStore();
  const { draft, bound, restored, photoFiles } = store;
  const bodyId = waterBodyId as Id<'waterBodies'>;
  const body = useQuery(api.waterBodies.get, { waterBodyId: bodyId });
  const polygon = body?.available ? polygonOf(body.body.polygon) : null;
  const liveHazards = useQuery(api.hazards.listForBody, { waterBodyId: bodyId });
  const createHazard = useMutation(api.hazards.create);
  const confirmHazard = useMutation(api.hazardConfirmations.confirm);
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl);
  const createPhoto = useMutation(api.photos.create);
  const deletePhoto = useMutation(api.photos.remove);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nudge, setNudge] = useState<NudgeView | null>(null);
  const photos = usePhotoPreviews(photoFiles);

  // The draft belongs to the signed-in Clerk user (a shared browser never restores someone else's).
  // The skater layout binds it app-wide (`useHazardDraftOwnerBinding`); the flow only waits for it.
  // Open the flow once it's bound: this lake's draft comes back; anything else starts over.
  const opened = useRef(false);
  useEffect(() => {
    if (!bound || opened.current) return;
    opened.current = true;
    const state = useHazardDraftStore.getState();
    if (state.draft?.waterBodyId !== waterBodyId) {
      state.clearDraft();
      state.setDraft(startDraft(waterBodyId, stacked));
    } else if (state.draft.stackedInReport !== stacked) {
      state.updateDraft({ stackedInReport: stacked });
    }
    // Stacked, the report sheet's opener has already recorded the start (it knows the entry).
    if (!stacked) capture('hazard_flow_started', { entry: 'water_body' });
  }, [bound, waterBodyId, stacked, capture]);

  const apply = (change: (current: HazardDraft) => HazardDraft) => {
    const current = useHazardDraftStore.getState().draft;
    if (current) useHazardDraftStore.getState().setDraft(change(current));
  };

  // Every way out runs once, whichever got there first (the page's Esc and the mode bar's both fire).
  const left = useRef(false);
  const leave = () => {
    if (left.current) return;
    left.current = true;
    apply(stopPlacing);
    onClose();
  };
  const finish = (result: HazardFlowResult, filedDraftId: string | undefined) => {
    // The draft goes however the skater left: a Post still in flight when they pressed Close lands
    // here after `leave`, and a draft that restored after its hazard was filed would file it twice.
    // Only *that* draft, though: by the time a slow Post lands the skater may have thrown it away
    // and started another hazard on this lake, and that one (and its photos) is theirs to keep.
    const state = useHazardDraftStore.getState();
    if (state.draft?.waterBodyId === waterBodyId && state.draft.draftId === filedDraftId) {
      state.clearDraft();
    }
    if (left.current) {
      // Already gone, so nothing navigates — but a host that carries the result on (the report
      // sheet's `hazardIds`) still hears of it.
      onDone?.(result, { open: false });
      return;
    }
    left.current = true;
    (onDone ?? (() => onClose()))(result, { open: true });
  };

  // Leaving by any road (a route change included) takes the map out of listening mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only; `apply` reads the store.
  useEffect(() => () => apply(stopPlacing), []);

  const ready = draft !== null && draft.waterBodyId === waterBodyId;
  const map = useHazardMap({
    bodyId: waterBodyId,
    ...(subAreaId !== undefined ? { subAreaId } : {}),
    draft: ready ? draft : null,
    ...(instrument !== undefined ? { instrument } : {}),
    onCapture: (coord: LatLng) => apply((d) => applyMapClick(d, coord, polygon)),
    onAreaRing: (ring) => apply((d) => applyAreaRing(d, ring)),
    onExit: leave,
  });

  if (!ready) {
    return instrument === undefined ? (
      <RegionFlowSpec spec={map.spec} handlers={map.handlers} />
    ) : null;
  }

  const file = async (current: HazardDraft, shape: HazardShape, dismissed: string | null) => {
    const type = current.hazardType as HazardType;
    setSubmitting(true);
    setError(null);
    try {
      const photoIds = await uploadHazardPhotos(photoFiles, {
        generateUploadUrl,
        createPhoto,
        deletePhoto,
      });
      const hazardId = await createHazard({
        waterBodyId: bodyId,
        type,
        geometryKind: shape.geometryKind,
        geometry: shape.geometry,
        ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
        ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
        ...(current.note.trim() ? { description: current.note.trim() } : {}),
        ...(photoIds.length > 0 ? { photoIds } : {}),
        ...(dismissed ? { dismissedDuplicateOf: dismissed as Id<'hazards'> } : {}),
      });
      // The type, the primitive and how many photos — never the note, never the geometry (D240).
      capture('hazard_reported', {
        hazard_type: type,
        geometry_kind: shape.geometryKind,
        photo_count: photoIds.length,
      });
      finish({ outcome: 'filed', hazardId: String(hazardId) }, current.draftId);
    } catch (e) {
      setError(messageOf(e, 'Couldn’t save that hazard. Check your connection and try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const post = () => {
    const shape = shapeOf(draft);
    const type = draft.hazardType;
    if (shape === null || type === null) return;
    // The nudge (D80): an open hazard of the same family already sits here. Asked once, at Post,
    // and only if this skater hasn't already said theirs is a different one.
    const candidate =
      draft.dismissedDuplicateOf === null && liveHazards
        ? findDuplicateCandidate(
            {
              type,
              geometryKind: shape.geometryKind,
              geometry: shape.geometry,
              ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
              ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
            },
            liveHazards.map((h) => ({
              id: h._id as string,
              type: h.type,
              geometryKind: h.geometryKind,
              geometry: h.geometry as HazardShape['geometry'],
              ...(h.radiusMeters !== undefined ? { radiusMeters: h.radiusMeters } : {}),
              ...(h.bufferMeters !== undefined ? { bufferMeters: h.bufferMeters } : {}),
              ...(h.clippedFootprint !== undefined
                ? { clippedFootprint: h.clippedFootprint as HazardShape['geometry'] }
                : {}),
              bbox: h.bbox,
              firstReportedAt: h.firstReportedAt,
              lastConfirmedAt: h.lastConfirmedAt,
            })),
          )
        : null;
    if (candidate) {
      apply((d) => ({ ...d, nearbyHazardId: candidate.hazard.id, step: 'confirm' }));
      setNudge({
        text: duplicateNudge(candidate.hazard.type, {
          reportedAgo: relativeWhen(candidate.hazard.firstReportedAt, Date.now()),
        }),
      });
      return;
    }
    void file(draft, shape, draft.dismissedDuplicateOf);
  };

  const confirmNearby = async () => {
    const hazardId = draft.nearbyHazardId;
    const confirmingDraftId = draft.draftId;
    if (hazardId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await confirmHazard({
        hazardId: hazardId as Id<'hazards'>,
        verdict: 'still_there',
        via: 'duplicate_nudge',
      });
      capture('existing_hazard_confirmed', { confirmation_source: 'duplicate_nudge' });
      finish({ outcome: 'confirmed', hazardId }, confirmingDraftId);
    } catch (e) {
      setNudge(null);
      apply((d) => ({ ...d, nearbyHazardId: null, step: stepOf({ ...d, nearbyHazardId: null }) }));
      setError(messageOf(e, 'Couldn’t confirm that one. File yours instead if you prefer.'));
    } finally {
      setSubmitting(false);
    }
  };

  // One tap: dismiss and file. The id goes straight to `file`, so the pin lands on this tap.
  const fileDistinct = () => {
    const dismissed = draft.nearbyHazardId;
    const shape = shapeOf(draft);
    setNudge(null);
    const next = {
      ...draft,
      nearbyHazardId: null,
      dismissedDuplicateOf: dismissed,
    };
    useHazardDraftStore.getState().setDraft({ ...next, step: stepOf(next) });
    if (shape !== null) void file(next, shape, dismissed);
  };

  const lostPhotos = restored && photoFiles.length === 0 ? draft.photoCount : 0;

  return (
    <>
      {instrument === undefined && <RegionFlowSpec spec={map.spec} handlers={map.handlers} />}
      <HazardFlowView
        draft={draft}
        photos={photos}
        lostPhotos={lostPhotos}
        // The nudge was asked about the draft's `nearbyHazardId`; whatever clears that (a new type,
        // no type) takes the prompt down with it, so a stale one never holds Post.
        nudge={draft.nearbyHazardId !== null ? nudge : null}
        error={error}
        submitting={submitting}
        {...(container !== undefined ? { container } : {})}
        onChooseType={(type) => apply((d) => chooseType(d, type))}
        onClearType={() => apply(clearType)}
        onChooseDrawKind={(kind) => apply((d) => chooseDrawKind(d, kind))}
        onStopPlacing={() => apply(stopPlacing)}
        onUndo={() => apply(undoPlacement)}
        onFlipShore={() => apply((d) => flipShore(d, polygon))}
        onResize={(direction) => apply((d) => resize(d, direction, polygon))}
        onNoteChange={(note) => apply((d) => ({ ...d, note }))}
        onAddPhotos={(files) => store.setPhotoFiles([...photoFiles, ...files])}
        onRemovePhoto={(id) => store.setPhotoFiles(photoFiles.filter((f) => photoIdOf(f) !== id))}
        onConfirmNearby={() => void confirmNearby()}
        onFileDistinct={fileDistinct}
        onPost={post}
        onCancel={() => {
          useHazardDraftStore.getState().clearDraft();
          leave();
        }}
      />
    </>
  );
}
