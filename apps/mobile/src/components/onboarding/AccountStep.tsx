import { api } from '@skating/convex/api';
import { DISPLAY_NAME_MAX_LENGTH, ONBOARDING_COPY, USERNAME_MAX_LENGTH } from '@skating/core';
import { useQuery } from 'convex/react';
import { Text, XStack, YStack } from 'tamagui';
import {
  type AccountDraft,
  accountStepView,
  digitsOnly,
  usernameField,
  usernameQuery,
} from '../../lib/accountStep';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { Input } from '../ThemedInputs';
import { MonthPicker } from './MonthPicker';
import {
  FieldHint,
  FieldLabel,
  FieldProblem,
  OnboardingFrame,
  PrimaryButton,
  StepHeader,
} from './OnboardingFrame';
import type { AccountFields } from './TermsStep';

/** The pause before the live username check asks (and before a malformed name is called out). */
const USERNAME_SETTLE_MS = 350;

/** The underline-only field the boards draw, on the app's themed input. */
const UNDERLINE = {
  borderWidth: 0,
  borderBottomWidth: 1,
  borderRadius: 0,
  backgroundColor: 'transparent',
  paddingHorizontal: 0,
} as const;

/**
 * **The Account step** (B03 §9.6 boards 11.1–11.2): full name, `@`username with the live check, and
 * the date of birth as a month by name plus a typed day and year. Nothing is written: *Continue*
 * hands the fields to the Terms step, and *Record acceptance* is what creates the account. Every
 * problem here is the client's own, so it is the amber line under its field, never a toast.
 */
export function AccountStep({
  draft,
  onDraft,
  refused,
  nowMs,
  onSignOut,
  onContinue,
}: {
  draft: AccountDraft;
  onDraft: (draft: AccountDraft) => void;
  /** Names an acceptance was refused for (`username_taken`), marked taken here. */
  refused: ReadonlySet<string>;
  /** The clock the 18+ rule reads, from the screen. */
  nowMs: number;
  onSignOut: () => void;
  onContinue: (account: AccountFields) => void;
}) {
  const settled = useDebouncedValue(draft.username, USERNAME_SETTLE_MS);
  const asking = usernameQuery(settled);
  const check = useQuery(
    api.profiles.usernameAvailable,
    asking !== null ? { username: asking } : 'skip',
  );
  const view = accountStepView(
    draft,
    usernameField(draft.username, settled, check, refused),
    nowMs,
  );
  const copy = ONBOARDING_COPY.account;

  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      foot={
        <PrimaryButton
          disabled={view.account === null}
          onPress={() => {
            if (view.account) onContinue(view.account);
          }}
        >
          {copy.continue}
        </PrimaryButton>
      }
    >
      <StepHeader kicker={copy.kicker} step={copy.step} heading={copy.heading} lede={copy.lede} />

      <YStack gap="1">
        <FieldLabel>{copy.fullName}</FieldLabel>
        <Input
          {...UNDERLINE}
          borderColor={view.messages.name ? 'warning' : 'border'}
          value={draft.displayName}
          onChangeText={(displayName) => onDraft({ ...draft, displayName })}
          accessibilityLabel={copy.fullName}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          maxLength={DISPLAY_NAME_MAX_LENGTH + 10}
        />
        {view.messages.name ? <FieldProblem>{view.messages.name}</FieldProblem> : null}
      </YStack>

      <YStack gap="1">
        <FieldLabel>{copy.username}</FieldLabel>
        <XStack
          alignItems="center"
          gap="2"
          borderBottomWidth={1}
          borderColor={view.messages.username ? 'warning' : 'border'}
        >
          <Text color="foregroundMuted" fontSize={16}>
            {copy.usernamePrefix}
          </Text>
          <Input
            {...UNDERLINE}
            flex={1}
            borderBottomWidth={0}
            value={draft.username}
            onChangeText={(username) => onDraft({ ...draft, username })}
            accessibilityLabel={copy.username}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            textContentType="username"
            maxLength={USERNAME_MAX_LENGTH + 5}
          />
        </XStack>
        {view.messages.username ? <FieldProblem>{view.messages.username}</FieldProblem> : null}
      </YStack>

      <YStack gap="1">
        <FieldLabel>{copy.dateOfBirth}</FieldLabel>
        <XStack gap="3" alignItems="flex-end">
          <YStack flex={2}>
            <MonthPicker
              month={draft.dob.month}
              onChange={(month) => onDraft({ ...draft, dob: { ...draft.dob, month } })}
              problem={view.messages.dob !== undefined}
            />
          </YStack>
          <YStack flex={1}>
            <Input
              {...UNDERLINE}
              borderColor={view.messages.dob ? 'warning' : 'border'}
              value={draft.dob.day}
              onChangeText={(day) =>
                onDraft({ ...draft, dob: { ...draft.dob, day: digitsOnly(day, 2) } })
              }
              placeholder={copy.day}
              accessibilityLabel={copy.day}
              keyboardType="number-pad"
              maxLength={2}
            />
          </YStack>
          <YStack flex={1.3}>
            <Input
              {...UNDERLINE}
              borderColor={view.messages.dob ? 'warning' : 'border'}
              value={draft.dob.year}
              onChangeText={(year) =>
                onDraft({ ...draft, dob: { ...draft.dob, year: digitsOnly(year, 4) } })
              }
              placeholder={copy.year}
              accessibilityLabel={copy.year}
              keyboardType="number-pad"
              maxLength={4}
            />
          </YStack>
        </XStack>
        {view.messages.dob ? (
          <FieldProblem>{view.messages.dob}</FieldProblem>
        ) : (
          <FieldHint>{copy.dateOfBirthHint}</FieldHint>
        )}
      </YStack>
    </OnboardingFrame>
  );
}
