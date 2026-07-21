import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  confirmRequestPrompt,
  hazardTypeLabel,
  NO_ALERT_IS_NOT_ALL_CLEAR,
  warningHeadline,
} from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import * as Location from 'expo-location'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui'
import {
  type AlertSession,
  advanceAlertSession,
  dismissBanner,
  emptyAlertSession,
  toProximityHazards,
} from '../lib/onIce'
import { useMapSelection } from './MapSelectionContext'

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
  const router = useRouter()
  const { onIceWaterBodyId } = useMapSelection()
  const confirm = useMutation(api.hazardConfirmations.confirm)
  const [session, setSession] = useState<AlertSession>(emptyAlertSession)

  const hazards = useQuery(
    api.hazards.listForBody,
    onIceWaterBodyId ? { waterBodyId: onIceWaterBodyId as Id<'waterBodies'> } : 'skip',
  )
  const proximityHazards = useMemo(() => toProximityHazards(hazards ?? []), [hazards])

  // The watcher reads the latest hazard set without being torn down and restarted on every data
  // update — restarting a GPS subscription mid-skate would drop fixes exactly when they matter.
  const hazardsRef = useRef(proximityHazards)
  hazardsRef.current = proximityHazards

  useEffect(() => {
    if (!onIceWaterBodyId) return
    let subscription: Location.LocationSubscription | null = null
    let cancelled = false
    ;(async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync()
        if (status !== 'granted' || cancelled) return
        subscription = await Location.watchPositionAsync(
          // Balanced accuracy and a 20 m step: enough to catch an approach, cheap enough not to cook
          // a cold battery, which is the phone state this feature actually runs in.
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 20 },
          (pos) => {
            const coord = { lat: pos.coords.latitude, lng: pos.coords.longitude }
            setSession((prev) => advanceAlertSession(prev, coord, hazardsRef.current))
          },
        )
        if (cancelled) subscription.remove()
      } catch {
        // No location ⇒ no alerts. The "silence is not an all-clear" copy below is why this is a
        // survivable failure rather than something to shout about.
      }
    })()
    return () => {
      cancelled = true
      subscription?.remove()
    }
  }, [onIceWaterBodyId])

  const banner = session.banner
  if (!banner) return null

  const warning = banner.kind === 'warning'

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
              setSession(dismissBanner)
              router.navigate({ pathname: '/hazard/[id]', params: { id: banner.hazardId } })
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
              setSession(dismissBanner)
              try {
                await confirm({
                  hazardId: banner.hazardId as Id<'hazards'>,
                  verdict: 'still_there',
                  via: 'proximity_alert',
                })
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
              setSession(dismissBanner)
              router.navigate({ pathname: '/hazard/[id]', params: { id: banner.hazardId } })
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
  )
}
