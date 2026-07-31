import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  DUPLICATE_NUDGE_CONFIRM,
  DUPLICATE_NUDGE_DISTINCT,
  deriveShoreBand,
  draftForType,
  draftPlacementCount,
  draftToShape,
  duplicateNudge,
  findDuplicateCandidate,
  HAZARD_BUFFER_STEPS_M,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardAuthorableKind,
  type HazardDraft,
  type HazardShape,
  type HazardType,
  isPassageMarker,
  offersShoreBand,
  relativeWhen,
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

/** The geometry union the clustering primitive accepts, narrowed from Convex's broad `geoJson`. */
type HazardDraftGeometry = HazardShape['geometry'];

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
  /**
   * Are two shore clicks in hand, so the ± stepper is tuning the **band half-width**?
   *
   * True **even when the last attempt was refused**, which is the point of the name. The width is the
   * escape from the commonest refusal — a band wide enough to close on itself — so a flag that went
   * false on an error would take away the one control that fixes it, and hand the same − button back
   * to the draft's own halo instead. A refusal is a state of the band, not the end of snapping.
   */
  deriving: boolean;
  /**
   * The band half-width, in metres. Carried on the prop rather than read off the draft because
   * Decision 3 stores a snapped band as an ordinary polygon: this number is an *input* to deriving
   * that ring, not a property of it, and putting it on the draft would give a polygon two widths.
   */
  halfWidthMeters: number;
  /**
   * The type's uncertainty halo, in metres — what `hazardFootprint` adds *outside* the derived ring.
   *
   * Here so the UI can say `halfWidthMeters + haloMeters` out loud. A band is the one primitive where
   * the number under the stepper is **not** the whole footprint: on a line the buffer *is* the
   * footprint, on a hand-drawn area the number is explicitly "give around the edge", but a band's
   * half-width is a claim about the ice with the type's margin still to come. Left implicit, that reads
   * as a footprint 10 m bigger than the skater was told — and a reviewer read it as a double-buffer bug,
   * which is a fair thing to conclude from copy that doesn't mention it.
   */
  haloMeters: number;
  /** Metres of shoreline the band covers, once derived. */
  arcLengthMeters: number | null;
  /** Why the last attempt was refused, if it was. */
  error: string | null;
  /** Arm (or re-arm) the two-click shore pick. */
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
  // Not gated on `isArea`: a *refused* first snap leaves the draft as whatever it was (a circle), and
  // the width stepper still has to mean the band's half-width, because narrowing is the way out.
  const banding = shore?.deriving === true;
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
          {/* While a band is being derived it is the *only* thing worth describing — the corner count
              of a ring nobody placed by hand isn't news, and on a refusal the reason renders below. */}
          {banding ? (
            <p className="text-sm">
              {shore?.arcLengthMeters !== null && shore?.arcLengthMeters !== undefined
                ? `Following ${Math.round(shore.arcLengthMeters)} m of shoreline.`
                : 'Picking a stretch of shore.'}
            </p>
          ) : placements === 0 ? (
            <p className="text-foreground-muted text-sm">Not placed yet.</p>
          ) : isLine ? (
            <p className="text-sm">
              Traced with {placements} {placements === 1 ? 'point' : 'points'}
              {placements === 1 ? ' — a line needs at least two.' : '.'}
            </p>
          ) : isArea ? (
            <p className="text-sm">
              Drawn with {placements} {placements === 1 ? 'corner' : 'corners'}
              {placements < 3 ? ' — an area needs at least three.' : '.'}
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
            {banding ? (
              <>
                {/* Two ways round a lake, and "shorter" is right almost always and silently wrong
                    on a small pond where the band you mean is most of the perimeter (Decision 4).
                    Both of these stay offered through a refusal — they are two of the three ways out
                    of one, the third being the − stepper. */}
                <Button variant="ghost" size="sm" onClick={() => shore?.onFlip()}>
                  Go the other way round
                </Button>
                <Button variant="ghost" size="sm" onClick={() => shore?.onStart()}>
                  Pick a different stretch
                </Button>
              </>
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
            {shore?.offered && !banding ? (
              <p className="text-foreground-muted text-xs">
                “Along the shore” follows the lake’s own outline between two clicks — no tracing.
              </p>
            ) : null}
            {banding && isArea ? (
              <p className="text-foreground-muted text-xs">
                Adjusting the corners by hand takes it off the shoreline — after that it’s an
                ordinary area, and the width below becomes a margin around it.
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
            {banding
              ? 'How far out from shore?'
              : isLine
                ? 'Roughly how wide?'
                : 'Roughly how big?'}
          </Label>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              aria-label={banding || isLine ? 'Narrower' : 'Smaller'}
              onClick={() => onResize(-1)}
            >
              −
            </Button>
            <span className="text-sm">
              {/* `banding` is checked before the primitive, not after: a refused snap can leave the
                  draft a circle, and the number under the stepper has to be the one the stepper is
                  actually moving. */}
              {banding
                ? `about ${shore?.halfWidthMeters ?? 0} m out from the shoreline — warned to ${
                    (shore?.halfWidthMeters ?? 0) + (shore?.haloMeters ?? 0)
                  } m`
                : draft.geometryKind === 'point_radius'
                  ? `about ${draft.radiusMeters} m across the radius`
                  : draft.geometryKind === 'line'
                    ? `about ${draft.bufferMeters} m to either side of the line`
                    : `about ${draft.bufferMeters} m of give around the edge`}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label={banding || isLine ? 'Wider' : 'Bigger'}
              onClick={() => onResize(1)}
            >
              +
            </Button>
          </div>
          <p className="text-foreground-muted text-xs">
            {banding
              ? `An estimate is fine — the band shows roughly how far out the ice is affected, not an exact edge. Warnings start ${shore?.haloMeters ?? 0} m further out than that, the same margin every hazard of this type gets for being an estimate rather than a survey. The part that falls on land is trimmed off.`
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
  const confirmHazard = useMutation(api.hazardConfirmations.confirm);
  /**
   * The body's live hazards, for the draw-time nudge (D80, layer 1). The map is already subscribed to
   * this query, so it costs nothing extra and — crucially — it is data the client already holds, which
   * is what lets the nudge work with no signal. On-ice is exactly where duplicates happen.
   */
  const liveHazards = useQuery(api.hazards.listForBody, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  });
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
  /**
   * The pin the nudge is currently offering, and the one the skater has already said is different.
   *
   * Two pieces of state rather than one, because they answer different questions: the first is "what
   * are we showing right now", the second is "what have they already ruled out" — and the second has
   * to survive the submit it unblocks, because it rides along to the server so auto-merge can't
   * overrule them a second later.
   */
  const [nudge, setNudge] = useState<{ hazardId: string; type: HazardType; at: number } | null>(
    null,
  );
  const [dismissedDuplicateOf, setDismissedDuplicateOf] = useState<string | null>(null);

  const offersShore = type !== null && offersShoreBand(type);
  const snapping = hazardShoreTaps !== null;
  /**
   * Two clicks in hand, so the ± stepper is on the band's half-width — **including after a refusal**,
   * because narrowing is the way out of the commonest one.
   */
  const deriving = snapping && hazardShoreTaps.length === 2;
  // Fetched only once someone actually arms the snap, not merely for picking a shore-shaped type.
  // A body document carries its whole polygon — Champlain's is 116 rings — and most `thin_ice` reports
  // are an ordinary circle, so type selection is the wrong trigger. Arming gives it two clicks of head
  // start, and the derive effect below re-runs when the polygon lands.
  const body = useQuery(
    api.waterBodies.get,
    offersShore && snapping ? { waterBodyId: waterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const bodyPolygon = body?.available ? (body.body.polygon as Polygon | MultiPolygon) : null;

  // Two taps in hand ⇒ derive the band. Re-runs when the width or the direction changes, which is
  // what makes both of those live controls rather than a re-pick.
  useEffect(() => {
    if (!type || !hazardShoreTaps || hazardShoreTaps.length < 2) return;
    if (!bodyPolygon) {
      // `undefined` is the query still in flight, which the "Picking a stretch of shore" copy already
      // covers. A *resolved* query with no usable polygon is a dead end, and has to say so rather than
      // leave that copy on screen forever.
      if (body !== undefined) setShoreError(shoreBandRefusalText('no_boundary'));
      return;
    }
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
  }, [type, hazardShoreTaps, body, bodyPolygon, shoreHalfWidth, shoreOtherWay, setHazardDraft]);

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
    //
    // A **snapped band is the exception**, and this is what makes the reset above honest rather than
    // cosmetic. D67 has a polygon survive a re-type because reaching one costs a deliberate opt-in
    // plus three placements — but a band cost two clicks and was derived *for a shore-shaped type*.
    // Carrying it over is how a `pressure_ridge` ends up shaped exactly like a shoreline, which no
    // one chose. So a hand-drawn area survives (D67) and a band starts over.
    const nextDraft =
      hazardDraft && !deriving ? retypeDraft(hazardDraft, next) : draftForType(next);
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

  /**
   * Arm the map for whatever the draft needs next.
   *
   * A snapped band handed to the vertex editor **stops being a snapped band** — which is Decision 3
   * taken seriously rather than only stated: snapping is an input convenience, not a stored
   * relationship, so the moment someone drags a corner the shoreline is no longer what defines the
   * shape. Clearing the taps here is also what keeps the map's click handler from treating the next
   * click as a third shore pick, which is what it would otherwise do.
   */
  function requestPlace() {
    // `deriving`, not "derived successfully": leaving the taps armed after a *refused* snap is exactly
    // how the next click gets eaten as a third shore pick instead of placing anything.
    if (deriving) {
      setHazardShoreTaps(null);
      setShoreArcLength(null);
      setShoreError(null);
    }
    setHazardDropMode(true);
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
   * One stepper, two meanings (Decision 3). While two shore clicks are in hand it tunes the **band
   * half-width** and the effect above re-derives the ring; otherwise it steps the draft's own size.
   * Only one of those is ever on screen, which is what keeps "two widths in the model" from becoming
   * two widths in the UI.
   *
   * Deliberately keyed on `deriving` rather than on the band having come back valid: the width is the
   * escape from a band that closed on itself, so a refusal must not be the thing that takes the escape
   * away. It also runs with no draft at all, which a first refused snap can leave you with.
   */
  function resize(direction: 1 | -1) {
    if (deriving) {
      setShoreHalfWidth((current) => stepSize(current, HAZARD_BUFFER_STEPS_M, direction));
      return;
    }
    if (!hazardDraft) return;
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
    // **The nudge** (D80, layer 1). Checked here rather than while drawing, so it interrupts once, at
    // the moment the skater has actually decided what they are filing — and only if they haven't
    // already told us this is a different hazard.
    const candidate =
      dismissedDuplicateOf === null && liveHazards
        ? findDuplicateCandidate(
            {
              type,
              geometryKind: shape.geometryKind,
              geometry: shape.geometry,
              ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
              ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
            },
            liveHazards.map((h) => ({
              id: h._id,
              type: h.type,
              geometryKind: h.geometryKind,
              geometry: h.geometry as HazardDraftGeometry,
              ...(h.radiusMeters !== undefined ? { radiusMeters: h.radiusMeters } : {}),
              ...(h.bufferMeters !== undefined ? { bufferMeters: h.bufferMeters } : {}),
              ...(h.clippedFootprint !== undefined
                ? { clippedFootprint: h.clippedFootprint as HazardDraftGeometry }
                : {}),
              bbox: h.bbox,
              firstReportedAt: h.firstReportedAt,
              lastConfirmedAt: h.lastConfirmedAt,
            })),
          )
        : null;
    if (candidate) {
      setNudge({
        hazardId: candidate.hazard.id,
        type: candidate.hazard.type,
        at: candidate.hazard.firstReportedAt,
      });
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
        // Rides along so auto-merge can't overrule a person who was standing on the ice looking at it.
        ...(dismissedDuplicateOf
          ? { dismissedDuplicateOf: dismissedDuplicateOf as Id<'hazards'> }
          : {}),
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

  /** Turn the duplicate into the corroboration it was about to replace — the outcome that helps most. */
  async function confirmExisting(hazardId: string) {
    setSubmitting(true);
    setError(null);
    try {
      await confirmHazard({
        hazardId: hazardId as Id<'hazards'>,
        verdict: 'still_there',
        via: 'duplicate_nudge',
      });
      setType(null);
      setDescription('');
      setHazardDraft(null);
      setHazardShoreTaps(null);
      onClose();
    } catch (e) {
      setNudge(null);
      setError(
        e instanceof ConvexError
          ? String(e.data)
          : 'Could not confirm that one — file yours instead if you prefer.',
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
        {/* The nudge (D80, layer 1). Confirming is primary because it turns a second pin into the
            corroboration the first one was missing; the way past is one tap and is never discouraged,
            because a skater looking at something the map has wrong must not be argued with. */}
        {nudge ? (
          <div className="space-y-3 rounded-md border border-border bg-surface-muted p-3">
            <p className="text-sm">
              {duplicateNudge(nudge.type, { reportedAgo: relativeWhen(nudge.at, Date.now()) })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => confirmExisting(nudge.hazardId)} disabled={submitting}>
                {DUPLICATE_NUDGE_CONFIRM}
              </Button>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  setDismissedDuplicateOf(nudge.hazardId);
                  setNudge(null);
                }}
              >
                {DUPLICATE_NUDGE_DISTINCT}
              </Button>
            </div>
          </div>
        ) : null}
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
            deriving,
            halfWidthMeters: shoreHalfWidth,
            // The same value the derive effect stores as the band's `bufferMeters`, so what the copy
            // promises and what `hazardFootprint` adds can't drift apart.
            haloMeters: type ? HAZARD_DEFAULT_BUFFER_M[type] : 0,
            arcLengthMeters: shoreArcLength,
            error: shoreError,
            onStart: startSnap,
            onFlip: () => setShoreOtherWay((current) => !current),
          }}
          onChooseType={chooseType}
          onChooseKind={chooseKind}
          onDraftChange={setHazardDraft}
          onResize={resize}
          onRequestPlace={requestPlace}
          onDescriptionChange={setDescription}
          onSubmit={submit}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
