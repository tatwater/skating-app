import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

/**
 * Warms every skater route's code once the first page has settled, so moving between pages costs
 * no download at all.
 *
 * The router already preloads on intent (`defaultPreload: 'intent'` in `router.tsx`), which covers
 * a link the pointer rests on; it does not cover a link pressed straight away, the bell's jump to
 * a hazard, a keyboard navigation, or the back button. Those are the ones that stutter, and the
 * stutter is a chunk fetch, so fetching the chunks while nothing else is happening removes it.
 *
 * **Chunks only, never data.** `loadRouteChunk` loads a route's component module and nothing
 * else — no match, no loader, no subscription. Prefetching *data* would mean opening Convex
 * subscriptions for pages nobody is looking at, which is a corpus-wide read nobody asked for and
 * the opposite of how this app is supposed to treat the deployment.
 *
 * **The console is skipped.** `/admin` is a different app for a handful of people; its chunks are
 * large, and a skater must not pay for them.
 */

/** Routes under these ids stay unwarmed. */
const SKIP_PREFIX = '/admin';

/** When no browser idle callback exists (Safari), warm on this delay instead. */
export const PREFETCH_FALLBACK_MS = 1_000;

export function RoutePrefetch() {
  const router = useRouter();
  // "The first page is done": the router has finished its work and nothing is in flight.
  const settled = useRouterState({ select: (s) => s.status === 'idle' && !s.isLoading });
  const done = useRef(false);

  useEffect(() => {
    if (!settled || done.current) return;
    done.current = true;

    const warm = () => {
      for (const [id, route] of Object.entries(router.routesById)) {
        if (id.startsWith(SKIP_PREFIX)) continue;
        // A chunk that fails to load is not this component's problem: the navigation that needs it
        // will ask again and report it properly.
        void router.loadRouteChunk(route)?.catch(() => {});
      }
    };

    // `requestIdleCallback` so the warm-up never competes with the page that just arrived.
    const idle = typeof window !== 'undefined' ? window.requestIdleCallback : undefined;
    if (idle) {
      const handle = idle(warm, { timeout: 2_000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(warm, PREFETCH_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [settled, router]);

  return null;
}
