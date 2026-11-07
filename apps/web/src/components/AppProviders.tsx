import { ClerkProvider, useAuth } from '@clerk/tanstack-react-start';
import * as Sentry from '@sentry/tanstackstart-react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { type ReactNode, useState } from 'react';
import { CLERK_APPEARANCE } from '../lib/clerkAppearance';
import { env } from '../lib/env';
import { AnalyticsProvider } from './Analytics';
import { PostHogIdentity } from './PostHogIdentity';
import { CrashScreen } from './skater/CrashScreen';
import { ThemeProvider, useTheme } from './theme-provider';

/**
 * App-wide providers (D26/D2/D7/D34), mirroring the mobile provider stack:
 * theme → Clerk (auth) → Convex-with-Clerk (authed reactive data). Clerk reads its keys
 * server-side via the request middleware (`src/start.ts`), so `<ClerkProvider>` needs no
 * key props. The Convex client is created once per client via `useState` so it's stable across
 * renders and never shared across server requests.
 *
 * The theme sits **outermost** (it used to be innermost) because Clerk's prebuilt components take
 * their palette as a prop rather than reading CSS, so `<ClerkProvider>` has to be able to see the
 * resolved theme. The theme provider depends on neither Clerk nor Convex, so hoisting it is free.
 *
 * The whole tree is wrapped in `Sentry.ErrorBoundary` (D29) — the web analog of mobile's
 * `Sentry.wrap(RootLayout)`: it reports render-time crashes and shows a recoverable fallback
 * instead of a blank page (a passthrough during SSR, where React error boundaries don't run).
 *
 * `AnalyticsProvider` (D235) is the other half of D29's observability pair, and sits **outside**
 * Clerk because the SDK has to be initialized before `PostHogIdentity` — which is inside Clerk,
 * where the user id lives — can hand it one. It is also under the error boundary rather than over
 * it, so a crash in analytics setup lands in the fallback like any other and never takes the app
 * with it.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <Sentry.ErrorBoundary fallback={({ resetError }) => <CrashScreen onRetry={resetError} />}>
      <ThemeProvider>
        <AnalyticsProvider>
          <AuthedProviders>{children}</AuthedProviders>
        </AnalyticsProvider>
      </ThemeProvider>
    </Sentry.ErrorBoundary>
  );
}

/**
 * Clerk + Convex, under the theme so Clerk's `appearance` can follow it.
 *
 * Setting `appearance` here rather than on each `<SignIn>`/`<SignUp>` means anything Clerk renders
 * later — a `<UserProfile>`, an org switcher, a verification modal — is themed by default instead of
 * arriving unstyled and needing the prop threaded to it.
 */
function AuthedProviders({ children }: { children: ReactNode }) {
  const [convex] = useState(() => new ConvexReactClient(env.convexUrl));
  const { resolvedTheme } = useTheme();
  // `resolvedTheme` is undefined until the provider has read the OS scheme on the client. Light is
  // the D34 default, so falling back to it matches what the surrounding page paints on first frame.
  const appearance = CLERK_APPEARANCE[resolvedTheme === 'dark' ? 'dark' : 'light'];

  return (
    <ClerkProvider appearance={appearance}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <PostHogIdentity>{children}</PostHogIdentity>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
