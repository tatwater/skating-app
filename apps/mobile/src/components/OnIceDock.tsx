import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faIceSkate } from '@fortawesome/sharp-light-svg-icons';
import { formatDistanceMiles, NO_ALERT_IS_NOT_ALL_CLEAR } from '@skating/core';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { Button, Paragraph, Switch, Text, useTheme, XStack, YStack } from 'tamagui';
import { onIceControlMode } from '../lib/onIce';
import { armOnIceMode, disarmOnIceMode, setOnIceCadence, useOnIceMode } from '../lib/onIceMode';
import {
  pauseRecording,
  resumeRecording,
  setUploadToStrava,
  startRecording,
  stopRecording,
  useRecorder,
} from '../lib/recorder';
import { useIsLeaving } from './LeavingNotice';
import { useMapSelection } from './MapSelectionContext';

/**
 * Going on the ice, as one control (founder, 2026-08-26).
 *
 * This was two permanent buttons stacked in the bottom-left corner — "Start on-ice mode" (D54 Layer 2:
 * keep warning me about hazards ahead) and "Record my skate" (Phase 8: keep the track) — floating over
 * the sheet, the search bar and each other on every route, reserving space for a drawer position they
 * then ignored. They are not two decisions a skater makes. They are one thing — *I'm going out on the
 * ice* — and then a second, smaller thing they may or may not also want, which is a recording of it.
 *
 * So there is one button now. It arms on-ice mode, and the panel it opens is where recording lives.
 * Arming is the cheap half (no continuous high-accuracy GPS until you press record), so it's the right
 * default to put behind one tap; and a skater who wanted the track was always going to want the
 * warnings too.
 *
 * ## Where it sits, and what it yields to
 *
 * On the map's bottom rail, opposite `ImageryDock` and riding the same `bottom` — so it clears the
 * sheet wherever the sheet settled, instead of hovering over it. Its placement is `MapView`'s job (it
 * owns the rail's geometry); this component only reports back whether it's a button or a panel, because
 * two full-width boxes cannot share one line.
 *
 * The collapsed button appears **only on the lake you're standing on, once you've selected it** — the
 * exact mirror of `BackToLakeButton`, which appears only when you haven't. `onIceControlMode` holds that
 * rule and its one exception: a session already running is never hidden by walking away from it.
 *
 * ⚠ **Silence is not an all-clear (D3).** The disclaimer rides in the panel, because a proximity system
 * that has only ever been quiet is the most dangerous signal we could emit.
 */
export function OnIceDock({
  bottom,
  onExpandedChange,
}: {
  /** Distance above the map's bottom edge: clear of the sheet, and of the imagery dock. */
  bottom: number;
  /**
   * True while this is a panel rather than a button — i.e. while it needs the rail's full width.
   * `MapView` folds the imagery timeline away when it hears this, the same way the sheet rising folds
   * it away: the layer stays on the map, only the scrubber gives up the line.
   */
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { onIceWaterBodyId, highlightWaterBodyId, hazardDraft } = useMapSelection();
  const { armed, cadence } = useOnIceMode();
  const recorder = useRecorder();
  const leaving = useIsLeaving();
  const router = useRouter();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  /** The just-finished skate, offered as a report until the skater acts on it or waves it off. */
  const [finished, setFinished] = useState<{ id: string; waterBodyId?: string } | null>(null);

  const recording = recorder.status !== 'idle';
  const mode = onIceControlMode({
    onIceWaterBodyId,
    selectedWaterBodyId: highlightWaterBodyId,
    armed,
    sessionActive: recording || finished !== null,
    capturingHazard: hazardDraft !== null,
  });

  // Announced from an effect rather than during render — this is a message to a sibling's layout, and
  // writing a parent's state mid-render is the one thing React will not have.
  useEffect(() => {
    onExpandedChange(mode === 'panel');
  }, [mode, onExpandedChange]);

  async function arm() {
    setBusy(true);
    try {
      await armOnIceMode();
    } finally {
      setBusy(false);
    }
  }

  function disarm() {
    disarmOnIceMode();
    setShowOptions(false);
  }

  async function startSkate() {
    setBusy(true);
    try {
      // Seed the lake from what GPS already resolved on-device, so a track recorded with no signal
      // still knows where it was — the server re-checks the hint at ingest either way.
      await startRecording(onIceWaterBodyId ? { waterBodyId: onIceWaterBodyId } : {});
    } finally {
      setBusy(false);
    }
  }

  async function stopSkate() {
    setBusy(true);
    try {
      const track = await stopRecording();
      setShowOptions(false);
      // Offer the report immediately. The track is safe on disk either way — this is the prompt, not
      // the save — but a skater who has to go find the button later mostly doesn't, and the path on
      // the report is the entire point of having recorded.
      if (track) {
        setFinished({
          id: track.id,
          ...(track.waterBodyId ? { waterBodyId: track.waterBodyId } : {}),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'hidden') return null;

  return (
    <Animated.View
      // `box-none` so the map keeps the space this doesn't occupy — the wrapper spans the rail to
      // right-align a button, and a button must not eat taps beside it.
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 16, right: 16, bottom, zIndex: 20 }}
    >
      <Animated.View
        // The grow, matching `ImageryDock`: the button becomes the panel rather than being replaced
        // by it. A device that drops the animation gets the same geometry, just snapped.
        layout={LinearTransition.duration(220)}
        style={{ alignSelf: mode === 'panel' ? 'stretch' : 'flex-end' }}
      >
        {mode === 'panel' ? (
          <Animated.View entering={FadeIn.duration(160)}>
            <YStack
              padding="$3"
              borderRadius="$4"
              backgroundColor="$surface"
              borderColor="$primary"
              borderWidth={1}
              gap="$2"
            >
              {finished ? (
                <FinishedSkate
                  finished={finished}
                  onDismiss={() => setFinished(null)}
                  onReport={(bodyId, trackId) => {
                    setFinished(null);
                    router.navigate({
                      pathname: '/water/[id]',
                      params: { id: bodyId, track: trackId },
                    });
                  }}
                />
              ) : (
                <>
                  {armed ? (
                    <XStack justifyContent="space-between" alignItems="center">
                      <Text color="$foreground" fontWeight="700">
                        ⛸ On-ice mode is on
                      </Text>
                      <Button
                        size="$2"
                        chromeless
                        onPress={disarm}
                        accessibilityLabel="Stop on-ice mode"
                      >
                        Stop
                      </Button>
                    </XStack>
                  ) : null}

                  {recording ? (
                    <RecordingRows recorder={recorder} busy={busy} onStop={stopSkate} />
                  ) : null}

                  {/* No offer while a deletion is pending: a recording exists to become a report,
                      and a pending deletion can't post one (D62 amendment) — `ingestTrack` would
                      refuse the finished track. The alerting half is untouched; it's safety, not
                      contribution. */}
                  {!recording && !leaving ? (
                    <Button
                      size="$3"
                      backgroundColor="$surface"
                      borderColor="$border"
                      borderWidth={1}
                      disabled={busy}
                      onPress={startSkate}
                      accessibilityLabel="Record my skate"
                    >
                      {busy ? 'Starting…' : '⏺ Record my skate'}
                    </Button>
                  ) : null}

                  <Button size="$2" chromeless onPress={() => setShowOptions((v) => !v)}>
                    {showOptions ? 'Hide options' : 'Options'}
                  </Button>

                  {showOptions ? (
                    <YStack gap="$2">
                      {armed ? (
                        <OptionRow
                          title="Remind me on every approach"
                          detail="Off: warn once per hazard this session. On: warn again each time you skate back to one."
                          checked={cadence === 'every_approach'}
                          onChange={(on) =>
                            setOnIceCadence(on ? 'every_approach' : 'once_per_session')
                          }
                        />
                      ) : null}
                      {recording ? (
                        <OptionRow
                          title="Also upload to Strava"
                          detail="Sends this skate to your own Strava account when it syncs. Turn it off if your watch already records there."
                          checked={recorder.uploadToStrava}
                          onChange={setUploadToStrava}
                        />
                      ) : null}
                    </YStack>
                  ) : null}

                  {/* The battery cost is stated, not buried (D3 copy). Record mode holds the GPS
                      radio at navigation-grade accuracy; we say so before someone commits three
                      hours to it. */}
                  {recording ? (
                    <Paragraph color="$foregroundMuted" fontSize={11}>
                      Recording uses GPS continuously — expect roughly 5–12% battery per hour, more
                      in the cold. You can lock the screen; recording continues.
                    </Paragraph>
                  ) : null}

                  {armed ? (
                    <Paragraph color="$foregroundMuted" fontSize={11}>
                      {NO_ALERT_IS_NOT_ALL_CLEAR}
                    </Paragraph>
                  ) : null}
                </>
              )}
            </YStack>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(160)}>
            <Button
              size="$3"
              backgroundColor="$surface"
              borderColor="$border"
              borderWidth={1}
              disabled={busy}
              onPress={arm}
              accessibilityLabel="Start on-ice mode"
            >
              <FontAwesomeIcon icon={faIceSkate} size={14} color={theme.foreground?.val} />
              <Text color="$foreground">{busy ? 'Starting…' : 'On ice'}</Text>
            </Button>
          </Animated.View>
        )}
      </Animated.View>
    </Animated.View>
  );
}

/** One labelled switch — the cadence choice and the Strava choice have the same shape. */
function OptionRow({
  title,
  detail,
  checked,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <XStack justifyContent="space-between" alignItems="center" gap="$2">
      <YStack flex={1}>
        <Text color="$foreground" fontSize={13}>
          {title}
        </Text>
        <Paragraph color="$foregroundMuted" fontSize={11}>
          {detail}
        </Paragraph>
      </YStack>
      <Switch size="$2" checked={checked} onCheckedChange={onChange} accessibilityLabel={title}>
        <Switch.Thumb />
      </Switch>
    </XStack>
  );
}

/** The live recording: what's been captured so far, and the two controls over it. */
function RecordingRows({
  recorder,
  busy,
  onStop,
}: {
  recorder: ReturnType<typeof useRecorder>;
  busy: boolean;
  onStop: () => void;
}) {
  const paused = recorder.status === 'paused';
  const minutes = Math.floor(recorder.elapsedSeconds / 60);

  return (
    <>
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
            onPress={onStop}
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
    </>
  );
}

/**
 * The post-skate prompt. Dismissing it never deletes anything: the recording is queued, it will sync,
 * and it stays available to attach to a report later.
 */
function FinishedSkate({
  finished,
  onDismiss,
  onReport,
}: {
  finished: { id: string; waterBodyId?: string };
  onDismiss: () => void;
  onReport: (waterBodyId: string, trackId: string) => void;
}) {
  return (
    <>
      <Text color="$foreground" fontWeight="700">
        Skate saved
      </Text>
      <Paragraph color="$foregroundMuted" fontSize={12}>
        {finished.waterBodyId
          ? 'Want to post a report? Your recorded path goes on it, so other skaters can see where the ice was good.'
          : "We couldn't match this to a lake we know. You can add it from your track — that's the only way new water gets on the map."}
      </Paragraph>
      <XStack gap="$2">
        <Button
          size="$3"
          flex={1}
          disabled={!finished.waterBodyId}
          onPress={() => {
            if (finished.waterBodyId) onReport(finished.waterBodyId, finished.id);
          }}
        >
          Report this skate
        </Button>
        <Button size="$3" chromeless onPress={onDismiss}>
          Not now
        </Button>
      </XStack>
    </>
  );
}
