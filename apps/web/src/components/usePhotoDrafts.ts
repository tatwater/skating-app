import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { photoUploadCoord } from '@skating/core';
import { useMutation } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { processPhoto, uploadToStorage } from './photoPipeline';

/**
 * Shared photo-attachment lifecycle for the authoring forms (D31/D42) — report photos and hazard
 * photos are the same pipeline, so they're the same hook.
 *
 * It exists because the *careful* parts are easy to get subtly wrong twice: the checkpointed upload
 * (each blob's storage id recorded the instant it lands, so a retry after a partial failure reuses
 * it instead of orphaning a duplicate), the teardown sweep (an abandoned form must reclaim whatever
 * it already uploaded), and the race where an upload resolves *after* the component unmounted and
 * has to reclaim itself. Duplicating that into a second form is how storage leaks appear.
 *
 * The privacy invariant lives in the pipeline below it: EXIF GPS is read from the ORIGINAL, then the
 * re-encode strips all metadata, so the only location that can leave the browser is one the user
 * explicitly opted to place on the map (`photoUploadCoord`).
 */

/** A processed photo awaiting upload — blobs + EXIF coord + the per-photo `placeOnMap` opt-in (D42). */
interface PhotoDraft {
  id: string;
  previewUrl: string;
  full: File;
  thumb: File;
  coord?: { lat: number; lng: number };
  placeOnMap: boolean;
  /**
   * Storage IDs recorded as each blob lands, so a submit retry after a partial-upload failure
   * reuses the already-uploaded object instead of orphaning it and uploading a fresh copy.
   */
  fullStorageId?: Id<'_storage'>;
  thumbStorageId?: Id<'_storage'>;
  /** Set once the photo row exists, so a retry doesn't re-create it (and re-attach it twice). */
  uploadedId?: Id<'photos'>;
}

/** The subset a form renders (no blobs). */
export interface PhotoDraftView {
  id: string;
  previewUrl: string;
  coord?: { lat: number; lng: number };
  placeOnMap: boolean;
}

export interface PhotoDrafts {
  photos: PhotoDraftView[];
  /** Non-null when processing a picked file failed; forms surface it alongside their own errors. */
  error: string | null;
  /**
   * Drop the processing error. Forms call this wherever they clear their *own* error (i.e. on
   * submit): the offending photo has usually been removed by then, and a stale "couldn't process one
   * of those photos" sitting under a submit button reads as if the submit itself failed.
   */
  clearError: () => void;
  addFiles: (files: FileList) => Promise<void>;
  removePhoto: (id: string) => void;
  setPlaceOnMap: (id: string, on: boolean) => void;
  /**
   * Upload every attached photo and return the resulting `photoIds`, in attachment order. Safe to
   * call again after a failure — anything already uploaded is reused rather than re-sent.
   */
  uploadAll: () => Promise<Id<'photos'>[]>;
  /**
   * Tell the hook the parent record is committing, so the teardown sweep stops reclaiming these
   * photos — they belong to the report/hazard now. **Call `true` before the create mutation**, not
   * after: an unmount *during* the mutation would otherwise sweep and delete the very rows the
   * committing record is about to reference, leaving it with permanently missing images. Set back to
   * `false` if the create then fails, so the uploads are reclaimable again.
   */
  setCommitted: (committed: boolean) => void;
}

export function usePhotoDrafts(): PhotoDrafts {
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl);
  const createPhoto = useMutation(api.photos.create);
  const deletePhoto = useMutation(api.photos.remove);
  const removeBlob = useMutation(api.photos.removeBlob);

  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reclaim whatever a draft has already uploaded so nothing is stranded server-side: a created row
  // (deletes the row + both blobs) or, for a partial/interrupted upload, the bare blobs that never
  // got a row. Best-effort; failures are swallowed.
  const reclaim = useCallback(
    (p: PhotoDraft) => {
      if (p.uploadedId) {
        void deletePhoto({ photoId: p.uploadedId }).catch(() => {});
        return;
      }
      if (p.fullStorageId) void removeBlob({ storageId: p.fullStorageId }).catch(() => {});
      if (p.thumbStorageId) void removeBlob({ storageId: p.thumbStorageId }).catch(() => {});
    },
    [deletePhoto, removeBlob],
  );

  // Revoke every preview object URL on unmount — via a ref so we don't revoke still-displayed
  // previews on each add/remove (a `[photos]` dep would run cleanup on every list change).
  // Individual removals revoke their own URL in `removePhoto`.
  const photosRef = useRef<PhotoDraft[]>([]);
  photosRef.current = photos;
  const committedRef = useRef(false);
  // Flipped at teardown so an upload / row-create that resolves *after* the sweep reclaims itself —
  // the sweep only sees what's already recorded, not what's still in flight.
  const disposedRef = useRef(false);
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      for (const p of photosRef.current) {
        URL.revokeObjectURL(p.previewUrl);
        if (!committedRef.current) reclaim(p);
      }
    };
  }, [reclaim]);

  const removePhoto = useCallback(
    (id: string) => {
      setPhotos((prev) => {
        const removed = prev.find((p) => p.id === id);
        if (removed) {
          URL.revokeObjectURL(removed.previewUrl);
          // Reclaim anything a prior failed submit uploaded (row and/or bare blobs) — dropping it
          // from state alone would strand it (it's no longer in the unmount sweep).
          reclaim(removed);
        }
        return prev.filter((p) => p.id !== id);
      });
    },
    [reclaim],
  );

  // Takes the desired value rather than toggling: the control is a checkbox that reports its own
  // state, and a toggle would desync if it ever fired twice with the same value.
  const setPlaceOnMap = useCallback((id: string, on: boolean) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, placeOnMap: on } : p)));
  }, []);

  const addFiles = useCallback(async (files: FileList) => {
    setError(null);
    try {
      // Process the picked files concurrently (each is a heavy HEIC-decode + two compressions).
      // Create the object URLs only AFTER all succeed — doing it inside the tasks would leak the
      // URLs of the files that resolved when a sibling rejects (they never reach state to be revoked).
      const processed = await Promise.all(Array.from(files).map((file) => processPhoto(file)));
      const drafts = processed.map(
        (p) =>
          ({
            id: crypto.randomUUID(),
            previewUrl: URL.createObjectURL(p.thumb),
            full: p.full,
            thumb: p.thumb,
            coord: p.coord,
            placeOnMap: false,
          }) satisfies PhotoDraft,
      );
      setPhotos((prev) => [...prev, ...drafts]);
    } catch {
      setError("Couldn't process one of those photos — try a different image.");
    }
  }, []);

  const uploadAll = useCallback(async (): Promise<Id<'photos'>[]> => {
    return Promise.all(
      photosRef.current.map(async (photo) => {
        if (photo.uploadedId) return photo.uploadedId;
        // Upload the full + thumb independently, each recording its storage id the instant it lands
        // (not after both settle). So a partial failure keeps the blob that DID upload — a retry
        // reuses it instead of orphaning a duplicate, and the cleanup sweep can reclaim it.
        const ensure = (
          existing: Id<'_storage'> | undefined,
          file: File,
          key: 'fullStorageId' | 'thumbStorageId',
        ): Promise<Id<'_storage'>> =>
          existing !== undefined
            ? Promise.resolve(existing)
            : generateUploadUrl()
                .then((url) => uploadToStorage(url, file))
                .then((sid) => {
                  const id = sid as Id<'_storage'>;
                  // If the form was torn down while this was in flight (and we're not mid-successful-
                  // submit), no draft remains to record or sweep it — reclaim the blob here instead.
                  if (disposedRef.current && !committedRef.current) {
                    void removeBlob({ storageId: id }).catch(() => {});
                  } else {
                    setPhotos((prev) =>
                      prev.map((p) => (p.id === photo.id ? { ...p, [key]: id } : p)),
                    );
                  }
                  return id;
                });
        const [storageId, thumbStorageId] = await Promise.all([
          ensure(photo.fullStorageId, photo.full, 'fullStorageId'),
          ensure(photo.thumbStorageId, photo.thumb, 'thumbStorageId'),
        ]);
        const id = await createPhoto({
          storageId,
          thumbStorageId,
          placeOnMap: photo.placeOnMap,
          coord: photoUploadCoord(photo.placeOnMap, photo.coord),
        });
        // Same teardown race one level up: the row was created after the form unmounted, so nothing
        // will attach it — reclaim the row (+ its blobs) rather than strand it.
        if (disposedRef.current && !committedRef.current) {
          void deletePhoto({ photoId: id }).catch(() => {});
        } else {
          setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, uploadedId: id } : p)));
        }
        return id;
      }),
    );
  }, [createPhoto, deletePhoto, generateUploadUrl, removeBlob]);

  const clearError = useCallback(() => setError(null), []);

  const setCommitted = useCallback((committed: boolean) => {
    committedRef.current = committed;
  }, []);

  return {
    photos: photos.map((p) => ({
      id: p.id,
      previewUrl: p.previewUrl,
      coord: p.coord,
      placeOnMap: p.placeOnMap,
    })),
    error,
    clearError,
    addFiles,
    removePhoto,
    setPlaceOnMap,
    uploadAll,
    setCommitted,
  };
}
