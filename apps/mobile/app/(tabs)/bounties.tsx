import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { H1, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import { expiryLabel } from '../../src/components/BountyList';
import { Badge } from '../../src/components/detailUi';
import { TrustAvatar } from '../../src/components/TrustDisplay';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  fulfilled: 'Fulfilled',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** "3.2 mi away" — a browse row's distance when `listOpen` was asked to sort by proximity. */
function distanceLabel(meters: number): string {
  const miles = meters / 1609.344;
  return miles < 0.1 ? 'nearby' : `${miles.toFixed(miles < 10 ? 1 : 0)} mi away`;
}

/**
 * Bounties tab (D10/D17) — "ask for fresh eyes on a lake, or go earn some." Two lists: a browse of open
 * bounties and the caller's own bounties across every status (`bounties.myBounties`). Each row opens the
 * shared `/bounty/[id]` detail (a bottom-sheet over the map). Posting lives on the water-body drawer, where
 * the lake is in hand; this tab is the browse/track surface.
 *
 * **Proximity sort.** If foreground location is **already** granted (the map / on-ice flows prompt for it
 * on first launch, so it usually is), we take a one-shot fix and sort by true current distance, showing
 * `X mi away` per row. We deliberately **never prompt from this tab** — an ungranted / denied user simply
 * gets `sortByHome`, where the server sorts by their *private* home coord without ever returning it or an
 * exact distance (D11), falling back to newest-first when no home is set.
 */
export default function BountiesScreen() {
  const router = useRouter();
  const [coord, setCoord] = useState<{ lat: number; lng: number } | null>(null);

  // Reuse an already-granted foreground permission; never prompt from the browse tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') return; // fall back to sortByHome — no prompt here
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!cancelled) setCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch {
        // Location unavailable — keep the home-sort fallback below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const open = useQuery(api.bounties.listOpen, coord ? { near: coord } : { sortByHome: true });
  const mine = useQuery(api.bounties.myBounties, {});
  const now = Date.now();

  const openDetail = (id: string) => router.navigate({ pathname: '/bounty/[id]', params: { id } });

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView>
        <YStack flex={1} gap="$4" padding="$4" backgroundColor="$background">
          <H1 color="$foreground">Bounties</H1>
          <Paragraph color="$foregroundMuted">
            A bounty asks recent skaters to check a lake and post a fresh report. Post one from a
            lake's page; fulfill one by skating and reporting.
          </Paragraph>

          <YStack gap="$2">
            <Text
              color="$foregroundMuted"
              fontSize={11}
              letterSpacing={1.5}
              textTransform="uppercase"
            >
              Open bounties
            </Text>
            {open === undefined ? (
              <YStack padding="$4" alignItems="center">
                <Spinner color="$primary" />
              </YStack>
            ) : open.length === 0 ? (
              <Paragraph color="$foregroundMuted">
                No open bounties right now. Post one from a lake to ask for a fresh report.
              </Paragraph>
            ) : (
              open.map((b) => (
                <XStack
                  key={b._id}
                  gap="$2"
                  alignItems="center"
                  padding="$3"
                  borderWidth={1}
                  borderColor="$border"
                  borderRadius="$4"
                  backgroundColor="$surface"
                  pressStyle={{ backgroundColor: '$surfaceMuted' }}
                  onPress={() => openDetail(b._id)}
                >
                  <TrustAvatar
                    displayName={b.requester.displayName}
                    trustClass={b.requester.trustClass}
                    size={28}
                  />
                  <YStack flex={1}>
                    <Text color="$foreground" numberOfLines={1}>
                      {b.waterBodyName}
                    </Text>
                    <Text color="$foregroundMuted" fontSize={12}>
                      by {b.requester.displayName}
                      {b.distanceMeters !== undefined
                        ? ` · ${distanceLabel(b.distanceMeters)}`
                        : ''}
                      {b.fulfillingCount > 0
                        ? ` · ${b.fulfillingCount} candidate${b.fulfillingCount === 1 ? '' : 's'}`
                        : ''}
                      {' · '}
                      {expiryLabel(b.expiresAt, now)}
                    </Text>
                  </YStack>
                  <Badge tone="solid">{b.rewardPoints} pts</Badge>
                </XStack>
              ))
            )}
          </YStack>

          {mine && mine.length > 0 ? (
            <YStack gap="$2">
              <Text
                color="$foregroundMuted"
                fontSize={11}
                letterSpacing={1.5}
                textTransform="uppercase"
              >
                My bounties
              </Text>
              {mine.map((b) => (
                <XStack
                  key={b._id}
                  gap="$2"
                  alignItems="center"
                  padding="$3"
                  borderWidth={1}
                  borderColor="$border"
                  borderRadius="$4"
                  backgroundColor="$surface"
                  pressStyle={{ backgroundColor: '$surfaceMuted' }}
                  onPress={() => openDetail(b._id)}
                >
                  <YStack flex={1}>
                    <Text color="$foreground">
                      {STATUS_LABEL[b.status] ?? b.status}
                      {b.status === 'open' ? ` · ${expiryLabel(b.expiresAt, now)}` : ''}
                    </Text>
                    <Text color="$foregroundMuted" fontSize={12}>
                      {b.fulfillingReportIds.length > 0
                        ? `${b.fulfillingReportIds.length} candidate report${
                            b.fulfillingReportIds.length === 1 ? '' : 's'
                          }`
                        : 'No reports yet'}
                    </Text>
                  </YStack>
                  <Badge tone="solid">{b.rewardPoints} pts</Badge>
                </XStack>
              ))}
            </YStack>
          ) : null}
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}
