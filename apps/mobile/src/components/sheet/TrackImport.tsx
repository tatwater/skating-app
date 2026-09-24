import { useNetInfo } from '@react-native-community/netinfo';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { gpxSizeRefusal, planGpxImport, updateReport } from '@skating/core';
import { useMutation } from 'convex/react';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { updateSheet } from '../../lib/sheetStore';
import { SheetHint } from './SheetSection';
import type { SectionProps } from './sectionProps';

/**
 * The track's call to action when the app did not record (A10-7, founder call 2026-09-23):
 * **Upload a GPX file** — Strava, Garmin and most watches export one — parsed on the phone
 * (`parseGpx`), cleaned like a recording (`processTrack`), ingested as an activity
 * (`gpsActivities.ingestTrack`, which resolves the lake and its bays), and linked to this Report
 * with its start and end stamped exactly (`gps`). Online only: the activity is a server row.
 * Nothing is pulled from any platform — the Strava connection is write-only by decision, and a
 * file the author chose is the author's.
 */
export function TrackImport({
  report,
  body,
  dispatch,
}: Pick<SectionProps, 'report' | 'body' | 'dispatch'>) {
  const ingest = useMutation(api.gpsActivities.ingestTrack);
  const offline = useNetInfo().isConnected === false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const importGpx = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/gpx+xml', 'application/xml', 'text/xml', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (!asset?.uri) return;
      const file = new File(asset.uri);
      // Refused before it is read: the parse runs on the JS thread. The picker's size, else the
      // cached copy's own.
      const tooBig = gpxSizeRefusal(asset.size ?? file.size ?? undefined);
      if (tooBig) {
        setError(tooBig);
        return;
      }
      const plan = planGpxImport(await file.text(), report.id);
      if (!plan.ok) {
        setError(plan.message);
        return;
      }
      const { idempotencyKey, path, startTime, endTime, elapsedSeconds } = plan;
      const activityId = await ingest({
        idempotencyKey,
        path,
        startTime,
        endTime,
        elapsedSeconds,
        ...(body?.waterBodyId !== undefined
          ? { waterBodyId: body.waterBodyId as Id<'waterBodies'> }
          : {}),
      });
      updateSheet((p) =>
        updateReport(p, report.id, (r) => ({ ...r, activityId: activityId as string })),
      );
      dispatch({
        type: 'select',
        field: 'endTime',
        key: 'gps',
        value: { ms: endTime, precision: 'gps' },
      });
      dispatch({ type: 'setScalar', key: 'skateStartTime', value: startTime });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <XStack>
        <XStack
          height={32}
          paddingHorizontal={12}
          alignItems="center"
          borderRadius="$xs"
          borderWidth={1}
          borderColor="$foreground"
          onPress={() => setOpen((o) => !o)}
          pressStyle={{ opacity: 0.7 }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
        >
          <Text
            color="$foreground"
            fontSize={12}
            fontWeight="700"
            letterSpacing={0.8}
            textTransform="uppercase"
          >
            {busy ? 'Reading the track…' : '+ Add your track'}
          </Text>
        </XStack>
      </XStack>
      {open ? (
        <YStack
          gap="$2"
          padding={10}
          borderWidth={1}
          borderColor="$border"
          borderRadius="$xs"
          backgroundColor="$background"
        >
          <XStack
            height={36}
            paddingHorizontal={12}
            alignItems="center"
            borderRadius="$xs"
            backgroundColor="$foreground"
            opacity={offline || busy ? 0.5 : 1}
            onPress={offline || busy ? undefined : () => void importGpx()}
            pressStyle={{ opacity: 0.7 }}
            accessibilityRole="button"
            accessibilityLabel="Upload a GPX file"
          >
            <Text color="$background" fontSize={13} fontWeight="700">
              Upload a GPX file
            </Text>
          </XStack>
          <SheetHint>
            Sets your start and end exactly, and draws the skate on the lake. From Strava: open the
            activity, ⋯ → Export GPX. Garmin, Coros and most watches export one too. Nothing is
            pulled from any account.{offline ? ' Needs signal.' : ''}
          </SheetHint>
        </YStack>
      ) : null}
      {error ? (
        <Text color="$danger" fontSize={12}>
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}
