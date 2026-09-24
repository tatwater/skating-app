import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  describeLocatedChip,
  describeSnow,
  formatConditions,
  formatLocationLine,
  formatSeason,
  formatSkateTime,
  formatSkateWindow,
  formatThicknessReading,
  isLeaving,
  OBSERVED_FROM_LABELS,
  type ReportConditions,
  reportStripState,
  SIGHTING_LABELS,
  SKATE_QUALITY_LABELS,
  SUITABILITY_LABELS,
  seasonOf,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Alert, Image, Pressable } from 'react-native';
import { Button, H4, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';
import { doorHref } from '../lib/sheetDoors';
import { Comments } from './CommentThread';
import { Badge, Chips, DetailLoading, Section, Unavailable } from './detailUi';
import { useMapSelection } from './MapSelectionContext';
import { ModeratorActions } from './ModeratorActions';
import { BlockedChip, FlagControl } from './SafetyControls';
import { ThumbControl } from './ThumbControl';
import { TrustAvatar } from './TrustDisplay';
import { WeatherStrip } from './WeatherStrip';

/**
 * Report detail drawer (§6, D42/D47) for `/report/[id]`, the mobile mirror of web's `ReportDetail`.
 * Reads the report (visibility-checked server-side), its author + lake name + serving photo URLs,
 * and pushes the lake highlight, a fly-to on the put-in point, and any `placeOnMap` photo pins up to
 * the persistent map via `useMapSelection`. Every stored value renders **imperial** (D25) via the
 * shared `@skating/core` formatters.
 */
export function ReportDetail({ reportId }: { reportId: string }) {
  const router = useRouter();
  const report = useQuery(api.reports.get, { reportId: reportId as Id<'reports'> });
  // The Post's words and its other lakes (A10 / D186); `null` until it loads or when not visible.
  const post = useQuery(api.posts.getForReport, { reportId: reportId as Id<'reports'> });
  const body = useQuery(api.waterBodies.get, report ? { waterBodyId: report.waterBodyId } : 'skip');
  // The author's own takedown (A10-3): soft, audited, the Post with the last Report (D186).
  const removeReport = useMutation(api.reports.remove);
  const [deleting, setDeleting] = useState(false);
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
  // The author's "people were waiting for this" line (A08 / D170) — 0 for anyone but the author (the
  // server re-checks), so only the author subscribes rather than every reader holding a query that
  // can only ever say 0.
  const bountiesAnswered = useQuery(
    api.bounties.answeredByMyReport,
    me && report && me._id === report.authorId ? { reportId: report._id } : 'skip',
  );
  const { setHighlightWaterBodyId, setFocus, setPhotoPins, setTrackPath } = useMapSelection();

  // The recorded GPS path behind this report (Phase 08), when there is one — most reports have none
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
  const snow = report.snow ? describeSnow(report.snow) : null;
  const conditions = report.conditions
    ? formatConditions({
        ...report.conditions,
        source: report.conditions.source ?? 'user',
      } as ReportConditions)
    : [];

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        {/* Composed through `@skating/core`, never assembled here (A02/D60): the bay name goes ahead
            of the lake, and this screen is the reason that helper exists — the mobile feed card was
            already showing "Malletts Bay" while this one still said "Lake Champlain". */}
        <H4 color="$foreground">
          {bodyName
            ? formatLocationLine({
                ...(report.subAreaName !== undefined ? { subAreaName: report.subAreaName } : {}),
                ...(report.subAreaNames !== undefined ? { subAreaNames: report.subAreaNames } : {}),
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
          {/* A past season still resolves by permalink — a link or an old notification must not 404
              (D63) — and says which winter it is from, because an old report rendering exactly like
              Tuesday's is the thing seasons exist to stop. */}
          {seasonOf(report.skateEndTime) === seasonOf(Date.now())
            ? ''
            : ` · from the ${formatSeason(seasonOf(report.skateEndTime))} season`}
          {report.editedAt ? ' · edited' : ''}
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

      {/* The who-claim leads (D3 / D190): "Don't go" before "Great", in the warning treatment;
          then the vantage when it was not the ice (D191), and what a shore observer saw. */}
      {report.suitability ||
      report.skateQuality ||
      (report.observedFrom && report.observedFrom !== 'on_ice') ||
      report.sighting ||
      report.conflicting ? (
        <XStack gap="$1.5" flexWrap="wrap" alignItems="center">
          {report.suitability ? (
            <Badge tone={report.suitability === 'dont_go' ? 'danger' : 'solid'}>
              {SUITABILITY_LABELS[report.suitability]}
            </Badge>
          ) : null}
          {report.skateQuality ? (
            <Badge tone="solid">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
          ) : null}
          {report.observedFrom && report.observedFrom !== 'on_ice' ? (
            <Badge>{OBSERVED_FROM_LABELS[report.observedFrom]}</Badge>
          ) : null}
          {report.sighting ? <Badge>{SIGHTING_LABELS[report.sighting]}</Badge> : null}
          {report.conflicting ? <Badge>Conflicting reports</Badge> : null}
        </XStack>
      ) : null}

      {/* The words this Report was posted with (A10 / D186) — the author's, over the data. */}
      {post?.title || post?.body ? (
        <YStack gap="$1">
          {post.title ? (
            <Text color="$foreground" fontWeight="600" fontSize={16}>
              {post.title}
            </Text>
          ) : null}
          {post.body ? (
            <Paragraph color="$foreground" lineHeight={21}>
              {post.body}
            </Paragraph>
          ) : null}
        </YStack>
      ) : null}

      {report.iceTypes && report.iceTypes.length > 0 ? (
        <Section label="Ice types">
          {/* Each chip with its `where`, in words (A10 §12.1) — the bays by name, from the server. */}
          <Chips
            values={report.iceTypes.map((chip) => describeLocatedChip(chip, report.bayNames))}
            humanize={false}
          />
        </Section>
      ) : null}

      {report.surfaceTags && report.surfaceTags.length > 0 ? (
        <Section label="Surface">
          <Chips
            values={report.surfaceTags.map((chip) => describeLocatedChip(chip, report.bayNames))}
            humanize={false}
          />
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

      {snow ? (
        <Section label="Snow">
          <Text color="$foreground">{snow}</Text>
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

      {/* The other legs of the same day (A10 / D186), in the author's order. */}
      {post && post.siblings.length > 0 ? (
        <Section label="Also in this post">
          <XStack gap="$1.5" flexWrap="wrap">
            {post.siblings.map((sibling) => (
              <Button
                key={sibling.reportId}
                size="$2"
                variant="outlined"
                onPress={() =>
                  router.navigate({ pathname: '/report/[id]', params: { id: sibling.reportId } })
                }
              >
                {sibling.bodyName}
              </Button>
            ))}
          </XStack>
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

      {/* Told on the spot rather than pinged (D170): a stranger having asked is not a reason for
          the author's phone to ding, but it is a nice thing to know. */}
      {isOwn && bountiesAnswered !== undefined && bountiesAnswered > 0 ? (
        <Text color="$foregroundMuted" fontSize={13}>
          Thanks for this report — at least{' '}
          {bountiesAnswered === 1 ? 'one skater was' : `${bountiesAnswered} skaters were`} looking
          forward to it.
        </Text>
      ) : null}

      {/* Thumbs (D50): counts visible to all; rating enabled for a signed-in non-author. */}
      <Separator />
      <ThumbControl
        targetType="report"
        targetId={report._id}
        canRate={!!me && !isOwn && !isLeaving(me)}
      />

      {/* Safety tools on the report (D32): flag for anyone but the author; moderator takedown. */}
      {me && !isOwn ? (
        <XStack gap="$2" flexWrap="wrap" alignItems="flex-start">
          <FlagControl targetType="report" targetId={report._id} label="Flag report" />
          <ModeratorActions targetType="report" targetId={report._id} />
          {/* The Post is the other verdict (A10 / D186): hiding it hides every Report under it. */}
          {report.postId ? (
            <ModeratorActions targetType="post" targetId={report.postId} label="Moderate post" />
          ) : null}
        </XStack>
      ) : null}

      {/* The author's own controls (A06f; A10-3). Edit opens the sheet on this Report — the same
          sheet that wrote it — and its Post's words with it. Delete is soft and audited; what
          left, and when, a moderator can still see (founder call, 2026-09-21). Hidden once
          moderated, which the server refuses. */}
      {me && isOwn && report.moderationStatus === 'visible' && !isLeaving(me) ? (
        <XStack gap="$2" flexWrap="wrap">
          <Button
            size="$2"
            chromeless
            onPress={() => router.navigate(doorHref({ edit: report._id }))}
          >
            Edit report
          </Button>
          <Button
            size="$2"
            chromeless
            color="$danger"
            disabled={deleting}
            onPress={() =>
              Alert.alert(
                'Delete this report?',
                report.postId
                  ? 'It comes off the lake and the feed. If it was the last report in its post, the post goes too.'
                  : 'It comes off the lake and the feed.',
                [
                  { text: 'Keep it', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                      setDeleting(true);
                      removeReport({ reportId: report._id })
                        .then(() =>
                          router.navigate({
                            pathname: '/water/[id]',
                            params: { id: report.waterBodyId },
                          }),
                        )
                        .catch(() => setDeleting(false));
                    },
                  },
                ],
              )
            }
          >
            {deleting ? 'Deleting…' : 'Delete report'}
          </Button>
        </XStack>
      ) : null}

      <Comments reportId={report._id} />
    </YStack>
  );
}
