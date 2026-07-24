import { useAuth } from '@clerk/clerk-expo';
import * as Sentry from '@sentry/react-native';
import { api } from '@skating/convex/api';
import { resolveAuthRoute } from '@skating/core';
import { useQuery } from 'convex/react';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initSentry } from '../src/lib/sentry';
import { Providers } from '../src/providers/Providers';

// Crash reporting must init before anything renders (D29).
initSentry();

/**
 * Auth- + provisioning-gated root navigator (D26). Two declarative `Stack.Protected`
 * gates, both driven by reactive state so the tree swaps itself:
 *  1. Clerk `isSignedIn` — signed-out users get the auth flow.
 *  2. A *fully provisioned* profile — a signed-in user is admitted to the tabs only once
 *     their Convex `profiles` row carries a **current** risk acknowledgment (D45). The
 *     other two signed-in states each get their own screen:
 *       - no row yet → **onboarding** (collect profile fields + first consent);
 *       - a row with a missing/stale ack (e.g. after we bump `RISK_ACK_VERSION`) →
 *         **re-ack** (renew consent only — no re-entering profile fields).
 *     Gating on row *existence* alone would let a stale ack sail past, defeating the
 *     versioning, so we check the ack itself.
 * We render a blank frame while Clerk loads or the profile query is still resolving, so
 * we neither flash the sign-in screen at launch nor bounce a returning user through
 * onboarding before their profile has loaded.
 */
function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();
  // Skip until Clerk confirms a session — unauthenticated the query would just be null.
  const profile = useQuery(api.profiles.current, isSignedIn ? {} : 'skip');

  const route = resolveAuthRoute({ isLoaded, isSignedIn, profile });
  if (route === 'loading') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={route === 'app'}>
        <Stack.Screen name="(tabs)" />
        {/* Viewable profile (D13) — pushed from an author line, report, or profile search. */}
        <Stack.Screen
          name="u/[username]"
          options={{ presentation: 'modal', headerShown: true, title: 'Profile' }}
        />
        <Stack.Screen
          name="about"
          options={{ presentation: 'modal', headerShown: true, title: 'About' }}
        />
        {/* Contact support / report a bug (D35) — a submission path, open even to suspended/banned
            users for appeals (support.create doesn't gate on status). */}
        <Stack.Screen
          name="support"
          options={{ presentation: 'modal', headerShown: true, title: 'Contact support' }}
        />
        {/* Offline report capture + draft editing (F2) — full-screen modals, off the map. */}
        <Stack.Screen
          name="draft/new"
          options={{ presentation: 'modal', headerShown: true, title: 'New report' }}
        />
        <Stack.Screen
          name="draft/[id]"
          options={{ presentation: 'modal', headerShown: true, title: 'Edit draft' }}
        />
      </Stack.Protected>
      <Stack.Protected guard={route === 'onboarding'}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={route === 'reack'}>
        <Stack.Screen name="reack" />
      </Stack.Protected>
      <Stack.Protected guard={route === 'auth'}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Providers>
        <RootNavigator />
      </Providers>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap enables navigation/perf instrumentation + error boundary (D29).
export default Sentry.wrap(RootLayout);
