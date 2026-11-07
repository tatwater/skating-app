// Sentry must initialize before the request handler runs (D29), so this import stays first.
import './instrument.server';

import { wrapFetchWithSentry } from '@sentry/tanstackstart-react';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';

/**
 * Server entry (D26/D29). This replaces TanStack Start's default server entry so we can wrap
 * the fetch handler with Sentry: `wrapFetchWithSentry` opens a request-scoped Sentry context
 * and captures any error thrown while handling the request (SSR, loaders, server functions).
 */
export default createServerEntry(
  wrapFetchWithSentry({
    fetch(request: Request) {
      return handler.fetch(request);
    },
  }),
);
