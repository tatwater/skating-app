import { useSignIn, useSSO } from '@clerk/clerk-expo';
import { Link } from 'expo-router';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H1, Input, Paragraph, Text, YStack } from 'tamagui';

// Dismisses the auth popup if the app is resumed mid-flow with a pending session.
WebBrowser.maybeCompleteAuthSession();

/**
 * Sign-in (D26). Google SSO is the primary path; an emailed code is the fallback.
 *
 * There is deliberately NO password field. The Clerk instance enables password (and requires
 * one at sign-*up*) but with `used_for_first_factor: false` — its only first factors are
 * `email_code`, `phone_code`, and OAuth. So `signIn.create({identifier, password})` can never
 * return `complete`; it returns `needs_first_factor`, which is what made an earlier build
 * dead-end on "extra verification is required". Restoring password sign-in is an *instance*
 * setting (enable Password as a sign-in method), not a change here.
 *
 * Note `auth_config.first_factors` in Clerk's environment payload *does* list `password` —
 * ignore it. That field is the legacy capability catalogue (it also lists `ticket` and
 * `reset_password_*`); `user_settings.attributes` is the operative one.
 *
 * SSO adds no native module: `expo-web-browser` + `expo-auth-session` are already declared
 * deps and `scheme: 'skating'` already exists for the redirect, so this ships over the air.
 */
export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { startSSOFlow } = useSSO();

  const [email, setEmail] = useState('');
  const [pendingCode, setPendingCode] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = isLoaded && !busy && !!email;

  // Android keeps a warmed custom-tab process around, which makes the OAuth sheet appear
  // roughly instantly instead of after a visible beat. No-op on iOS.
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  const onGoogle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { createdSessionId, setActive: setActiveSSO, authSessionResult, signUp } =
        await startSSOFlow({
          strategy: 'oauth_google',
          redirectUrl: AuthSession.makeRedirectUri(),
        });

      if (createdSessionId && setActiveSSO) {
        // Same handoff as the code path: activating flips `isSignedIn` and the root gate
        // routes to the tabs or to onboarding — see app/_layout.tsx.
        await setActiveSSO({ session: createdSessionId });
        return;
      }

      // Backing out of the Google sheet is a normal action, not a failure — staying silent
      // here avoids showing a scary red error for a deliberate cancel.
      if (authSessionResult?.type === 'cancel' || authSessionResult?.type === 'dismiss') return;

      // Otherwise Clerk wants something this screen doesn't collect (a first Google sign-in
      // on an instance with extra required sign-up fields lands here). Name it.
      const missing = signUp?.missingFields ?? [];
      setError(
        missing.length > 0
          ? `Google sign-in needs more info: ${missing.join(', ')}. Check your Clerk required fields.`
          : 'Google sign-in didn’t complete.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google sign-in failed');
    } finally {
      setBusy(false);
    }
  }, [busy, startSSOFlow]);

  async function onSendCode() {
    if (!isLoaded || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email });

      // Pick the emailed-code factor off what this instance actually offers rather than
      // assuming it — a phone-only instance would otherwise fail with an opaque Clerk error.
      const emailFactor = attempt.supportedFirstFactors?.find((f) => f.strategy === 'email_code');
      if (!emailFactor || !('emailAddressId' in emailFactor)) {
        setError('This account can’t sign in with an emailed code. Try Google instead.');
        return;
      }

      await signIn.prepareFirstFactor({
        strategy: 'email_code',
        emailAddressId: emailFactor.emailAddressId,
      });
      setPendingCode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.attemptFirstFactor({ strategy: 'email_code', code });
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
      } else if (attempt.status === 'needs_second_factor') {
        // Instance-level 2FA is off, but a user can still enrol a phone individually.
        setError('This account has two-factor authentication on, which this build doesn’t handle yet.');
      } else {
        // Say what the blocking status is — re-entering the code just fails as "already
        // verified" and buries the real cause.
        setError(`Sign-in incomplete (status: ${attempt.status}).`);
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
          <H1 color="$foreground">Check your email</H1>
          <Paragraph color="$foregroundMuted">Enter the code we emailed to {email}.</Paragraph>
          <Input
            value={code}
            onChangeText={setCode}
            placeholder="Verification code"
            keyboardType="number-pad"
            autoComplete="one-time-code"
          />
          {error ? <Text color="$danger">{error}</Text> : null}
          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            disabled={busy || !code}
            onPress={onVerify}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </YStack>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <YStack flex={1} gap="$3" padding="$4" justifyContent="center" backgroundColor="$background">
        <H1 color="$foreground">Sign in</H1>

        <Button
          backgroundColor="$primary"
          color="$primaryForeground"
          disabled={busy}
          onPress={onGoogle}
        >
          {busy ? 'Please wait…' : 'Continue with Google'}
        </Button>

        <Paragraph color="$foregroundMuted" textAlign="center">
          or use your email
        </Paragraph>

        <Input
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />

        {error ? <Text color="$danger">{error}</Text> : null}

        <Button disabled={!canSubmit} onPress={onSendCode}>
          {busy ? 'Sending…' : 'Email me a code'}
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
