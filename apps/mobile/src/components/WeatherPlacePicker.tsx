import { useRouter } from 'expo-router';
import { Text, XStack, YStack } from 'tamagui';

/**
 * Which place on a giant the Planning tab's weather is about (N6h / open question 5) — the mobile
 * twin of web's `WeatherPlacePicker`, as chips like the season filter beside it.
 *
 * Nothing on the ~99% of bodies with no named bays. On a body with bays it is the scope line and
 * the switcher in one: *"Weather at"* followed by a chip per bay, the selected one filled.
 *
 * ⚠ Picking a bay is a **navigation**: it writes the route's `sub` param, the one a search hit
 * sets, so the camera frames the bay, the report feed seeds to it and the panel reads its cell —
 * one selection concept across the sheet (founder call, 2026-09-11). The default bay is never
 * written back; `resolveWeatherSubArea` picks it implicitly so opening a lake is not a navigation.
 */
export function WeatherPlacePicker({
  waterBodyId,
  bays,
  selectedId,
}: {
  waterBodyId: string;
  /** Live bays only, in display order. */
  bays: readonly { _id: string; name: string }[];
  /** The bay the panel is currently about — explicit or implicit. */
  selectedId: string | null;
}) {
  const router = useRouter();
  if (bays.length === 0 || selectedId === null) return null;
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
        {bays.map((bay) => {
          const selected = bay._id === selectedId;
          return (
            <Text
              key={bay._id}
              accessibilityRole="radio"
              accessibilityLabel={`Show weather at ${bay.name}`}
              accessibilityState={{ checked: selected, selected }}
              onPress={() =>
                router.navigate({
                  pathname: '/water/[id]',
                  params: { id: waterBodyId, sub: bay._id },
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
              {bay.name}
            </Text>
          );
        })}
      </XStack>
    </YStack>
  );
}
