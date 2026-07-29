import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  deriveShoreBand,
  draftForType,
  draftPlacementCount,
  draftToShape,
  HAZARD_BUFFER_STEPS_M,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardAuthorableKind,
  type HazardDraft,
  type HazardType,
  isPassageMarker,
  offersShoreBand,
  resizeDraft,
  retypeDraft,
  SHORE_BAND_DEFAULT_HALF_WIDTH_M,
  shoreBandRefusalText,
  stepSize,
  switchDraftKind,
  undoDraftPlacement,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { useEffect, useState } from 'react';
import { useMapSelection } from './MapSelectionContext';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { type PhotoDraftView, usePhotoDrafts } from './usePhotoDrafts';

/**
 * Hazard authoring — the web half of D51.
 *
 * The shape of this form follows the same rule as the mobile on-ice flow: **pick a type, place it,
 * done.** Everything else (resizing, a note) is optional, because the type's own defaults are
 * already a reasonable footprint and an over-long form is how safety reports don't get filed.
 *
 * The primitive follows the hazard rather than the other way round: picking a ridge, a heave or a
 * working crack puts you in polyline mode, because those things are lines on the ice and a circle
 * drawn over one either misses most of it or swallows half the lake. Everything else is a blob, a
 * hole or a zone, which a circle describes at least as well as a hand-drawn shape would. Any
 * primitive can be swapped for any other — you might only know the one spot on a ridge you crossed.
 *
 * **Freeform areas landed in N5b**, the primitive D51 always called opt-in and advanced. No type
 * *starts* as one; you reach it by choosing "an area", which lazily loads terra-draw on the map and
 * gives you real vertex dragging. That chunk is fetched by the person who asked for the tool and
 * nobody else, which was the founder call on whether a skater-facing route may load it at all.
 *
 * **Snap-to-shoreline** (N5b, `thin_ice` and `open_water`) is the same primitive reached differently:
 * two clicks near the shore, and the band comes off the lake's own boundary. It produces an ordinary
 * polygon draft — nothing downstream knows it was snapped — which is the whole reason it can share
 * every control below.
 *
 * All draft state lives in `@skating/core` so mobile's gloved-thumb version of this is the same
 * state machine, not a parallel reimplementation that can drift on what counts as a valid hazard.
 * The fields are split out presentationally (as `ReportForm` does) so the authoring rules — which
 * primitive a type gets, when a line becomes postable — are testable without Convex or WebGL.
 */

/** The three primitives, in the order they cost effort. */
const KIND_LABELS: { kind: HazardAuthorableKind; label: string }[] = [
  { kind: 'point_radius', label: 'A spot' },
  { kind: 'line', label: 'A line' },
  { kind: 'polygon', label: 'An area' },
];

/** What the hazard form needs to know about an in-progress snap. */
export interface ShoreBandState {
  /** Does this type offer snapping at all? (`thin_ice` / `open_water` — N5b Decision 1.) */
  offered: boolean;
  /** Is a snapped band the current draft? Governs which width the ± stepper tunes. */
  active: boolean;
  /**
   * The band half-width, in metres. Carried on the prop rather than read off the draft because
   * Decision 3 stores a snapped band as an ordinary polygon: this number is an *input* to deriving
   * that ring, not a property of it, and putting it on the draft would give a polygon two widths.
   */
  halfWidthMeters: number;
  /** Metres of shoreline the band covers, once derived. */
  arcLengthMeters: number | null;
  /** Why the last attempt was refused, if it was. */
  error: string | null;
  /** Arm the two-click shore pick. */
  onStart: () => void;
  /** Take the other way round the lake (Decision 4). */
  onFlip: () => void;
}

export function HazardFormFields({
  type,
  draft,
  description,
  error,
  submitting,
  photos,
  shore,
  onChooseType,
  onChooseKind,
  onDraftChange,
  onResize,
  onRequestPlace,
  onDescriptionChange,
  onAddFiles,
  onRemovePhoto,
  onSubmit,
  onCancel,
}: {
  type: HazardType | null;
  draft: HazardDraft | null;
  description: string;
  error: string | null;
  submitting: boolean;
  photos: PhotoDraftView[];
  shore?: ShoreBandState;
  onChooseType: (type: HazardType) => void;
  onChooseKind: (kind: HazardAuthorableKind) => void;
  onDraftChange: (draft: HazardDraft) => void;
  onResize: (direction: 1 | -1) => void;
  onRequestPlace: () => void;
  onDescriptionChange: (description: string) => void;
  onAddFiles: (files: FileList) => void;
  onRemovePhoto: (id: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [showAllTypes, setShowAllTypes] = useState(false);

  const kind = draft?.geometryKind ?? null;
  const isLine = kind === 'line';
  const isArea = kind === 'polygon';
  const snapped = isArea && shore?.active === true;
  const placements = draft ? draftPlacementCount(draft) : 0;
  const postable = draft !== null && draftToShape(draft) !== null;

  const otherTypes = HAZARD_TYPES.filter(
    (t) => !(HAZARD_TYPE_PRESETS as readonly string[]).includes(t),
  );

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-medium text-sm">What did you see?</legend>
        {/* The three types that are ~80% of real reports get one-tap buttons; the rest are one
            click further away, so the common case stays fast (research §6). */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {HAZARD_TYPE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={type === preset}
              onClick={() => onChooseType(preset)}
              className={`rounded-md border p-3 text-left font-medium text-sm ${
                type === preset ? 'border-primary bg-primary/10' : 'border-border'
              }`}
            >
              {HAZARD_TYPE_LABELS[preset]}
            </button>
          ))}
        </div>
        {showAllTypes ? (
          <div className="grid grid-cols-2 gap-2">
            {otherTypes.map((other) => (
              <button
                key={other}
                type="button"
                aria-pressed={type === other}
                onClick={() => onChooseType(other)}
                className={`rounded-md border p-2 text-left text-sm ${
                  type === other ? 'border-primary bg-primary/10' : 'border-border'
                }`}
              >
                {HAZARD_TYPE_LABELS[other]}
                {isPassageMarker(other) ? (
                  <span className="block text-foreground-muted text-xs">
                    A place you got across — not a danger
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setShowAllTypes(true)}>
            More types…
          </Button>
        )}
      </fieldset>

      {draft && type ? (
        <div className="space-y-2">
          <Label>Where is it?</Label>
          {placements === 0 ? (
            <p className="text-foreground-muted text-sm">Not placed yet.</p>
          ) : isLine ? (
            <p className="text-sm">
              Traced with {placements} {placements === 1 ? 'point' : 'points'}
              {placements === 1 ? ' — a line needs at least two.' : '.'}
            </p>
          ) : isArea ? (
            <p className="text-sm">
              {snapped && shore?.arcLengthMeters !== null && shore?.arcLengthMeters !== undefined
                ? `Following ${Math.round(shore.arcLengthMeters)} m of shoreline.`
                : `Drawn with ${placements} ${placements === 1 ? 'corner' : 'corners'}`}
              {!snapped && placements < 3
                ? ' — an area needs at least three.'
                : !snapped
                  ? '.'
                  : ''}
            </p>
          ) : (
            <p className="text-sm">Placed on the map.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onRequestPlace}>
              {placements === 0
                ? isLine
                  ? 'Trace on map'
                  : isArea
                    ? 'Draw on map'
                    : 'Place on map'
                : isLine
                  ? 'Keep tracing'
                  : isArea
                    ? 'Adjust corners'
                    : 'Move on map'}
            </Button>
            {placements > 0 && !isArea ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDraftChange(undoDraftPlacement(draft))}
              >
                {isLine ? 'Undo last point' : 'Clear'}
              </Button>
            ) : null}
            {/* Two ways round a lake, and "shorter" is right almost always and silently wrong on a
                small pond where the band you mean is most of the perimeter (Decision 4). */}
            {snapped ? (
              <Button variant="ghost" size="sm" onClick={() => shore?.onFlip()}>
                Go the other way round
              </Button>
            ) : null}
          </div>

          {/* Any primitive is reachable from any other, because all of the mistakes are real: you may
              only know the one spot on a ridge where you crossed it, you may realise the open water
              you started marking is a lead running across the bay, or you may have walked the edge
              of a rotten patch and be able to say where it is. */}
          <fieldset className="space-y-1 pt-1">
            <legend className="text-foreground-muted text-xs">Draw it as…</legend>
            <div className="flex flex-wrap gap-2">
              {KIND_LABELS.map(({ kind: option, label }) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => onChooseKind(option)}
                  className={`rounded-md border px-3 py-1 text-sm ${
                    kind === option ? 'border-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  {label}
                </button>
              ))}
              {shore?.offered ? (
                <button
                  type="button"
                  onClick={() => shore.onStart()}
                  className="rounded-md border border-border px-3 py-1 text-sm"
                >
                  Along the shore
                </button>
              ) : null}
            </div>
            {shore?.offered && !snapped ? (
              <p className="text-foreground-muted text-xs">
                “Along the shore” follows the lake’s own outline between two clicks — no tracing.
              </p>
            ) : null}
            {shore?.error ? (
              <p className="text-destructive text-xs" role="alert">
                {shore.error}
              </p>
            ) : null}
          </fieldset>
        </div>
      ) : null}

      {draft ? (
        <div className="space-y-2">
          <Label>
            {snapped
              ? 'How far out from shore?'
              : isLine
                ? 'Roughly how wide?'
                : 'Roughly how big?'}
          </Label>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              aria-label={snapped ? 'Narrower' : isLine ? 'Narrower' : 'Smaller'}
              onClick={() => onResize(-1)}
            >
              −
            </Button>
            <span className="text-sm">
              {draft.geometryKind === 'point_radius'
                ? `about ${draft.radiusMeters} m across the radius`
                : snapped
                  ? `about ${shore?.halfWidthMeters ?? 0} m out from the shoreline`
                  : draft.geometryKind === 'line'
                    ? `about ${draft.bufferMeters} m to either side of the line`
                    : `about ${draft.bufferMeters} m of give around the edge`}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label={snapped || isLine ? 'Wider' : 'Bigger'}
              onClick={() => onResize(1)}
            >
              +
            </Button>
          </div>
          <p className="text-foreground-muted text-xs">
            {snapped
              ? 'An estimate is fine — the band shows roughly how far out the ice is affected, not an exact edge. The part that falls on land is trimmed off.'
              : isLine
                ? 'An estimate is fine — the band shows roughly how far the hazard reaches, not an exact edge. A folded pressure ridge is far wider than a hairline crack.'
                : 'An estimate is fine — the marker is drawn as an approximate area, not an exact edge.'}
          </p>
        </div>
      ) : null}

      {/* Photos. Ice hazards are intensely visual and notoriously hard to describe — "folded ridges
          are hard to see" is a recurring cause of death (research §2/§6) — so a picture is the
          highest-value thing one skater can leave the next. Plural, because a ridge or lead usually
          needs two angles, and entirely optional.
          There is no `placeOnMap` control here, unlike report photos: a hazard already *has* a
          location, and offering a second, differently-derived one would invite a photo's EXIF coord
          to contradict the footprint the alert measures against. The EXIF coord is never sent. */}
      <div className="space-y-2">
        <Label htmlFor="hazard-photos">Photos (optional)</Label>
        <p className="text-foreground-muted text-xs">
          Hard to describe, easy to show — a photo helps the next skater recognise it.
        </p>
        <input
          id="hazard-photos"
          type="file"
          accept="image/*"
          multiple
          className="block w-full text-sm"
          onChange={(e) => {
            if (e.target.files) onAddFiles(e.target.files);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
        <div className="flex flex-col gap-2">
          {photos.map((photo) => (
            <div key={photo.id} className="flex items-center gap-3">
              <img
                src={photo.previewUrl}
                alt="Upload preview"
                className="h-16 w-16 rounded-md object-cover"
              />
              <span className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemovePhoto(photo.id)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="hazard-description">Anything worth adding? (optional)</Label>
        <Textarea
          id="hazard-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="e.g. running the length of the narrows, water showing at the edges"
        />
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={submitting || !type || !postable}>
          {submitting ? 'Saving…' : 'Post hazard'}
        </Button>
      </div>
    </div>
  );
}

export function HazardForm({
  waterBodyId,
  onClose,
}: {
  waterBodyId: string;
  /**
   * Close the form. The caller *unmounts* us rather than keeping us mounted-but-closed — which is
   * what makes the unmount cleanup below the only teardown path that needs to exist.
   */
  onClose: () => void;
}) {
  const createHazard = useMutation(api.hazards.create);
  const {
    hazardDraft,
    setHazardDraft,
    hazardDraftType: type,
    setHazardDraftType: setType,
    hazardDropMode,
    setHazardDropMode,
    hazardShoreTaps,
    setHazardShoreTaps,
  } = useMapSelection();

  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Same pipeline as report photos, so the same hook — it owns the checkpointed upload and the
  // reclaim-on-abandon sweep, which a hazard form abandoned mid-upload needs just as much.
  const photoDrafts = usePhotoDrafts();

  /**
   * The snap's own state. It lives here rather than on the draft because Decision 3 stores a snapped
   * band as an **ordinary polygon** — the band half-width is an input to deriving that ring, not a
   * property of it, and putting it on the draft would give a polygon two widths that could disagree.
   */
  const [shoreHalfWidth, setShoreHalfWidth] = useState(SHORE_BAND_DEFAULT_HALF_WIDTH_M);
  const [shoreOtherWay, setShoreOtherWay] = useState(false);
  const [shoreError, setShoreError] = useState<string | null>(null);
  const [shoreArcLength, setShoreArcLength] = useState<number | null>(null);

  const offersShore = type !== null && offersShoreBand(type);
  // Only fetched for the two types that can snap. A body document carries its whole polygon —
  // Champlain's is 116 rings — so this is not a query to run on every hazard.
  const body = useQuery(
    api.waterBodies.get,
    offersShore ? { waterBodyId: waterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const bodyPolygon = body?.available ? (body.body.polygon as Polygon | MultiPolygon) : null;

  const snapping = hazardShoreTaps !== null;
  const snapped = snapping && hazardShoreTaps.length === 2 && shoreError === null;

  // Two taps in hand ⇒ derive the band. Re-runs when the width or the direction changes, which is
  // what makes both of those live controls rather than a re-pick.
  useEffect(() => {
    if (!type || !hazardShoreTaps || hazardShoreTaps.length < 2 || !bodyPolygon) return;
    const [a, b] = hazardShoreTaps as [{ lat: number; lng: number }, { lat: number; lng: number }];
    const result = deriveShoreBand(bodyPolygon, a, b, {
      halfWidthMeters: shoreHalfWidth,
      theOtherWay: shoreOtherWay,
    });
    if (!result.ok) {
      setShoreError(shoreBandRefusalText(result.reason));
      setShoreArcLength(null);
      return;
    }
    setShoreError(null);
    setShoreArcLength(result.band.arcLengthMeters);
    setHazardDraft({
      geometryKind: 'polygon',
      vertices: result.band.vertices,
      bufferMeters: HAZARD_DEFAULT_BUFFER_M[type],
    });
  }, [type, hazardShoreTaps, bodyPolygon, shoreHalfWidth, shoreOtherWay, setHazardDraft]);

  // Leaving the form must never strand the map in crosshair mode or leave a phantom footprint
  // sitting on the lake — the same teardown discipline (and idiom) as the report form's put-in pin.
  // It has to be an unmount cleanup, not an `!open` branch: the draft lives in MapSelectionContext,
  // which outlives this component, so cancelling or navigating away mid-draw would otherwise leave a
  // translucent red hazard drawn over a lake nobody reported a hazard on.
  useEffect(() => {
    return () => {
      setHazardDropMode(false);
      setHazardDraft(null);
      setType(null);
      setHazardShoreTaps(null);
    };
  }, [setHazardDropMode, setHazardDraft, setType, setHazardShoreTaps]);

  function chooseType(next: HazardType) {
    setType(next);
    // A type change abandons a snap: the band was derived for the old type's shape, and the new type
    // may not even offer snapping. Clearing is the honest reset — silently keeping the ring would
    // leave a `pressure_ridge` shaped exactly like a shoreline for no reason anyone chose.
    setHazardShoreTaps(null);
    setShoreError(null);
    setShoreArcLength(null);
    // Re-typing keeps whatever has already been placed but adopts the new type's primitive and
    // default size: a drilled hole and a thaw-rotten zone are two orders of magnitude apart, so
    // starting near the truth matters more than starting consistent.
    const nextDraft = hazardDraft ? retypeDraft(hazardDraft, next) : draftForType(next);
    setHazardDraft(nextDraft);
    // Nothing placed yet ⇒ go straight to the map. A line stays armed across clicks (MapView).
    if (draftPlacementCount(nextDraft) === 0) setHazardDropMode(true);
  }

  function chooseKind(kind: HazardAuthorableKind) {
    if (!hazardDraft || !type) return;
    setHazardShoreTaps(null);
    setShoreError(null);
    setShoreArcLength(null);
    const next = switchDraftKind(hazardDraft, kind, type);
    setHazardDraft(next);
    // An area is drawn by an engine that only exists while drop mode is on, so choosing it arms the
    // map — unlike the other two, where the draft is already usable and placing is a separate step.
    if (kind === 'polygon' && draftPlacementCount(next) < 3) setHazardDropMode(true);
  }

  function startSnap() {
    if (!type) return;
    setShoreError(null);
    setShoreArcLength(null);
    setShoreOtherWay(false);
    setShoreHalfWidth(SHORE_BAND_DEFAULT_HALF_WIDTH_M);
    setHazardShoreTaps([]);
    setHazardDropMode(true);
  }

  /**
   * One stepper, two meanings (Decision 3). While a snapped band is the draft it tunes the **band
   * half-width** and the effect above re-derives the ring; otherwise it steps the draft's own size.
   * Only one of those is ever on screen, which is what keeps "two widths in the model" from becoming
   * two widths in the UI.
   */
  function resize(direction: 1 | -1) {
    if (!hazardDraft) return;
    if (snapped) {
      setShoreHalfWidth((current) => stepSize(current, HAZARD_BUFFER_STEPS_M, direction));
      return;
    }
    setHazardDraft(resizeDraft(hazardDraft, direction));
  }

  async function submit() {
    const shape = hazardDraft ? draftToShape(hazardDraft) : null;
    if (!type) {
      setError('Pick what kind of hazard this is.');
      return;
    }
    if (!shape) {
      setError(
        hazardDraft?.geometryKind === 'line'
          ? 'Trace the hazard on the map — a line needs at least two points.'
          : hazardDraft?.geometryKind === 'polygon'
            ? 'Draw the area on the map — it needs at least three corners, and they can’t cross over each other.'
            : 'Place the hazard on the map.',
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    photoDrafts.clearError(); // a photo that was already removed shouldn't keep failing the form
    try {
      const photoIds = await photoDrafts.uploadAll();
      // Before the mutation, not after: an unmount *during* it would otherwise sweep and delete the
      // very photo rows the committing hazard is about to reference.
      photoDrafts.setCommitted(true);
      await createHazard({
        waterBodyId: waterBodyId as Id<'waterBodies'>,
        type,
        geometryKind: shape.geometryKind,
        geometry: shape.geometry,
        ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
        ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(photoIds.length > 0 ? { photoIds } : {}),
      });
      setType(null);
      setDescription('');
      setHazardDraft(null);
      setHazardShoreTaps(null);
      onClose();
    } catch (e) {
      photoDrafts.setCommitted(false); // creation didn't complete — uploads are reclaimable again
      // A ConvexError carries the message the mutation *chose* to show a skater; anything else would
      // render the raw `[CONVEX M(hazards:create)] Uncaught …` blob at them.
      setError(
        e instanceof ConvexError
          ? String(e.data)
          : e instanceof Error
            ? e.message
            : 'Could not save that hazard.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Hidden (not unmounted) while arming a map click, so the in-progress form survives the
    // placement — and, for a polyline or an area, survives the whole multi-click draw.
    <Dialog open={!hazardDropMode} onOpenChange={(next) => !next && !hazardDropMode && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report a hazard</DialogTitle>
        </DialogHeader>
        <HazardFormFields
          type={type}
          draft={hazardDraft}
          description={description}
          error={error ?? photoDrafts.error}
          photos={photoDrafts.photos}
          onAddFiles={photoDrafts.addFiles}
          onRemovePhoto={photoDrafts.removePhoto}
          submitting={submitting}
          shore={{
            offered: offersShore,
            active: snapped,
            halfWidthMeters: shoreHalfWidth,
            arcLengthMeters: shoreArcLength,
            error: shoreError,
            onStart: startSnap,
            onFlip: () => setShoreOtherWay((current) => !current),
          }}
          onChooseType={chooseType}
          onChooseKind={chooseKind}
          onDraftChange={setHazardDraft}
          onResize={resize}
          onRequestPlace={() => setHazardDropMode(true)}
          onDescriptionChange={setDescription}
          onSubmit={submit}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
