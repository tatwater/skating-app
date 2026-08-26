import { ClerkProvider, useAuth } from '@clerk/tanstack-react-start';
import * as Sentry from '@sentry/tanstackstart-react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { useTheme } from 'next-themes';
import { type ReactNode, useState } from 'react';
import { CLERK_APPEARANCE } from '../lib/clerkAppearance';
import { env } from '../lib/env';
import { ThemeProvider } from './theme-provider';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

/**
 * App-wide providers (D26/D2/D7/D34), mirroring the mobile provider stack:
 * theme → Clerk (auth) → Convex-with-Clerk (authed reactive data). Clerk reads its keys
 * server-side via the request middleware (`src/start.ts`), so `<ClerkProvider>` needs no
 * key props. The Convex client is created once per client via `useState` so it's stable across
 * renders and never shared across server requests.
 *
 * The theme sits **outermost** (it used to be innermost) because Clerk's prebuilt components take
 * their palette as a prop rather than reading CSS, so `<ClerkProvider>` has to be able to see the
 * resolved theme. `next-themes` depends on neither Clerk nor Convex, so hoisting it is free.
 *
 * The whole tree is wrapped in `Sentry.ErrorBoundary` (D29) — the web analog of mobile's
 * `Sentry.wrap(RootLayout)`: it reports render-time crashes and shows a recoverable fallback
 * instead of a blank page (a passthrough during SSR, where React error boundaries don't run).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <Sentry.ErrorBoundary fallback={CrashFallback}>
      <ThemeProvider>
        <AuthedProviders>{children}</AuthedProviders>
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
  // `resolvedTheme` is undefined until `next-themes` has read localStorage on the client. Light is
  // the D34 default, so falling back to it matches what the surrounding page paints on first frame.
  const appearance = CLERK_APPEARANCE[resolvedTheme === 'dark' ? 'dark' : 'light'];

  return (
    <ClerkProvider appearance={appearance}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function CrashFallback({ resetError }: { resetError: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <h1 className="font-bold font-mono text-foreground text-lg uppercase tracking-widest">
            Something broke
          </h1>
          <p className="text-foreground-muted text-sm">
            The app hit an unexpected error. It's been reported — try again, and if it keeps
            happening, reload the page.
          </p>
          <Button onClick={resetError}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}
