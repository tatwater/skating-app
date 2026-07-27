import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { DEFAULT_BOUNTY_REWARD_POINTS } from '@skating/core';
import { useAction, useQuery } from 'convex/react';
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
  const create = useAction(api.bounties.create);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Named bays on this lake (N2/D60). The whole lake stays the default — most lakes have none, and
  // asking "which part?" of a pond is noise. Rendered as chips rather than a picker: at the handful
  // a lake carries, one tap beats a modal wheel.
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  // The cap that applies to *this* person (N2) — the global constant would lie to a limited user.
  const myLimit = useQuery(api.bounties.myBountyLimit, {});
  const bays = (subAreas ?? []).filter((s) => !s.removed);
  const [subAreaId, setSubAreaId] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const id = await create({
        waterBodyId,
        ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
      });
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
      {bays.length > 0 ? (
        <YStack gap="$2">
          <Text color="$foreground" fontWeight="600" fontSize={14}>
            Which part?
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            <Button
              size="$3"
              chromeless={subAreaId !== null}
              backgroundColor={subAreaId === null ? '$primary' : undefined}
              color={subAreaId === null ? '$primaryForeground' : '$foreground'}
              onPress={() => setSubAreaId(null)}
            >
              Anywhere
            </Button>
            {bays.map((bay) => (
              <Button
                key={bay._id}
                size="$3"
                chromeless={subAreaId !== bay._id}
                backgroundColor={subAreaId === bay._id ? '$primary' : undefined}
                color={subAreaId === bay._id ? '$primaryForeground' : '$foreground'}
                onPress={() => setSubAreaId(bay._id)}
              >
                {bay.name}
              </Button>
            ))}
          </XStack>
          <Text color="$foregroundMuted" fontSize={13}>
            Narrowing the ask means only a report from that part of the lake will fulfil it — and a
            recent report somewhere else won't stop you asking.
          </Text>
        </YStack>
      ) : null}
      <YStack gap="$1">
        <Text color="$foregroundMuted" fontSize={13}>
          • Only if the lake doesn't already have a recent report — a well-confirmed read keeps it
          covered longer, and a big thaw or freeze reopens it sooner.
        </Text>
        <Text color="$foregroundMuted" fontSize={13}>
          • Up to {myLimit?.limit ?? '—'} open bount{myLimit?.limit === 1 ? 'y' : 'ies'} at a time
          {myLimit?.restricted ? ' (a moderator has set this for your account)' : ''}.
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
