import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { Text, XStack, YStack } from 'tamagui';
import { Badge } from './detailUi';
import { TrustAvatar } from './TrustDisplay';

/** "expires in N days / hours" — a bounty's remaining lifetime, humanized for the card. */
export function expiryLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expiring';
  const hours = ms / 3_600_000;
  if (hours < 24) return `expires in ${Math.max(1, Math.round(hours))}h`;
  const days = Math.round(hours / 24);
  return `expires in ${days}d`;
}

/**
 * The open bounties on a body (per-body drawer surface, D47), the mobile mirror of web's `BountyList` —
 * requester (ringed by trust), reward, how many candidate reports have attached, and remaining
 * lifetime. Each row opens the `/bounty/[id]` detail. Renders nothing while empty so the drawer stays
 * quiet on a lake nobody's asked about.
 */
export function BountyList({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const router = useRouter();
  const bounties = useQuery(api.bounties.listForBody, { waterBodyId });
  if (!bounties || bounties.length === 0) return null;
  const now = Date.now();

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Open bounties
      </Text>
      {bounties.map((b) => (
        <XStack
          key={b._id}
          gap="$2"
          alignItems="center"
          padding="$2.5"
          borderWidth={1}
          borderColor="$border"
          borderRadius="$4"
          backgroundColor="$surface"
          pressStyle={{ backgroundColor: '$surfaceMuted' }}
          onPress={() => router.navigate({ pathname: '/bounty/[id]', params: { id: b._id } })}
        >
          <TrustAvatar
            displayName={b.requester.displayName}
            trustClass={b.requester.trustClass}
            size={24}
          />
          <YStack flex={1}>
            <Text color="$foreground" numberOfLines={1}>
              Requested by {b.requester.displayName}
            </Text>
            <Text color="$foregroundMuted" fontSize={12}>
              {b.fulfillingCount > 0
                ? `${b.fulfillingCount} candidate report${b.fulfillingCount === 1 ? '' : 's'} · `
                : ''}
              {expiryLabel(b.expiresAt, now)}
            </Text>
          </YStack>
          <Badge tone="solid">{b.rewardPoints} pts</Badge>
        </XStack>
      ))}
    </YStack>
  );
}
