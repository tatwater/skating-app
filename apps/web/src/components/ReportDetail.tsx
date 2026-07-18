import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  formatConditions,
  formatSkateTime,
  formatSkateWindow,
  formatSnowCoverInches,
  formatThicknessReading,
  humanizeEnum,
  type ReportConditions,
  SKATE_QUALITY_LABELS,
  type SkateQuality,
  type ThicknessReading,
} from '@skating/core'
import { Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useEffect } from 'react'
import { Comments } from './CommentThread'
import { DetailSkeleton, UnavailableState } from './DrawerStates'
import { useMapSelection } from './MapSelectionContext'
import { ModeratorActions } from './ModeratorActions'
import { BlockedChip, FlagDialog } from './SafetyControls'
import { Badge } from './ui/badge'
import { Separator } from './ui/separator'
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'

/** The plain data a report renders from — decoupled from Convex so `ReportView` is testable. */
export interface ReportViewData {
  waterBodyId: string
  bodyName?: string
  authorName?: string
  /** The author is in the viewer's block set — de-emphasize the line + show a "Blocked" chip (D3). */
  authorBlocked?: boolean
  /** When the skater left the ice — the primary timestamp shown (D28; Phase 5). */
  skateEndTime: number
  /** Optional — when they got on; renders the derived duration alongside the end (Phase 5). */
  skateStartTime?: number
  skateQuality?: SkateQuality
  iceTypes: string[]
  surfaceTags: string[]
  iceThickness?: { readings: ThicknessReading[] }
  snowCoverCm?: number
  conditions?: ReportConditions
  notes?: string
  photos: { photoId: string; url: string | null; thumbUrl: string | null; caption?: string }[]
}

/**
 * Presentational report renderer (§D) — every stored value shown **imperial** (D25) via the pure
 * `reportDisplay` helpers, so the formatting is unit-testable without Convex or a map. The container
 * `ReportDetail` below feeds it live data; a test can feed it a fixture.
 */
export function ReportView({ data }: { data: ReportViewData }) {
  const conditions = data.conditions ? formatConditions(data.conditions) : []
  const readings = data.iceThickness?.readings ?? []
  const duration = formatSkateWindow(data.skateEndTime, data.skateStartTime)

  return (
    <>
      <SheetHeader>
        <SheetTitle>{data.bodyName ?? 'Report'}</SheetTitle>
        <SheetDescription>
          Off the ice {formatSkateTime(data.skateEndTime)}
          {duration ? ` · skated ${duration}` : null}
          {data.authorName && !data.authorBlocked ? ` · by ${data.authorName}` : null}
          {data.authorName && data.authorBlocked ? (
            <>
              {' · by '}
              <span className="text-foreground-muted">{data.authorName}</span> <BlockedChip />
            </>
          ) : null}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {data.skateQuality ? (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="secondary">{SKATE_QUALITY_LABELS[data.skateQuality]}</Badge>
          </div>
        ) : null}

        {data.iceTypes.length > 0 ? (
          <Section label="Ice types">
            <Chips values={data.iceTypes} />
          </Section>
        ) : null}

        {data.surfaceTags.length > 0 ? (
          <Section label="Surface">
            <Chips values={data.surfaceTags} />
          </Section>
        ) : null}

        {readings.length > 0 ? (
          <Section label="Thickness">
            <ul className="flex flex-col gap-0.5 text-foreground text-sm">
              {readings.map((reading, i) => {
                const formatted = formatThicknessReading(reading)
                return formatted ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: readings are an ordered, stable list.
                  <li key={i}>{formatted}</li>
                ) : null
              })}
            </ul>
          </Section>
        ) : null}

        {data.snowCoverCm !== undefined ? (
          <Section label="Snow cover">
            <span className="text-foreground text-sm">
              {formatSnowCoverInches(data.snowCoverCm)}
            </span>
          </Section>
        ) : null}

        {conditions.length > 0 ? (
          <Section label="Conditions">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {conditions.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-foreground-muted">{row.label}</dt>
                  <dd className="text-foreground">{row.value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}

        {data.notes ? (
          <Section label="Notes">
            <p className="whitespace-pre-wrap text-foreground text-sm">{data.notes}</p>
          </Section>
        ) : null}

        {data.photos.length > 0 ? (
          <Section label="Photos">
            <div className="flex flex-wrap gap-2">
              {data.photos.map((photo) =>
                photo.thumbUrl ? (
                  <a
                    key={photo.photoId}
                    href={photo.url ?? photo.thumbUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      src={photo.thumbUrl}
                      alt={photo.caption ?? 'Report photo'}
                      className="h-24 w-24 rounded-md object-cover"
                    />
                  </a>
                ) : null,
              )}
            </div>
          </Section>
        ) : null}

        <Separator />
        <Link
          to="/water/$id"
          params={{ id: data.waterBodyId }}
          className="text-primary text-sm underline-offset-4 hover:underline"
        >
          View the lake
        </Link>
      </div>
    </>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">{label}</h3>
      {children}
    </div>
  )
}

function Chips({ values }: { values: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {humanizeEnum(value)}
        </Badge>
      ))}
    </div>
  )
}

/**
 * Container for `/report/$id`: reads the report (visibility-checked server-side), its author + lake
 * name + serving photo URLs, and pushes the lake highlight, a fly-to on the put-in point, and any
 * `placeOnMap` photo pins (D42) up to the persistent map via `useMapSelection`.
 */
export function ReportDetail({ reportId }: { reportId: string }) {
  const report = useQuery(api.reports.get, { reportId: reportId as Id<'reports'> })
  const body = useQuery(api.waterBodies.get, report ? { waterBodyId: report.waterBodyId } : 'skip')
  const authors = useQuery(
    api.profiles.publicByIds,
    report ? { profileIds: [report.authorId] } : 'skip',
  )
  const photos = useQuery(
    api.photos.getUrls,
    report && report.photoIds.length > 0 ? { reportId: report._id } : 'skip',
  )
  // The viewer's block set (both directions, D32), to de-emphasize a blocked author's report line
  // (D3). Skipped when signed out (the query requires a profile). A block never hides the report.
  const me = useQuery(api.profiles.current, {})
  const blockedIds = useQuery(api.blocks.blockedUserIds, me ? {} : 'skip')
  const { setHighlightWaterBodyId, setFocus, setPhotoPins } = useMapSelection()

  // Fly to the report's put-in point as soon as the report loads.
  useEffect(() => {
    if (report) setFocus({ lat: report.point.lat, lng: report.point.lng, zoom: 13 })
  }, [report, setFocus])

  // Highlight the lake by its *resolved survivor* id (what the map's features carry), so a report on
  // a since-merged body still highlights the right polygon — not the stale stored `waterBodyId`.
  useEffect(() => {
    if (body?.available) setHighlightWaterBodyId(body.body._id)
  }, [body, setHighlightWaterBodyId])

  useEffect(() => {
    setPhotoPins(
      (photos ?? [])
        .filter((photo) => photo.coord)
        .map((photo) => ({
          photoId: photo.photoId,
          // biome-ignore lint/style/noNonNullAssertion: filtered to photos with a coord above.
          coord: photo.coord!,
          thumbUrl: photo.thumbUrl,
        })),
    )
  }, [photos, setPhotoPins])

  if (report === undefined) return <DetailSkeleton />
  if (report === null) {
    return (
      <UnavailableState
        title="Report not available"
        message="This report may have been removed or isn't visible to you."
      />
    )
  }

  const authorBlocked = (blockedIds ?? []).includes(report.authorId)
  const isOwn = me?._id === report.authorId

  return (
    <>
      <ReportView
        data={{
          waterBodyId: report.waterBodyId,
          bodyName: body?.available ? body.body.name : undefined,
          authorName: authors?.[report.authorId]?.displayName,
          authorBlocked,
          skateEndTime: report.skateEndTime,
          skateStartTime: report.skateStartTime,
          skateQuality: report.skateQuality,
          iceTypes: report.iceTypes,
          surfaceTags: report.surfaceTags,
          iceThickness: report.iceThickness,
          snowCoverCm: report.snowCoverCm,
          conditions: report.conditions,
          notes: report.notes,
          photos: photos ?? [],
        }}
      />
      {/* Safety tools on the report (D32): flag for anyone but the author; moderator takedown. */}
      {me && !isOwn ? (
        <div className="flex flex-wrap gap-1 px-4 pb-2">
          <FlagDialog targetType="report" targetId={report._id} label="Flag report" />
          <ModeratorActions targetType="report" targetId={report._id} />
        </div>
      ) : null}
      <Comments reportId={report._id} />
    </>
  )
}
