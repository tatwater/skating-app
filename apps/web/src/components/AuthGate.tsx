import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { resolveAuthRoute } from '@skating/core';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { type ReactNode, useEffect } from 'react';
import { authZoneTarget } from '../lib/authZone';
import { AppShell } from './AppShell';
import { Splash } from './Splash';

/**
 * Web counterpart to mobile's `Stack.Protected` gate (D26/D45), driven by the *same* pure
 * `resolveAuthRoute` (shared in `@skating/core`, D7). It resolves the auth/provisioning
 * state from Clerk + the reactive `profiles.current` query, then — because the web is
 * path-based — redirects the user into the right zone when they're in the wrong one. The
 * signed-in-and-provisioned (`app`) state is wrapped in the `AppShell`; the auth/onboarding/
 * re-ack pages render bare. We hold on a `Splash` while loading or mid-redirect so we never
 * flash the wrong surface.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const profile = useQuery(api.profiles.current, isSignedIn ? {} : 'skip');
  const route = resolveAuthRoute({ isLoaded, isSignedIn, profile });

  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const target = authZoneTarget(route, pathname);

  useEffect(() => {
    // `history.push` takes a plain path string, sidestepping typed-route friction for a
    // computed redirect target.
    if (target && target !== pathname) router.history.push(target);
  }, [target, pathname, router]);

  if (route === 'loading' || target) return <Splash />;
  if (route === 'app') return <AppShell>{children}</AppShell>;
  return <>{children}</>;
}
