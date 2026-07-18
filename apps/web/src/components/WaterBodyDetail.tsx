import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { formatAreaAcres, formatSkateTime, humanizeEnum, SKATE_QUALITY_LABELS } from '@skating/core'
import { Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useEffect, useState } from 'react'
import { DetailSkeleton, UnavailableState } from './DrawerStates'
import { useMapSelection } from './MapSelectionContext'
import { ReportForm } from './ReportForm'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'
import { Skeleton } from './ui/skeleton'

/**
 * Water-body detail drawer content (§D, D47) for `/water/$id`. Reads `waterBodies.get`, which
 * **follows a merge to the survivor** (a stale/merged deep link silently lands on the canonical
 * lake) and distinguishes not-found (`null`) from removed/unlisted (`{ available: false }`) so each
 * gets its own friendly state instead of a blank. Shows the name, type, imperial area (D25), and
 * the report feed newest **skate time** first; the map flies to the lake's centroid on open.
 */
export function WaterBodyDetail({ waterBodyId }: { waterBodyId: string }) {
  const result = useQuery(api.waterBodies.get, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  })
  const body = result?.available ? result.body : null
  const { setFocus, setHighlightWaterBodyId } = useMapSelection()
  const [formOpen, setFormOpen] = useState(false)

  // Once the (possibly merge-resolved) lake loads, fly the map to it and highlight it. We use the
  // resolved `body._id` — the survivor a merged deep link redirects to — which is what the map's
  // features carry, so a `/water/<merged-id>` link still highlights the right polygon.
  useEffect(() => {
    if (body) {
      setFocus({ lat: body.centroid.lat, lng: body.centroid.lng, zoom: 12 })
      setHighlightWaterBodyId(body._id)
    }
  }, [body, setFocus, setHighlightWaterBodyId])

  if (result === undefined) return <DetailSkeleton />

  if (result === null) {
    return (
      <UnavailableState
        title="Lake not found"
        message="We couldn't find this water body. The link may be broken."
      />
    )
  }
  if (!result.available) {
    return (
      <UnavailableState
        title="This lake isn't available"
        message="It may have been removed from the map. Try another lake nearby."
      />
    )
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{result.body.name}</SheetTitle>
        <SheetDescription>
          {humanizeEnum(result.body.type)}
          {result.body.surfaceAreaSqM !== undefined
            ? ` · ${formatAreaAcres(result.body.surfaceAreaSqM)}`
            : ''}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {/* Report creation surfaced in place (D47). */}
        <Button onClick={() => setFormOpen(true)}>Add a report</Button>
        <ReportFeed waterBodyId={result.body._id} />
      </div>
      {formOpen ? (
        <ReportForm
          waterBodyId={result.body._id}
          bodyName={result.body.name}
          open={formOpen}
          onOpenChange={setFormOpen}
        />
      ) : null}
    </>
  )
}

function ReportFeed({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const reports = useQuery(api.reports.listByWaterBody, { waterBodyId })
  const authorIds = reports ? [...new Set(reports.map((r) => r.authorId))] : []
  const authors = useQuery(
    api.profiles.publicByIds,
    reports && reports.length > 0 ? { profileIds: authorIds } : 'skip',
  )

  if (reports === undefined) return <Skeleton className="h-24 w-full" />
  if (reports.length === 0) {
    return (
      <p className="text-foreground-muted text-sm">
        No reports yet — be the first to say how it skates.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">Reports</h3>
      {reports.map((report) => (
        <Link key={report._id} to="/report/$id" params={{ id: report._id }} className="block">
          <Card size="sm" className="transition-colors hover:bg-surface-muted">
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground text-sm">
                  {formatSkateTime(report.skateEndTime)}
                </span>
                {report.skateQuality ? (
                  <Badge variant="secondary">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
                ) : null}
              </div>
              {report.iceTypes.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {report.iceTypes.map((iceType) => (
                    <Badge key={iceType} variant="outline">
                      {humanizeEnum(iceType)}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <span className="text-foreground-muted text-xs">
                by {authors?.[report.authorId]?.displayName ?? '…'}
              </span>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  )
}
