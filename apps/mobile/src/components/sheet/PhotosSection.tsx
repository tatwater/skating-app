import type { DraftPhoto } from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { Image } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { deleteDraftPhotoFiles, isPersistedUri } from '../../lib/draftPhotos';
import { pickPhotos, processPhoto } from '../photoPipeline';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetSection } from './SheetSection';
import type { SectionProps } from './sectionProps';

/**
 * *Photos* (A10 §8, the A10-3 half): the picker and the native pipeline as they were — EXIF
 * stripped, only a coordinate kept, sent only on the `placeOnMap` opt-in (D42) — with the photos
 * held on the sheet until Post or Save draft copies them into the draft's own files. *Photos from
 * your skate* (the time-window query over the camera roll, §8.1) is A10-4.
 *
 * Nothing uploads from here: the queue uploads at flush, checkpointing each object, so a photo
 * picked with no signal costs nothing until it can post.
 */
export function PhotosSection({
  report,
  dispatch,
  setReport,
  gaps,
  editing,
  timeZone,
}: SectionProps) {
  const sheet = report.sheet;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = report.photos.length + report.keptPhotoIds.length;
  const summary = count > 0 ? `${count} ${count === 1 ? 'photo' : 'photos'}` : '';
  void timeZone;

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const assets = await pickPhotos();
      if (assets.length === 0) return;
      const drafts: DraftPhoto[] = await Promise.all(
        assets.map(async (asset) => {
          const processed = await processPhoto(asset);
          return {
            id: randomUUID(),
            fullUri: processed.fullUri,
            thumbUri: processed.thumbUri,
            ...(processed.coord ? { coord: processed.coord } : {}),
            placeOnMap: false,
          };
        }),
      );
      setReport((r) => ({ ...r, photos: [...r.photos, ...drafts] }));
    } catch {
      setError("Couldn't add those photos — check photo permission and try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string) =>
    setReport((r) => {
      const gone = r.photos.find((p) => p.id === id);
      if (gone) {
        // A photo already copied for a saved draft owns its files; drop them with it.
        const files = [gone.fullUri, gone.thumbUri].filter(isPersistedUri);
        if (files.length > 0) deleteDraftPhotoFiles(files);
      }
      return { ...r, photos: r.photos.filter((p) => p.id !== id) };
    });

  return (
    <SheetSection
      label="Photos"
      summary={summary}
      collapsed={sheet.collapsed.photos}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'photos', collapsed: !sheet.collapsed.photos })
      }
      gap={gaps.has('photos')}
    >
      <XStack gap={6} flexWrap="wrap">
        {report.keptPhotoIds.map((photoId) => (
          <YStack key={photoId} gap="$1" alignItems="center">
            <YStack
              width={72}
              height={72}
              borderRadius="$xs"
              backgroundColor="$surfaceMuted"
              alignItems="center"
              justifyContent="center"
            >
              <Text color="$foregroundMuted" fontSize={11}>
                On the report
              </Text>
            </YStack>
            <Text
              color="$foregroundMuted"
              fontSize={11}
              onPress={() =>
                setReport((r) => ({
                  ...r,
                  keptPhotoIds: r.keptPhotoIds.filter((id) => id !== photoId),
                }))
              }
            >
              Remove
            </Text>
          </YStack>
        ))}
        {report.photos.map((photo) => (
          <YStack key={photo.id} gap="$1" alignItems="center">
            <Image
              source={{ uri: photo.thumbUri }}
              style={{ width: 72, height: 72, borderRadius: 2 }}
              accessibilityLabel="A photo you picked"
            />
            {photo.coord ? (
              <SheetChip
                compact
                label="On the map"
                tier={photo.placeOnMap ? 'solid' : undefined}
                onPress={() =>
                  setReport((r) => ({
                    ...r,
                    photos: r.photos.map((p) =>
                      p.id === photo.id ? { ...p, placeOnMap: !p.placeOnMap } : p,
                    ),
                  }))
                }
              />
            ) : null}
            <Text color="$foregroundMuted" fontSize={11} onPress={() => remove(photo.id)}>
              Remove
            </Text>
          </YStack>
        ))}
      </XStack>
      <Button size="$2" alignSelf="flex-start" onPress={() => void add()} disabled={busy}>
        {busy ? 'Adding…' : '+ Photos'}
      </Button>
      {editing ? <SheetHint>A photo you remove leaves the report when you save.</SheetHint> : null}
      {error ? (
        <Text color="$danger" fontSize={12}>
          {error}
        </Text>
      ) : null}
    </SheetSection>
  );
}
