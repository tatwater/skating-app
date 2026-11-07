import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posthogOptions, resetPageviewDedupe } from '../lib/posthogOptions';

const mocks = vi.hoisted(() => {
  const register = vi.fn();
  const subscribers: Array<() => void> = [];
  const router = {
    state: { matches: [{ routeId: '__root__' }, { routeId: '/_map/water/$id' }] },
    subscribe: vi.fn((_event: string, fn: () => void) => {
      subscribers.push(fn);
      return () => {
        subscribers.length = 0;
      };
    }),
    matchRoutes: vi.fn((pathname: string) =>
      pathname.startsWith('/admin')
        ? [{ routeId: '__root__' }, { routeId: '/admin/users' }]
        : [{ routeId: '__root__' }, { routeId: '/_map/water/$id' }],
    ),
  };
  return { register, router, subscribers, configured: { posthog: true } };
});

vi.mock('../lib/env', () => ({
  env: { posthogKey: 'phc_test', posthogHost: 'https://us.i.posthog.com' },
  isConfigured: mocks.configured,
}));
vi.mock('@posthog/react', () => ({ usePostHog: () => ({ register: mocks.register }) }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => mocks.router }));

import { RouteAnalytics } from './RouteAnalytics';

beforeEach(() => {
  mocks.register.mockClear();
  mocks.subscribers.length = 0;
  mocks.configured.posthog = true;
  resetPageviewDedupe();
});

afterEach(() => {
  // A failing test must not leave a resolver behind for the posthogOptions suites.
  resetPageviewDedupe();
});

describe('RouteAnalytics', () => {
  it('registers route_id and surface at mount and again on every resolution', () => {
    render(<RouteAnalytics />);
    expect(mocks.register).toHaveBeenCalledWith({
      route_id: '/_map/water/$id',
      surface: 'skater',
    });

    mocks.router.state.matches = [{ routeId: '__root__' }, { routeId: '/admin/users' }];
    for (const fn of mocks.subscribers) fn();
    expect(mocks.register).toHaveBeenLastCalledWith({
      route_id: '/admin/users',
      surface: 'admin',
    });
  });

  it('installs the pageview resolver and removes it on unmount', () => {
    const pageview = (url: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
      posthogOptions.before_send({ event: '$pageview', properties: { $current_url: url } } as any);

    const { unmount } = render(<RouteAnalytics />);
    expect(pageview('https://gli.app/admin/users')?.properties).toMatchObject({
      route_id: '/admin/users',
      surface: 'admin',
    });

    unmount();
    resetPageviewDedupe();
    expect(pageview('https://gli.app/water/b')?.properties?.route_id).toBeUndefined();
  });

  it('does nothing when PostHog is unconfigured', () => {
    mocks.configured.posthog = false;
    render(<RouteAnalytics />);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.router.subscribe).not.toHaveBeenCalled();
  });
});
