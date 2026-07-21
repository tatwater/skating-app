import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  buildReportInput,
  bundledHazardIds,
  emptyReportForm,
  emptyThicknessReading,
  humanizeEnum,
  ICE_TYPES,
  isMinor,
  PRECIP_LABELS,
  PRECIP_TYPES,
  type ReportFormState,
  resolveSkateWindow,
  SKATE_QUALITIES,
  SKATE_QUALITY_LABELS,
  SKY_CONDITIONS,
  SKY_LABELS,
  SURFACE_TAGS,
  THICKNESS_METHOD_LABELS,
  THICKNESS_METHODS,
  type ThicknessFormReading,
  toggleBundleOptOut,
  validateReportInput,
} from '@skating/core'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { datetimeLocalToMs, toDatetimeLocal } from '../lib/reportForm'
import { HazardBundlePrompt } from './HazardBundlePrompt'
import { useMapSelection } from './MapSelectionContext'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'
import { Textarea } from './ui/textarea'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { type PhotoDraftView, usePhotoDrafts } from './usePhotoDrafts'

// --- Small enum pickers on the shadcn (Base UI) ToggleGroup ---

function MultiToggle<T extends string>({
  values,
  options,
  label,
  onChange,
}: {
  values: T[]
  options: readonly T[]
  label: (v: T) => string
  onChange: (next: T[]) => void
}) {
  return (
    <ToggleGroup
      value={values}
      onValueChange={(v) => onChange(v as T[])}
      className="flex-wrap justify-start"
      variant="outline"
      size="sm"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {label(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function SingleToggle<T extends string>({
  value,
  options,
  label,
  onChange,
  allowEmpty = true,
}: {
  value: T | ''
  options: readonly T[]
  label: (v: T) => string
  onChange: (next: T | '') => void
  allowEmpty?: boolean
}) {
  return (
    <ToggleGroup
      value={value ? [value] : []}
      onValueChange={(v) => {
        const next = (v[v.length - 1] as T) ?? ''
        if (next === '' && !allowEmpty) return // required single-selects never clear
        onChange(next)
      }}
      className="flex-wrap justify-start"
      variant="outline"
      size="sm"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {label(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium text-foreground text-sm">{label}</span>
      {children}
    </div>
  )
}

type StartMode = 'none' | 'start' | 'duration'

/**
 * Optional "when did you get on the ice?" input (Phase 5). The skater enters *either* a start time
 * *or* a duration; `resolveSkateWindow` back-computes the start from a duration at this input
 * boundary, and only the resolved `skateStartTime` (epoch ms) is ever lifted to the form — duration
 * is never stored. Re-derives when the end time or the entry changes; surfaces an inline error for an
 * inverted/invalid window without corrupting the form (it lifts `undefined` while the entry is bad).
 */
function StartWindowField({
  end,
  skateStartTime,
  onResolve,
}: {
  end: number
  skateStartTime?: number
  onResolve: (skateStartTime: number | undefined) => void
}) {
  const [mode, setMode] = useState<StartMode>('none')
  const [startValue, setStartValue] = useState('')
  const [durationValue, setDurationValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Keep the latest onResolve in a ref so the derive effect doesn't depend on its (unstable) identity.
  const onResolveRef = useRef(onResolve)
  onResolveRef.current = onResolve

  // Derive whenever the end, mode, or entry changes — a duration window shifts with the end.
  useEffect(() => {
    if (mode === 'none') {
      setError(null)
      onResolveRef.current(undefined)
      return
    }
    const input =
      mode === 'start'
        ? { end, start: datetimeLocalToMs(startValue) }
        : { end, durationMinutes: Number(durationValue) }
    // An empty entry is "not set yet", not an error — clear the start until they type.
    if ((mode === 'start' && startValue === '') || (mode === 'duration' && durationValue === '')) {
      setError(null)
      onResolveRef.current(undefined)
      return
    }
    const result = resolveSkateWindow(input)
    if (result.ok) {
      setError(null)
      onResolveRef.current(result.skateStartTime)
    } else {
      setError(result.error)
      onResolveRef.current(undefined)
    }
  }, [end, mode, startValue, durationValue])

  const duration =
    skateStartTime !== undefined ? Math.round((end - skateStartTime) / 60_000) : undefined

  return (
    <details className="rounded-md border border-border p-2">
      <summary className="cursor-pointer text-foreground text-sm">
        When did you get on? (optional)
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <SingleToggle
          value={mode === 'none' ? '' : mode}
          options={['start', 'duration'] as const}
          label={(m) => (m === 'start' ? 'Start time' : 'Duration')}
          onChange={(m) => setMode(m === '' ? 'none' : m)}
        />
        {mode === 'start' ? (
          <Field label="Start time">
            <Input
              type="datetime-local"
              value={startValue}
              onChange={(e) => setStartValue(e.target.value)}
            />
          </Field>
        ) : null}
        {mode === 'duration' ? (
          <Field label="How long did you skate? (minutes)">
            <Input
              type="number"
              min="1"
              inputMode="numeric"
              placeholder="e.g. 90"
              value={durationValue}
              onChange={(e) => setDurationValue(e.target.value)}
            />
          </Field>
        ) : null}
        {error ? <p className="text-danger text-sm">{error}</p> : null}
        {!error && duration !== undefined && duration > 0 ? (
          <p className="text-foreground-muted text-sm">Skated about {duration} min.</p>
        ) : null}
      </div>
    </details>
  )
}

// --- Presentational form body (no Convex / map / router deps → testable in isolation) ---

export interface ReportFormFieldsProps {
  form: ReportFormState
  onFormChange: (form: ReportFormState) => void
  putInPin: { lat: number; lng: number } | null
  onRequestPin: () => void
  onClearPin: () => void
  photos: PhotoDraftView[]
  onAddFiles: (files: FileList) => void
  onRemovePhoto: (id: string) => void
  onTogglePlaceOnMap: (id: string, on: boolean) => void
  onSubmit: () => void
  onCancel: () => void
  submitting: boolean
  error: string | null
  /**
   * The D55 bundle offer, injected by the container so this stays a pure presentational component
   * (the prompt needs a Convex query; these fields must not).
   */
  bundlePrompt?: ReactNode
}

export function ReportFormFields({
  form,
  onFormChange,
  bundlePrompt,
  putInPin,
  onRequestPin,
  onClearPin,
  photos,
  onAddFiles,
  onRemovePhoto,
  onTogglePlaceOnMap,
  onSubmit,
  onCancel,
  submitting,
  error,
}: ReportFormFieldsProps) {
  const patch = (partial: Partial<ReportFormState>) => onFormChange({ ...form, ...partial })

  const updateReading = (index: number, partial: Partial<ThicknessFormReading>) =>
    patch({
      thickness: form.thickness.map((r, i) => (i === index ? { ...r, ...partial } : r)),
    })
  const removeReading = (index: number) =>
    patch({ thickness: form.thickness.filter((_, i) => i !== index) })
  const addReading = () => patch({ thickness: [...form.thickness, emptyThicknessReading()] })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSubmit()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="When did you get off the ice?">
        <Input
          type="datetime-local"
          value={toDatetimeLocal(form.skateEndTime)}
          onChange={(e) => patch({ skateEndTime: datetimeLocalToMs(e.target.value) })}
        />
      </Field>

      <StartWindowField
        end={form.skateEndTime}
        skateStartTime={form.skateStartTime}
        onResolve={(skateStartTime) => patch({ skateStartTime })}
      />

      <Field label="Ice types">
        <MultiToggle
          values={form.iceTypes}
          options={ICE_TYPES}
          label={humanizeEnum}
          onChange={(iceTypes) => patch({ iceTypes })}
        />
      </Field>

      <Field label="Surface">
        <MultiToggle
          values={form.surfaceTags}
          options={SURFACE_TAGS}
          label={humanizeEnum}
          onChange={(surfaceTags) => patch({ surfaceTags })}
        />
      </Field>

      <Field label="Overall quality">
        <SingleToggle
          value={form.skateQuality}
          options={SKATE_QUALITIES}
          label={(q) => SKATE_QUALITY_LABELS[q]}
          onChange={(skateQuality) => patch({ skateQuality })}
        />
      </Field>

      <Field label="Ice thickness">
        <div className="flex flex-col gap-3">
          {form.thickness.map((reading, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: readings are an ordered, editable list.
            <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <SingleToggle
                  value={reading.mode}
                  options={['single', 'range'] as const}
                  label={(m) => (m === 'single' ? 'Single' : 'Range')}
                  onChange={(mode) => mode !== '' && updateReading(index, { mode })}
                  allowEmpty={false}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => removeReading(index)}
                >
                  Remove
                </Button>
              </div>
              {reading.mode === 'single' ? (
                <Input
                  type="number"
                  step="0.1"
                  inputMode="decimal"
                  aria-label="Thickness (inches)"
                  placeholder="inches"
                  value={reading.value}
                  onChange={(e) => updateReading(index, { value: e.target.value })}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.1"
                    aria-label="Minimum thickness (inches)"
                    placeholder="min in"
                    value={reading.min}
                    onChange={(e) => updateReading(index, { min: e.target.value })}
                  />
                  <span className="text-foreground-muted">–</span>
                  <Input
                    type="number"
                    step="0.1"
                    aria-label="Maximum thickness (inches)"
                    placeholder="max in"
                    value={reading.max}
                    onChange={(e) => updateReading(index, { max: e.target.value })}
                  />
                </div>
              )}
              <SingleToggle
                value={reading.method}
                options={THICKNESS_METHODS}
                label={(m) => THICKNESS_METHOD_LABELS[m]}
                onChange={(method) => method !== '' && updateReading(index, { method })}
                allowEmpty={false}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={addReading}
          >
            Add a thickness reading
          </Button>
        </div>
      </Field>

      <Field label="Snow cover (inches)">
        <Input
          type="number"
          step="0.1"
          inputMode="decimal"
          value={form.snowCover}
          onChange={(e) => patch({ snowCover: e.target.value })}
        />
      </Field>

      <details className="rounded-md border border-border p-2">
        <summary className="cursor-pointer text-foreground text-sm">Conditions (optional)</summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Field label="Air °F">
              <Input
                type="number"
                value={form.conditions.airTempF}
                onChange={(e) =>
                  patch({ conditions: { ...form.conditions, airTempF: e.target.value } })
                }
              />
            </Field>
            <Field label="Wind mph">
              <Input
                type="number"
                value={form.conditions.windMph}
                onChange={(e) =>
                  patch({ conditions: { ...form.conditions, windMph: e.target.value } })
                }
              />
            </Field>
            <Field label="Wind dir">
              <Input
                placeholder="NW"
                value={form.conditions.windDir}
                onChange={(e) =>
                  patch({ conditions: { ...form.conditions, windDir: e.target.value } })
                }
              />
            </Field>
          </div>
          <Field label="Sky">
            <SingleToggle
              value={form.conditions.sky}
              options={SKY_CONDITIONS}
              label={(s) => SKY_LABELS[s]}
              onChange={(sky) => patch({ conditions: { ...form.conditions, sky } })}
            />
          </Field>
          <Field label="Precipitation">
            <SingleToggle
              value={form.conditions.precip}
              options={PRECIP_TYPES}
              label={(p) => PRECIP_LABELS[p]}
              onChange={(precip) => patch({ conditions: { ...form.conditions, precip } })}
            />
          </Field>
        </div>
      </details>

      <Field label="Photos">
        <div className="flex flex-col gap-2">
          <Input
            type="file"
            accept="image/*,.heic,.heif"
            multiple
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
                <div className="flex flex-1 flex-col gap-1">
                  {photo.coord ? (
                    <label
                      htmlFor={`place-${photo.id}`}
                      className="flex items-center gap-2 text-foreground-muted text-sm"
                    >
                      <Checkbox
                        id={`place-${photo.id}`}
                        checked={photo.placeOnMap}
                        onCheckedChange={(checked) =>
                          onTogglePlaceOnMap(photo.id, checked === true)
                        }
                      />
                      Place this photo's location on the map
                    </label>
                  ) : (
                    <span className="text-foreground-muted text-xs">
                      No location in this photo.
                    </span>
                  )}
                </div>
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
      </Field>

      <Field label="Access point (put-in)">
        {putInPin ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-foreground">
              Pin set at {putInPin.lat.toFixed(4)}, {putInPin.lng.toFixed(4)}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={onClearPin}>
              Clear pin
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={onRequestPin}
          >
            Set access point on the map
          </Button>
        )}
      </Field>

      <Field label="Notes">
        <Textarea
          value={form.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          placeholder="Anything else — access, hazards you saw, how it skated…"
        />
      </Field>

      {bundlePrompt}

      {error ? <p className="text-danger text-sm">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Posting…' : 'Post report'}
        </Button>
      </div>
    </form>
  )
}

// --- Container: wires the profile-derived visibility, photo pipeline, and map put-in pin ---

export function ReportForm({
  waterBodyId,
  bodyName,
  open,
  onOpenChange,
}: {
  waterBodyId: Id<'waterBodies'>
  bodyName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const profile = useQuery(api.profiles.current, {})
  const createReport = useMutation(api.reports.create)
  const { putInPin, setPutInPin, setPinDropMode, pinDropMode } = useMapSelection()

  const [form, setForm] = useState<ReportFormState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Report photos + hazard photos are the same pipeline, so they share one hook — it owns the
  // checkpointed upload and the reclaim-on-abandon sweep (see `usePhotoDrafts`).
  const photoDrafts = usePhotoDrafts()
  // D55: the author's own on-ice hazards for this lake, pre-checked to bundle into this report.
  // Held as an explicit opt-out set rather than an opt-in one — the offer is pre-checked, but the
  // skater can always drop any of them, and nothing attaches without the list being visible.
  const [unbundledHazardIds, setUnbundledHazardIds] = useState<string[]>([])
  const [bundleCandidateIds, setBundleCandidateIds] = useState<string[]>([])
  const bundleHazardIds = bundledHazardIds(bundleCandidateIds, unbundledHazardIds)

  // Minors are read-only — all reports are public (D13), so under-18 users can't post (D41).
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false

  // Initialize the form once the profile is known (and the author is allowed to post).
  useEffect(() => {
    if (profile !== undefined && !minor && form === null) {
      setForm(emptyReportForm(Date.now()))
    }
  }, [profile, form, minor])

  // Clear the map put-in-pin state when the form goes away — including an unmount from navigating
  // away mid-pin-drop, which would otherwise strand the map in crosshair/banner mode.
  useEffect(() => {
    return () => {
      setPutInPin(null)
      setPinDropMode(false)
    }
  }, [setPutInPin, setPinDropMode])

  const closeForm = useCallback(() => {
    setPutInPin(null)
    setPinDropMode(false)
    onOpenChange(false)
  }, [onOpenChange, setPutInPin, setPinDropMode])

  async function handleSubmit() {
    if (!form) return
    setError(null)
    const input = buildReportInput(form, waterBodyId, putInPin ?? undefined)
    const result = validateReportInput(input, { now: Date.now() })
    if (!result.ok) {
      setError(result.errors.map((e) => `${e.field}: ${e.message}`).join('; '))
      return
    }

    setSubmitting(true)
    try {
      // A photo that already uploaded on a prior (failed) submit keeps its id, so a retry
      // doesn't orphan duplicates.
      const photoIds = await photoDrafts.uploadAll()
      // Flip the guard BEFORE createReport, not after: an unmount *during* the mutation would
      // otherwise sweep (submittedRef still false) and delete the very photo rows the committing
      // report is about to reference — leaving it with permanently missing images.
      photoDrafts.setCommitted(true)
      const reportId = await createReport({
        ...input,
        waterBodyId,
        photoIds,
        ...(bundleHazardIds.length > 0
          ? { attachHazardIds: bundleHazardIds as Id<'hazards'>[] }
          : {}),
      })
      setPutInPin(null)
      onOpenChange(false)
      navigate({ to: '/report/$id', params: { id: reportId } })
    } catch (err) {
      photoDrafts.setCommitted(false) // creation didn't complete — uploads are reclaimable again
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : err instanceof Error
            ? err.message
            : 'Could not post your report',
      )
      setSubmitting(false)
    }
  }

  return (
    // Hidden (but kept mounted) while the map is in pin-drop mode, so form state survives placing a
    // pin. The `!pinDropMode` guard keeps arming pin-drop (which drives `open` false) from being
    // misread as a user close.
    <Dialog
      open={open && !pinDropMode}
      onOpenChange={(next) => !next && !pinDropMode && closeForm()}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Report on {bodyName}</DialogTitle>
        </DialogHeader>
        {minor ? (
          // Under-18 accounts are read-only — all reports are public, so minors can't post (D41).
          <p className="text-sm text-muted-foreground">
            Reports are shared publicly with the community, so posting opens when you turn 18. You
            can keep reading reports in the meantime.
          </p>
        ) : form ? (
          <ReportFormFields
            form={form}
            onFormChange={setForm}
            putInPin={putInPin}
            onRequestPin={() => setPinDropMode(true)}
            onClearPin={() => setPutInPin(null)}
            photos={photoDrafts.photos}
            onAddFiles={photoDrafts.addFiles}
            onRemovePhoto={photoDrafts.removePhoto}
            onTogglePlaceOnMap={photoDrafts.setPlaceOnMap}
            onSubmit={handleSubmit}
            onCancel={closeForm}
            submitting={submitting}
            error={error ?? photoDrafts.error}
            bundlePrompt={
              <HazardBundlePrompt
                waterBodyId={waterBodyId}
                skateEndTime={form.skateEndTime}
                skateStartTime={form.skateStartTime ?? undefined}
                selectedIds={bundleHazardIds}
                onToggle={(hazardId, checked) =>
                  setUnbundledHazardIds((prev) => toggleBundleOptOut(prev, hazardId, checked))
                }
                onCandidates={setBundleCandidateIds}
              />
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
