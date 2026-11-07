import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '../stores/chromeStore';

const m = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  signedIn: true,
  stats: undefined as unknown,
  settings: vi.fn(),
  profile: vi.fn(),
}));

vi.mock('@tanstack/react-router', async (actual) => ({
  ...(await actual<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ history: { push: m.push, replace: m.replace } }),
  Outlet: () => <span data-testid="outlet" />,
}));
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => ({ isSignedIn: m.signedIn }) }));
vi.mock('convex/react', () => ({ useQuery: () => m.stats }));
vi.mock('../components/skater/SkaterShell', () => ({
  SkaterShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('../components/skater/settings/SettingsPage', () => ({
  SettingsPage: (props: Record<string, unknown>) => {
    m.settings(props);
    return null;
  },
}));
vi.mock('../components/skater/profile/ProfilePage', () => ({
  ProfilePage: (props: Record<string, unknown>) => {
    m.profile(props);
    return null;
  },
}));

import { Route as SkaterRoute } from './_skater';
import { Route as SettingsSectionRoute } from './_skater.settings.$section';
import { Route as SettingsIndexRoute } from './_skater.settings.index';
import { Route as ProfileRoute } from './_skater.u.$username';
import { Route as AboutRoute } from './about';
import { Route as NotificationsRoute } from './notifications';

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as ComponentType;

beforeEach(() => {
  vi.clearAllMocks();
  m.signedIn = true;
  m.stats = undefined;
  useChromeStore.setState({ overlay: null });
});

describe('/settings', () => {
  it('lands on Account', () => {
    const before = SettingsIndexRoute.options.beforeLoad as () => void;
    let thrown: unknown;
    try {
      before();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      options: { to: '/settings/$section', params: { section: 'account' }, replace: true },
    });
  });

  it('validates the section in the path: a real one parses, anything else is the 404', () => {
    const params = SettingsSectionRoute.options.params as {
      parse: (raw: Record<string, string>) => unknown;
      stringify: (p: { section: string }) => unknown;
    };
    expect(params.parse({ section: 'home' })).toEqual({ section: 'home' });
    expect(params.stringify({ section: 'home' })).toEqual({ section: 'home' });
    let thrown: unknown;
    try {
      params.parse({ section: 'billing' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ isNotFound: true });
  });

  it('reads the home view from the search, and navigates through the router', () => {
    const Page = component(SettingsSectionRoute);
    const params = vi.spyOn(SettingsSectionRoute, 'useParams');
    const search = vi.spyOn(SettingsSectionRoute, 'useSearch');
    const cases: [string, Record<string, boolean>, string][] = [
      ['home', { edit: true }, 'edit'],
      ['home', { travel: true }, 'travel'],
      ['home', {}, 'summary'],
      ['account', { edit: true }, 'summary'],
    ];
    for (const [section, s, view] of cases) {
      params.mockReturnValue({ section } as never);
      search.mockReturnValue(s as never);
      const { unmount } = render(<Page />);
      expect(m.settings).toHaveBeenLastCalledWith(
        expect.objectContaining({ section, homeView: view }),
      );
      unmount();
    }
    const { onNavigate } = (m.settings.mock.lastCall ?? [])[0] as {
      onNavigate: (h: string, o?: { replace?: boolean }) => void;
    };
    onNavigate('/settings/data');
    onNavigate('/settings/home', { replace: true });
    expect(m.push).toHaveBeenCalledWith('/settings/data');
    expect(m.replace).toHaveBeenCalledWith('/settings/home');
  });
});

describe('/u/$username', () => {
  it('hands the handle to the profile page and navigates through the router', () => {
    vi.spyOn(ProfileRoute, 'useParams').mockReturnValue({ username: 'placasse' } as never);
    const Page = component(ProfileRoute);
    render(<Page />);
    const props = m.profile.mock.lastCall?.[0] as {
      username: string;
      onNavigate: (h: string) => void;
    };
    expect(props.username).toBe('placasse');
    props.onNavigate('/latest');
    expect(m.push).toHaveBeenCalledWith('/latest');
  });
});

describe('the skater layout', () => {
  it('validates the root search and mounts the shell', () => {
    expect(SkaterRoute.options.validateSearch).toBeDefined();
    const Layout = component(SkaterRoute);
    render(<Layout />);
    expect(screen.getByTestId('shell')).toContainElement(screen.getByTestId('outlet'));
  });
});

describe('/notifications', () => {
  it('lands on the map with the bell open', () => {
    const Page = component(NotificationsRoute);
    act(() => {
      render(<Page />);
    });
    expect(useChromeStore.getState().overlay).toBe('notifications');
    expect(m.replace).toHaveBeenCalledWith('/');
  });
});

describe('/about', () => {
  it('signed in: under the shell, the counts once they load, and Contact support', () => {
    m.stats = [
      { state: 'NH', bodiesScanned: 2614, bodiesActive: 412 },
      { state: 'VT', bodiesScanned: 1873 },
    ];
    const Page = component(AboutRoute);
    render(<Page />);
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(screen.getByText('New Hampshire')).toBeInTheDocument();
    expect(screen.getByText('2,614')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: /opens in a new tab/ })) {
      expect(link).toHaveAttribute('target', '_blank');
    }
    fireEvent.click(screen.getByRole('link', { name: 'Contact support' }));
    expect(m.push).toHaveBeenCalledWith('/settings/support');
  });

  it('signed out: bare, the way in, no help block, no counts until they load', () => {
    m.signedIn = false;
    const Page = component(AboutRoute);
    render(<Page />);
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(screen.queryByText('The map')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Contact support' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(m.push).toHaveBeenCalledWith('/sign-in');
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }));
    expect(m.push).toHaveBeenCalledWith('/sign-up');
  });
});

describe('the settings layout', () => {
  it('only passes its sections through', async () => {
    const { Route } = await import('./_skater.settings');
    const Layout = component(Route);
    render(<Layout />);
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });
});
