import { useRouterState } from '@tanstack/react-router';

/**
 * Where the console is now (path and query), for a link that comes back here — a Body console's
 * `from`. Its own module so the route-and-view harness, which stands in the router's
 * `useSearch`, `useNavigate` and `Link` only, can stand this in too.
 */
export function useHereHref(): string {
  return useRouterState({ select: (s) => s.location.href });
}
