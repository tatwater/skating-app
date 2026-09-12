import { api } from '@skating/convex/api';
import { describeNotification, formatRelativeTime, type NotificationView } from '@skating/core';
import { useMutation, usePaginatedQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { FlatList } from 'react-native';
import { Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import { notificationRoute } from '../src/lib/notificationRoutes';

const PAGE_SIZE = 30;

/**
 * The inbox (N8/A3) — reached from the bell on the You tab, never a tab of its own (D28's five
 * stand). Mirrors the web route: newest first, infinite scroll, everything shown marks itself read
 * once it has actually been on screen, and a row whose target is gone renders degraded and
 * untappable rather than vanishing (N8 #5).
 */
export default function NotificationsScreen() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.list,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const markRead = useMutation(api.notifications.markRead);
  const now = Date.now();

  // Mark what the screen opened on as read — once, when the first page lands with rows (same guard
  // as the web, and the same reasons: latch regardless of whether anything shown was unread, rows
  // present ⇒ authenticated, and no `before` so the server also stamps the rows the list omits for
  // blocked actors). A notification arriving while the modal is up stays unread until the next open.
  const hasRows = results.length > 0;
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || status === 'LoadingFirstPage' || !hasRows) return;
    marked.current = true;
    void markRead({}).catch(() => {});
  }, [markRead, hasRows, status]);

  return (
    <FlatList<NotificationView>
      data={results}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => <NotificationRow view={item} now={now} />}
      onEndReached={() => {
        if (status === 'CanLoadMore') loadMore(PAGE_SIZE);
      }}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingBottom: 24 }}
      ListEmptyComponent={
        status === 'LoadingFirstPage' ? (
          <YStack padding="$6" alignItems="center">
            <Spinner />
          </YStack>
        ) : (
          <YStack padding="$4" gap="$2">
            <Text color="$foreground" fontWeight="600">
              Nothing yet
            </Text>
            <Paragraph color="$foregroundMuted">
              When someone comments on your report, finds it helpful, or a lake you follow gets new
              ice, it shows up here. Which of those reach you is up to you under Notifications on
              the You tab.
            </Paragraph>
          </YStack>
        )
      }
      ListFooterComponent={
        status === 'LoadingMore' ? (
          <YStack padding="$4" alignItems="center">
            <Spinner />
          </YStack>
        ) : null
      }
    />
  );
}

function NotificationRow({ view, now }: { view: NotificationView; now: number }) {
  const router = useRouter();
  const { title, detail, target } = describeNotification(view);
  const route = notificationRoute(target, view);
  const unread = view.readAt === undefined;
  return (
    <XStack
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
      borderBottomWidth={1}
      borderColor="$border"
      alignItems="flex-start"
      opacity={route ? 1 : 0.8}
      {...(route
        ? {
            pressStyle: { backgroundColor: '$surfaceMuted' },
            onPress: () => router.navigate(route),
            accessibilityRole: 'button' as const,
          }
        : {})}
    >
      {/* Fixed-width gutter so read and unread rows share a left edge. */}
      <YStack width={8} alignItems="center" paddingTop={7}>
        {unread ? (
          <YStack
            width={8}
            height={8}
            borderRadius={4}
            backgroundColor="$primary"
            accessibilityLabel="Unread"
          />
        ) : null}
      </YStack>
      <YStack flex={1} gap="$1">
        <Text color="$foreground" fontWeight={unread ? '600' : '400'}>
          {title}
        </Text>
        {detail ? (
          <Text color="$foregroundMuted" fontSize={12}>
            {detail}
          </Text>
        ) : null}
        <Text color="$foregroundMuted" fontSize={12}>
          {formatRelativeTime(view.createdAt, now)}
        </Text>
      </YStack>
    </XStack>
  );
}
