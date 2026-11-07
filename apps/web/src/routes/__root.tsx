import { useAuth, useUser } from '@clerk/tanstack-react-start';
import { PostHogProvider, usePostHog } from '@posthog/react';
import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { AppProviders } from '../components/AppProviders';
import { AuthGate } from '../components/AuthGate';
import '../lib/fontawesome';
import appCss from '../styles/app.css?url';

/**
 * Root document + providers. `shellComponent` owns the full HTML shell; the providers and
 * the `AuthGate` (D26/D45) wrap the routed content (`children`). `suppressHydrationWarning`
 * on <html> is required because next-themes sets the theme class before hydration (D34).
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Gli' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <PostHogRoot>
          <PostHogLogLifecycle />
          <AppProviders>
            <PostHogIdentity>
              <AuthGate>{children}</AuthGate>
            </PostHogIdentity>
          </AppProviders>
        </PostHogRoot>
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Synchronizes Clerk's durable user ID with the browser client once authentication has settled.
 * PostHog keeps that identity for later events and exception capture; a reset on sign-out (or an
 * in-browser account switch) prevents the next account from inheriting the prior account's data.
 */
function PostHogIdentity({ children }: { children: ReactNode }) {
  const posthog = usePostHog();
  const { isLoaded: isAuthLoaded, isSignedIn, userId } = useAuth();
  const { isLoaded: isUserLoaded, user } = useUser();
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthLoaded || !isUserLoaded) return;

    if (!isSignedIn || !userId) {
      if (identifiedUserId.current) {
        posthog.reset();
        identifiedUserId.current = null;
      }
      return;
    }

    if (identifiedUserId.current === userId) return;

    if (identifiedUserId.current) posthog.reset();

    posthog.identify(userId, {
      ...(user?.primaryEmailAddress?.emailAddress
        ? { email: user.primaryEmailAddress.emailAddress }
        : {}),
      ...(user?.fullName ? { name: user.fullName } : {}),
    });
    identifiedUserId.current = userId;
  }, [isAuthLoaded, isSignedIn, isUserLoaded, posthog, user, userId]);

  return <>{children}</>;
}

/** Emits only the app lifecycle records this integration owns; existing console output stays local. */
function PostHogLogLifecycle() {
  const posthog = usePostHog();

  useEffect(() => {
    posthog.logger.info('web application initialized', {
      event: 'web_application_initialized',
      runtime: 'browser',
    });
  }, [posthog]);

  return null;
}

function PostHogRoot({ children }: { children: ReactNode }) {
  const apiKey = import.meta.env.VITE_POSTHOG_KEY;
  const apiHost = import.meta.env.VITE_POSTHOG_HOST;

  if (!apiKey || !apiHost) {
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const missingVariable = apiKey ? 'VITE_POSTHOG_HOST' : 'VITE_POSTHOG_KEY';
      throw new Error(
        `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
      );
    }

    return children;
  }

  return (
    <PostHogProvider
      apiKey={apiKey}
      options={{
        api_host: apiHost,
        capture_exceptions: true,
        defaults: '2025-05-24',
        debug: import.meta.env.DEV,
        logs: {
          serviceName: 'skating-web',
          environment: import.meta.env.MODE,
        },
      }}
    >
      {children}
    </PostHogProvider>
  );
}
