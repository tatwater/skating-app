import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settled: true,
  loadRouteChunk: vi.fn((_route: { id: string }) => Promise.resolve()),
  routesById: {
    __root__: { id: '__root__' },
    '/_skater/': { id: '/_skater/' },
    '/_skater/latest': { id: '/_skater/latest' },
    '/about': { id: '/about' },
    '/admin': { id: '/admin' },
    '/admin/water/$id': { id: '/admin/water/$id' },
  } as Record<string, { id: string }>,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ routesById: mocks.routesById, loadRouteChunk: mocks.loadRouteChunk }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ status: mocks.settled ? 'idle' : 'pending', isLoading: !mocks.settled }),
}));

import { PREFETCH_FALLBACK_MS, RoutePrefetch } from './RoutePrefetch';

/** The ids `loadRouteChunk` was handed, in no particular order. */
function warmed(): string[] {
  return mocks.loadRouteChunk.mock.calls.map(([route]) => route.id).sort();
}

beforeEach(() => {
  mocks.settled = true;
  mocks.loadRouteChunk = vi.fn((_route: { id: string }) => Promise.resolve());
  vi.useFakeTimers();
  // No idle callback: the fallback timer is the path every test takes, so the wait is fake-timable
  // and Safari's path is the one under test.
  vi.stubGlobal('requestIdleCallback', undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RoutePrefetch', () => {
  it('warms every skater route once the first page has settled', () => {
    render(<RoutePrefetch />);
    vi.advanceTimersByTime(PREFETCH_FALLBACK_MS);
    expect(warmed()).toEqual(['/_skater/', '/_skater/latest', '/about', '__root__']);
  });

  it('leaves the console cold — a skater must not download an app they never open', () => {
    render(<RoutePrefetch />);
    vi.advanceTimersByTime(PREFETCH_FALLBACK_MS);
    expect(warmed()).not.toContain('/admin');
    expect(warmed()).not.toContain('/admin/water/$id');
  });

  it('waits for the first page: nothing is fetched while the router is still working', () => {
    mocks.settled = false;
    render(<RoutePrefetch />);
    vi.advanceTimersByTime(PREFETCH_FALLBACK_MS * 5);
    expect(mocks.loadRouteChunk).not.toHaveBeenCalled();
  });

  it('runs once, not on every later navigation', () => {
    const { rerender } = render(<RoutePrefetch />);
    vi.advanceTimersByTime(PREFETCH_FALLBACK_MS);
    const first = mocks.loadRouteChunk.mock.calls.length;
    rerender(<RoutePrefetch />);
    vi.advanceTimersByTime(PREFETCH_FALLBACK_MS * 5);
    expect(mocks.loadRouteChunk.mock.calls.length).toBe(first);
  });

  it('prefers the browser’s idle callback when there is one', () => {
    const idle = vi.fn((fn: () => void) => {
      fn();
      return 7;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    render(<RoutePrefetch />);
    expect(idle).toHaveBeenCalled();
    expect(warmed().length).toBeGreaterThan(0);
  });

  it('swallows a chunk that fails: the navigation that needs it will report it', async () => {
    mocks.loadRouteChunk = vi.fn((_route: { id: string }) => Promise.reject(new Error('offline')));
    render(<RoutePrefetch />);
    expect(() => vi.advanceTimersByTime(PREFETCH_FALLBACK_MS)).not.toThrow();
    await vi.runAllTimersAsync();
  });

  it('tolerates a route whose chunk is already loaded (`loadRouteChunk` returns nothing)', () => {
    mocks.loadRouteChunk = vi.fn((_route: { id: string }) => undefined as unknown as Promise<void>);
    render(<RoutePrefetch />);
    expect(() => vi.advanceTimersByTime(PREFETCH_FALLBACK_MS)).not.toThrow();
  });
});
