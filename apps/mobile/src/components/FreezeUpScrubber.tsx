/**
 * The freeze-up scrubber on mobile (N6e §C4, D146).
 *
 * Same decisions as web's, and the same reasons — the arguments are in
 * `apps/web/src/components/FreezeUpScrubber.tsx` and in `imageryTimeline`, which is where the logic
 * they describe actually lives. What is here is the parts that had to differ:
 *
 * **Over the map, not in the sheet.** D146 settled this for mobile first: the skater *collapses* the
 * sheet without dismissing it, and the control is there. A scrubber inside a sheet would be a control
 * for a map it was covering.
 *
 * **Taps, not arrow keys.** There is no roving tabindex to build. A blocked stop still renders and
 * still carries its reason as an accessible label with `accessibilityState.disabled`, so VoiceOver
 * and TalkBack explain it exactly as a screen reader does on web.
 *
 * **Drag, with a tick at every notch.** A traditional scrubber, which is what a timeline reads as —
 * so the track takes a pan gesture, snaps to the nearest notch under the finger, and fires a light
 * haptic each time the finger crosses into a new one. The tick is what makes a dense track usable
 * without watching it: sixty passes in a phone's width is under 6 px each, and a thumb covers the
 * mark it is choosing.
 *
 * ⚠ **The whole season therefore has to fit.** A scrolling track can be read a section at a time; a
 * track you *drag across* cannot, because the gesture has no meaning without both ends visible. So
 * notches are placed by fraction of the measured width and a dense winter packs tighter — which is
 * also honest about the sampling.
 */

import {
  type BodyTimeline,
  bandsIn,
  crossedNotch,
  frameSourceLabel,
  type IndexedFrame,
  nearestLandableStop,
  notchAtOffset,
  type SeasonIndex,
  stopCaption,
  type TimelineStop,
} from '@skating/core';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Text, XStack, YStack } from 'tamagui';

/** `winter-2025-26` → `winter 2025–26`. */
function seasonLabel(season: string): string {
  const match = /^winter-(\d{4})-(\d{2})$/.exec(season);
  return match ? `winter ${match[1]}–${match[2]}` : season;
}

export function FreezeUpScrubber({
  timeline,
  index,
  band,
  onBandChange,
  selected,
  onSelect,
  loading,
  error = false,
  renderedCompanion = null,
}: {
  timeline: BodyTimeline | null;
  index: SeasonIndex | null;
  band: string;
  onBandChange: (band: string) => void;
  selected: number | null;
  onSelect: (index: number) => void;
  loading: boolean;
  error?: boolean;
  /**
   * The seam half actually on the map, which can outlive the stop that supplied it.
   *
   * Passed in rather than read off the stop because the holding happens where the frames are mounted
   * — and a caption naming a different frame from the one on screen is the D84 failure this module is
   * arranged to avoid.
   */
  renderedCompanion?: IndexedFrame | null;
}) {
  const stops = timeline?.stops ?? [];
  const bands = index ? bandsIn(index) : [];
  const [trackWidth, setTrackWidth] = useState(0);
  // The notch the finger was last over, so a tick fires on *crossing* rather than on every sample.
  const lastNotch = useRef<number | null>(null);
  const dragDirection = useRef<1 | -1 | 0>(0);

  const scrubTo = useCallback(
    (x: number) => {
      const notch = notchAtOffset(x, trackWidth, stops.length);
      if (notch === null) return;
      // ⚠ **Snap to the nearest notch, including a blocked one.** Skipping ahead to the nearest
      // landable stop would make the thumb outrun the finger and feel broken — and it would hide that
      // a date exists and is unusable, which is the entire reason blocked stops are drawn.
      if (crossedNotch(lastNotch.current, notch)) {
        dragDirection.current = notch > (lastNotch.current ?? 0) ? 1 : -1;
        // ⚠ **Two weights, because they mean different things.** A firm tick says *there is a picture
        // here*; a faint one says *this date exists and you cannot land on it*. That is the same
        // distinction the drawn marks make, in the only channel available while a thumb is covering
        // them — and it is what lets a skater feel their way to a usable frame without watching.
        void Haptics.impactAsync(
          stops[notch]?.landable
            ? Haptics.ImpactFeedbackStyle.Medium
            : Haptics.ImpactFeedbackStyle.Light,
        );
      }
      lastNotch.current = notch;
      onSelect(notch);
    },
    [trackWidth, stops, onSelect],
  );

  // ⚠ Releasing on a clouded date slides to one with a picture, in the direction the finger was
  // going. Parking on a blocked notch would leave caption and image disagreeing at rest; snapping
  // *back* would send the skater to a date they had already scrubbed past.
  const settle = useCallback(() => {
    const direction = dragDirection.current;
    dragDirection.current = 0;
    lastNotch.current = null;
    if (selected === null || stops[selected]?.landable !== false) return;
    const landable = nearestLandableStop(stops, selected, direction);
    if (landable !== null) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onSelect(landable);
    }
  }, [selected, stops, onSelect]);

  // ⚠ `.runOnJS(true)`, so the handlers are plain JS callbacks rather than worklets. The selection
  // lives in React state and the haptic is a native module call — neither is worklet-safe, and the
  // failure for both is a runtime crash on the UI thread rather than a type error here.
  //
  // `minDistance(0)` makes a tap scrub as well, so the track does not have two behaviours a finger
  // has to know about before touching it.
  const pan = Gesture.Pan()
    .minDistance(0)
    .runOnJS(true)
    .onBegin((event) => {
      lastNotch.current = null;
      scrubTo(event.x);
    })
    .onUpdate((event) => scrubTo(event.x))
    .onFinalize(settle);

  // Open on the most recent usable pass: a skater asking about a lake is asking about now.
  useEffect(() => {
    if (selected !== null || stops.length === 0) return;
    const last = nearestLandableStop(stops, stops.length - 1);
    if (last !== null) onSelect(last);
  }, [selected, stops, onSelect]);

  if (loading) {
    return (
      <Text color="$foregroundMuted" fontSize="$2">
        Loading the freeze-up timeline…
      </Text>
    );
  }

  // ⚠ No timeline is not the same claim as no passes. An unreachable archive, a fetch in flight and
  // an unconfigured base URL all land here, and none of them is knowledge about this lake — see the
  // web component, where saying otherwise was a live bug.
  if (!timeline) {
    return error ? (
      <Text color="$foregroundMuted" fontSize="$2">
        The freeze-up archive could not be reached.
      </Text>
    ) : null;
  }

  if (stops.length === 0) {
    return (
      <Text color="$foregroundMuted" fontSize="$2">
        No satellite passes recorded over this lake this season.
      </Text>
    );
  }

  const current = selected !== null ? stops[selected] : undefined;
  const caption = current ? stopCaption(current) : null;
  // ⚠ **Captions what is on the map, not what this stop declares.** A held companion outlives the
  // stop that supplied it (see `framesToRender`), so reading `current.companion` would leave half the
  // lake showing a date the caption never named.
  const shownCompanion = renderedCompanion ?? current?.companion?.frame ?? null;
  const companionCaptionRaw = shownCompanion
    ? stopCaption({ ...(current as TimelineStop), frame: shownCompanion })
    : null;
  // ⚠ Compared as **rendered labels**, not as instants. Two granules from one pass are seconds apart,
  // so an instant comparison called them different and rendered "Dec 12, 2025 + Dec 12, 2025" — which
  // is what a device showed on Quabbin. The question is whether a reader sees two dates, and that is
  // a question about the strings.
  const companionCaption =
    companionCaptionRaw && caption && companionCaptionRaw.date !== caption.date
      ? companionCaptionRaw
      : null;

  return (
    <YStack gap="$2">
      <XStack justifyContent="space-between" alignItems="baseline" gap="$2">
        <Text fontSize="$3" fontWeight="600">
          Freeze-up timeline
        </Text>
        <Text color="$foregroundMuted" fontSize="$1">
          {seasonLabel(timeline.season)}
        </Text>
      </XStack>

      <GestureDetector gesture={pan}>
        <XStack
          height={32}
          alignItems="flex-end"
          onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel={`Satellite passes over this lake, ${seasonLabel(timeline.season)}`}
        >
          {stops.map((stop, i) => (
            <StopMark
              key={`${stop.frame.granuleId}:${stop.frame.band}`}
              stop={stop}
              selected={i === selected}
              // `flex={1}` rather than a fixed width: the whole season fits the box, so a dense
              // winter packs tighter instead of scrolling out of reach of the drag.
              onPress={() => onSelect(i)}
            />
          ))}
        </XStack>
      </GestureDetector>

      {/* The date is content, not furniture (D84/C4). */}
      {caption ? (
        <Text fontSize="$2" accessibilityLiveRegion="polite">
          <Text fontWeight="600">{caption.date}</Text>
          {/* A seam's second date at the same weight as the first — both halves are on screen. */}
          {companionCaption ? <Text fontWeight="600"> + {companionCaption.date}</Text> : null}
          <Text color="$foregroundMuted">
            {' · '}
            {caption.source}
          </Text>
        </Text>
      ) : null}

      {/* ⚠ Always rendered. The caveat's length varies with the cloud figure, so letting it appear
          and vanish changes the panel's height — under a thumb that is mid-drag. A control that
          resizes out from under the finger operating it is the one thing a scrubber must not do. */}
      <Text color="$foregroundMuted" fontSize="$1" minHeight={16}>
        {caption?.caveat ?? ' '}
      </Text>

      {companionCaption ? (
        <Text color="$foregroundMuted" fontSize="$1">
          Two passes, joined — this lake sits across a granule edge, so each half was photographed
          on its own date.
        </Text>
      ) : null}

      {bands.length > 1 ? (
        <XStack gap="$2" flexWrap="wrap">
          {bands.map((option) => (
            <Text
              key={option}
              fontSize="$1"
              paddingHorizontal="$2"
              paddingVertical="$1"
              borderRadius="$2"
              borderWidth={1}
              borderColor={option === band ? '$primary' : '$border'}
              color={option === band ? '$primary' : '$foregroundMuted'}
              onPress={() => onBandChange(option)}
              accessibilityRole="button"
              accessibilityState={{ selected: option === band }}
              accessibilityLabel={frameSourceLabel(option)}
            >
              {frameSourceLabel(option)}
            </Text>
          ))}
        </XStack>
      ) : null}

      {timeline.coverageInferred + timeline.coverageUnknown > 0 ? (
        <Text color="$foregroundMuted" fontSize="$1">
          {timeline.coverageInferred + timeline.coverageUnknown} of {stops.length} passes not yet
          confirmed against this lake.
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * One pass.
 *
 * Flexes to an equal share of the track rather than taking a fixed width, because the whole season
 * has to fit for a drag across it to mean anything. A sparse winter therefore gets fat targets and a
 * dense one gets thin ones — which is why the haptic tick matters: at sixty passes a mark is under
 * 6 px and a thumb covers the one it is choosing.
 */
function StopMark({
  stop,
  selected,
  onPress,
}: {
  stop: TimelineStop;
  selected: boolean;
  onPress: () => void;
}) {
  const caption = stopCaption(stop);
  // The reason travels in the accessible name, so a blocked mark explains itself to a screen reader
  // exactly as it does to an eye. That is the whole point of drawing blocked stops at all.
  const label = [caption.date, caption.source, caption.caveat].filter(Boolean).join(' — ');

  return (
    <XStack
      flex={1}
      height={28}
      alignItems="flex-end"
      justifyContent="center"
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !stop.landable }}
    >
      <XStack
        width={4}
        height={stop.landable ? 24 : 12}
        borderRadius={2}
        backgroundColor={stop.landable ? (selected ? '$primary' : '$foregroundMuted') : '$border'}
      />
    </XStack>
  );
}
