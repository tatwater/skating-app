import * as Sentry from '@sentry/tanstackstart-react';
import { env, isConfigured } from './lib/env';
import { sharedSentryOptions } from './lib/sentryOptions';

/**
 * Client-side Sentry init (D29), imported as the very first statement of the client entry
 * (`src/client.tsx`) so it initializes before React hydration. No-ops until a real DSN is
 * provisioned, so local/UI work stays quiet (mirrors the mobile `initSentry()` guard).
 *
 * Session Replay + user-feedback integrations are deliberately NOT enabled: this is a
 * location app whose population includes minors (D29), so replay stays off — to be revisited
 * with input/coordinate masking before it's ever turned on. Router-aware browser tracing is
 * attached separately in `router.tsx` (it needs the router instance, which doesn't exist yet).
 *
 * `sharedSentryOptions` replaces the `sendDefaultPii: false` that used to sit here. That flag
 * did less than it read as — see the note on `dataCollection` in `lib/sentryOptions.ts` — and
 * nothing scrubbed the fields an application actually fills in.
 */
if (isConfigured.sentry) {
  Sentry.init({
    ...sharedSentryOptions,
    dsn: env.sentryDsn,
    // Full sampling for the alpha; tune down once there's real traffic. Every navigation
    // becomes a transaction at this rate, which is why `beforeSendTransaction` in
    // @skating/core strips URLs out of span attributes and descriptions.
    tracesSampleRate: 1.0,
  });
}
