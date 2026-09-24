/**
 * Who the open report sheet belongs to (PR #77 review), wired to Clerk — the two hooks that keep one
 * account's half-written Post from reaching the next account on a shared browser. The rules
 * themselves are `sheetStore`'s; this is only where the account comes from.
 */

import { useAuth } from '@clerk/tanstack-react-start';
import { useCallback, useEffect } from 'react';
import { bindSheetOwner, forgetSheet } from './sheetStore';

/**
 * Bind the sheet to the signed-in Clerk user — `null` when signed out. Mounted once, in `AuthGate`,
 * which every route renders under; it waits for Clerk to load, so a page load never reads as a
 * sign-out.
 */
export function useSheetOwnerBinding(): void {
  const { isLoaded, isSignedIn, userId } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    bindSheetOwner(isSignedIn ? (userId ?? null) : null);
  }, [isLoaded, isSignedIn, userId]);
}

/**
 * Clerk's sign-out, with the sheet forgotten first: an author signing out is leaving this browser,
 * and what they were writing leaves with them. Every *Sign out* button goes through this.
 */
export function useSignOut(): () => Promise<void> {
  const { signOut } = useAuth();
  return useCallback(async () => {
    forgetSheet();
    await signOut();
  }, [signOut]);
}
