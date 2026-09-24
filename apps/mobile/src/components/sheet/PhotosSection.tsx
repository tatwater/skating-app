import {
  type DraftPhoto,
  onWater,
  photosInWindow,
  photoWindow,
  placePhoto as placeAlongTrack,
  sameDayWindow,
  selectedValues,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { deleteDraftPhotoFiles, isPersistedUri, persistDraftPhoto } from '../../lib/draftPhotos';
import { getTrack } from '../../lib/draftStore';
import { setHazardPrefill } from '../../lib/hazardPrefill';
import { pickPhotos, processPhoto } from '../photoPipeline';
import { LakeMap } from './LakeMap';
import { SheetChip } from './SheetChip';
import { QuestionBlock, SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';

/** How many of the library's photos the reel shows before *same day* widens it. */
const REEL_MAX = 30;

interface ReelPhoto {
  assetId: string;
  uri: string;
  takenAtMs: number;
}

/**
 * *Photos* (A10 §8, the A10-7 half): **Photos from your skate** — the camera roll queried for the
 * skate's window (the end time, and the start when there is one, padded; *same day* as the wider
 * option), each a tap to include. Nothing leaves the roll and nothing uploads until Post. An
 * included photo carries its capture time and its EXIF location, read on device; one on the lake
 * is placed by it, one with no location on a Report opened from a recording is placed where the
 * track was when the shutter fired, and any other can be placed by a tap on the lake. *This is a
 * hazard* hands the photo and its location to the map's capture. The picker stays for the rest.
 *
 * Nothing uploads from here: the queue uploads at flush, checkpointing each object, so a photo
 * picked with no signal costs nothing until it can post.
 */
export function PhotosSection({
  report,
  body,
  dispatch,
  setReport,
  gaps,
  editing,
  timeZone,
}: SectionProps) {
  const sheet = report.sheet;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reel, setReel] = useState<ReelPhoto[] | null>(null);
  const [reelState, setReelState] = useState<'idle' | 'loading' | 'denied' | 'none'>('idle');
  const [wide, setWide] = useState(false);
  const [placing, setPlacing] = useState<string | null>(null);
  const count = report.photos.length + report.keptPhotoIds.length;
  const summary = count > 0 ? `${count} ${count === 1 ? 'photo' : 'photos'}` : '';
  const [end] = selectedValues(sheet, 'endTime');
  const endMs = end?.ms;
  const startMs = sheet.scalars.skateStartTime;
  const outline = body?.polygon;
  const included = useMemo(() => new Set(report.photos.map((p) => p.id)), [report.photos]);

  // The window the library is asked for: the skate's, padded — or the whole local day.
  const window = useMemo(() => {
    if (endMs === undefined) return null;
    const activity = { startMs: startMs ?? endMs - 2 * 3600_000, endMs };
    return wide ? sameDayWindow(activity, timeZone) : photoWindow(activity);
  }, [endMs, startMs, wide, timeZone]);

  const loadReel = useCallback(async () => {
    if (!window) return;
    setReelState('loading');
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      if (!perm.granted) {
        setReelState('denied');
        return;
      }
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: 'photo',
        createdAfter: window.startMs,
        createdBefore: window.endMs,
        sortBy: [['creationTime', true]],
        first: REEL_MAX,
      });
      const photos = photosInWindow(
        page.assets.map((a) => ({ id: a.id, takenAtMs: a.creationTime, uri: a.uri })),
        window,
      ).map((a) => ({ assetId: a.id, uri: a.uri, takenAtMs: a.takenAtMs as number }));
      setReel(photos);
      setReelState(photos.length === 0 ? 'none' : 'idle');
    } catch {
      setReelState('none');
    }
  }, [window]);
  useEffect(() => {
    if (window && !sheet.collapsed.photos) void loadReel();
  }, [window, loadReel, sheet.collapsed.photos]);

  /** The recorded track's points, for placing an undated-location photo where the skater was. */
  const trackPoints = useMemo(() => {
    if (report.trackDraftId === undefined) return [];
    return (getTrack(report.trackDraftId)?.points ?? []).map((p) => ({
      lat: p.lat,
      lng: p.lng,
      timestamp: p.t,
    }));
  }, [report.trackDraftId]);

  /** Turn a library asset into a draft photo: EXIF read on device, files copied out of the roll. */
  const include = async (item: ReelPhoto) => {
    setError(null);
    setBusy(true);
    try {
      const info = await MediaLibrary.getAssetInfoAsync(item.assetId, {
        shouldDownloadFromNetwork: true,
      });
      const processed = await processPhoto({
        uri: info.localUri ?? info.uri,
        width: info.width,
        height: info.height,
        exif: (info.exif as Record<string, unknown> | undefined) ?? null,
        creationTime: info.creationTime,
      });
      const exifCoord =
        processed.coord ??
        (info.location ? { lat: info.location.latitude, lng: info.location.longitude } : undefined);
      const id = randomUUID();
      const [fullUri, thumbUri] = await Promise.all([
        persistDraftPhoto(processed.fullUri, `sheet-${id}-full.jpg`),
        persistDraftPhoto(processed.thumbUri, `sheet-${id}-thumb.jpg`),
      ]);
      const takenAtMs = processed.takenAtMs ?? item.takenAtMs;
      // Where it was taken: its own location if on the water; else along the track at that minute
      // — and that only on the water too, since a shutter before the first fix clamps to the
      // track's first point, which may be the launch the author keeps to themselves (D58).
      let coord = exifCoord;
      let placeOnMap = onWater(coord, outline);
      if (!placeOnMap && trackPoints.length > 1) {
        const along = placeAlongTrack({ id, takenAtMs, coord: undefined }, trackPoints);
        if (along && onWater(along.coord, outline)) {
          coord = along.coord;
          placeOnMap = true;
        }
      }
      const draft: DraftPhoto = {
        id,
        fullUri,
        thumbUri,
        ...(coord ? { coord } : {}),
        takenAtMs,
        placeOnMap,
      };
      setReport((r) => ({ ...r, photos: [...r.photos, draft] }));
      setIncludedAsset(item.assetId, id);
    } catch {
      setError("Couldn't read that photo from your library.");
    } finally {
      setBusy(false);
    }
  };
  // Which reel item became which draft, so a second tap removes rather than re-adds.
  const [assetToDraft, setAssetToDraft] = useState<Record<string, string>>({});
  const setIncludedAsset = (assetId: string, draftId: string) =>
    setAssetToDraft((m) => ({ ...m, [assetId]: draftId }));

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const assets = await pickPhotos();
      if (assets.length === 0) return;
      const drafts: DraftPhoto[] = await Promise.all(
        assets.map(async (asset) => {
          const processed = await processPhoto(asset);
          const coord = processed.coord;
          return {
            id: randomUUID(),
            fullUri: processed.fullUri,
            thumbUri: processed.thumbUri,
            ...(coord ? { coord } : {}),
            ...(processed.takenAtMs !== undefined ? { takenAtMs: processed.takenAtMs } : {}),
            placeOnMap: onWater(coord, outline),
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

  /**
   * Photo → hazard (A10-7): the map's capture with the pin where the photo was taken and the photo
   * attached. The capture gets its **own copy** of the files: it frees what it holds on Cancel and
   * the hazard queue frees it after a flush, and this Report's photo must outlive both.
   */
  const asHazard = async (photo: DraftPhoto) => {
    if (!body) return;
    setError(null);
    setBusy(true);
    try {
      const id = randomUUID();
      const [fullUri, thumbUri] = await Promise.all([
        persistDraftPhoto(photo.fullUri, `hazard-${id}-full.jpg`),
        persistDraftPhoto(photo.thumbUri, `hazard-${id}-thumb.jpg`),
      ]);
      setHazardPrefill({
        ...(photo.coord !== undefined ? { coord: photo.coord } : {}),
        photos: [{ id, fullUri, thumbUri, placeOnMap: false }],
        sourceIds: [photo.id],
      });
      router.navigate({
        pathname: '/water/[id]',
        params: { id: body.waterBodyId, hazard: String(Date.now()) },
      });
    } catch {
      setError("Couldn't hand that photo to the map — try again.");
    } finally {
      setBusy(false);
    }
  };

  const placingPhoto = placing ? report.photos.find((p) => p.id === placing) : undefined;

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
      {/* The reel: the roll, for the skate's window. */}
      {!editing && window ? (
        <YStack gap="$2">
          <SubLabel>
            From your skate · {clock(window.startMs)}–{clock(window.endMs)}
            {reel ? ` · ${reel.length} found` : ''}
          </SubLabel>
          {reelState === 'denied' ? (
            <SheetHint>
              Photo access is off for Gli — allow it in Settings to see the roll here.
            </SheetHint>
          ) : reelState === 'none' ? (
            <SheetHint>
              {wide ? 'No photos on your phone from that day.' : 'No photos from those hours.'}
            </SheetHint>
          ) : null}
          {reel && reel.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <XStack gap={6}>
                {reel.map((item) => {
                  const draftId = assetToDraft[item.assetId];
                  const on = draftId !== undefined && included.has(draftId);
                  const placed = on && report.photos.find((p) => p.id === draftId)?.placeOnMap;
                  return (
                    <Pressable
                      key={item.assetId}
                      disabled={busy}
                      onPress={() => (on ? remove(draftId as string) : void include(item))}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={`Photo from ${clock(item.takenAtMs)}`}
                    >
                      <YStack
                        width={74}
                        height={74}
                        borderRadius="$xs"
                        borderWidth={1}
                        borderColor={on ? '$foreground' : '$border'}
                        overflow="hidden"
                      >
                        <Image source={{ uri: item.uri }} style={{ width: 74, height: 74 }} />
                        <YStack
                          position="absolute"
                          left={4}
                          top={4}
                          width={16}
                          height={16}
                          borderWidth={1}
                          borderRadius="$xs"
                          borderColor={on ? '$foreground' : '$borderStrong'}
                          backgroundColor={on ? '$foreground' : '$background'}
                          alignItems="center"
                          justifyContent="center"
                        >
                          {on ? (
                            <Text
                              color="$background"
                              fontSize={11}
                              fontWeight="700"
                              lineHeight={14}
                            >
                              ✓
                            </Text>
                          ) : null}
                        </YStack>
                        {placed ? (
                          <YStack
                            position="absolute"
                            right={4}
                            bottom={4}
                            width={7}
                            height={7}
                            backgroundColor="$primary"
                          />
                        ) : null}
                      </YStack>
                    </Pressable>
                  );
                })}
                <Pressable onPress={() => setWide((w) => !w)} accessibilityRole="button">
                  <YStack
                    width={74}
                    height={74}
                    borderRadius="$xs"
                    borderWidth={1}
                    borderStyle="dashed"
                    borderColor="$border"
                    alignItems="center"
                    justifyContent="center"
                  >
                    <Text
                      color="$foregroundMuted"
                      fontSize={12}
                      fontWeight="600"
                      textAlign="center"
                    >
                      {wide ? 'Just the\nskate' : 'Same\nday'}
                    </Text>
                  </YStack>
                </Pressable>
              </XStack>
            </ScrollView>
          ) : null}
          <SheetHint>
            Tap to include. Nothing leaves your camera roll. A blue corner means it's placed on the
            lake from its own location.
          </SheetHint>
        </YStack>
      ) : null}

      {/* What this Report carries, with a home for each. */}
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
          <YStack key={photo.id} gap="$1" alignItems="center" width={72}>
            <YStack
              borderRadius="$xs"
              overflow="hidden"
              borderWidth={placing === photo.id ? 2 : 0}
              borderColor="$primary"
            >
              <Image
                source={{ uri: photo.thumbUri }}
                style={{ width: 72, height: 72 }}
                accessibilityLabel="A photo you picked"
              />
              {photo.placeOnMap ? (
                <YStack
                  position="absolute"
                  right={4}
                  bottom={4}
                  width={7}
                  height={7}
                  backgroundColor="$primary"
                />
              ) : null}
            </YStack>
            <XStack gap={4}>
              <SheetChip
                compact
                label={photo.placeOnMap ? 'Placed' : 'Place'}
                tier={photo.placeOnMap ? 'solid' : undefined}
                onPress={() => {
                  if (photo.placeOnMap) {
                    setReport((r) => ({
                      ...r,
                      photos: r.photos.map((p) =>
                        p.id === photo.id ? { ...p, placeOnMap: false } : p,
                      ),
                    }));
                  } else if (onWater(photo.coord, outline)) {
                    setReport((r) => ({
                      ...r,
                      photos: r.photos.map((p) =>
                        p.id === photo.id ? { ...p, placeOnMap: true } : p,
                      ),
                    }));
                  } else setPlacing(placing === photo.id ? null : photo.id);
                }}
              />
            </XStack>
            <XStack gap={8}>
              <Text
                color="$danger"
                fontSize={11}
                onPress={() => void asHazard(photo)}
                accessibilityRole="button"
              >
                Hazard
              </Text>
              <Text
                color="$foregroundMuted"
                fontSize={11}
                onPress={() => remove(photo.id)}
                accessibilityRole="button"
              >
                Remove
              </Text>
            </XStack>
          </YStack>
        ))}
      </XStack>
      {placingPhoto && body?.silhouette ? (
        <QuestionBlock title="Where was this photo taken?" onDone={() => setPlacing(null)}>
          <LakeMap
            data={body.silhouette}
            point={placingPhoto.coord}
            height={190}
            onTap={(coord) => {
              setReport((r) => ({
                ...r,
                photos: r.photos.map((p) =>
                  p.id === placingPhoto.id ? { ...p, coord, placeOnMap: true } : p,
                ),
              }));
              setPlacing(null);
            }}
          />
          <SheetHint>Tap the water where you took it, or leave it unplaced.</SheetHint>
        </QuestionBlock>
      ) : null}
      <Button size="$2" alignSelf="flex-start" onPress={() => void add()} disabled={busy}>
        {busy ? 'Adding…' : '+ From your library'}
      </Button>
      {report.photos.some((p) => p.coord) ? (
        <SheetHint>
          A photo's location is only sent if it's placed on the lake. Everything else in the file is
          stripped before it leaves your phone.
        </SheetHint>
      ) : null}
      {editing ? <SheetHint>A photo you remove leaves the report when you save.</SheetHint> : null}
      {error ? (
        <Text color="$danger" fontSize={12}>
          {error}
        </Text>
      ) : null}
    </SheetSection>
  );
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(ms);
}
