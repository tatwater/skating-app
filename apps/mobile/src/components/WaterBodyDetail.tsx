import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  formatAreaAcres,
  formatSkateTime,
  humanizeEnum,
  SKATE_QUALITY_LABELS,
} from '@skating/core';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import type { MultiPolygon, Polygon } from 'geojson';
import { useEffect, useState } from 'react';
import { Button, H4, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import { cacheBody } from '../lib/bodyCache';
import { cacheReports } from '../lib/reportCache';
import { BountyForm } from './BountyForm';
import { BountyList } from './BountyList';
import { Badge, DetailLoading, Section, Unavailable } from './detailUi';
import { DirectionsButton, FavoriteButton } from './FavoriteButton';
import { LeavingNotice, useIsLeaving } from './LeavingNotice';
import { useMapSelection } from './MapSelectionContext';
import { ReportForm } from './ReportForm';
import { SeasonEmptyState, SeasonFilter } from './SeasonFilter';

/**
 * Water-body detail drawer (§F, D47) for `/water/[id]`, the mobile mirror of web's `WaterBodyDetail`.
 * Reads `waterBodies.get`, which **follows a merge to the survivor** (a stale/merged deep link
 * silently lands on the canonical lake) and distinguishes not-found (`null`) from removed/unlisted
 * (`{ available: false }`) so each gets its own friendly state. Shows name, type, imperial area
 * (D25), and the report feed newest **skate time** first; the map flies to the lake's centroid on
 * open. "Add a report" swaps the feed for the create form in place (D47), kept mounted in this same
 * sheet so its state survives the put-in-pin peek.
 */
export function WaterBodyDetail({
  waterBodyId,
  trackDraftId,
  focusSubAreaId,
}: {
  waterBodyId: string;
  /** A named bay to frame instead of the whole lake (N2/D60) — set by a sub-area search hit. */
  focusSubAreaId?: string;
  /**
   * A just-finished recording to file this report against (Phase 8). When present the form opens
   * straight away — the skater tapped "Report this skate", and making them find the button again
   * would be the moment the whole record→report loop leaks people.
   */
  trackDraftId?: string;
}) {
  const result = useQuery(api.waterBodies.get, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  });
  const body = result?.available ? result.body : null;
  // Only fetched when a bay was actually asked for — a `by_parent` read on a lake already open.
  const subAreas = useQuery(
    api.subAreas.listForBody,
    focusSubAreaId && body ? { waterBodyId: body._id } : 'skip',
  );
  const focusSubArea = focusSubAreaId
    ? subAreas?.find((s) => s._id === focusSubAreaId && !s.removed)
    : undefined;
  const { setFocus, setHighlightWaterBodyId } = useMapSelection();
  const [formOpen, setFormOpen] = useState(trackDraftId !== undefined);
  const [bountyFormOpen, setBountyFormOpen] = useState(false);
  const leaving = useIsLeaving();

  // Offline read-cache (decision #8): stash this opened lake's freshest reports as feed cards so they
  // read back on the ice with no signal. Skips until the (merge-resolved) body id is known.
  const openedLakeCards = useQuery(
    api.reports.recentCardsForBodies,
    body ? { waterBodyIds: [body._id] } : 'skip',
  );
  useEffect(() => {
    if (openedLakeCards && openedLakeCards.length > 0) cacheReports(openedLakeCards);
  }, [openedLakeCards]);

  // Once the (possibly merge-resolved) lake loads, fly the map to it and highlight it by the
  // *resolved* `_id` — the survivor a merged deep link redirects to, which is what the map carries.
  useEffect(() => {
    if (body) {
      // Pass the lake's bbox so the map zoom-to-fits it into the area above the drawer (falls back to
      // the centroid for anything without bounds).
      // A bay frames on its own bounds, not the lake's — Champlain zoom-to-fit is 200 km of ice,
      // which is exactly the framing that made naming bays worth doing.
      setFocus(
        focusSubArea
          ? {
              lat: focusSubArea.centroid.lat,
              lng: focusSubArea.centroid.lng,
              bounds: focusSubArea.bbox,
            }
          : { lat: body.centroid.lat, lng: body.centroid.lng, bounds: body.bbox },
      );
      setHighlightWaterBodyId(body._id);
      // Cache this viewed lake's reference data on-device (F2 Layer 2) so it can be GPS-resolved
      // offline for a no-signal report. Best-effort; the sqlite write never blocks viewing.
      cacheBody({
        waterBodyId: body._id,
        name: body.name,
        states: body.states,
        polygon: body.polygon as unknown as Polygon | MultiPolygon,
        centroid: body.centroid,
        surfaceAreaSqM: body.surfaceAreaSqM,
      });
    }
  }, [body, focusSubArea, setFocus, setHighlightWaterBodyId]);

  if (result === undefined) return <DetailLoading />;
  if (result === null) {
    return (
      <Unavailable
        title="Lake not found"
        message="We couldn't find this water body. The link may be broken."
      />
    );
  }
  if (!result.available) {
    return (
      <Unavailable
        title="This lake isn't available"
        message="It may have been removed from the map. Try another lake nearby."
      />
    );
  }

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <XStack justifyContent="space-between" alignItems="center" gap="$2">
          <H4 color="$foreground" flex={1}>
            {result.body.name}
          </H4>
          <FavoriteButton waterBodyId={result.body._id} />
        </XStack>
        <Text color="$foregroundMuted">
          {humanizeEnum(result.body.type)}
          {result.body.surfaceAreaSqM !== undefined
            ? ` · ${formatAreaAcres(result.body.surfaceAreaSqM)}`
            : ''}
        </Text>
        <DirectionsButton waterBodyId={result.body._id} />
      </YStack>

      {formOpen ? (
        <ReportForm
          waterBodyId={result.body._id}
          bodyName={result.body.name}
          {...(trackDraftId !== undefined ? { trackDraftId } : {})}
          onClose={() => setFormOpen(false)}
        />
      ) : bountyFormOpen ? (
        <BountyForm
          waterBodyId={result.body._id}
          bodyName={result.body.name}
          onClose={() => setBountyFormOpen(false)}
        />
      ) : (
        <>
          {/* Report creation + bounty posting surfaced in place (D47). Both close while a
              deletion is pending (D62 amendment); the feed below stays fully readable. */}
          {leaving ? (
            <LeavingNotice />
          ) : (
            <>
              <Button
                backgroundColor="$primary"
                color="$primaryForeground"
                onPress={() => setFormOpen(true)}
              >
                Add a report
              </Button>
              <Button variant="outlined" onPress={() => setBountyFormOpen(true)}>
                Post a bounty
              </Button>
            </>
          )}
          <SeasonFilter waterBodyId={result.body._id} />
          <BountyList waterBodyId={result.body._id} />
          <ReportFeed
            waterBodyId={result.body._id}
            {...(focusSubArea ? { initialSubAreaId: focusSubArea._id } : {})}
          />
        </>
      )}
    </YStack>
  );
}

/** How many per-body reports to fetch per infinite-scroll page. */
const REPORTS_PAGE_SIZE = 20;

function ReportFeed({
  waterBodyId,
  /** The bay a search hit arrived on, pre-selecting the filter — you asked about Malletts, not the lake. */
  initialSubAreaId,
}: {
  waterBodyId: Id<'waterBodies'>;
  initialSubAreaId?: string;
}) {
  const router = useRouter();
  // The named bays on this lake (N2/D60). Most lakes have none, and then the control is absent
  // rather than an empty chip row asking "which part?" of a pond.
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const bays = (subAreas ?? []).filter((s) => !s.removed);
  const [subAreaId, setSubAreaId] = useState<string>(initialSubAreaId ?? '');
  // A bay delisted since the link was made falls back to the whole lake, rather than filtering on an
  // id nothing matches — which would read as "no reports here".
  const activeBay = bays.some((b) => b._id === subAreaId) ? subAreaId : '';

  // The season on screen (D63), shared with the map so the pins behind this sheet belong to the same
  // winter as the list in it. `null` — this season — is the default the sheet always opens in.
  const { browseSeason } = useMapSelection();
  const seasons = useQuery(api.reports.seasonsForBody, { waterBodyId });
  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listByWaterBody,
    {
      waterBodyId,
      ...(activeBay ? { subAreaId: activeBay as Id<'waterBodySubAreas'> } : {}),
      ...(browseSeason === null ? {} : { season: browseSeason }),
    },
    { initialNumItems: REPORTS_PAGE_SIZE },
  );
  const authorIds = [...new Set(results.map((r) => r.authorId))];
  const authors = useQuery(
    api.profiles.publicByIds,
    results.length > 0 ? { profileIds: authorIds } : 'skip',
  );

  // Chips rather than a picker: there are at most a handful of bays, and a tap is cheaper than a
  // modal on a phone someone is holding in a glove.
  const bayFilter =
    bays.length > 0 ? (
      <XStack gap="$2" flexWrap="wrap">
        {[{ _id: '', name: 'Anywhere' }, ...bays].map((bay) => (
          <Text
            key={bay._id || 'all'}
            accessibilityRole="button"
            accessibilityLabel={`Show reports from ${bay.name}`}
            accessibilityState={{ selected: activeBay === bay._id }}
            onPress={() => setSubAreaId(bay._id)}
            paddingHorizontal="$2"
            paddingVertical="$1"
            borderRadius="$3"
            borderWidth={1}
            borderColor={activeBay === bay._id ? '$primary' : '$border'}
            color={activeBay === bay._id ? '$primary' : '$foregroundMuted'}
            fontSize={13}
          >
            {bay.name}
          </Text>
        ))}
      </XStack>
    ) : null;

  if (status === 'LoadingFirstPage') return <DetailLoading />;
  if (results.length === 0) {
    return (
      <YStack gap="$2">
        {bayFilter}
        {activeBay ? (
          <Paragraph color="$foregroundMuted">No reports from that part of the lake yet.</Paragraph>
        ) : (
          <SeasonEmptyState browseSeason={browseSeason} currentSeason={seasons?.current} />
        )}
      </YStack>
    );
  }

  return (
    <YStack gap="$2">
      {bayFilter}
      <Section label="Reports">
        <YStack gap="$2">
          {results.map((report) => (
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
          {status === 'CanLoadMore' ? (
            <Button size="$3" variant="outlined" onPress={() => loadMore(REPORTS_PAGE_SIZE)}>
              Load more
            </Button>
          ) : null}
          {status === 'LoadingMore' ? (
            <YStack padding="$2" alignItems="center">
              <Spinner color="$primary" />
            </YStack>
          ) : null}
        </YStack>
      </Section>
    </YStack>
  );
}
