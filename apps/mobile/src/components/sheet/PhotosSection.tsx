import {
  canReadLibrary,
  type DraftPhoto,
  type LibraryAccess,
  onWater,
  photoWindow,
  reportEndMs,
  reportsInTimeOrder,
  sameDayWindow,
  selectedValues,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Image, Linking, Pressable, ScrollView } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { deleteDraftPhotoFiles, isPersistedUri, persistDraftPhoto } from '../../lib/draftPhotos';
import { getTrack } from '../../lib/draftStore';
import { setHazardPrefill } from '../../lib/hazardPrefill';
import { getPicks, openLibraryGridRequest, setPicks, usePicks } from '../../lib/libraryPicks';
import {
  askLibraryAccess,
  chooseMorePhotos,
  type LibraryItem,
  libraryPhotos,
  onLibraryChange,
  READS_LIBRARY,
  readLibraryAccess,
  readLibraryPhoto,
} from '../../lib/photoLibrary';
import { toDraftPhoto } from '../../lib/sheetPhotos';
import { useSheet } from '../../lib/sheetStore';
import { pickPhotos } from '../photoPipeline';
import { LakeMap } from './LakeMap';
import { SheetChip } from './SheetChip';
import { QuestionBlock, SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';

/** How many of the library's photos the reel shows before *same day* widens it. */
const REEL_MAX = 30;

/**
 * *Photos* (A10 §8): **Photos from your skate** on iOS — the library queried for the skate's window
 * (the end time, and the start when there is one, padded; *same day* as the wider option), each a
 * tap to include — and the system picker on both phones. Nothing asks for the library until the
 * person reaches for it (A10-8, D207): the permission's state is read without a prompt, and the
 * prompt is a tap on *Show photos from your skate*. Android reads no library at all; its picker
 * already shows Google Photos. Nothing leaves the roll and nothing uploads until Post. An
 * included photo carries its capture time and its location, read on device; one on the lake is
 * placed by it, one with no location on a Report opened from a recording is placed where the track
 * was when the shutter fired, and any other can be placed by a tap on the lake. *This is a hazard*
 * hands the photo and its location to the map's capture.
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
  const [reel, setReel] = useState<LibraryItem[] | null>(null);
  const [reelState, setReelState] = useState<'idle' | 'loading' | 'none' | 'failed'>('idle');
  const [access, setAccess] = useState<LibraryAccess | null>(READS_LIBRARY ? null : 'none');
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

  // The permission's state, read without a prompt — and read again on the way back from Settings.
  useEffect(() => {
    if (!READS_LIBRARY) return;
    let live = true;
    const read = () => void readLibraryAccess().then((a) => live && setAccess(a));
    read();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') read();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  const loadReel = useCallback(async () => {
    if (!window) return;
    setReelState('loading');
    try {
      const { photos } = await libraryPhotos(window, { offset: 0, limit: REEL_MAX });
      setReel(photos);
      setReelState(photos.length === 0 ? 'none' : 'idle');
    } catch {
      // Said as a failure, never as an empty roll (A10-7's reel read a throw as "no photos").
      setReel(null);
      setReelState('failed');
    }
  }, [window]);
  const readable = access !== null && canReadLibrary(access);
  useEffect(() => {
    if (readable && window && !sheet.collapsed.photos) void loadReel();
  }, [readable, window, loadReel, sheet.collapsed.photos]);

  /** The one prompt, from the person's tap. */
  const askForLibrary = async () => {
    setError(null);
    try {
      setAccess(await askLibraryAccess());
    } catch {
      setError("Couldn't ask for your photos — try again.");
    }
  };
  const chooseMore = async () => {
    try {
      await chooseMorePhotos();
    } catch {
      setError("Couldn't open the photo chooser — try again.");
    }
  };
  // What was shared changes after *Choose more* returns (the system sheet has no completion): the
  // library says so, and the reel reads again.
  useEffect(() => {
    if (access !== 'limited') return;
    return onLibraryChange(() => void loadReel());
  }, [access, loadReel]);

  /** The recorded track's points, for placing an undated-location photo where the skater was. */
  const trackPoints = useMemo(() => {
    if (report.trackDraftId === undefined) return [];
    return (getTrack(report.trackDraftId)?.points ?? []).map((p) => ({
      lat: p.lat,
      lng: p.lng,
      timestamp: p.t,
    }));
  }, [report.trackDraftId]);

  /** Turn a library photo into a draft photo: read on device, files copied out of the roll. */
  const include = async (item: LibraryItem) => {
    setError(null);
    setBusy(true);
    try {
      const asset = await readLibraryPhoto(item.assetId);
      const draft = await toDraftPhoto(
        { ...asset, creationTime: asset.creationTime ?? item.takenAtMs },
        { outline, track: trackPoints },
      );
      setReport((r) => ({ ...r, photos: [...r.photos, draft] }));
      setIncludedAsset(item.assetId, draft.id);
    } catch {
      setError("Couldn't read that photo from your library.");
    } finally {
      setBusy(false);
    }
  };
  // Which library photo became which draft — shared with the grid, so a second tap on either
  // removes rather than re-adds.
  const assetToDraft = usePicks(report.id);
  // Read at write time, not from the render: the grid may have written picks while a read awaited.
  const setIncludedAsset = (assetId: string, draftId: string) =>
    setPicks(report.id, { ...getPicks(report.id), [assetId]: draftId });

  /** *See all* (iOS): the full-screen grid, for the skate or the day (§8.5). */
  const post = useSheet();
  const openGrid = () => {
    const activity =
      endMs !== undefined ? { startMs: startMs ?? endMs - 2 * 3600_000, endMs } : null;
    const now = Date.now();
    const others = (post ? reportsInTimeOrder(post) : []).flatMap((r, i) => {
      const e = r.id === report.id ? undefined : reportEndMs(r);
      if (e === undefined) return [];
      const s = r.sheet.scalars.skateStartTime;
      return [{ number: i + 1, ...(s !== undefined ? { startMs: s } : {}), endMs: e }];
    });
    openLibraryGridRequest({
      reportId: report.id,
      timeZone,
      skate: activity,
      skateWindow: activity ? photoWindow(activity) : null,
      dayWindow: sameDayWindow(activity ?? { startMs: now, endMs: now }, timeZone),
      others,
      outline,
      track: trackPoints,
    });
    router.push('/photo-library');
  };

  /** The system picker: no permission on either phone, and Google Photos is in it on Android. */
  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const assets = await pickPhotos();
      if (assets.length === 0) return;
      // Each on its own: one that will not read costs itself, and what landed stays (its files are
      // already copied for the draft).
      const settled = await Promise.allSettled(
        assets.map((asset) => toDraftPhoto(asset, { outline, track: trackPoints })),
      );
      const drafts: DraftPhoto[] = settled.flatMap((s) =>
        s.status === 'fulfilled' ? [s.value] : [],
      );
      if (drafts.length > 0) setReport((r) => ({ ...r, photos: [...r.photos, ...drafts] }));
      const missed = settled.length - drafts.length;
      if (missed > 0) {
        setError(
          missed === 1
            ? "One photo couldn't be read. The rest were added."
            : `${missed} photos couldn't be read. The rest were added.`,
        );
      }
    } catch {
      setError("Couldn't add those photos — try again.");
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
      {/* The reel (iOS): the library, for the skate's window — asked for only from a tap. */}
      {READS_LIBRARY && !editing && window && access !== null ? (
        <YStack gap="$2">
          <SubLabel>
            From your skate · {clock(window.startMs)}–{clock(window.endMs)}
            {readable && reel ? ` · ${reel.length} found` : ''}
          </SubLabel>
          {access === 'ask' ? (
            <>
              <Button size="$2" alignSelf="flex-start" onPress={() => void askForLibrary()}>
                Show photos from your skate
              </Button>
              <SheetHint>
                Gli looks for the photos you took during these hours. Nothing is uploaded until you
                post.
              </SheetHint>
            </>
          ) : access === 'settings' ? (
            <>
              <SheetHint>
                Photo access is off for Gli. Turn it on in Settings to see them here.
              </SheetHint>
              <Button size="$2" alignSelf="flex-start" onPress={() => void Linking.openSettings()}>
                Open Settings
              </Button>
            </>
          ) : reelState === 'none' ? (
            <SheetHint>
              {wide ? 'No photos on your phone from that day.' : 'No photos from those hours.'}
            </SheetHint>
          ) : reelState === 'failed' ? (
            <SheetHint>Couldn't read your library just now.</SheetHint>
          ) : null}
          {readable ? (
            <XStack gap="$2" flexWrap="wrap">
              <SheetChip
                compact
                label={wide ? 'Just the skate' : 'The whole day'}
                onPress={() => setWide((w) => !w)}
              />
              <SheetChip compact label="See all" onPress={openGrid} />
              {access === 'limited' ? (
                <SheetChip compact label="Choose more" onPress={() => void chooseMore()} />
              ) : null}
            </XStack>
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
              </XStack>
            </ScrollView>
          ) : null}
          {reel && reel.length > 0 ? (
            <SheetHint>
              Tap to include. Nothing leaves your camera roll. A blue corner means it's placed on
              the lake from its own location.
            </SheetHint>
          ) : null}
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
        {busy ? 'Adding…' : READS_LIBRARY ? '+ Choose photos' : '+ Add photos'}
      </Button>
      {!READS_LIBRARY && !editing && count === 0 ? (
        <SheetHint>Opens your phone's photo picker. Your Google Photos are in it too.</SheetHint>
      ) : null}
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
