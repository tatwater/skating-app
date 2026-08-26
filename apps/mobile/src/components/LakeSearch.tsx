import { api } from '@skating/convex/api';
import { searchQueryArg, waterBodyClassLabel, waterBodyDisplayName } from '@skating/core';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, YStack } from 'tamagui';
import { Input } from './ThemedInputs';

/** A search result row from `waterBodies.searchByName` — a lake, or a named bay inside one (D60). */
export type LakeHit = {
  kind: 'body' | 'subArea';
  _id: string;
  /** The page to open. For a bay this is its **parent** — a sub-area is a name on a lake, not a
   *  page of its own — framed on the bay's own bbox. */
  waterBodyId: string;
  name: string;
  /** Set on a bay hit, so the row can say which lake it's part of. */
  parentName?: string;
  type: string;
  centroid: { lat: number; lng: number };
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  states: string[];
};

/**
 * The meta line on a result row: "Lake · NY" for a body, "in Lake Champlain" for a bay.
 *
 * A bay's own type would be its parent's, which tells you nothing you didn't just read — where it
 * *is* does, and it's the disambiguation people need when three lakes have a South Bay.
 */
function hitMeta(hit: LakeHit): string {
  if (hit.kind === 'subArea' && hit.parentName) return `in ${hit.parentName}`;
  const type = waterBodyClassLabel(hit.type);
  return hit.states.length ? `${type} · ${hit.states.join(', ')}` : type;
}

/** How long the bar takes to leave/return. Long enough to read as one object moving, short enough
 *  that a back-tap doesn't feel like it's waiting on an animation. */
const SLIDE_MS = 220;

/** Where the bar sits before it's measured — an Input's rough height, so the very first hide (if it
 *  somehow beats layout) still clears the screen rather than parking the bar half-visible. */
const FALLBACK_INPUT_HEIGHT = 48;

/**
 * How much vertical room the bar claims below the safe-area inset, for anything that has to start
 * *under* it — currently `BackToLakeButton`, which used to overlap it on tall phones.
 *
 * The nominal height plus a gap, not a measurement: the bar's real height is known only inside this
 * component and only after layout, and a control that jumped once the first layout landed would be
 * worse than one that's a couple of points off at a large font scale.
 */
export const SEARCH_BAR_SLOT = FALLBACK_INPUT_HEIGHT + 8;

/**
 * Presentational lake-search box (Tamagui), the mobile mirror of web's `LakeSearchBox`. Convex-free
 * so it's testable. Renders a search input over the map and, when `showResults`, a dropdown of
 * pressable result rows (or a "no lakes" line). Positioned as an absolute overlay below the status
 * bar; selecting a row is the container's job (navigate to the lake).
 *
 * `hidden` scoots the whole bar up past the top edge (founder, 2026-08-26: it eats too much of the
 * single-body view). It **translates** rather than unmounting so the return is a drop-in from the
 * top rather than a pop, and so the input keeps its identity across the transition.
 *
 * ⚠ The slide distance is measured off the **input row only**, never the container: the container
 * grows by the results dropdown, so a container-height offset would send the bar a variable and
 * sometimes screen-tall distance depending on what happened to be typed when the drawer opened.
 */
export function LakeSearchBox({
  items,
  value,
  onChangeText,
  onSelect,
  showResults,
  emptyVisible,
  topInset = 0,
  hidden = false,
}: {
  items: LakeHit[];
  value: string;
  onChangeText: (text: string) => void;
  onSelect: (hit: LakeHit) => void;
  showResults: boolean;
  emptyVisible: boolean;
  topInset?: number;
  hidden?: boolean;
}) {
  const [inputHeight, setInputHeight] = useState(FALLBACK_INPUT_HEIGHT);
  // Seeded from `hidden`, not 0. A deep link (or the on-ice auto-select) can land the app directly on
  // a detail route, where starting at 0 would paint the bar for one frame and *then* slide it out —
  // a flash of a control that was never meant to be on that screen. The effect below only ever
  // animates *transitions*.
  const offset = useSharedValue(hidden ? -(topInset + 8 + FALLBACK_INPUT_HEIGHT + 8) : 0);

  const onInputLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setInputHeight(height);
  };

  // The bar's own top edge is at `topInset + 8`, so clearing the screen means travelling that plus
  // its height — and a little more, so nothing peeks out under a rounded display corner.
  const travel = topInset + 8 + inputHeight + 8;

  useEffect(() => {
    offset.value = withTiming(hidden ? -travel : 0, {
      duration: SLIDE_MS,
      // Out with acceleration (it's leaving, don't linger), back in with a decelerating settle.
      easing: hidden ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
    });
  }, [hidden, travel, offset]);

  const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));

  return (
    <Animated.View
      style={[
        { position: 'absolute', top: topInset + 8, left: 12, right: 12, zIndex: 10 },
        slideStyle,
      ]}
      // Off-screen but still in the tree: keep it out of the touch and screen-reader paths, or a
      // blind skater lands on a search box that isn't on the screen they're being read.
      pointerEvents={hidden ? 'none' : 'auto'}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
    >
      <YStack gap="$2">
        <Input
          value={value}
          onChangeText={onChangeText}
          onLayout={onInputLayout}
          placeholder="Search lakes by name…"
          backgroundColor="$background"
          borderColor="$border"
          aria-label="Search lakes by name"
          testID="lake-search-input"
        />
        {showResults ? (
          <YStack
            backgroundColor="$background"
            borderColor="$border"
            borderWidth={1}
            borderRadius="$4"
            overflow="hidden"
          >
            {items.map((hit) => (
              <YStack
                key={hit._id}
                onPress={() => onSelect(hit)}
                paddingHorizontal="$3"
                paddingVertical="$2.5"
                pressStyle={{ backgroundColor: '$surfaceMuted' }}
                accessibilityRole="button"
                testID={`lake-search-result-${hit._id}`}
              >
                <Text color="$foreground">{waterBodyDisplayName(hit.name)}</Text>
                <Text color="$foregroundMuted" fontSize="$1">
                  {hitMeta(hit)}
                </Text>
              </YStack>
            ))}
            {emptyVisible ? (
              <Text color="$foregroundMuted" paddingHorizontal="$3" paddingVertical="$3">
                No lakes found.
              </Text>
            ) : null}
          </YStack>
        ) : null}
      </YStack>
    </Animated.View>
  );
}

/**
 * Map search box (Phase 2.5) — full-text lake lookup over the regional corpus via
 * `waterBodies.searchByName` (server-side, typo-tolerant); debounced and skipped under 2 chars.
 * Selecting a result navigates to `/water/[id]`, whose drawer flies the map to the lake (reusing the
 * existing fly-to), so search needs no map wiring of its own.
 *
 * `hidden` is the layout's drawer state: search belongs to pan-around mode, and the single-body view
 * can't spare the strip.
 */
export function LakeSearch({ hidden = false }: { hidden?: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(id);
  }, [text]);

  // Leave with an empty box, so the drop-in is a fresh search rather than the stale query that led
  // here — and so nothing re-runs `searchByName` for a bar nobody can see. Also dismisses the
  // keyboard: typing then tapping a map feature would otherwise slide the bar out from under a
  // keyboard still holding half the screen.
  useEffect(() => {
    if (!hidden) return;
    setText('');
    Keyboard.dismiss();
  }, [hidden]);

  const arg = searchQueryArg(debounced);
  const results = useQuery(api.waterBodies.searchByName, arg);
  const loaded = arg !== 'skip' && results !== undefined;

  return (
    <LakeSearchBox
      items={results ?? []}
      value={text}
      onChangeText={setText}
      showResults={loaded}
      emptyVisible={loaded && (results?.length ?? 0) === 0}
      topInset={insets.top}
      hidden={hidden}
      onSelect={(hit) => {
        setText('');
        Keyboard.dismiss();
        // A bay opens its parent's page; `sub` says which bay, so the map frames the bay rather
        // than the whole lake (step 8).
        router.navigate({
          pathname: '/water/[id]',
          params: { id: hit.waterBodyId, ...(hit.kind === 'subArea' ? { sub: hit._id } : {}) },
        });
      }}
    />
  );
}
