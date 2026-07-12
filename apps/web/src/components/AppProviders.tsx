import { ClerkProvider, useAuth } from '@clerk/tanstack-react-start'
import { ConvexReactClient } from 'convex/react'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import { type ReactNode, useState } from 'react'
import { env } from '../lib/env'
import { ThemeProvider } from './theme-provider'

/**
 * App-wide providers (D26/D2/D7/D34), mirroring the mobile provider stack:
 * Clerk (auth) → Convex-with-Clerk (authed reactive data) → theme. Clerk reads its keys
 * server-side via the request middleware (`src/start.ts`), so `<ClerkProvider>` needs no
 * props. The Convex client is created once per client via `useState` so it's stable across
 * renders and never shared across server requests.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [convex] = useState(() => new ConvexReactClient(env.convexUrl))
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <ThemeProvider>{children}</ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}
