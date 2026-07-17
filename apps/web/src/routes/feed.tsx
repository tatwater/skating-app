import { createFileRoute } from '@tanstack/react-router'
import { Panel } from '../components/Panel'
import { Placeholder } from '../components/Placeholder'
import { ProfileSearch } from '../components/ProfileSearch'

// Newsfeed: the chronological, cross-water-body co-primary page (D28). Lands in Phase 5.
export const Route = createFileRoute('/feed')({ component: FeedPage })

function FeedPage() {
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Find a skater">
        <ProfileSearch />
      </Panel>
      <Placeholder
        title="Newsfeed"
        subtitle="The cross-water-body feed — newest skate time first (D28) — lands in Phase 5. Reports are all public (D13); the Phase 3 block filter is now enforced."
      />
      <Panel title="Create a report">
        Report creation is surfaced here too, as well as on the map (D47).
      </Panel>
    </div>
  )
}
