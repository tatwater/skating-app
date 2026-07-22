import {
  formatSkateTime,
  type HazardQueueItem,
  hazardTypeLabel,
  isFlushable,
  isHazardItemFlushable,
  type ReportDraft,
} from '@skating/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';
import { Badge } from '../../src/components/detailUi';
import { useOfflineDrafts } from '../../src/components/OfflineDraftsContext';

/**
 * The center "＋ Report" tab (D28). Online, reports are created in place from a lake's detail drawer
 * (D47) — this tab points you there. Offline (F2), it's the **first-class capture entry point**:
 * "Capture a report" uses your GPS to bind to the nearest cached lake (or resolves it at sync), and
 * this screen lists your queued drafts (pending / errored) with sync + edit + delete. Drafts flush
 * automatically on reconnect (D12); "Sync now" forces it.
 */
export default function ReportScreen() {
  const router = useRouter();
  const { drafts, hazardItems, pendingCount, refresh, flushNow, removeDraft, removeHazardItem } =
    useOfflineDrafts();

  // Refresh from sqlite whenever the tab regains focus (e.g. after saving a draft in the modal).
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <YStack gap="$4">
          <YStack gap="$2">
            <H4 color="$foreground">Add a report</H4>
            <Paragraph color="$foregroundMuted">
              Online, open the map and tap the lake you skated. Off the grid, capture it here — it
              posts automatically when you're back online.
            </Paragraph>
          </YStack>

          <YStack gap="$2">
            <Button
              backgroundColor="$primary"
              color="$primaryForeground"
              onPress={() => router.navigate('/draft/new')}
            >
              Capture a report (offline-ready)
            </Button>
            <Button chromeless onPress={() => router.navigate('/')}>
              Go to the map
            </Button>
          </YStack>

          {drafts.length > 0 || hazardItems.length > 0 ? (
            <YStack gap="$2">
              <XStack justifyContent="space-between" alignItems="center">
                <Text color="$foreground" fontWeight="600">
                  Queued{pendingCount > 0 ? ` · ${pendingCount} to send` : ''}
                </Text>
                {pendingCount > 0 ? (
                  <Button size="$2" onPress={() => void flushNow()}>
                    Sync now
                  </Button>
                ) : null}
              </XStack>
              {/* Hazards first — they're safety content and flush first (see `flushDrafts`). A queued
                  hazard that hit a permanent rejection lives here until dismissed, so it can't silently
                  vanish after "it'll post when you're back in signal". */}
              {hazardItems.map((item) => (
                <HazardItemRow
                  key={item.id}
                  item={item}
                  onDelete={() => removeHazardItem(item.id)}
                />
              ))}
              {drafts.map((draft) => (
                <DraftRow
                  key={draft.id}
                  draft={draft}
                  onEdit={() =>
                    router.navigate({ pathname: '/draft/[id]', params: { id: draft.id } })
                  }
                  onDelete={() => removeDraft(draft.id)}
                />
              ))}
            </YStack>
          ) : null}
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}

function DraftRow({
  draft,
  onEdit,
  onDelete,
}: {
  draft: ReportDraft;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const pending = isFlushable(draft);
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$border"
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <XStack justifyContent="space-between" alignItems="center" gap="$2">
        <Text color="$foreground" flex={1}>
          {draft.bodyName ?? 'Unknown lake'}
        </Text>
        <Badge tone={draft.status === 'error' ? 'solid' : undefined}>
          {draft.status === 'error' ? 'Needs attention' : pending ? 'Pending' : 'Sent'}
        </Badge>
      </XStack>
      <Text color="$foregroundMuted" fontSize={12}>
        Skated {formatSkateTime(draft.form.skateEndTime)}
      </Text>
      {draft.status === 'error' && draft.errorMessage ? (
        <Text color="$danger" fontSize={12}>
          {draft.errorMessage}
        </Text>
      ) : null}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$2" chromeless onPress={onDelete}>
          Delete
        </Button>
        <Button size="$2" onPress={onEdit}>
          Edit
        </Button>
      </XStack>
    </YStack>
  );
}

/**
 * A queued on-ice hazard or confirmation (Phase 9). No edit affordance — a hazard is immutable once
 * captured — but it must be *visible and deletable*, so a permanent rejection on flush (a removed
 * lake, a minor, an unresolvable location) is something the skater can see and clear rather than a
 * silent, unrecoverable row that also never frees its photo files.
 */
function HazardItemRow({ item, onDelete }: { item: HazardQueueItem; onDelete: () => void }) {
  const pending = isHazardItemFlushable(item);
  const title = item.kind === 'hazard' ? hazardTypeLabel(item.type) : 'Hazard confirmation';
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$border"
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <XStack justifyContent="space-between" alignItems="center" gap="$2">
        <Text color="$foreground" flex={1}>
          {title}
        </Text>
        <Badge tone={item.status === 'error' ? 'solid' : undefined}>
          {item.status === 'error' ? 'Needs attention' : pending ? 'Pending' : 'Sent'}
        </Badge>
      </XStack>
      {item.status === 'error' && item.errorMessage ? (
        <Text color="$danger" fontSize={12}>
          {item.errorMessage}
        </Text>
      ) : null}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$2" chromeless onPress={onDelete}>
          Delete
        </Button>
      </XStack>
    </YStack>
  );
}
