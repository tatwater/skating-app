import { useAuth } from '@clerk/clerk-expo'
import * as Sentry from '@sentry/react-native'
import { Stack } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { initSentry } from '../src/lib/sentry'
import { Providers } from '../src/providers/Providers'

// Crash reporting must init before anything renders (D29).
initSentry()

/**
 * Auth-gated root navigator (D26). Expo Router's `Stack.Protected` swaps the whole
 * navigation tree on `isSignedIn`: signed-in users get the tabs, everyone else the
 * auth flow. We hold on `!isLoaded` so we don't flash the sign-in screen at launch.
 */
function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded) return null

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isSignedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="about"
          options={{ presentation: 'modal', headerShown: true, title: 'About' }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  )
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Providers>
        <RootNavigator />
      </Providers>
    </GestureHandlerRootView>
  )
}

// Sentry.wrap enables navigation/perf instrumentation + error boundary (D29).
export default Sentry.wrap(RootLayout)
