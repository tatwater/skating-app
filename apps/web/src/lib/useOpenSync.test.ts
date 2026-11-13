import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useOpenSync } from './useOpenSync';

const MONDAY_NOON = Date.UTC(2026, 0, 12, 12);
const HOUR = 3_600_000;

function show(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useOpenSync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MONDAY_NOON);
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  test('syncs on open, not on every return the same day', () => {
    const sync = vi.fn();
    renderHook(() => useOpenSync(sync, true));
    expect(sync).toHaveBeenCalledTimes(1);
    vi.setSystemTime(MONDAY_NOON + 3 * HOUR);
    show('hidden');
    show('visible');
    expect(sync).toHaveBeenCalledTimes(1);
  });

  test('a tab left open since yesterday syncs again when it comes back into view', () => {
    const sync = vi.fn();
    renderHook(() => useOpenSync(sync, true));
    show('hidden');
    vi.setSystemTime(MONDAY_NOON + 20 * HOUR); // Tuesday, 08:00 UTC
    show('visible');
    expect(sync).toHaveBeenCalledTimes(2);
    show('hidden');
    show('visible');
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('a window that never left view syncs again when it is focused on a new day', () => {
    const sync = vi.fn();
    renderHook(() => useOpenSync(sync, true));
    window.dispatchEvent(new Event('focus'));
    expect(sync).toHaveBeenCalledTimes(1);
    vi.setSystemTime(MONDAY_NOON + 20 * HOUR); // Tuesday, still visible all night
    window.dispatchEvent(new Event('focus'));
    expect(sync).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('nothing before there is a profile, and nothing after unmount', () => {
    const sync = vi.fn();
    const { rerender, unmount } = renderHook(({ on }) => useOpenSync(sync, on), {
      initialProps: { on: false },
    });
    expect(sync).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(sync).toHaveBeenCalledTimes(1);
    unmount();
    vi.setSystemTime(MONDAY_NOON + 24 * HOUR);
    show('visible');
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
