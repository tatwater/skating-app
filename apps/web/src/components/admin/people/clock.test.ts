import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { minuteOf, useClockFor } from './clock';

afterEach(() => vi.useRealTimers());

describe('useClockFor', () => {
  it('holds the minute a place opened at, and reads the clock again for a new place', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 30));
    const { result, rerender } = renderHook(({ key }) => useClockFor(key), {
      initialProps: { key: 'lane:everyone' },
    });
    const opened = result.current;
    expect(opened).toBe(minuteOf(Date.now()));
    vi.setSystemTime(new Date(2026, 9, 14, 12, 5, 10));
    rerender({ key: 'lane:everyone' });
    expect(result.current).toBe(opened);
    rerender({ key: 'lane:staff' });
    expect(result.current).toBe(new Date(2026, 9, 14, 12, 5).getTime());
  });
});
