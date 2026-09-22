import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Paragraph, Spinner, YStack } from 'tamagui';
import { ReportSheet } from '../../src/components/sheet/ReportSheet';
import { saveSheetAsDraft } from '../../src/lib/sheetActions';
import {
  type DoorParams,
  doorHref,
  doorKey,
  locateTabSheet,
  openDoor,
} from '../../src/lib/sheetDoors';
import { getSheet, setSheet, updateSheet } from '../../src/lib/sheetStore';

/**
 * The center "＋ Report" tab (D28) — **the report sheet is the page** (A10-3, founder call
 * 2026-09-21): no overview, no second tap. Every door lands here with its params
 * (`sheetDoors.ts`): a lake's drawer, a finished recording, an unreported skate, a draft, a
 * published Report to edit; the tab alone opens on the lake under your feet, or with the picker.
 * Drafts and *Waiting to send* are separate screens behind the sheet's header buttons.
 *
 * The sheet's state lives in `sheetStore`, not here, so leaving for the map (*mark one here*) and
 * coming back finds it as it was. A door only opens a new sheet when it is a *different* door
 * from the one open — returning to the tab never wipes a half-written report. Every navigate to a
 * door carries its own stamp (`doorHref`'s `at`), because the tab keeps its last params: without
 * it, the same lake's *Add a report* after a Post would be the door already consumed, and the
 * focus path below would open the tab's own door in its place.
 */
export default function ReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams() as DoorParams;
  const profile = useQuery(api.profiles.current, {});
  const [state, setState] = useState<'opening' | 'open' | 'gone'>(getSheet() ? 'open' : 'opening');
  const openedFor = useRef<string | null>(getSheet() ? '' : null);
  const key = doorKey(params);
  // The door's params, read inside the effect through a ref: the effect keys on the door, and the
  // params object is a new identity every render.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (profile === undefined) return;
    // A door already open, or the tab revisited with the sheet still there: leave it.
    if (openedFor.current === key && getSheet() !== null) return;
    if (openedFor.current !== null && key === '' && getSheet() !== null) return;
    let cancelled = false;
    openedFor.current = key;
    setState('opening');
    // A half-written sheet a new door would replace goes to Drafts first — a skater must never face
    // "finish now or lose it", least of all by tapping a lake.
    const current = getSheet();
    const parked =
      current?.dirty && current.mode.kind === 'create'
        ? saveSheetAsDraft(current, Date.now()).catch(() => null)
        : Promise.resolve(null);
    void parked
      .then(() => openDoor(paramsRef.current, profile?.showPutInDefault, Date.now()))
      .then((sheet) => {
        if (cancelled) return;
        if (sheet === null) {
          setState('gone');
          return;
        }
        setSheet(sheet);
        setState('open');
        // The tab's own door: the lake under your feet arrives after the sheet, never before it.
        if (sheet.door === 'page') void locateTabSheet(sheet.draftId, getSheet, updateSheet);
      });
    return () => {
      cancelled = true;
    };
  }, [key, profile]);

  // Coming back from the map with the sheet closed by Post: start fresh on the tab's own door.
  useFocusEffect(
    useCallback(() => {
      if (getSheet() === null && state === 'open') {
        openedFor.current = null;
        setState('opening');
        void openDoor({}, profile?.showPutInDefault, Date.now()).then((sheet) => {
          if (sheet) setSheet(sheet);
          setState(sheet ? 'open' : 'gone');
          if (sheet) void locateTabSheet(sheet.draftId, getSheet, updateSheet);
        });
      }
    }, [state, profile?.showPutInDefault]),
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      {state === 'gone' ? (
        <YStack flex={1} alignItems="center" justifyContent="center" gap="$3" padding="$4">
          <Paragraph color="$foregroundMuted">That report is no longer available.</Paragraph>
          <Button onPress={() => router.navigate(doorHref({}))}>Start a new one</Button>
        </YStack>
      ) : state === 'opening' && getSheet() === null ? (
        <YStack flex={1} alignItems="center" justifyContent="center" gap="$3">
          <Spinner color="$primary" />
          <Paragraph color="$foregroundMuted">Opening your sheet…</Paragraph>
        </YStack>
      ) : (
        <ReportSheet
          onDone={() => {
            openedFor.current = null;
          }}
        />
      )}
    </SafeAreaView>
  );
}
