import type { EntryRoute } from '@skating/core';

/**
 * Web-only translation of the shared `resolveEntryRoute` state (B03 §9.3, D298) into a redirect
 * target. Mobile swaps its navigation tree declaratively (`Stack.Protected`); the web is
 * path-based, so this computes "given where the skater's way in stands, is the current path in
 * the wrong zone, and if so where should they go?". Pure and tested, so the redirect rules are
 * verifiable without a router harness. Returns `null` when the current path is already allowed.
 *
 * Paths only: a step inside a page (`/onboarding?step=terms`, `/welcome?step=profile`) is the
 * page's to settle, from its own search params and the profile.
 */

/** Signed-out visitors may sit on these paths (plus the public About page). */
const AUTH_PATHS: ReadonlySet<string> = new Set(['/sign-in', '/sign-up']);
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/about']);

/** Each step of the way in, at its one path. */
export const ENTRY_PATHS = {
  account: '/onboarding',
  terms: '/terms',
  questions: '/know-before-you-go',
  welcome: '/welcome',
} as const satisfies Partial<Record<EntryRoute, string>>;

/**
 * Every way-in path: none of them is a place to be once the skater is through. `/reack` is the
 * retired acknowledgment's page (D295): no route draws it any more, but an old bookmark to it goes
 * home rather than to the 404.
 */
const WAY_IN_PATHS: ReadonlySet<string> = new Set([...Object.values(ENTRY_PATHS), '/reack']);

/**
 * Where the receipt may sit: the Terms step's two homes. The receipt hold keeps the skater on the
 * screen they accepted on; anywhere else (a typed URL mid-hold) goes to `/terms`, which draws the
 * receipt for an account that now exists.
 */
const RECEIPT_PATHS: ReadonlySet<string> = new Set([ENTRY_PATHS.account, ENTRY_PATHS.terms]);

export function authZoneTarget(route: EntryRoute, pathname: string): string | null {
  switch (route) {
    case 'auth':
      // Signed out: only the auth pages (and public About) are reachable.
      return AUTH_PATHS.has(pathname) || PUBLIC_PATHS.has(pathname) ? null : '/sign-in';
    case 'receipt':
      return RECEIPT_PATHS.has(pathname) ? null : ENTRY_PATHS.terms;
    case 'account':
    case 'terms':
    case 'questions':
    case 'welcome': {
      // A step of the way in: pinned to its path until the route moves on.
      const path = ENTRY_PATHS[route];
      return pathname === path ? null : path;
    }
    case 'app':
      // Through: the auth pages and the way in no longer apply — send home.
      return AUTH_PATHS.has(pathname) || WAY_IN_PATHS.has(pathname) ? '/' : null;
    default:
      // `loading` — decide nothing yet.
      return null;
  }
}
