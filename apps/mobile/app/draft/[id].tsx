import type { Id } from '@skating/convex/dataModel';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { Button, Paragraph, YStack } from 'tamagui';
import { ReportForm } from '../../src/components/ReportForm';
import { getDraft } from '../../src/lib/draftStore';

/**
 * Edit a queued offline draft (F2). Hydrates the `ReportForm` from the stored draft (fields, photos,
 * put-in); saving re-upserts it under the same id + idempotencyKey, so a later flush stays deduped.
 * Rendered off the map (no-map put-in fallback). Fully offline-capable.
 */
export default function EditDraftScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const draft = useMemo(() => (id ? getDraft(id) : null), [id]);

  if (!draft) {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        gap="$3"
        padding="$4"
        backgroundColor="$background"
      >
        <Paragraph color="$foregroundMuted">This draft is no longer available.</Paragraph>
        <Button onPress={() => router.back()}>Back</Button>
      </YStack>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} style={{ backgroundColor: 'transparent' }}>
      <ReportForm
        draft={draft}
        waterBodyId={draft.waterBodyId as Id<'waterBodies'> | undefined}
        bodyName={draft.bodyName}
        coord={draft.coord}
        onClose={() => router.back()}
        onSaved={() => router.back()}
      />
    </ScrollView>
  );
}
