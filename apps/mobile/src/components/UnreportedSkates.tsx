import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatSkateTime, freshnessRefusal } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';
import { Section } from './detailUi';
import { NewWaterPrompt } from './NewWaterPrompt';

/**
 * Skates you recorded and never turned into a report (A06f) — the other half of the recorder's loop.
 *
 * ## Why this exists
 *
 * The prompt on stop has always been **component state on a map control**: it lives on a card that
 * unmounts the moment you navigate, it is never persisted, and it never touched the server — so
 * `promptState` never left `pending` for any activity ever recorded, and `listMine` and
 * `setPromptState` sat with zero callers since Phase 08. Background the app during a skate, or tap
 * "Not now" and change your mind, and the recording was unreachable from anywhere in the product.
 * The path was on disk and on the server; nothing offered it to you again.
 *
 * ## Why it is server-backed, unlike `TrackHistory` above it
 *
 * `TrackHistory` is the device's offline queue: what *this phone* recorded and whether Strava took
 * it. This is the account's, so it shows a skate recorded on a phone you no longer carry — and it is
 * the only one of the two that knows whether a report was ever written, because `linkedReportId` is
 * the server's fact. The two answer different questions and are deliberately not merged.
 *
 * ## Dismissing never deletes
 *
 * `dismissed` takes a skate off this list and touches nothing else: the activity, its path and its
 * aggregate-track contribution all stay. It is a statement about this prompt, not about the skate —
 * which is why the copy says "not reporting this one" rather than anything about removal.
 */
export function UnreportedSkates() {
  const activities = useQuery(api.gpsActivities.listMine, { limit: 20 });
  const setPromptState = useMutation(api.gpsActivities.setPromptState);
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  /** The row whose "add it from your track" prompt is open (A07b PR 2 / D108). */
  const [adding, setAdding] = useState<string | null>(null);

  // A skate is unreported when nothing links it to a report and the owner hasn't waved it off.
  // `linkedReportId` leads because it is the fact — `promptState` can lag a conversion that happened
  // on another device, and a row offering to report an already-reported skate is the worse error.
  // And inside the freshness window (D199, A10 §9.4): a skate older than a week can no longer be
  // reported, so offering it would be offering a refusal. The track stays; only the prompt goes.
  const now = Date.now();
  const rows = (activities ?? []).filter(
    (a) =>
      a.linkedReportId === undefined &&
      a.promptState !== 'dismissed' &&
      freshnessRefusal(a.endTime ?? a.startTime, now) === null,
  );

  if (rows.length === 0) return null;

  return (
    <Section label="Skates you haven't reported">
      <YStack gap="$2">
        {rows.map((row) => (
          <YStack key={row.activityId} gap="$1.5">
            <Text color="$foreground">
              {row.waterBodyName ?? 'An unmatched lake'} · {formatSkateTime(row.startTime)}
            </Text>
            <XStack gap="$2" flexWrap="wrap">
              <Button
                size="$2"
                disabled={busy === row.activityId || !row.waterBodyId}
                onPress={() => {
                  // Mark `prompted` as we hand off — the transition the stop-card could never make,
                  // because at stop time the track usually hasn't flushed and has no server id yet.
                  void setPromptState({
                    activityId: row.activityId as Id<'gpsActivities'>,
                    promptState: 'prompted',
                  }).catch(() => {});
                  router.navigate({
                    pathname: '/report',
                    params: {
                      body: row.waterBodyId as string,
                      ...(row.waterBodyName ? { name: row.waterBodyName } : {}),
                      activity: row.activityId,
                    },
                  });
                }}
              >
                Report this skate
              </Button>
              <Button
                size="$2"
                chromeless
                disabled={busy === row.activityId}
                onPress={async () => {
                  setBusy(row.activityId);
                  try {
                    await setPromptState({
                      activityId: row.activityId as Id<'gpsActivities'>,
                      promptState: 'dismissed',
                    });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Not reporting this one
              </Button>
            </XStack>
            {row.waterBodyId ? null : adding === row.activityId ? (
              // The D14 / D108 case: a skate on water the corpus doesn't have. This is the surface
              // the plan said to wire rather than write — the prompt takes exactly this server
              // activity id, offers the ranked matches first (a dormant or removed lake included),
              // and only then a track-derived body.
              <NewWaterPrompt
                activityId={row.activityId}
                onResolved={(waterBodyId) => {
                  setAdding(null);
                  router.navigate({
                    pathname: '/report',
                    params: { body: waterBodyId, activity: row.activityId },
                  });
                }}
                onDismiss={() => setAdding(null)}
              />
            ) : (
              <YStack gap="$2">
                <Paragraph color="$foregroundMuted" fontSize={12}>
                  We couldn't match this to a lake we know.
                </Paragraph>
                <Button size="$2" variant="outlined" onPress={() => setAdding(row.activityId)}>
                  Add it from your track
                </Button>
              </YStack>
            )}
          </YStack>
        ))}
      </YStack>
    </Section>
  );
}
