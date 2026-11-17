import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabsHub } from '@/test/tabsHub';
import { useSheetOwnerBinding, useSignOut } from './sheetOwner';
import { askOtherTabs, setUnsavedChannelForTests } from './unsavedElsewhere';

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
  sheet: null as unknown,
  getSheet: () => store.sheet,
  getSheetAttempt: () => null,
}));
vi.mock('./sheetStore', () => store);

beforeEach(() => {
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: 'user_a' });
});

afterEach(() => {
  vi.clearAllMocks();
  store.sheet = null;
  setUnsavedChannelForTests(undefined);
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

describe('the tab answers another tab’s Sign out', () => {
  it('says it holds work while its sheet holds an unsent edit, and nothing once it’s gone', async () => {
    const hub = tabsHub();
    setUnsavedChannelForTests(hub.make, 0);
    // An edit of a published report: written in, never stored — only this tab can say so.
    store.sheet = { mode: { kind: 'edit', reportId: 'r1' }, dirty: true };
    const { unmount } = renderHook(() => useSheetOwnerBinding());
    await expect(askOtherTabs('the-asking-tab')).resolves.toBe('held');
    store.sheet = { mode: { kind: 'edit', reportId: 'r1' }, dirty: false };
    await expect(askOtherTabs('the-asking-tab')).resolves.toBe('none');
    // A closed tab answers nothing and leaves nothing listening.
    store.sheet = { mode: { kind: 'create' }, dirty: true };
    unmount();
    await expect(askOtherTabs('the-asking-tab')).resolves.toBe('none');
    expect(hub.open.size).toBe(0);
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
