import { api } from '@skating/convex/api';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { ProfileModeratorPanel } from '../components/admin/ProfileModeratorPanel';
import { UnavailableState } from '../components/DrawerStates';
import { useIsLeaving } from '../components/LeavingNotice';
import { useIsModerator } from '../components/ModeratorActions';
import { PostCard } from '../components/PostCard';
import { ProfileView } from '../components/ProfileView';
import { BlockButton, FlagDialog } from '../components/SafetyControls';
import { buttonVariants } from '../components/ui/button';

// Profiles get their own page (D47), including the current user's own.
export const Route = createFileRoute('/u/$username')({ component: ProfilePage });

function ProfilePage() {
  const { username } = Route.useParams();
  const profile = useQuery(api.profiles.getPublicProfile, { username });
  const leaving = useIsLeaving();
  const isModerator = useIsModerator();
  const navigate = useNavigate();
  const now = Date.now();

  if (profile === undefined) {
    return <div className="mx-auto max-w-2xl py-8 text-foreground-muted">Loading…</div>;
  }
  if (profile === null) {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <UnavailableState
          title="Profile not available"
          message="This profile doesn’t exist or isn’t visible to you."
        />
      </div>
    );
  }

  // On your own ghosted profile there is nothing to edit — the row is empty — so the one action worth
  // offering is the way back.
  const actions = profile.isSelf ? (
    <Link to="/settings" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {leaving ? 'Cancel deletion' : 'Edit profile'}
    </Link>
  ) : (
    <>
      <BlockButton targetUserId={profile.userId} displayName={profile.displayName} />
      <FlagDialog targetType="user" targetId={profile.userId} label="Flag" />
    </>
  );

  return (
    <>
      <ProfileView
        data={{
          username: profile.username,
          displayName: profile.displayName,
          profileImageUrl: profile.profileImageUrl,
          isSelf: profile.isSelf,
          isPrivate: profile.private,
          // Owner-only: nobody else learns that this person is leaving until it's irreversible.
          isLeaving: profile.isSelf && leaving,
          trustClass: profile.trustClass,
          homeTownLabel: profile.private ? undefined : profile.homeTownLabel,
          bio: profile.private ? undefined : profile.bio,
          badges: profile.private ? undefined : profile.badges,
          bountyPoints: profile.private ? undefined : profile.bountyPoints,
          // The raw number is admin-only (D50) — pass it through solely for a moderator/admin viewer.
          adminReputationPoints:
            !profile.private && isModerator ? profile.reputationPoints : undefined,
          reportCount: profile.private ? undefined : profile.reportCount,
          commentCount: profile.private ? undefined : profile.commentCount,
        }}
        actions={actions}
        reportHistory={
          !profile.private && profile.posts.length > 0 ? (
            // The person's Posts as the feed shows them (A10 / D186) — one card builder, one look.
            <ul className="flex flex-col gap-3">
              {profile.posts.map((post) => (
                <li key={post.postId}>
                  <PostCard
                    data={post}
                    now={now}
                    onOpenReport={(reportId) =>
                      navigate({ to: '/report/$id', params: { id: reportId } })
                    }
                  />
                </li>
              ))}
            </ul>
          ) : !profile.private ? (
            <p className="text-foreground-muted text-sm">No reports yet.</p>
          ) : null
        }
      />
      <ProfileModeratorPanel userId={profile.userId} isSelf={profile.isSelf} />
    </>
  );
}
