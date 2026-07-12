import { SafeAreaView } from 'react-native-safe-area-context'
import { H1, Paragraph, YStack } from 'tamagui'

/**
 * Barebones themed placeholder for a Phase 0 route. Each real screen (map, feed,
 * report, …) gets deep-dived in its own later-phase PR; for now we just prove the
 * route renders, is themed (D34), and reads safe-area insets.
 */
export function PlaceholderScreen({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        gap="$3"
        padding="$4"
        backgroundColor="$background"
      >
        <H1 color="$foreground" textAlign="center">
          {title}
        </H1>
        {subtitle ? (
          <Paragraph color="$foregroundMuted" textAlign="center">
            {subtitle}
          </Paragraph>
        ) : null}
      </YStack>
    </SafeAreaView>
  )
}
