import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabsHub } from '@/test/tabsHub';
import { accountScoped, resetAccountOwnerForTests } from './accountScoped';
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

/** A registered in-memory store (as a ticket's drafts are): how often it was forgotten. */
const scoped = vi.hoisted(() => ({ forgotten: 0 }));

afterEach(() => {
  vi.clearAllMocks();
  resetAccountOwnerForTests();
  scoped.forgotten = 0;
  store.sheet = null;
  setUnsavedChannelForTests(undefined);
});

accountScoped(() => {
  scoped.forgotten++;
});

describe('useSheetOwnerBinding', () => {
  it('forgets the person’s in-memory stores when the signed-in person changes, never on a page load', () => {
    const { rerender } = renderHook(() => useSheetOwnerBinding());
    // The first binding is a page load, not a change of person.
    expect(scoped.forgotten).toBe(0);
    rerender();
    expect(scoped.forgotten).toBe(0);
    // Another person signs in at the same tab: the last one's unsent words go.
    Object.assign(auth, { userId: 'user_b' });
    rerender();
    expect(scoped.forgotten).toBe(1);
    // Signed out (a session that expired): gone too.
    Object.assign(auth, { isSignedIn: false, userId: null });
    rerender();
    expect(scoped.forgotten).toBe(2);
  });

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

  it('forgets every in-memory store the person owns (a ticket’s unsent reply) before signing out', async () => {
    const order: string[] = [];
    auth.signOut.mockImplementation(async () => {
      order.push(`signOut after ${scoped.forgotten} forgets`);
    });
    const { result } = renderHook(() => useSignOut());
    await result.current();
    expect(order).toEqual(['signOut after 1 forgets']);
  });
});
