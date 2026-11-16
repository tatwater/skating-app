import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTickingNow } from './tabParts';

afterEach(() => {
  vi.useRealTimers();
});

describe('useTickingNow', () => {
  it('holds its instant between ticks and moves on at each one', () => {
    const start = Date.UTC(2026, 9, 14, 12);
    vi.useFakeTimers({ now: start, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { result, unmount } = renderHook(() => useTickingNow(3_600_000));
    expect(result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(3_599_999);
    });
    expect(result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(start + 3_600_000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
