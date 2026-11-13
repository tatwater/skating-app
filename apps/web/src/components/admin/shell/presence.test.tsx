import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { colleaguesFrom, HEARTBEAT_MS, useHeartbeat } from './presence';

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useHeartbeat — the console tab says it is open', () => {
  it('beats at once, then once a minute', () => {
    const send = vi.fn();
    renderHook(() => useHeartbeat(true, send));
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stops while the tab is hidden, and is never sooner than a minute on coming back', () => {
    const send = vi.fn();
    renderHook(() => useHeartbeat(true, send));
    vi.advanceTimersByTime(0);
    setVisibility('hidden');
    vi.advanceTimersByTime(10 * HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    // Back after ten minutes: at once.
    setVisibility('visible');
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(2);
    // A flicker hidden and back inside the minute does not beat again early.
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sends nothing when not enabled, or from a tab opened hidden, and stops on unmount', () => {
    const off = vi.fn();
    renderHook(() => useHeartbeat(false, off));
    vi.advanceTimersByTime(5 * HEARTBEAT_MS);
    expect(off).not.toHaveBeenCalled();

    visibility = 'hidden';
    const hidden = vi.fn();
    renderHook(() => useHeartbeat(true, hidden));
    vi.advanceTimersByTime(5 * HEARTBEAT_MS);
    expect(hidden).not.toHaveBeenCalled();

    visibility = 'visible';
    const send = vi.fn();
    const { unmount } = renderHook(() => useHeartbeat(true, send));
    vi.advanceTimersByTime(0);
    unmount();
    vi.advanceTimersByTime(5 * HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops a failed send; the next beat is the retry', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    renderHook(() => useHeartbeat(true, send));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('colleaguesFrom', () => {
  it('keeps a face, and leaves out a picture nobody has', () => {
    expect(
      colleaguesFrom([
        { id: 'a', name: 'Sarah Berman', src: 'https://img/a', present: true },
        { id: 'b', name: 'Matt Steinberg', src: null, present: false },
      ]),
    ).toEqual([
      { id: 'a', name: 'Sarah Berman', src: 'https://img/a', present: true },
      { id: 'b', name: 'Matt Steinberg', present: false },
    ]);
  });
});
