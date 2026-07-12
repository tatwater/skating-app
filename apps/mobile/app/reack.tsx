import { useAuth } from '@clerk/clerk-expo'
import { api } from '@skating/convex/api'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H1, Paragraph, Text, YStack } from 'tamagui'
import { RiskAckConsent } from '../src/components/RiskAckConsent'
import { RISK_ACK_VERSION } from '../src/lib/riskAck'

/**
 * Re-acceptance gate (D45). Reached when a signed-in user already has a profile but its
 * recorded acknowledgment is missing or stale — e.g. after we bump `RISK_ACK_VERSION`.
 * Unlike onboarding, it asks for nothing but renewed consent: their existing profile
 * fields (username, display name, DOB) are untouched. On success the reactive
 * `profiles.current` query flips and the root gate swaps this screen for the tabs.
 */
export default function ReAckScreen() {
  const { signOut } = useAuth()
  const acceptCurrentRiskAck = useMutation(api.profiles.acceptCurrentRiskAck)

  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onAccept() {
    if (busy || !ack) return
    setBusy(true)
    setError(null)
    try {
      await acceptCurrentRiskAck({ riskAckVersion: RISK_ACK_VERSION })
      // Success: no navigation — the root gate reacts to the refreshed acknowledgment.
    } catch (e) {
      setError(
        e instanceof ConvexError
          ? String(e.data)
          : e instanceof Error
            ? e.message
            : 'Could not save your acknowledgment',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }}>
        <YStack gap="$3" backgroundColor="$background">
          <H1 color="$foreground">One quick thing</H1>
          <Paragraph color="$foregroundMuted">
            We’ve updated our safety acknowledgment. Please review and accept it to keep using
            Skating — nothing else about your account changes.
          </Paragraph>

          <RiskAckConsent checked={ack} onToggle={() => setAck((v) => !v)} />

          {error ? <Text color="$danger">{error}</Text> : null}

          <Button
            backgroundColor="$primary"
            color="$primaryForeground"
            disabled={busy || !ack}
            onPress={onAccept}
          >
            {busy ? 'Saving…' : 'Accept and continue'}
          </Button>

          <Button onPress={() => signOut()}>Not now — sign out</Button>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  )
}
