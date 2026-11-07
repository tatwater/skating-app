import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { deviceTimeZone, timezoneToSync } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useEffect } from 'react';

import { useSearchOwnerBinding } from './GlobalSearch';
import { NotFoundScreen } from './NotFoundScreen';
import { OfflineOverPage } from './OfflineBoundary';
import { PhoneChrome } from './phone/PhoneChrome';
import { useIsPhone } from './phone/usePhoneLayout';
import { SkaterFrame } from './SkaterFrame';
import { SkaterTopBar } from './SkaterTopBar';
import { useSkaterSurface } from './useSkaterSurface';

/**
 * The skater app's frame (B03 §1, §1.8): the top bar over the page, the skater surface on `<html>`,
 * the offline plate over the page when the connection drops, and the old shell's two side effects
 * on every app open — the device's time zone (the 8 pm digest's zone, A08 §3) and the Clerk mirrors
 * (email, avatar). Below `md` the phone chrome (row 9) takes `SkaterFrame`'s `phoneChrome` slot.
 */
export function SkaterShell({ children }: { children: ReactNode }) {
  useSkaterSurface();
  useAppOpenSync();
  useSearchOwnerBinding();
  // One bar's overlays at a time: the chrome store controls both bars' copies (row 9).
  const phone = useIsPhone();
  return (
    <SkaterFrame
      topBar={phone ? null : <SkaterTopBar />}
      phoneChrome={<PhoneChrome live={phone} />}
      overlay={<OfflineOverPage />}
    >
      {children}
    </SkaterFrame>
  );
}

/**
 * The time zone and the Clerk mirrors, refreshed on app open — the shell is the one component every
 * signed-in page renders, which makes its mount "app open". Each writes only when something
 * differs (the server writes nothing when the claims already match), and a failure is silent: the
 * next open tries again.
 */
export function useAppOpenSync(): void {
  const profile = useQuery(api.profiles.current, {});
  const hasProfile = !!profile;
  const storedZone = profile?.timezone;

  const setTimezone = useMutation(api.profiles.setTimezone);
  useEffect(() => {
    if (!hasProfile) return;
    const timezone = timezoneToSync(storedZone, deviceTimeZone());
    if (timezone !== null) void setTimezone({ timezone }).catch(() => {});
  }, [hasProfile, storedZone, setTimezone]);

  const syncFromClerk = useMutation(api.profiles.syncFromClerk);
  useEffect(() => {
    if (!hasProfile) return;
    void syncFromClerk({}).catch(() => {});
  }, [hasProfile, syncFromClerk]);
}

/**
 * The root route's `notFoundComponent`: signed in, the 404 sits under the top bar (8.14); signed
 * out the auth gate has already sent the visitor to sign in, so the bare screen is a fallback. The
 * router renders it at the root, outside every layout, and the auth gate leaves a not-found match
 * bare (`isNotFound`) — so this shell is the only one, and its app-open effects run once.
 */
export function NotFoundRoute() {
  const { isSignedIn } = useAuth();
  if (!isSignedIn) return <NotFoundScreen />;
  return (
    <SkaterShell>
      <NotFoundScreen />
    </SkaterShell>
  );
}
