import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  confirmRequestPrompt,
  hazardTypeLabel,
  NO_ALERT_IS_NOT_ALL_CLEAR,
  warningHeadline,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';
import { toProximityHazards } from '../lib/onIce';
import { dismissOnIceBanner, setOnIceHazards, useOnIceMode } from '../lib/onIceMode';
import { useMapSelection } from './MapSelectionContext';

/**
 * On-ice alert banner (D54 Layers 1 + 2) — the *foreground* face of on-ice alerting.
 *
 * The server never learns where anyone is (D12). It syncs hazard *data* for the lake you're on; the
 * `onIceMode` store watches the device's own GPS (published by the layout's single watcher) and
 * evaluates it locally against those cached hazards — proximity always, plus the directional "hazard
 * ahead" projection while on-ice mode is armed. So positions never leave the phone, a troll's blast
 * radius is limited to people physically on that same ice, and — once hazards are cached — alerts fire
 * with no signal. This component just *renders* the store's current banner; the pocketed-phone case
 * fires a local notification instead (same shared dedup set, so neither double-fires).
 *
 * Alerts surface as **top banners, never modals** — blocking the map of someone moving on ice is
 * unacceptable.
 *
 * ⚠ **Silence is not an all-clear.** This banner appearing means something was *reported* nearby; it
 * never appearing means nothing was reported — not that the ice is fine. The disclaimer ships *with* the
 * feature rather than buried in settings.
 */
export function HazardBanner() {
  const router = useRouter();
  const { onIceWaterBodyId } = useMapSelection();
  const confirm = useMutation(api.hazardConfirmations.confirm);
  const { banner } = useOnIceMode();

  // **No `season` argument, ever** (D63). This query looks identical to the map's, and the difference
  // is the whole point: the map answers "what did this lake look like when I choose to look", the
  // banner answers "what is near me right now". A skater standing on ice must never be alerted about
  // last winter's ridge because a sheet they opened an hour ago was browsing '24/'25 — and must never
  // *stop* being alerted about this winter's for the same reason. The server default, this season, is
  // the only correct value here, which is why `browseSeason` is deliberately not read.
  const hazards = useQuery(
    api.hazards.listForBody,
    onIceWaterBodyId ? { waterBodyId: onIceWaterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const proximityHazards = useMemo(() => toProximityHazards(hazards ?? []), [hazards]);

  // Push the lake's hazards into the shared store, which re-evaluates them against the last fix — so a
  // stationary skater whose lake finishes syncing, or near whom a hazard is freshly posted, still gets
  // the banner without waiting for a new GPS fix. Clearing to `[]` when there's no on-ice lake stops a
  // stale set from alerting after the skater leaves.
  useEffect(() => {
    setOnIceHazards(proximityHazards);
  }, [proximityHazards]);

  if (!banner) return null;

  const warning = banner.kind === 'warning';
  const ahead = banner.secondsToEncounter !== undefined;
  const headline = warning
    ? ahead
      ? `⚠ ${hazardTypeLabel(banner.type)} ~${Math.round(banner.secondsToEncounter ?? 0)} s ahead`
      : warningHeadline(banner.type, banner.distanceMeters)
    : confirmRequestPrompt(banner.type);

  return (
    <YStack
      position="absolute"
      top={0}
      left={0}
      right={0}
      zIndex={50}
      backgroundColor={warning ? '$danger' : '$warning'}
      paddingTop="$6"
      paddingHorizontal="$3"
      paddingBottom="$3"
      gap="$2"
      // A proximity warning a screen-reader user is never *told* about is no warning at all. Announce
      // it the moment it mounts (`assertive` interrupts, which is proportionate for on-ice danger).
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text color={warning ? '$dangerForeground' : '$warningForeground'} fontWeight="700">
        {headline}
      </Text>

      {warning ? (
        <XStack gap="$2">
          <Button
            size="$3"
            flex={1}
            onPress={() => {
              dismissOnIceBanner();
              router.navigate({ pathname: '/hazard/[id]', params: { id: banner.hazardId } });
            }}
          >
            Show me
          </Button>
          <Button size="$3" chromeless onPress={dismissOnIceBanner}>
            Dismiss
          </Button>
        </XStack>
      ) : (
        // The gate IS the confirmation: answering this prompt is how an unconfirmed hazard collects
        // the confirmation it needs. One tap, no navigation.
        <XStack gap="$2">
          <Button
            size="$3"
            flex={1}
            onPress={async () => {
              dismissOnIceBanner();
              try {
                await confirm({
                  hazardId: banner.hazardId as Id<'hazards'>,
                  verdict: 'still_there',
                  via: 'proximity_alert',
                });
              } catch {
                // A failed confirmation is not worth interrupting someone on ice over.
              }
            }}
          >
            Yes, it’s there
          </Button>
          {/* "I can't see it" is NOT "fully healed & safe" — whiteout, snow cover and a hidden folded
              ridge all look identical to not-seeing-it. So this opens the three-tier control and
              clears nothing on its own (D3). */}
          <Button
            size="$3"
            flex={1}
            onPress={() => {
              dismissOnIceBanner();
              router.navigate({ pathname: '/hazard/[id]', params: { id: banner.hazardId } });
            }}
          >
            Not seeing it
          </Button>
        </XStack>
      )}

      <Paragraph
        color={warning ? '$dangerForeground' : '$warningForeground'}
        fontSize={11}
        opacity={0.9}
      >
        {hazardTypeLabel(banner.type)} · {NO_ALERT_IS_NOT_ALL_CLEAR}
      </Paragraph>
    </YStack>
  );
}
