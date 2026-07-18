import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { api } from '@skating/convex/api'
import { type FeedCardData, type FeedFilters, groupFeedSections } from '@skating/core'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { H1, Paragraph, Spinner, Text, useTheme, YStack } from 'tamagui'
import { FeedCard } from '../../src/components/FeedCard'
import { FeedFilterBar } from '../../src/components/FeedFilterBar'
import { MapSelectionProvider } from '../../src/components/MapSelectionContext'
import { ProfileSearch } from '../../src/components/ProfileSearch'
import { ReportDetail } from '../../src/components/ReportDetail'
import { reconcileFilters } from '../../src/lib/feedFilters'
import { loadStoredFilters, saveStoredFilters } from '../../src/lib/feedFiltersStore'
import { cacheReports, loadCachedReports } from '../../src/lib/reportCache'

/** Feed page size per `usePaginatedQuery` load. */
const PAGE_SIZE = 20

/** A row in the interleaved feed list: a recency section header, or a report card (decision #5). */
type FeedListItem =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'card'; data: FeedCardData }

/**
 * Newsfeed tab (Phase 5) — the mobile mirror of web's `/feed`. Reads `reports.listFeed` (global,
 * newest skate-end time first) via `usePaginatedQuery` into a `FlatList` with pull-to-refresh and
 * infinite scroll, and opens a tapped report in a `@gorhom/bottom-sheet` (the Phase 2 drawer pattern,
 * reusing the shared `ReportDetail`) so the feed scroll position survives. All reports are public
 * (D13); a blocked author's report still shows, de-emphasized (D3).
 */
export default function NewsfeedScreen() {
  const theme = useTheme()
  const filters = useFeedFilters()
  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listFeed,
    { filters: filters.value },
    { initialNumItems: PAGE_SIZE },
  )
  const now = Date.now()

  // Offline read-cache (decision #8): cache the feed cards we render, and fall back to the cache when
  // the live query has nothing yet (on the ice with no signal). Cached cards load once on mount.
  const [cached] = useState(() => loadCachedReports())
  useEffect(() => {
    if (results.length > 0) cacheReports(results)
  }, [results])

  // Pre-cache the viewer's favorites' recent reports (decision #8) so a followed lake reads back
  // offline even if it never scrolled past in the feed. Refreshes whenever the favorite set changes.
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {})
  const favoriteCards = useQuery(
    api.reports.recentCardsForBodies,
    favorites && favorites.length > 0
      ? { waterBodyIds: favorites.map((f) => f.waterBodyId) }
      : 'skip',
  )
  useEffect(() => {
    if (favoriteCards && favoriteCards.length > 0) cacheReports(favoriteCards)
  }, [favoriteCards])
  const isOfflineFallback =
    results.length === 0 && status === 'LoadingFirstPage' && cached.length > 0
  const feedData = isOfflineFallback ? cached : results

  // Interleave recency scroll-divider headers (Phase 4, decision #5) into the flat list — one header
  // row per section ("Today / Yesterday / …"), then that section's cards, so infinite scroll +
  // pull-to-refresh keep working over a single `FlatList`.
  const listItems: FeedListItem[] = groupFeedSections(feedData, (d) => d.skateEndTime, now).flatMap(
    (section) => [
      { kind: 'header' as const, key: `header:${section.key}`, label: section.label },
      ...section.items.map((data) => ({ kind: 'card' as const, data })),
    ],
  )

  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const sheetRef = useRef<BottomSheet>(null)
  useEffect(() => {
    if (selectedReportId) sheetRef.current?.snapToIndex(0)
    else sheetRef.current?.close()
  }, [selectedReportId])

  // Convex queries are live, so the list is always current — pull-to-refresh is a familiar affordance
  // that just settles the spinner (there's no stale snapshot to refetch).
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(() => {
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 500)
  }, [])

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <FlatList<FeedListItem>
        data={listItems}
        keyExtractor={(item) => (item.kind === 'header' ? item.key : item.data.reportId)}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (status === 'CanLoadMore') loadMore(PAGE_SIZE)
        }}
        ListHeaderComponent={
          <YStack gap="$4" paddingBottom="$2">
            <H1 color="$foreground">Newsfeed</H1>
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
            <FeedFilterBar filters={filters.value} onChange={filters.set} />
          </YStack>
        }
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text
              color="$foregroundMuted"
              fontSize={11}
              letterSpacing={1.5}
              textTransform="uppercase"
            >
              {item.label}
            </Text>
          ) : (
            <FeedCard
              data={item.data}
              now={now}
              onOpen={() => setSelectedReportId(item.data.reportId)}
            />
          )
        }
        ListEmptyComponent={
          status === 'LoadingFirstPage' ? (
            <YStack padding="$4" alignItems="center">
              <Spinner color="$primary" />
            </YStack>
          ) : (
            <Paragraph color="$foregroundMuted" paddingHorizontal="$1">
              No reports yet. When skaters post from the map, the freshest reads across every lake
              show up here — newest first.
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
  )
}

/**
 * Feed-filter state (Phase 4, decision #6): device sqlite is the working copy (instant, offline-safe),
 * `profiles.feedFilterPrefs` is the durable server-sync copy. Load local on mount; once the profile
 * arrives, reconcile once (LWW — non-empty local wins, else adopt server). Each change writes local
 * immediately and syncs the server copy.
 */
function useFeedFilters(): { value: FeedFilters; set: (next: FeedFilters) => void } {
  const [value, setValue] = useState<FeedFilters>(() => loadStoredFilters())
  const profile = useQuery(api.profiles.current, {})
  const setServer = useMutation(api.profiles.setFeedFilterPrefs)
  const reconciled = useRef(false)

  useEffect(() => {
    if (reconciled.current || profile === undefined) return
    reconciled.current = true
    const merged = reconcileFilters(loadStoredFilters(), profile?.feedFilterPrefs)
    setValue(merged)
    saveStoredFilters(merged)
  }, [profile])

  const set = (next: FeedFilters) => {
    setValue(next)
    saveStoredFilters(next)
    if (profile) void setServer({ filters: next })
  }

  return { value, set }
}
