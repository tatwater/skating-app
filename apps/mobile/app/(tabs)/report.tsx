import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, Paragraph, YStack } from 'tamagui'

/**
 * The center "＋ Report" tab (D28). In Phase 2 reports are created **in place** from a lake's detail
 * drawer (D47) — you pick the lake you skated, then post — so this tab guides you to the map rather
 * than opening a lake-less form. (The offline draft queue that makes this tab a first-class capture
 * entry point is Phase 2 F2.)
 */
export default function ReportScreen() {
  const router = useRouter()
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        gap="$4"
        padding="$4"
        backgroundColor="$background"
      >
        <Paragraph color="$foregroundMuted" textAlign="center">
          To add a report, open the map and tap the lake you skated — then post your ice report
          right there.
        </Paragraph>
        <Button
          backgroundColor="$primary"
          color="$primaryForeground"
          onPress={() => router.navigate('/')}
        >
          Go to the map
        </Button>
      </YStack>
    </SafeAreaView>
  )
}
