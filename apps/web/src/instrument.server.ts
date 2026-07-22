import * as Sentry from '@sentry/tanstackstart-react';
import { env, isConfigured } from './lib/env';

/**
 * Server-side Sentry init (D29), imported as the very first statement of the server entry
 * (`src/server.ts`) so it initializes before the request handler runs. This is what closes
 * the gap the mobile app already had (its root is `Sentry.wrap`-ed): without a server init,
 * SSR/loader/server-function errors go uncaptured.
 *
 * `import.meta.env.VITE_SENTRY_DSN` is inlined by Vite into the SSR bundle just as it is on
 * the client, so the same single DSN drives both surfaces and the same placeholder guard
 * keeps the server quiet until a DSN is provisioned. Deep Node/OTel auto-instrumentation
 * (which needs a `--import` preloader) is intentionally skipped; `wrapFetchWithSentry`
 * (see `server.ts`) + the request middleware give request-scoped error + trace capture, which
 * is what we need for the alpha.
 */
if (isConfigured.sentry) {
  Sentry.init({
    dsn: env.sentryDsn,
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
  });
}
