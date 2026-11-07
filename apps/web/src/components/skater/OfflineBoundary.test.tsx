import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakes, resetFakes, router } from './testMocks';

const conn = vi.hoisted(() => ({
  value: {
    status: 'connecting',
    firstLoad: true,
    lastConnectedAt: null as number | null,
    lastTriedAt: null as number | null,
  },
  online: true,
  retry: vi.fn(),
}));
vi.mock('@/lib/useConnection', () => ({
  useConnection: () => conn.value,
  useBrowserOnline: () => conn.online,
  retryConnection: conn.retry,
}));
vi.mock('@tanstack/react-router', () => router);
vi.mock('./RegionBackdrop', () => ({ RegionBackdrop: () => <img alt="" data-testid="region" /> }));

import { FirstLoadHold, FirstLoadSplash, OfflineOverPage } from './OfflineBoundary';

beforeEach(() => {
  resetFakes();
  conn.retry.mockClear();
  conn.value = { status: 'connecting', firstLoad: true, lastConnectedAt: null, lastTriedAt: null };
});

describe('FirstLoadSplash', () => {
  it('holds on the splash while the app starts', () => {
    render(<FirstLoadSplash />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeInTheDocument();
  });

  it('turns into the offline screen when a first load can’t reach the server', () => {
    conn.value = { status: 'offline', firstLoad: true, lastConnectedAt: null, lastTriedAt: 1 };
    render(<FirstLoadSplash />);
    expect(screen.getByRole('heading', { name: 'You’re offline' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(conn.retry).toHaveBeenCalledWith(true);
  });
});

/**
 * The escalation belongs to the hold, not to the splash: from the second load of a browser session
 * the gate holds on `BootScreen`, and a skeleton that never becomes the offline screen is a page
 * that silently never loads.
 */
describe('FirstLoadHold', () => {
  it('shows the hold it is given while the app starts', () => {
    render(
      <FirstLoadHold>
        <p>skeletons</p>
      </FirstLoadHold>,
    );
    expect(screen.getByText('skeletons')).toBeInTheDocument();
  });

  it('turns any hold into the offline screen when a first load can’t reach the server', () => {
    conn.value = { status: 'offline', firstLoad: true, lastConnectedAt: null, lastTriedAt: 1 };
    render(
      <FirstLoadHold>
        <p>skeletons</p>
      </FirstLoadHold>,
    );
    expect(screen.getByRole('heading', { name: 'You’re offline' })).toBeInTheDocument();
    expect(screen.queryByText('skeletons')).not.toBeInTheDocument();
  });
});

describe('OfflineOverPage', () => {
  it('draws nothing while connected or on a first load', () => {
    const { container, rerender } = render(<OfflineOverPage />);
    expect(container).toBeEmptyDOMElement();
    conn.value = { status: 'offline', firstLoad: true, lastConnectedAt: null, lastTriedAt: null };
    rerender(<OfflineOverPage />);
    expect(container).toBeEmptyDOMElement();
  });

  it('centers the plate over the map on Explore and over the page elsewhere', () => {
    conn.value = {
      status: 'offline',
      firstLoad: false,
      lastConnectedAt: Date.now(),
      lastTriedAt: null,
    };
    fakes.location = { pathname: '/water/w1', searchStr: '' };
    const { rerender } = render(<OfflineOverPage />);
    expect(screen.getByRole('status')).toHaveClass(
      'left-[calc(var(--size-sidebar)+(100%-var(--size-sidebar))/2)]',
    );
    fakes.location = { pathname: '/latest', searchStr: '' };
    rerender(<OfflineOverPage />);
    expect(screen.getByRole('status')).toHaveClass('left-1/2');
    conn.online = false;
    rerender(<OfflineOverPage />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(conn.retry).toHaveBeenCalledWith(false);
  });
});
