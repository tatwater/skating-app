import { formatSkateTime, isHeldDraft, postDraftLabel, reportDraftEndTime } from '@skating/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';
import { useOfflineDrafts } from '../src/components/OfflineDraftsContext';
import { doorHref } from '../src/lib/sheetDoors';

/**
 * *Drafts* (A10-3): the Posts the author saved to come back to. Never sent until they open one and
 * tap *Post* — a draft is "not done yet" by definition (founder call, 2026-09-21). Reached from the
 * sheet's header; a tap reopens the draft on the sheet under the same id.
 */
export default function DraftsScreen() {
  const router = useRouter();
  const { drafts, refresh, removeDraft } = useOfflineDrafts();
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  const held = drafts.filter(isHeldDraft);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <YStack gap="$4">
          <XStack alignItems="center" justifyContent="space-between">
            <H4 color="$foreground">Drafts</H4>
            <Button size="$2" chromeless onPress={() => router.back()}>
              Back
            </Button>
          </XStack>
          {held.length === 0 ? (
            <Paragraph color="$foregroundMuted">
              Nothing saved. *Save draft* on the sheet keeps a half-written report here until you
              post it.
            </Paragraph>
          ) : null}
          {held.map((draft) => {
            const latest = Math.max(
              ...draft.reports.map(reportDraftEndTime).filter(Number.isFinite),
            );
            return (
              <YStack
                key={draft.id}
                gap="$2"
                padding="$3"
                borderWidth={1}
                borderColor="$border"
                borderRadius="$4"
                backgroundColor="$surfaceMuted"
              >
                <Text color="$foreground" fontWeight="600">
                  {postDraftLabel(draft)}
                </Text>
                <Text color="$foregroundMuted" fontSize={12}>
                  {Number.isFinite(latest)
                    ? `Skated ${formatSkateTime(latest)}`
                    : 'No end time yet'}
                  {draft.reports.length > 1 ? ` · ${draft.reports.length} lakes` : ''}
                </Text>
                <XStack gap="$2" justifyContent="flex-end">
                  <Button size="$2" chromeless onPress={() => removeDraft(draft.id)}>
                    Delete
                  </Button>
                  <Button size="$2" onPress={() => router.navigate(doorHref({ draft: draft.id }))}>
                    Open
                  </Button>
                </XStack>
              </YStack>
            );
          })}
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}
