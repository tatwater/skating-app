import { usePostHog } from '@posthog/react';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { isConfigured } from '../lib/env';
import { setRouteIdResolver, surfaceForRouteId } from '../lib/posthogOptions';

/**
 * Routes into analytics (D240), two ways:
 *
 * 1. **Registers `route_id` and `surface` as super-properties** on every navigation's
 *    `onResolved`, so the typed events and autocaptured clicks say which page and which surface
 *    (§1.0: a moderator living in the console must not sit in a skater funnel) without any event
 *    naming a URL.
 * 2. **Installs the URL → routeId resolver** `before_send` uses to stamp `$pageview`s: the SDK's
 *    history hook fires on `pushState`, before resolution, so pageviews can't trust the
 *    super-property — they'd carry the previous route (`lib/posthogOptions.ts`).
 *
 * Renders nothing. Mounted once in the root document, inside both the analytics provider and the
 * router.
 */
export function RouteAnalytics() {
  const posthog = usePostHog();
  const router = useRouter();

  useEffect(() => {
    if (!isConfigured.posthog) return;

    setRouteIdResolver((url) => {
      try {
        const pathname = new URL(url, window.location.origin).pathname;
        const matches = router.matchRoutes(pathname, {});
        const routeId = matches[matches.length - 1]?.routeId;
        return typeof routeId === 'string' ? routeId : null;
      } catch {
        return null;
      }
    });

    const register = () => {
      const matches = router.state.matches;
      const routeId = matches[matches.length - 1]?.routeId;
      if (typeof routeId !== 'string') return;
      posthog.register({ route_id: routeId, surface: surfaceForRouteId(routeId) });
    };
    register();
    const unsubscribe = router.subscribe('onResolved', register);
    return () => {
      unsubscribe();
      setRouteIdResolver(null);
    };
  }, [posthog, router]);

  return null;
}
