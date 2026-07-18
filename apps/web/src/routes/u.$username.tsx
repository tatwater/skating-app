import { api } from '@skating/convex/api'
import { formatSkateTime, humanizeEnum } from '@skating/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { UnavailableState } from '../components/DrawerStates'
import { ProfileView } from '../components/ProfileView'
import { BlockButton, FlagDialog } from '../components/SafetyControls'
import { Badge } from '../components/ui/badge'
import { buttonVariants } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'

// Profiles get their own page (D47), including the current user's own.
export const Route = createFileRoute('/u/$username')({ component: ProfilePage })

function ProfilePage() {
  const { username } = Route.useParams()
  const profile = useQuery(api.profiles.getPublicProfile, { username })

  if (profile === undefined) {
    return <div className="mx-auto max-w-2xl py-8 text-foreground-muted">Loading…</div>
  }
  if (profile === null) {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <UnavailableState
          title="Profile not available"
          message="This profile doesn’t exist or isn’t visible to you."
        />
      </div>
    )
  }

  const actions = profile.isSelf ? (
    <Link to="/settings" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      Edit profile
    </Link>
  ) : (
    <>
      <BlockButton targetUserId={profile.userId} displayName={profile.displayName} />
      <FlagDialog targetType="user" targetId={profile.userId} label="Flag" />
    </>
  )

  return (
    <ProfileView
      data={{
        username: profile.username,
        displayName: profile.displayName,
        profileImageUrl: profile.profileImageUrl,
        isSelf: profile.isSelf,
        isPrivate: profile.private,
        homeTownLabel: profile.private ? undefined : profile.homeTownLabel,
        bio: profile.private ? undefined : profile.bio,
        reputationPoints: profile.private ? undefined : profile.reputationPoints,
        reportCount: profile.private ? undefined : profile.reportCount,
        commentCount: profile.private ? undefined : profile.commentCount,
      }}
      actions={actions}
      reportHistory={
        !profile.private && profile.reports.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {profile.reports.map(({ report, waterBodyName }) => (
              <li key={report._id}>
                <Link to="/report/$id" params={{ id: report._id }}>
                  <Card className="transition-colors hover:border-primary">
                    <CardContent className="flex items-center justify-between gap-2 py-3">
                      <div className="flex flex-col">
                        <span className="text-foreground text-sm">{waterBodyName}</span>
                        <span className="text-foreground-muted text-xs">
                          {formatSkateTime(report.skateEndTime)}
                        </span>
                      </div>
                      {report.skateQuality ? (
                        <Badge variant="secondary">{humanizeEnum(report.skateQuality)}</Badge>
                      ) : null}
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        ) : !profile.private ? (
          <p className="text-foreground-muted text-sm">No reports yet.</p>
        ) : null
      }
    />
  )
}
