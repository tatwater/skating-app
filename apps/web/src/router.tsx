import * as Sentry from '@sentry/tanstackstart-react';
import { createRouter } from '@tanstack/react-router';
import { isConfigured } from './lib/env';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  });

  // Router-aware browser tracing (D29): pageloads + client navigations become Sentry
  // transactions with the matched route as the name. Client-only (the server build ships a
  // no-op) and gated on a provisioned DSN so it stays inert locally.
  if (!router.isServer && isConfigured.sentry) {
    Sentry.addIntegration(Sentry.tanstackRouterBrowserTracingIntegration(router));
  }

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
