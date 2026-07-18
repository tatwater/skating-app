import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { formatAreaAcres, formatSkateTime, humanizeEnum, SKATE_QUALITY_LABELS } from '@skating/core'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import type { MultiPolygon, Polygon } from 'geojson'
import { useEffect, useState } from 'react'
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui'
import { cacheBody } from '../lib/bodyCache'
import { Badge, DetailLoading, Section, Unavailable } from './detailUi'
import { useMapSelection } from './MapSelectionContext'
import { ReportForm } from './ReportForm'

/**
 * Water-body detail drawer (§F, D47) for `/water/[id]`, the mobile mirror of web's `WaterBodyDetail`.
 * Reads `waterBodies.get`, which **follows a merge to the survivor** (a stale/merged deep link
 * silently lands on the canonical lake) and distinguishes not-found (`null`) from removed/unlisted
 * (`{ available: false }`) so each gets its own friendly state. Shows name, type, imperial area
 * (D25), and the report feed newest **skate time** first; the map flies to the lake's centroid on
 * open. "Add a report" swaps the feed for the create form in place (D47), kept mounted in this same
 * sheet so its state survives the put-in-pin peek.
 */
export function WaterBodyDetail({ waterBodyId }: { waterBodyId: string }) {
  const result = useQuery(api.waterBodies.get, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  })
  const body = result?.available ? result.body : null
  const { setFocus, setHighlightWaterBodyId } = useMapSelection()
  const [formOpen, setFormOpen] = useState(false)

  // Once the (possibly merge-resolved) lake loads, fly the map to it and highlight it by the
  // *resolved* `_id` — the survivor a merged deep link redirects to, which is what the map carries.
  useEffect(() => {
    if (body) {
      // Pass the lake's bbox so the map zoom-to-fits it into the area above the drawer (falls back to
      // the centroid for anything without bounds).
      setFocus({ lat: body.centroid.lat, lng: body.centroid.lng, bounds: body.bbox })
      setHighlightWaterBodyId(body._id)
      // Cache this viewed lake's reference data on-device (F2 Layer 2) so it can be GPS-resolved
      // offline for a no-signal report. Best-effort; the sqlite write never blocks viewing.
      cacheBody({
        waterBodyId: body._id,
        name: body.name,
        states: body.states,
        polygon: body.polygon as unknown as Polygon | MultiPolygon,
        centroid: body.centroid,
        surfaceAreaSqM: body.surfaceAreaSqM,
      })
    }
  }, [body, setFocus, setHighlightWaterBodyId])

  if (result === undefined) return <DetailLoading />
  if (result === null) {
    return (
      <Unavailable
        title="Lake not found"
        message="We couldn't find this water body. The link may be broken."
      />
    )
  }
  if (!result.available) {
    return (
      <Unavailable
        title="This lake isn't available"
        message="It may have been removed from the map. Try another lake nearby."
      />
    )
  }

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <H4 color="$foreground">{result.body.name}</H4>
        <Text color="$foregroundMuted">
          {humanizeEnum(result.body.type)}
          {result.body.surfaceAreaSqM !== undefined
            ? ` · ${formatAreaAcres(result.body.surfaceAreaSqM)}`
            : ''}
        </Text>
      </YStack>

      {formOpen ? (
        <ReportForm
          waterBodyId={result.body._id}
          bodyName={result.body.name}
          onClose={() => setFormOpen(false)}
        />
      ) : (
        <>
          {/* Report creation surfaced in place (D47). */}
          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            onPress={() => setFormOpen(true)}
          >
            Add a report
          </Button>
          <ReportFeed waterBodyId={result.body._id} />
        </>
      )}
    </YStack>
  )
}

function ReportFeed({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const router = useRouter()
  const reports = useQuery(api.reports.listByWaterBody, { waterBodyId })
  const authorIds = reports ? [...new Set(reports.map((r) => r.authorId))] : []
  const authors = useQuery(
    api.profiles.publicByIds,
    reports && reports.length > 0 ? { profileIds: authorIds } : 'skip',
  )

  if (reports === undefined) return <DetailLoading />
  if (reports.length === 0) {
    return (
      <Paragraph color="$foregroundMuted">
        No reports yet — be the first to say how it skates.
      </Paragraph>
    )
  }

  return (
    <YStack gap="$2">
      <Section label="Reports">
        <YStack gap="$2">
          {reports.map((report) => (
            <YStack
              key={report._id}
              gap="$2"
              padding="$3"
              borderWidth={1}
              borderColor="$border"
              borderRadius="$4"
              backgroundColor="$surfaceMuted"
              pressStyle={{ opacity: 0.7 }}
              onPress={() =>
                router.navigate({ pathname: '/report/[id]', params: { id: report._id } })
              }
            >
              <XStack justifyContent="space-between" alignItems="center" gap="$2">
                <Text color="$foreground">{formatSkateTime(report.skateEndTime)}</Text>
                {report.skateQuality ? (
                  <Badge tone="solid">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
                ) : null}
              </XStack>
              {report.iceTypes.length > 0 ? (
                <XStack gap="$1.5" flexWrap="wrap">
                  {report.iceTypes.map((iceType) => (
                    <Badge key={iceType}>{humanizeEnum(iceType)}</Badge>
                  ))}
                </XStack>
              ) : null}
              <Text color="$foregroundMuted" fontSize={12}>
                by {authors?.[report.authorId]?.displayName ?? '…'}
              </Text>
            </YStack>
          ))}
        </YStack>
      </Section>
    </YStack>
  )
}
