import { useAuth, useUser } from '@clerk/tanstack-react-start'
import { api } from '@skating/convex/api'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { Button, buttonVariants } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'

/**
 * Account hub — the web analog of mobile's "You" tab (D28). Barebones for Phase 0: who
 * you're signed in as (read from the provisioned Convex `profiles` row, proving the full
 * Clerk↔Convex loop), the about/license link (D43), and sign-out. Reputation, GPS
 * connections, and notification toggles come in later phases.
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
            {profile ? `${profile.displayName} · @${profile.username}` : 'Loading your profile…'}
          </p>
          {user?.primaryEmailAddress?.emailAddress ? (
            <p className="text-foreground-muted">{user.primaryEmailAddress.emailAddress}</p>
          ) : null}
        </CardContent>
      </Card>
      <p className="text-foreground-muted text-sm">
        Reputation, GPS connections, and notification toggles arrive in later phases.
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
