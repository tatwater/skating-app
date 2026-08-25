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
 * **Marks size up.** Web's 8 px hit target is a mouse target. These are 20 px wide with the visible
 * mark drawn inside, because a stop nobody can reliably tap is a stop that is not there.
 */

import {
  type BodyTimeline,
  bandsIn,
  frameSourceLabel,
  nearestLandableStop,
  type SeasonIndex,
  stopCaption,
  type TimelineStop,
} from '@skating/core';
import { useEffect } from 'react';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

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
}: {
  timeline: BodyTimeline | null;
  index: SeasonIndex | null;
  band: string;
  onBandChange: (band: string) => void;
  selected: number | null;
  onSelect: (index: number) => void;
  loading: boolean;
  error?: boolean;
}) {
  const stops = timeline?.stops ?? [];
  const bands = index ? bandsIn(index) : [];

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
  const companionCaption =
    current?.companion && current.companion.frame.capturedAt !== current.frame.capturedAt
      ? stopCaption({ ...current, frame: current.companion.frame })
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

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <XStack alignItems="flex-end" accessibilityRole="tablist">
          {stops.map((stop, i) => (
            <StopMark
              key={`${stop.frame.granuleId}:${stop.frame.band}`}
              stop={stop}
              selected={i === selected}
              onPress={() => stop.landable && onSelect(i)}
            />
          ))}
        </XStack>
      </ScrollView>

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
          {caption.caveat ? (
            <Text color="$foregroundMuted">
              {' · '}
              {caption.caveat}
            </Text>
          ) : null}
        </Text>
      ) : null}

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

/** One pass. 20 px of hit target around a hairline mark — a stop nobody can tap is not a stop. */
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
      width={20}
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
