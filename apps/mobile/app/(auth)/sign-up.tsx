import { useSignUp } from '@clerk/clerk-expo';
import { Link } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H1, Input, Paragraph, Text, YStack } from 'tamagui';

/**
 * Clerk account creation (D26): email + password + email-code verification. The profile
 * fields and the blocking Phase 0 gates (16+ age gate D41, assumption-of-risk ack D45)
 * are collected right after, on the onboarding screen, where they're passed to the
 * enforced `upsertFromClerk` mutation — never staged in Clerk `unsafeMetadata`. Once the
 * session is active the root gate routes an unprovisioned user to onboarding, so no
 * manual navigation is needed here.
 */
export default function SignUpScreen() {
  const { signUp, setActive, isLoaded } = useSignUp();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pendingCode, setPendingCode] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = isLoaded && !busy && !!email && !!password;

  async function onSignUp() {
    if (!isLoaded || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await signUp.create({ emailAddress: email, password });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setPendingCode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign up failed');
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code });
      if (attempt.status === 'complete') {
        // Activating the session flips `isSignedIn`; the root gate then routes to
        // onboarding (no profile yet) — see app/_layout.tsx.
        await setActive({ session: attempt.createdSessionId });
      } else {
        // Email verified, but the sign-up can't complete because the Clerk instance
        // still wants fields this screen doesn't collect (e.g. a required phone_number).
        // Surface exactly what's blocking rather than a generic "try again" — retrying
        // the code just fails with "already verified" and hides the real cause.
        const blocking = [...attempt.missingFields, ...attempt.unverifiedFields];
        setError(
          blocking.length > 0
            ? `Email verified, but this account still needs: ${blocking.join(', ')}. ` +
                'Check your Clerk instance’s required sign-up fields.'
            : `Sign-up incomplete (status: ${attempt.status}).`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  if (pendingCode) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <YStack
          flex={1}
          gap="$3"
          padding="$4"
          justifyContent="center"
          backgroundColor="$background"
        >
          <H1 color="$foreground">Verify email</H1>
          <Paragraph color="$foregroundMuted">Enter the code we emailed to {email}.</Paragraph>
          <Input
            value={code}
            onChangeText={setCode}
            placeholder="Verification code"
            keyboardType="number-pad"
          />
          {error ? <Text color="$danger">{error}</Text> : null}
          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            disabled={busy || !code}
            onPress={onVerify}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
        </YStack>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }}>
        <YStack gap="$3" backgroundColor="$background">
          <H1 color="$foreground">Create account</H1>

          <Input
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <Input
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
            autoComplete="new-password"
          />

          {error ? <Text color="$danger">{error}</Text> : null}

          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            disabled={!canSubmit}
            onPress={onSignUp}
          >
            {busy ? 'Creating…' : 'Create account'}
          </Button>

          <Paragraph color="$foregroundMuted" textAlign="center">
            Already have an account?{' '}
            <Link href="/sign-in" replace>
              <Text color="$primary">Sign in</Text>
            </Link>
          </Paragraph>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}
