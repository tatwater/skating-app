import type { AuthRoute } from '@skating/core';

/**
 * Web-only translation of the shared `resolveAuthRoute` state (D26/D45) into a redirect
 * target. Mobile swaps its navigation tree declaratively (`Stack.Protected`); web is
 * path-based, so we compute "given the auth state, is the current path in the wrong zone,
 * and if so where should we send them?". Pure + tested so the redirect rules are verifiable
 * without a router harness. Returns `null` when the current path is already allowed.
 */

/** Signed-out users may sit on these paths (plus the public About page). */
const AUTH_PATHS: ReadonlySet<string> = new Set(['/sign-in', '/sign-up']);
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/about']);

export function authZoneTarget(route: AuthRoute, pathname: string): string | null {
  switch (route) {
    case 'auth':
      // Signed out: only the auth pages (and public About) are reachable.
      return AUTH_PATHS.has(pathname) || PUBLIC_PATHS.has(pathname) ? null : '/sign-in';
    case 'onboarding':
      // Signed in, no profile yet: pin to onboarding until it's created.
      return pathname === '/onboarding' ? null : '/onboarding';
    case 'reack':
      // Signed in, stale acknowledgment: pin to re-ack until renewed.
      return pathname === '/reack' ? null : '/reack';
    case 'app':
      // Fully provisioned: the auth/onboarding/reack pages no longer apply — send home.
      return AUTH_PATHS.has(pathname) || pathname === '/onboarding' || pathname === '/reack'
        ? '/'
        : null;
    default:
      // `loading` — decide nothing yet.
      return null;
  }
}
