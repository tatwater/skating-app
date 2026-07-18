import DateTimePicker from '@react-native-community/datetimepicker'
import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  buildReportInput,
  createDraft,
  type DraftPhoto,
  emptyReportForm,
  emptyThicknessReading,
  formatSkateTime,
  humanizeEnum,
  ICE_TYPES,
  isMinor,
  PRECIP_LABELS,
  PRECIP_TYPES,
  photoUploadCoord,
  type ReportDraft,
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
  validateReportInput,
} from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { randomUUID } from 'expo-crypto'
import * as Location from 'expo-location'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { Button, Input, Spinner, Text, TextArea, XStack, YStack } from 'tamagui'
import { deleteDraftPhotoFiles, isPersistedUri, persistDraftPhoto } from '../lib/draftPhotos'
import { saveDraft } from '../lib/draftStore'
import { isDraftFlushing } from '../lib/flushService'
import { useMapSelectionOptional } from './MapSelectionContext'
import { pickPhotos, processPhoto, uploadToStorage } from './photoPipeline'

/** A processed photo awaiting upload — file URIs + EXIF coord + the per-photo `placeOnMap` opt-in. */
interface PhotoDraft {
  id: string
  fullUri: string
  thumbUri: string
  coord?: { lat: number; lng: number }
  placeOnMap: boolean
  /**
   * Storage IDs recorded as each object lands, so a submit retry after a partial-upload failure
   * reuses the already-uploaded object instead of orphaning it and uploading a fresh copy.
   */
  fullStorageId?: Id<'_storage'>
  thumbStorageId?: Id<'_storage'>
  /** Set once the photo row exists, so a retry doesn't re-create it (and re-attach it twice). */
  uploadedId?: Id<'photos'>
}

// --- Selectable pill toggles (the native analog of web's ToggleGroup) ---

function ChipToggle({
  selected,
  label,
  onPress,
}: {
  selected: boolean
  label: string
  onPress: () => void
}) {
  return (
    <XStack
      borderWidth={1}
      borderColor={selected ? '$primary' : '$border'}
      backgroundColor={selected ? '$primary' : 'transparent'}
      borderRadius="$4"
      paddingHorizontal="$3"
      paddingVertical="$1.5"
      pressStyle={{ opacity: 0.7 }}
      onPress={onPress}
    >
      <Text color={selected ? '$primaryForeground' : '$foreground'} fontSize={13}>
        {label}
      </Text>
    </XStack>
  )
}

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
    <XStack gap="$2" flexWrap="wrap">
      {options.map((option) => {
        const selected = values.includes(option)
        return (
          <ChipToggle
            key={option}
            selected={selected}
            label={label(option)}
            onPress={() =>
              onChange(selected ? values.filter((v) => v !== option) : [...values, option])
            }
          />
        )
      })}
    </XStack>
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
    <XStack gap="$2" flexWrap="wrap">
      {options.map((option) => {
        const selected = value === option
        return (
          <ChipToggle
            key={option}
            selected={selected}
            label={label(option)}
            onPress={() => {
              if (selected && !allowEmpty) return // required single-selects never clear
              onChange(selected ? '' : option)
            }}
          />
        )
      })}
    </XStack>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <YStack gap="$1.5">
      <Text color="$foreground" fontWeight="600" fontSize={14}>
        {label}
      </Text>
      {children}
    </YStack>
  )
}

const numberInputProps = { keyboardType: 'decimal-pad', inputMode: 'decimal' } as const

/**
 * Skate-time picker (D9 — editable to the past for a report you're posting later). iOS shows the
 * inline datetime spinner; Android opens the date dialog, then the time dialog (its picker has no
 * combined datetime mode).
 */
function SkateTimeField({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const [mode, setMode] = useState<'date' | 'time' | null>(null)
  const open = () => setMode(Platform.OS === 'ios' ? 'date' : 'date')
  return (
    <Field label="When did you get off the ice?">
      <XStack gap="$2" alignItems="center">
        <Text color="$foreground" flex={1}>
          {formatSkateTime(value)}
        </Text>
        <Button size="$2" onPress={open}>
          Change
        </Button>
      </XStack>
      {mode ? (
        <DateTimePicker
          value={new Date(value)}
          mode={Platform.OS === 'ios' ? 'datetime' : mode}
          maximumDate={new Date(Date.now() + 60 * 60 * 1000)}
          onChange={(event, date) => {
            // Android fires once per stage; iOS fires continuously in datetime mode.
            if (event.type === 'dismissed' || !date) {
              setMode(null)
              return
            }
            onChange(date.getTime())
            if (Platform.OS === 'ios') return // stays open until the user taps away
            setMode(mode === 'date' ? 'time' : null)
          }}
        />
      ) : null}
    </Field>
  )
}

type StartMode = 'none' | 'start' | 'duration'

/**
 * Optional "when did you get on the ice?" input (Phase 5), the mobile mirror of web's
 * `StartWindowField`. The skater enters a start time *or* a duration; `resolveSkateWindow`
 * back-computes the start from a duration at this input boundary, and only the resolved
 * `skateStartTime` (epoch ms) is lifted to the form — duration is never stored. Re-derives on any
 * change; surfaces an inline error for an inverted/invalid window without corrupting the form.
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
  const [startMs, setStartMs] = useState<number | null>(null)
  const [durationStr, setDurationStr] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState<'date' | 'time' | null>(null)

  const onResolveRef = useRef(onResolve)
  onResolveRef.current = onResolve

  useEffect(() => {
    if (mode === 'none') {
      setError(null)
      onResolveRef.current(undefined)
      return
    }
    if ((mode === 'start' && startMs === null) || (mode === 'duration' && durationStr === '')) {
      setError(null)
      onResolveRef.current(undefined)
      return
    }
    const input =
      mode === 'start'
        ? { end, start: startMs ?? undefined }
        : { end, durationMinutes: Number(durationStr) }
    const result = resolveSkateWindow(input)
    if (result.ok) {
      setError(null)
      onResolveRef.current(result.skateStartTime)
    } else {
      setError(result.error)
      onResolveRef.current(undefined)
    }
  }, [end, mode, startMs, durationStr])

  const duration =
    skateStartTime !== undefined ? Math.round((end - skateStartTime) / 60_000) : undefined

  return (
    <Field label="When did you get on? (optional)">
      <SingleToggle
        value={mode === 'none' ? '' : mode}
        options={['start', 'duration'] as const}
        label={(m) => (m === 'start' ? 'Start time' : 'Duration')}
        onChange={(m) => setMode(m === '' ? 'none' : m)}
      />
      {mode === 'start' ? (
        <XStack gap="$2" alignItems="center">
          <Text color="$foreground" flex={1}>
            {startMs !== null ? formatSkateTime(startMs) : 'Not set'}
          </Text>
          <Button size="$2" onPress={() => setPickerOpen('date')}>
            {startMs !== null ? 'Change' : 'Set start'}
          </Button>
          {pickerOpen ? (
            <DateTimePicker
              value={new Date(startMs ?? end)}
              mode={Platform.OS === 'ios' ? 'datetime' : pickerOpen}
              maximumDate={new Date(end)}
              onChange={(event, date) => {
                if (event.type === 'dismissed' || !date) {
                  setPickerOpen(null)
                  return
                }
                setStartMs(date.getTime())
                if (Platform.OS === 'ios') return
                setPickerOpen(pickerOpen === 'date' ? 'time' : null)
              }}
            />
          ) : null}
        </XStack>
      ) : null}
      {mode === 'duration' ? (
        <Input
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="minutes, e.g. 90"
          value={durationStr}
          onChangeText={setDurationStr}
        />
      ) : null}
      {error ? <Text color="$danger">{error}</Text> : null}
      {!error && duration !== undefined && duration > 0 ? (
        <Text color="$foregroundMuted">Skated about {duration} min.</Text>
      ) : null}
    </Field>
  )
}

/**
 * Report create form (§F/§E, D22–D25/D41) — the mobile mirror of web's `ReportForm`, rendered in
 * place inside the water-body drawer (D47). Imperial input → metric storage (D25) via the shared
 * `@skating/core` `buildReportInput`, validated by `validateReportInput` before submit. All reports
 * are public (D13); minors are read-only (D41), so the form is replaced by a notice for them. The
 * native photo pipeline (`photoPipeline.ts`) strips EXIF and only sends a coord on the
 * `placeOnMap` opt-in. The put-in pin is placed by tapping the live map — the drawer peeks aside for
 * the tap while this form stays mounted (see the `(map)` layout).
 */
export function ReportForm({
  waterBodyId,
  bodyName,
  coord,
  draft,
  onClose,
  onSaved,
}: {
  /** Absent for a coord-only offline capture — the lake is resolved from `coord` at flush. */
  waterBodyId?: Id<'waterBodies'>
  bodyName?: string
  /** Device GPS at capture — carried on a coord-only draft so the flush can resolve the lake. */
  coord?: { lat: number; lng: number }
  /** An existing draft to hydrate + update (offline edit); absent = a fresh report/draft. */
  draft?: ReportDraft
  onClose: () => void
  /** Called after saving a draft (defaults to `onClose`). */
  onSaved?: () => void
}) {
  const router = useRouter()
  const profile = useQuery(api.profiles.current, {})
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl)
  const createPhoto = useMutation(api.photos.create)
  const deletePhoto = useMutation(api.photos.remove)
  const removeBlob = useMutation(api.photos.removeBlob)
  const createReport = useMutation(api.reports.create)
  // On the map (online, from a lake's detail drawer) the put-in is dropped by tapping the live map;
  // off the map (the offline capture/edit routes, outside the `(map)` layout) there's no map, so the
  // put-in falls back to local state + a "use my current location" button.
  const mapSelection = useMapSelectionOptional()
  const [localPutIn, setLocalPutIn] = useState<{ lat: number; lng: number } | null>(
    draft?.putInPin ?? null,
  )
  // Off-map, there's no pin-drop mode — but the no-op MUST be stable (a fresh `() => {}` each render
  // would change the clear-effect's deps every render, re-running its cleanup and wiping the pin).
  const noopPinDrop = useCallback(() => {}, [])
  const putInPin = mapSelection ? mapSelection.putInPin : localPutIn
  const setPutInPin = mapSelection ? mapSelection.setPutInPin : setLocalPutIn
  const setPinDropMode = mapSelection ? mapSelection.setPinDropMode : noopPinDrop
  const hasMap = mapSelection !== null

  // Hydrate from a draft when editing; else start empty once the profile loads (below).
  const [form, setForm] = useState<ReportFormState | null>(draft ? draft.form : null)
  const [photos, setPhotos] = useState<PhotoDraft[]>(
    draft
      ? draft.photos.map((p) => ({
          id: p.id,
          fullUri: p.fullUri,
          thumbUri: p.thumbUri,
          coord: p.coord,
          placeOnMap: p.placeOnMap,
          // Carry any flush checkpoints (a prior partial flush uploaded blobs / created the row) so a
          // re-save preserves them — otherwise the next flush re-uploads and duplicates the photo row
          // + orphans the original blobs. (`DraftPhoto.photoId` is `PhotoDraft.uploadedId`; core stores
          // ids as plain strings, so re-brand them as Convex `Id`s here.)
          fullStorageId: p.fullStorageId as Id<'_storage'> | undefined,
          thumbStorageId: p.thumbStorageId as Id<'_storage'> | undefined,
          uploadedId: p.photoId as Id<'photos'> | undefined,
        }))
      : [],
  )
  const [showConditions, setShowConditions] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Minors are read-only — all reports are public (D13), so under-18 users can't post (D41).
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false

  // Initialize a fresh form once the profile is known (a hydrated draft already set it above).
  useEffect(() => {
    if (profile !== undefined && !minor && form === null) {
      setForm(emptyReportForm(Date.now()))
    }
  }, [profile, form, minor])

  // Reclaim whatever a draft has already uploaded so nothing is stranded server-side: a created row
  // (deletes the row + both blobs) or, for a partial/interrupted upload, the bare blobs that never
  // got a row (each recorded the instant it landed — see `handleSubmit`). Best-effort; failures are
  // swallowed. Mirrors web's `ReportForm` cleanup (minus its object-URL revocation — native uses URIs).
  const reclaim = useCallback(
    (p: PhotoDraft) => {
      if (p.uploadedId) {
        void deletePhoto({ photoId: p.uploadedId }).catch(() => {})
        return
      }
      if (p.fullStorageId) void removeBlob({ storageId: p.fullStorageId }).catch(() => {})
      if (p.thumbStorageId) void removeBlob({ storageId: p.thumbStorageId }).catch(() => {})
    },
    [deletePhoto, removeBlob],
  )

  // Reclaim any photos uploaded for a report that never got created — a failed `reports.create` or an
  // abandoned form would otherwise strand blobs (+ a row). `submittedRef` skips a successful submit,
  // whose photos are now attached. Read via a ref so this stays an unmount-only sweep.
  const photosRef = useRef<PhotoDraft[]>([])
  photosRef.current = photos
  const submittedRef = useRef(false)
  // Flipped at teardown so an upload / row-create that resolves *after* the sweep (see `handleSubmit`)
  // reclaims itself — the sweep only sees what's already recorded, not what's still in flight.
  const disposedRef = useRef(false)
  useEffect(() => {
    return () => {
      disposedRef.current = true
      if (submittedRef.current) return
      for (const p of photosRef.current) reclaim(p)
    }
  }, [reclaim])

  // Clear the map put-in-pin state when the form goes away — including an unmount mid-pin-drop, which
  // would otherwise strand the map in peek mode.
  useEffect(() => {
    return () => {
      setPutInPin(null)
      setPinDropMode(false)
    }
  }, [setPutInPin, setPinDropMode])

  // Reclaim an already-uploaded photo's blobs (+ row) when the user removes it (a prior failed submit
  // may have uploaded it); dropping it from state alone would strand it — it's no longer swept.
  const removePhoto = useCallback(
    (id: string) => {
      setPhotos((prev) => {
        const removed = prev.find((p) => p.id === id)
        if (removed) {
          reclaim(removed)
          // If this photo was already persisted to disk for a saved draft, delete its files too —
          // otherwise removing it while editing a draft would orphan them (they're no longer in the
          // draft, so a later draft-delete cleanup wouldn't catch them either).
          const files = [removed.fullUri, removed.thumbUri].filter(isPersistedUri)
          if (files.length > 0) deleteDraftPhotoFiles(files)
        }
        return prev.filter((p) => p.id !== id)
      })
    },
    [reclaim],
  )

  const onAddPhotos = useCallback(async () => {
    setError(null)
    try {
      const assets = await pickPhotos()
      if (assets.length === 0) return
      const drafts = await Promise.all(
        assets.map(async (asset) => {
          const processed = await processPhoto(asset)
          return {
            id: randomUUID(),
            fullUri: processed.fullUri,
            thumbUri: processed.thumbUri,
            coord: processed.coord,
            placeOnMap: false,
          } satisfies PhotoDraft
        }),
      )
      setPhotos((prev) => [...prev, ...drafts])
    } catch {
      setError("Couldn't add those photos — check photo permission and try again.")
    }
  }, [])

  const patch = (partial: Partial<ReportFormState>) =>
    setForm((prev) => (prev ? { ...prev, ...partial } : prev))

  // Under-18 accounts are read-only — all reports are public, so minors can't post (D41).
  if (minor)
    return (
      <Text color="$foregroundMuted" fontSize={14}>
        Reports are shared publicly with the community, so posting opens when you turn 18. You can
        keep reading reports in the meantime.
      </Text>
    )
  if (form === null) return <Spinner color="$primary" />

  const updateReading = (index: number, partial: Partial<ThicknessFormReading>) =>
    patch({ thickness: form.thickness.map((r, i) => (i === index ? { ...r, ...partial } : r)) })
  const removeReading = (index: number) =>
    patch({ thickness: form.thickness.filter((_, i) => i !== index) })
  const addReading = () => patch({ thickness: [...form.thickness, emptyThicknessReading()] })

  async function handleSubmit() {
    // Online post requires a resolved lake — the button is disabled without one (a coord-only
    // capture can only be saved as a draft, whose lake resolves at flush).
    if (!form || waterBodyId === undefined) return
    setError(null)
    const input = buildReportInput(form, waterBodyId, putInPin ?? undefined)
    const result = validateReportInput(input, { now: Date.now() })
    if (!result.ok) {
      setError(result.errors.map((e) => `${e.field}: ${e.message}`).join('; '))
      return
    }

    setSubmitting(true)
    try {
      const photoIds = await Promise.all(
        photos.map(async (photo) => {
          if (photo.uploadedId) return photo.uploadedId
          // Upload the full + thumb independently, each recording its storage id the instant it lands
          // (not after both settle). So a partial failure keeps the object that DID upload — a retry
          // reuses it instead of orphaning a duplicate, and the cleanup sweep can reclaim it.
          const ensure = (
            existing: Id<'_storage'> | undefined,
            uri: string,
            key: 'fullStorageId' | 'thumbStorageId',
          ): Promise<Id<'_storage'>> =>
            existing !== undefined
              ? Promise.resolve(existing)
              : generateUploadUrl()
                  .then((url) => uploadToStorage(url, uri))
                  .then((sid) => {
                    const id = sid as Id<'_storage'>
                    // If the form was torn down while this was in flight (and we're not mid-successful-
                    // submit), no draft remains to record or sweep it — reclaim the blob here instead.
                    if (disposedRef.current && !submittedRef.current) {
                      void removeBlob({ storageId: id }).catch(() => {})
                    } else {
                      setPhotos((prev) =>
                        prev.map((p) => (p.id === photo.id ? { ...p, [key]: id } : p)),
                      )
                    }
                    return id
                  })
          const [storageId, thumbStorageId] = await Promise.all([
            ensure(photo.fullStorageId, photo.fullUri, 'fullStorageId'),
            ensure(photo.thumbStorageId, photo.thumbUri, 'thumbStorageId'),
          ])
          const id = await createPhoto({
            storageId,
            thumbStorageId,
            placeOnMap: photo.placeOnMap,
            coord: photoUploadCoord(photo.placeOnMap, photo.coord),
          })
          // Same teardown race one level up: the row was created after the form unmounted, so nothing
          // will attach it to a report — reclaim the row (+ its blobs) rather than strand it.
          if (disposedRef.current && !submittedRef.current) {
            void deletePhoto({ photoId: id }).catch(() => {})
          } else {
            setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, uploadedId: id } : p)))
          }
          return id
        }),
      )
      // Flip the guard BEFORE createReport, not after: an unmount *during* the mutation would
      // otherwise sweep (submittedRef still false) and delete the very photo rows the committing
      // report is about to reference — leaving it with permanently missing images.
      submittedRef.current = true
      const reportId = await createReport({ ...input, waterBodyId, photoIds })
      setPutInPin(null)
      setPinDropMode(false)
      onClose()
      router.navigate({ pathname: '/report/[id]', params: { id: reportId } })
    } catch (err) {
      submittedRef.current = false // creation didn't complete — these uploads are reclaimable again
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

  // Save the form + photos as an offline draft (F2): copy each captured photo out of the evictable
  // picker cache into the persistent drafts dir, then upsert the draft (it flushes on reconnect).
  // Editing an existing draft reuses its id + idempotencyKey so a later retry stays deduped.
  async function handleSaveDraft() {
    if (!form) return
    // Refuse to save over a draft that's mid-flush — the flush's checkpoint writes + delete would
    // clobber this edit and idempotency would re-serve the pre-edit report, losing the change
    // silently. Checked synchronously right before the sync `saveDraft` so a flush can't claim the
    // id in between (see `flushService` `flushingIds`).
    if (isDraftFlushing(draft?.id)) {
      setError('This draft is syncing right now — try saving again in a moment.')
      return
    }
    setError(null)
    setSavingDraft(true)
    try {
      const id = draft?.id ?? randomUUID()
      const idempotencyKey = draft?.idempotencyKey ?? randomUUID()
      const draftPhotos: DraftPhoto[] = await Promise.all(
        photos.map(async (p) => ({
          id: p.id,
          fullUri: isPersistedUri(p.fullUri)
            ? p.fullUri
            : await persistDraftPhoto(p.fullUri, `${id}-${p.id}-full.jpg`),
          thumbUri: isPersistedUri(p.thumbUri)
            ? p.thumbUri
            : await persistDraftPhoto(p.thumbUri, `${id}-${p.id}-thumb.jpg`),
          coord: p.coord,
          placeOnMap: p.placeOnMap,
          // Preserve flush checkpoints across an edit/re-save so the next flush resumes instead of
          // re-uploading (which would duplicate the photo row + orphan blobs).
          fullStorageId: p.fullStorageId,
          thumbStorageId: p.thumbStorageId,
          photoId: p.uploadedId,
        })),
      )
      // Re-check right before the synchronous write: a flush could have claimed this id during the
      // photo-persist await above. No `await` between here and `saveDraft`, so a flush can't slip in
      // between the check and the write.
      if (isDraftFlushing(draft?.id)) {
        setError('This draft is syncing right now — try saving again in a moment.')
        setSavingDraft(false)
        return
      }
      saveDraft(
        createDraft({
          id,
          idempotencyKey,
          now: Date.now(),
          form,
          waterBodyId,
          bodyName,
          coord,
          putInPin: putInPin ?? undefined,
          photos: draftPhotos,
        }),
      )
      // These photos now belong to the saved draft — skip the unmount reclaim sweep. (They carry no
      // server objects yet anyway; the flush uploads them.)
      submittedRef.current = true
      ;(onSaved ?? onClose)()
    } catch {
      setError("Couldn't save this draft. Please try again.")
      setSavingDraft(false)
    }
  }

  // Offline there's no live map to tap, so set the put-in to the device's current location (D42/S1).
  async function useCurrentLocationAsPutIn() {
    setError(null)
    try {
      const { status } = await Location.requestForegroundPermissionsAsync()
      if (status !== 'granted') {
        setError('Location permission is needed to set the access point.')
        return
      }
      const pos = await Location.getCurrentPositionAsync({})
      setPutInPin({ lat: pos.coords.latitude, lng: pos.coords.longitude })
    } catch {
      setError("Couldn't get your current location.")
    }
  }

  return (
    <YStack gap="$4">
      <Text color="$foreground" fontWeight="700" fontSize={16}>
        {bodyName ? `Report on ${bodyName}` : 'New report'}
      </Text>
      {waterBodyId === undefined ? (
        <Text color="$foregroundMuted" fontSize={12}>
          We'll match this to the closest lake when you're back online.
        </Text>
      ) : null}

      <SkateTimeField
        value={form.skateEndTime}
        onChange={(skateEndTime) => patch({ skateEndTime })}
      />

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
        <YStack gap="$3">
          {form.thickness.map((reading, index) => (
            <YStack
              // biome-ignore lint/suspicious/noArrayIndexKey: readings are an ordered, editable list.
              key={index}
              gap="$2"
              padding="$2"
              borderWidth={1}
              borderColor="$border"
              borderRadius="$4"
            >
              <XStack justifyContent="space-between" alignItems="center">
                <SingleToggle
                  value={reading.mode}
                  options={['single', 'range'] as const}
                  label={(m) => (m === 'single' ? 'Single' : 'Range')}
                  onChange={(mode) => mode !== '' && updateReading(index, { mode })}
                  allowEmpty={false}
                />
                <Button size="$2" chromeless onPress={() => removeReading(index)}>
                  Remove
                </Button>
              </XStack>
              {reading.mode === 'single' ? (
                <Input
                  {...numberInputProps}
                  placeholder="inches"
                  value={reading.value}
                  onChangeText={(value) => updateReading(index, { value })}
                />
              ) : (
                <XStack gap="$2" alignItems="center">
                  <Input
                    {...numberInputProps}
                    flex={1}
                    placeholder="min in"
                    value={reading.min}
                    onChangeText={(min) => updateReading(index, { min })}
                  />
                  <Text color="$foregroundMuted">–</Text>
                  <Input
                    {...numberInputProps}
                    flex={1}
                    placeholder="max in"
                    value={reading.max}
                    onChangeText={(max) => updateReading(index, { max })}
                  />
                </XStack>
              )}
              <SingleToggle
                value={reading.method}
                options={THICKNESS_METHODS}
                label={(m) => THICKNESS_METHOD_LABELS[m]}
                onChange={(method) => method !== '' && updateReading(index, { method })}
                allowEmpty={false}
              />
            </YStack>
          ))}
          <Button size="$2" alignSelf="flex-start" onPress={addReading}>
            Add a thickness reading
          </Button>
        </YStack>
      </Field>

      <Field label="Snow cover (inches)">
        <Input
          {...numberInputProps}
          placeholder="inches"
          value={form.snowCover}
          onChangeText={(snowCover) => patch({ snowCover })}
        />
      </Field>

      <Button
        size="$2"
        chromeless
        alignSelf="flex-start"
        onPress={() => setShowConditions((s) => !s)}
      >
        {showConditions ? 'Hide conditions' : 'Add conditions (optional)'}
      </Button>
      {showConditions ? (
        <YStack gap="$3">
          <XStack gap="$2">
            <Field label="Air °F">
              <Input
                {...numberInputProps}
                value={form.conditions.airTempF}
                onChangeText={(airTempF) => patch({ conditions: { ...form.conditions, airTempF } })}
              />
            </Field>
            <Field label="Wind mph">
              <Input
                {...numberInputProps}
                value={form.conditions.windMph}
                onChangeText={(windMph) => patch({ conditions: { ...form.conditions, windMph } })}
              />
            </Field>
            <Field label="Wind dir">
              <Input
                placeholder="NW"
                autoCapitalize="characters"
                value={form.conditions.windDir}
                onChangeText={(windDir) => patch({ conditions: { ...form.conditions, windDir } })}
              />
            </Field>
          </XStack>
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
        </YStack>
      ) : null}

      <Field label="Photos">
        <YStack gap="$2">
          <Button size="$2" alignSelf="flex-start" onPress={onAddPhotos}>
            Add photos
          </Button>
          {photos.map((photo) => (
            <XStack key={photo.id} gap="$2" alignItems="center">
              <Text color="$foregroundMuted" flex={1} fontSize={12}>
                {photo.coord ? 'Photo has a location' : 'No location in this photo'}
              </Text>
              {photo.coord ? (
                <ChipToggle
                  selected={photo.placeOnMap}
                  label="Place on map"
                  onPress={() =>
                    setPhotos((prev) =>
                      prev.map((p) =>
                        p.id === photo.id ? { ...p, placeOnMap: !p.placeOnMap } : p,
                      ),
                    )
                  }
                />
              ) : null}
              <Button size="$2" chromeless onPress={() => removePhoto(photo.id)}>
                Remove
              </Button>
            </XStack>
          ))}
        </YStack>
      </Field>

      <Field label="Access point (put-in)">
        {putInPin ? (
          <XStack gap="$2" alignItems="center">
            <Text color="$foreground" flex={1}>
              Pin set at {putInPin.lat.toFixed(4)}, {putInPin.lng.toFixed(4)}
            </Text>
            <Button size="$2" chromeless onPress={() => setPutInPin(null)}>
              Clear
            </Button>
          </XStack>
        ) : (
          <XStack gap="$2" flexWrap="wrap">
            {hasMap ? (
              <Button size="$2" onPress={() => setPinDropMode(true)}>
                Set on the map
              </Button>
            ) : null}
            <Button size="$2" onPress={useCurrentLocationAsPutIn}>
              Use my current location
            </Button>
          </XStack>
        )}
      </Field>

      <Field label="Notes">
        <TextArea
          value={form.notes}
          onChangeText={(notes) => patch({ notes })}
          placeholder="Anything else — access, hazards you saw, how it skated…"
        />
      </Field>

      {error ? <Text color="$danger">{error}</Text> : null}

      <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
        <Button chromeless onPress={onClose} disabled={submitting || savingDraft}>
          Cancel
        </Button>
        <Button onPress={handleSaveDraft} disabled={submitting || savingDraft}>
          {savingDraft ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          backgroundColor="$primary"
          color="$primaryForeground"
          onPress={handleSubmit}
          disabled={submitting || savingDraft || waterBodyId === undefined}
        >
          {submitting ? 'Posting…' : 'Post report'}
        </Button>
      </XStack>
    </YStack>
  )
}
