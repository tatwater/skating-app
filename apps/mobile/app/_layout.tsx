import { useAuth } from '@clerk/clerk-expo'
import * as Sentry from '@sentry/react-native'
import { api } from '@skating/convex/api'
import { useQuery } from 'convex/react'
import { Stack } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { initSentry } from '../src/lib/sentry'
import { Providers } from '../src/providers/Providers'

// Crash reporting must init before anything renders (D29).
initSentry()

/**
 * Auth- + provisioning-gated root navigator (D26). Two declarative `Stack.Protected`
 * gates, both driven by reactive state so the tree swaps itself:
 *  1. Clerk `isSignedIn` — signed-out users get the auth flow.
 *  2. A provisioned Convex `profiles` row — a signed-in user who doesn't have one yet is
 *     sent to onboarding to create it (the client half of `upsertFromClerk`). The tabs
 *     mount *only* once a profile exists, so the 16+ / risk-ack gates can't be bypassed
 *     by jumping straight into the app.
 * We render a blank frame while Clerk loads or the profile query is still resolving, so
 * we neither flash the sign-in screen at launch nor bounce a returning user through
 * onboarding before their profile has loaded.
 */
function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth()
  // Skip until Clerk confirms a session — unauthenticated the query would just be null.
  const profile = useQuery(api.profiles.current, isSignedIn ? {} : 'skip')

  const provisioning = isSignedIn && profile === undefined
  if (!isLoaded || provisioning) return null

  const hasProfile = !!profile
  const needsOnboarding = isSignedIn && profile === null

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={hasProfile}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="about"
          options={{ presentation: 'modal', headerShown: true, title: 'About' }}
        />
      </Stack.Protected>
      <Stack.Protected guard={needsOnboarding}>
        <Stack.Screen name="onboarding" />
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
