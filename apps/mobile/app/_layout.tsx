import { useAuth } from '@clerk/expo';
import * as Sentry from '@sentry/react-native';
import { api } from '@skating/convex/api';
import { resolveEntryRoute } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { useEffect, useMemo, useReducer } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTheme } from 'tamagui';
import { EntrySessionContext } from '../src/components/onboarding/EntrySession';
import { ToastProvider } from '../src/components/Toast';
import {
  EMPTY_ENTRY_SESSION,
  entryGroup,
  entrySessionReducer,
  sessionEnded,
} from '../src/lib/entryGate';
import { retryPendingRelease } from '../src/lib/pushRegistration';
import { initSentry } from '../src/lib/sentry';
import { Providers } from '../src/providers/Providers';

// Crash reporting must init before anything renders (D29).
initSentry();

/**
 * The gated root navigator (D26, D298). Core's `resolveEntryRoute` — the same rule the web's gate
 * uses — picks the route from Clerk, `profiles.current`, the Ice Watch's opening
 * (`consent.watchAnchor`) and the receipt hold; `src/lib/entryGate.ts` turns it into one open
 * `Stack.Protected` group, and the tree swaps itself as those change:
 *
 * - signed out → `(auth)`;
 * - no profile row, or a canceled deletion's emptied one → `onboarding` (Account, then Terms);
 * - a pending deletion → the tabs (read-only), before any consent check;
 * - terms not accepted at this version → `terms`;
 * - Know Before You Go due (never answered, or not this season) → `know-before-you-go`;
 * - a new account's Home and Profile still ahead → `welcome`;
 * - otherwise → the tabs.
 *
 * **The receipt hold** lives here, in the navigator's own state, because *Record acceptance*
 * changes the profile under the screen that recorded it: while held, the gate keeps that screen
 * open for the receipt, and its button releases it. A sign-out forgets it. Nothing renders while
 * Clerk, the profile or the watch is still loading, so a returning skater is never bounced through
 * a screen that isn't theirs.
 */
function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();
  // Skip until Clerk confirms a session — unauthenticated the queries would just be null.
  const profile = useQuery(api.profiles.current, isSignedIn ? {} : 'skip');
  const anchor = useQuery(api.consent.watchAnchor, isSignedIn ? {} : 'skip');
  const theme = useTheme();
  const [session, dispatch] = useReducer(entrySessionReducer, EMPTY_ENTRY_SESSION);
  const entry = useMemo(() => ({ session, dispatch }), [session]);

  // A push-token release the last sign-out couldn't finish (offline, or past its bound) is retried
  // here, at the root, so it runs whether or not anyone is signed in — and is queued before the tabs
  // layout, further down the tree, can register a token for whoever signs in next (A08 PR 3).
  const releaseToken = useMutation(api.pushTokens.release);
  useEffect(() => {
    retryPendingRelease({ release: releaseToken });
  }, [releaseToken]);

  // Whoever signs in next starts with no hold and no "new account" memory.
  const ended = sessionEnded(isLoaded, isSignedIn);
  useEffect(() => {
    if (ended) dispatch({ type: 'signedOut' });
  }, [ended]);

  const route = resolveEntryRoute({
    isLoaded,
    isSignedIn,
    profile,
    watch:
      anchor === undefined ? undefined : anchor === null ? null : { openedAt: anchor.openedAt },
    hold: session.hold,
  });
  const group = entryGroup(route, session.heldOn);
  if (group === null) return null;

  return (
    <EntrySessionContext.Provider value={entry}>
      <ToastProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            // React Navigation ships its own light/dark themes, but adopting them would put a second
            // palette in the app that knows nothing about `@skating/design` — so the five `headerShown`
            // modals below are dressed from our tokens instead, the same way the tab bar is. Without
            // this they render Navigation's default *light* header inside a dark app.
            headerStyle: { backgroundColor: theme.surface?.val },
            headerTintColor: theme.foreground?.val,
            headerTitleStyle: { color: theme.foreground?.val },
            // The frame behind a screen — visible during push/modal transitions, and the reason a theme
            // change used to flash white between routes.
            contentStyle: { backgroundColor: theme.background?.val },
          }}
        >
          <Stack.Protected guard={group === 'app'}>
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
            {/* The inbox (A08 §1.3) — pushed from the bell on the You tab; not a sixth tab (D28). */}
            <Stack.Screen
              name="notifications"
              options={{ presentation: 'modal', headerShown: true, title: 'Notifications' }}
            />
            {/* Contact support / report a bug (D35) — a submission path, open even to suspended/banned
            users for appeals (support.create doesn't gate on status). */}
            <Stack.Screen
              name="support"
              options={{ presentation: 'modal', headerShown: true, title: 'Contact support' }}
            />
            {/* The sheet's two lists (A10-3): the drafts the author is holding and the queue waiting
            on signal. Full-screen modals behind the ＋ Report tab's header; a draft reopens on the
            sheet itself. */}
            <Stack.Screen name="drafts" options={{ presentation: 'modal' }} />
            <Stack.Screen name="queue" options={{ presentation: 'modal' }} />
            {/* The library grid (A10-8 §8.5), iOS only — opened from a report's Photos. */}
            <Stack.Screen name="photo-library" options={{ presentation: 'fullScreenModal' }} />
          </Stack.Protected>
          {/* The way in (D298): one screen per route; Account and Terms are one screen's steps. */}
          <Stack.Protected guard={group === 'onboarding'}>
            <Stack.Screen name="onboarding" />
          </Stack.Protected>
          <Stack.Protected guard={group === 'terms'}>
            <Stack.Screen name="terms" />
          </Stack.Protected>
          <Stack.Protected guard={group === 'know-before-you-go'}>
            <Stack.Screen name="know-before-you-go" />
          </Stack.Protected>
          <Stack.Protected guard={group === 'welcome'}>
            <Stack.Screen name="welcome" />
          </Stack.Protected>
          <Stack.Protected guard={group === 'auth'}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
        </Stack>
      </ToastProvider>
    </EntrySessionContext.Provider>
  );
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Photos shared to Gli (A10-8 §8.7): above every gate, so a share that arrives before
          sign-in is still there after it. The tabs' `ShareIntentHandler` takes it. */}
      {/* Not reset on backgrounding: signing in means a trip to the mail app for the code. */}
      <ShareIntentProvider options={{ resetOnBackground: false }}>
        <Providers>
          <RootNavigator />
        </Providers>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap enables navigation/perf instrumentation + error boundary (D29).
export default Sentry.wrap(RootLayout);
