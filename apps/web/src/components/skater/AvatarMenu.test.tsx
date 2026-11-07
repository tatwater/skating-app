import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { convexReact, fakes, resetFakes, router } from './testMocks';

const theme = vi.hoisted(() => ({ value: 'system' as string, setTheme: vi.fn() }));
const signOut = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// A written sheet, as the report sheet's store holds it; `null` is no sheet open.
const sheet = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => router);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => signOut }));
vi.mock('@/lib/sheetStore', () => ({
  useSheet: () => sheet.value,
  useSheetAttempt: () => null,
  readStoredSheet: () => null,
}));
vi.mock('../theme-provider', () => ({
  useTheme: () => ({ theme: theme.value, setTheme: theme.setTheme, resolvedTheme: 'dark' }),
}));

import { AvatarMenu, useThemeChoice } from './AvatarMenu';

beforeEach(() => {
  resetFakes();
  theme.value = 'system';
  theme.setTheme.mockClear();
  signOut.mockClear();
  sheet.value = null;
  useChromeStore.setState({ overlay: null });
  fakes.queries.set('profiles:current', {
    _id: 'p1',
    displayName: 'Kate Donovan',
    username: 'kdonovan',
    role: 'member',
  });
});
afterEach(() => useChromeStore.setState({ overlay: null }));

describe('useThemeChoice', () => {
  it('writes the theme and records a real change, never a re-press', () => {
    const { result } = renderHook(() => useThemeChoice());
    act(() => result.current.onThemeChange('system'));
    expect(theme.setTheme).not.toHaveBeenCalled();
    act(() => result.current.onThemeChange('dark'));
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
    expect(fakes.capture).toHaveBeenCalledWith('theme_changed', { mode: 'dark' });
  });
});

describe('AvatarMenu', () => {
  it('shows who you are and goes where its rows say', () => {
    act(() => useChromeStore.getState().setOverlay('avatar'));
    render(<AvatarMenu />);
    expect(screen.getByText('@kdonovan')).toBeInTheDocument();
    expect(screen.queryByText('Moderation')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Your profile' }));
    expect(fakes.push).toHaveBeenCalledWith('/u/kdonovan');
  });

  it('offers Moderation to a moderator, in a new tab', () => {
    fakes.queries.set('profiles:current', {
      _id: 'p1',
      displayName: 'Kate Donovan',
      username: 'kd',
      role: 'moderator',
      profileImageUrl: 'https://x/k.png',
    });
    act(() => useChromeStore.getState().setOverlay('avatar'));
    render(<AvatarMenu />);
    const item = screen.getByRole('menuitem', { name: /Moderation/ });
    expect(item).toHaveAttribute('href', '/admin');
    expect(item).toHaveAttribute('target', '_blank');
  });

  it('switches the theme from the menu and signs out', () => {
    act(() => useChromeStore.getState().setOverlay('avatar'));
    render(<AvatarMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(theme.setTheme).toHaveBeenCalledWith('light');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('asks before signing out over a written sheet, and can reopen it over this page', async () => {
    sheet.value = {
      draftId: 'd',
      idempotencyKey: 'k',
      title: '',
      body: 'Black ice off the point',
      reports: [{ bodyName: 'Mascoma Lake' }],
      mode: { kind: 'create' },
      door: 'body',
      openedAtMs: Date.now(),
      dirty: true,
    };
    fakes.location = { pathname: '/water/w1', searchStr: '?tab=weather' };
    act(() => useChromeStore.getState().setOverlay('avatar'));
    render(<AvatarMenu />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).not.toHaveBeenCalled();
    expect(await screen.findByText('Sign out and discard your draft?')).toBeInTheDocument();
    expect(screen.getByText(/unsent report on Mascoma Lake/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the draft' }));
    expect(fakes.push).toHaveBeenCalledWith('/water/w1?tab=weather&post=new');
    await waitFor(() => expect(screen.queryByText('Sign out and discard your draft?')).toBeNull());
    expect(signOut).not.toHaveBeenCalled();
  });

  it('opens from its trigger through the chrome store', () => {
    fakes.queries.delete('profiles:current');
    render(<AvatarMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
    expect(useChromeStore.getState().overlay).toBe('avatar');
  });
});
