/**
 * The console's gate, surface and rail (B01). A UX boundary: every Convex function behind a page
 * gates itself; what this pins is that nobody sees chrome they can't use, and that the rail draws
 * only what the viewer's role holds (D217).
 */

import { type Capability, canUse } from '@skating/core';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/admin',
  navigate: vi.fn(),
  role: undefined as 'member' | 'moderator' | 'admin' | undefined,
  loading: false,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <p>the page</p>,
}));
vi.mock('../../../lib/useRole', () => ({
  useRole: () => ({
    role: mocks.role,
    userId: 'me',
    isModerator: mocks.role === 'moderator' || mocks.role === 'admin',
    isAdmin: mocks.role === 'admin',
    isLoading: mocks.loading,
    can: (c: Capability) => canUse(mocks.role, false, c, {}),
  }),
}));
vi.mock('convex/react', () => ({
  useQuery: () => ({ displayName: 'Teagan Atwater' }),
  useConvex: () => ({ query: vi.fn(), mutation: vi.fn() }),
}));
vi.mock('../../../lib/useConnection', () => ({ useConnection: () => ({ status: 'online' }) }));
vi.mock('../../Splash', () => ({ Splash: () => <p>splash</p> }));
vi.mock('./ConsolePalette', () => ({
  ConsolePalette: ({ open }: { open: boolean }) => (open ? <p>palette open</p> : null),
}));

const { ConsoleLayout } = await import('./ConsoleLayout');
const { modKey } = await import('../../../lib/keys');

beforeEach(() => {
  mocks.pathname = '/admin';
  mocks.navigate = vi.fn();
  mocks.role = 'moderator';
  mocks.loading = false;
  document.documentElement.removeAttribute('data-surface');
});

const rail = () => screen.getByRole('navigation', { name: 'Modes' });

describe('the gate', () => {
  it('holds on the splash while the role resolves, guessing nothing', () => {
    mocks.loading = true;
    mocks.role = undefined;
    render(<ConsoleLayout />);
    expect(screen.getByText('splash')).toBeInTheDocument();
    expect(screen.queryByText('the page')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('sends a member home without drawing any console chrome', () => {
    mocks.role = 'member';
    render(<ConsoleLayout />);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('the page')).toBeNull();
  });

  it('sends a member home from a console page that belongs to no mode yet', () => {
    mocks.role = 'member';
    mocks.pathname = '/admin/body/b1';
    render(<ConsoleLayout />);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(screen.queryByText('the page')).toBeNull();
  });

  it('lets a moderator in, with the page in the frame', () => {
    render(<ConsoleLayout />);
    expect(screen.getByText('the page')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe('the surface', () => {
  it('states the console surface while mounted, and gives the old pages theirs back', () => {
    const { unmount } = render(<ConsoleLayout />);
    expect(document.documentElement.getAttribute('data-surface')).toBe('admin');
    unmount();
    expect(document.documentElement.hasAttribute('data-surface')).toBe(false);
  });

  it('never leaves the console surface behind, even when the init script stated it', () => {
    document.documentElement.setAttribute('data-surface', 'admin');
    const { unmount } = render(<ConsoleLayout />);
    unmount();
    expect(document.documentElement.hasAttribute('data-surface')).toBe(false);
  });

  it('gives back a skater page’s surface it was opened over', () => {
    document.documentElement.setAttribute('data-surface', 'skater');
    const { unmount } = render(<ConsoleLayout />);
    expect(document.documentElement.getAttribute('data-surface')).toBe('admin');
    unmount();
    expect(document.documentElement.getAttribute('data-surface')).toBe('skater');
  });
});

describe('the rail', () => {
  it('lists the Overview, current at /admin, then Legacy', () => {
    render(<ConsoleLayout />);
    const overview = within(rail()).getByRole('link', { name: /Overview/ });
    expect(overview).toHaveAttribute('href', '/admin');
    expect(overview).toHaveAttribute('aria-current', 'page');
    expect(within(rail()).getByRole('button', { name: /Legacy/ })).toBeInTheDocument();
  });

  it('shows a moderator only the old pages a moderator can use', async () => {
    render(<ConsoleLayout />);
    await userEvent.click(within(rail()).getByRole('button', { name: /Legacy/ }));
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toContain('Flags');
    expect(items).toContain('Ice calibration');
    for (const adminOnly of ['Seasons', 'Support', 'Tuning', 'Imports']) {
      expect(items).not.toContain(adminOnly);
    }
  });

  it('shows an admin every old page, and goes to the one chosen', async () => {
    mocks.role = 'admin';
    render(<ConsoleLayout />);
    await userEvent.click(within(rail()).getByRole('button', { name: /Legacy/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(15);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Imports' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/imports' });
  });

  it('lists the old dashboard first, at its new home', async () => {
    render(<ConsoleLayout />);
    await userEvent.click(within(rail()).getByRole('button', { name: /Legacy/ }));
    const menu = await screen.findByRole('menu');
    const first = within(menu).getAllByRole('menuitem')[0];
    expect(first).toHaveTextContent('Dashboard');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Dashboard' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/dashboard' });
  });

  it('opens the app in a new tab and names the viewer at the foot', () => {
    render(<ConsoleLayout />);
    const app = screen.getByRole('link', { name: /App/ });
    expect(app).toHaveAttribute('href', '/');
    expect(app).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('img', { name: 'Teagan Atwater' })).toBeInTheDocument();
  });
});

describe('the top and status bars', () => {
  it('opens the palette from the search, and says the connection is live', async () => {
    render(<ConsoleLayout />);
    expect(screen.queryByText('palette open')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Jump to a body or a person/ }));
    expect(screen.getByText('palette open')).toBeInTheDocument();
    expect(screen.getByText('Convex live')).toBeInTheDocument();
  });

  it('draws the season tape over this winter', () => {
    vi.useFakeTimers({ now: new Date('2026-10-14T16:00:00Z'), toFake: ['Date'] });
    try {
      render(<ConsoleLayout />);
      expect(screen.getByText('Winter 2026–27')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens and closes the palette with ⌘K from anywhere', async () => {
    const mod = modKey();
    render(<ConsoleLayout />);
    await act(async () => {
      await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    });
    expect(await screen.findByText('palette open')).toBeInTheDocument();
    await act(async () => {
      await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    });
    expect(screen.queryByText('palette open')).toBeNull();
  });
});
