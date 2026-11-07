import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { convexReact, fakes, resetFakes, router } from './testMocks';

const theme = vi.hoisted(() => ({ value: 'system' as string, setTheme: vi.fn() }));
const signOut = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => router);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => signOut }));
vi.mock('../theme-provider', () => ({
  useTheme: () => ({ theme: theme.value, setTheme: theme.setTheme, resolvedTheme: 'dark' }),
}));

import { AvatarMenu, useThemeChoice } from './AvatarMenu';

beforeEach(() => {
  resetFakes();
  theme.value = 'system';
  theme.setTheme.mockClear();
  signOut.mockClear();
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

  it('opens from its trigger through the chrome store', () => {
    fakes.queries.delete('profiles:current');
    render(<AvatarMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
    expect(useChromeStore.getState().overlay).toBe('avatar');
  });
});
