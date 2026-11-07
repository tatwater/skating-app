import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPen } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  describeLocatedChip,
  describeSighting,
  describeSnow,
  formatConditions,
  formatLocationLine,
  formatSeason,
  formatSkateWindow,
  formatThicknessReading,
  isLeaving,
  OBSERVED_FROM_LABELS,
  reportStripState,
  SKATE_QUALITY_LABELS,
  SUITABILITY_LABELS,
  seasonOf,
  sightingsOf,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../kit/alert-dialog';
import { Button } from '../../kit/button';
import { ModeratorActions } from '../../ModeratorActions';
import { RevisionHistory } from '../../RevisionHistory';
import { defineMapSpec, panelMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { Comments } from './CommentThread';
import { FlagDialog } from './FlagDialog';
import { InsetCard, PanelLoading, PanelUnavailable } from './InsetCard';
import { panelTriggerKey, useClosePanel, usePanelViewed } from './panelNavigation';
import { clockLabel, dayLabel } from './panelTime';
import { RatingsRow, writeError } from './RatingsRow';
import { type ReportPanelData, ReportPanelView } from './ReportPanelView';
import { photosOverlay, trackOverlay } from './reportMap';
import { WeatherSince } from './WeatherSince';

/** While the card resolves, the map stays where it is: no focus, no fit. */
export const PANEL_LOADING_SPEC = defineMapSpec({
  id: 'panel-loading',
  dock: { zoom: true, layers: true },
});

/**
 * `/report/$id` (boards 2.4/2.5): the report as an inset card over its lake. Reads the report
 * (visibility-checked server-side), its post's words, its author, its photos and its path; frames
 * the lake on the map with the path and the photo pins (`panelMapSpec`); and wires the thumbs, the
 * flag, the comments, and the author's own edit and delete.
 */
export function ReportPanel({ reportId }: { reportId: string }) {
  const rid = reportId as Id<'reports'>;
  const now = useMemo(() => Date.now(), []);
  const report = useQuery(api.reports.get, { reportId: rid });
  const post = useQuery(api.posts.getForReport, { reportId: rid });
  const body = useQuery(api.waterBodies.get, report ? { waterBodyId: report.waterBodyId } : 'skip');
  const authors = useQuery(
    api.profiles.publicByIds,
    report ? { profileIds: [report.authorId] } : 'skip',
  );
  const photos = useQuery(
    api.photos.getUrls,
    report && report.photoIds.length > 0 ? { reportId: rid } : 'skip',
  );
  const track = useQuery(api.gpsActivities.getForReport, { reportId: rid });
  // The viewer's block set (both directions, D32): a blocked author's report dims, never hides (D3).
  const me = useQuery(api.profiles.current, {});
  const blockedIds = useQuery(api.blocks.blockedUserIds, me ? {} : 'skip');
  const isOwn = !!me && !!report && me._id === report.authorId;
  // Only the author's own report has a number to show (D170); everyone else would hold a live
  // query that can only ever say 0.
  const answered = useQuery(api.bounties.answeredByMyReport, isOwn ? { reportId: rid } : 'skip');

  // The map follows the lake by its *survivor* id (what the map's features carry, D36).
  const bodyId = body?.available ? body.body._id : report?.waterBodyId;
  // Convex hands back the same object until the data changes, so these hold still between renders.
  const track$ = useMemo(() => trackOverlay(reportId, track), [reportId, track]);
  const photos$ = useMemo(() => photosOverlay(reportId, photos), [reportId, photos]);
  const spec = useMemo(
    () =>
      bodyId === undefined
        ? PANEL_LOADING_SPEC
        : panelMapSpec(bodyId, { track: track$, photos: photos$ }),
    [bodyId, track$, photos$],
  );
  useMapSpec(spec);

  usePanelViewed('report_viewed', reportId);
  const lake = bodyId === undefined ? null : { bodyId };
  const close = useClosePanel(lake);
  const lakeName = body?.available ? body.body.name : null;

  const common = {
    onClose: close,
    returnKey: panelTriggerKey('report', reportId),
    label: 'Report',
  };

  if (report === undefined) {
    return (
      <InsetCard {...common} backTo={null}>
        <PanelLoading />
      </InsetCard>
    );
  }
  if (report === null) {
    return (
      <InsetCard {...common} backTo="Explore">
        <PanelUnavailable title="Report not available">
          This report may have been removed, or it isn’t visible to you.
        </PanelUnavailable>
      </InsetCard>
    );
  }

  const author = authors?.[report.authorId] ?? null;
  const authorBlocked = (blockedIds ?? []).includes(report.authorId);
  const leaving = isLeaving(me);
  const duration = formatSkateWindow(report.skateEndTime, report.skateStartTime);
  const pastSeason = seasonOf(report.skateEndTime) !== seasonOf(now);
  const snow = report.snow ? describeSnow(report.snow) : null;
  const data: ReportPanelData = {
    reportId,
    title: formatLocationLine({
      ...(report.subAreaName !== undefined ? { subAreaName: report.subAreaName } : {}),
      ...(report.subAreaNames !== undefined ? { subAreaNames: report.subAreaNames } : {}),
      bodyName: lakeName ?? 'Report',
    }),
    when: [
      `${dayLabel(report.skateEndTime, now)} · off the ice ${clockLabel(report.skateEndTime)}`,
      duration !== null ? `skated ${duration}` : null,
      // A past season still resolves by permalink (D63), and says which winter it's from.
      pastSeason ? `from the ${formatSeason(seasonOf(report.skateEndTime))} season` : null,
      report.editedAt !== undefined ? 'edited' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
    author:
      author === null
        ? null
        : {
            displayName: author.displayName,
            username: author.username,
            ...(author.profileImageUrl !== undefined
              ? { profileImageUrl: author.profileImageUrl }
              : {}),
            ...(author.deleted ? { deleted: true as const } : {}),
          },
    authorBlocked,
    claims: {
      suitabilityLabel: report.suitability ? SUITABILITY_LABELS[report.suitability] : null,
      isDontGo: report.suitability === 'dont_go',
      qualityLabel: report.skateQuality ? SKATE_QUALITY_LABELS[report.skateQuality] : null,
      vantageLabel:
        report.observedFrom && report.observedFrom !== 'on_ice'
          ? OBSERVED_FROM_LABELS[report.observedFrom]
          : null,
      // Two sightings that read the same are said once.
      sightingLabels: [
        ...new Set(sightingsOf(report).map((s) => describeSighting(s, report.bayNames))),
      ],
      conflicting: report.conflicting === true,
    },
    ...(post?.title !== undefined ? { postTitle: post.title } : {}),
    ...(post?.body !== undefined ? { postBody: post.body } : {}),
    iceTypes: report.iceTypes.map((chip) => describeLocatedChip(chip, report.bayNames)),
    surfaceTags: report.surfaceTags.map((chip) => describeLocatedChip(chip, report.bayNames)),
    thickness: (report.iceThickness?.readings ?? [])
      .map((reading) => formatThicknessReading(reading))
      .filter((line): line is string => !!line),
    snow,
    conditions: report.conditions ? formatConditions(report.conditions) : [],
    ...(report.notes !== undefined ? { notes: report.notes } : {}),
    siblings: post?.siblings ?? [],
    photos: photos ?? [],
    trackClipped: track?.clipped === true,
    bountiesAnswered: answered ?? 0,
  };

  // The weather since: once the report is some hours old, and gone again past a couple of weeks.
  const strip = reportStripState(report.skateEndTime, now);
  const weather =
    strip.kind === 'strip' ? (
      <WeatherSince
        reportId={reportId}
        label="Weather since this report"
        since={`Since ${clockLabel(report.skateEndTime)}`}
      />
    ) : undefined;

  const foot =
    isOwn && me ? (
      report.moderationStatus === 'visible' && !leaving ? (
        <OwnActions reportId={reportId} />
      ) : undefined
    ) : (
      <>
        <RatingsRow targetType="report" targetId={reportId} canRate={!!me && !leaving} />
        {me ? (
          <span className="ml-auto">
            <FlagDialog target="report" targetId={reportId} />
          </span>
        ) : null}
      </>
    );

  return (
    <InsetCard {...common} backTo={lakeName} foot={foot}>
      <ReportPanelView
        data={data}
        weather={weather}
        comments={<Comments reportId={reportId} now={now} />}
      />
      {me && !isOwn ? <ModeratorTools reportId={reportId} postId={report.postId ?? null} /> : null}
    </InsetCard>
  );
}

/**
 * A moderator's levers on the report and its post (D32, D205): takedown and the edit history. Each
 * renders nothing for anyone else, so the section only appears for a moderator. They keep the old
 * console's skin until the console's report tools replace them.
 */
function ModeratorTools({ reportId, postId }: { reportId: string; postId: string | null }) {
  return (
    <div
      data-slot="report-moderator"
      className="flex flex-wrap items-center gap-(--space-1) empty:hidden"
    >
      <ModeratorActions targetType="report" targetId={reportId} />
      {postId !== null && (
        <ModeratorActions targetType="post" targetId={postId} label="Moderate post" />
      )}
      <RevisionHistory targetType="report" targetId={reportId} />
      {postId !== null && <RevisionHistory targetType="post" targetId={postId} />}
    </div>
  );
}

/**
 * The author's own: Edit opens the report sheet over this card (`?post=<id>`, D242); Delete is
 * soft and audited (A10-3) — it takes the report off the lake and the feed, so it asks first, and
 * it's red only once armed.
 */
function OwnActions({ reportId }: { reportId: string }) {
  const navigate = useNavigate();
  const remove = useMutation(api.reports.remove);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        data-attr="report-edit"
        onClick={() =>
          void navigate({
            to: '/report/$id',
            params: { id: reportId },
            search: (prev) => ({ ...prev, post: reportId }),
          })
        }
      >
        <FontAwesomeIcon icon={faPen} aria-hidden="true" className="h-[0.8125rem]" />
        Edit report
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <AlertDialogTrigger
          data-attr="report-delete"
          render={<Button size="sm" className="ml-auto text-bad inset-ring-bad" />}
        >
          Delete
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this report?</AlertDialogTitle>
            <AlertDialogDescription>
              It comes off the lake and the feed. A moderator can still read it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error !== null && (
            <AlertDialogBody>
              <AlertDialogError title="Not deleted.">{error}</AlertDialogError>
            </AlertDialogBody>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction
              destructive
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await remove({ reportId: reportId as Id<'reports'> });
                  setOpen(false);
                } catch (err) {
                  setError(writeError(err, 'Check your connection and try again.'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete report
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
