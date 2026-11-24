import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEntryNow } from './useEntryNow';

// Pinned (D243).
const T0 = Date.UTC(2026, 10, 24, 15);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useEntryNow', () => {
  it('reads the clock again just past a suspension’s end, and not before', () => {
    const profile = { status: 'suspended' as const, suspendedUntil: T0 + 60_000 };
    const { result } = renderHook(() => useEntryNow(profile));
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(T0 + 60_001);
  });

  it('sets no timer when nothing in the rule moves with the clock', () => {
    for (const profile of [
      null,
      undefined,
      { status: 'active' as const },
      { status: 'banned' as const },
    ]) {
      const { unmount } = renderHook(() => useEntryNow(profile));
      expect(vi.getTimerCount()).toBe(0);
      unmount();
    }
  });

  it('drops its timer on unmount', () => {
    const { unmount } = renderHook(() =>
      useEntryNow({ status: 'suspended', suspendedUntil: T0 + 60_000 }),
    );
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
