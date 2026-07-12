import { api } from '@skating/convex/api'
import {
  isValidDisplayName,
  isValidUsername,
  MINIMUM_SIGNUP_AGE,
  meetsMinimumAge,
  normalizeDisplayName,
  normalizeUsername,
} from '@skating/core'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H1, Input, Paragraph, Text, YStack } from 'tamagui'
import { RiskAckConsent } from '../src/components/RiskAckConsent'
import { parseDateOfBirth } from '../src/lib/dob'
import { RISK_ACK_VERSION } from '../src/lib/riskAck'

/**
 * Profile provisioning (D26). Reached only when the user is Clerk-authenticated but has
 * no Convex `profiles` row yet (see the gate in `app/_layout.tsx`). This is the client
 * half of the trust boundary: it collects the profile fields and the blocking Phase 0
 * gates — the 16+ age gate (D41) and the assumption-of-risk acknowledgment (D45) — then
 * calls `upsertFromClerk`, which *re-enforces* all of it server-side (D37).
 *
 * DOB + ack are passed straight to the enforced mutation — never staged in Clerk
 * `unsafeMetadata`. On success the reactive `profiles.current` query flips and the root
 * gate swaps this screen for the tabs, so no manual navigation is needed.
 */
export default function OnboardingScreen() {
  const upsertFromClerk = useMutation(api.profiles.upsertFromClerk)

  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [dob, setDob] = useState('')
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dobMs = parseDateOfBirth(dob)
  const oldEnough = dobMs !== null && meetsMinimumAge(dobMs, Date.now())
  const dobTouched = dob.trim().length > 0

  const normalizedUsername = normalizeUsername(username)
  const usernameOk = isValidUsername(normalizedUsername)
  const usernameTouched = username.trim().length > 0
  const nameOk = isValidDisplayName(normalizeDisplayName(displayName))

  const canSubmit = !busy && nameOk && usernameOk && oldEnough && ack

  async function onSubmit() {
    if (!canSubmit || dobMs === null) return
    setBusy(true)
    setError(null)
    try {
      await upsertFromClerk({
        displayName: normalizeDisplayName(displayName),
        username: normalizedUsername,
        dateOfBirth: dobMs,
        riskAckVersion: RISK_ACK_VERSION,
        // The acceptance time is stamped server-side (trust boundary, D37) — not sent.
      })
      // Success: no navigation — the root gate reacts to the now-provisioned profile.
    } catch (e) {
      // ConvexErrors carry a user-safe message in `.data` (e.g. "Username is already
      // taken"); anything else is redacted, so fall back to a generic line.
      setError(
        e instanceof ConvexError
          ? String(e.data)
          : e instanceof Error
            ? e.message
            : 'Could not finish setting up your profile',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }}>
        <YStack gap="$3" backgroundColor="$background">
          <H1 color="$foreground">Finish your profile</H1>
          <Paragraph color="$foregroundMuted">
            A few details before you start — this is how other skaters will see you.
          </Paragraph>

          <YStack gap="$1">
            <Input
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Display name"
              autoCapitalize="words"
            />
          </YStack>

          <YStack gap="$1">
            <Input
              value={username}
              onChangeText={setUsername}
              placeholder="Username"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {usernameTouched && !usernameOk ? (
              <Text color="$danger">
                3–30 characters: letters, numbers, or underscores (no leading or trailing _).
              </Text>
            ) : null}
          </YStack>

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

          <RiskAckConsent checked={ack} onToggle={() => setAck((v) => !v)} />

          {error ? <Text color="$danger">{error}</Text> : null}

          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            disabled={!canSubmit}
            onPress={onSubmit}
          >
            {busy ? 'Setting up…' : 'Start skating'}
          </Button>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  )
}
