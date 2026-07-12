/**
 * Centralized, validated access to client env (D2/D29). `VITE_`-prefixed vars are the only
 * ones Vite inlines into the client bundle, so they're the public keys. Clerk's keys are
 * read server-side by `@clerk/tanstack-react-start` (see `src/start.ts`), not here.
 *
 * As on mobile, we fall back to obvious placeholders rather than throwing so the app still
 * builds/boots for UI work before keys are provisioned — data + telemetry simply stay inert.
 */

const CONVEX_URL_PLACEHOLDER = 'https://placeholder.convex.cloud'

export const env = {
  convexUrl: import.meta.env.VITE_CONVEX_URL ?? CONVEX_URL_PLACEHOLDER,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN ?? '',
} as const

/** True once the corresponding real key has been provisioned (not a placeholder). */
export const isConfigured = {
  convex: env.convexUrl !== CONVEX_URL_PLACEHOLDER,
  sentry: env.sentryDsn.length > 0,
} as const
