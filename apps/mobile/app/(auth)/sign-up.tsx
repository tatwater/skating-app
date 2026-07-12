import { useSignUp } from '@clerk/clerk-expo'
import { MINIMUM_SIGNUP_AGE, meetsMinimumAge } from '@skating/core'
import { Link, useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H1, Input, Paragraph, Text, XStack, YStack } from 'tamagui'
import { parseDateOfBirth } from '../../src/lib/dob'
import { RISK_ACK_COPY, RISK_ACK_VERSION } from '../../src/lib/riskAck'

/**
 * Sign-up with the two blocking Phase 0 gates:
 *  - 16+ age gate from a collected date of birth (D41) — validated via `@skating/core`.
 *  - Assumption-of-risk acknowledgment (D45).
 * These gates are UX-level for now: DOB + risk-ack are staged in Clerk `unsafeMetadata`
 * and the real server-side enforcement (persist + require them in `upsertFromClerk`)
 * lands with profile provisioning — see the note in `src/lib/riskAck.ts`. Email-code
 * verification finishes signup.
 */
export default function SignUpScreen() {
  const { signUp, setActive, isLoaded } = useSignUp()
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [dob, setDob] = useState('')
  const [ack, setAck] = useState(false)
  const [pendingCode, setPendingCode] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dobMs = parseDateOfBirth(dob)
  const oldEnough = dobMs !== null && meetsMinimumAge(dobMs, Date.now())
  const dobTouched = dob.trim().length > 0
  const canSubmit = isLoaded && !busy && !!email && !!password && oldEnough && ack

  async function onSignUp() {
    if (!isLoaded || !canSubmit || dobMs === null) return
    setBusy(true)
    setError(null)
    try {
      await signUp.create({
        emailAddress: email,
        password,
        unsafeMetadata: {
          dateOfBirth: dobMs,
          riskAckVersion: RISK_ACK_VERSION,
          riskAckAt: Date.now(),
        },
      })
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
      setPendingCode(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign up failed')
    } finally {
      setBusy(false)
    }
  }

  async function onVerify() {
    if (!isLoaded || busy) return
    setBusy(true)
    setError(null)
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code })
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId })
        router.replace('/')
      } else {
        // Email verified, but the sign-up can't complete because the Clerk instance
        // still wants fields this screen doesn't collect (e.g. a required phone_number).
        // Surface exactly what's blocking rather than a generic "try again" — retrying
        // the code just fails with "already verified" and hides the real cause.
        const blocking = [...attempt.missingFields, ...attempt.unverifiedFields]
        setError(
          blocking.length > 0
            ? `Email verified, but this account still needs: ${blocking.join(', ')}. ` +
                'Check your Clerk instance’s required sign-up fields.'
            : `Sign-up incomplete (status: ${attempt.status}).`,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed')
    } finally {
      setBusy(false)
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
    )
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

          <YStack gap="$1">
            <Input
              value={dob}
              onChangeText={setDob}
              placeholder="Date of birth (YYYY-MM-DD)"
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
            />
            {dobTouched && !dobMs ? (
              <Text color="$danger">Enter a valid date as YYYY-MM-DD.</Text>
            ) : dobTouched && !oldEnough ? (
              <Text color="$danger">You must be at least {MINIMUM_SIGNUP_AGE} to use Skating.</Text>
            ) : null}
          </YStack>

          <XStack gap="$3" alignItems="flex-start" onPress={() => setAck((v) => !v)}>
            <Text color={ack ? '$primary' : '$foregroundMuted'} fontSize="$6">
              {ack ? '☑' : '☐'}
            </Text>
            <Paragraph flex={1} color="$foregroundMuted">
              {RISK_ACK_COPY}
            </Paragraph>
          </XStack>

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
  )
}
