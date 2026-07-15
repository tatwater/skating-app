import DateTimePicker from '@react-native-community/datetimepicker'
import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  buildReportInput,
  deriveDefaultVisibility,
  emptyReportForm,
  emptyThicknessReading,
  formatSkateTime,
  humanizeEnum,
  ICE_TYPES,
  isMinor,
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
  validateReportInput,
  visibilityOptions,
} from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { Button, Input, Spinner, Text, TextArea, XStack, YStack } from 'tamagui'
import { useMapSelection } from './MapSelectionContext'
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

// Monotonic per-session counter for draft keys — unique even when the same library asset is picked
// twice (deriving the id from asset/file identifiers would collide and corrupt retry state).
let draftSeq = 0

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
    <Field label="When did you skate?">
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

/**
 * Report create form (§F/§E, D22–D25/D41) — the mobile mirror of web's `ReportForm`, rendered in
 * place inside the water-body drawer (D47). Imperial input → metric storage (D25) via the shared
 * `@skating/core` `buildReportInput`, validated by `validateReportInput` before submit; visibility
 * is derived from the profile and clamped to the D41 ceiling (a locked/minor author is never offered
 * `public`). The native photo pipeline (`photoPipeline.ts`) strips EXIF and only sends a coord on the
 * `placeOnMap` opt-in. The put-in pin is placed by tapping the live map — the drawer peeks aside for
 * the tap while this form stays mounted (see the `(map)` layout).
 */
export function ReportForm({
  waterBodyId,
  bodyName,
  onClose,
}: {
  waterBodyId: Id<'waterBodies'>
  bodyName: string
  onClose: () => void
}) {
  const router = useRouter()
  const profile = useQuery(api.profiles.current, {})
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl)
  const createPhoto = useMutation(api.photos.create)
  const deletePhoto = useMutation(api.photos.remove)
  const removeBlob = useMutation(api.photos.removeBlob)
  const createReport = useMutation(api.reports.create)
  const { putInPin, setPutInPin, setPinDropMode } = useMapSelection()

  const [form, setForm] = useState<ReportFormState | null>(null)
  const [photos, setPhotos] = useState<PhotoDraft[]>([])
  const [showConditions, setShowConditions] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Report default/ceiling derive from the author's age, not profile privacy (D13/D41).
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false
  const maxVisibility = maxVisibilityForProfile({ isMinor: minor })

  // Initialize the form once the profile (and thus the default visibility, D41) is known.
  useEffect(() => {
    if (profile !== undefined && form === null) {
      setForm(emptyReportForm(Date.now(), deriveDefaultVisibility({ isMinor: minor })))
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
        if (removed) reclaim(removed)
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
            id: `draft-${draftSeq++}`,
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

  if (form === null) return <Spinner color="$primary" />

  const updateReading = (index: number, partial: Partial<ThicknessFormReading>) =>
    patch({ thickness: form.thickness.map((r, i) => (i === index ? { ...r, ...partial } : r)) })
  const removeReading = (index: number) =>
    patch({ thickness: form.thickness.filter((_, i) => i !== index) })
  const addReading = () => patch({ thickness: [...form.thickness, emptyThicknessReading()] })

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

  return (
    <YStack gap="$4">
      <Text color="$foreground" fontWeight="700" fontSize={16}>
        Report on {bodyName}
      </Text>

      <SkateTimeField value={form.skateTime} onChange={(skateTime) => patch({ skateTime })} />

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
          <Button size="$2" alignSelf="flex-start" onPress={() => setPinDropMode(true)}>
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
        <TextArea
          value={form.notes}
          onChangeText={(notes) => patch({ notes })}
          placeholder="Anything else — access, hazards you saw, how it skated…"
        />
      </Field>

      {error ? <Text color="$danger">{error}</Text> : null}

      <XStack gap="$2" justifyContent="flex-end">
        <Button chromeless onPress={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          backgroundColor="$primary"
          color="$primaryForeground"
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? 'Posting…' : 'Post report'}
        </Button>
      </XStack>
    </YStack>
  )
}
