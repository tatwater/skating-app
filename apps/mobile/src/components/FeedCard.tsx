import { buildFeedCardView, type FeedCardData } from '@skating/core';
import { Image, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { Badge } from './detailUi';
import { BlockedChip } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';

/** Max chips shown on a card before we stop (the drawer shows the full breakdown). */
const MAX_CHIPS = 4;

/**
 * A single newsfeed card (Phase 5) — the mobile mirror of web's `FeedCard`. Body name +
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
}: {
  data: FeedCardData;
  now: number;
  onOpen: () => void;
}) {
  const card = buildFeedCardView(data, now);
  const chips = card.chips.slice(0, MAX_CHIPS);

  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$border"
      borderRadius="$4"
      backgroundColor="$surface"
      pressStyle={{ opacity: 0.7 }}
      onPress={onOpen}
    >
      <XStack justifyContent="space-between" gap="$3" alignItems="flex-start">
        <YStack flex={1}>
          <Text color="$foreground" fontWeight="600" numberOfLines={1}>
            {card.isFavorite ? <Text color="$primary">★ </Text> : null}
            {card.bodyName}
          </Text>
          {card.placeLabel ? (
            <Text color="$foregroundMuted" fontSize={13} numberOfLines={1}>
              {card.placeLabel}
            </Text>
          ) : null}
        </YStack>
        <Text color="$foregroundMuted" fontSize={12}>
          {card.relativeTime}
        </Text>
      </XStack>

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

      {card.qualityLabel || chips.length > 0 ? (
        <XStack gap="$1.5" flexWrap="wrap" alignItems="center">
          {card.qualityLabel ? <Badge tone="solid">{card.qualityLabel}</Badge> : null}
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
