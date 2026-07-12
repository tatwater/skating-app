import { api } from '@skating/convex/api'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { Placeholder } from '../components/Placeholder'

// Profiles get their own page (D47), including the current user's own. Details land later.
export const Route = createFileRoute('/u/$username')({ component: ProfilePage })

function ProfilePage() {
  const { username } = Route.useParams()
  const me = useQuery(api.profiles.current, {})
  const isSelf = me?.username === username

  return (
    <Placeholder
      title={`@${username}`}
      subtitle={
        isSelf
          ? 'This is your profile. Reputation, your reports, and connections land in later phases.'
          : 'Public profiles land in a later phase — reputation, recent reports, and follows.'
      }
    />
  )
}
