import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  classifyFlushError,
  createQueuedConfirmation,
  FOOTPRINT_IS_APPROXIMATE,
  freshnessLabel,
  type HazardVerdict,
  hazardTypeLabel,
  healingNote,
  isPassageMarker,
  stalenessCaveat,
  verdictHelp,
  verdictLabel,
} from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import * as Location from 'expo-location'
import { useEffect, useState } from 'react'
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui'
import { saveHazardItem } from '../lib/draftStore'
import { Badge, DetailLoading, Section, Unavailable } from './detailUi'
import { useMapSelection } from './MapSelectionContext'

/**
 * The hazard drawer (Phase 9) — reached by tapping a pin, from an on-ice banner, or via the
 * `skating://hazard/<id>` deep link.
 *
 * Its job is the **three-tier confirmation**, and the asymmetry between the three is the whole
 * design. "Still here" and "Healing — still unsafe" both keep the pin up; only "Fully healed & safe"
 * retires it for everyone, so that one is de-emphasised and gated behind a second tap. A false
 * all-clear is the worst outcome this app can produce (D3), and the UI is shaped to make it the
 * hardest thing to do by accident.
 *
 * Every word describing hazard *state* comes from `@skating/core`'s copy helpers rather than being
 * written here, so the "never assert ice is safe" rule is enforced by one tested module — including
 * the per-type relabelling that turns the three verdicts into *still crossable / dicey now / ridge
 * closed* for a `ridge_crossing`.
 */

/** The three verdicts, in the order they're offered — destructive last, and visually last. */
const VERDICTS: HazardVerdict[] = ['still_there', 'healing_unsafe', 'fully_healed']

function formatWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${Math.round(hours)} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export function HazardDetail({ hazardId }: { hazardId: string }) {
  const hazard = useQuery(api.hazards.get, { hazardId: hazardId as Id<'hazards'> })
  const confirm = useMutation(api.hazardConfirmations.confirm)
  const { setHighlightWaterBodyId, setFocus } = useMapSelection()

  const [pendingHealed, setPendingHealed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<HazardVerdict | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Highlight the hazard's lake so the map paints its hazard layer — this is also what makes the
  // deep link land somewhere legible when the app was opened cold onto this route.
  useEffect(() => {
    if (hazard) setHighlightWaterBodyId(hazard.waterBodyId)
  }, [hazard, setHighlightWaterBodyId])

  useEffect(() => {
    if (hazard?.bbox) {
      setFocus({
        lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
        lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
        bounds: hazard.bbox,
      })
    }
  }, [hazard, setFocus])

  if (hazard === undefined) return <DetailLoading />
  if (hazard === null) {
    return (
      <Unavailable
        title="Hazard unavailable"
        message="This hazard has been removed, or the link is out of date."
      />
    )
  }

  const passage = isPassageMarker(hazard.type)
  const archived = hazard.status !== 'active'

  async function cast(verdict: HazardVerdict) {
    setConfirming(true)
    setError(null)
    // Stamped before anything can await — this is the moment the skater is looking at the hazard.
    const observedAt = Date.now()

    // Stamp where the skater stood, when we can get it — a confirmation made *at* the hazard is
    // worth more than one made from the couch, and `via` records which this was. Resolved outside the
    // send so the queued fallback carries the same coord the online path would have sent.
    let atCoord: { lat: number; lng: number } | undefined
    try {
      const { status } = await Location.getForegroundPermissionsAsync()
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({})
        atCoord = { lat: pos.coords.latitude, lng: pos.coords.longitude }
      }
    } catch {
      // No fix ⇒ confirm without one. Never block a confirmation on location.
    }

    try {
      await confirm({
        hazardId: hazardId as Id<'hazards'>,
        verdict,
        via: 'app_open_nearby',
        ...(atCoord ? { atCoord } : {}),
        observedAt,
      })
      setDone(verdict)
    } catch (e) {
      if (classifyFlushError(e) === 'permanent') {
        setError(e instanceof Error ? e.message : 'Couldn’t record that.')
        setConfirming(false)
        setPendingHealed(false)
        return
      }
      // No signal — queue it. `observedAt` is *now*, when they're standing here looking at it, not
      // whenever the phone reconnects: a verdict that lands hours later must not reset the hazard's
      // freshness clock to the moment it sent.
      saveHazardItem(
        createQueuedConfirmation({
          id: randomUUID(),
          now: Date.now(),
          hazardId,
          verdict,
          observedAt,
          ...(atCoord ? { atCoord } : {}),
        }),
      )
      setDone(verdict)
    } finally {
      setConfirming(false)
      setPendingHealed(false)
    }
  }

  return (
    <YStack gap="$3">
      <H4 color="$foreground">{hazardTypeLabel(hazard.type)}</H4>

      <XStack gap="$1.5" flexWrap="wrap">
        <Badge tone={hazard.freshness === 'fresh' ? 'solid' : 'outline'}>
          {freshnessLabel(hazard.freshness)}
        </Badge>
        {hazard.provisional ? <Badge>Unconfirmed</Badge> : null}
        {hazard.healingState === 'healing_unsafe' ? <Badge>Reported healing</Badge> : null}
        {passage ? <Badge>Crossing point</Badge> : null}
        {archived ? <Badge>Retired</Badge> : null}
      </XStack>

      <Paragraph color="$foregroundMuted" fontSize={13}>
        Reported {formatWhen(hazard.firstReportedAt)}
        {hazard.confirmCount > 0
          ? ` · confirmed by ${hazard.confirmCount} other skater${hazard.confirmCount === 1 ? '' : 's'}`
          : ' · nobody else has confirmed it yet'}
        .
      </Paragraph>

      {/* Freshness is confidence, never safety — a stale pin still says "unverified", not "clear". */}
      <Paragraph color="$foregroundMuted" fontSize={13}>
        {stalenessCaveat(hazard.type)}
      </Paragraph>

      {hazard.healingState === 'healing_unsafe' ? (
        <Paragraph color="$foregroundMuted" fontSize={13}>
          {healingNote(hazard.type)}
        </Paragraph>
      ) : null}

      {hazard.description ? (
        <Section label="Notes">
          <Paragraph color="$foreground">{hazard.description}</Paragraph>
        </Section>
      ) : null}

      <Paragraph color="$foregroundMuted" fontSize={12}>
        {FOOTPRINT_IS_APPROXIMATE}
      </Paragraph>

      {done ? (
        <Paragraph color="$foreground">
          Thanks — recorded as “{verdictLabel(done, hazard.type)}”.
        </Paragraph>
      ) : archived ? null : (
        <Section label={passage ? 'Is it still crossable?' : 'Is it still there?'}>
          <YStack gap="$2">
            {VERDICTS.map((verdict) => {
              const destructive = verdict === 'fully_healed'
              // The destructive verdict is the only one that retires the pin for everyone, so it
              // asks twice. The asymmetry is the point.
              if (destructive && pendingHealed) {
                return (
                  <YStack
                    key={verdict}
                    gap="$2"
                    borderWidth={1}
                    borderColor="$border"
                    borderRadius="$4"
                    padding="$3"
                  >
                    <Text color="$foreground">
                      This retires the pin for everyone once another skater agrees. Only if you can
                      actually see it’s gone.
                    </Text>
                    <XStack gap="$2">
                      <Button
                        size="$4"
                        flex={1}
                        disabled={confirming}
                        onPress={() => cast(verdict)}
                      >
                        {confirming ? 'Saving…' : 'Yes, I can see it’s gone'}
                      </Button>
                      <Button size="$4" chromeless onPress={() => setPendingHealed(false)}>
                        Cancel
                      </Button>
                    </XStack>
                  </YStack>
                )
              }
              return (
                <Button
                  key={verdict}
                  size="$5"
                  chromeless={destructive}
                  disabled={confirming}
                  onPress={() => (destructive ? setPendingHealed(true) : cast(verdict))}
                >
                  <YStack>
                    <Text color="$foreground" fontWeight={destructive ? '400' : '700'}>
                      {verdictLabel(verdict, hazard.type)}
                    </Text>
                    <Text color="$foregroundMuted" fontSize={12}>
                      {verdictHelp(verdict, hazard.type)}
                    </Text>
                  </YStack>
                </Button>
              )
            })}
          </YStack>
        </Section>
      )}

      {error ? (
        <Text color="$danger" fontSize={13}>
          {error}
        </Text>
      ) : null}
    </YStack>
  )
}
