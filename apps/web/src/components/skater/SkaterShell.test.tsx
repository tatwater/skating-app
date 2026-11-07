import { render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from './testMocks';

vi.mock('convex/react', () => convexReact);
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => fakes.auth }));
vi.mock('@skating/core', async (load) => ({
  ...(await load<typeof import('@skating/core')>()),
  deviceTimeZone: () => 'America/New_York',
}));
vi.mock('./GlobalSearch', () => ({ useSearchOwnerBinding: vi.fn() }));
vi.mock('./SkaterTopBar', () => ({ SkaterTopBar: () => <header>top bar</header> }));
vi.mock('./OfflineBoundary', () => ({ OfflineOverPage: () => <div>offline plate</div> }));
vi.mock('./NotFoundScreen', () => ({ NotFoundScreen: () => <p>not found</p> }));

import { NotFoundRoute, SkaterShell, useAppOpenSync } from './SkaterShell';

beforeEach(() => {
  resetFakes();
  document.documentElement.removeAttribute('data-surface');
});

describe('SkaterShell', () => {
  it('frames the page under the top bar on the skater surface, and hands the surface back', () => {
    document.documentElement.setAttribute('data-surface', 'admin');
    const { unmount } = render(
      <SkaterShell>
        <p>page</p>
      </SkaterShell>,
    );
    expect(document.documentElement).toHaveAttribute('data-surface', 'skater');
    const shell = screen.getByText('page').closest('[data-slot="skater-shell"]');
    expect(shell).toHaveAttribute('data-surface', 'skater');
    expect(screen.getByText('top bar')).toBeInTheDocument();
    expect(screen.getByText('offline plate')).toBeInTheDocument();
    unmount();
    expect(document.documentElement).toHaveAttribute('data-surface', 'admin');
  });

  it('removes the attribute it added when there was none before', () => {
    const { unmount } = render(<SkaterShell>x</SkaterShell>);
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-surface');
  });
});

describe('useAppOpenSync', () => {
  it('syncs the zone when it differs and the Clerk mirrors once the profile exists', () => {
    const { rerender } = renderHook(() => useAppOpenSync());
    expect(fakes.mutations.get('profiles:setTimezone')).not.toHaveBeenCalled();
    fakes.queries.set('profiles:current', { _id: 'p1', timezone: 'America/Chicago' });
    rerender();
    expect(fakes.mutations.get('profiles:setTimezone')).toHaveBeenCalledWith({
      timezone: 'America/New_York',
    });
    expect(fakes.mutations.get('profiles:syncFromClerk')).toHaveBeenCalledWith({});
  });

  it('writes nothing when the zone already matches, and swallows a failure', () => {
    fakes.mutations.set('profiles:syncFromClerk', vi.fn().mockRejectedValue(new Error('offline')));
    fakes.queries.set('profiles:current', { _id: 'p1', timezone: 'America/New_York' });
    renderHook(() => useAppOpenSync());
    expect(fakes.mutations.get('profiles:setTimezone')).not.toHaveBeenCalled();
  });
});

describe('NotFoundRoute', () => {
  it('sits under the top bar when signed in, bare when not', () => {
    const { unmount } = render(<NotFoundRoute />);
    expect(screen.getByText('top bar')).toBeInTheDocument();
    unmount();
    fakes.auth = { isLoaded: true, isSignedIn: false, userId: null };
    render(<NotFoundRoute />);
    expect(screen.getByText('not found')).toBeInTheDocument();
    expect(screen.queryByText('top bar')).toBeNull();
  });
});
