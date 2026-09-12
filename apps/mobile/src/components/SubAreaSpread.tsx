import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { SpreadPart } from '@skating/core';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { Paragraph, Text, YStack } from 'tamagui';
import { Section } from './detailUi';

/**
 * The spread across a giant's named bays (N6h / open question 5) — the mobile twin of web's
 * `SubAreaSpread`, over the same core sentences. The named extremes are pressable and navigate to
 * `sub=`, the same route the chips and a search hit use, so pressing *Missisquoi Bay* frames it and
 * scopes both weather panels to it. Nothing renders until the filter tier has rows for two of the
 * lake's bays, which outside the season is every lake.
 */
export function SubAreaSpread({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const spread = useQuery(api.weatherArchive.getSubAreaSpread, { waterBodyId });
  const router = useRouter();
  if (!spread) return null;
  const go = (subAreaId: string) =>
    router.navigate({ pathname: '/water/[id]', params: { id: waterBodyId, sub: subAreaId } });
  return (
    <Section label="Across the lake">
      <YStack gap="$1">
        <Text color="$foregroundMuted" fontSize={13}>
          {spread.summary}
        </Text>
        {spread.similar
          ? null
          : spread.lines.map((line) => (
              <Paragraph key={line.kind} color="$foreground" fontSize={14}>
                {line.parts.map((part) => (
                  <SpreadPartView key={partKey(part)} part={part} onPress={go} />
                ))}
              </Paragraph>
            ))}
        {/* The sorted bay lists (Workstream E, founder call 9): the user picks the criterion, the
            app counts (D150). Each bay is the same `sub=` navigation the extremes are. */}
        {[spread.rankings?.coldestNights, spread.rankings?.leastSnow]
          .filter((r): r is NonNullable<typeof r> => !!r)
          .map((ranking) => (
            <Paragraph key={ranking.kind} color="$foregroundMuted" fontSize={13}>
              <Text color="$foreground">{ranking.label}: </Text>
              {ranking.bays.map((bay, i) => (
                <Text key={bay.subAreaId}>
                  {i > 0 ? ' · ' : ''}
                  <SpreadPartView part={bay} onPress={go} />
                  {` (${bay.value})`}
                </Text>
              ))}
            </Paragraph>
          ))}
      </YStack>
    </Section>
  );
}

/** A part is prose or a place; either is unique within its line, so the content is the key. */
function partKey(part: SpreadPart): string {
  return typeof part === 'string' ? part : part.subAreaId;
}

function SpreadPartView({
  part,
  onPress,
}: {
  part: SpreadPart;
  onPress: (subAreaId: string) => void;
}) {
  if (typeof part === 'string') return <Text>{part}</Text>;
  return (
    <Text
      color="$primary"
      accessibilityRole="link"
      accessibilityLabel={`Show weather at ${part.name}`}
      onPress={() => onPress(part.subAreaId)}
    >
      {part.name}
    </Text>
  );
}
