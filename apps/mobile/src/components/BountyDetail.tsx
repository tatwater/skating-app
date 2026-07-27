import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatSkateTime, SKATE_QUALITY_LABELS } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, H4, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';
import { expiryLabel } from './BountyList';
import { Badge, DetailLoading, Section, Unavailable } from './detailUi';
import { ThumbControl } from './ThumbControl';
import { TrustAvatar } from './TrustDisplay';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  fulfilled: 'Fulfilled',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/**
 * `/bounty/[id]` detail drawer (D47), the mobile mirror of web's `BountyDetail`. Shows the requester
 * (ringed by trust), the reward, and the candidate reports that have auto-attached. The **requester**
 * can cancel an open bounty, or mark a candidate report **helpful** — which fulfills the bounty and
 * pays its author (decisions 10–11), driven by the shared thumbs control with the `bountyId` threaded
 * through. Others just see the status + candidates.
 */
export function BountyDetail({ bountyId }: { bountyId: string }) {
  const router = useRouter();
  const detail = useQuery(api.bounties.getDetail, { bountyId: bountyId as Id<'bounties'> });
  const cancel = useMutation(api.bounties.cancel);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (detail === undefined) return <DetailLoading />;
  if (detail === null) {
    return (
      <Unavailable
        title="Bounty not available"
        message="This bounty may have been cancelled or removed."
      />
    );
  }

  const now = Date.now();
  const isOpen = detail.status === 'open';

  const onCancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await cancel({ bountyId: bountyId as Id<'bounties'> });
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : 'Could not cancel — check your connection and try again.',
      );
    } finally {
      setCancelling(false);
    }
  };

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <H4 color="$foreground">Bounty{detail.waterBody ? ` · ${detail.waterBody.name}` : ''}</H4>
        <Text color="$foregroundMuted">
          {STATUS_LABEL[detail.status] ?? detail.status}
          {isOpen ? ` · ${expiryLabel(detail.expiresAt, now)}` : ''}
        </Text>
      </YStack>

      <XStack gap="$2" alignItems="center">
        <TrustAvatar
          displayName={detail.requester.displayName}
          trustClass={detail.requester.trustClass}
          size={28}
        />
        {/* No link for a requester there's nothing to link to. Two distinct cases: an *unresolvable*
            one has no username at all, and a **deleted** one now has a synthetic sentinel handle (N3)
            — which passes an emptiness check while still routing nowhere, so `deleted` has to be
            checked explicitly. */}
        <Text
          flex={1}
          color={
            detail.requester.username && !detail.requester.deleted ? '$primary' : '$foreground'
          }
          onPress={
            detail.requester.username && !detail.requester.deleted
              ? () =>
                  router.navigate({
                    pathname: '/u/[username]',
                    params: { username: detail.requester.username },
                  })
              : undefined
          }
        >
          {detail.requester.displayName}
          <Text color="$foregroundMuted"> wants fresh eyes here</Text>
        </Text>
        <Badge tone="solid">{detail.rewardPoints} pts</Badge>
      </XStack>

      {detail.waterBody ? (
        <Text
          color="$primary"
          onPress={() =>
            router.navigate({
              pathname: '/water/[id]',
              // biome-ignore lint/style/noNonNullAssertion: guarded by the `detail.waterBody` check.
              params: { id: detail.waterBody!._id },
            })
          }
        >
          View the lake
        </Text>
      ) : null}

      <Separator borderColor="$border" />

      <Section label="Candidate reports">
        {detail.fulfillingReports.length === 0 ? (
          <Paragraph color="$foregroundMuted">
            No reports yet. Recent skaters have been notified.
          </Paragraph>
        ) : (
          <YStack gap="$2">
            {detail.fulfillingReports.map((report) => (
              <YStack
                key={report._id}
                gap="$2"
                padding="$2.5"
                borderWidth={1}
                borderColor="$border"
                borderRadius="$4"
                backgroundColor="$surface"
              >
                <XStack gap="$2" alignItems="center">
                  <TrustAvatar
                    displayName={report.authorName}
                    trustClass={report.authorTrustClass}
                    size={20}
                  />
                  <Text
                    flex={1}
                    color="$foreground"
                    numberOfLines={1}
                    onPress={() =>
                      router.navigate({ pathname: '/report/[id]', params: { id: report._id } })
                    }
                  >
                    {report.authorName} · {formatSkateTime(report.skateEndTime)}
                  </Text>
                  {report.skateQuality ? (
                    <Badge>{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
                  ) : null}
                </XStack>
                {/* Requester-only: a helpful thumb here fulfills the bounty + pays the author. */}
                {detail.isRequester && isOpen && !report.isOwn ? (
                  <ThumbControl
                    targetType="report"
                    targetId={report._id}
                    canRate
                    bountyId={detail._id}
                  />
                ) : null}
              </YStack>
            ))}
          </YStack>
        )}
      </Section>

      {detail.isRequester && isOpen ? (
        <>
          <Separator borderColor="$border" />
          <YStack gap="$1" alignItems="flex-start">
            <Button size="$4" chromeless onPress={onCancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel bounty'}
            </Button>
            {error ? (
              <Text color="$danger" fontSize={12} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
          </YStack>
        </>
      ) : null}
    </YStack>
  );
}
