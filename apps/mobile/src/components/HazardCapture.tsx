import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  applyDraftMapClick,
  draftPlacementCount,
  draftToShape,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardType,
  isPassageMarker,
  pointDraftForType,
  resizeDraft,
  switchDraftKind,
  undoDraftPlacement,
} from '@skating/core'
import { useMutation } from 'convex/react'
import * as Location from 'expo-location'
import { useState } from 'react'
import { Modal } from 'react-native'
import { Button, H4, Paragraph, ScrollView, Text, XStack, YStack } from 'tamagui'
import { useMapSelection } from './MapSelectionContext'

/**
 * On-ice hazard capture (Phase 9, D51 §Mobile) — the FAB, the type sheet, and the adjust bar.
 *
 * Designed against one governing constraint: **cold hands, gloves, bright sun, one hand, possibly
 * moving, no signal, phone in a pocket.** Two rules fall out and drive every decision here:
 *
 * 1. **No required typing anywhere in the flow.** There is no note field on this path at all.
 * 2. **The hazard is committable after two taps** — FAB, then the type. Picking the type drops the
 *    pin at the skater's GPS with that type's own default radius, and it is immediately valid and
 *    postable. Everything after that (resize, move, trace a line) is optional, because a
 *    mitten-fumble that hits Done early must still produce a useful pin.
 *
 * That second rule is why even a pressure ridge starts as a circle here (`pointDraftForType`) rather
 * than the polyline it starts as on web: one GPS fix is one vertex, and a one-vertex line isn't
 * storable. Tracing is an *upgrade* you opt into, not a precondition for being useful.
 *
 * The type sheet closes as soon as a type is picked, collapsing to a compact bar — you have to be
 * able to see the ice and the pin. Nothing here is a blocking modal once the pin exists, because the
 * skater may be moving.
 */

/** Steppers, not a slider. Sliders are miserable with gloves on. */
export function HazardCapture() {
  const createHazard = useMutation(api.hazards.create)
  const {
    onIceWaterBodyId,
    highlightWaterBodyId,
    hazardDraft,
    setHazardDraft,
    hazardDraftType,
    setHazardDraftType,
    hazardDropMode,
    setHazardDropMode,
  } = useMapSelection()

  const [picking, setPicking] = useState(false)
  const [showAllTypes, setShowAllTypes] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Flag against the lake the skater is standing on; fall back to whichever lake they have open, so
  // the affordance still works when browsing from the couch.
  const targetBodyId = onIceWaterBodyId ?? highlightWaterBodyId

  function reset() {
    setHazardDraft(null)
    setHazardDraftType(null)
    setHazardDropMode(false)
    setPicking(false)
    setShowAllTypes(false)
    setError(null)
  }

  async function chooseType(type: HazardType) {
    setHazardDraftType(type)
    setPicking(false)
    const draft = pointDraftForType(type)
    try {
      // Drop at the current fix. Permission was already requested for map framing; if it's denied or
      // the fix times out we keep the (unplaced) draft and ask for a tap instead of failing outright.
      const pos = await Location.getCurrentPositionAsync({})
      setHazardDraft(
        applyDraftMapClick(draft, { lat: pos.coords.latitude, lng: pos.coords.longitude }),
      )
    } catch {
      setHazardDraft(draft)
      setHazardDropMode(true)
      setError('Couldn’t get your location — tap the map where the hazard is.')
    }
  }

  async function post() {
    const shape = hazardDraft ? draftToShape(hazardDraft) : null
    if (!hazardDraftType || !shape || !targetBodyId) return
    setSaving(true)
    setError(null)
    try {
      await createHazard({
        waterBodyId: targetBodyId as Id<'waterBodies'>,
        type: hazardDraftType,
        geometryKind: shape.geometryKind,
        geometry: shape.geometry,
        ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
        ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
      })
      reset()
      // A brief toast, never a blocking modal — the skater may be moving.
      setToast('Hazard posted. Thanks.')
      setTimeout(() => setToast(null), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t post that hazard.')
    } finally {
      setSaving(false)
    }
  }

  const isLine = hazardDraft?.geometryKind === 'line'
  const placements = hazardDraft ? draftPlacementCount(hazardDraft) : 0
  const postable = hazardDraft !== null && draftToShape(hazardDraft) !== null
  const otherTypes = HAZARD_TYPES.filter(
    (t) => !(HAZARD_TYPE_PRESETS as readonly string[]).includes(t),
  )

  return (
    <>
      {toast ? (
        <YStack
          position="absolute"
          top={72}
          left={16}
          right={16}
          backgroundColor="$success"
          borderRadius="$4"
          padding="$3"
          zIndex={40}
        >
          <Text color="$successForeground">{toast}</Text>
        </YStack>
      ) : null}

      {/* The FAB. Present whenever there's a lake to attach to; off-ice it's simply the ordinary way
          to flag one. Deliberately NOT an "you're on the ice!" mode — there should be nothing you
          can be confused about being *in*. */}
      {targetBodyId && !hazardDraft && !picking ? (
        <Button
          position="absolute"
          bottom={132}
          right={16}
          zIndex={30}
          size="$6"
          circular
          backgroundColor="$danger"
          color="$dangerForeground"
          onPress={() => setPicking(true)}
          accessibilityLabel="Flag a hazard"
        >
          ⚠
        </Button>
      ) : null}

      <Modal visible={picking} animationType="slide" transparent onRequestClose={reset}>
        <YStack flex={1} justifyContent="flex-end" backgroundColor="rgba(0,0,0,0.35)">
          <YStack
            backgroundColor="$surface"
            borderTopLeftRadius="$6"
            borderTopRightRadius="$6"
            padding="$4"
            gap="$3"
            maxHeight="80%"
          >
            <H4 color="$foreground">What did you see?</H4>
            <ScrollView>
              <YStack gap="$2.5">
                {/* The three types that are ~80% of real reports get big one-tap tiles (research §6). */}
                {HAZARD_TYPE_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    size="$6"
                    backgroundColor="$danger"
                    color="$dangerForeground"
                    onPress={() => chooseType(preset)}
                  >
                    {HAZARD_TYPE_LABELS[preset]}
                  </Button>
                ))}
                {/* A crossing is the one *positive* marker — where you got across. It reads green so
                    it can't be mistaken for one more danger tile (research §4). */}
                <Button
                  size="$6"
                  backgroundColor="$success"
                  color="$successForeground"
                  onPress={() => chooseType('ridge_crossing')}
                >
                  {HAZARD_TYPE_LABELS.ridge_crossing}
                </Button>
                {showAllTypes ? (
                  otherTypes
                    .filter((t) => t !== 'ridge_crossing')
                    .map((other) => (
                      <Button key={other} size="$5" onPress={() => chooseType(other)}>
                        {HAZARD_TYPE_LABELS[other]}
                      </Button>
                    ))
                ) : (
                  <Button size="$5" chromeless onPress={() => setShowAllTypes(true)}>
                    More…
                  </Button>
                )}
              </YStack>
            </ScrollView>
            <Button chromeless onPress={reset}>
              Cancel
            </Button>
          </YStack>
        </YStack>
      </Modal>

      {/* The adjust bar — everything here is optional. It sits above the drawer peek and never
          blocks the map, because the pin is already valid and the skater may be moving. */}
      {hazardDraft && hazardDraftType && !picking ? (
        <YStack
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          zIndex={35}
          backgroundColor="$surface"
          borderTopWidth={1}
          borderTopColor="$border"
          padding="$3"
          gap="$2"
        >
          <XStack justifyContent="space-between" alignItems="center">
            <Text color="$foreground" fontWeight="700">
              {HAZARD_TYPE_LABELS[hazardDraftType]}
            </Text>
            <Button size="$2" chromeless onPress={reset}>
              Cancel
            </Button>
          </XStack>

          {/* A line that isn't postable yet must always say so, not just while tracing — switching a
              valid pin to a line silently disables Done otherwise, which on the ice reads as the app
              being broken. */}
          {isLine && !postable ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {placements} {placements === 1 ? 'point' : 'points'} — tap Trace and add at least one
              more, or go back to Just a spot.
            </Paragraph>
          ) : hazardDropMode ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {isLine
                ? `Tap the map along the hazard. ${placements} ${placements === 1 ? 'point' : 'points'}.`
                : 'Tap the map where the hazard is.'}
            </Paragraph>
          ) : (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              Dropped where you are. If you spotted it ahead, tap Move and put it where you saw it —
              don’t skate onto it to mark it.
            </Paragraph>
          )}

          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Button size="$5" onPress={() => setHazardDraft(resizeDraft(hazardDraft, -1))}>
              −
            </Button>
            <Text color="$foreground" fontSize={13} flex={1}>
              {hazardDraft.geometryKind === 'line'
                ? `about ${hazardDraft.bufferMeters} m either side`
                : `about ${hazardDraft.radiusMeters} m across`}
            </Text>
            <Button size="$5" onPress={() => setHazardDraft(resizeDraft(hazardDraft, 1))}>
              +
            </Button>
          </XStack>

          <XStack gap="$2" flexWrap="wrap">
            <Button size="$4" onPress={() => setHazardDropMode(true)}>
              {isLine ? 'Trace' : 'Move'}
            </Button>
            {isLine && placements > 0 ? (
              <Button size="$4" onPress={() => setHazardDraft(undoDraftPlacement(hazardDraft))}>
                Undo point
              </Button>
            ) : null}
            {/* Upgrading to a polyline is opt-in, and only worth offering for the things that are
                actually lines on the ice. The pin stays valid throughout. */}
            <Button
              size="$4"
              chromeless
              onPress={() =>
                setHazardDraft(
                  switchDraftKind(hazardDraft, isLine ? 'point_radius' : 'line', hazardDraftType),
                )
              }
            >
              {isLine ? 'Just a spot' : 'It’s a line'}
            </Button>
          </XStack>

          {error ? (
            <Text color="$danger" fontSize={13}>
              {error}
            </Text>
          ) : null}

          <Button
            size="$6"
            backgroundColor={postable ? '$primary' : undefined}
            color={postable ? '$primaryForeground' : undefined}
            disabled={!postable || saving}
            opacity={postable ? 1 : 0.5}
            onPress={post}
          >
            {saving ? 'Posting…' : 'Done'}
          </Button>
          {isPassageMarker(hazardDraftType) ? (
            <Paragraph color="$foregroundMuted" fontSize={12}>
              A crossing marks where you got across — it’s not a promise it’s safe, and ridges
              change hour to hour.
            </Paragraph>
          ) : null}
        </YStack>
      ) : null}
    </>
  )
}
