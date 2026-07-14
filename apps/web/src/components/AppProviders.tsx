import { ClerkProvider, useAuth } from '@clerk/tanstack-react-start'
import * as Sentry from '@sentry/tanstackstart-react'
import { ConvexReactClient } from 'convex/react'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import { type ReactNode, useState } from 'react'
import { env } from '../lib/env'
import { ThemeProvider } from './theme-provider'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'

/**
 * App-wide providers (D26/D2/D7/D34), mirroring the mobile provider stack:
 * Clerk (auth) → Convex-with-Clerk (authed reactive data) → theme. Clerk reads its keys
 * server-side via the request middleware (`src/start.ts`), so `<ClerkProvider>` needs no
 * props. The Convex client is created once per client via `useState` so it's stable across
 * renders and never shared across server requests.
 *
 * The whole tree is wrapped in `Sentry.ErrorBoundary` (D29) — the web analog of mobile's
 * `Sentry.wrap(RootLayout)`: it reports render-time crashes and shows a recoverable fallback
 * instead of a blank page (a passthrough during SSR, where React error boundaries don't run).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [convex] = useState(() => new ConvexReactClient(env.convexUrl))
  return (
    <Sentry.ErrorBoundary fallback={CrashFallback}>
      <ClerkProvider>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <ThemeProvider>{children}</ThemeProvider>
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </Sentry.ErrorBoundary>
  )
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
  )
}
