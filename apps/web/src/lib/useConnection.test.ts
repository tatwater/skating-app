import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const convex = vi.hoisted(() => ({
  state: { isWebSocketConnected: false, hasEverConnected: false },
}));
vi.mock('convex/react', () => ({
  useConvexConnectionState: () => convex.state,
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/tanstackstart-react', () => sentry);

import {
  connectionStatus,
  FIRST_LOAD_GRACE_MS,
  RECONNECT_GRACE_MS,
  RETRY_STAMP_MS,
  retryConnection,
  useBrowserOnline,
  useConnection,
} from './useConnection';

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

describe('connectionStatus', () => {
  const base = {
    browserOnline: true,
    socketConnected: false,
    hasEverConnected: true,
    downForMs: 0,
  };
  it('trusts a live socket over the browser flag', () => {
    expect(connectionStatus({ ...base, socketConnected: true, browserOnline: false })).toBe(
      'online',
    );
  });
  it('is offline at once when the browser has no network', () => {
    expect(connectionStatus({ ...base, browserOnline: false })).toBe('offline');
  });
  it('waits out the reconnect grace mid-session', () => {
    expect(connectionStatus({ ...base, downForMs: RECONNECT_GRACE_MS - 1 })).toBe('connecting');
    expect(connectionStatus({ ...base, downForMs: RECONNECT_GRACE_MS })).toBe('offline');
  });
  it('gives the first load the longer grace', () => {
    const first = { ...base, hasEverConnected: false };
    expect(connectionStatus({ ...first, downForMs: RECONNECT_GRACE_MS })).toBe('connecting');
    expect(connectionStatus({ ...first, downForMs: FIRST_LOAD_GRACE_MS })).toBe('offline');
  });
});

describe('retryConnection', () => {
  it('reloads only when the browser says it has a network', () => {
    const reload = vi.fn();
    expect(retryConnection(false, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(retryConnection(true, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('useBrowserOnline', () => {
  afterEach(() => setOnline(true));
  it('follows the online and offline events', () => {
    setOnline(true);
    const { result } = renderHook(() => useBrowserOnline());
    expect(result.current).toBe(true);
    act(() => setOnline(false));
    expect(result.current).toBe(false);
  });
});

describe('useConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-16T12:00:00Z'));
    setOnline(true);
    convex.state = { isWebSocketConnected: false, hasEverConnected: false };
  });
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it('starts connecting, never offline, and reads online once the socket opens', () => {
    const { result, rerender } = renderHook(() => useConnection());
    expect(result.current.status).toBe('connecting');
    expect(result.current.firstLoad).toBe(true);
    convex.state = { isWebSocketConnected: true, hasEverConnected: true };
    rerender();
    expect(result.current.status).toBe('online');
    expect(result.current.firstLoad).toBe(false);
    expect(result.current.lastConnectedAt).toBe(Date.now());
  });

  it('turns a first load offline when the grace runs out, and stamps tries every thirty seconds', () => {
    const { result } = renderHook(() => useConnection());
    act(() => {
      vi.advanceTimersByTime(FIRST_LOAD_GRACE_MS + 5);
    });
    expect(result.current.status).toBe('offline');
    expect(result.current.firstLoad).toBe(true);
    const first = result.current.lastTriedAt;
    expect(first).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(RETRY_STAMP_MS);
    });
    expect(result.current.lastTriedAt).toBe((first as number) + RETRY_STAMP_MS);
  });

  it('remembers when the socket dropped and reads offline after the reconnect grace', () => {
    convex.state = { isWebSocketConnected: true, hasEverConnected: true };
    const { result, rerender } = renderHook(() => useConnection());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const droppedAt = Date.now();
    convex.state = { isWebSocketConnected: false, hasEverConnected: true };
    rerender();
    expect(result.current.status).toBe('connecting');
    expect(result.current.lastConnectedAt).toBe(droppedAt);
    act(() => {
      vi.advanceTimersByTime(RECONNECT_GRACE_MS + 5);
    });
    expect(result.current.status).toBe('offline');
    expect(result.current.firstLoad).toBe(false);
    convex.state = { isWebSocketConnected: true, hasEverConnected: true };
    rerender();
    expect(result.current.status).toBe('online');
    expect(result.current.lastTriedAt).toBeNull();
  });

  it('reads offline at once when the browser loses its network, and reports nothing to Sentry', () => {
    convex.state = { isWebSocketConnected: true, hasEverConnected: true };
    const { result, rerender } = renderHook(() => useConnection());
    convex.state = { isWebSocketConnected: false, hasEverConnected: true };
    act(() => setOnline(false));
    rerender();
    expect(result.current.status).toBe('offline');
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});
