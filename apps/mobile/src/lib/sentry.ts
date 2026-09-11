import * as Sentry from '@sentry/react-native';
import { sentryPrivacyHooks } from '@skating/core';
import { env, isConfigured } from './env';

/**
 * Crash/error reporting from day one (D29) — "is it crashing in the cold?". No-ops
 * until a real DSN is provisioned so local/UI work stays quiet. PostHog (analytics,
 * session replay) is deliberately deferred to a later phase.
 *
 * The privacy rules are the same ones the web app installs, from `@skating/core`, where
 * they are tested once. What differs between the platforms is only the SDK's own option
 * names: `ReactNativeOptions` has no `dataCollection`, and exposes the older
 * `sendDefaultPii` instead. That is the whole of the divergence, and it is why the hooks
 * live in the shared package rather than being written out on each side.
 */
export function initSentry() {
  if (!isConfigured.sentry) return;

  Sentry.init({
    ...sentryPrivacyHooks,
    dsn: env.sentryDsn,
    // Keep it lean for the alpha; tune sampling once there's real traffic.
    tracesSampleRate: 1.0,
    // We'll enable native crash symbolication automatically via the Expo plugin.

    // No device or user information the SDK inferred on its own, which on native includes
    // the IP address the event was sent from. It already defaults to false; stated because
    // this is a location app whose population includes minors (D41), so the default is one
    // worth being explicit about rather than inheriting.
    sendDefaultPii: false,
  });
}
