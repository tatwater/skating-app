import { buildPostCardView, type PostCardData } from '@skating/core';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { Text, View, XStack, YStack } from 'tamagui';
import { FeedCard } from './FeedCard';
import { BlockedChip } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';

/** Prose past this many characters is clamped to a few lines with the rest a tap away, in place. */
const CLAMP_CHARS = 240;

/**
 * One Post in the Latest tab (A10 / D186) — the mobile twin of web's `PostCard`, over the same
 * `buildPostCardView`. Two registers kept visibly apart: the header is the author's words (who,
 * when, the subject-line title, the prose in their voice), the blocks under it are the lakes' data
 * as `FeedCard`s, each pressable to its Report. Two or more lakes get a hairline rail down the left
 * with a mark per lake — the day's itinerary in the order the author skated it. A legacy Post (one
 * Report, no words) has no header and *is* the report card, unchanged.
 */
export function PostCard({
  data,
  now,
  onOpenReport,
}: {
  data: PostCardData;
  now: number;
  onOpenReport: (reportId: string) => void;
}) {
  const view = buildPostCardView(data, now);
  const [expanded, setExpanded] = useState(false);
  const first = data.reports[0];
  if (!view.hasHeader && first) {
    return <FeedCard data={first} now={now} onOpen={() => onOpenReport(first.reportId)} />;
  }
  const sequence = view.reports.length > 1;
  const clamped = view.body !== null && view.body.length > CLAMP_CHARS && !expanded;

  return (
    <YStack borderWidth={1} borderColor="$border" borderRadius="$4" backgroundColor="$surface">
      <YStack gap="$2" padding="$3" paddingBottom="$1">
        <XStack gap="$1.5" alignItems="center">
          <TrustAvatar
            displayName={view.author.displayName}
            imageUrl={view.author.profileImageUrl}
            trustClass={view.author.trustClass}
            size={20}
          />
          <Text
            color={view.blocked ? '$foregroundMuted' : '$foreground'}
            fontSize={13}
            numberOfLines={1}
            flexShrink={1}
          >
            {view.author.displayName}
          </Text>
          {view.blocked ? <BlockedChip /> : null}
          <Text color="$foregroundMuted" fontSize={12} marginLeft="auto">
            {view.relativeTime}
            {view.edited ? ' · edited' : ''}
          </Text>
        </XStack>
        {view.title ? (
          <Text color="$foreground" fontWeight="600" fontSize={16}>
            {view.title}
          </Text>
        ) : null}
        {view.body ? (
          <YStack gap="$1" alignItems="flex-start">
            <Text
              color="$foreground"
              fontSize={14}
              lineHeight={21}
              numberOfLines={clamped ? 4 : undefined}
            >
              {view.body}
            </Text>
            {view.body.length > CLAMP_CHARS ? (
              <Pressable
                onPress={() => setExpanded((e) => !e)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                hitSlop={8}
              >
                <Text color="$foregroundMuted" fontSize={13}>
                  {expanded ? 'Show less' : 'Read more'}
                </Text>
              </Pressable>
            ) : null}
          </YStack>
        ) : null}
      </YStack>

      <XStack>
        {sequence ? (
          <View width={20} alignItems="center" paddingTop="$4" paddingBottom="$4">
            <View flex={1} width={1} backgroundColor="$border" />
          </View>
        ) : null}
        <YStack flex={1}>
          {data.reports.map((report) => (
            <XStack key={report.reportId} alignItems="flex-start">
              {sequence ? (
                <View
                  position="absolute"
                  left={-13}
                  top={18}
                  width={7}
                  height={7}
                  borderRadius={4}
                  borderWidth={1}
                  borderColor="$border"
                  backgroundColor="$surface"
                />
              ) : null}
              <YStack flex={1}>
                <FeedCard
                  data={report}
                  now={now}
                  nested
                  onOpen={() => onOpenReport(report.reportId)}
                />
              </YStack>
            </XStack>
          ))}
        </YStack>
      </XStack>

      {view.omittedLabel ? (
        <Text color="$foregroundMuted" fontSize={12} paddingHorizontal="$3" paddingBottom="$3">
          {view.omittedLabel}
        </Text>
      ) : (
        <View height={4} />
      )}
    </YStack>
  );
}
