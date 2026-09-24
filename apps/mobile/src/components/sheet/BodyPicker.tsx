import { api } from '@skating/convex/api';
import { searchQueryArg, waterBodyClassLabel } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, H4, Text, XStack, YStack } from 'tamagui';
import { listCachedBodies } from '../../lib/bodyCache';
import { Input } from '../ThemedInputs';

export interface PickedBody {
  waterBodyId: string;
  name: string;
}

/**
 * Pick a water body by name for the sheet (A10 §4.2 — the *search* door, which §4.3's *add
 * another lake* needs anyway): the catalog's search when there is signal, the lakes this phone
 * has viewed when there is not. A bay hit picks its parent — a bay is a `where`, not a body.
 */
export function BodyPicker({
  open,
  onPick,
  onClose,
}: {
  open: boolean;
  onPick: (body: PickedBody) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    if (!open) setText('');
  }, [open]);

  const arg = searchQueryArg(debounced);
  const results = useQuery(api.waterBodies.searchByName, arg);
  const cached = useMemo(() => (open ? listCachedBodies() : []), [open]);
  const query = debounced.trim().toLowerCase();
  const offlineHits = cached.filter(
    (b) => query.length < 2 || b.name.toLowerCase().includes(query),
  );

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <YStack flex={1} backgroundColor="$background" paddingTop={insets.top} padding="$4" gap="$3">
        <XStack alignItems="center" justifyContent="space-between">
          <H4 color="$foreground">Which lake?</H4>
          <Button size="$2" chromeless onPress={onClose}>
            Cancel
          </Button>
        </XStack>
        <Input
          autoFocus
          placeholder="Search by name"
          value={text}
          onChangeText={setText}
          autoCorrect={false}
        />
        <ScrollView keyboardShouldPersistTaps="handled">
          <YStack gap="$1">
            {(results ?? []).map((hit) => (
              <Row
                key={hit._id}
                title={hit.name}
                meta={
                  hit.kind === 'subArea' && hit.parentName
                    ? `in ${hit.parentName}`
                    : [waterBodyClassLabel(hit.type), ...hit.states].join(' · ')
                }
                onPress={() =>
                  onPick({
                    waterBodyId: hit.waterBodyId,
                    name: hit.kind === 'subArea' && hit.parentName ? hit.parentName : hit.name,
                  })
                }
              />
            ))}
            {results === undefined || results.length === 0 ? (
              <>
                {offlineHits.length > 0 ? (
                  <Text
                    color="$foregroundMuted"
                    fontSize={11}
                    letterSpacing={1.5}
                    textTransform="uppercase"
                    paddingVertical="$2"
                  >
                    {query.length >= 2 ? 'Lakes you have viewed' : 'Recently viewed'}
                  </Text>
                ) : null}
                {offlineHits.map((b) => (
                  <Row
                    key={b.waterBodyId}
                    title={b.name}
                    meta={b.states.join(', ')}
                    onPress={() => onPick({ waterBodyId: b.waterBodyId, name: b.name })}
                  />
                ))}
              </>
            ) : null}
            {arg !== 'skip' &&
            results !== undefined &&
            results.length === 0 &&
            offlineHits.length === 0 ? (
              <Text color="$foregroundMuted" paddingVertical="$3">
                Nothing by that name. Try another spelling, or the lake's town.
              </Text>
            ) : null}
          </YStack>
        </ScrollView>
      </YStack>
    </Modal>
  );
}

function Row({ title, meta, onPress }: { title: string; meta: string; onPress: () => void }) {
  return (
    <YStack
      paddingVertical="$2.5"
      paddingHorizontal="$2"
      borderRadius="$3"
      pressStyle={{ backgroundColor: '$surfaceMuted' }}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text color="$foreground" fontSize={15}>
        {title}
      </Text>
      {meta ? (
        <Text color="$foregroundMuted" fontSize={12}>
          {meta}
        </Text>
      ) : null}
    </YStack>
  );
}
