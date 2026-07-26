import {
  canRemoveTrack,
  describeStravaPush,
  formatDistanceMiles,
  type QueuedTrack,
  requestStravaPush,
  trackSummary,
} from '@skating/core';
import { useCallback, useEffect, useState } from 'react';
import { Button, Separator, Text, XStack, YStack } from 'tamagui';
import { deleteTrack, listDrafts, listTracks, saveTrack } from '../lib/draftStore';
import { flushDrafts } from '../lib/flushService';

/**
 * Your recorded skates on this device, and what became of each one's Strava copy (Phase 8).
 *
 * **This exists to be the manual retry path.** The queue retries a temporary push failure a bounded
 * number of times (`MAX_STRAVA_PUSH_ATTEMPTS`) and then stops — it has to, because drains fire on
 * every reconnect and Strava rate-limits per application, so an uncapped loop would spend everyone's
 * budget on one stuck track. But "the machine gave up" must not mean "the skate is lost": without a
 * button, a single bad moment during one flush would permanently drop an upload the skater explicitly
 * asked for, with nothing in the app ever mentioning it again. So the state is *shown* — including
 * the boring "on Strava" case, because a list that only appears when something is wrong teaches
 * people to fear it — and anything settled short of uploaded can be asked for again by hand.
 *
 * A person tapping retry is new information, not a repeat of the machine's guess: they reconnected,
 * the outage ended, or they changed their mind about a skate they'd toggled off. That's why the
 * button also covers tracks that were never *meant* for Strava.
 *
 * It's also where a recording the app **couldn't** save is dismissed. A permanent failure that can
 * only sit in the queue forever, invisible, is the thing the hazard queue was given a dismissal for;
 * a skate deserves the same, and saying "we couldn't save this one" out loud is better than a row
 * that quietly claims it's still syncing.
 *
 * Device-local by design: these rows are the offline queue's, not the server's. A skate recorded on
 * another phone isn't here, and the list only knows what this device did.
 */
export function TrackHistory() {
  const [tracks, setTracks] = useState<QueuedTrack[]>([]);
  const [referencedIds, setReferencedIds] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  // Newest first, and only finished sessions — a recording still in progress belongs to the recorder
  // control on the map, not to a history list.
  const refresh = useCallback(() => {
    setTracks(
      listTracks()
        .filter((t) => t.finished)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_ROWS),
    );
    // Which tracks an unflushed report draft still points at, by local id. Those rows can't be
    // deleted: the draft resolves its path through them (see `canRemoveTrack`).
    setReferencedIds(
      new Set(
        listDrafts()
          .map((d) => d.trackDraftId)
          .filter((id): id is string => id !== undefined),
      ),
    );
  }, []);

  useEffect(refresh, [refresh]);

  const retry = useCallback(
    async (track: QueuedTrack) => {
      setBusyId(track.id);
      try {
        // Clear the settled state first, then drain: `requestStravaPush` is what makes the track
        // flushable again, and the flush is what actually sends it.
        saveTrack(requestStravaPush(track, Date.now()));
        refresh();
        await flushDrafts();
      } finally {
        setBusyId(null);
        refresh();
      }
    },
    [refresh],
  );

  const remove = useCallback(
    (track: QueuedTrack) => {
      deleteTrack(track.id);
      refresh();
    },
    [refresh],
  );

  if (tracks.length === 0) return null;

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Your recorded skates
      </Text>
      {tracks.map((track) => (
        <TrackRow
          key={track.id}
          track={track}
          busy={busyId === track.id}
          removable={canRemoveTrack(track, referencedIds)}
          onRetry={() => void retry(track)}
          onRemove={() => remove(track)}
        />
      ))}
      <Separator borderColor="$border" />
    </YStack>
  );
}

/**
 * Enough to cover a season's worth of recent skates without turning settings into a feed. Older rows
 * still exist until the retention sweep drops them (`trackRetention`); they're just not listed.
 */
const MAX_ROWS = 10;

function TrackRow({
  track,
  busy,
  removable,
  onRetry,
  onRemove,
}: {
  track: QueuedTrack;
  busy: boolean;
  removable: boolean;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const push = describeStravaPush(track);
  const summary = trackSummary(track);
  const failed = track.status === 'error';

  return (
    <XStack gap="$2" alignItems="center">
      <YStack flex={1} gap="$1">
        <Text color="$foreground" fontSize={14}>
          {track.bodyName ?? 'Unrecognized water'}
        </Text>
        <Text color="$foregroundMuted" fontSize={12}>
          {new Date(track.startedAt).toLocaleDateString()} ·{' '}
          {formatDistanceMiles(summary.distanceMeters)}
        </Text>
        {/* A recording we couldn't save says so in its own words — it has no Strava state to report,
            and "waiting to sync" would be a lie about a track that is never going to sync. */}
        <Text
          color={failed || push.action === 'retry' ? '$danger' : '$foregroundMuted'}
          fontSize={12}
        >
          {failed ? (track.errorMessage ?? "Couldn't save this skate") : push.label}
        </Text>
      </YStack>
      {!failed && push.action ? (
        <Button size="$2" disabled={busy} onPress={onRetry}>
          {busy ? 'Sending…' : push.action === 'retry' ? 'Retry' : 'Send to Strava'}
        </Button>
      ) : null}
      {removable ? (
        <Button size="$2" chromeless disabled={busy} onPress={onRemove}>
          Remove
        </Button>
      ) : null}
    </XStack>
  );
}
