import { createFileRoute } from '@tanstack/react-router'
import { DetailSheet } from '../components/DetailSheet'
import { WaterBodyDetail } from '../components/WaterBodyDetail'

// `/water/$id` — a deep-linkable water-body detail drawer over the map (D47).
export const Route = createFileRoute('/_map/water/$id')({ component: WaterRoute })

function WaterRoute() {
  const { id } = Route.useParams()
  return (
    <DetailSheet>
      <WaterBodyDetail waterBodyId={id} />
    </DetailSheet>
  )
}
