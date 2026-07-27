import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  formatConditions,
  formatLocationLine,
  formatSkateTime,
  formatSkateWindow,
  formatSnowCoverInches,
  formatThicknessReading,
  type ReportConditions,
  reportStripState,
  SKATE_QUALITY_LABELS,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Image, Pressable } from 'react-native';
import { H4, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';
import { Comments } from './CommentThread';
import { Badge, Chips, DetailLoading, Section, Unavailable } from './detailUi';
import { useMapSelection } from './MapSelectionContext';
import { ModeratorActions } from './ModeratorActions';
import { BlockedChip, FlagControl } from './SafetyControls';
import { ThumbControl } from './ThumbControl';
import { TrustAvatar } from './TrustDisplay';
import { WeatherStrip } from './WeatherStrip';

/**
 * Report detail drawer (§F, D42/D47) for `/report/[id]`, the mobile mirror of web's `ReportDetail`.
 * Reads the report (visibility-checked server-side), its author + lake name + serving photo URLs,
 * and pushes the lake highlight, a fly-to on the put-in point, and any `placeOnMap` photo pins up to
 * the persistent map via `useMapSelection`. Every stored value renders **imperial** (D25) via the
 * shared `@skating/core` formatters.
 */
export function ReportDetail({ reportId }: { reportId: string }) {
  const router = useRouter();
  const report = useQuery(api.reports.get, { reportId: reportId as Id<'reports'> });
  const body = useQuery(api.waterBodies.get, report ? { waterBodyId: report.waterBodyId } : 'skip');
  const authors = useQuery(
    api.profiles.publicByIds,
    report ? { profileIds: [report.authorId] } : 'skip',
  );
  const photos = useQuery(
    api.photos.getUrls,
    report && report.photoIds.length > 0 ? { reportId: report._id } : 'skip',
  );
  // The viewer's own blocks, to de-emphasize a blocked author's report line (D3). A block never
  // hides the report itself. Skipped when signed out (the query requires a profile).
  const me = useQuery(api.profiles.current, {});
  const blockedIds = useQuery(api.blocks.blockedUserIds, me ? {} : 'skip');
  const { setHighlightWaterBodyId, setFocus, setPhotoPins, setTrackPath } = useMapSelection();

  // The recorded GPS path behind this report (Phase 8), when there is one — most reports have none
  // (D24), so this resolves to null and the layer stays empty.
  const track = useQuery(api.gpsActivities.getForReport, { reportId: reportId as Id<'reports'> });

  // Fly to the report's put-in point as soon as the report loads.
  useEffect(() => {
    if (report) setFocus({ lat: report.point.lat, lng: report.point.lng, zoom: 13 });
  }, [report, setFocus]);

  // Highlight the lake by its *resolved survivor* id (what the map's features carry).
  useEffect(() => {
    if (body?.available) setHighlightWaterBodyId(body.body._id);
  }, [body, setHighlightWaterBodyId]);

  useEffect(() => {
    setPhotoPins(
      (photos ?? [])
        .filter((photo) => photo.coord)
        .map((photo) => ({
          photoId: photo.photoId,
          // biome-ignore lint/style/noNonNullAssertion: filtered to photos with a coord above.
          coord: photo.coord!,
        })),
    );
  }, [photos, setPhotoPins]);

  // Draw the path while this sheet is open and clear it on close — the map is persistent, so a path
  // left behind would hang over the next report.
  useEffect(() => {
    setTrackPath(track?.path ?? null);
    return () => setTrackPath(null);
  }, [track, setTrackPath]);

  if (report === undefined) return <DetailLoading />;
  if (report === null) {
    return (
      <Unavailable
        title="Report not available"
        message="This report may have been removed, or isn't shared with you."
      />
    );
  }

  const bodyName = body?.available ? body.body.name : undefined;
  const author = authors?.[report.authorId];
  const authorName = author?.displayName;
  const authorBlocked = (blockedIds ?? []).includes(report.authorId);
  const isOwn = me?._id === report.authorId;
  const readings = report.iceThickness?.readings ?? [];
  const conditions = report.conditions
    ? formatConditions({
        ...report.conditions,
        source: report.conditions.source ?? 'user',
      } as ReportConditions)
    : [];

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        {/* Composed through `@skating/core`, never assembled here (N2/D60): the bay name goes ahead
            of the lake, and this screen is the reason that helper exists — the mobile feed card was
            already showing "Malletts Bay" while this one still said "Lake Champlain". */}
        <H4 color="$foreground">
          {bodyName
            ? formatLocationLine({
                ...(report.subAreaName !== undefined ? { subAreaName: report.subAreaName } : {}),
                bodyName,
              })
            : 'Report'}
        </H4>
        <Text color="$foregroundMuted">
          Off the ice {formatSkateTime(report.skateEndTime)}
          {(() => {
            const duration = formatSkateWindow(report.skateEndTime, report.skateStartTime);
            return duration ? ` · skated ${duration}` : '';
          })()}
        </Text>
        {authorName ? (
          <XStack gap="$1.5" alignItems="center" flexWrap="wrap">
            <TrustAvatar
              displayName={authorName}
              imageUrl={author?.profileImageUrl}
              trustClass={author?.trustClass}
              size={20}
            />
            <Text color={authorBlocked ? '$foregroundMuted' : '$foreground'} fontSize={13}>
              by {authorName}
            </Text>
            {authorBlocked ? <BlockedChip /> : null}
          </XStack>
        ) : null}
      </YStack>

      {report.skateQuality || report.conflicting ? (
        <XStack gap="$1.5" flexWrap="wrap" alignItems="center">
          {report.skateQuality ? (
            <Badge tone="solid">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
          ) : null}
          {report.conflicting ? <Badge>Conflicting reports</Badge> : null}
        </XStack>
      ) : null}

      {report.iceTypes && report.iceTypes.length > 0 ? (
        <Section label="Ice types">
          <Chips values={report.iceTypes} />
        </Section>
      ) : null}

      {report.surfaceTags && report.surfaceTags.length > 0 ? (
        <Section label="Surface">
          <Chips values={report.surfaceTags} />
        </Section>
      ) : null}

      {readings.length > 0 ? (
        <Section label="Thickness">
          <YStack gap="$0.5">
            {readings.map((reading, i) => {
              const formatted = formatThicknessReading(reading);
              return formatted ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: readings are an ordered, stable list.
                <Text key={i} color="$foreground">
                  {formatted}
                </Text>
              ) : null;
            })}
          </YStack>
        </Section>
      ) : null}

      {report.snowCoverCm !== undefined ? (
        <Section label="Snow cover">
          <Text color="$foreground">{formatSnowCoverInches(report.snowCoverCm)}</Text>
        </Section>
      ) : null}

      {conditions.length > 0 ? (
        <Section label="Conditions">
          <YStack gap="$1">
            {conditions.map((row) => (
              <XStack key={row.label} justifyContent="space-between">
                <Text color="$foregroundMuted">{row.label}</Text>
                <Text color="$foreground">{row.value}</Text>
              </XStack>
            ))}
          </YStack>
        </Section>
      ) : null}

      {(() => {
        // Weather-since strip (§3): shown once the report is >~6h old, gone past ~14d (the header's
        // "off the ice <date>" already carries the age line).
        const strip = reportStripState(report.skateEndTime, Date.now());
        return strip.kind === 'strip' ? (
          // The server derives the window (body, put-in sample point, skate time) from the report id.
          <WeatherStrip reportId={report._id} label="Weather since this report" />
        ) : null;
      })()}

      {report.notes ? (
        <Section label="Notes">
          <Paragraph color="$foreground">{report.notes}</Paragraph>
        </Section>
      ) : null}

      {photos && photos.length > 0 ? (
        <Section label="Photos">
          <XStack gap="$2" flexWrap="wrap">
            {photos.map((photo) =>
              photo.thumbUrl ? (
                <Pressable
                  key={photo.photoId}
                  onPress={() => {
                    const full = photo.url ?? photo.thumbUrl;
                    if (full) WebBrowser.openBrowserAsync(full);
                  }}
                >
                  <Image
                    source={{ uri: photo.thumbUrl }}
                    style={{ width: 96, height: 96, borderRadius: 8 }}
                    accessibilityLabel={photo.caption ?? 'Report photo'}
                  />
                </Pressable>
              ) : null,
            )}
          </XStack>
        </Section>
      ) : null}

      <Separator />
      <Text
        color="$primary"
        onPress={() =>
          router.navigate({ pathname: '/water/[id]', params: { id: report.waterBodyId } })
        }
      >
        View the lake
      </Text>

      {/* The drawn line stops short of where the skater got on and off the ice, because this report
          withheld its put-in (D58 §3). Said out loud rather than left to look like the whole skate —
          a silently shortened track is the same quiet lie as a silently truncated list. */}
      {track?.clipped ? (
        <Text color="$foregroundMuted" fontSize={12}>
          Start and end of this track are hidden — the skater didn’t share their put-in.
        </Text>
      ) : null}

      {/* Thumbs (D50): counts visible to all; rating enabled for a signed-in non-author. */}
      <Separator />
      <ThumbControl targetType="report" targetId={report._id} canRate={!!me && !isOwn} />

      {/* Safety tools on the report (D32): flag for anyone but the author; moderator takedown. */}
      {me && !isOwn ? (
        <XStack gap="$2" flexWrap="wrap" alignItems="flex-start">
          <FlagControl targetType="report" targetId={report._id} label="Flag report" />
          <ModeratorActions targetType="report" targetId={report._id} />
        </XStack>
      ) : null}

      <Comments reportId={report._id} />
    </YStack>
  );
}
