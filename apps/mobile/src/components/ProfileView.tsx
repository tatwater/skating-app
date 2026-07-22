import { badgeLabel, type TrustClass } from '@skating/core';
import type { ReactNode } from 'react';
import { H4, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';
import { Avatar } from './Avatar';
import { Badge } from './detailUi';
import { TrustAvatar, TrustClassChip } from './TrustDisplay';

// Re-exported so existing importers (`CommentThread`) keep working after Avatar moved to its own module.
export { Avatar };

/** Plain profile data for the presentational view (mirrors web's `ProfileViewData`). */
export interface ProfileViewData {
  username: string;
  displayName: string;
  profileImageUrl?: string;
  isSelf: boolean;
  isPrivate: boolean;
  homeTownLabel?: string;
  bio?: string;
  /** Cosmetic trust class (D50) — the profile chip + avatar ring; `null` ⇒ no chip/ring. */
  trustClass?: TrustClass | null;
  /** Raw score — shown ONLY to admins/moderators (D50); the container passes it only then. */
  adminReputationPoints?: number;
  /** Earned badge families (D50 decision 6), stable order; humanized for the badge row. */
  badges?: string[];
  bountyPoints?: number;
  reportCount?: number;
  commentCount?: number;
}

/** A labeled stat / count number. */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <YStack alignItems="center" gap="$0.5">
      <Text color="$foreground" fontSize={22} fontWeight="600">
        {value}
      </Text>
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        {label}
      </Text>
    </YStack>
  );
}

/**
 * Presentational profile view (D13), the mobile mirror of web's `ProfileView`. Private (to others) =
 * name + avatar only; public (or your own) = full card with bio, town, badges (D50), #reports/#comments
 * and, when earned, bounty points, plus a trust-class chip beside the name + a ring on the avatar. The
 * raw trust *number* is admin-only on web; mobile has no moderator/admin surface here, so it's omitted
 * (see the route note). `actions` + `reportHistory` are slots so the container owns the live wiring.
 */
export function ProfileView({
  data,
  actions,
  reportHistory,
}: {
  data: ProfileViewData;
  actions?: ReactNode;
  reportHistory?: ReactNode;
}) {
  return (
    <YStack gap="$4" padding="$4" backgroundColor="$background">
      <XStack gap="$3" alignItems="flex-start">
        <TrustAvatar
          displayName={data.displayName}
          imageUrl={data.profileImageUrl}
          trustClass={data.trustClass}
          size={64}
        />
        <YStack flex={1} gap="$0.5">
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <H4 color="$foreground">{data.displayName}</H4>
            <TrustClassChip trustClass={data.trustClass ?? null} />
          </XStack>
          <Text color="$foregroundMuted">@{data.username}</Text>
          {!data.isPrivate && data.homeTownLabel ? (
            <Text color="$foregroundMuted">{data.homeTownLabel}</Text>
          ) : null}
          {/* Admin-only raw trust number (D50) — never shown to ordinary viewers. */}
          {data.adminReputationPoints !== undefined ? (
            <Text color="$foregroundMuted" fontSize={12}>
              trust score: {data.adminReputationPoints} (admin)
            </Text>
          ) : null}
        </YStack>
        {actions ? <YStack gap="$2">{actions}</YStack> : null}
      </XStack>

      {data.isPrivate ? (
        <Paragraph color="$foregroundMuted">This profile is private.</Paragraph>
      ) : (
        <>
          {data.bio ? <Paragraph color="$foreground">{data.bio}</Paragraph> : null}
          {data.badges && data.badges.length > 0 ? (
            <XStack gap="$1.5" flexWrap="wrap">
              {data.badges.map((badge) => (
                <Badge key={badge}>{badgeLabel(badge)}</Badge>
              ))}
            </XStack>
          ) : null}
          <Separator borderColor="$border" />
          <XStack justifyContent="space-around">
            <Stat value={data.reportCount ?? 0} label="Reports" />
            <Stat value={data.commentCount ?? 0} label="Comments" />
            {data.bountyPoints && data.bountyPoints > 0 ? (
              <Stat value={data.bountyPoints} label="Bounty pts" />
            ) : null}
          </XStack>
        </>
      )}

      {!data.isPrivate && reportHistory ? (
        <YStack gap="$2">
          <Text
            color="$foregroundMuted"
            fontSize={11}
            letterSpacing={1.5}
            textTransform="uppercase"
          >
            Recent reports
          </Text>
          {reportHistory}
        </YStack>
      ) : null}
    </YStack>
  );
}
