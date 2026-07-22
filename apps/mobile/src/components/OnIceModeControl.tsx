import { NO_ALERT_IS_NOT_ALL_CLEAR } from '@skating/core';
import { useState } from 'react';
import { Button, Paragraph, Switch, Text, XStack, YStack } from 'tamagui';
import { armOnIceMode, disarmOnIceMode, setOnIceCadence, useOnIceMode } from '../lib/onIceMode';
import { useMapSelection } from './MapSelectionContext';

/**
 * On-ice mode arm/disarm (D54 Layer 2). Opt-in, session-scoped: the skater turns it on when they start,
 * and it keeps warning them about reported hazards *ahead* while they skate with the phone pocketed and
 * the screen asleep — delivering the directional alert as a local notification. There is deliberately
 * **no keep-awake**; the screen sleeps normally and we lean on background location + notifications.
 *
 * It only appears once GPS has resolved to a lake — off the ice there's nothing to arm. The persistent
 * "on-ice mode is on" affordance the OS shows (Android's foreground-service notification / iOS's blue
 * location pill) is the always-visible indicator; this in-app control is the discoverable on/off and the
 * home of the re-alert-cadence choice.
 *
 * ⚠ **Silence is not an all-clear (D3).** The copy says so outright, because a proximity system that has
 * only ever been quiet is the most dangerous signal we could emit — and it gets more dangerous, not less,
 * once it's running in your pocket.
 */
export function OnIceModeControl() {
  const { onIceWaterBodyId, hazardDraft } = useMapSelection();
  const { armed, cadence } = useOnIceMode();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Nothing to arm off the ice; and stay out of the way while a hazard is being captured (the adjust
  // bar owns the bottom of the screen then).
  if (!onIceWaterBodyId || hazardDraft) return null;

  async function toggle() {
    if (armed) {
      disarmOnIceMode();
      setExpanded(false);
      return;
    }
    setBusy(true);
    try {
      await armOnIceMode();
    } finally {
      setBusy(false);
    }
  }

  if (!armed) {
    return (
      <Button
        position="absolute"
        bottom={132}
        left={16}
        zIndex={30}
        size="$4"
        backgroundColor="$surface"
        borderColor="$border"
        borderWidth={1}
        disabled={busy}
        onPress={toggle}
        accessibilityLabel="Start on-ice mode"
      >
        {busy ? 'Starting…' : '⛸ Start on-ice mode'}
      </Button>
    );
  }

  return (
    <YStack
      position="absolute"
      bottom={132}
      left={16}
      right={72}
      zIndex={30}
      backgroundColor="$surface"
      borderColor="$primary"
      borderWidth={1}
      borderRadius="$4"
      padding="$3"
      gap="$2"
    >
      <XStack justifyContent="space-between" alignItems="center">
        <Text color="$foreground" fontWeight="700">
          ⛸ On-ice mode is on
        </Text>
        <Button size="$2" chromeless onPress={toggle} accessibilityLabel="Stop on-ice mode">
          Stop
        </Button>
      </XStack>

      <Button size="$2" chromeless onPress={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide options' : 'Options'}
      </Button>

      {expanded ? (
        <XStack justifyContent="space-between" alignItems="center" gap="$2">
          <YStack flex={1}>
            <Text color="$foreground" fontSize={13}>
              Remind me on every approach
            </Text>
            <Paragraph color="$foregroundMuted" fontSize={11}>
              Off: warn once per hazard this session. On: warn again each time you skate back to
              one.
            </Paragraph>
          </YStack>
          <Switch
            size="$2"
            checked={cadence === 'every_approach'}
            onCheckedChange={(on) => setOnIceCadence(on ? 'every_approach' : 'once_per_session')}
            accessibilityLabel="Remind me on every approach"
          >
            <Switch.Thumb />
          </Switch>
        </XStack>
      ) : null}

      <Paragraph color="$foregroundMuted" fontSize={11}>
        {NO_ALERT_IS_NOT_ALL_CLEAR}
      </Paragraph>
    </YStack>
  );
}
