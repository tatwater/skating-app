import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView } from 'react-native';
import { Text, YStack } from 'tamagui';
import { DetailLoading, Unavailable } from '../../src/components/detailUi';
import { useIsLeaving } from '../../src/components/LeavingNotice';
import { useIsModerator } from '../../src/components/ModeratorActions';
import { PostCard } from '../../src/components/PostCard';
import { ProfileView } from '../../src/components/ProfileView';
import { BlockButton, FlagControl } from '../../src/components/SafetyControls';

/** `/u/[username]` — a viewable public/private profile (D13), the mobile mirror of web's route. */
export default function ProfileRoute() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const now = Date.now();
  const profile = useQuery(api.profiles.getPublicProfile, { username });
  const isModerator = useIsModerator();
  const leaving = useIsLeaving();

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
          // Owner-only: nobody else learns this person is leaving until it's irreversible.
          isLeaving: profile.isSelf && leaving,
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
          !profile.private && profile.posts.length > 0 ? (
            // The person's Posts as the feed shows them (A10 / D186) — one card builder, one look.
            <YStack gap="$3">
              {profile.posts.map((post) => (
                <PostCard
                  key={post.postId}
                  data={post}
                  now={now}
                  onOpenReport={(reportId) =>
                    router.navigate({ pathname: '/report/[id]', params: { id: reportId } })
                  }
                />
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
