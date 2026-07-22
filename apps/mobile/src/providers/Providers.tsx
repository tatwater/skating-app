import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
import { tokenCache } from '@clerk/clerk-expo/token-cache';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider } from 'tamagui';
import { config } from '../../tamagui.config';
import { OfflineDraftsProvider } from '../components/OfflineDraftsContext';
import { convex } from '../lib/convex';
import { env } from '../lib/env';

/**
 * Composes the app-wide providers (D26/D2/D7/D34):
 * Clerk (auth) → Convex-with-Clerk (authed reactive data) → Tamagui (themed UI,
 * following the OS light/dark preference) → SafeArea → OfflineDrafts (F2: the offline
 * report queue + its reconnect/foreground flush triggers, under Convex+auth so a flush
 * has an authed client).
 */
export function Providers({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  return (
    <ClerkProvider publishableKey={env.clerkPublishableKey} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <TamaguiProvider config={config} defaultTheme={scheme === 'dark' ? 'dark' : 'light'}>
          <SafeAreaProvider>
            <OfflineDraftsProvider>{children}</OfflineDraftsProvider>
          </SafeAreaProvider>
        </TamaguiProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
