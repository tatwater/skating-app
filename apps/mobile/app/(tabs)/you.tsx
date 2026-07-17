import { useAuth, useUser } from '@clerk/clerk-expo'
import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { useMutation, useQuery } from 'convex/react'
import { Link, useRouter } from 'expo-router'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H1, Paragraph, Separator, Text, XStack, YStack } from 'tamagui'
import { ProfileEdit } from '../../src/components/ProfileEdit'
import { Avatar } from '../../src/components/ProfileView'

/**
 * Profile / settings hub (D28). Who you're signed in as (with a link to your public profile),
 * profile editing (bio / town / public↔private, D13), your blocked-users list (D32), the
 * license/about link (D43), and sign-out. GPS connections + notification toggles come later.
 */
export default function YouScreen() {
  const { signOut } = useAuth()
  const { user } = useUser()
  const profile = useQuery(api.profiles.current, {})
  const router = useRouter()

  async function onSignOut() {
    await signOut()
    router.replace('/sign-in')
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView>
        <YStack flex={1} gap="$4" padding="$4" backgroundColor="$background">
          <H1 color="$foreground">You</H1>
          {profile ? (
            <Link
              href={{ pathname: '/u/[username]', params: { username: profile.username } }}
              asChild
            >
              <Paragraph color="$foreground">
                {profile.displayName} · @{profile.username}
              </Paragraph>
            </Link>
          ) : (
            <Paragraph color="$foreground">Loading your profile…</Paragraph>
          )}
          {user?.primaryEmailAddress?.emailAddress ? (
            <Paragraph color="$foregroundMuted">{user.primaryEmailAddress.emailAddress}</Paragraph>
          ) : null}

          <Separator borderColor="$border" />
          <Text
            color="$foregroundMuted"
            fontSize={11}
            letterSpacing={1.5}
            textTransform="uppercase"
          >
            Your profile
          </Text>
          <ProfileEdit />

          <BlockedUsers />

          <Separator borderColor="$border" />
          <Link href="/about" asChild>
            <Button>About &amp; licenses</Button>
          </Link>
          <Button backgroundColor="$danger" color="$dangerForeground" onPress={onSignOut}>
            Sign out
          </Button>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  )
}

/** The caller's blocked users (D32) with an unblock control. A block never hid their reports (D3). */
function BlockedUsers() {
  const blocks = useQuery(api.blocks.myBlocks, {})
  const unblock = useMutation(api.blocks.unblock)

  if (blocks === undefined || blocks.length === 0) return null

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Blocked users
      </Text>
      {blocks.map((b) => (
        <XStack key={b.userId} gap="$2" alignItems="center">
          <Avatar displayName={b.displayName} imageUrl={b.profileImageUrl} size={28} />
          <Text flex={1} color="$foreground">
            {b.displayName} · @{b.username}
          </Text>
          <Button size="$2" onPress={() => unblock({ targetUserId: b.userId as Id<'profiles'> })}>
            Unblock
          </Button>
        </XStack>
      ))}
    </YStack>
  )
}
