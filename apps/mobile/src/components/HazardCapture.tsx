import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  applyDraftMapClick,
  classifyFlushError,
  createQueuedHazard,
  type DraftPhoto,
  deriveShoreBand,
  draftPlacementCount,
  draftToShape,
  HAZARD_BUFFER_STEPS_M,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardType,
  isPassageMarker,
  offersShoreBand,
  pointDraftForType,
  resizeDraft,
  SHORE_BAND_DEFAULT_HALF_WIDTH_M,
  shoreBandRefusalText,
  stepSize,
  switchDraftKind,
  undoDraftPlacement,
} from '@skating/core';
import { useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { randomUUID } from 'expo-crypto';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { Image, Modal } from 'react-native';
import { Button, H4, Paragraph, ScrollView, Text, XStack, YStack } from 'tamagui';
import { cachedBodyPolygon } from '../lib/bodyCache';
import { deleteDraftPhotoFiles, persistDraftPhoto } from '../lib/draftPhotos';
import { saveHazardItem } from '../lib/draftStore';
import { useIsLeaving } from './LeavingNotice';
import { useMapSelection } from './MapSelectionContext';
import { pickPhotos, processPhoto, uploadToStorage } from './photoPipeline';

/**
 * On-ice hazard capture (Phase 9, D51 §Mobile) — the FAB, the type sheet, and the adjust bar.
 *
 * Designed against one governing constraint: **cold hands, gloves, bright sun, one hand, possibly
 * moving, no signal, phone in a pocket.** Two rules fall out and drive every decision here:
 *
 * 1. **No required typing anywhere in the flow.** There is no note field on this path at all.
 * 2. **The hazard is committable after two taps** — FAB, then the type. Picking the type drops the
 *    pin at the skater's GPS with that type's own default radius, and it is immediately valid and
 *    postable. Everything after that (resize, move, trace a line) is optional, because a
 *    mitten-fumble that hits Done early must still produce a useful pin.
 *
 * That second rule is why even a pressure ridge starts as a circle here (`pointDraftForType`) rather
 * than the polyline it starts as on web: one GPS fix is one vertex, and a one-vertex line isn't
 * storable. Tracing is an *upgrade* you opt into, not a precondition for being useful.
 *
 * The type sheet closes as soon as a type is picked, collapsing to a compact bar — you have to be
 * able to see the ice and the pin. Nothing here is a blocking modal once the pin exists, because the
 * skater may be moving.
 */

/** Steppers, not a slider. Sliders are miserable with gloves on. */
export function HazardCapture() {
  // A pending deletion closes hazard authoring (D62 amendment). Checked before anything else so the
  // button never appears — being handed a draw tool and refused at submit is the failure this avoids.
  const leaving = useIsLeaving();
  const createHazard = useMutation(api.hazards.create);
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl);
  const createPhoto = useMutation(api.photos.create);
  const deletePhoto = useMutation(api.photos.remove);
  const removeBlob = useMutation(api.photos.removeBlob);
  const {
    onIceWaterBodyId,
    highlightWaterBodyId,
    hazardDraft,
    setHazardDraft,
    hazardDraftType,
    setHazardDraftType,
    hazardDropMode,
    setHazardDropMode,
    hazardShoreTaps,
    setHazardShoreTaps,
  } = useMapSelection();

  const [picking, setPicking] = useState(false);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /**
   * The lake the pin belongs to, **captured the instant a type is chosen** rather than read live at
   * Done time. `targetBodyId` below is derived from map state that changes underfoot — navigating back
   * to `/` clears the highlight and `onIceWaterBodyId` can go null — so reading it at submit let Done
   * silently bail (no lake ⇒ `post()` returns, having looked like it did nothing). Freezing it here is
   * what makes "Done always means Done" true: the pin can't lose the lake it was dropped on.
   */
  const [capturedBodyId, setCapturedBodyId] = useState<string | null>(null);
  /**
   * Photos, held as offline draft photos from the moment they're picked.
   *
   * They're copied straight into persistent storage rather than staged in memory or left in the
   * picker cache, because on the ice the offline path is the *likely* one — and a hazard that queues
   * for hours must not have its images evicted by the OS before it sends. It also means one shape
   * feeds both paths: upload these uris now, or hand the same records to the queue.
   */
  /**
   * Snap-to-shoreline state (N5b), held here rather than on the draft: Decision 3 stores a snapped
   * band as an **ordinary polygon**, so the band half-width is an input to deriving that ring, not a
   * property of it. Putting it on the draft would give one shape two widths that could disagree.
   */
  const [shoreHalfWidth, setShoreHalfWidth] = useState(SHORE_BAND_DEFAULT_HALF_WIDTH_M);
  const [shoreOtherWay, setShoreOtherWay] = useState(false);
  const [shoreError, setShoreError] = useState<string | null>(null);
  const [shoreArcLength, setShoreArcLength] = useState<number | null>(null);
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  /**
   * The live photo list, mirrored into a ref so `post()`'s failure branches read the *checkpoints*
   * `uploadPhotos` recorded (storage ids / photo-row ids), not the stale closure. The permanent branch
   * needs them to reclaim what already uploaded; the transient branch hands them to the queue so the
   * flush *resumes* the upload instead of re-sending from disk and orphaning the first set.
   */
  const photosRef = useRef<DraftPhoto[]>([]);
  photosRef.current = photos;
  // Latest draft, for the async GPS handler below to read without a stale closure — the context's
  // `setHazardDraft` takes a value, not an updater, so we can't check "is it still unplaced?" inside it.
  const hazardDraftRef = useRef(hazardDraft);
  hazardDraftRef.current = hazardDraft;

  // Flag against the lake the skater is standing on; fall back to whichever lake they have open, so
  // the affordance still works when browsing from the couch.
  const targetBodyId = onIceWaterBodyId ?? highlightWaterBodyId;

  /** Clear the draft state without touching photo files — the queue path keeps the files it owns. */
  function resetDraftState() {
    setPhotos([]);
    setCapturedBodyId(null);
    setHazardShoreTaps(null);
    setShoreError(null);
    setShoreArcLength(null);
    setShoreOtherWay(false);
    setShoreHalfWidth(SHORE_BAND_DEFAULT_HALF_WIDTH_M);
    setHazardDraft(null);
    setHazardDraftType(null);
    setHazardDropMode(false);
    setPicking(false);
    setShowAllTypes(false);
    setLocating(false);
    setError(null);
  }

  /**
   * Full reset for an *abandoned* capture (Cancel, or the type sheet's `onRequestClose`): free the
   * persisted photo files too. Without this, photos picked then cancelled leak their full+thumb copies
   * into app storage forever — `removePhoto` frees a single removal, but bailing out skipped the rest.
   */
  function reset() {
    deleteDraftPhotoFiles(photosRef.current.flatMap((p) => [p.fullUri, p.thumbUri]));
    resetDraftState();
  }

  /**
   * Get a fix fast, or `null`. Prefers the last known fix — it returns *instantly* on a cold receiver,
   * and a pin you can nudge beats a spinner you can't dismiss — then falls back to a fresh fix under a
   * hard timeout so the bar never hangs on a receiver that won't lock (tree cover, a true cold start).
   */
  async function acquireCoord(): Promise<{ lat: number; lng: number } | null> {
    try {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
      if (last) return { lat: last.coords.latitude, lng: last.coords.longitude };
    } catch {
      // fall through to a fresh fix
    }
    try {
      const pos = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (pos) return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch {
      // no fix
    }
    return null;
  }

  /**
   * Two taps in hand ⇒ derive the band. Re-runs on width and direction, which is what makes both of
   * those live controls rather than a re-pick — on the ice, "start over" is the expensive option.
   *
   * The polygon comes from the **offline body cache**, not a query: the skater this is for is
   * standing on the lake, and on the lake there is frequently no signal. The cache holds every body
   * whose detail has been opened, which on arrival is the one under their feet.
   */
  useEffect(() => {
    if (!hazardDraftType || !hazardShoreTaps || hazardShoreTaps.length < 2 || !capturedBodyId) {
      return;
    }
    const polygon = cachedBodyPolygon(capturedBodyId);
    if (!polygon) {
      setShoreError('This lake’s outline isn’t on the phone yet. Trace it as a line instead.');
      return;
    }
    const [a, b] = hazardShoreTaps as [{ lat: number; lng: number }, { lat: number; lng: number }];
    const result = deriveShoreBand(polygon, a, b, {
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
      bufferMeters: HAZARD_DEFAULT_BUFFER_M[hazardDraftType],
    });
  }, [
    hazardDraftType,
    hazardShoreTaps,
    capturedBodyId,
    shoreHalfWidth,
    shoreOtherWay,
    setHazardDraft,
  ]);

  async function chooseType(type: HazardType) {
    // Freeze the lake now, while we still have it — see `capturedBodyId`.
    setCapturedBodyId(targetBodyId);
    setHazardDraftType(type);
    setPicking(false);
    setError(null);
    // A type change abandons a snap: the band was derived for the old type, and the new one may not
    // offer snapping at all. Keeping the ring would leave a ridge shaped exactly like a shoreline.
    setHazardShoreTaps(null);
    setShoreError(null);
    setShoreArcLength(null);
    // Show the pin's adjust bar *immediately*, armed for a map tap, so tap 2 is never a dead tap while
    // a cold GPS receiver spins up: the sheet has closed and without this the screen would show only
    // the reappeared FAB, reading as "nothing happened" — and a gloved re-tap restarts the whole flow.
    const draft = pointDraftForType(type);
    setHazardDraft(draft);
    setHazardDropMode(true);
    setLocating(true);
    try {
      const coord = await acquireCoord();
      if (coord) {
        // Only place if the draft is still the unplaced one we started — a fix that lands *after* the
        // skater already tapped the map themselves must not yank the pin off where they put it.
        const current = hazardDraftRef.current;
        if (current?.geometryKind === 'point_radius' && current.coord === null) {
          setHazardDraft(applyDraftMapClick(current, coord));
        }
        setHazardDropMode(false);
      } else {
        // Keep the (unplaced) draft in drop mode and ask for a tap instead of failing outright.
        setError('Couldn’t get your location — tap the map where the hazard is.');
      }
    } finally {
      setLocating(false);
    }
  }

  /**
   * Post it, or queue it if there's no signal.
   *
   * There is deliberately **no "save for later" button**: on the ice, "am I online?" is not a
   * question the skater should have to answer, and a hazard that didn't get filed because someone
   * picked the wrong button is a hazard the next skater doesn't see. So Done always means Done — a
   * transient failure falls through to the offline queue and flushes on reconnect, and only a real
   * server rejection (a minor trying to post, a removed lake) surfaces as an error worth reading.
   *
   * The key is minted here, at capture, and travels with the queued item: that's what makes a
   * lost-ack retry return the original pin instead of dropping a second one beside it.
   */
  async function addPhotos() {
    setAddingPhotos(true);
    setError(null);
    try {
      const assets = await pickPhotos();
      const added = await Promise.all(
        assets.map(async (asset) => {
          const processed = await processPhoto(asset);
          const id = randomUUID();
          // Copy the stripped output out of the evictable picker cache immediately.
          const [fullUri, thumbUri] = await Promise.all([
            persistDraftPhoto(processed.fullUri, `hazard-${id}-full.jpg`),
            persistDraftPhoto(processed.thumbUri, `hazard-${id}-thumb.jpg`),
          ]);
          // No `placeOnMap` opt-in here, unlike report photos: the hazard already *has* a location,
          // and a photo's EXIF coord contradicting the footprint the alert measures against would be
          // worse than useless. The coord is dropped rather than carried (D42).
          return { id, fullUri, thumbUri, placeOnMap: false } satisfies DraftPhoto;
        }),
      );
      setPhotos((prev) => [...prev, ...added]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t add that photo.');
    } finally {
      setAddingPhotos(false);
    }
  }

  function removePhoto(id: string) {
    setPhotos((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) deleteDraftPhotoFiles([gone.fullUri, gone.thumbUri]);
      return prev.filter((p) => p.id !== id);
    });
  }

  /**
   * Upload the persisted photos and return their ids, **checkpointing each step into `photos` state**
   * (storage id, then row id) exactly as the offline flush does. Throws like any other network call —
   * but the partial progress it recorded survives in `photosRef`, so the failure branches in `post()`
   * can either reclaim it (permanent) or hand it to the queue to resume (transient) instead of
   * re-uploading from disk and stranding the first set. Mirrors web's `usePhotoDrafts.uploadAll`.
   */
  async function uploadPhotos(): Promise<Id<'photos'>[]> {
    const checkpoint = (id: string, patch: Partial<DraftPhoto>) =>
      setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    const ids: Id<'photos'>[] = [];
    for (const photo of photosRef.current) {
      if (photo.photoId) {
        ids.push(photo.photoId as Id<'photos'>);
        continue;
      }
      let fullStorageId = photo.fullStorageId;
      if (fullStorageId === undefined) {
        fullStorageId = await generateUploadUrl().then((url) =>
          uploadToStorage(url, photo.fullUri),
        );
        checkpoint(photo.id, { fullStorageId });
      }
      let thumbStorageId = photo.thumbStorageId;
      if (thumbStorageId === undefined) {
        thumbStorageId = await generateUploadUrl().then((url) =>
          uploadToStorage(url, photo.thumbUri),
        );
        checkpoint(photo.id, { thumbStorageId });
      }
      const photoId = await createPhoto({
        storageId: fullStorageId as Id<'_storage'>,
        thumbStorageId: thumbStorageId as Id<'_storage'>,
        placeOnMap: false,
      });
      checkpoint(photo.id, { photoId });
      ids.push(photoId);
    }
    return ids;
  }

  /**
   * Reclaim whatever `uploadPhotos` managed to upload before a *permanent* failure, so nothing is
   * stranded server-side: a created row (row + both blobs) or, for a partial upload, the bare blobs
   * that never got a row. Checkpoints are then cleared so a subsequent retry re-uploads fresh rather
   * than re-attaching the rows we just deleted. Best-effort; mirrors `usePhotoDrafts.reclaim`.
   */
  function reclaimUploadedPhotos() {
    for (const p of photosRef.current) {
      if (p.photoId) {
        void deletePhoto({ photoId: p.photoId as Id<'photos'> }).catch(() => {});
      } else {
        if (p.fullStorageId)
          void removeBlob({ storageId: p.fullStorageId as Id<'_storage'> }).catch(() => {});
        if (p.thumbStorageId)
          void removeBlob({ storageId: p.thumbStorageId as Id<'_storage'> }).catch(() => {});
      }
    }
    setPhotos((prev) =>
      prev.map((p) => ({
        ...p,
        fullStorageId: undefined,
        thumbStorageId: undefined,
        photoId: undefined,
      })),
    );
  }

  async function post() {
    const shape = hazardDraft ? draftToShape(hazardDraft) : null;
    if (!hazardDraftType || !shape || !capturedBodyId) return;
    setSaving(true);
    setError(null);
    const idempotencyKey = randomUUID();
    try {
      const photoIds = await uploadPhotos();
      await createHazard({
        waterBodyId: capturedBodyId as Id<'waterBodies'>,
        idempotencyKey,
        ...(photoIds.length > 0 ? { photoIds } : {}),
        type: hazardDraftType,
        geometryKind: shape.geometryKind,
        geometry: shape.geometry,
        ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
        ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
      });
      // The upload succeeded, so the persisted copies are now dead weight. `reset()` frees them.
      reset();
      // A brief toast, never a blocking modal — the skater may be moving.
      setToast('Hazard posted. Thanks.');
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      if (classifyFlushError(e) === 'permanent') {
        // A real rejection (a minor posting, a removed lake) — retrying won't help, so reclaim the
        // photo rows/blobs this attempt uploaded rather than orphan them, and leave the draft up with
        // the reason so the skater can read it and Cancel (which frees the files).
        reclaimUploadedPhotos();
        setError(
          e instanceof ConvexError
            ? String(e.data)
            : e instanceof Error
              ? e.message
              : 'Couldn’t post that hazard.',
        );
        setSaving(false);
        return;
      }
      const now = Date.now();
      saveHazardItem(
        createQueuedHazard({
          id: randomUUID(),
          idempotencyKey,
          now,
          type: hazardDraftType,
          shape,
          waterBodyId: capturedBodyId,
          // Hand over the *checkpointed* photos: any blob/row already uploaded above carries its id, so
          // the flush resumes from there instead of re-uploading from disk and orphaning the first set.
          photos: photosRef.current,
        }),
      );
      // The queue owns the files now — reset draft state WITHOUT freeing them.
      resetDraftState();
      setToast('Saved — it’ll post when you’re back in signal.');
      setTimeout(() => setToast(null), 4000);
    } finally {
      setSaving(false);
    }
  }

  const isLine = hazardDraft?.geometryKind === 'line';
  const isArea = hazardDraft?.geometryKind === 'polygon';
  const snapping = hazardShoreTaps !== null;
  const snapped = isArea && snapping && hazardShoreTaps.length === 2 && shoreError === null;
  const offersShore = hazardDraftType !== null && offersShoreBand(hazardDraftType);
  const placements = hazardDraft ? draftPlacementCount(hazardDraft) : 0;
  // `capturedBodyId` is part of this so Done can never be enabled when `post()` would bail on a
  // missing lake — the button being tappable must guarantee the tap actually files something.
  const postable =
    hazardDraft !== null && draftToShape(hazardDraft) !== null && capturedBodyId !== null;
  const otherTypes = HAZARD_TYPES.filter(
    (t) => !(HAZARD_TYPE_PRESETS as readonly string[]).includes(t),
  );

  // Nothing here can land while a deletion is pending (D62 amendment), so the FAB, the type picker
  // and the adjust bar all go together — offering the draw tool and refusing the submit is precisely
  // the sequence the read-only rule exists to prevent.
  if (leaving) return null;

  return (
    <>
      {toast ? (
        <YStack
          position="absolute"
          top={72}
          left={16}
          right={16}
          backgroundColor="$success"
          borderRadius="$4"
          padding="$3"
          zIndex={40}
        >
          <Text color="$successForeground">{toast}</Text>
        </YStack>
      ) : null}

      {/* The FAB. Present whenever there's a lake to attach to; off-ice it's simply the ordinary way
          to flag one. Deliberately NOT an "you're on the ice!" mode — there should be nothing you
          can be confused about being *in*. */}
      {targetBodyId && !hazardDraft && !picking ? (
        <Button
          position="absolute"
          bottom={132}
          right={16}
          zIndex={30}
          size="$6"
          circular
          backgroundColor="$danger"
          color="$dangerForeground"
          onPress={() => setPicking(true)}
          accessibilityLabel="Flag a hazard"
        >
          ⚠
        </Button>
      ) : null}

      <Modal visible={picking} animationType="slide" transparent onRequestClose={reset}>
        <YStack flex={1} justifyContent="flex-end" backgroundColor="rgba(0,0,0,0.35)">
          <YStack
            backgroundColor="$surface"
            borderTopLeftRadius="$6"
            borderTopRightRadius="$6"
            padding="$4"
            gap="$3"
            maxHeight="80%"
          >
            <H4 color="$foreground">What did you see?</H4>
            <ScrollView>
              <YStack gap="$2.5">
                {/* The three types that are ~80% of real reports get big one-tap tiles (research §6). */}
                {HAZARD_TYPE_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    size="$6"
                    backgroundColor="$danger"
                    color="$dangerForeground"
                    onPress={() => chooseType(preset)}
                  >
                    {HAZARD_TYPE_LABELS[preset]}
                  </Button>
                ))}
                {/* A crossing is the one *positive* marker — where you got across. It reads green so
                    it can't be mistaken for one more danger tile (research §4). */}
                <Button
                  size="$6"
                  backgroundColor="$success"
                  color="$successForeground"
                  onPress={() => chooseType('ridge_crossing')}
                >
                  {HAZARD_TYPE_LABELS.ridge_crossing}
                </Button>
                {showAllTypes ? (
                  otherTypes
                    .filter((t) => t !== 'ridge_crossing')
                    .map((other) => (
                      <Button key={other} size="$5" onPress={() => chooseType(other)}>
                        {HAZARD_TYPE_LABELS[other]}
                      </Button>
                    ))
                ) : (
                  <Button size="$5" chromeless onPress={() => setShowAllTypes(true)}>
                    More…
                  </Button>
                )}
              </YStack>
            </ScrollView>
            <Button chromeless onPress={reset}>
              Cancel
            </Button>
          </YStack>
        </YStack>
      </Modal>

      {/* The adjust bar — everything here is optional. It sits above the drawer peek and never
          blocks the map, because the pin is already valid and the skater may be moving. */}
      {hazardDraft && hazardDraftType && !picking ? (
        <YStack
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          zIndex={35}
          backgroundColor="$surface"
          borderTopWidth={1}
          borderTopColor="$border"
          padding="$3"
          gap="$2"
        >
          <XStack justifyContent="space-between" alignItems="center">
            <Text color="$foreground" fontWeight="700">
              {HAZARD_TYPE_LABELS[hazardDraftType]}
            </Text>
            <Button size="$2" chromeless onPress={reset}>
              Cancel
            </Button>
          </XStack>

          {/* A line that isn't postable yet must always say so, not just while tracing — switching a
              valid pin to a line silently disables Done otherwise, which on the ice reads as the app
              being broken. */}
          {locating ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              Finding you… you can tap the map to drop the pin yourself if you already know where it
              is.
            </Paragraph>
          ) : shoreError ? (
            <Paragraph color="$danger" fontSize={13} accessibilityRole="alert">
              {shoreError}
            </Paragraph>
          ) : snapping && hazardShoreTaps.length < 2 ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {hazardShoreTaps.length === 0
                ? 'Tap one end of the affected shore.'
                : 'Now tap the other end.'}{' '}
              The band follows the lake’s own shoreline between them.
            </Paragraph>
          ) : snapped ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              Following {Math.round(shoreArcLength ?? 0)} m of shoreline. The part that falls on
              land is trimmed off.
            </Paragraph>
          ) : isArea && !postable ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {placements} {placements === 1 ? 'corner' : 'corners'} — tap Draw and add
              {placements >= 2 ? ' another' : ' more'}; an area needs at least three that don’t
              cross over each other.
            </Paragraph>
          ) : isLine && !postable ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {placements} {placements === 1 ? 'point' : 'points'} — tap Trace and add at least one
              more, or go back to Just a spot.
            </Paragraph>
          ) : hazardDropMode ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {isLine
                ? `Tap the map along the hazard. ${placements} ${placements === 1 ? 'point' : 'points'}.`
                : isArea
                  ? `Tap each corner of the area. ${placements} ${placements === 1 ? 'corner' : 'corners'}.`
                  : 'Tap the map where the hazard is.'}
            </Paragraph>
          ) : (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              Dropped where you are. If you spotted it ahead, tap Move and put it where you saw it —
              don’t skate onto it to mark it.
            </Paragraph>
          )}

          {/* One stepper, two meanings, never both on screen (N5b Decision 3): on a snapped band it
              tunes the band half-width and the ring re-derives; otherwise it steps the draft's own
              size. Steppers, not a slider — sliders are miserable with gloves on. */}
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Button
              size="$5"
              accessibilityLabel={isLine || snapped ? 'Narrower' : 'Smaller'}
              onPress={() =>
                snapped
                  ? setShoreHalfWidth((w) => stepSize(w, HAZARD_BUFFER_STEPS_M, -1))
                  : setHazardDraft(resizeDraft(hazardDraft, -1))
              }
            >
              −
            </Button>
            <Text color="$foreground" fontSize={13} flex={1}>
              {snapped
                ? `about ${shoreHalfWidth} m out from shore`
                : hazardDraft.geometryKind === 'point_radius'
                  ? `about ${hazardDraft.radiusMeters} m across`
                  : hazardDraft.geometryKind === 'line'
                    ? `about ${hazardDraft.bufferMeters} m either side`
                    : `about ${hazardDraft.bufferMeters} m of give around the edge`}
            </Text>
            <Button
              size="$5"
              accessibilityLabel={isLine || snapped ? 'Wider' : 'Bigger'}
              onPress={() =>
                snapped
                  ? setShoreHalfWidth((w) => stepSize(w, HAZARD_BUFFER_STEPS_M, 1))
                  : setHazardDraft(resizeDraft(hazardDraft, 1))
              }
            >
              +
            </Button>
          </XStack>

          {/* Photos. Ice hazards are intensely visual and notoriously hard to describe — "folded
              ridges are hard to see" is a recurring cause of death (research §2/§6) — so a picture is
              the highest-value thing one skater leaves the next. Encouraged, plural, and entirely
              skippable: the pin is already valid without one. */}
          {photos.length > 0 ? (
            <XStack gap="$2" flexWrap="wrap">
              {photos.map((photo) => (
                <YStack key={photo.id} gap="$1" alignItems="center">
                  <Image
                    source={{ uri: photo.thumbUri }}
                    style={{ width: 56, height: 56, borderRadius: 6 }}
                  />
                  <Button size="$1" chromeless onPress={() => removePhoto(photo.id)}>
                    Remove
                  </Button>
                </YStack>
              ))}
            </XStack>
          ) : null}

          <XStack gap="$2" flexWrap="wrap">
            {/* A snapped band is re-picked, never hand-adjusted: tap-to-place has no vertex
                dragging (that's terra-draw, and terra-draw can't run here), so "adjust" would mean
                re-tapping the whole ring. Re-picking two ends is the cheap, honest version. */}
            <Button
              size="$4"
              onPress={() => {
                if (snapped) {
                  setShoreArcLength(null);
                  setHazardShoreTaps([]);
                }
                setHazardDropMode(true);
              }}
            >
              {snapped ? 'Re-pick' : isLine ? 'Trace' : isArea ? 'Draw' : 'Move'}
            </Button>
            <Button size="$4" disabled={addingPhotos} onPress={addPhotos}>
              {addingPhotos ? 'Adding…' : photos.length > 0 ? '📷 Add another' : '📷 Photo'}
            </Button>
            {(isLine || (isArea && !snapped)) && placements > 0 ? (
              <Button size="$4" onPress={() => setHazardDraft(undoDraftPlacement(hazardDraft))}>
                {isLine ? 'Undo point' : 'Undo corner'}
              </Button>
            ) : null}
            {/* Two ways round a lake, and "shorter" is right almost always and silently wrong on a
                small pond where the band you mean is most of the perimeter (Decision 4). */}
            {snapped ? (
              <Button size="$4" onPress={() => setShoreOtherWay((other) => !other)}>
                Other way
              </Button>
            ) : null}
          </XStack>

          {/* Changing primitive is opt-in and always reversible; the pin stays valid throughout.
              An area is the advanced one (D51) and no type starts as one, which on the ice also
              protects the two-tap guarantee — three taps and a close is not a mitten-fumble away. */}
          <XStack gap="$2" flexWrap="wrap">
            {!isArea ? (
              <Button
                size="$3"
                chromeless
                onPress={() =>
                  setHazardDraft(
                    switchDraftKind(hazardDraft, isLine ? 'point_radius' : 'line', hazardDraftType),
                  )
                }
              >
                {isLine ? 'Just a spot' : 'It’s a line'}
              </Button>
            ) : (
              <Button
                size="$3"
                chromeless
                onPress={() => {
                  setHazardShoreTaps(null);
                  setShoreError(null);
                  setShoreArcLength(null);
                  setHazardDraft(switchDraftKind(hazardDraft, 'point_radius', hazardDraftType));
                }}
              >
                Just a spot
              </Button>
            )}
            {!isArea ? (
              <Button
                size="$3"
                chromeless
                onPress={() => {
                  const next = switchDraftKind(hazardDraft, 'polygon', hazardDraftType);
                  setHazardDraft(next);
                  if (draftPlacementCount(next) < 3) setHazardDropMode(true);
                }}
              >
                It’s an area
              </Button>
            ) : null}
            {/* Snapping is only offered for the two types that are genuinely shore-shaped
                (Decision 1) — a ridge is linear but not *shore*-linear. */}
            {offersShore && !snapped ? (
              <Button
                size="$3"
                chromeless
                onPress={() => {
                  setShoreError(null);
                  setShoreArcLength(null);
                  setShoreOtherWay(false);
                  setShoreHalfWidth(SHORE_BAND_DEFAULT_HALF_WIDTH_M);
                  setHazardShoreTaps([]);
                  setHazardDropMode(true);
                }}
              >
                Along the shore
              </Button>
            ) : null}
          </XStack>

          {error ? (
            <Text
              color="$danger"
              fontSize={13}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              {error}
            </Text>
          ) : null}

          <Button
            size="$6"
            backgroundColor={postable ? '$primary' : undefined}
            color={postable ? '$primaryForeground' : undefined}
            disabled={!postable || saving}
            opacity={postable ? 1 : 0.5}
            onPress={post}
          >
            {saving ? 'Posting…' : 'Done'}
          </Button>
          {isPassageMarker(hazardDraftType) ? (
            <Paragraph color="$foregroundMuted" fontSize={12}>
              A crossing marks where you got across — it’s not a promise it’s safe, and ridges
              change hour to hour.
            </Paragraph>
          ) : null}
        </YStack>
      ) : null}
    </>
  );
}
