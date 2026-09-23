import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { buildFeedCardView, type FeedCardData } from '@skating/core';
import { Image, ScrollView } from 'react-native';
import { Text, useTheme, XStack, YStack } from 'tamagui';
import { BodySilhouette } from './BodySilhouette';
import { Badge } from './detailUi';
import { BlockedChip } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';

/** Max chips shown on a card before we stop (the drawer shows the full breakdown). */
const MAX_CHIPS = 4;

/**
 * A single newsfeed card (Phase 05) — the mobile mirror of web's `FeedCard`. Body name +
 * point-derived location, skate-end relative time, quality + ice/surface chips, a horizontal photo
 * thumbnail carousel, and blocked-author de-emphasis (D3: a block never hides the report, only dims
 * the author line + adds a "Blocked" chip). The whole card is pressable → opens the report
 * bottom-sheet, preserving the feed scroll position. Pure/presentational — the container maps
 * `FeedCardData` → view-model via `buildFeedCardView` and wires `onOpen`.
 */
export function FeedCard({
  data,
  now,
  onOpen,
  nested = false,
}: {
  data: FeedCardData;
  now: number;
  onOpen: () => void;
  /**
   * Inside a `PostCard` (A10 / D186): no frame of its own and no author line — the Post already
   * said who and when, and the frame is the Post's. Standing alone, the card is what it always was.
   */
  nested?: boolean;
}) {
  const card = buildFeedCardView(data, now);
  const chips = card.chips.slice(0, MAX_CHIPS);
  const theme = useTheme();

  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={nested ? 0 : 1}
      borderColor="$border"
      borderRadius="$4"
      backgroundColor={nested ? 'transparent' : '$surface'}
      pressStyle={{ opacity: 0.7 }}
      onPress={onOpen}
    >
      <XStack justifyContent="space-between" gap="$3" alignItems="flex-start">
        <YStack flex={1}>
          {/* The star sits beside the name rather than inside it: RN <Text> can only host text and
              inline images, and FontAwesome renders an SVG. Shrinking the label instead of the icon
              keeps the truncation on the long name, where it belongs. */}
          <XStack alignItems="center" gap="$1.5">
            {card.isFavorite ? (
              <FontAwesomeIcon icon={faStar} color={theme.primary?.val} size={12} />
            ) : null}
            <Text color="$foreground" fontWeight="600" numberOfLines={1} flexShrink={1}>
              {card.locationPrimary}
            </Text>
          </XStack>
          {card.locationSecondary ? (
            <Text color="$foregroundMuted" fontSize={13} numberOfLines={1}>
              {card.locationSecondary}
            </Text>
          ) : null}
          {/* D87's third surface — beside the drive time, never folded into it (D72 amendment). */}
          {card.isHikeIn ? (
            <Text color="$foregroundMuted" fontSize={12}>
              Hike-in
            </Text>
          ) : null}
        </YStack>
        {/* The right column: when, and where on the lake (A10 §12.3) — the silhouette carries the
            put-in, the skate and the chips' `where`, so the card shows the shape of the day without
            a map. Absent on a body with no usable outline, and on a cached card from before it. */}
        <YStack alignItems="flex-end" gap="$1">
          <Text color="$foregroundMuted" fontSize={12}>
            {card.relativeTime}
          </Text>
          {data.silhouette ? <BodySilhouette data={data.silhouette} size={56} /> : null}
        </YStack>
      </XStack>

      {nested ? (
        card.durationLabel ? (
          <Text color="$foregroundMuted" fontSize={13}>
            skated {card.durationLabel}
          </Text>
        ) : null
      ) : (
        <XStack gap="$1.5" alignItems="center" flexWrap="wrap">
          <TrustAvatar
            displayName={card.author.displayName}
            imageUrl={card.author.profileImageUrl}
            trustClass={card.author.trustClass}
            size={20}
          />
          <Text color={card.blocked ? '$foregroundMuted' : '$foreground'} fontSize={13}>
            by {card.author.displayName}
          </Text>
          {card.blocked ? <BlockedChip /> : null}
          {card.durationLabel ? (
            <Text color="$foregroundMuted" fontSize={13}>
              · skated {card.durationLabel}
            </Text>
          ) : null}
        </XStack>
      )}

      {card.suitabilityLabel ||
      card.qualityLabel ||
      card.vantageLabel ||
      card.sightingLabel ||
      chips.length > 0 ? (
        <XStack gap="$1.5" flexWrap="wrap" alignItems="center">
          {/* The who-claim leads (D3 / D190): "Don't go" before "Great", in the warning treatment. */}
          {card.suitabilityLabel ? (
            <Badge tone={card.isDontGo ? 'danger' : 'solid'}>{card.suitabilityLabel}</Badge>
          ) : null}
          {card.qualityLabel ? <Badge tone="solid">{card.qualityLabel}</Badge> : null}
          {/* Provenance a reader needs (D191): only off the ice, where it changes how a chip reads. */}
          {card.vantageLabel ? <Badge>{card.vantageLabel}</Badge> : null}
          {card.sightingLabel ? <Badge>{card.sightingLabel}</Badge> : null}
          {chips.map((chip) => (
            <Badge key={chip}>{chip}</Badge>
          ))}
        </XStack>
      ) : null}

      {card.photoThumbUrls.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <XStack gap="$2">
            {card.photoThumbUrls.map((url) => (
              <Image
                key={url}
                source={{ uri: url }}
                style={{ width: 80, height: 80, borderRadius: 8 }}
                accessibilityLabel="Report photo"
              />
            ))}
          </XStack>
        </ScrollView>
      ) : null}
    </YStack>
  );
}
