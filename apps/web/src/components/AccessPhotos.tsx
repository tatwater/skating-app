import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { MAX_ACCESS_PHOTOS } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { usePhotoDrafts } from './usePhotoDrafts';

/**
 * Photos of an access point (N6d Workstream D / D88) — *"is this the right dirt road?"*
 *
 * A picture of the pull-off answers that better than any prose, which is the founder's whole
 * rationale. Three things about it are deliberately unlike report photos:
 *
 * - **They document infrastructure, not conditions**, so they are exempt from D66's seasonal purge.
 *   A parking lot looks the same next November.
 * - **No new permission** (D88). They ride D57's existing report/hazard posting right, because a bad
 *   photo of a parking lot is wrong rather than dangerous. The `MAX_ACCESS_PHOTOS` cap and Phase 3's
 *   minors-are-read-only rule do the protective work instead.
 * - **They live in `accessPhotos` rows, not a `photoIds` array**, and that is not a style choice: the
 *   put-in is created by the ETL, so a photo hanging off it would be invisible to the orphan sweep's
 *   scan-by-author and destroyed thirty days later.
 *
 * Reuses `usePhotoDrafts` unchanged — the checkpointed upload, the teardown sweep and the
 * EXIF-stripping pipeline are the careful parts, and duplicating them is how storage leaks appear.
 */
export function AccessPhotos({
  putInId,
  parkingAreaId,
  label,
}: {
  putInId?: Id<'putIns'>;
  parkingAreaId?: Id<'parkingAreas'>;
  label: string;
}) {
  const targetType = putInId ? ('put_in' as const) : ('parking_area' as const);
  // Exactly the id `targetType` names, never both. The server refuses a row that claims two targets
  // — an alert or photo carrying a foreign id is reachable from that other lake's read path — and
  // spreading whichever props happened to be set would send one the moment this component is given
  // both. Deriving the pair together keeps the client incapable of forming the request.
  const target = putInId ? { putInId } : parkingAreaId ? { parkingAreaId } : {};
  const photos = useQuery(api.accessPoints.listPhotos, { targetType, ...target });
  const attach = useMutation(api.accessPoints.attachPhoto);
  const detach = useMutation(api.accessPoints.detachPhoto);
  const drafts = usePhotoDrafts();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = photos ?? [];
  const remaining = MAX_ACCESS_PHOTOS - existing.length;

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      // `setCommitted(true)` BEFORE the mutation, not after: an unmount during it would otherwise
      // sweep and delete the very rows we are about to attach. Same ordering the report form uses.
      drafts.setCommitted(true);
      const ids = await drafts.uploadAll();
      for (const photoId of ids) {
        await attach({ targetType, ...target, photoId });
      }
      for (const photo of drafts.photos) drafts.removePhoto(photo.id);
    } catch (err) {
      // Reclaimable again — the attach failed, so these uploads belong to nobody.
      drafts.setCommitted(false);
      setError(err instanceof Error ? err.message : 'Could not attach those photos');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="font-medium text-foreground-muted text-xs uppercase tracking-widest">{label}</p>

      {existing.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {existing.map((photo) => (
            <li key={photo.photoId} className="relative">
              {photo.thumbUrl ? (
                <img
                  src={photo.thumbUrl}
                  alt="Access point"
                  className="h-20 w-20 rounded object-cover"
                />
              ) : (
                <div className="h-20 w-20 rounded bg-surface-muted" />
              )}
              <button
                type="button"
                aria-label="Remove photo"
                className="absolute top-0 right-0 rounded bg-surface px-1 text-xs"
                onClick={() =>
                  void detach({ accessPhotoId: photo.accessPhotoId as Id<'accessPhotos'> })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {drafts.photos.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {drafts.photos.map((draft) => (
            <li key={draft.id}>
              <img
                src={draft.previewUrl}
                alt="Pending upload"
                className="h-20 w-20 rounded object-cover opacity-70"
              />
            </li>
          ))}
        </ul>
      ) : null}

      {(error ?? drafts.error) ? (
        <p className="text-destructive text-sm">{error ?? drafts.error}</p>
      ) : null}

      {remaining > 0 ? (
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void drafts.addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
            Add a photo
          </Button>
          {drafts.photos.length > 0 ? (
            <Button size="sm" disabled={busy} onClick={() => void commit()}>
              {busy ? 'Uploading…' : 'Upload'}
            </Button>
          ) : null}
        </div>
      ) : (
        // Stated rather than hidden: a disappearing button reads as broken. Three is enough to answer
        // "which dirt road" and few enough that the point doesn't become a gallery.
        <p className="text-foreground-muted text-xs">
          {MAX_ACCESS_PHOTOS} photos is the limit for one access point.
        </p>
      )}
    </div>
  );
}
