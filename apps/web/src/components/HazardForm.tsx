import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  HAZARD_DEFAULT_RADIUS_M,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardType,
  isPassageMarker,
} from '@skating/core'
import { useMutation } from 'convex/react'
import { useEffect, useState } from 'react'
import { useMapSelection } from './MapSelectionContext'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

/**
 * Hazard authoring — the web half of D51.
 *
 * The shape of this form follows the same rule as the mobile on-ice flow: **pick a type, place a
 * pin, done.** Everything else (resizing, a note) is optional, because the type's own default radius
 * is already a reasonable footprint and an over-long form is how safety reports don't get filed.
 *
 * v1 authors **point + radius** only. Polyline authoring for ridges and cracks lands in the next
 * commit; freeform polygon is deferred (it renders, it just isn't drawable — D51 build staging).
 */

/** The radius steppers, in metres. Coarse on purpose — this is an estimate, not a survey (D3). */
const RADIUS_STEPS = [10, 25, 50, 100, 200, 400]

function nextRadius(current: number, direction: 1 | -1): number {
  const sorted = RADIUS_STEPS
  if (direction === 1)
    return sorted.find((r) => r > current) ?? sorted[sorted.length - 1] ?? current
  return [...sorted].reverse().find((r) => r < current) ?? sorted[0] ?? current
}

export function HazardForm({
  waterBodyId,
  open,
  onClose,
}: {
  waterBodyId: string
  open: boolean
  onClose: () => void
}) {
  const createHazard = useMutation(api.hazards.create)
  const { hazardDraft, setHazardDraft, hazardDropMode, setHazardDropMode } = useMapSelection()

  const [type, setType] = useState<HazardType | null>(null)
  const [showAllTypes, setShowAllTypes] = useState(false)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Leaving the form must never strand the map in crosshair mode or leave a phantom footprint
  // sitting on the lake — the same teardown discipline the report form's put-in pin uses.
  useEffect(() => {
    if (!open) {
      setHazardDropMode(false)
      setHazardDraft(null)
    }
  }, [open, setHazardDropMode, setHazardDraft])

  function chooseType(next: HazardType) {
    setType(next)
    // Swap in the type's own default footprint. A drilled hole and a thaw-rotten zone are two orders
    // of magnitude apart, so starting near the truth matters more than starting consistent.
    const radiusMeters = HAZARD_DEFAULT_RADIUS_M[next]
    setHazardDraft(hazardDraft ? { ...hazardDraft, radiusMeters } : null)
    if (!hazardDraft) setHazardDropMode(true)
  }

  async function submit() {
    if (!type) {
      setError('Pick what kind of hazard this is.')
      return
    }
    if (!hazardDraft) {
      setError('Place the hazard on the map.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await createHazard({
        waterBodyId: waterBodyId as Id<'waterBodies'>,
        type,
        geometryKind: 'point_radius',
        geometry: {
          type: 'Point',
          coordinates: [hazardDraft.coord.lng, hazardDraft.coord.lat],
        },
        radiusMeters: hazardDraft.radiusMeters,
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      setType(null)
      setDescription('')
      setHazardDraft(null)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that hazard.')
    } finally {
      setSubmitting(false)
    }
  }

  const otherTypes = HAZARD_TYPES.filter(
    (t) => !(HAZARD_TYPE_PRESETS as readonly string[]).includes(t),
  )

  return (
    // Hidden (not unmounted) while arming a map click, so the in-progress form survives the placement.
    <Dialog open={open && !hazardDropMode} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report a hazard</DialogTitle>
        </DialogHeader>

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
                  onClick={() => chooseType(preset)}
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
                    onClick={() => chooseType(other)}
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

          <div className="space-y-2">
            <Label>Where is it?</Label>
            {hazardDraft ? (
              <p className="text-sm">
                Placed at {hazardDraft.coord.lat.toFixed(4)}, {hazardDraft.coord.lng.toFixed(4)}
              </p>
            ) : (
              <p className="text-foreground-muted text-sm">Not placed yet.</p>
            )}
            <Button variant="outline" size="sm" onClick={() => setHazardDropMode(true)}>
              {hazardDraft ? 'Move on map' : 'Place on map'}
            </Button>
          </div>

          {hazardDraft ? (
            <div className="space-y-2">
              <Label>Roughly how big?</Label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Smaller"
                  onClick={() =>
                    setHazardDraft({
                      ...hazardDraft,
                      radiusMeters: nextRadius(hazardDraft.radiusMeters, -1),
                    })
                  }
                >
                  −
                </Button>
                <span className="text-sm">
                  about {hazardDraft.radiusMeters} m across the radius
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Bigger"
                  onClick={() =>
                    setHazardDraft({
                      ...hazardDraft,
                      radiusMeters: nextRadius(hazardDraft.radiusMeters, 1),
                    })
                  }
                >
                  +
                </Button>
              </div>
              <p className="text-foreground-muted text-xs">
                An estimate is fine — the marker is drawn as an approximate area, not an exact edge.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="hazard-description">Anything worth adding? (optional)</Label>
            <Textarea
              id="hazard-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. running the length of the narrows, water showing at the edges"
            />
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting || !type || !hazardDraft}>
              {submitting ? 'Saving…' : 'Post hazard'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
