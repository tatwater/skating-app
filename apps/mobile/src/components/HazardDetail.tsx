import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  classifyFlushError,
  confirmerSummary,
  createQueuedConfirmation,
  disputedNote,
  FOOTPRINT_IS_APPROXIMATE,
  freshnessLabel,
  type HazardVerdict,
  hazardTypeLabel,
  healingNote,
  isLeaving,
  isPassageMarker,
  stalenessCaveat,
  verdictHelp,
  verdictLabel,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { randomUUID } from 'expo-crypto';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';
import { saveHazardItem } from '../lib/draftStore';
import { useDrawerScroll } from './DrawerScrollContext';
import { Badge, DetailLoading, Section, Unavailable } from './detailUi';
import { useMapSelection } from './MapSelectionContext';
import { FlagControl } from './SafetyControls';
import { ThumbControl } from './ThumbControl';
import { TrustAvatar } from './TrustDisplay';
import { WeatherStrip } from './WeatherStrip';

/**
 * The hazard drawer (Phase 9) — reached by tapping a pin, from an on-ice banner, or via the
 * `skating://hazard/<id>` deep link. `action=confirm` (the on-ice notification tap, D54 Layer 2)
 * scrolls the confirm control into view so the drawer opens pre-focused on it — but never expands the
 * destructive "fully healed" step, which stays gated behind its own second tap even then (D3).
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

/**
 * The verdicts, in the order they're offered — destructive last, and `never_existed` last of all: it
 * is the only one that is a claim about the *report* rather than the ice (D65), and the only one that
 * puts the pin in front of a moderator.
 */
const VERDICTS: HazardVerdict[] = [
  'still_there',
  'healing_unsafe',
  'fully_healed',
  'never_existed',
];

function formatWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function HazardDetail({ hazardId, action }: { hazardId: string; action?: 'confirm' }) {
  const hazard = useQuery(api.hazards.get, { hazardId: hazardId as Id<'hazards'> });
  const photos = useQuery(api.photos.getHazardUrls, { hazardId: hazardId as Id<'hazards'> });
  const confirm = useMutation(api.hazardConfirmations.confirm);
  // The reporter's public attribution (ringed by trust, D50) + the viewer, to gate rating own content.
  const reporters = useQuery(
    api.profiles.publicByIds,
    hazard ? { profileIds: [hazard.createdByUserId] } : 'skip',
  );
  const me = useQuery(api.profiles.current, {});
  // Who has confirmed it (D65) — named where the profile is public, counted where it isn't, so the
  // list can be shorter than the count without the count ever being wrong.
  const confirmations = useQuery(api.hazardConfirmations.listForHazard, {
    hazardId: hazardId as Id<'hazards'>,
  });
  const confirmerNames = (confirmations ?? [])
    .filter((c) => c.verdict === 'still_there' && c.displayName !== undefined)
    .map((c) => c.displayName as string);
  const { setHighlightWaterBodyId, setFocus } = useMapSelection();
  const { scrollToY } = useDrawerScroll();

  // For the `?action=confirm` deep link: scroll the confirm control into view once it lays out. The
  // section sits below the fold in the drawer's scroll view; `onLayout` gives us its offset and the
  // drawer does the scroll. The ref holds the hazard id we last scrolled for (not a bare boolean): a
  // vote patches the hazard and re-lays-out the drawer, and we must not yank a reading skater back down
  // each time — but a *different* hazard deep-linked into the already-open drawer (a second on-ice
  // notification; `router.navigate` reuses the route without remounting) must scroll afresh.
  const confirmScrolledForRef = useRef<string | null>(null);

  const [pendingHealed, setPendingHealed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<HazardVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Highlight the hazard's lake so the map paints its hazard layer — this is also what makes the
  // deep link land somewhere legible when the app was opened cold onto this route.
  useEffect(() => {
    if (hazard) setHighlightWaterBodyId(hazard.waterBodyId);
  }, [hazard, setHighlightWaterBodyId]);

  // Frame the hazard, but depend on the bbox *numbers*, not the whole `hazard` object. Casting a vote
  // patches `lastConfirmedAt`, so the reactive query hands back a new object identity every confirm —
  // depending on `hazard` re-fired this and re-`fitBounds`, throwing a skater who'd zoomed in to
  // inspect right back out at the very moment they confirmed. The bbox itself doesn't change on a vote.
  const bboxMinLat = hazard?.bbox?.minLat;
  const bboxMaxLat = hazard?.bbox?.maxLat;
  const bboxMinLng = hazard?.bbox?.minLng;
  const bboxMaxLng = hazard?.bbox?.maxLng;
  useEffect(() => {
    if (
      bboxMinLat !== undefined &&
      bboxMaxLat !== undefined &&
      bboxMinLng !== undefined &&
      bboxMaxLng !== undefined
    ) {
      setFocus({
        lat: (bboxMinLat + bboxMaxLat) / 2,
        lng: (bboxMinLng + bboxMaxLng) / 2,
        bounds: { minLat: bboxMinLat, maxLat: bboxMaxLat, minLng: bboxMinLng, maxLng: bboxMaxLng },
      });
    }
  }, [bboxMinLat, bboxMaxLat, bboxMinLng, bboxMaxLng, setFocus]);

  if (hazard === undefined) return <DetailLoading />;
  if (hazard === null) {
    return (
      <Unavailable
        title="Hazard unavailable"
        message="This hazard has been removed, or the link is out of date."
      />
    );
  }

  const passage = isPassageMarker(hazard.type);
  const archived = hazard.status !== 'active';
  const reporter = reporters?.[hazard.createdByUserId];
  const isOwn = me?._id === hazard.createdByUserId;

  async function cast(verdict: HazardVerdict) {
    setConfirming(true);
    setError(null);
    // Stamped before anything can await — this is the moment the skater is looking at the hazard.
    const observedAt = Date.now();

    // Stamp where the skater stood, when we can get it — a confirmation made *at* the hazard is
    // worth more than one made from the couch, and `via` records which this was. Resolved outside the
    // send so the queued fallback carries the same coord the online path would have sent.
    let atCoord: { lat: number; lng: number } | undefined;
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({});
        atCoord = { lat: pos.coords.latitude, lng: pos.coords.longitude };
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
      });
      setDone(verdict);
    } catch (e) {
      if (classifyFlushError(e) === 'permanent') {
        setError(
          e instanceof ConvexError
            ? String(e.data)
            : e instanceof Error
              ? e.message
              : 'Couldn’t record that.',
        );
        setConfirming(false);
        setPendingHealed(false);
        return;
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
          // Same trigger as the online path above — a drawer confirmation, not a proximity alert.
          via: 'app_open_nearby',
          observedAt,
          ...(atCoord ? { atCoord } : {}),
        }),
      );
      setDone(verdict);
    } finally {
      setConfirming(false);
      setPendingHealed(false);
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
        {hazard.healingState === 'disputed' ? <Badge>Disputed</Badge> : null}
        {hazard.healingState === 'healing_unsafe' ? <Badge>Reported healing</Badge> : null}
        {passage ? <Badge>Crossing point</Badge> : null}
        {archived ? <Badge>Retired</Badge> : null}
      </XStack>

      {reporter ? (
        <XStack gap="$1.5" alignItems="center" flexWrap="wrap">
          <TrustAvatar
            displayName={reporter.displayName}
            imageUrl={reporter.profileImageUrl}
            trustClass={reporter.trustClass}
            size={20}
          />
          <Text color="$foreground" fontSize={13}>
            by {reporter.displayName}
          </Text>
        </XStack>
      ) : null}

      <Paragraph color="$foregroundMuted" fontSize={13}>
        {/* Attribution (name + TrustAvatar) is the row above — Phase 6's richer treatment supersedes
            Phase 9.5's plain `hazard.reporterName` here, so this line only carries when + confirms. */}
        Reported {formatWhen(hazard.firstReportedAt)}
        {hazard.confirmCount > 0
          ? ` · ${confirmerSummary(confirmerNames, hazard.confirmCount)?.toLowerCase()}`
          : ' · nobody else has confirmed it yet'}
        .
      </Paragraph>

      {/* Freshness is confidence, never safety — a stale pin still says "unverified", not "clear". */}
      <Paragraph color="$foregroundMuted" fontSize={13}>
        {stalenessCaveat(hazard.type)}
      </Paragraph>

      {/* A disputed crossing outranks a healing note — "the ridge is closed here" is the stronger
          claim, and the one to read first (D64). */}
      {hazard.healingState === 'disputed' ? (
        <Paragraph color="$foregroundMuted" fontSize={13}>
          {disputedNote()}
        </Paragraph>
      ) : hazard.healingState === 'healing_unsafe' ? (
        <Paragraph color="$foregroundMuted" fontSize={13}>
          {healingNote(hazard.type)}
        </Paragraph>
      ) : null}

      {/* The photo is often the thing that makes a hazard recognisable from a distance — which is
          the whole point of the pin. Shown before the notes for that reason. */}
      {photos && photos.length > 0 ? (
        <Section label="Photos">
          <XStack gap="$2" flexWrap="wrap">
            {photos.map((photo) =>
              photo.thumbUrl ? (
                <Image
                  key={photo.photoId}
                  source={{ uri: photo.thumbUrl }}
                  accessibilityLabel={`${hazardTypeLabel(hazard.type)} photo`}
                  style={{ width: 96, height: 96, borderRadius: 8 }}
                />
              ) : null,
            )}
          </XStack>
        </Section>
      ) : null}

      {hazard.description ? (
        <Section label="Notes">
          <Paragraph color="$foreground">{hazard.description}</Paragraph>
        </Section>
      ) : null}

      {/* Only active hazards show recent weather — a retired/archived pin needn't hit Open-Meteo (§3). */}
      {archived ? null : (
        <WeatherStrip
          hazardId={hazard._id}
          label="Recent weather here"
          caveat={hazard.snowHidden ? 'Possibly snow-hidden.' : undefined}
        />
      )}

      <Paragraph color="$foregroundMuted" fontSize={12}>
        {FOOTPRINT_IS_APPROXIMATE}
      </Paragraph>

      {done ? (
        <Paragraph color="$foreground">
          Thanks — recorded as “{verdictLabel(done, hazard.type)}”.
        </Paragraph>
      ) : archived || isLeaving(me) ? null : (
        <View
          onLayout={(e) => {
            if (action === 'confirm' && confirmScrolledForRef.current !== hazardId) {
              confirmScrolledForRef.current = hazardId;
              // `layout.y` is relative to the root stack, itself ~16 px (container padding) into the
              // scroll content — so scrolling to `y` lands the section just below the top edge.
              scrollToY(Math.max(0, e.nativeEvent.layout.y));
            }
          }}
        >
          <Section label={passage ? 'Is it still crossable?' : 'Is it still there?'}>
            <YStack gap="$2">
              {VERDICTS.map((verdict) => {
                const destructive = verdict === 'fully_healed';
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
                        This retires the pin for everyone once another skater agrees. Only if you
                        can actually see it’s gone.
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
                  );
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
                );
              })}
            </YStack>
          </Section>
        </View>
      )}

      {error ? (
        <Text
          color="$danger"
          fontSize={13}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {error}
        </Text>
      ) : null}

      {/* Thumbs (D50): counts visible to all; rating enabled for a signed-in non-reporter. */}
      <ThumbControl
        targetType="hazard"
        targetId={hazardId}
        canRate={!!me && !isOwn && !isLeaving(me)}
      />

      {/* Flagging a hazard (D3/D32) — a dangerously false pin is a safety problem, so the same
          `unsafe_false_report` reason that leads the report/comment picker is reachable here too.
          Mirrors web's `HazardView` flag affordance and how mobile flags reports/comments. */}
      <XStack>
        <FlagControl targetType="hazard" targetId={hazardId} label="Flag this hazard" />
      </XStack>
    </YStack>
  );
}
