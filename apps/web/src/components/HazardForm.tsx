import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  draftForType,
  draftPlacementCount,
  draftToShape,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardDraft,
  type HazardType,
  isPassageMarker,
  resizeDraft,
  retypeDraft,
  switchDraftKind,
  undoDraftPlacement,
} from '@skating/core'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useEffect, useState } from 'react'
import { useMapSelection } from './MapSelectionContext'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { type PhotoDraftView, usePhotoDrafts } from './usePhotoDrafts'

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
 * hole or a zone, which a circle describes at least as well as a hand-drawn shape would. Either
 * primitive can be swapped for the other — you might only know the one spot on a ridge you crossed.
 *
 * Freeform polygon is still not authorable (D51 build staging, call 5): it renders and it stores, it
 * just has no editor.
 *
 * All draft state lives in `@skating/core` so mobile's gloved-thumb version of this is the same
 * state machine, not a parallel reimplementation that can drift on what counts as a valid hazard.
 * The fields are split out presentationally (as `ReportForm` does) so the authoring rules — which
 * primitive a type gets, when a line becomes postable — are testable without Convex or WebGL.
 */

export function HazardFormFields({
  type,
  draft,
  description,
  error,
  submitting,
  photos,
  onChooseType,
  onDraftChange,
  onRequestPlace,
  onDescriptionChange,
  onAddFiles,
  onRemovePhoto,
  onSubmit,
  onCancel,
}: {
  type: HazardType | null
  draft: HazardDraft | null
  description: string
  error: string | null
  submitting: boolean
  photos: PhotoDraftView[]
  onChooseType: (type: HazardType) => void
  onDraftChange: (draft: HazardDraft) => void
  onRequestPlace: () => void
  onDescriptionChange: (description: string) => void
  onAddFiles: (files: FileList) => void
  onRemovePhoto: (id: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const [showAllTypes, setShowAllTypes] = useState(false)

  const isLine = draft?.geometryKind === 'line'
  const placements = draft ? draftPlacementCount(draft) : 0
  const postable = draft !== null && draftToShape(draft) !== null

  const otherTypes = HAZARD_TYPES.filter(
    (t) => !(HAZARD_TYPE_PRESETS as readonly string[]).includes(t),
  )

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
          ) : (
            <p className="text-sm">Placed on the map.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onRequestPlace}>
              {placements === 0
                ? isLine
                  ? 'Trace on map'
                  : 'Place on map'
                : isLine
                  ? 'Keep tracing'
                  : 'Move on map'}
            </Button>
            {placements > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDraftChange(undoDraftPlacement(draft))}
              >
                {isLine ? 'Undo last point' : 'Clear'}
              </Button>
            ) : null}
          </div>
          {/* Either primitive is available for any type, because both mistakes are real: you may
              only know the one spot on a ridge where you crossed it, or you may realise the open
              water you started marking is a lead running across the bay. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onDraftChange(switchDraftKind(draft, isLine ? 'point_radius' : 'line', type))
            }
          >
            {isLine ? 'Mark a single spot instead' : 'Draw it as a line instead'}
          </Button>
        </div>
      ) : null}

      {draft ? (
        <div className="space-y-2">
          <Label>{isLine ? 'Roughly how wide?' : 'Roughly how big?'}</Label>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              aria-label={isLine ? 'Narrower' : 'Smaller'}
              onClick={() => onDraftChange(resizeDraft(draft, -1))}
            >
              −
            </Button>
            <span className="text-sm">
              {draft.geometryKind === 'line'
                ? `about ${draft.bufferMeters} m to either side of the line`
                : `about ${draft.radiusMeters} m across the radius`}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label={isLine ? 'Wider' : 'Bigger'}
              onClick={() => onDraftChange(resizeDraft(draft, 1))}
            >
              +
            </Button>
          </div>
          <p className="text-foreground-muted text-xs">
            {isLine
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
            if (e.target.files) onAddFiles(e.target.files)
            e.target.value = '' // allow re-selecting the same file
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
  )
}

export function HazardForm({
  waterBodyId,
  onClose,
}: {
  waterBodyId: string
  /**
   * Close the form. The caller *unmounts* us rather than keeping us mounted-but-closed — which is
   * what makes the unmount cleanup below the only teardown path that needs to exist.
   */
  onClose: () => void
}) {
  const createHazard = useMutation(api.hazards.create)
  const {
    hazardDraft,
    setHazardDraft,
    hazardDraftType: type,
    setHazardDraftType: setType,
    hazardDropMode,
    setHazardDropMode,
  } = useMapSelection()

  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Same pipeline as report photos, so the same hook — it owns the checkpointed upload and the
  // reclaim-on-abandon sweep, which a hazard form abandoned mid-upload needs just as much.
  const photoDrafts = usePhotoDrafts()

  // Leaving the form must never strand the map in crosshair mode or leave a phantom footprint
  // sitting on the lake — the same teardown discipline (and idiom) as the report form's put-in pin.
  // It has to be an unmount cleanup, not an `!open` branch: the draft lives in MapSelectionContext,
  // which outlives this component, so cancelling or navigating away mid-draw would otherwise leave a
  // translucent red hazard drawn over a lake nobody reported a hazard on.
  useEffect(() => {
    return () => {
      setHazardDropMode(false)
      setHazardDraft(null)
      setType(null)
    }
  }, [setHazardDropMode, setHazardDraft, setType])

  function chooseType(next: HazardType) {
    setType(next)
    // Re-typing keeps whatever has already been placed but adopts the new type's primitive and
    // default size: a drilled hole and a thaw-rotten zone are two orders of magnitude apart, so
    // starting near the truth matters more than starting consistent.
    const nextDraft = hazardDraft ? retypeDraft(hazardDraft, next) : draftForType(next)
    setHazardDraft(nextDraft)
    // Nothing placed yet ⇒ go straight to the map. A line stays armed across clicks (MapView).
    if (draftPlacementCount(nextDraft) === 0) setHazardDropMode(true)
  }

  async function submit() {
    const shape = hazardDraft ? draftToShape(hazardDraft) : null
    if (!type) {
      setError('Pick what kind of hazard this is.')
      return
    }
    if (!shape) {
      setError(
        hazardDraft?.geometryKind === 'line'
          ? 'Trace the hazard on the map — a line needs at least two points.'
          : 'Place the hazard on the map.',
      )
      return
    }
    setSubmitting(true)
    setError(null)
    photoDrafts.clearError() // a photo that was already removed shouldn't keep failing the form
    try {
      const photoIds = await photoDrafts.uploadAll()
      // Before the mutation, not after: an unmount *during* it would otherwise sweep and delete the
      // very photo rows the committing hazard is about to reference.
      photoDrafts.setCommitted(true)
      await createHazard({
        waterBodyId: waterBodyId as Id<'waterBodies'>,
        type,
        geometryKind: shape.geometryKind,
        geometry: shape.geometry,
        ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
        ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(photoIds.length > 0 ? { photoIds } : {}),
      })
      setType(null)
      setDescription('')
      setHazardDraft(null)
      onClose()
    } catch (e) {
      photoDrafts.setCommitted(false) // creation didn't complete — uploads are reclaimable again
      // A ConvexError carries the message the mutation *chose* to show a skater; anything else would
      // render the raw `[CONVEX M(hazards:create)] Uncaught …` blob at them.
      setError(
        e instanceof ConvexError
          ? String(e.data)
          : e instanceof Error
            ? e.message
            : 'Could not save that hazard.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Hidden (not unmounted) while arming a map click, so the in-progress form survives the
    // placement — and, for a polyline, survives the whole multi-click trace.
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
          onChooseType={chooseType}
          onDraftChange={setHazardDraft}
          onRequestPlace={() => setHazardDropMode(true)}
          onDescriptionChange={setDescription}
          onSubmit={submit}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
