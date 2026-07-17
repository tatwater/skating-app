import { api } from '@skating/convex/api'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Keyboard } from 'react-native'
import { Input, Text, YStack } from 'tamagui'

/**
 * Inline profile search (D13), the mobile mirror of web's `ProfileSearch` — public profiles only
 * (server excludes private + blocked). Debounced; selecting a result opens that profile.
 */
export function ProfileSearch() {
  const router = useRouter()
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), 150)
    return () => clearTimeout(id)
  }, [text])

  const results = useQuery(
    api.profiles.searchProfiles,
    debounced.length > 0 ? { query: debounced } : 'skip',
  )
  const loaded = debounced.length > 0 && results !== undefined

  return (
    <YStack gap="$2">
      <Input
        value={text}
        onChangeText={setText}
        placeholder="Search skaters by name…"
        backgroundColor="$background"
        borderColor="$border"
        aria-label="Search skaters by name"
      />
      {loaded ? (
        <YStack borderColor="$border" borderWidth={1} borderRadius="$4" overflow="hidden">
          {(results ?? []).map((hit) => (
            <YStack
              key={hit.userId}
              onPress={() => {
                setText('')
                Keyboard.dismiss()
                router.navigate({ pathname: '/u/[username]', params: { username: hit.username } })
              }}
              paddingHorizontal="$3"
              paddingVertical="$2.5"
              pressStyle={{ backgroundColor: '$surfaceMuted' }}
              accessibilityRole="button"
            >
              <Text color="$foreground">{hit.displayName}</Text>
              <Text color="$foregroundMuted" fontSize="$1">
                {hit.homeTownLabel ?? `@${hit.username}`}
              </Text>
            </YStack>
          ))}
          {(results?.length ?? 0) === 0 ? (
            <Text color="$foregroundMuted" paddingHorizontal="$3" paddingVertical="$3">
              No skaters found.
            </Text>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  )
}
