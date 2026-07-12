import * as Sentry from '@sentry/tanstackstart-react'
import { env, isConfigured } from './env'

/**
 * Client-side crash/error reporting from day one (D29). No-ops on the server and until a
 * real DSN is provisioned, so local/UI work stays quiet. Called once at router-module load
 * (see `src/router.tsx`) — the web analog of mobile's `initSentry()` in the root layout.
 * PostHog (analytics, session replay) is deliberately deferred to a later phase.
 */
export function initSentry() {
  if (typeof window === 'undefined') return
  if (!isConfigured.sentry) return

  Sentry.init({
    dsn: env.sentryDsn,
    // Keep it lean for the alpha; tune sampling once there's real traffic.
    tracesSampleRate: 1.0,
  })
}
