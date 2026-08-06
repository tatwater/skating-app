import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { USER_SELECTABLE_WATER_BODY_CLASSES, waterBodyClassLabel } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button, Input, Paragraph, Text, XStack, YStack } from 'tamagui';

/**
 * "You skated somewhere we don't have on the map" — the D14/D36 create-or-attach flow, reached only
 * from a **recorded skate** that resolved to no known water.
 *
 * Two rules shape this screen, both enforced server-side rather than merely presented here:
 *
 * 1. **Path-only.** There is no draw tool, no map-tap outline, no radius slider. The shape comes from
 *    the track and nothing else, because a hand-drawn blob carries no proof that anyone was there and
 *    no frame of reference for scale — and once it exists, other people's reports attach to it.
 * 2. **Attaching beats creating.** The ranked matches are shown *first* and creating requires
 *    explicitly rejecting them ("None of these"). The cheapest dedup is the one that never creates
 *    the duplicate, and a skater who attaches to the existing lake has done more good than one who
 *    mints a second copy of it.
 *
 * Either way the new body is auto-visible and reviewed after the fact (D37) with its dedup verdict
 * stamped — so a moderator sees it in the merge queue even when the skater was sure it was new.
 */
export function NewWaterPrompt({
  activityId,
  onResolved,
  onDismiss,
}: {
  activityId: string;
  onResolved: (waterBodyId: string) => void;
  onDismiss: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof USER_SELECTABLE_WATER_BODY_CLASSES)[number]>('lakePond');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showingCreate, setShowingCreate] = useState(false);

  const candidates = useQuery(api.waterBodies.findMatchCandidates, {
    activityId: activityId as Id<'gpsActivities'>,
    ...(name ? { name } : {}),
  });
  const createBody = useMutation(api.waterBodies.create);

  if (candidates === undefined) return null;

  // A track we can't derive a shape from (a recording that never really moved) can't create water.
  // Say so plainly rather than showing a create form that will fail.
  if (!candidates.derivable) {
    return (
      <YStack padding="$3" gap="$2">
        <Text color="$foreground" fontWeight="700">
          We couldn't map this skate
        </Text>
        <Paragraph color="$foregroundMuted" fontSize={13}>
          The recording didn't cover enough ground to outline new water. You can still post a report
          on a lake you pick yourself.
        </Paragraph>
        <Button size="$3" onPress={onDismiss}>
          OK
        </Button>
      </YStack>
    );
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const id = await createBody({
        name: name.trim(),
        type,
        activityId: activityId as Id<'gpsActivities'>,
        confirmedNew: true,
      });
      onResolved(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create this lake.');
    } finally {
      setBusy(false);
    }
  }

  const hasMatches = candidates.matches.length > 0;

  return (
    <YStack padding="$3" gap="$3">
      <YStack gap="$1">
        <Text color="$foreground" fontWeight="700">
          New water?
        </Text>
        <Paragraph color="$foregroundMuted" fontSize={13}>
          This skate didn't match a lake we know about. We'll outline it from your recorded track —
          that's the only way water gets added, so the shape always comes from somewhere someone
          actually skated.
        </Paragraph>
      </YStack>

      {hasMatches && !showingCreate ? (
        <YStack gap="$2">
          <Paragraph color="$foreground" fontSize={13}>
            These are close by — is it one of them?
          </Paragraph>
          {candidates.matches.map((match) => (
            <Button
              key={match.waterBodyId}
              size="$3"
              backgroundColor="$surface"
              borderColor="$border"
              borderWidth={1}
              onPress={() => onResolved(match.waterBodyId)}
            >
              <YStack flex={1} alignItems="flex-start">
                <Text color="$foreground">{match.name || 'Unnamed water'}</Text>
                <Text color="$foregroundMuted" fontSize={11}>
                  {match.centroidDistanceM} m away
                  {match.official ? ' · on the official map' : ''}
                </Text>
              </YStack>
            </Button>
          ))}
          <Button size="$3" chromeless onPress={() => setShowingCreate(true)}>
            None of these — it's new
          </Button>
        </YStack>
      ) : (
        <YStack gap="$2">
          <Input
            value={name}
            onChangeText={setName}
            placeholder="What's it called?"
            accessibilityLabel="Name of the water"
          />
          <XStack gap="$2" flexWrap="wrap">
            {USER_SELECTABLE_WATER_BODY_CLASSES.map((t) => (
              <Button
                key={t}
                size="$2"
                backgroundColor={t === type ? '$primary' : '$surface'}
                borderColor="$border"
                borderWidth={1}
                onPress={() => setType(t)}
              >
                {waterBodyClassLabel(t)}
              </Button>
            ))}
          </XStack>
          {error ? (
            <Paragraph color="$danger" fontSize={12}>
              {error}
            </Paragraph>
          ) : null}
          <Paragraph color="$foregroundMuted" fontSize={11}>
            A moderator will check it later. If it turns out to be somewhere we already have,
            they'll merge the two — nothing you post is lost.
          </Paragraph>
          <XStack gap="$2">
            <Button size="$3" flex={1} disabled={busy || !name.trim()} onPress={create}>
              {busy ? 'Adding…' : 'Add it'}
            </Button>
            <Button
              size="$3"
              chromeless
              onPress={hasMatches ? () => setShowingCreate(false) : onDismiss}
            >
              {hasMatches ? 'Back' : 'Not now'}
            </Button>
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}
