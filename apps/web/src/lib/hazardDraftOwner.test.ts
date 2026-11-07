import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useHazardDraftStore } from '@/stores/hazardDraftStore';

import { useHazardDraftOwnerBinding } from './hazardDraftOwner';

const auth = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true as boolean,
  userId: 'user_a' as string | null,
}));
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => auth }));

const initial = useHazardDraftStore.getState();

beforeEach(() => {
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: 'user_a' });
  localStorage.clear();
  useHazardDraftStore.setState({ ...initial, owner: null, bound: false, draft: null }, true);
});

describe('useHazardDraftOwnerBinding', () => {
  it('binds the signed-in Clerk user, and no one once signed out', () => {
    const { rerender } = renderHook(() => useHazardDraftOwnerBinding());
    expect(useHazardDraftStore.getState()).toMatchObject({ owner: 'user_a', bound: true });
    Object.assign(auth, { isSignedIn: false, userId: null });
    rerender();
    expect(useHazardDraftStore.getState().owner).toBeNull();
  });

  it('binds nothing while Clerk is loading, so a page load never reads as a sign-out', () => {
    const bind = vi.spyOn(useHazardDraftStore.getState(), 'bindOwner');
    Object.assign(auth, { isLoaded: false, isSignedIn: false, userId: null });
    renderHook(() => useHazardDraftOwnerBinding());
    expect(bind).not.toHaveBeenCalled();
    expect(useHazardDraftStore.getState().bound).toBe(false);
  });

  it('a signed-in session with no user id yet binds no one', () => {
    Object.assign(auth, { userId: null });
    renderHook(() => useHazardDraftOwnerBinding());
    // Bound to no one is still bound: the flow may open, and nothing persists.
    expect(useHazardDraftStore.getState()).toMatchObject({ owner: null, bound: true });
  });
});
