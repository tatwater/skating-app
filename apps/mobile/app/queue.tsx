import { useNetInfo } from '@react-native-community/netinfo';
import {
  formatSkateTime,
  type HazardQueueItem,
  hazardTypeLabel,
  isFlushable,
  isHazardItemFlushable,
  isHeldDraft,
  POST_SENT_COPY,
  type PostDraft,
  postCreateSent,
  postDraftLabel,
  reportDraftEndTime,
  WAITING_TO_SEND_COPY,
} from '@skating/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';
import { Badge } from '../src/components/detailUi';
import { useOfflineDrafts } from '../src/components/OfflineDraftsContext';
import { doorHref } from '../src/lib/sheetDoors';

/**
 * *Waiting to send* (A10 §9.2): the signal state in one sentence from core, the queued hazards
 * first (safety content flushes first), then the queued Posts labeled by title or lakes — each
 * with sync, edit and delete. Drafts the author is holding are not here; they have their own
 * screen. A Post that hit a permanent refusal stays until fixed or deleted, so nothing can
 * quietly fail forever.
 */
export default function QueueScreen() {
  const router = useRouter();
  const { drafts, hazardItems, pendingCount, refresh, flushNow, removeDraft, removeHazardItem } =
    useOfflineDrafts();
  const offline = useNetInfo().isConnected === false;
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  const queued = drafts.filter((d) => !isHeldDraft(d));

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <YStack gap="$4">
          <XStack alignItems="center" justifyContent="space-between">
            <H4 color="$foreground">Waiting to send</H4>
            <XStack gap="$2">
              {pendingCount > 0 && !offline ? (
                <Button size="$2" onPress={() => void flushNow()}>
                  Sync now
                </Button>
              ) : null}
              <Button size="$2" chromeless onPress={() => router.back()}>
                Back
              </Button>
            </XStack>
          </XStack>
          {pendingCount > 0 ? (
            <Paragraph color="$foregroundMuted" fontSize={13}>
              {offline ? WAITING_TO_SEND_COPY.offline : WAITING_TO_SEND_COPY.online}
            </Paragraph>
          ) : queued.length === 0 && hazardItems.length === 0 ? (
            <Paragraph color="$foregroundMuted">
              Nothing waiting. Everything you posted has been sent.
            </Paragraph>
          ) : null}
          {hazardItems.map((item) => (
            <HazardItemRow key={item.id} item={item} onDelete={() => removeHazardItem(item.id)} />
          ))}
          {queued.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              onEdit={() => router.navigate(doorHref({ draft: draft.id }))}
              onDelete={() => removeDraft(draft.id)}
            />
          ))}
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}

/** One queued Post (A10 §9.1): its title or its lakes, the latest skate, its state. */
function DraftRow({
  draft,
  onEdit,
  onDelete,
}: {
  draft: PostDraft;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const pending = isFlushable(draft);
  // A sent Post may be live, and the queue resends it as it went: an edit here would be dropped by
  // the server's idempotent create without a word (PR #77 review), so none is offered.
  const sent = postCreateSent(draft);
  const latest = Math.max(...draft.reports.map(reportDraftEndTime).filter(Number.isFinite));
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
          {postDraftLabel(draft)}
        </Text>
        <Badge tone={draft.status === 'error' ? 'solid' : undefined}>
          {draft.status === 'error' ? 'Needs attention' : pending ? 'Waiting' : 'Sent'}
        </Badge>
      </XStack>
      <Text color="$foregroundMuted" fontSize={12}>
        {Number.isFinite(latest) ? `Skated ${formatSkateTime(latest)}` : ''}
        {draft.reports.length > 1 ? ` · ${draft.reports.length} lakes` : ''}
      </Text>
      {draft.status === 'error' && draft.errorMessage ? (
        <Text color="$danger" fontSize={12}>
          {draft.errorMessage}
        </Text>
      ) : null}
      {sent ? (
        <Text color="$foregroundMuted" fontSize={12}>
          {POST_SENT_COPY}
        </Text>
      ) : null}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$2" chromeless onPress={onDelete}>
          Delete
        </Button>
        {draft.status === 'done' || sent ? null : (
          <Button size="$2" onPress={onEdit}>
            Edit
          </Button>
        )}
      </XStack>
    </YStack>
  );
}

/**
 * A queued on-ice hazard or confirmation (Phase 09a). No edit affordance — a hazard is immutable once
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
          {item.status === 'error' ? 'Needs attention' : pending ? 'Waiting' : 'Sent'}
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
