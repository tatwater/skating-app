import * as Sentry from '@sentry/tanstackstart-react';
import {
  createRootRoute,
  type ErrorComponentProps,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { AppProviders } from '../components/AppProviders';
import { AuthGate } from '../components/AuthGate';
import { RouteAnalytics } from '../components/RouteAnalytics';
import { CrashScreen } from '../components/skater/CrashScreen';
import { NotFoundRoute } from '../components/skater/SkaterShell';
import { isConfigured } from '../lib/env';
import '../lib/fontawesome';
import appCss from '../styles/app.css?url';

/**
 * Root document + providers. `shellComponent` owns the full HTML shell; the providers and
 * the `AuthGate` (D26/D45) wrap the routed content (`children`). `suppressHydrationWarning`
 * on <html> is required because the theme init script sets `data-mode` and the theme class
 * before hydration (D34/D241).
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Gli' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFoundRoute,
  errorComponent: RootCrash,
});

/**
 * The router's own error boundary catches a route's throw before `Sentry.ErrorBoundary` can, so it
 * reports here — once per mount, and only when Sentry has a DSN — and shows the same crash screen.
 */
function RootCrash({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    if (isConfigured.sentry) Sentry.captureException(error);
  }, [error]);
  return <CrashScreen onRetry={reset} />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppProviders>
          <RouteAnalytics />
          <AuthGate>{children}</AuthGate>
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
