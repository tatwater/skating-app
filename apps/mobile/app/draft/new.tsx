import type { Id } from '@skating/convex/dataModel';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { Button, Paragraph, Spinner, YStack } from 'tamagui';
import { ReportForm } from '../../src/components/ReportForm';
import { resolveCachedBody } from '../../src/lib/bodyCache';

/**
 * Offline report capture (F2). Uses the device GPS to bind the report to the nearest cached lake
 * (Layer-2 auto-select); if none is cached, the draft carries just the coord and the lake is
 * resolved server-side at flush (`waterBodies.resolveBodyForCoord`). Rendered off the map, so the
 * `ReportForm` uses its no-map put-in fallback. Everything here can run with no signal.
 */
type Located =
  | { phase: 'locating' }
  | { phase: 'denied' }
  | {
      phase: 'ready';
      coord: { lat: number; lng: number };
      waterBodyId?: Id<'waterBodies'>;
      bodyName?: string;
    };

export default function NewDraftScreen() {
  const router = useRouter();
  const [state, setState] = useState<Located>({ phase: 'locating' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!cancelled) setState({ phase: 'denied' });
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      const coord = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const match = resolveCachedBody(coord);
      if (!cancelled) {
        setState({
          phase: 'ready',
          coord,
          waterBodyId: match?.waterBodyId as Id<'waterBodies'> | undefined,
          bodyName: match?.name,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === 'locating') {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        gap="$3"
        backgroundColor="$background"
      >
        <Spinner color="$primary" />
        <Paragraph color="$foregroundMuted">Finding your location…</Paragraph>
      </YStack>
    );
  }

  if (state.phase === 'denied') {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        gap="$3"
        padding="$4"
        backgroundColor="$background"
      >
        <Paragraph color="$foregroundMuted" textAlign="center">
          Location permission is needed to capture a report where you're skating.
        </Paragraph>
        <Button onPress={() => router.back()}>Back</Button>
      </YStack>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} style={{ backgroundColor: 'transparent' }}>
      <ReportForm
        coord={state.coord}
        waterBodyId={state.waterBodyId}
        bodyName={state.bodyName}
        onClose={() => router.back()}
        onSaved={() => router.back()}
      />
    </ScrollView>
  );
}
