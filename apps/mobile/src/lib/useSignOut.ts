import { useAuth } from '@clerk/expo';
import { api } from '@skating/convex/api';
import { useMutation } from 'convex/react';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { clearNotificationCache } from './notificationCache';
import { unregisterThisDevice } from './pushRegistration';

/**
 * Sign out from anywhere — the You tab, the onboarding's bar, the season card's *Not now — sign
 * out*. Sign-out takes this phone's push address with it and drops the offline inbox (A08 PR 3): a
 * phone nobody is signed in on must not keep ringing — or reading back — for the account that left.
 * Both best-effort and *before* the Clerk sign-out. The release itself needs no session (it's keyed
 * by the token), so one that's still queued when the session ends still lands; the tabs layout
 * re-registers on the next sign-in. The root gate forgets the onboarding's hold on its own once
 * nobody is signed in.
 */
export function useSignOut(): () => Promise<void> {
  const { signOut } = useAuth();
  const router = useRouter();
  const register = useMutation(api.pushTokens.register);
  const unregister = useMutation(api.pushTokens.unregister);
  const release = useMutation(api.pushTokens.release);
  return useCallback(async () => {
    await unregisterThisDevice({ register, unregister, release });
    clearNotificationCache();
    await signOut();
    router.replace('/sign-in');
  }, [register, unregister, release, signOut, router]);
}
