import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { type DirectionsPlatform, directionsUrl } from '@skating/core'
import { useQuery } from 'convex/react'
import { buttonVariants } from './ui/button'

/** Detect the platform for the directions deep link — Apple Maps on iOS, Google Maps elsewhere. */
function detectPlatform(): DirectionsPlatform {
  if (typeof navigator === 'undefined') return 'web'
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : 'web'
}

/**
 * Directions button on the lake detail drawer (Phase 4, decision #7). Targets a **put-in coord**, never
 * the on-water centroid (which would route you into the middle of the lake). Uses the highest-priority
 * marker from `putIns.listForBody` (official first, else the top derived cluster). Renders nothing when
 * a lake has no known put-in yet — there's nothing safe to route to.
 */
export function DirectionsButton({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const markers = useQuery(api.putIns.listForBody, { waterBodyId })
  if (markers === undefined || markers.length === 0) return null
  const target = markers[0]
  if (!target) return null

  return (
    <a
      href={directionsUrl(target.coord, detectPlatform())}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: 'outline' })}
    >
      Directions{target.source === 'official' ? '' : ' (approx. put-in)'}
    </a>
  )
}
