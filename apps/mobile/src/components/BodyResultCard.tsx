import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { type BodyResultData, buildBodyResultView } from '@skating/core';
import { Text, useTheme, XStack, YStack } from 'tamagui';
import { Badge } from './detailUi';

/**
 * A weather-matched **lake** in the Latest feed (N6h / D165) — the mobile twin of web's
 * `BodyResultCard`. An *Overview* object where a report card is a *Reporting* one (D159), and the
 * layout says so: no author, no quality, no photos; a place, the chain sentence that matched, and the
 * date the reading is as of. Every sentence comes from `buildBodyResultView` in core. Pressing opens
 * the lake on the map (the bay, when the reading was taken at one).
 */
export function BodyResultCard({
  data,
  now,
  onOpen,
}: {
  data: BodyResultData;
  now: number;
  onOpen: (focusSubAreaId: string | null) => void;
}) {
  const card = buildBodyResultView(data, now);
  const theme = useTheme();
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderStyle="dashed"
      borderColor="$border"
      borderRadius="$4"
      backgroundColor="$surface"
      pressStyle={{ opacity: 0.7 }}
      onPress={() => onOpen(card.focusSubAreaId)}
    >
      <XStack justifyContent="space-between" gap="$3" alignItems="flex-start">
        <YStack flex={1}>
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
        </YStack>
        <Text color="$foregroundMuted" fontSize={12}>
          {card.relativeTime}
        </Text>
      </XStack>

      <Text color="$foreground" fontSize={14}>
        {card.headline}
        <Text color="$foregroundMuted">{` · ${card.asOfLabel}`}</Text>
      </Text>
      {card.alsoAtLabel ? (
        <Text color="$foregroundMuted" fontSize={12}>
          {card.alsoAtLabel}
        </Text>
      ) : null}
      {card.caveat ? (
        <Text color="$foregroundMuted" fontSize={12} fontStyle="italic">
          {card.caveat}
        </Text>
      ) : null}

      <XStack gap="$1" flexWrap="wrap">
        <Badge tone="solid">Weather match</Badge>
        {card.isHikeIn ? <Badge>Hike-in</Badge> : null}
        {card.noPublicAccess ? <Badge>No public access</Badge> : null}
      </XStack>
    </YStack>
  );
}
