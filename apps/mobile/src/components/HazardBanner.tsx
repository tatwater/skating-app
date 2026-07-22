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
import { useEffect, useMemo, useState } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';
import {
  type AlertSession,
  advanceAlertSession,
  dismissBanner,
  emptyAlertSession,
  toProximityHazards,
} from '../lib/onIce';
import { useMapSelection } from './MapSelectionContext';

/**
 * On-ice proximity alerts (D54 Layer 1) — **foreground-only in v1** (build-kickoff call 4).
 *
 * The server never learns where anyone is (D12). It syncs hazard *data* for the lake you're on; this
 * component watches the device's own GPS and evaluates it locally against those cached hazards. So
 * positions never leave the phone, a troll's blast radius is limited to people physically on that
 * same ice, and — once the hazards are cached — the alert fires with no signal.
 *
 * Alerts surface as **top banners, never modals**. Blocking the map of someone moving on ice is
 * unacceptable, so there is no dialog anywhere in this path.
 *
 * ⚠ **Silence is not an all-clear.** This banner appearing means something was *reported* nearby; it
 * never appearing means nothing was reported — not that the ice is fine. In v1 the watcher only runs
 * while the app is foregrounded, which makes that even weaker, so the disclaimer ships *with* the
 * feature rather than buried in settings.
 */
export function HazardBanner() {
  const router = useRouter();
  const { onIceWaterBodyId, onIceCoord } = useMapSelection();
  const confirm = useMutation(api.hazardConfirmations.confirm);
  const [session, setSession] = useState<AlertSession>(emptyAlertSession);

  const hazards = useQuery(
    api.hazards.listForBody,
    onIceWaterBodyId ? { waterBodyId: onIceWaterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const proximityHazards = useMemo(() => toProximityHazards(hazards ?? []), [hazards]);

  // No GPS watcher of its own — the layout owns the single watcher and publishes each fix as
  // `onIceCoord`, so proximity is evaluated here off that shared coord. One subscription for the whole
  // on-ice experience; `advanceAlertSession` keeps a showing banner from being swapped out from under a
  // moving skater and dedups per session (unit-tested in `onIce.ts`), so it's safe to run on either
  // trigger. Re-evaluate on BOTH a new fix AND a change to the cached hazard set: a stationary skater
  // (no new fixes) whose lake finishes syncing, or near whom a hazard is freshly posted, must still get
  // the banner — evaluated against their latest known coord (the effect closes over the current
  // `onIceCoord` on every run).
  useEffect(() => {
    if (!onIceCoord) return;
    setSession((prev) => advanceAlertSession(prev, onIceCoord, proximityHazards));
  }, [onIceCoord, proximityHazards]);

  const banner = session.banner;
  if (!banner) return null;

  const warning = banner.kind === 'warning';

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
        {warning
          ? warningHeadline(banner.type, banner.distanceMeters)
          : confirmRequestPrompt(banner.type)}
      </Text>

      {warning ? (
        <XStack gap="$2">
          <Button
            size="$3"
            flex={1}
            onPress={() => {
              setSession(dismissBanner);
              router.navigate({ pathname: '/hazard/[id]', params: { id: banner.hazardId } });
            }}
          >
            Show me
          </Button>
          <Button size="$3" chromeless onPress={() => setSession(dismissBanner)}>
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
              setSession(dismissBanner);
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
              setSession(dismissBanner);
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
