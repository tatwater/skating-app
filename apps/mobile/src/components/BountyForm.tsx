import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  DEFAULT_BOUNTY_REWARD_POINTS,
  FRESH_REPORT_HOURS,
  MAX_OPEN_BOUNTIES_PER_DAY,
} from '@skating/core';
import { useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';

/**
 * Post-a-bounty panel (D10/D17), the mobile mirror of web's `BountyForm` — "ask for fresh eyes on this
 * lake." Creation is a single confirm: the only input the server needs is the water body (reward +
 * eligibility fan-out are server-owned). The two junk controls surface as inline copy, and their server
 * rejections (already-fresh, at-cap, minor) are shown verbatim so the requester knows *why* it didn't
 * post. Rendered in place inside the water-body drawer (like `ReportForm`); on success it navigates to
 * the new bounty detail.
 */
export function BountyForm({
  waterBodyId,
  bodyName,
  onClose,
}: {
  waterBodyId: Id<'waterBodies'>;
  bodyName: string;
  onClose: () => void;
}) {
  const create = useMutation(api.bounties.create);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const id = await create({ waterBodyId });
      onClose();
      router.navigate({ pathname: '/bounty/[id]', params: { id } });
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : 'Could not post the bounty — check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <YStack gap="$3">
      <H4 color="$foreground">Post a bounty on {bodyName}</H4>
      <Paragraph color="$foregroundMuted">
        A bounty asks recent skaters to check {bodyName} and post a fresh report. When you mark a
        fulfilling report helpful, its author earns {DEFAULT_BOUNTY_REWARD_POINTS} bounty points.
      </Paragraph>
      <YStack gap="$1">
        <Text color="$foregroundMuted" fontSize={13}>
          • Only if there's no fresh report in the last {FRESH_REPORT_HOURS} hours.
        </Text>
        <Text color="$foregroundMuted" fontSize={13}>
          • Up to {MAX_OPEN_BOUNTIES_PER_DAY} open bounties at a time.
        </Text>
      </YStack>
      {error ? (
        <Text color="$danger" fontSize={13} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$4" chromeless onPress={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          size="$4"
          backgroundColor="$primary"
          color="$primaryForeground"
          onPress={submit}
          disabled={pending}
        >
          {pending ? 'Posting…' : 'Post bounty'}
        </Button>
      </XStack>
    </YStack>
  );
}
