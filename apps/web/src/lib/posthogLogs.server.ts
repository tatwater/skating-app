import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
const posthogHost = import.meta.env.VITE_POSTHOG_HOST;
const isPostHogConfigured = Boolean(posthogKey && posthogHost);

if (!isPostHogConfigured && import.meta.env.DEV) {
  const missingVariable = posthogKey ? 'VITE_POSTHOG_HOST' : 'VITE_POSTHOG_KEY';
  console.warn(
    `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
  );
}

function createPostHogLogger() {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': 'skating-web-server',
      'deployment.environment': import.meta.env.MODE,
    }),
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${posthogHost}/i/v1/logs`,
          headers: { Authorization: `Bearer ${posthogKey}` },
        }),
      ),
    ],
  });

  // Deliberately use this provider rather than the global Logs API: only records emitted below
  // are exported, and existing application loggers retain their current destinations.
  return provider.getLogger('posthog-web-server');
}

/** Dedicated OTLP logger for the lifecycle records added by this integration. */
export const posthogServerLogger = isPostHogConfigured ? createPostHogLogger() : undefined;
