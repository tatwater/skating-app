import { ONBOARDING_COPY, onboardingStepLabel } from '@skating/core';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H2, Paragraph, Text, XStack, YStack } from 'tamagui';
import { tapTargetSlop } from '../../lib/tapTarget';

/**
 * The phone's onboarding screen (B03 §9.7, rows 11): a bar with *Sign out*, an optional hairline
 * under it (the terms' reading progress), the step's page scrolling in the middle, and a foot that
 * holds the step's buttons in reach of a thumb. Drawn from the app's existing tokens as an
 * approximation of the boards; the re-skin to the mocks' look comes later.
 */
export function OnboardingFrame({
  onSignOut,
  progress,
  foot,
  scrollRef,
  scrollProps,
  children,
}: {
  /** The bar's *Sign out*; absent on the season card, whose own second button is the way out. */
  onSignOut?: () => void;
  /** The hairline's fill, 0–1; absent draws no hairline. */
  progress?: number;
  foot?: ReactNode;
  scrollRef?: Ref<ScrollViewInstance>;
  scrollProps?: Omit<ComponentProps<typeof ScrollView>, 'children' | 'ref'>;
  children: ReactNode;
}) {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <YStack flex={1} backgroundColor="background">
          <XStack
            minHeight={52}
            paddingHorizontal="4"
            alignItems="center"
            justifyContent="flex-end"
            borderBottomWidth={progress === undefined ? 1 : 0}
            borderColor="border"
          >
            {onSignOut ? (
              <Button
                size="sm"
                variant="outlined"
                borderColor="border"
                color="foreground"
                hitSlop={tapTargetSlop('$2')}
                onPress={onSignOut}
              >
                {ONBOARDING_COPY.foot.signOut}
              </Button>
            ) : null}
          </XStack>
          {progress !== undefined ? <Hairline progress={progress} /> : null}
          <ScrollView
            ref={scrollRef}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ flexGrow: 1 }}
            {...scrollProps}
          >
            <YStack padding="4" gap="3">
              {children}
            </YStack>
          </ScrollView>
          {foot ? (
            <YStack padding="4" gap="3" borderTopWidth={1} borderColor="border">
              {foot}
            </YStack>
          ) : null}
        </YStack>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** The reading progress under the bar: a thin line that fills as the terms scroll. */
function Hairline({ progress }: { progress: number }) {
  const pct = `${Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10}%` as const;
  return (
    <YStack
      height={2}
      backgroundColor="border"
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
    >
      <YStack height={2} width={pct} backgroundColor="foreground" />
    </YStack>
  );
}

/** A step's top: the kicker with "N of 5" across from it, the heading, and the lede. */
export function StepHeader({
  kicker,
  step,
  heading,
  lede,
}: {
  kicker: string;
  /** The step number, or `null` to draw no counter (a returning account's terms and questions). */
  step: number | null;
  /** Absent on a question, whose prompt is the heading. */
  heading?: string;
  lede?: ReactNode;
}) {
  return (
    <YStack gap="2">
      <XStack justifyContent="space-between" alignItems="center">
        <Kicker>{kicker}</Kicker>
        {step !== null ? (
          <Text color="foregroundMuted" fontSize={12} letterSpacing={1.5}>
            {onboardingStepLabel(step)}
          </Text>
        ) : null}
      </XStack>
      {heading ? (
        <H2 color="foreground" fontSize={24} lineHeight={30} textTransform="uppercase">
          {heading}
        </H2>
      ) : null}
      {lede !== undefined ? (
        typeof lede === 'string' ? (
          <Paragraph color="foregroundMuted">{lede}</Paragraph>
        ) : (
          lede
        )
      ) : null}
    </YStack>
  );
}

/** The small spaced capitals the app already uses for a section's name. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <Text color="foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
      {children}
    </Text>
  );
}

/** A field's label, in the kicker's style (the boards label fields the same way). */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <Kicker>{children}</Kicker>;
}

/** The amber line under a field: a client-side problem, never a server refusal (those toast). */
export function FieldProblem({ children }: { children: ReactNode }) {
  return (
    <Text color="warning" fontSize={13}>
      {children}
    </Text>
  );
}

/** A field's quiet hint. */
export function FieldHint({ children }: { children: ReactNode }) {
  return (
    <Text color="foregroundMuted" fontSize={12}>
      {children}
    </Text>
  );
}

/** The foot's main button: full width, filled, dimmed while off. */
export function PrimaryButton({
  children,
  disabled,
  onPress,
  flex,
}: {
  children: ReactNode;
  disabled?: boolean;
  onPress: () => void;
  flex?: number;
}) {
  return (
    <Button
      flex={flex}
      backgroundColor="primary"
      color="primaryForeground"
      disabled={disabled}
      opacity={disabled ? 0.45 : 1}
      onPress={onPress}
      accessibilityState={{ disabled: Boolean(disabled) }}
    >
      {children}
    </Button>
  );
}

/** The foot's second button: outlined. */
export function SecondaryButton({
  children,
  disabled,
  onPress,
}: {
  children: ReactNode;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="outlined"
      borderColor="border"
      color="foreground"
      disabled={disabled}
      opacity={disabled ? 0.45 : 1}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}
