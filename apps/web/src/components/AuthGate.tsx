import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { resolveAuthRoute } from '@skating/core';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { type ReactNode, useEffect } from 'react';
import { authZoneTarget } from '../lib/authZone';
import { useSheetOwnerBinding } from '../lib/sheetOwner';
import { AppShell } from './AppShell';
import { FirstLoadSplash } from './skater/OfflineBoundary';

/**
 * The *From Google Photos* consent pop-up's landing page. It answers its opener itself and closes,
 * so it renders bare in every auth state: no shell, and no redirect into an auth zone.
 */
const GOOGLE_PHOTOS_CALLBACK = '/google-photos/callback';

/**
 * The one area still drawn inside the old `AppShell`: the admin console. B03's retirement of the
 * old shell is otherwise complete — Latest replaced `/feed` (now only a redirect to `/latest`) and
 * `/post` is only a redirect into `?post=`. Everything else (`/`, `/latest`, `/water/…`, the
 * cards, profile, settings, about, and a path no route matches) renders bare: the skater layout or
 * the screen brings its own chrome.
 */
const OLD_SHELL_TREES = ['/admin'];

/**
 * Whether the router matched nothing: the root's `notFoundComponent` is about to render, and it
 * brings its own shell (`NotFoundRoute`). Read off the matches' `_notFound` mark — typed on
 * `RouteMatch`, and the only signal the router keeps; `AuthGate.notFound.test.tsx` pins it against
 * the real router so an upgrade that renames it fails there, not in production.
 */
export function isNotFound(state: { matches: ReadonlyArray<{ _notFound?: boolean }> }): boolean {
  return state.matches.some((m) => m._notFound === true);
}

/** Whether `pathname` still sits in the old `AppShell` — the admin console's tree. */
export function usesOldShell(pathname: string): boolean {
  return OLD_SHELL_TREES.some((tree) => pathname === tree || pathname.startsWith(`${tree}/`));
}

/**
 * Web counterpart to mobile's `Stack.Protected` gate (D26/D45), driven by the *same* pure
 * `resolveAuthRoute` (shared in `@skating/core`, D7). It resolves the auth/provisioning
 * state from Clerk + the reactive `profiles.current` query, then — because the web is
 * path-based — redirects the user into the right zone when they're in the wrong one. In the
 * signed-in-and-provisioned (`app`) state only the admin console (`usesOldShell`) is
 * wrapped in the old `AppShell`; the skater pages, the 404 and the auth/onboarding/re-ack pages
 * render bare. We hold on the first-load splash while loading or mid-redirect so we
 * never flash the wrong surface; it turns into the offline screen if the socket never opens.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const profile = useQuery(api.profiles.current, isSignedIn ? {} : 'skip');
  const route = resolveAuthRoute({ isLoaded, isSignedIn, profile });
  // The report sheet is the signed-in author's; a change of account drops it (PR #77 review).
  useSheetOwnerBinding();

  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // A 404 under an old-shell prefix (`/admin/nope`, `/u/a/b`) is still the 404: one shell, its own.
  const notFound = useRouterState({ select: isNotFound });
  const bare = pathname === GOOGLE_PHOTOS_CALLBACK;
  const target = bare ? null : authZoneTarget(route, pathname);

  useEffect(() => {
    // `history.push` takes a plain path string, sidestepping typed-route friction for a
    // computed redirect target.
    if (target && target !== pathname) router.history.push(target);
  }, [target, pathname, router]);

  if (bare) return <>{children}</>;
  if (route === 'loading' || target) return <FirstLoadSplash />;
  if (route === 'app' && usesOldShell(pathname) && !notFound) {
    return <AppShell>{children}</AppShell>;
  }
  return <>{children}</>;
}
