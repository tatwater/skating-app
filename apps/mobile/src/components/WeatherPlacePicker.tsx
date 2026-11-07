import { useRouter } from 'expo-router';
import { Text, XStack, YStack } from 'tamagui';

/**
 * Which place on a giant the Planning tab's weather is about (A06h / open question 5) — the mobile
 * twin of web's `WeatherPlacePicker`, as chips like the season filter beside it.
 *
 * Nothing on the ~99% of bodies with no named bays. On a body with bays it is the scope line and
 * the switcher in one: *"Weather at"* followed by *Whole lake* and a chip per bay, the selected one
 * filled. A lake opens on *Whole lake* (founder call, 2026-11-07, the same default as web).
 *
 * ⚠ Picking a place is a **navigation**: a bay writes the route's `sub` param, the one a search
 * hit sets, so the camera frames the bay, the report feed seeds to it and the panel reads its cell —
 * one selection concept across the sheet (founder call, 2026-09-11); *Whole lake* drops it.
 */
export function WeatherPlacePicker({
  waterBodyId,
  bays,
  selectedId,
}: {
  waterBodyId: string;
  /** Live bays only, in display order. */
  bays: readonly { _id: string; name: string }[];
  /** The bay the panel is currently about, or `null` for the whole lake. */
  selectedId: string | null;
}) {
  const router = useRouter();
  if (bays.length === 0) return null;
  const places = [{ _id: null, name: 'Whole lake' }, ...bays];
  return (
    <YStack gap="$1">
      <Text color="$foregroundMuted" fontSize={13}>
        Weather at
      </Text>
      {/* One choice among several, so the group is a radio group and each chip a radio — not a tab
          list of buttons, which a screen reader announces as two things that do not go together. */}
      <XStack
        gap="$2"
        flexWrap="wrap"
        accessibilityRole="radiogroup"
        accessibilityLabel="Which part of the lake the weather is for"
      >
        {places.map((place) => {
          const selected = place._id === selectedId;
          return (
            <Text
              key={place._id ?? 'whole-lake'}
              accessibilityRole="radio"
              accessibilityLabel={
                place._id === null
                  ? 'Show weather for the whole lake'
                  : `Show weather at ${place.name}`
              }
              accessibilityState={{ checked: selected, selected }}
              onPress={() =>
                router.navigate({
                  pathname: '/water/[id]',
                  params:
                    place._id === null ? { id: waterBodyId } : { id: waterBodyId, sub: place._id },
                })
              }
              paddingHorizontal="$2"
              paddingVertical="$1"
              borderRadius="$3"
              borderWidth={1}
              borderColor={selected ? '$primary' : '$border'}
              color={selected ? '$primary' : '$foregroundMuted'}
              fontSize={13}
            >
              {place.name}
            </Text>
          );
        })}
      </XStack>
    </YStack>
  );
}
