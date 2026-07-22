import { useSignIn } from '@clerk/clerk-expo';
import { Link } from 'expo-router';
import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H1, Input, Paragraph, Text, YStack } from 'tamagui';

/**
 * Minimal email/password sign-in (D26). Barebones for Phase 0 — social login,
 * magic links, and error polish come in the auth deep-dive PR.
 */
export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email, password });
      if (attempt.status === 'complete') {
        // Activating the session flips `isSignedIn`; the root gate takes it from here,
        // routing to the tabs (profile exists) or onboarding (D26) — see app/_layout.tsx.
        await setActive({ session: attempt.createdSessionId });
      } else {
        setError('Extra verification is required — not handled in this barebones build yet.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <YStack flex={1} gap="$3" padding="$4" justifyContent="center" backgroundColor="$background">
        <H1 color="$foreground">Sign in</H1>
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
          autoComplete="current-password"
        />
        {error ? <Text color="$danger">{error}</Text> : null}
        <Button
          backgroundColor="$primary"
          color="$primaryForeground"
          disabled={busy || !isLoaded}
          onPress={onSubmit}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <Paragraph color="$foregroundMuted" textAlign="center">
          New here?{' '}
          <Link href="/sign-up" replace>
            <Text color="$primary">Create an account</Text>
          </Link>
        </Paragraph>
      </YStack>
    </SafeAreaView>
  );
}
