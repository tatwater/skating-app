import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { MAX_ACCESS_PHOTOS } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button, Image, Text, XStack, YStack } from 'tamagui';
import { pickPhotos, processPhoto, uploadToStorage } from './photoPipeline';

/**
 * Photos of an access point — the mobile half of web's `AccessPhotos` (N6d Workstream D / D88).
 *
 * *"Is this the right dirt road?"* is the question, and the phone is where it gets asked: you are in
 * the car, at a junction, in the dark. So this is arguably the more important of the two surfaces.
 *
 * **Uploads directly rather than staging drafts**, which is the one real difference from web. There
 * is no form to abandon here — a photo picked is a photo meant — so the checkpoint-and-reclaim dance
 * `HazardCapture` needs (where an upload can outlive a form the skater cancels) has nothing to
 * protect. Each photo is uploaded, rowed and attached in one pass; a failure leaves the earlier ones
 * attached, which is the right outcome for an operation with no all-or-nothing meaning.
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
  const photos = useQuery(api.accessPoints.listPhotos, {
    targetType,
    ...(putInId ? { putInId } : {}),
    ...(parkingAreaId ? { parkingAreaId } : {}),
  });
  const generateUploadUrl = useMutation(api.photos.generateUploadUrl);
  const createPhoto = useMutation(api.photos.create);
  const attach = useMutation(api.accessPoints.attachPhoto);
  const detach = useMutation(api.accessPoints.detachPhoto);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = photos ?? [];
  const remaining = MAX_ACCESS_PHOTOS - existing.length;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      // `pickPhotos` takes no cap, so the slice is ours — and the server enforces it anyway, which
      // is what makes this a courtesy rather than the rule.
      const picked = (await pickPhotos()).slice(0, remaining);
      for (const asset of picked) {
        // The pipeline strips EXIF on re-encode; `placeOnMap: false` because an access photo's
        // location is the access point's, which we already know — there is nothing to opt into (D42).
        const processed = await processPhoto(asset);
        const storageId = await generateUploadUrl().then((url) =>
          uploadToStorage(url, processed.fullUri),
        );
        const thumbStorageId = await generateUploadUrl().then((url) =>
          uploadToStorage(url, processed.thumbUri),
        );
        const photoId = await createPhoto({
          storageId: storageId as Id<'_storage'>,
          thumbStorageId: thumbStorageId as Id<'_storage'>,
          placeOnMap: false,
        });
        await attach({
          targetType,
          ...(putInId ? { putInId } : {}),
          ...(parkingAreaId ? { parkingAreaId } : {}),
          photoId,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t add that photo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        {label}
      </Text>

      {existing.length > 0 ? (
        <XStack gap="$2" flexWrap="wrap">
          {existing.map((photo) =>
            photo.thumbUrl ? (
              <YStack key={photo.photoId}>
                <Image source={{ uri: photo.thumbUrl }} width={72} height={72} borderRadius={6} />
                <Button
                  size="$1"
                  chromeless
                  onPress={() =>
                    void detach({ accessPhotoId: photo.accessPhotoId as Id<'accessPhotos'> })
                  }
                >
                  <Text fontSize={11} color="$foregroundMuted">
                    Remove
                  </Text>
                </Button>
              </YStack>
            ) : null,
          )}
        </XStack>
      ) : null}

      {error ? (
        <Text color="$danger" fontSize={13} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {remaining > 0 ? (
        <Button
          size="$2"
          chromeless
          borderWidth={1}
          borderColor="$border"
          disabled={busy}
          onPress={() => void add()}
        >
          <Text>{busy ? 'Uploading…' : 'Add a photo'}</Text>
        </Button>
      ) : (
        // Said rather than hidden: a button that vanishes reads as broken.
        <Text color="$foregroundMuted" fontSize={12}>
          {MAX_ACCESS_PHOTOS} photos is the limit for one access point.
        </Text>
      )}
    </YStack>
  );
}
