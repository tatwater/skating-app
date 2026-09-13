import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { api } from '@skating/convex/api';
import {
  type BodyResultData,
  type FeedCardData,
  formatSeason,
  groupFeedSections,
  hasWeatherFilter,
  interleaveLatest,
  seasonOf,
} from '@skating/core';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { H1, Paragraph, Spinner, Text, useTheme, YStack } from 'tamagui';
import { BodyResultCard } from '../../src/components/BodyResultCard';
import { FeedCard } from '../../src/components/FeedCard';
import { FeedFilterBar } from '../../src/components/FeedFilterBar';
import { MapSelectionProvider } from '../../src/components/MapSelectionContext';
import { ProfileSearch } from '../../src/components/ProfileSearch';
import { RecommendedCard } from '../../src/components/RecommendedCard';
import { ReportDetail } from '../../src/components/ReportDetail';
import { useFeedFilters } from '../../src/lib/feedFiltersStore';
import { cacheReports, loadCachedReports } from '../../src/lib/reportCache';

/** Feed page size per `usePaginatedQuery` load. */
const PAGE_SIZE = 20;

/**
 * A row in the interleaved feed list: a recency section header, a report card (decision #5), or a
 * `recommended` filter-breaking bundle interleaved near the top (D50 decisions 13–15).
 */
type FeedListItem =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'card'; data: FeedCardData }
  | { kind: 'body'; data: BodyResultData }
  | { kind: 'recommended'; key: string; cards: FeedCardData[] };

/**
 * Latest tab (Phase 5, renamed from Newsfeed by N6h/D159) — the mobile mirror of web's `/feed`.
 * Reads `reports.listFeed` (global, newest skate-end time first) via `usePaginatedQuery` into a
 * `FlatList` with pull-to-refresh and infinite scroll, and opens a tapped report in a
 * `@gorhom/bottom-sheet` (the Phase 2 drawer pattern, reusing the shared `ReportDetail`) so the
 * feed scroll position survives. All reports are public (D13); a blocked author's report still
 * shows, de-emphasized (D3).
 *
 * Under a weather filter the list is heterogeneous (D165): `weatherDiscovery.listBodyResults`
 * supplies the lakes whose cold chain matched, and `interleaveLatest` slots them among the reports
 * by the day each crossed the requested number of nights. A lake card opens the lake on the map.
 */
export default function NewsfeedScreen() {
  const theme = useTheme();
  const router = useRouter();
  const filters = useFeedFilters();
  const weatherActive = hasWeatherFilter(filters.value);
  const discovery = useQuery(api.weatherDiscovery.status, {});
  const bodyResults = useQuery(
    api.weatherDiscovery.listBodyResults,
    weatherActive && !filters.value.onlyReports ? { filters: filters.value } : 'skip',
  );
  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listFeed,
    { filters: filters.value },
    { initialNumItems: PAGE_SIZE },
  );
  const now = Date.now();

  // Offline read-cache (decision #8): cache the feed cards we render, and fall back to the cache when
  // the live query has nothing yet (on the ice with no signal). Cached cards load once on mount.
  const [cached] = useState(() => loadCachedReports());
  useEffect(() => {
    if (results.length > 0) cacheReports(results);
  }, [results]);

  // Pre-cache the viewer's favorites' recent reports (decision #8) so a followed lake reads back
  // offline even if it never scrolled past in the feed. Refreshes whenever the favorite set changes.
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {});
  const favoriteCards = useQuery(
    api.reports.recentCardsForBodies,
    favorites && favorites.length > 0
      ? { waterBodyIds: favorites.map((f) => f.waterBodyId) }
      : 'skip',
  );
  useEffect(() => {
    if (favoriteCards && favoriteCards.length > 0) cacheReports(favoriteCards);
  }, [favoriteCards]);
  const isOfflineFallback =
    results.length === 0 && status === 'LoadingFirstPage' && cached.length > 0;
  const feedData = isOfflineFallback ? cached : results;

  // Recommended filter-breaking bundles (D50) — a separate query interleaved near the top, never spliced
  // into the paginated feed. Renders nothing (the common case) when nothing exceptional qualifies.
  const recommended = useQuery(api.reports.recommended, {});
  const recommendedItems: FeedListItem[] =
    recommended && recommended.length > 0
      ? [
          { kind: 'header', key: 'header:recommended', label: 'Recommended' },
          ...recommended.map((rec) => ({
            kind: 'recommended' as const,
            key: `rec:${rec.waterBodyId}`,
            cards: rec.cards,
          })),
        ]
      : [];
  // Subtract the recommended reports from the main feed — a permissive-filter viewer must not see the
  // same report both in the "Recommended" strip and in a recency section below.
  const recommendedIds = new Set(
    recommended?.flatMap((rec) => rec.cards.map((c) => c.reportId)) ?? [],
  );

  // Interleave recency scroll-divider headers (Phase 4, decision #5) into the flat list — one header
  // row per section ("Today / Yesterday / …"), then that section's cards, so infinite scroll +
  // pull-to-refresh keep working over a single `FlatList`. The recommended bundles lead the list.
  const listItems: FeedListItem[] = [
    ...recommendedItems,
    ...groupFeedSections(
      interleaveLatest(
        feedData.filter((d) => !recommendedIds.has(d.reportId)),
        (d) => d.skateEndTime,
        // Never from the offline cache: a cached report list has no matching body list.
        isOfflineFallback ? [] : (bodyResults?.results ?? []),
        status === 'Exhausted',
      ),
      (item) => (item.kind === 'report' ? item.data.skateEndTime : item.data.eventMs),
      now,
    ).flatMap((section) => [
      { kind: 'header' as const, key: `header:${section.key}`, label: section.label },
      ...section.items.map((item) =>
        item.kind === 'report'
          ? { kind: 'card' as const, data: item.data }
          : { kind: 'body' as const, data: item.data },
      ),
    ]),
  ];

  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const sheetRef = useRef<BottomSheet>(null);
  useEffect(() => {
    if (selectedReportId) sheetRef.current?.snapToIndex(0);
    else sheetRef.current?.close();
  }, [selectedReportId]);

  // Convex queries are live, so the list is always current — pull-to-refresh is a familiar affordance
  // that just settles the spinner (there's no stale snapshot to refetch).
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 500);
  }, []);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <FlatList<FeedListItem>
        data={listItems}
        keyExtractor={(item) =>
          item.kind === 'card'
            ? item.data.reportId
            : item.kind === 'body'
              ? `body:${item.data.waterBodyId}`
              : item.key
        }
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (status === 'CanLoadMore') loadMore(PAGE_SIZE);
        }}
        ListHeaderComponent={
          <YStack gap="$4" paddingBottom="$2">
            <H1 color="$foreground">Latest</H1>
            {isOfflineFallback ? (
              <Text color="$foregroundMuted" fontSize={13}>
                Offline — showing recently saved reports.
              </Text>
            ) : null}
            <YStack gap="$2">
              <Text
                color="$foregroundMuted"
                fontSize={11}
                letterSpacing={1.5}
                textTransform="uppercase"
              >
                Find a skater
              </Text>
              <ProfileSearch />
            </YStack>
            <PastSeasonNotice results={feedData} now={now} />
            <FeedFilterBar filters={filters.value} onChange={filters.set} weather={discovery} />
          </YStack>
        }
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return (
              <Text
                color="$foregroundMuted"
                fontSize={11}
                letterSpacing={1.5}
                textTransform="uppercase"
              >
                {item.label}
              </Text>
            );
          }
          if (item.kind === 'recommended') {
            return <RecommendedCard cards={item.cards} now={now} onOpen={setSelectedReportId} />;
          }
          if (item.kind === 'body') {
            return (
              <BodyResultCard
                data={item.data}
                now={now}
                onOpen={(sub) =>
                  router.navigate({
                    pathname: '/water/[id]',
                    params: sub
                      ? { id: item.data.waterBodyId, sub }
                      : { id: item.data.waterBodyId },
                  })
                }
              />
            );
          }
          return (
            <FeedCard
              data={item.data}
              now={now}
              onOpen={() => setSelectedReportId(item.data.reportId)}
            />
          );
        }}
        ListEmptyComponent={
          status === 'LoadingFirstPage' ? (
            <YStack padding="$4" alignItems="center">
              <Spinner color="$primary" />
            </YStack>
          ) : (
            <Paragraph color="$foregroundMuted" paddingHorizontal="$1">
              {weatherActive && discovery?.available === false
                ? 'No weather data yet this season, so the weather filter cannot match any lake. It fills in once the region freezes.'
                : weatherActive
                  ? 'No lake matches that weather yet, and no matching reports on this page.'
                  : 'No reports yet. When skaters post from the map, the freshest reads across every lake show up here — newest first.'}
            </Paragraph>
          )
        }
        ListFooterComponent={
          status === 'LoadingMore' ? (
            <YStack padding="$3" alignItems="center">
              <Spinner color="$primary" />
            </YStack>
          ) : null
        }
      />

      {/* Report bottom-sheet — reuses the map's `ReportDetail`, which pushes map focus through
          `MapSelectionContext`; we mount a throwaway provider (no map on the feed, so it's inert). */}
      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={['58%', '94%']}
        enablePanDownToClose
        onClose={() => setSelectedReportId(null)}
        backgroundStyle={{ backgroundColor: theme.surface?.val }}
        handleIndicatorStyle={{ backgroundColor: theme.foregroundMuted?.val }}
      >
        <BottomSheetScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {selectedReportId ? (
            <MapSelectionProvider>
              <ReportDetail reportId={selectedReportId} />
            </MapSelectionProvider>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </SafeAreaView>
  );
}

/**
 * The labelled fallback (D63) — web's `PastSeasonNotice`, same words, same reason.
 *
 * Season-scoping the feed empties it on July 1 and leaves it empty until first ice, so the server
 * falls back to the newest season that has anything. What it must never do is fall back *silently*:
 * a February report under today's date, unlabelled, is the "tell the difference from opacity alone"
 * problem this phase exists to end.
 *
 * Derived from the cards because `usePaginatedQuery` flattens the pages and drops what else the page
 * carried. One season is served per read, so the first card answers for all of them.
 */
function PastSeasonNotice({
  results,
  now,
}: {
  results: readonly { skateEndTime: number }[];
  now: number;
}) {
  const first = results[0];
  if (!first) return null;
  const season = seasonOf(first.skateEndTime);
  if (season === seasonOf(now)) return null;
  return (
    <Text color="$foregroundMuted" fontSize={13}>
      Nothing reported yet this season — showing the {formatSeason(season)} season, the last one
      anybody skated.
    </Text>
  );
}
