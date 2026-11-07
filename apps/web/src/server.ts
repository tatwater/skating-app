// Sentry must initialize before the request handler runs (D29), so this import stays first.
import './instrument.server';

import { wrapFetchWithSentry } from '@sentry/tanstackstart-react';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { posthogServerLogger } from './lib/posthogLogs.server';

/**
 * Server entry (D26/D29). This replaces TanStack Start's default server entry so we can wrap
 * the fetch handler with Sentry: `wrapFetchWithSentry` opens a request-scoped Sentry context
 * and captures any error thrown while handling the request (SSR, loaders, server functions).
 */
export default createServerEntry(
  wrapFetchWithSentry({
    async fetch(request: Request) {
      const startedAt = performance.now();

      try {
        const response = await handler.fetch(request);
        posthogServerLogger?.emit({
          severityText: 'INFO',
          body: 'server request completed',
          attributes: {
            event: 'server_request_completed',
            request_method: request.method,
            response_status: response.status,
            duration_ms: Math.round(performance.now() - startedAt),
          },
        });
        return response;
      } catch (error) {
        posthogServerLogger?.emit({
          severityText: 'ERROR',
          body: 'server request failed',
          attributes: {
            event: 'server_request_failed',
            request_method: request.method,
            error_type: error instanceof Error ? error.name : 'unknown_error',
            duration_ms: Math.round(performance.now() - startedAt),
          },
        });
        throw error;
      }
    },
  }),
);
