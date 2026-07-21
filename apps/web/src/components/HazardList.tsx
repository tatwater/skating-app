import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  BODY_FEATURE_CAVEAT,
  freshnessLabel,
  type HazardFreshness,
  type HazardType,
  hazardTypeLabel,
  humanizeEnum,
  isHazardVisibleByDefault,
  isPassageMarker,
  NO_ALERT_IS_NOT_ALL_CLEAR,
} from '@skating/core'
import { Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useState } from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Skeleton } from './ui/skeleton'

/** A hazard row as the list renders it. */
export interface HazardListItem {
  _id: string
  type: HazardType
  freshness: HazardFreshness
  provisional: boolean
  healingState?: 'none' | 'healing_unsafe'
}

/**
 * Presentational hazard list for a lake drawer.
 *
 * Stale hazards are **collapsed behind a toggle, never dropped** (D3). The server returns them
 * deliberately, and this is the one place the "show older" affordance lives — the distinction between
 * "nobody has checked lately" and "it's gone" has to survive all the way to the screen.
 */
export function HazardListView({
  hazards,
  knownFeatures,
}: {
  hazards: readonly HazardListItem[]
  knownFeatures: readonly { _id: string; type: string }[]
}) {
  const [showOlder, setShowOlder] = useState(false)
  const current = hazards.filter((h) => isHazardVisibleByDefault(h.freshness))
  const older = hazards.filter((h) => !isHazardVisibleByDefault(h.freshness))
  const visible = showOlder ? [...current, ...older] : current

  if (hazards.length === 0 && knownFeatures.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">Hazards</h3>

      {knownFeatures.length > 0 ? (
        <Card size="sm">
          <CardContent className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-1">
              {knownFeatures.map((f) => (
                <Badge key={f._id} variant="outline">
                  {humanizeEnum(f.type)}
                </Badge>
              ))}
            </div>
            <span className="text-foreground-muted text-xs">{BODY_FEATURE_CAVEAT}</span>
          </CardContent>
        </Card>
      ) : null}

      {visible.map((hazard) => (
        <Link key={hazard._id} to="/hazard/$id" params={{ id: hazard._id }} className="block">
          <Card size="sm" className="transition-colors hover:bg-surface-muted">
            <CardContent className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{hazardTypeLabel(hazard.type)}</span>
              <div className="flex flex-wrap gap-1">
                {isPassageMarker(hazard.type) ? <Badge variant="outline">Crossing</Badge> : null}
                {hazard.healingState === 'healing_unsafe' ? (
                  <Badge variant="secondary">Healing</Badge>
                ) : null}
                {hazard.provisional ? <Badge variant="outline">Unconfirmed</Badge> : null}
                <Badge variant={hazard.freshness === 'fresh' ? 'default' : 'secondary'}>
                  {freshnessLabel(hazard.freshness)}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}

      {visible.length === 0 && hazards.length > 0 ? (
        <p className="text-foreground-muted text-sm">
          Nothing reported recently — only older, unverified markers.
        </p>
      ) : null}

      {older.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowOlder((prev) => !prev)}
          className="self-start"
        >
          {showOlder
            ? 'Hide older markers'
            : `Show ${older.length} older marker${older.length === 1 ? '' : 's'}`}
        </Button>
      ) : null}

      {/* Stated wherever hazards are surfaced: the absence of a marker is not information (D3). */}
      <p className="text-foreground-muted text-xs">{NO_ALERT_IS_NOT_ALL_CLEAR}</p>
    </div>
  )
}

/** Container: hazards + known seasonal features for one lake. */
export function HazardList({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const hazards = useQuery(api.hazards.listForBody, { waterBodyId })
  const knownFeatures = useQuery(api.bodyFeatures.listForBody, { waterBodyId })

  if (hazards === undefined) return <Skeleton className="h-12 w-full" />

  return <HazardListView hazards={hazards} knownFeatures={knownFeatures ?? []} />
}
