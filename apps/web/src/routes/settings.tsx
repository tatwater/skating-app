import { useAuth, useUser } from '@clerk/tanstack-react-start'
import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ProfileEdit } from '../components/ProfileEdit'
import { Avatar } from '../components/ProfileView'
import { Button, buttonVariants } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'

/**
 * Account hub — the web analog of mobile's "You" tab (D28). Who you're signed in as, profile
 * editing (bio / town / public↔private, D13), your blocked-users list (D32), the about/license link
 * (D43), and sign-out. GPS connections + notification toggles come in later phases.
 */
export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  const { signOut } = useAuth()
  const { user } = useUser()
  const profile = useQuery(api.profiles.current, {})

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 py-8">
      <h1 className="font-semibold text-2xl text-foreground">Settings</h1>
      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-foreground">
            {profile ? (
              <Link
                to="/u/$username"
                params={{ username: profile.username }}
                className="hover:underline"
              >
                {profile.displayName} · @{profile.username}
              </Link>
            ) : (
              'Loading your profile…'
            )}
          </p>
          {user?.primaryEmailAddress?.emailAddress ? (
            <p className="text-foreground-muted">{user.primaryEmailAddress.emailAddress}</p>
          ) : null}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Your profile
        </h2>
        <ProfileEdit />
      </section>

      <BlockedUsers />

      <p className="text-foreground-muted text-sm">
        GPS connections and notification toggles arrive in later phases.
      </p>
      <div className="flex gap-3">
        <Link to="/about" className={buttonVariants({ variant: 'outline' })}>
          About &amp; licenses
        </Link>
        <Button variant="destructive" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  )
}

/** The caller's blocked users (D32) with an unblock control. A block never hid their reports (D3). */
function BlockedUsers() {
  const blocks = useQuery(api.blocks.myBlocks, {})
  const unblock = useMutation(api.blocks.unblock)

  if (blocks === undefined || blocks.length === 0) return null

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Blocked users
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2">
          {blocks.map((b) => (
            <div key={b.userId} className="flex items-center gap-2">
              <Avatar displayName={b.displayName} imageUrl={b.profileImageUrl} size={28} />
              <span className="flex-1 text-foreground text-sm">
                {b.displayName} · @{b.username}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => unblock({ targetUserId: b.userId as Id<'profiles'> })}
              >
                Unblock
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  )
}
