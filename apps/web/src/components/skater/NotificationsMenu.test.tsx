import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { convexReact, fakes, resetFakes, router } from './testMocks';

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => router);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { NotificationsMenu } from './NotificationsMenu';

const now = Date.now();
const body = { id: 'w1', name: 'Mascoma Lake' };
const unreadHazard = {
  id: 'n1',
  createdAt: now - 60 * 60_000,
  type: 'hazard_confirmation',
  target: { id: 'h1', available: true },
  body,
  phase: 'confirmed',
};
const readFlag = {
  id: 'n2',
  createdAt: now - 3 * 86_400_000,
  readAt: now - 1000,
  type: 'content_flag_resolved',
  resolution: 'dismissed',
};

// jsdom has no Web Animations; the kit Skeleton's shimmer asks for one.
beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
});

beforeEach(() => {
  resetFakes();
  useChromeStore.setState({ overlay: null });
});
afterEach(() => useChromeStore.setState({ overlay: null }));

describe('NotificationsMenu', () => {
  it('shows the dot for unread, and subscribes to the list only while open', () => {
    fakes.queries.set('notifications:unreadCount', 3);
    render(<NotificationsMenu />);
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(fakes.paginatedArgs.every((a) => a === 'skip')).toBe(true);
  });

  it('records the opening with the unread bucket, then marks what’s there read once', async () => {
    fakes.queries.set('notifications:unreadCount', 1);
    fakes.paginated = { results: [unreadHazard, readFlag], status: 'Exhausted', loadMore: vi.fn() };
    const markRead = vi.fn().mockResolvedValue(['n1']);
    fakes.mutations.set('notifications:markRead', markRead);
    render(<NotificationsMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(fakes.capture).toHaveBeenCalledWith('notifications_opened', { unread_bucket: '1-3' });
    expect(useChromeStore.getState().overlay).toBe('notifications');
    await screen.findByText('New');
    expect(screen.getByText('Earlier')).toBeInTheDocument();
    await waitFor(() => expect(markRead).toHaveBeenCalledOnce());
    expect(markRead).toHaveBeenCalledWith({});
    // The stamped row keeps its wash for the rest of the visit.
    const row = screen.getByText(/still there/).closest('[data-slot="notification-row"]');
    expect(row).toHaveAttribute('data-unread');
  });

  it('waits for the token and the first page before marking', () => {
    fakes.isAuthenticated = false;
    fakes.paginated = { results: [], status: 'Exhausted', loadMore: vi.fn() };
    const markRead = vi.fn().mockResolvedValue([]);
    fakes.mutations.set('notifications:markRead', markRead);
    act(() => useChromeStore.getState().setOverlay('notifications'));
    render(<NotificationsMenu />);
    expect(markRead).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });

  it('opens a row, records its kind, and closes', async () => {
    fakes.paginated = { results: [unreadHazard], status: 'Exhausted', loadMore: vi.fn() };
    fakes.mutations.set('notifications:markRead', vi.fn().mockRejectedValue(new Error('offline')));
    act(() => useChromeStore.getState().setOverlay('notifications'));
    render(<NotificationsMenu />);
    fireEvent.click(await screen.findByText(/still there/));
    expect(fakes.capture).toHaveBeenCalledWith('notification_opened', {
      kind: 'hazard_confirmation',
    });
    expect(fakes.push).toHaveBeenCalledWith('/hazard/h1', { panelSource: 'notification' });
    expect(useChromeStore.getState().overlay).toBeNull();
  });

  it('loads more on request, and the gear goes to the notification settings', async () => {
    const loadMore = vi.fn();
    fakes.paginated = { results: [readFlag], status: 'CanLoadMore', loadMore };
    fakes.mutations.set('notifications:markRead', vi.fn().mockResolvedValue([]));
    act(() => useChromeStore.getState().setOverlay('notifications'));
    render(<NotificationsMenu />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledWith(20);
    fireEvent.click(screen.getByRole('link', { name: 'Notification settings' }));
    expect(fakes.push).toHaveBeenCalledWith('/settings/notifications');
    expect(useChromeStore.getState().overlay).toBeNull();
  });

  it('shows the loading rows while the first page is on its way', () => {
    act(() => useChromeStore.getState().setOverlay('notifications'));
    render(<NotificationsMenu />);
    expect(screen.getByRole('status', { name: 'Loading notifications' })).toBeInTheDocument();
  });
});
