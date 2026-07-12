import { createFileRoute } from '@tanstack/react-router'
import { Panel } from '../components/Panel'
import { Placeholder } from '../components/Placeholder'

// Newsfeed: the chronological, cross-water-body co-primary page (D28). Lands in Phase 6.
export const Route = createFileRoute('/feed')({ component: FeedPage })

function FeedPage() {
  return (
    <div className="flex flex-col gap-4">
      <Placeholder
        title="Newsfeed"
        subtitle="The cross-water-body feed — newest skate time first (D28) — lands in Phase 6, visibility-filtered once the social graph exists (Phase 3)."
      />
      <Panel title="Create a report">
        Report creation is surfaced here too, as well as on the map (D47).
      </Panel>
    </div>
  )
}
