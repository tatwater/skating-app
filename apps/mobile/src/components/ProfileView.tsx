import type { ReactNode } from 'react';
import { Image } from 'react-native';
import { H4, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';

/** Plain profile data for the presentational view (mirrors web's `ProfileViewData`). */
export interface ProfileViewData {
  username: string;
  displayName: string;
  profileImageUrl?: string;
  isSelf: boolean;
  isPrivate: boolean;
  homeTownLabel?: string;
  bio?: string;
  reputationPoints?: number;
  reportCount?: number;
  commentCount?: number;
}

/** Round avatar with an initial fallback when the user has no Clerk image. */
export function Avatar({
  displayName,
  imageUrl,
  size = 64,
}: {
  displayName: string;
  imageUrl?: string;
  size?: number;
}) {
  if (imageUrl) {
    return (
      <Image
        source={{ uri: imageUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel={displayName}
      />
    );
  }
  return (
    <YStack
      width={size}
      height={size}
      borderRadius={size / 2}
      backgroundColor="$surfaceMuted"
      alignItems="center"
      justifyContent="center"
    >
      <Text color="$foregroundMuted" fontSize={size / 2.5} fontWeight="600">
        {displayName.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </YStack>
  );
}

/** A labeled stat / trust-score number. */
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
 * name + avatar only; public (or your own) = full card with bio, town, #reports/#comments, the
 * trust-score widget (renders 0 until Phase 6, D50), and a report-history slot. `actions` +
 * `reportHistory` are slots so the container owns the live wiring.
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
        <Avatar displayName={data.displayName} imageUrl={data.profileImageUrl} />
        <YStack flex={1} gap="$0.5">
          <H4 color="$foreground">{data.displayName}</H4>
          <Text color="$foregroundMuted">@{data.username}</Text>
          {!data.isPrivate && data.homeTownLabel ? (
            <Text color="$foregroundMuted">{data.homeTownLabel}</Text>
          ) : null}
        </YStack>
        {actions ? <YStack gap="$2">{actions}</YStack> : null}
      </XStack>

      {data.isPrivate ? (
        <Paragraph color="$foregroundMuted">This profile is private.</Paragraph>
      ) : (
        <>
          {data.bio ? <Paragraph color="$foreground">{data.bio}</Paragraph> : null}
          <Separator borderColor="$border" />
          <XStack justifyContent="space-around">
            <Stat value={data.reportCount ?? 0} label="Reports" />
            <Stat value={data.commentCount ?? 0} label="Comments" />
            <Stat value={data.reputationPoints ?? 0} label="Trust score" />
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
