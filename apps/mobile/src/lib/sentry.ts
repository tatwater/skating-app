import * as Sentry from '@sentry/react-native'
import { env, isConfigured } from './env'

/**
 * Crash/error reporting from day one (D29) — "is it crashing in the cold?". No-ops
 * until a real DSN is provisioned so local/UI work stays quiet. PostHog (analytics,
 * session replay) is deliberately deferred to a later phase.
 */
export function initSentry() {
  if (!isConfigured.sentry) return

  Sentry.init({
    dsn: env.sentryDsn,
    // Keep it lean for the alpha; tune sampling once there's real traffic.
    tracesSampleRate: 1.0,
    // We'll enable native crash symbolication automatically via the Expo plugin.
  })
}
