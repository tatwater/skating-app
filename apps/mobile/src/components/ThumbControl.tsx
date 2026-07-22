import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { RatingTargetType } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

/**
 * The helpful / unhelpful thumbs control (D50 decision 4), the mobile mirror of web's `ThumbControl` —
 * one shared component driving the polymorphic `ratings.rate` mutation over a report **or** a hazard.
 * Helpful boosts the target author's trust; a thumbs-down never publicly penalizes (boost-only) — it
 * just accumulates toward the mod queue server-side.
 *
 * Counts are always shown (a public signal). Buttons are enabled only when `canRate` (signed in and
 * not your own content — the server also rejects self-rating and discards block-grudge thumbs-downs).
 * When the viewer is the bounty requester, `bountyId` is threaded so a **helpful** thumb on a
 * fulfilling report also fulfills the bounty (decisions 10–11).
 */
export function ThumbControl({
  targetType,
  targetId,
  canRate,
  bountyId,
}: {
  targetType: RatingTargetType;
  targetId: string;
  canRate: boolean;
  bountyId?: Id<'bounties'>;
}) {
  const summary = useQuery(api.ratings.summaryForTarget, { targetType, targetId });
  const rate = useMutation(api.ratings.rate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cast = async (verdict: 'helpful' | 'unhelpful') => {
    setPending(true);
    setError(null);
    try {
      await rate({
        targetType,
        targetId,
        verdict,
        ...(bountyId ? { bountyId } : {}),
      });
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : 'Could not record that — check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  };

  const helpful = summary?.helpful ?? 0;
  const unhelpful = summary?.unhelpful ?? 0;
  const mine = summary?.mine ?? null;
  const disabled = !canRate || pending || summary === undefined;

  return (
    <YStack gap="$1">
      <XStack gap="$2" alignItems="center">
        <ThumbButton
          label="Helpful"
          emoji="👍"
          count={helpful}
          active={mine === 'helpful'}
          disabled={disabled}
          onPress={() => cast('helpful')}
        />
        <ThumbButton
          label="Not helpful"
          emoji="👎"
          count={unhelpful}
          active={mine === 'unhelpful'}
          disabled={disabled}
          onPress={() => cast('unhelpful')}
        />
      </XStack>
      {error ? (
        <Text color="$danger" fontSize={12} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}

function ThumbButton({
  label,
  emoji,
  count,
  active,
  disabled,
  onPress,
}: {
  label: string;
  emoji: string;
  count: number;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      size="$2"
      borderRadius={9999}
      borderWidth={1}
      borderColor={active ? '$primary' : '$border'}
      backgroundColor={active ? '$surfaceMuted' : 'transparent'}
      disabled={disabled}
      opacity={disabled ? 0.5 : 1}
      onPress={onPress}
      accessibilityLabel={`${label} (${count})`}
    >
      <Text color={active ? '$primary' : '$foregroundMuted'} fontSize={14}>
        {emoji} {count}
      </Text>
    </Button>
  );
}
