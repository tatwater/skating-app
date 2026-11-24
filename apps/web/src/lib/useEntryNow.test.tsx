import { SUSPENSION_CLOCK_MARGIN_MS } from '@skating/core';
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
  // A suspension ending a minute from now lapses, for the gate, a margin later (core's rule).
  const END = 60_000 + SUSPENSION_CLOCK_MARGIN_MS;

  it('reads the clock again just past a suspension’s end and its margin, and not before', () => {
    const profile = { status: 'suspended' as const, suspendedUntil: T0 + 60_000 };
    const { result } = renderHook(() => useEntryNow(profile));
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(END);
    });
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(T0 + END + 1);
  });

  it('reads the clock again when a can’t-act refusal stops holding', () => {
    const { result } = renderHook(() => useEntryNow({ status: 'active' }, T0 - 1_000));
    act(() => {
      vi.advanceTimersByTime(SUSPENSION_CLOCK_MARGIN_MS - 1_001);
    });
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(T0 + SUSPENSION_CLOCK_MARGIN_MS - 1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sets its timer again when one fires a hair early, so the end is never missed', () => {
    const profile = { status: 'suspended' as const, suspendedUntil: T0 + 60_000 };
    const { result } = renderHook(() => useEntryNow(profile));
    // The clock steps back 5 ms under the timer (an NTP step, a coarsened `Date.now()`): it fires
    // on schedule, but the clock it reads says the suspension hasn't quite ended. The wake-up
    // instant comes out the same as before, and a timer keyed on it alone would never be set again.
    vi.setSystemTime(T0 - 5);
    act(() => {
      vi.advanceTimersByTime(END + 1);
    });
    expect(result.current).toBe(T0 + END - 4);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(5);
    });
    expect(result.current).toBe(T0 + END + 1);
    expect(vi.getTimerCount()).toBe(0);
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
