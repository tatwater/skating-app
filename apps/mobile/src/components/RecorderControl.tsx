import { formatDistanceMiles } from '@skating/core';
import { useState } from 'react';
import { Button, Paragraph, Switch, Text, XStack, YStack } from 'tamagui';
import {
  pauseRecording,
  resumeRecording,
  setUploadToStrava,
  startRecording,
  stopRecording,
  useRecorder,
} from '../lib/recorder';
import { useMapSelection } from './MapSelectionContext';

/**
 * The track recorder's on-map control (Phase 8), sitting alongside `OnIceModeControl` because the two
 * are **orthogonal choices about the same skate**: "keep watching for hazards" and "record my skate".
 * Keeping them adjacent is what makes that legible — and it's where the skater already goes to start a
 * session. When both are on, the GPS session runs at record fidelity (see `onIceTask`).
 *
 * **The battery cost is stated, not buried (D3 copy).** Record mode holds the GPS radio at
 * navigation-grade accuracy; on a cold phone that's the upper end of roughly 5–12 %/hr. We say so, in
 * those words, before the skater commits three hours to it. We are not pretending to beat a dedicated
 * watch — this is for the phone-only skater and for capturing the path behind a report.
 *
 * The OS affordance (Android's "Recording your skate" foreground-service notification / iOS's blue
 * location pill) is the always-visible indicator that we're recording; this is the discoverable
 * on/off, the live stats, and the home of the per-session Strava choice.
 */
export function RecorderControl() {
  const { onIceWaterBodyId, hazardDraft } = useMapSelection();
  const recorder = useRecorder();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Stay out of the way while a hazard is being captured — the adjust bar owns the bottom then.
  if (hazardDraft) return null;
  // Off the ice there's nothing to record, unless a session is already running (in which case the
  // control must stay reachable however far the skater has wandered from a mapped lake).
  if (!onIceWaterBodyId && recorder.status === 'idle') return null;

  async function start() {
    setBusy(true);
    try {
      // Seed the lake from what GPS already resolved on-device, so a track recorded with no signal
      // still knows where it was — the server re-checks the hint at ingest either way.
      await startRecording(onIceWaterBodyId ? { waterBodyId: onIceWaterBodyId } : {});
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await stopRecording();
      setExpanded(false);
    } finally {
      setBusy(false);
    }
  }

  if (recorder.status === 'idle') {
    return (
      <Button
        position="absolute"
        bottom={188}
        left={16}
        zIndex={30}
        size="$4"
        backgroundColor="$surface"
        borderColor="$border"
        borderWidth={1}
        disabled={busy}
        onPress={start}
        accessibilityLabel="Record my skate"
      >
        {busy ? 'Starting…' : '⏺ Record my skate'}
      </Button>
    );
  }

  const minutes = Math.floor(recorder.elapsedSeconds / 60);
  const paused = recorder.status === 'paused';

  return (
    <YStack
      position="absolute"
      bottom={188}
      left={16}
      right={72}
      zIndex={30}
      backgroundColor="$surface"
      borderColor="$primary"
      borderWidth={1}
      borderRadius="$4"
      padding="$3"
      gap="$2"
    >
      <XStack justifyContent="space-between" alignItems="center">
        <Text color="$foreground" fontWeight="700">
          {paused ? '⏸ Recording paused' : '⏺ Recording your skate'}
        </Text>
        <XStack gap="$2">
          <Button
            size="$2"
            chromeless
            onPress={paused ? resumeRecording : pauseRecording}
            accessibilityLabel={paused ? 'Resume recording' : 'Pause recording'}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            size="$2"
            chromeless
            disabled={busy}
            onPress={stop}
            accessibilityLabel="Stop recording"
          >
            Stop
          </Button>
        </XStack>
      </XStack>

      <Text color="$foreground" fontSize={13}>
        {formatDistanceMiles(recorder.distanceMeters)} · {minutes} min · {recorder.pointCount}{' '}
        points
      </Text>

      {/* The "I forgot to stop it" nudge. It never auto-stops: a genuine rest on the ice must not
          truncate someone's skate, so we ask rather than decide. */}
      {recorder.stationaryPrompt ? (
        <Paragraph color="$foregroundMuted" fontSize={12}>
          You haven't moved in a while. Still skating? If you're done, tap Stop — we'll keep
          everything recorded so far.
        </Paragraph>
      ) : null}

      <Button size="$2" chromeless onPress={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide options' : 'Options'}
      </Button>

      {expanded ? (
        <XStack justifyContent="space-between" alignItems="center" gap="$2">
          <YStack flex={1}>
            <Text color="$foreground" fontSize={13}>
              Also upload to Strava
            </Text>
            <Paragraph color="$foregroundMuted" fontSize={11}>
              Sends this skate to your own Strava account when it syncs. Turn it off if your watch
              already records there.
            </Paragraph>
          </YStack>
          <Switch
            size="$2"
            checked={recorder.uploadToStrava}
            onCheckedChange={setUploadToStrava}
            accessibilityLabel="Also upload to Strava"
          >
            <Switch.Thumb />
          </Switch>
        </XStack>
      ) : null}

      <Paragraph color="$foregroundMuted" fontSize={11}>
        Recording uses GPS continuously — expect roughly 5–12% battery per hour, more in the cold.
        You can lock the screen; recording continues.
      </Paragraph>
    </YStack>
  );
}
