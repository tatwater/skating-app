import type { FeedCardData } from '@skating/core';
import { YStack } from 'tamagui';
import { FeedCard } from './FeedCard';

/**
 * One recommended bundle (decisions 13–15) — the mobile mirror of web's recommended strip. A highlighted
 * wrapper around the ≤2 exceptional, corroborated reports for a body that the viewer's filters would hide,
 * rendered as a distinct row in the feed list. Reuses `FeedCard` so it reads as a feed item but is set
 * apart by the primary-colored border.
 */
export function RecommendedCard({
  cards,
  now,
  onOpen,
}: {
  cards: FeedCardData[];
  now: number;
  onOpen: (reportId: string) => void;
}) {
  return (
    <YStack
      gap="$2"
      padding="$2"
      borderWidth={2}
      borderColor="$primary"
      borderRadius="$4"
      backgroundColor="$surface"
    >
      {cards.map((data) => (
        <FeedCard key={data.reportId} data={data} now={now} onOpen={() => onOpen(data.reportId)} />
      ))}
    </YStack>
  );
}
