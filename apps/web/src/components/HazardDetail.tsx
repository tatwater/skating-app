import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  BODY_FEATURE_CAVEAT,
  FOOTPRINT_IS_APPROXIMATE,
  freshnessLabel,
  type HazardFreshness,
  type HazardType,
  type HazardVerdict,
  hazardTypeLabel,
  healingNote,
  isPassageMarker,
  stalenessCaveat,
  verdictHelp,
  verdictLabel,
} from '@skating/core'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { type ReactNode, useEffect, useState } from 'react'
import { DetailSkeleton, UnavailableState } from './DrawerStates'
import { useMapSelection } from './MapSelectionContext'
import { FlagDialog } from './SafetyControls'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'

/** The plain data a hazard renders from — decoupled from Convex so `HazardView` is testable. */
export interface HazardViewData {
  hazardId: string
  waterBodyId: string
  bodyName?: string
  type: HazardType
  freshness: HazardFreshness
  provisional: boolean
  healing: boolean
  archived: boolean
  description?: string
  reporterName?: string
  firstReportedAt: number
  lastConfirmedAt: number
  confirmCount: number
  photos: { photoId: string; url: string | null; thumbUrl: string | null; caption?: string }[]
}

/** The three verdicts, in the order they're offered. */
const VERDICTS: HazardVerdict[] = ['still_there', 'healing_unsafe', 'fully_healed']

function formatWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${Math.round(hours)} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/**
 * Presentational hazard renderer.
 *
 * Every word describing hazard *state* comes from `@skating/core`'s copy helpers rather than being
 * written here — that's the point of centralizing them: the D3 rule "we never assert ice is safe" is
 * enforced by one tested module instead of by reviewing every component that mentions a hazard.
 */
export function HazardView({
  data,
  onConfirm,
  confirming,
  flagControl,
}: {
  data: HazardViewData
  onConfirm?: (verdict: HazardVerdict) => void
  confirming?: boolean
  /**
   * The flag control, injected by the container. It needs a Convex mutation, and this component is
   * deliberately Convex-free so it can be rendered from a fixture in a test.
   */
  flagControl?: ReactNode
}) {
  // The destructive verdict gets a confirm step. It's the only one that retires a pin for everyone,
  // and a mis-tap that clears a real hazard is the worst outcome this UI can produce (D3).
  const [pendingHealed, setPendingHealed] = useState(false)
  const passage = isPassageMarker(data.type)

  return (
    <>
      <SheetHeader>
        <SheetTitle>{hazardTypeLabel(data.type)}</SheetTitle>
        <SheetDescription>
          {data.bodyName ? (
            <Link
              to="/water/$id"
              params={{ id: data.waterBodyId }}
              className="underline underline-offset-2"
            >
              {data.bodyName}
            </Link>
          ) : null}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-4 px-4 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={data.freshness === 'fresh' ? 'default' : 'secondary'}>
            {freshnessLabel(data.freshness)}
          </Badge>
          {data.provisional ? <Badge variant="outline">Unconfirmed</Badge> : null}
          {data.healing ? <Badge variant="secondary">Reported healing</Badge> : null}
          {passage ? <Badge variant="outline">Crossing point</Badge> : null}
          {data.archived ? <Badge variant="outline">Retired</Badge> : null}
        </div>

        <p className="text-foreground-muted text-sm">
          Reported {formatWhen(data.firstReportedAt)}
          {data.reporterName ? ` by ${data.reporterName}` : ''}
          {data.confirmCount > 0
            ? ` · confirmed by ${data.confirmCount} other skater${data.confirmCount === 1 ? '' : 's'}`
            : ' · nobody else has confirmed it yet'}
          .
        </p>

        {/* The sentence that has to do the work of not sounding like an all-clear. */}
        {data.freshness !== 'fresh' ? (
          <p className="rounded-md bg-surface-muted p-3 text-sm">{stalenessCaveat(data.type)}</p>
        ) : null}
        {data.healing ? (
          <p className="rounded-md bg-surface-muted p-3 text-sm">{healingNote(data.type)}</p>
        ) : null}

        {data.description ? <p className="text-sm">{data.description}</p> : null}

        {data.photos.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {data.photos.map((photo) =>
              photo.thumbUrl ? (
                <img
                  key={photo.photoId}
                  src={photo.thumbUrl}
                  alt={photo.caption ?? `${hazardTypeLabel(data.type)} photo`}
                  className="h-32 w-full rounded-md object-cover"
                />
              ) : null,
            )}
          </div>
        ) : null}

        <p className="text-foreground-muted text-xs">{FOOTPRINT_IS_APPROXIMATE}</p>

        {onConfirm && !data.archived ? (
          <>
            <Separator />
            <div className="space-y-2">
              <h3 className="font-medium text-sm">
                {passage ? 'Been through here?' : 'Seen this recently?'}
              </h3>
              {VERDICTS.map((verdict) => {
                const destructive = verdict === 'fully_healed'
                if (destructive && pendingHealed) {
                  return (
                    <div
                      key={verdict}
                      className="space-y-2 rounded-md border border-destructive p-3"
                    >
                      <p className="text-sm">
                        This retires the marker for everyone once one more skater agrees. Only if
                        the ice here is genuinely sound.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={confirming}
                          onClick={() => {
                            setPendingHealed(false)
                            onConfirm(verdict)
                          }}
                        >
                          Yes, it's fully healed
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPendingHealed(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )
                }
                return (
                  <button
                    key={verdict}
                    type="button"
                    disabled={confirming}
                    onClick={() => (destructive ? setPendingHealed(true) : onConfirm(verdict))}
                    className={`w-full rounded-md border p-3 text-left disabled:opacity-50 ${
                      destructive
                        ? 'border-border text-foreground-muted hover:bg-surface-muted'
                        : 'border-border hover:bg-surface-muted'
                    }`}
                  >
                    <span className={destructive ? 'text-sm' : 'font-medium text-sm'}>
                      {verdictLabel(verdict, data.type)}
                    </span>
                    <span className="block text-foreground-muted text-xs">
                      {verdictHelp(verdict, data.type)}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        ) : null}

        {flagControl ? (
          <>
            <Separator />
            {flagControl}
          </>
        ) : null}
      </div>
    </>
  )
}

/** Container: resolves the hazard + its photos, pushes map focus, and wires the confirm mutation. */
export function HazardDetail({ hazardId }: { hazardId: string }) {
  const hazard = useQuery(api.hazards.get, { hazardId: hazardId as Id<'hazards'> })
  const photos = useQuery(api.photos.getHazardUrls, { hazardId: hazardId as Id<'hazards'> })
  const body = useQuery(api.waterBodies.get, hazard ? { waterBodyId: hazard.waterBodyId } : 'skip')
  const confirm = useMutation(api.hazardConfirmations.confirm)
  const [confirming, setConfirming] = useState(false)
  const { setFocus, setHighlightWaterBodyId } = useMapSelection()

  useEffect(() => {
    if (!hazard) return
    const centre = {
      lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
      lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
    }
    setFocus({ ...centre, zoom: 14 })
    setHighlightWaterBodyId(hazard.waterBodyId)
  }, [hazard, setFocus, setHighlightWaterBodyId])

  if (hazard === undefined) return <DetailSkeleton />
  if (hazard === null) {
    return (
      <UnavailableState
        title="Hazard not found"
        // Deliberately does not say the hazard is gone: it may have been hidden by a moderator, and
        // "removed from view" must never be reported to a skater as "no longer there" (D3).
        message="This marker isn't available. The link may be broken, or it may have been removed from the map."
      />
    )
  }

  const bodyName = body?.available ? body.body.name : undefined

  return (
    <HazardView
      data={{
        hazardId,
        waterBodyId: hazard.waterBodyId,
        bodyName,
        type: hazard.type,
        freshness: hazard.freshness,
        provisional: hazard.provisional,
        healing: hazard.healingState === 'healing_unsafe',
        archived: hazard.status === 'archived',
        description: hazard.description,
        firstReportedAt: hazard.firstReportedAt,
        lastConfirmedAt: hazard.lastConfirmedAt,
        confirmCount: hazard.confirmCount,
        photos: photos ?? [],
      }}
      confirming={confirming}
      flagControl={<FlagDialog targetType="hazard" targetId={hazardId} />}
      onConfirm={async (verdict) => {
        setConfirming(true)
        try {
          await confirm({
            hazardId: hazardId as Id<'hazards'>,
            verdict,
            via: 'app_open_nearby',
          })
        } finally {
          setConfirming(false)
        }
      }}
    />
  )
}

/** The always-on note under a known seasonal feature (D53) — no age, no confirm loop. */
export function BodyFeatureNote() {
  return <p className="text-foreground-muted text-xs">{BODY_FEATURE_CAVEAT}</p>
}
