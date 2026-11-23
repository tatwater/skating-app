/**
 * The console's gate, surface and rail (B01). A UX boundary: every Convex function behind a page
 * gates itself; what this pins is that nobody sees chrome they can't use, and that the rail draws
 * only what the viewer's role holds (D217).
 */

import { type Capability, canUse, seasonOf } from '@skating/core';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/admin',
  navigate: vi.fn(),
  role: undefined as 'member' | 'moderator' | 'admin' | undefined,
  loading: false,
  /** What each read answers, by function name; the viewer's own profile when none is set. */
  results: new Map<string, unknown>(),
  asked: [] as string[],
  beats: 0,
  /** The pick store each drawing of the page found above it. */
  stores: [] as unknown[],
  pickStoreModule: null as unknown,
  /** What a read through the console's read layer answers, by function name and its args. */
  answer: null as null | ((name: string, args: unknown) => unknown),
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
  Outlet: () => {
    const { PickStoreContext } = mocks.pickStoreModule as typeof import('../body/tabs/latestPick');
    mocks.stores.push(useContext(PickStoreContext));
    return <p>the page</p>;
  },
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
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === 'skip') return undefined;
      const name = getFunctionName(ref);
      mocks.asked.push(name);
      // As Convex's `useQuery` does, a failed read throws into the render.
      if (mocks.answer !== null && mocks.results.has(name) === false) {
        const answer = mocks.answer(name, args);
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return answer;
      }
      return mocks.results.has(name) ? mocks.results.get(name) : { displayName: 'Teagan Atwater' };
    },
    // The console's read layer (`useConsoleReadSet`) reads through `useQueries`, which hands a
    // failure back as an `Error` rather than throwing it.
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          mocks.asked.push(name);
          return [key, mocks.answer !== null ? mocks.answer(name, args) : mocks.results.get(name)];
        }),
      ),
    useMutation: () => () => {
      mocks.beats++;
      return Promise.resolve(null);
    },
    useConvex: () => ({ query: vi.fn(), mutation: vi.fn() }),
  };
});
// The viewer's menu signs out through Clerk (its own tests drive that); here it only has to draw.
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => ({ signOut: vi.fn() }) }));
vi.mock('../../../lib/useConnection', () => ({ useConnection: () => ({ status: 'online' }) }));
vi.mock('../../Splash', () => ({ Splash: () => <p>splash</p> }));
vi.mock('./ConsolePalette', () => ({
  ConsolePalette: ({ open }: { open: boolean }) => (open ? <p>palette open</p> : null),
}));

mocks.pickStoreModule = await import('../body/tabs/latestPick');
const { ConsoleLayout } = await import('./ConsoleLayout');
const { modKey } = await import('../../../lib/keys');

beforeEach(() => {
  mocks.results = new Map<string, unknown>([
    ['seasonWatch:tape', undefined],
    ['console:colleagues', []],
    ['inbox:lanes', undefined],
  ]);
  mocks.asked = [];
  mocks.answer = null;
  mocks.beats = 0;
  mocks.stores = [];
  mocks.pathname = '/admin';
  mocks.navigate = vi.fn();
  mocks.role = 'moderator';
  mocks.loading = false;
  document.documentElement.removeAttribute('data-surface');
});

const rail = () => screen.getByRole('navigation', { name: 'Modes' });

/** `inbox.lanes` with nineteen open. */
const LANES_19 = {
  lanes: [],
  allOpen: 19,
  decided: 0,
  today: { count: 0, capped: false },
  medianFiledAt: null,
  pending: false,
};

describe('the queues’ owners outlive the splash', () => {
  it('a role reload that shows the splash keeps the same pick store above the page', () => {
    const { rerender } = render(<ConsoleLayout />);
    mocks.loading = true;
    rerender(<ConsoleLayout />);
    expect(screen.getByText('splash')).toBeInTheDocument();
    mocks.loading = false;
    rerender(<ConsoleLayout />);
    const found = mocks.stores.filter((s) => s !== null);
    expect(found.length).toBeGreaterThan(1);
    expect(new Set(found).size).toBe(1);
  });
});

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

  it('lists People after Bodies, current on the list and on a person’s page', () => {
    mocks.pathname = '/admin/people/k17abc';
    render(<ConsoleLayout />);
    const names = within(rail())
      .getAllByRole('link')
      .map((l) => l.textContent ?? '');
    expect(names.findIndex((n) => n.includes('People'))).toBe(
      names.findIndex((n) => n.includes('Bodies')) + 1,
    );
    const people = within(rail()).getByRole('link', { name: /People/ });
    expect(people).toHaveAttribute('href', '/admin/people');
    expect(people).toHaveAttribute('aria-current', 'page');
  });

  it('lists the Inbox second, current on its page, with an amber count of what waits', () => {
    mocks.pathname = '/admin/inbox';
    mocks.results.set('inbox:lanes', {
      lanes: [],
      allOpen: 19,
      decided: 0,
      today: { count: 0, capped: false },
      medianFiledAt: null,
      pending: false,
    });
    render(<ConsoleLayout />);
    const names = within(rail())
      .getAllByRole('link')
      .map((l) => l.textContent ?? '');
    expect(names.findIndex((n) => n.includes('Inbox'))).toBe(1);
    const inbox = within(rail()).getByRole('link', { name: /Inbox/ });
    expect(inbox).toHaveAttribute('href', '/admin/inbox');
    expect(inbox).toHaveAttribute('aria-current', 'page');
    expect(inbox.textContent).toContain('19');
  });

  it('draws no Inbox count while nothing waits or the items are being prepared', () => {
    for (const answer of [
      {
        lanes: [],
        allOpen: 0,
        decided: 0,
        today: { count: 0, capped: false },
        medianFiledAt: null,
        pending: false,
      },
      {
        lanes: [],
        allOpen: 4,
        decided: 0,
        today: { count: 0, capped: false },
        medianFiledAt: null,
        pending: true,
      },
    ]) {
      mocks.results.set('inbox:lanes', answer);
      const { unmount } = render(<ConsoleLayout />);
      const inbox = within(rail()).getByRole('link', { name: /Inbox/ });
      expect(inbox.textContent).not.toMatch(/\d/);
      unmount();
    }
  });

  it('holds the Inbox count through the minute’s new subscription — it never blinks out', () => {
    vi.useFakeTimers();
    try {
      mocks.pathname = '/admin/inbox';
      mocks.results.delete('inbox:lanes');
      const first = new Map<string, number>();
      // Each minute's args are a new subscription: Convex answers nothing until it lands.
      mocks.answer = (name, args) => {
        if (name !== 'inbox:lanes') return mocks.results.get(name);
        const now = (args as { now: number }).now;
        if (first.size === 0) first.set('now', now);
        return now === first.get('now') ? { ...LANES_19 } : undefined;
      };
      render(<ConsoleLayout />);
      const count = () => within(rail()).getByRole('link', { name: /Inbox/ }).textContent;
      expect(count()).toContain('19');
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(count()).toContain('19');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed lanes read takes down the count and nothing else', () => {
    mocks.pathname = '/admin/inbox';
    mocks.results.delete('inbox:lanes');
    mocks.answer = (name) =>
      name === 'inbox:lanes' ? new Error('Too many bytes read') : mocks.results.get(name);
    render(<ConsoleLayout />);
    expect(screen.getByText('the page')).toBeInTheDocument();
    const inbox = within(rail()).getByRole('link', { name: /Inbox/ });
    expect(inbox.textContent).not.toMatch(/\d/);
  });

  it('after a failure, no held number comes back as current', () => {
    mocks.pathname = '/admin/inbox';
    let fail = false;
    mocks.results.delete('inbox:lanes');
    mocks.answer = (name) =>
      name === 'inbox:lanes'
        ? fail
          ? new Error('down')
          : { ...LANES_19 }
        : mocks.results.get(name);
    const { rerender } = render(<ConsoleLayout />);
    expect(within(rail()).getByRole('link', { name: /Inbox/ }).textContent).toContain('19');
    fail = true;
    rerender(<ConsoleLayout />);
    expect(within(rail()).getByRole('link', { name: /Inbox/ }).textContent).not.toMatch(/\d/);
  });

  it('shows a moderator only the old pages a moderator can use', async () => {
    render(<ConsoleLayout />);
    await userEvent.click(within(rail()).getByRole('button', { name: /Legacy/ }));
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toContain('Water bodies');
    expect(items).toContain('Ice calibration');
    expect(items).not.toContain('Flags');
    for (const adminOnly of ['Seasons', 'Support', 'Tuning', 'Imports']) {
      expect(items).not.toContain(adminOnly);
    }
  });

  it('shows an admin every old page, and goes to the one chosen', async () => {
    mocks.role = 'admin';
    render(<ConsoleLayout />);
    await userEvent.click(within(rail()).getByRole('button', { name: /Legacy/ }));
    const menu = await screen.findByRole('menu');
    // Every old page still standing: Users left the menu when People landed, Requests when the
    // Inbox's request handlers did, Support when its ticket handler did, Flags when the photo
    // handler did.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(11);
    expect(within(menu).queryByRole('menuitem', { name: 'Users' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Requests' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Support' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Flags' })).toBeNull();
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

  it('opens the app in a new tab, and the viewer’s menu at the foot goes to their own page', async () => {
    mocks.results.set('profiles:current', { _id: 'p_quinn', displayName: 'Quinn Ellery' });
    render(<ConsoleLayout />);
    const app = screen.getByRole('link', { name: /App/ });
    expect(app).toHaveAttribute('href', '/');
    expect(app).toHaveAttribute('target', '_blank');
    const foot = screen.getByRole('button', { name: /^Your account/ });
    expect(foot.closest('[data-slot="shell-rail-foot"]')).not.toBeNull();
    await userEvent.click(foot);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Quinn Ellery')).toBeInTheDocument();
    // The router's link, by the profile id the gate's read carries.
    expect(within(menu).getByRole('menuitem', { name: 'Your page in People' })).toHaveAttribute(
      'href',
      '/admin/people/p_quinn',
    );
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

describe('the top bar and presence', () => {
  it('draws the watch’s record on the tape, and colleagues’ faces — never the viewer', () => {
    mocks.results.set('seasonWatch:tape', {
      season: seasonOf(Date.now()),
      countsFrom: '2026-10-01',
      watch: null,
      imageryNudgeOn: null,
      imageryNudgeLowC: null,
      winterFrom: null,
      lastWinterFirst: null,
    });
    mocks.results.set('console:colleagues', [
      { id: 'sarah', name: 'Sarah Berman', src: null, present: true },
      { id: 'me', name: 'Teagan Atwater', src: null, present: true },
    ]);
    render(<ConsoleLayout />);
    expect(mocks.asked).toContain('seasonWatch:tape');
    expect(mocks.asked).toContain('console:colleagues');
    expect(screen.getByLabelText('Sarah Berman')).toBeInTheDocument();
    // The viewer is never among the faces (the rail's foot names them).
    expect(
      screen
        .queryAllByLabelText('Teagan Atwater')
        .filter((el) => el.closest('[data-slot="shell-top"]')),
    ).toEqual([]);
  });

  it('sends the heartbeat for staff, and asks a member for nothing of presence', async () => {
    render(<ConsoleLayout />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.beats).toBe(1);
    mocks.role = 'member';
    mocks.beats = 0;
    mocks.asked = [];
    render(<ConsoleLayout />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.beats).toBe(0);
    expect(mocks.asked).not.toContain('console:colleagues');
    expect(mocks.asked).not.toContain('seasonWatch:tape');
  });
});
