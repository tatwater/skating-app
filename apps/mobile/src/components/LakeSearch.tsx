import { api } from '@skating/convex/api';
import { humanizeEnum, searchQueryArg } from '@skating/core';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Input, Text, YStack } from 'tamagui';

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
  const type = humanizeEnum(hit.type);
  return hit.states.length ? `${type} · ${hit.states.join(', ')}` : type;
}

/**
 * Presentational lake-search box (Tamagui), the mobile mirror of web's `LakeSearchBox`. Convex-free
 * so it's testable. Renders a search input over the map and, when `showResults`, a dropdown of
 * pressable result rows (or a "no lakes" line). Positioned as an absolute overlay below the status
 * bar; selecting a row is the container's job (navigate to the lake).
 */
export function LakeSearchBox({
  items,
  value,
  onChangeText,
  onSelect,
  showResults,
  emptyVisible,
  topInset = 0,
}: {
  items: LakeHit[];
  value: string;
  onChangeText: (text: string) => void;
  onSelect: (hit: LakeHit) => void;
  showResults: boolean;
  emptyVisible: boolean;
  topInset?: number;
}) {
  return (
    <YStack position="absolute" top={topInset + 8} left={12} right={12} gap="$2" zIndex={10}>
      <Input
        value={value}
        onChangeText={onChangeText}
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
              <Text color="$foreground">{hit.name || 'Unnamed water'}</Text>
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
  );
}

/**
 * Map search box (Phase 2.5) — full-text lake lookup over the regional corpus via
 * `waterBodies.searchByName` (server-side, typo-tolerant); debounced and skipped under 2 chars.
 * Selecting a result navigates to `/water/[id]`, whose drawer flies the map to the lake (reusing the
 * existing fly-to), so search needs no map wiring of its own.
 */
export function LakeSearch() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(id);
  }, [text]);

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
