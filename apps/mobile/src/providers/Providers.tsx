import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
import { tokenCache } from '@clerk/clerk-expo/token-cache';
import { themes as designThemes } from '@skating/design';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { type ReactNode, useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider, Theme } from 'tamagui';
import { config } from '../../tamagui.config';
import { OfflineDraftsProvider } from '../components/OfflineDraftsContext';
import { convex } from '../lib/convex';
import { env } from '../lib/env';
import { ThemePreferenceProvider, useThemePreference } from './ThemeProvider';

/**
 * Everything below the theme preference (D34 amendment).
 *
 * Tamagui gets `defaultTheme` **and** `theme`: the first is the initial value, the second is what
 * makes a runtime toggle propagate. Passing only `defaultTheme` — as this file did while the OS was
 * the sole input — meant the theme was read once at mount and a user switching it in Settings
 * changed nothing until the next launch.
 */
function ThemedApp({ children }: { children: ReactNode }) {
  const { resolved, isDark } = useThemePreference();

  // The *window* background, behind everything React draws. Screens paint `$background` on an inner
  // YStack, so without this the safe-area insets (notch, home indicator) and the momentary gap
  // between screen transitions show the native default white — a bright seam around a dark app.
  //
  // Best-effort, in the `bodyCache` tradition: this is a native call on a surface nothing else
  // depends on, and a bare `void` on a rejecting promise is an unhandled rejection Sentry would
  // report as a crash the user never saw. A seam around the app is not worth an error report.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(designThemes[resolved].background).catch(() => {});
  }, [resolved]);

  return (
    <TamaguiProvider config={config} defaultTheme={resolved}>
      {/* `defaultTheme` alone is exactly that — a *default*, read once at mount — so a runtime
          switch needs this `<Theme>` wrapper to actually repaint the tree. Passing both means the
          very first frame is already correct rather than briefly light. */}
      <Theme name={resolved}>
        {/* `style` is the *content* color, so it inverts the theme name: a dark app needs light
            icons. Not `"auto"` — that follows the OS, which is the thing an explicit override
            is meant to outrank. */}
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <SafeAreaProvider>
          <OfflineDraftsProvider>{children}</OfflineDraftsProvider>
        </SafeAreaProvider>
      </Theme>
    </TamaguiProvider>
  );
}

/**
 * Composes the app-wide providers (D26/D2/D7/D34):
 * Clerk (auth) → Convex-with-Clerk (authed reactive data) → theme preference → Tamagui (themed UI)
 * → SafeArea → OfflineDrafts (F2: the offline report queue + its reconnect/foreground flush
 * triggers, under Convex+auth so a flush has an authed client).
 *
 * The theme preference sits *under* Convex rather than at the very top: it's device-local today, but
 * the moment it wants to follow an account across devices it needs an authed client, and moving a
 * provider up the tree later is a bigger change than starting it in the right place.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={env.clerkPublishableKey} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <ThemePreferenceProvider>
          <ThemedApp>{children}</ThemedApp>
        </ThemePreferenceProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
