import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AppProviders } from '../components/AppProviders'
import { AuthGate } from '../components/AuthGate'
import appCss from '../styles/app.css?url'

/**
 * Root document + providers. `shellComponent` owns the full HTML shell; the providers and
 * the `AuthGate` (D26/D45) wrap the routed content (`children`). `suppressHydrationWarning`
 * on <html> is required because next-themes sets the theme class before hydration (D34).
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Skating' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppProviders>
          <AuthGate>{children}</AuthGate>
        </AppProviders>
        <Scripts />
      </body>
    </html>
  )
}
