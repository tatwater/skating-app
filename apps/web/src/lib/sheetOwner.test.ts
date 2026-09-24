import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSheetOwnerBinding, useSignOut } from './sheetOwner';

const auth = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true as boolean,
  userId: 'user_a' as string | null,
  signOut: vi.fn(async () => {}),
}));
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => auth }));

const store = vi.hoisted(() => ({
  bindSheetOwner: vi.fn(),
  forgetSheet: vi.fn(),
}));
vi.mock('./sheetStore', () => store);

beforeEach(() => {
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: 'user_a' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSheetOwnerBinding', () => {
  it('binds the signed-in user, and no one once signed out', () => {
    const { rerender } = renderHook(() => useSheetOwnerBinding());
    expect(store.bindSheetOwner).toHaveBeenLastCalledWith('user_a');
    Object.assign(auth, { isSignedIn: false, userId: null });
    rerender();
    expect(store.bindSheetOwner).toHaveBeenLastCalledWith(null);
  });

  it('binds nothing while Clerk is loading, so a page load never reads as a sign-out', () => {
    Object.assign(auth, { isLoaded: false, isSignedIn: false, userId: null });
    renderHook(() => useSheetOwnerBinding());
    expect(store.bindSheetOwner).not.toHaveBeenCalled();
  });
});

describe('useSignOut', () => {
  it('forgets the sheet before Clerk signs the author out', async () => {
    const order: string[] = [];
    store.forgetSheet.mockImplementation(() => order.push('forget'));
    auth.signOut.mockImplementation(async () => {
      order.push('signOut');
    });
    const { result } = renderHook(() => useSignOut());
    await result.current();
    expect(order).toEqual(['forget', 'signOut']);
  });
});
