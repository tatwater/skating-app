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
  formatSeasonLabel,
  frameSourceHint,
  frameSourceLabel,
  type IndexedFrame,
  nearestLandableStop,
  nearestLandableStopToDate,
  notchAtOffset,
  notchFraction,
  type SeasonIndex,
  stopCaption,
  type TimelineStop,
} from '@skating/core';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Text, XStack, YStack } from 'tamagui';

/**
 * Wide enough to read as a handle and to leave a window worth looking through — 12 less two 2 px
 * walls is 8 px of clear space over a 2 px mark, four times what it has to clear — and narrow enough
 * not to bury its neighbours, which in a dense winter are 6 px apart.
 */
const THUMB_WIDTH = 12;

export function FreezeUpScrubber({
  timeline,
  index,
  band,
  onBandChange,
  selected,
  onSelect,
  loading,
  anchorAt = null,
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
  /**
   * Where the skater was, as a **date** — the capture time of whatever they last chose, which
   * survives a band switch that the stop list does not. See web's note.
   */
  anchorAt?: string | null;
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
  /**
   * ⚠ **An index the current stops do not have is *nothing chosen*, not a choice** — web's note
   * carries the argument. Switching bands swaps the stop list underneath the selection (a winter has
   * ~30 optical passes and ~9 radar ones), and a stale index left the thumb and the caption blank
   * while `selected` stayed non-null, which is the exact condition that stopped the auto-select
   * effect from choosing anything.
   */
  const chosen = selected !== null && selected < stops.length ? selected : null;
  const thumbFraction = chosen === null ? null : notchFraction(chosen, stops.length);
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
    if (chosen === null || stops[chosen]?.landable !== false) return;
    const landable = nearestLandableStop(stops, chosen, direction);
    if (landable !== null) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onSelect(landable);
    }
  }, [chosen, stops, onSelect]);

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
    if (chosen !== null || stops.length === 0) return;
    // ⚠ **The anchor first, and it is a date rather than an index.** Switching bands swaps a ~30-pass
    // optical season for a ~9-pass radar one; carrying the number across means nothing, and landing
    // on "most recent" throws away the part of the winter the skater was reading. The date is what
    // they meant. `nearestLandableStopToDate` returns null when the anchor cannot be honoured, and
    // then this is an ordinary opening: the season runs forward to now, so now is where it starts.
    const anchored = anchorAt ? nearestLandableStopToDate(stops, anchorAt) : null;
    const landing = anchored ?? nearestLandableStop(stops, stops.length - 1);
    if (landing !== null) onSelect(landing);
  }, [chosen, stops, onSelect, anchorAt]);

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

  const current = chosen !== null ? stops[chosen] : undefined;
  const caption = current ? stopCaption(current) : null;
  // ⚠ **Captions what is on the map, not what this stop declares.** A held companion outlives the
  // stop that supplied it (see `framesToRender`), so reading `current.companion` would leave half the
  // lake showing a date the caption never named.
  const shownCompanion = renderedCompanion ?? current?.companion?.frame ?? null;
  // ⚠ **Built from the companion's own frame and nothing else.** Spreading the primary stop in
  // carried the *primary's* `stats` across, so the companion's caveat would have reported the
  // primary's cloud and coverage figures over the companion's date.
  const companionCaptionRaw = shownCompanion
    ? stopCaption({ frame: shownCompanion, landable: true, basis: 'unknown' })
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
    // ⚠ **No heading here.** The title and the season live one level up, in the dock's heading row,
    // sharing it with the close button — see `ImageryDock`, and web's `ImageryControl` for the whole
    // argument. They had to move together: the X on that row has to exist even where this component
    // does not. The track's accessible name still carries the season, because a screen reader
    // reaching it has not necessarily read the heading.
    <YStack gap="$2">
      <GestureDetector gesture={pan}>
        <XStack
          // The height is the thumb's, not the marks'. See the geometry note on the thumb: the
          // handle stands 4 clear of the tallest mark at both ends, and 36 = 4 + 2 + 24 + 2 + 4.
          height={36}
          position="relative"
          alignItems="flex-end"
          paddingBottom={6}
          onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel={`Satellite passes over this lake, ${formatSeasonLabel(timeline.season)}`}
        >
          {stops.map((stop, i) => (
            <StopMark
              key={`${stop.frame.granuleId}:${stop.frame.band}`}
              stop={stop}
              selected={i === chosen}
              // `flex={1}` rather than a fixed width: the whole season fits the box, so a dense
              // winter packs tighter instead of scrolling out of reach of the drag.
              onPress={() => onSelect(i)}
            />
          ))}

          {/*
           * The thumb — **the thing being dragged**, and the reason the marks got thinner.
           *
           * > **Founder, 2026-08-26:** *"I'd love for this to feel more physical, like the user is
           * > really dragging something. Then the notches themselves can become thinner, with more
           * > space in-between, because they're not touch targets, the thumb is."*
           *
           * ⚠ **The whole track still takes the gesture**, which matters more here than on web: a
           * 12 pt handle is under the minimum anything should have to be hit, and at sixty passes a
           * thumb already covers the mark it is choosing. The handle says the control is grabbable;
           * the `Gesture.Pan` on the track — `minDistance(0)`, so a tap counts — is what makes it
           * forgiving. `pointerEvents="none"` keeps the handle from ever intercepting that.
           *
           * Placed from the measured width, so it cannot be drawn before the track has a size — and
           * it is the same arithmetic `notchAtOffset` reads back, which is pinned as a round-trip in
           * `scrubberTrack`. No animation: during a drag the handle is following a finger that is
           * already there, and a tap elsewhere on a discrete track is a jump, not a journey.
           *
           * ## ⚠ Hollow, which matters more on a phone than anywhere
           *
           * > **Founder, 2026-08-26:** *"if you could see through it, then you could understand what
           * > the notch you're covering is (short & gray vs tall & blue) to know whether you're ON
           * > the date of the image you see vs in-between dates, without having to remember."*
           *
           * A filled handle hides the one mark whose state is being asked about. Here a **thumb** is
           * over it as well, so the window is the only way that mark is ever seen during the gesture
           * that selects it.
           *
           * ⚠ **And it contains the mark rather than meeting it.** An outline flush with the tick's
           * ends reads as gripping it, not standing over it, so there is an equal 4 of clear space at
           * both: `36 = 4 + 2 border + 24 tick + 2 border + 4`. Which is why the handle is the whole
           * height of the track while the marks sit 6 up from its floor.
           */}
          {thumbFraction !== null && trackWidth > 0 ? (
            <XStack
              position="absolute"
              bottom={0}
              left={thumbFraction * trackWidth - THUMB_WIDTH / 2}
              width={THUMB_WIDTH}
              height={36}
              borderRadius={THUMB_WIDTH / 2}
              backgroundColor="transparent"
              borderWidth={2}
              borderColor="$primary"
              pointerEvents="none"
            />
          ) : null}
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

      {/* ⚠ **How to read the band, which the band's own name does not say** — web's note carries the
          argument. Rendered whether or not the toggle is: a season with one band still leaves a
          reader looking at a picture nobody has told them how to read. */}
      {frameSourceHint(band) ? (
        <Text color="$foregroundMuted" fontSize="$1">
          {frameSourceHint(band)}
        </Text>
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
 * One pass: a hairline tick, inside a row that is mostly empty space.
 *
 * Flexes to an equal share of the track rather than taking a fixed width, because the whole season
 * has to fit for a drag across it to mean anything. A sparse winter therefore gets wide slices and a
 * dense one narrow ones — which is why the haptic tick matters: at sixty passes a slice is under 6 px
 * and a thumb covers the mark it is choosing.
 *
 * ⚠ **The row did not get smaller when the mark did.** It still takes its full share and still
 * carries the accessible name and state, because that is what a screen reader walks and what a tap
 * lands on. Only the ink shrank.
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
      // The tallest mark's own height, so the row's top edge *is* the tick's top edge and the gap to
      // the thumb's outline is the track's padding and nothing else — see the geometry note there.
      height={24}
      alignItems="flex-end"
      justifyContent="center"
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !stop.landable }}
    >
      {/* ⚠ **No selected state — the thumb is standing on it.** Coloring the mark underneath would
          draw the same fact twice, and the half the handle covers would read as a shadow on it. The
          landable/blocked distinction stays, in height and color, because that is the one a skater
          has to be able to read at a glance. */}
      <XStack
        width={2}
        height={stop.landable ? 24 : 10}
        borderRadius={1}
        backgroundColor={stop.landable ? '$primary' : '$border'}
        opacity={stop.landable ? 0.5 : 1}
      />
    </XStack>
  );
}
