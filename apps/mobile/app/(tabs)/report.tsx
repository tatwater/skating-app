import type { Id } from '@skating/convex/dataModel';
import {
  formatSkateTime,
  type HazardQueueItem,
  hazardTypeLabel,
  isFlushable,
  isHazardItemFlushable,
  type ReportDraft,
} from '@skating/core';
import * as Location from 'expo-location';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H4, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import { Badge } from '../../src/components/detailUi';
import { LeavingNotice, useIsLeaving } from '../../src/components/LeavingNotice';
import { useOfflineDrafts } from '../../src/components/OfflineDraftsContext';
import { ReportForm } from '../../src/components/ReportForm';
import { resolveCachedBody } from '../../src/lib/bodyCache';

/**
 * The center "＋ Report" tab (D28). Online, reports are also created in place from a lake's detail
 * drawer (D47); here the form is **the page** — no second tap to reach it (founder, 2026-09-20; this
 * absorbed the old `draft/new` modal). It's the offline capture entry point (Phase 02a §6.2): your GPS
 * binds the report to the nearest cached lake (or it resolves at sync), and below the form sit your
 * queued drafts (pending / errored) with sync + edit + delete. Drafts flush automatically on
 * reconnect (D12); "Sync now" forces it. Picking the lake by name when you're not on it is Phase A10.
 *
 * While a deletion is pending the form goes (D62 amendment) but **the queue stays**: those drafts are
 * the skater's own unsent work, and this is the only screen that can show or delete them. A draft
 * that flushes now fails at the server gate and says so on its row, which is the honest outcome —
 * the alternative is a queue nobody can reach quietly failing forever.
 */
export default function ReportScreen() {
  const router = useRouter();
  const { drafts, hazardItems, pendingCount, refresh, flushNow, removeDraft, removeHazardItem } =
    useOfflineDrafts();
  const leaving = useIsLeaving();
  // Bumped to remount the capture block: Cancel and Save both want a clean form *and* a fresh GPS
  // fix, and a key does both at once. Tab switches don't bump it, so a half-typed report survives a
  // glance at the map.
  const [captureKey, setCaptureKey] = useState(0);
  const resetCapture = useCallback(() => setCaptureKey((k) => k + 1), []);

  // Refresh from sqlite whenever the tab regains focus (e.g. after editing a draft in the modal).
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
            {leaving ? (
              <LeavingNotice />
            ) : (
              <Paragraph color="$foregroundMuted">
                Works with no signal — it posts automatically when you're back online.
              </Paragraph>
            )}
          </YStack>

          {leaving ? null : (
            <ReportCapture
              key={captureKey}
              onClose={resetCapture}
              onSaved={() => {
                // The tab is already focused, so the focus-refresh above won't fire — pull the new
                // draft into the list ourselves before the form clears.
                refresh();
                resetCapture();
              }}
            />
          )}

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

type Located =
  | { phase: 'locating' }
  | { phase: 'denied' }
  /** Permission was fine but the fix never came — location services off, a timeout, an airplane-mode phone. */
  | { phase: 'failed' }
  | {
      phase: 'ready';
      coord: { lat: number; lng: number };
      waterBodyId?: Id<'waterBodies'>;
      bodyName?: string;
    };

/**
 * Locate, then the form. Uses the device GPS to bind the report to the nearest cached lake (Layer-2
 * auto-select); if none is cached, the draft carries just the coord and the lake is resolved
 * server-side at flush (`waterBodies.resolveBodyForCoord`). Rendered off the map, so the `ReportForm`
 * uses its no-map put-in fallback. Everything here can run with no signal. Located once per mount —
 * the parent remounts it (by key) whenever a fresh fix is wanted.
 */
function ReportCapture({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [state, setState] = useState<Located>({ phase: 'locating' });

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!canceled) setState({ phase: 'denied' });
          return;
        }
        const pos = await Location.getCurrentPositionAsync({});
        const coord = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const match = resolveCachedBody(coord);
        if (!canceled) {
          setState({
            phase: 'ready',
            coord,
            waterBodyId: match?.waterBodyId as Id<'waterBodies'> | undefined,
            bodyName: match?.name,
          });
        }
      } catch {
        // Either call rejects when location services are off or the fix times out. Without this
        // the rejection was unhandled and the tab sat on its spinner forever (Greptile, PR #69).
        if (!canceled) setState({ phase: 'failed' });
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  if (state.phase === 'locating') {
    return (
      <YStack alignItems="center" gap="$3" paddingVertical="$6">
        <Spinner color="$primary" />
        <Paragraph color="$foregroundMuted">Finding your location…</Paragraph>
      </YStack>
    );
  }

  if (state.phase === 'denied') {
    return (
      <YStack alignItems="center" gap="$3" paddingVertical="$6">
        <Paragraph color="$foregroundMuted" textAlign="center">
          Location permission is needed to capture a report where you're skating.
        </Paragraph>
        {/* Remounting re-asks: once the permission is granted in Settings the next tap goes through. */}
        <Button onPress={onClose}>Try again</Button>
      </YStack>
    );
  }

  if (state.phase === 'failed') {
    return (
      <YStack alignItems="center" gap="$3" paddingVertical="$6">
        <Paragraph color="$foregroundMuted" textAlign="center">
          Couldn't get your location. Check that location services are on, then try again.
        </Paragraph>
        <Button onPress={onClose}>Try again</Button>
      </YStack>
    );
  }

  return (
    <ReportForm
      coord={state.coord}
      waterBodyId={state.waterBodyId}
      bodyName={state.bodyName}
      onClose={onClose}
      onSaved={onSaved}
    />
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
