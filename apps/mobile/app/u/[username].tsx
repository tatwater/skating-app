import { api } from '@skating/convex/api';
import { formatSkateTime, humanizeEnum } from '@skating/core';
import { useQuery } from 'convex/react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, DetailLoading, Unavailable } from '../../src/components/detailUi';
import { useIsModerator } from '../../src/components/ModeratorActions';
import { ProfileView } from '../../src/components/ProfileView';
import { BlockButton, FlagControl } from '../../src/components/SafetyControls';

/** `/u/[username]` — a viewable public/private profile (D13), the mobile mirror of web's route. */
export default function ProfileRoute() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const profile = useQuery(api.profiles.getPublicProfile, { username });
  const isModerator = useIsModerator();

  if (profile === undefined) return <DetailLoading />;
  if (profile === null) {
    return (
      <Unavailable
        title="Profile not available"
        message="This profile doesn’t exist or isn’t visible to you."
      />
    );
  }

  const actions = profile.isSelf ? null : (
    <YStack gap="$2">
      <BlockButton targetUserId={profile.userId} displayName={profile.displayName} />
      <FlagControl targetType="user" targetId={profile.userId} />
    </YStack>
  );

  return (
    <ScrollView style={{ flex: 1 }}>
      <ProfileView
        data={{
          username: profile.username,
          displayName: profile.displayName,
          profileImageUrl: profile.profileImageUrl,
          isSelf: profile.isSelf,
          isPrivate: profile.private,
          trustClass: profile.trustClass,
          // The raw number is admin-only (D50) — pass it through solely for a moderator/admin viewer.
          adminReputationPoints:
            !profile.private && isModerator ? profile.reputationPoints : undefined,
          homeTownLabel: profile.private ? undefined : profile.homeTownLabel,
          bio: profile.private ? undefined : profile.bio,
          badges: profile.private ? undefined : profile.badges,
          bountyPoints: profile.private ? undefined : profile.bountyPoints,
          reportCount: profile.private ? undefined : profile.reportCount,
          commentCount: profile.private ? undefined : profile.commentCount,
        }}
        actions={actions}
        reportHistory={
          !profile.private && profile.reports.length > 0 ? (
            <YStack gap="$2">
              {profile.reports.map(({ report, waterBodyName }) => (
                <XStack
                  key={report._id}
                  justifyContent="space-between"
                  alignItems="center"
                  padding="$3"
                  borderWidth={1}
                  borderColor="$border"
                  borderRadius="$4"
                  pressStyle={{ backgroundColor: '$surfaceMuted' }}
                  onPress={() =>
                    router.navigate({ pathname: '/report/[id]', params: { id: report._id } })
                  }
                >
                  <YStack>
                    <Text color="$foreground">{waterBodyName}</Text>
                    <Text color="$foregroundMuted" fontSize="$1">
                      {formatSkateTime(report.skateEndTime)}
                    </Text>
                  </YStack>
                  {report.skateQuality ? (
                    <Badge tone="solid">{humanizeEnum(report.skateQuality)}</Badge>
                  ) : null}
                </XStack>
              ))}
            </YStack>
          ) : !profile.private ? (
            <Text color="$foregroundMuted">No reports yet.</Text>
          ) : null
        }
      />
    </ScrollView>
  );
}
