/**
 * The console's user menu, drawn from props: who is signed in, their own page in People, the theme,
 * and Sign out — in every state the viewer's profile can be in, and from the keyboard.
 */

import type { ThemePreference } from '@skating/design';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type MenuViewer, UserMenuView, type UserMenuViewProps } from './UserMenuView';

const READY: MenuViewer = { state: 'ready', id: 'p_robin', name: 'Robin Ashford' };

beforeAll(() => {
  // jsdom has no Web Animations; the skeleton's shimmer asks for one.
  Element.prototype.animate ??= (() => ({ cancel() {}, startTime: 0 })) as never;
});
afterEach(() => vi.restoreAllMocks());

function Menu(props: Partial<UserMenuViewProps>) {
  const [theme, setTheme] = useState<ThemePreference>('system');
  return (
    <UserMenuView
      viewer={READY}
      theme={theme}
      onThemeChange={setTheme}
      onSignOut={() => {}}
      canOpenOwnPage
      {...props}
    />
  );
}

const trigger = () => screen.getByRole('button', { name: 'Your account' });
const menu = () => screen.getByRole('menu');
/** The theme's segments (the menu's Theme group holds them, under the same name). */
const themes = (m: HTMLElement) => {
  const el = m.querySelector<HTMLElement>('[data-slot="theme-menu"]');
  if (el === null) throw new Error('no theme picker');
  return el;
};

async function open() {
  await userEvent.click(trigger());
  return screen.findByRole('menu');
}

describe('the trigger', () => {
  it('is the viewer’s circle, named for what it opens, masked from analytics', () => {
    render(<Menu />);
    const t = trigger();
    expect(t).toHaveAttribute('aria-haspopup', 'menu');
    expect(t).toHaveClass('ph-no-capture');
    // The circle: initials, hidden from a reader (the button is named), never the handle.
    const face = within(t).getByText('RA');
    expect(face.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(t.textContent).not.toContain('@');
  });

  it('keeps the circle’s box while the profile loads, so the rail never shifts', () => {
    const { rerender } = render(<Menu viewer={{ state: 'loading' }} />);
    const loading = trigger().querySelector('[data-slot="user-menu-face"]');
    expect(loading).toHaveClass('size-avatar-lg', 'rounded-full');
    expect(trigger()).toHaveAttribute('aria-busy', 'true');
    rerender(<Menu viewer={READY} />);
    const ready = trigger().querySelector('[data-slot="user-menu-face"]');
    expect(ready).toHaveClass('size-avatar-lg', 'rounded-full');
    expect(trigger()).not.toHaveAttribute('aria-busy');
  });
});

describe('the menu', () => {
  it('names the viewer by their real name, masked, and never their handle', async () => {
    render(<Menu />);
    const m = await open();
    const who = within(m).getByText('Robin Ashford');
    expect(who.closest('.ph-no-capture')).not.toBeNull();
    expect(m.textContent).not.toContain('@');
  });

  it('opens the viewer’s own page in People, in this tab, by their profile id', async () => {
    render(<Menu />);
    const m = await open();
    const page = within(m).getByRole('menuitem', { name: 'Your page in People' });
    // The person route itself, never the list: a phone's stacked People opens on the person.
    expect(page).toHaveAttribute('href', '/admin/people/p_robin');
    expect(page).not.toHaveAttribute('target');
  });

  it('goes through the router’s link when it is handed one', async () => {
    const linkFor = vi.fn((to: string) => <a href={`#router${to}`} data-router="" />);
    render(<Menu linkFor={linkFor} />);
    const page = within(await open()).getByRole('menuitem', { name: 'Your page in People' });
    expect(linkFor).toHaveBeenCalledWith('/admin/people/p_robin');
    expect(page).toHaveAttribute('data-router');
  });

  it('has no row for their page when the viewer can’t read People', async () => {
    render(<Menu canOpenOwnPage={false} />);
    const m = await open();
    expect(within(m).queryByRole('menuitem', { name: 'Your page in People' })).toBeNull();
    expect(within(m).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('offers the three themes, the stored one pressed, and hands a choice back', async () => {
    const onThemeChange = vi.fn();
    render(<Menu theme="dark" onThemeChange={onThemeChange} />);
    const m = await open();
    const group = themes(m);
    expect(group).toHaveAccessibleName('Theme');
    const names = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['System', 'Light', 'Dark']);
    expect(within(group).getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(group).getByRole('button', { name: 'Light' }));
    expect(onThemeChange).toHaveBeenCalledWith('light');
  });

  it('signs out from its last row', async () => {
    const onSignOut = vi.fn();
    render(<Menu onSignOut={onSignOut} />);
    await userEvent.click(within(await open()).getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe('while the profile loads, or when it can’t be read', () => {
  it.each([
    ['loading', 'Loading your profile'],
    ['failed', 'Your profile didn’t load'],
  ] as const)('%s: says so, holds their page’s row back, and still signs out', async (state, words) => {
    const onSignOut = vi.fn();
    render(<Menu viewer={{ state }} onSignOut={onSignOut} />);
    const m = await open();
    expect(within(m).getByText(words)).toBeInTheDocument();
    const page = within(m).getByRole('menuitem', { name: 'Your page in People' });
    expect(page).toHaveAttribute('aria-disabled', 'true');
    expect(page).not.toHaveAttribute('href');
    // The theme still works, and so does Sign out.
    expect(themes(m)).toBeInTheDocument();
    await userEvent.click(within(m).getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe('the keyboard', () => {
  it('opens from the trigger, walks its rows, and Esc gives focus back', async () => {
    const onSignOut = vi.fn();
    render(<Menu onSignOut={onSignOut} />);
    trigger().focus();
    await userEvent.keyboard('{Enter}');
    const m = menu();
    await waitFor(() => expect(m).toContainElement(document.activeElement as HTMLElement));
    // Opened from the keyboard, the first row is lit; ↓ walks to the next (the theme is Tab's).
    const row = (name: string | RegExp) => within(m).getByRole('menuitem', { name });
    await waitFor(() => expect(row('Your page in People')).toHaveAttribute('data-highlighted'));
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(row('Sign out')).toHaveAttribute('data-highlighted'));
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(row('Your page in People')).toHaveAttribute('data-highlighted'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger()).toHaveFocus();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('chooses Sign out with Enter', async () => {
    const onSignOut = vi.fn();
    render(<Menu onSignOut={onSignOut} />);
    trigger().focus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(menu()).toBeInTheDocument());
    await userEvent.keyboard('{End}{Enter}');
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
