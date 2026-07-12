import { createFileRoute } from '@tanstack/react-router'
import { Panel } from '../components/Panel'
import { Placeholder } from '../components/Placeholder'

// Map is the default top-level page (D20/D28). MapLibre renderer lands in Phase 2.
export const Route = createFileRoute('/')({ component: MapPage })

function MapPage() {
  return (
    <div className="flex flex-col gap-4">
      <Placeholder
        title="Map"
        subtitle="The wintery, water-focused MapLibre map lands in Phase 2. Creating a report and browsing bounties will live right here on the map (D47), not on separate pages."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Create a report">
          Report creation is surfaced here on the map and on the Newsfeed (D47) — it arrives with
          the map in Phase 2.
        </Panel>
        <Panel title="Bounties">
          Bounty requests are inherently spatial, so they live on the map (D47) — Phase 9.
        </Panel>
      </div>
    </div>
  )
}
