import { useAuth, useUser } from '@clerk/clerk-expo'
import { Link, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H1, Paragraph, Separator, YStack } from 'tamagui'

/**
 * Profile / settings hub (D28). Barebones for Phase 0: who you're signed in as,
 * sign-out (proves the Clerk↔Convex auth loop), and the license/about link (D43).
 * Reputation, GPS connections, notification toggles, etc. come in later phases.
 */
export default function YouScreen() {
  const { signOut } = useAuth()
  const { user } = useUser()
  const router = useRouter()

  // The parent Stack.Protected guard swaps the tree on sign-out, but from a nested tab
  // that transition can leave us on a stale child route; replace explicitly as a fallback.
  async function onSignOut() {
    await signOut()
    router.replace('/sign-in')
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack flex={1} gap="$4" padding="$4" backgroundColor="$background">
        <H1 color="$foreground">You</H1>
        <Paragraph color="$foregroundMuted">
          Signed in as {user?.primaryEmailAddress?.emailAddress ?? user?.username ?? 'your account'}
          .
        </Paragraph>

        <Separator borderColor="$border" />

        <Link href="/about" asChild>
          <Button>About &amp; licenses</Button>
        </Link>

        <Button backgroundColor="$danger" color="$dangerForeground" onPress={onSignOut}>
          Sign out
        </Button>
      </YStack>
    </SafeAreaView>
  )
}
