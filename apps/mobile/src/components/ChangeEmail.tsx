import { useUser } from '@clerk/clerk-expo';
import {
  beginEmailChange,
  completeEmailChange,
  type EmailAddressLike,
  isVerifiedEmail,
  type UserLike,
} from '@skating/core';
import { useState } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';
import { Input } from './ThemedInputs';

/**
 * Change the email on the account (N8 post-merge) — the You tab's email line, opened up. Clerk owns
 * the address (D26); the sequence is `@skating/core`'s `changeEmail`, the same one the web settings
 * page runs, and the code entry mirrors the sign-in screen's. The server learns through Clerk's
 * webhook, not from us: a client never sends the server an address it merely claims.
 */
export function ChangeEmail() {
  const { user } = useUser();
  const [step, setStep] = useState<'idle' | 'enter' | 'code' | 'done'>('idle');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<EmailAddressLike | null>(null);
  const [removedOld, setRemovedOld] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = user?.primaryEmailAddress?.emailAddress ?? null;

  const reset = () => {
    setStep('idle');
    setEmail('');
    setCode('');
    setPending(null);
    setRemovedOld(null);
    setError(null);
  };

  /** The make-primary half, shared by the code step and the no-code path for a verified address. */
  async function finish(u: UserLike, address: EmailAddressLike, enteredCode: string) {
    const result = await completeEmailChange(u, address, enteredCode);
    setRemovedOld(result.removedOld);
    setStep('done');
  }

  async function onSendCode() {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    try {
      const address = await beginEmailChange(user, email);
      setPending(address);
      // An address Clerk already holds verified (a Google-linked one that stayed) has no code to
      // enter; it goes straight to primary.
      if (isVerifiedEmail(address)) await finish(user, address, '');
      else setStep('code');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send a code');
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (!user || !pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      await finish(user, pending, code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'idle') {
    return (
      <XStack alignItems="center" justifyContent="space-between" gap="$3">
        <Paragraph color="$foregroundMuted" flex={1}>
          {current ?? 'No email on this account'}
        </Paragraph>
        <Button size="$2" onPress={() => setStep('enter')}>
          Change email
        </Button>
      </XStack>
    );
  }

  if (step === 'done') {
    return (
      <YStack gap="$1">
        <Paragraph color="$foreground">Your email is now {pending?.emailAddress}.</Paragraph>
        {removedOld === false ? (
          <Paragraph color="$foregroundMuted" fontSize="$1">
            Your old address stays on the account because it’s linked to your Google sign-in; it
            won’t receive notifications.
          </Paragraph>
        ) : null}
        <Paragraph color="$foregroundMuted" fontSize="$1">
          Notification emails go to the new address from here on.
        </Paragraph>
        <XStack>
          <Button size="$2" onPress={reset}>
            Done
          </Button>
        </XStack>
      </YStack>
    );
  }

  if (step === 'code') {
    return (
      <YStack gap="$2">
        <Paragraph color="$foregroundMuted" fontSize="$1">
          Enter the code we emailed to {pending?.emailAddress}.
        </Paragraph>
        <Input
          value={code}
          onChangeText={setCode}
          placeholder="Verification code"
          keyboardType="number-pad"
          autoComplete="one-time-code"
        />
        {error ? <Text color="$danger">{error}</Text> : null}
        <XStack gap="$2">
          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            disabled={busy || code.trim().length === 0}
            onPress={onVerify}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
          <Button chromeless disabled={busy} onPress={reset}>
            Cancel
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$2">
      <Paragraph color="$foregroundMuted" fontSize="$1">
        We’ll email a code to the new address to confirm it’s yours. Sign-in codes and notification
        emails go there afterwards.
      </Paragraph>
      <Input
        value={email}
        onChangeText={setEmail}
        placeholder="New email"
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
      />
      {error ? <Text color="$danger">{error}</Text> : null}
      <XStack gap="$2">
        <Button
          backgroundColor="$primary"
          color="$primaryForeground"
          disabled={busy || email.trim().length === 0}
          onPress={onSendCode}
        >
          {busy ? 'Sending…' : 'Email me a code'}
        </Button>
        <Button chromeless disabled={busy} onPress={reset}>
          Cancel
        </Button>
      </XStack>
    </YStack>
  );
}
