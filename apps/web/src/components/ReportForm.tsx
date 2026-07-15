import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  buildReportInput,
  deriveDefaultVisibility,
  emptyReportForm,
  emptyThicknessReading,
  humanizeEnum,
  ICE_TYPES,
  maxVisibilityForProfile,
  PRECIP_LABELS,
  PRECIP_TYPES,
  photoUploadCoord,
  type ReportFormState,
  SKATE_QUALITIES,
  SKATE_QUALITY_LABELS,
  SKY_CONDITIONS,
  SKY_LABELS,
  SURFACE_TAGS,
  THICKNESS_METHOD_LABELS,
  THICKNESS_METHODS,
  type ThicknessFormReading,
  VISIBILITY_LABELS,
  type Visibility,
  validateReportInput,
  visibilityOptions,
} from '@skating/core'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { datetimeLocalToMs, toDatetimeLocal } from '../lib/reportForm'
import { useMapSelection } from './MapSelectionContext'
import { processPhoto, uploadToStorage } from './photoPipeline'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'
import { Textarea } from './ui/textarea'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** A processed photo awaiting upload — blobs + EXIF coord + the per-photo `placeOnMap` opt-in (D42). */
interface PhotoDraft {
  id: string
  previewUrl: string
  full: File
  thumb: File
  coord?: { lat: number; lng: number }
  placeOnMap: boolean
  /**
   * Storage IDs recorded as each blob lands, so a submit retry after a partial-upload failure
   * reuses the already-uploaded object instead of orphaning it and uploading a fresh copy.
   */
  fullStorageId?: Id<'_storage'>
  thumbStorageId?: Id<'_storage'>
  /** Set once the photo row exists, so a retry doesn't re-create it (and re-attach it twice). */
  uploadedId?: Id<'photos'>
}

/** The subset of a photo draft `ReportFormFields` renders (no blobs). */
export interface PhotoDraftView {
  id: string
  previewUrl: string
  coord?: { lat: number; lng: number }
  placeOnMap: boolean
}

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

// --- Presentational form body (no Convex / map / router deps → testable in isolation) ---

export interface ReportFormFieldsProps {
  form: ReportFormState
  onFormChange: (form: ReportFormState) => void
  maxVisibility: Visibility
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
}

export function ReportFormFields({
  form,
  onFormChange,
  maxVisibility,
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
      <Field label="When did you skate?">
        <Input
          type="datetime-local"
          value={toDatetimeLocal(form.skateTime)}
          onChange={(e) => patch({ skateTime: datetimeLocalToMs(e.target.value) })}
        />
      </Field>

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

      <Field label="Visibility">
        <SingleToggle
          value={form.visibility}
          options={visibilityOptions(maxVisibility)}
          label={(v) => VISIBILITY_LABELS[v]}
          onChange={(visibility) => visibility !== '' && patch({ visibility })}
          allowEmpty={false}
        />
      </Field>

      <Field label="Notes">
        <Textarea
          value={form.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          placeholder="Anything else — access, hazards you saw, how it skated…"
        />
      </Field>

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
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl)
  const createPhoto = useMutation(api.photos.create)
  const deletePhoto = useMutation(api.photos.remove)
  const createReport = useMutation(api.reports.create)
  const { putInPin, setPutInPin, setPinDropMode, pinDropMode } = useMapSelection()

  const [form, setForm] = useState<ReportFormState | null>(null)
  const [photos, setPhotos] = useState<PhotoDraft[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const profilePublic = profile ? !profile.requireFollowApproval : true
  const maxVisibility = maxVisibilityForProfile({ profilePublic })

  // Initialize the form once the profile (and thus the default visibility, D41) is known.
  useEffect(() => {
    if (profile !== undefined && form === null) {
      setForm(emptyReportForm(Date.now(), deriveDefaultVisibility({ profilePublic })))
    }
  }, [profile, form, profilePublic])

  // Revoke every preview object URL on unmount — via a ref so we don't revoke still-displayed
  // previews on each add/remove (a `[photos]` dep would run cleanup on every list change).
  // Individual removals revoke their own URL in `removePhoto`. Also reclaim any photos that were
  // uploaded for a report that never got created — a failed `reports.create` or an abandoned form
  // would otherwise strand a storage blob + photo row (`submittedRef` skips a successful submit,
  // whose photos are now attached to the report). `useMutation` is a stable ref, so `[deletePhoto]`
  // never re-runs this — it stays an unmount-only cleanup.
  const photosRef = useRef<PhotoDraft[]>([])
  photosRef.current = photos
  const submittedRef = useRef(false)
  useEffect(() => {
    return () => {
      for (const p of photosRef.current) {
        URL.revokeObjectURL(p.previewUrl)
        if (!submittedRef.current && p.uploadedId) {
          void deletePhoto({ photoId: p.uploadedId }).catch(() => {})
        }
      }
    }
  }, [deletePhoto])

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

  const removePhoto = useCallback(
    (id: string) => {
      setPhotos((prev) => {
        const removed = prev.find((p) => p.id === id)
        if (removed) {
          URL.revokeObjectURL(removed.previewUrl)
          // If it had already been uploaded (on a prior failed submit), reclaim its blob + row now —
          // dropping it from state alone would strand it (it's no longer in the unmount sweep).
          if (removed.uploadedId) void deletePhoto({ photoId: removed.uploadedId }).catch(() => {})
        }
        return prev.filter((p) => p.id !== id)
      })
    },
    [deletePhoto],
  )

  const onAddFiles = useCallback(async (files: FileList) => {
    setError(null)
    try {
      // Process the picked files concurrently (each is a heavy HEIC-decode + two compressions).
      const drafts = await Promise.all(
        Array.from(files).map(async (file) => {
          const processed = await processPhoto(file)
          return {
            id: crypto.randomUUID(),
            previewUrl: URL.createObjectURL(processed.thumb),
            full: processed.full,
            thumb: processed.thumb,
            coord: processed.coord,
            placeOnMap: false,
          } satisfies PhotoDraft
        }),
      )
      setPhotos((prev) => [...prev, ...drafts])
    } catch {
      setError("Couldn't process one of those photos — try a different image.")
    }
  }, [])

  async function handleSubmit() {
    if (!form) return
    setError(null)
    const input = buildReportInput(form, waterBodyId, putInPin ?? undefined)
    const result = validateReportInput(input, { now: Date.now(), maxVisibility })
    if (!result.ok) {
      setError(result.errors.map((e) => `${e.field}: ${e.message}`).join('; '))
      return
    }

    setSubmitting(true)
    try {
      // Upload photos concurrently; within each, the full + thumb go up in parallel. A photo that
      // already uploaded on a prior (failed) submit keeps its id, so a retry doesn't orphan dupes.
      const photoIds = await Promise.all(
        photos.map(async (photo) => {
          if (photo.uploadedId) return photo.uploadedId
          // Reuse any blob a prior (failed) attempt already uploaded; only upload what's missing.
          const [storageId, thumbStorageId] = await Promise.all([
            photo.fullStorageId ??
              generateUploadUrl().then((url) => uploadToStorage(url, photo.full)),
            photo.thumbStorageId ??
              generateUploadUrl().then((url) => uploadToStorage(url, photo.thumb)),
          ])
          // Record the storage IDs before creating the row, so a createPhoto failure doesn't strand
          // the objects behind a retry that would re-upload them.
          setPhotos((prev) =>
            prev.map((p) =>
              p.id === photo.id
                ? {
                    ...p,
                    fullStorageId: storageId as Id<'_storage'>,
                    thumbStorageId: thumbStorageId as Id<'_storage'>,
                  }
                : p,
            ),
          )
          const id = await createPhoto({
            storageId: storageId as Id<'_storage'>,
            thumbStorageId: thumbStorageId as Id<'_storage'>,
            placeOnMap: photo.placeOnMap,
            coord: photoUploadCoord(photo.placeOnMap, photo.coord),
          })
          setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, uploadedId: id } : p)))
          return id
        }),
      )
      const reportId = await createReport({ ...input, waterBodyId, photoIds })
      submittedRef.current = true // photos are attached now — keep the unmount sweep off them
      setPutInPin(null)
      onOpenChange(false)
      navigate({ to: '/report/$id', params: { id: reportId } })
    } catch (err) {
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
        {form ? (
          <ReportFormFields
            form={form}
            onFormChange={setForm}
            maxVisibility={maxVisibility}
            putInPin={putInPin}
            onRequestPin={() => setPinDropMode(true)}
            onClearPin={() => setPutInPin(null)}
            photos={photos}
            onAddFiles={onAddFiles}
            onRemovePhoto={removePhoto}
            onTogglePlaceOnMap={(id, on) =>
              setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, placeOnMap: on } : p)))
            }
            onSubmit={handleSubmit}
            onCancel={closeForm}
            submitting={submitting}
            error={error}
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
