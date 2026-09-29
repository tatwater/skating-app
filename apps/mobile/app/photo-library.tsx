import { type GridHour, libraryGrid, photoIdsInWindow, updateReport } from '@skating/core';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Image,
  Modal,
  Pressable,
  SectionList,
  type SectionListRenderItem,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import { SheetChip } from '../src/components/sheet/SheetChip';
import { deleteDraftPhotoFiles, isPersistedUri } from '../src/lib/draftPhotos';
import { getLibraryGridRequest, getPicks, setPicks } from '../src/lib/libraryPicks';
import {
  allLibraryPhotos,
  type LibraryItem,
  libraryPhotos,
  readLibraryPhoto,
} from '../src/lib/photoLibrary';
import { toDraftPhoto } from '../src/lib/sheetPhotos';
import { getSheet, updateSheet } from '../src/lib/sheetStore';

/** A page of the library, three columns deep. */
const PAGE = 90;
const COLUMNS = 3;
/**
 * *Select all from the skate* pages through the skate's window — bounded, a skate is hours; past the
 * bound it says so rather than stopping quietly.
 */
const SKATE_MAX = 2_000;

type GridPhoto = LibraryItem & { id: string };
type Row = GridPhoto[];

/**
 * The library grid (A10-8 §8.5, iOS only — Android reads no library, D207): the phone's photos for
 * the skate or the whole day, three columns under a sticky header per local hour. The hours the
 * skate covers carry an ice rail; another Report's hours carry its number. A tap selects, a long
 * press shows the photo full size, and *Add* reads only the chosen photos (their time and location,
 * on device) onto the Report the grid was opened from. What was already included opens checked;
 * unchecking it removes it on *Add*.
 */
export default function PhotoLibraryScreen() {
  const router = useRouter();
  const request = useMemo(() => getLibraryGridRequest(), []);
  const [scope, setScope] = useState<'skate' | 'day'>(request?.skateWindow ? 'skate' : 'day');
  const window = request ? (scope === 'skate' ? request.skateWindow : request.dayWindow) : null;
  const [items, setItems] = useState<GridPhoto[]>([]);
  // Rows the library returned so far — the next page's offset (tiles that would not draw included).
  const scanned = useRef(0);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<GridPhoto | null>(null);
  const [missed, setMissed] = useState(0);
  const [capped, setCapped] = useState(false);
  // What is on the Report now, by asset — those open checked.
  const readIncluded = useCallback((): Record<string, string> => {
    if (!request) return {};
    const report = getSheet()?.reports.find((r) => r.id === request.reportId);
    const onReport = new Set(report?.photos.map((p) => p.id));
    return Object.fromEntries(
      Object.entries(getPicks(request.reportId)).filter(([, draftId]) => onReport.has(draftId)),
    );
  }, [request]);
  const [included, setIncluded] = useState<Record<string, string>>(readIncluded);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(Object.keys(included)),
  );
  const loadId = useRef(0);

  const loadMore = useCallback(
    async (reset: boolean) => {
      if (!window) return;
      const id = reset ? ++loadId.current : loadId.current;
      setLoading(true);
      setFailed(false);
      try {
        const offset = reset ? 0 : scanned.current;
        const page = await libraryPhotos(window, { offset, limit: PAGE });
        if (id !== loadId.current) return;
        scanned.current = offset + page.scanned;
        const tagged = page.photos.map((p) => ({ ...p, id: p.assetId }));
        setItems((prev) => (reset ? tagged : [...prev, ...tagged]));
        setExhausted(page.scanned < PAGE);
      } catch {
        if (id === loadId.current) setFailed(true);
      } finally {
        if (id === loadId.current) setLoading(false);
      }
    },
    [window],
  );
  // A new scope is a new list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads on the scope's window only.
  useEffect(() => {
    setItems([]);
    setExhausted(false);
    void loadMore(true);
  }, [window]);

  const sections = useMemo(() => {
    if (!request) return [];
    return libraryGrid(items, {
      timeZone: request.timeZone,
      skate: request.skate,
      others: request.others,
    }).map((hour) => ({ hour, data: chunk(hour.photos, COLUMNS) }));
  }, [items, request]);

  const toggle = (assetId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });

  const selectSkate = async () => {
    if (!request?.skateWindow) return;
    try {
      const skate = await allLibraryPhotos(request.skateWindow, SKATE_MAX);
      const ids = photoIdsInWindow(
        skate.photos.map((p) => ({ id: p.assetId, takenAtMs: p.takenAtMs })),
        request.skateWindow,
      );
      setSelected((s) => new Set([...s, ...ids]));
      setCapped(!skate.complete);
    } catch {
      setFailed(true);
    }
  };

  const toAdd = [...selected].filter((id) => included[id] === undefined);
  const toRemove = Object.keys(included).filter((id) => !selected.has(id));

  const apply = async () => {
    if (!request) return;
    setAdding(true);
    try {
      // Each photo on its own: one that will not read (an iCloud original with no signal) is
      // counted and left out, not the reason the rest are.
      const added: { assetId: string; draft: Awaited<ReturnType<typeof toDraftPhoto>> }[] = [];
      let missed = 0;
      for (const assetId of toAdd) {
        try {
          const asset = await readLibraryPhoto(assetId);
          added.push({
            assetId,
            draft: await toDraftPhoto(asset, { outline: request.outline, track: request.track }),
          });
        } catch {
          missed += 1;
        }
      }
      const removedDrafts = new Set(toRemove.map((id) => included[id] as string));
      // A removed photo owns its copied files; drop them with it, as the Photos section does.
      const gone = (
        getSheet()?.reports.find((r) => r.id === request.reportId)?.photos ?? []
      ).filter((p) => removedDrafts.has(p.id));
      updateSheet((post) =>
        updateReport(post, request.reportId, (r) => ({
          ...r,
          photos: [
            ...r.photos.filter((p) => !removedDrafts.has(p.id)),
            ...added.map((a) => a.draft),
          ],
        })),
      );
      const files = gone.flatMap((p) => [p.fullUri, p.thumbUri]).filter(isPersistedUri);
      if (files.length > 0) deleteDraftPhotoFiles(files);
      const nextPicks = { ...getPicks(request.reportId) };
      for (const id of toRemove) delete nextPicks[id];
      for (const a of added) nextPicks[a.assetId] = a.draft.id;
      setPicks(request.reportId, nextPicks);
      if (missed > 0) {
        // Stay, saying so: what landed is now what is included.
        const now = readIncluded();
        setMissed(missed);
        setIncluded(now);
        setSelected(new Set(Object.keys(now)));
        return;
      }
      router.back();
    } catch {
      setFailed(true);
    } finally {
      setAdding(false);
    }
  };

  if (!request) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <YStack flex={1} alignItems="center" justifyContent="center" gap="$3" padding="$4">
          <Paragraph color="$foregroundMuted">Open your photos from a report's Photos.</Paragraph>
          <Button onPress={() => router.back()}>Back</Button>
        </YStack>
      </SafeAreaView>
    );
  }

  const size = Math.floor(Dimensions.get('window').width / COLUMNS);
  const renderRow: SectionListRenderItem<Row, { hour: GridHour<GridPhoto> }> = ({ item }) => (
    <XStack>
      {item.map((photo) => {
        const on = selected.has(photo.assetId);
        return (
          <Pressable
            key={photo.assetId}
            onPress={() => toggle(photo.assetId)}
            onLongPress={() => setPreview(photo)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`Photo from ${clock(photo.takenAtMs, request.timeZone)}`}
          >
            <YStack width={size} height={size} padding={1}>
              <Image source={{ uri: photo.uri }} style={{ flex: 1 }} />
              <YStack
                position="absolute"
                left={6}
                top={6}
                width={20}
                height={20}
                borderWidth={1}
                borderRadius="$xs"
                borderColor={on ? '$foreground' : '$borderStrong'}
                backgroundColor={on ? '$foreground' : '$background'}
                alignItems="center"
                justifyContent="center"
              >
                {on ? (
                  <Text color="$background" fontSize={13} fontWeight="700" lineHeight={16}>
                    ✓
                  </Text>
                ) : null}
              </YStack>
            </YStack>
          </Pressable>
        );
      })}
    </XStack>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack flex={1} backgroundColor="$background">
        <XStack alignItems="center" justifyContent="space-between" padding="$3" gap="$2">
          <Button size="$2" chromeless onPress={() => router.back()}>
            Cancel
          </Button>
          <XStack gap="$1">
            {request.skateWindow ? (
              <SheetChip
                compact
                label="The skate"
                tier={scope === 'skate' ? 'solid' : undefined}
                onPress={() => setScope('skate')}
              />
            ) : null}
            <SheetChip
              compact
              label="The whole day"
              tier={scope === 'day' ? 'solid' : undefined}
              onPress={() => setScope('day')}
            />
          </XStack>
        </XStack>
        {request.skateWindow ? (
          <Button
            size="$2"
            marginHorizontal="$3"
            marginBottom="$2"
            onPress={() => void selectSkate()}
          >
            Select all from the skate
          </Button>
        ) : null}
        <SectionList
          sections={sections}
          keyExtractor={(row) => row.map((p) => p.assetId).join('|')}
          renderItem={renderRow}
          renderSectionHeader={({ section }) => <HourHeader hour={section.hour} />}
          stickySectionHeadersEnabled
          onEndReached={() => {
            if (!loading && !exhausted) void loadMore(false);
          }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            loading ? null : (
              <Paragraph color="$foregroundMuted" padding="$4">
                {scope === 'skate' ? 'No photos from those hours.' : 'No photos from that day.'}
              </Paragraph>
            )
          }
          ListFooterComponent={loading ? <Spinner margin="$4" color="$primary" /> : null}
        />
        {failed ? (
          <Paragraph color="$danger" paddingHorizontal="$3">
            Couldn't read your library just now.
          </Paragraph>
        ) : null}
        {capped ? (
          <Paragraph color="$foregroundMuted" paddingHorizontal="$3">
            {`Selected the first ${SKATE_MAX.toLocaleString('en-US')} photos from the skate — choose the rest by hand.`}
          </Paragraph>
        ) : null}
        {missed > 0 ? (
          <Paragraph color="$danger" paddingHorizontal="$3">
            {missed === 1
              ? "One photo couldn't be read — it may be in iCloud only. The rest were added."
              : `${missed} photos couldn't be read — they may be in iCloud only. The rest were added.`}
          </Paragraph>
        ) : null}
        <XStack padding="$3" borderTopWidth={1} borderColor="$border">
          <Button
            flex={1}
            disabled={adding || (toAdd.length === 0 && toRemove.length === 0)}
            onPress={() => void apply()}
          >
            {adding
              ? 'Adding…'
              : toAdd.length > 0
                ? `Add ${toAdd.length}`
                : toRemove.length > 0
                  ? `Remove ${toRemove.length}`
                  : 'Add'}
          </Button>
        </XStack>
      </YStack>
      <Modal
        visible={preview !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}
      >
        <Pressable style={{ flex: 1, backgroundColor: 'black' }} onPress={() => setPreview(null)}>
          {preview ? (
            <Image source={{ uri: preview.uri }} style={{ flex: 1 }} resizeMode="contain" />
          ) : null}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

/** The hour's sticky header: its label, the ice rail for the skate, the other Reports' numbers. */
function HourHeader({ hour }: { hour: GridHour<GridPhoto> }) {
  return (
    <XStack
      backgroundColor="$background"
      alignItems="center"
      gap="$2"
      paddingVertical="$1.5"
      paddingRight="$3"
    >
      <YStack
        width={4}
        alignSelf="stretch"
        backgroundColor={hour.inSkate ? '$primary' : 'transparent'}
      />
      <Text color="$foreground" fontWeight="600" fontSize={13}>
        {hour.label}
      </Text>
      {hour.inSkate ? (
        <Text color="$primary" fontSize={11} fontWeight="600">
          SKATE
        </Text>
      ) : null}
      {hour.reports.map((n) => (
        <YStack
          key={n}
          paddingHorizontal={5}
          borderWidth={1}
          borderColor="$border"
          borderRadius="$xs"
          accessibilityLabel={`Report ${n}`}
        >
          <Text color="$foregroundMuted" fontSize={11}>
            {n}
          </Text>
        </YStack>
      ))}
    </XStack>
  );
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < list.length; i += size) rows.push(list.slice(i, i + size));
  return rows;
}

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    ms,
  );
}
