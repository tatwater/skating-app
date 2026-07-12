import { createRouter } from '@tanstack/react-router'
import { initSentry } from './lib/sentry'
import { routeTree } from './routeTree.gen'

// Client-side crash reporting from day one (D29); no-ops on the server / without a DSN.
initSentry()

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
