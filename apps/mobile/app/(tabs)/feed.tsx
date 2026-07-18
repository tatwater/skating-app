import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { api } from '@skating/convex/api'
import type { FeedCardData } from '@skating/core'
import { usePaginatedQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { H1, Paragraph, Spinner, Text, useTheme, YStack } from 'tamagui'
import { FeedCard } from '../../src/components/FeedCard'
import { MapSelectionProvider } from '../../src/components/MapSelectionContext'
import { ProfileSearch } from '../../src/components/ProfileSearch'
import { ReportDetail } from '../../src/components/ReportDetail'

/** Feed page size per `usePaginatedQuery` load. */
const PAGE_SIZE = 20

/**
 * Newsfeed tab (Phase 5) — the mobile mirror of web's `/feed`. Reads `reports.listFeed` (global,
 * newest skate-end time first) via `usePaginatedQuery` into a `FlatList` with pull-to-refresh and
 * infinite scroll, and opens a tapped report in a `@gorhom/bottom-sheet` (the Phase 2 drawer pattern,
 * reusing the shared `ReportDetail`) so the feed scroll position survives. All reports are public
 * (D13); a blocked author's report still shows, de-emphasized (D3).
 */
export default function NewsfeedScreen() {
  const theme = useTheme()
  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listFeed,
    {},
    { initialNumItems: PAGE_SIZE },
  )
  const now = Date.now()

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
      <FlatList<FeedCardData>
        data={results}
        keyExtractor={(item) => item.reportId}
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
          </YStack>
        }
        renderItem={({ item }) => (
          <FeedCard data={item} now={now} onOpen={() => setSelectedReportId(item.reportId)} />
        )}
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
