import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faChevronDown } from '@fortawesome/sharp-light-svg-icons';
import { DOB_MONTHS, ONBOARDING_COPY } from '@skating/core';
import { useState } from 'react';
import { Modal, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';
import { ONBOARDING_COPY_MOBILE } from '../../lib/onboardingCopyMobile';

/**
 * The date of birth's month, picked by name (board 11.1). A field-shaped button that opens a plain
 * list of the twelve months in a modal — the app's existing picker pattern (`sheet/BodyPicker`),
 * rather than a new select component the phone hasn't used before.
 */
export function MonthPicker({
  month,
  onChange,
  problem,
}: {
  /** 1–12, or `null` until picked. */
  month: number | null;
  onChange: (month: number) => void;
  /** The field's underline goes amber with the date's problem. */
  problem: boolean;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const name = month !== null ? DOB_MONTHS[month - 1] : undefined;

  return (
    <>
      <XStack
        flex={1}
        minHeight={44}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderColor={problem ? 'warning' : 'border'}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={
          name
            ? `${ONBOARDING_COPY.account.month}: ${name}`
            : ONBOARDING_COPY_MOBILE.account.pickMonth
        }
      >
        <Text color={name ? 'foreground' : 'foregroundMuted'} fontSize={16}>
          {name ?? ONBOARDING_COPY.account.month}
        </Text>
        <FontAwesomeIcon icon={faChevronDown} size={14} color={theme.foregroundMuted?.val} />
      </XStack>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <YStack
          flex={1}
          backgroundColor="background"
          paddingTop={insets.top}
          paddingBottom={insets.bottom}
        >
          <XStack padding="4" alignItems="center" justifyContent="space-between">
            <Text color="foreground" fontSize={18} fontWeight="700">
              {ONBOARDING_COPY_MOBILE.account.pickMonth}
            </Text>
            <Button size="sm" variant="quiet" onPress={() => setOpen(false)}>
              {ONBOARDING_COPY_MOBILE.account.cancel}
            </Button>
          </XStack>
          <ScrollView>
            {DOB_MONTHS.map((label, i) => {
              const selected = month === i + 1;
              return (
                <XStack
                  key={label}
                  paddingHorizontal="4"
                  minHeight={52}
                  alignItems="center"
                  borderBottomWidth={1}
                  borderColor="border"
                  backgroundColor={selected ? 'surfaceMuted' : 'press:surfaceMuted'}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    onChange(i + 1);
                    setOpen(false);
                  }}
                >
                  <Text color="foreground" fontSize={16} fontWeight={selected ? '700' : '400'}>
                    {label}
                  </Text>
                </XStack>
              );
            })}
          </ScrollView>
        </YStack>
      </Modal>
    </>
  );
}
