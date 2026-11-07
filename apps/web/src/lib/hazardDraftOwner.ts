/**
 * Who the hazard flow's draft belongs to — the same rule as the report sheet's (`sheetOwner`):
 * bound to the signed-in Clerk user, app-wide, so a half-drawn hazard never restores for the next
 * account on a shared browser. The rule itself is `hazardDraftStore.bindOwner`'s; this is only
 * where the account comes from.
 */

import { useAuth } from '@clerk/tanstack-react-start';
import { useEffect } from 'react';

import { useHazardDraftStore } from '@/stores/hazardDraftStore';

/**
 * Bind the hazard draft to the signed-in Clerk user — `null` when signed out. Mounted once, in the
 * skater layout; it waits for Clerk to load, so a page load never reads as a sign-out.
 */
export function useHazardDraftOwnerBinding(): void {
  const { isLoaded, isSignedIn, userId } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    useHazardDraftStore.getState().bindOwner(isSignedIn ? (userId ?? null) : null);
  }, [isLoaded, isSignedIn, userId]);
}
