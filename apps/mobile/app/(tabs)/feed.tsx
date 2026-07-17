import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { H1, Paragraph, Text, YStack } from 'tamagui'
import { ProfileSearch } from '../../src/components/ProfileSearch'

// Cross-water-body, in-range, newest-skate-time feed (D28); built in Phase 5. Phase 3 adds the
// profile search here (public profiles only, D13).
export default function NewsfeedScreen() {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <YStack flex={1} gap="$4" padding="$4" backgroundColor="$background">
          <H1 color="$foreground">Newsfeed</H1>
          <YStack gap="$2">
            <Text
              color="$foregroundMuted"
              fontSize={11}
              letterSpacing={1.5}
              textTransform="uppercase"
            >
              Find a skater
            </Text>
            <ProfileSearch />
          </YStack>
          <Paragraph color="$foregroundMuted">
            Recent community reports within your range — arrives in Phase 5.
          </Paragraph>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  )
}
