import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ID_SHAPE, minuteOf, useClockFor } from './readArgs';

afterEach(() => vi.useRealTimers());

describe('what a console read is asked with', () => {
  it('holds the minute a place opened at while it stays open, and reads it again for a new place', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 0, 16, 17, 0, 30));
    const { result, rerender } = renderHook(({ key }) => useClockFor(key), {
      initialProps: { key: 'a' },
    });
    expect(result.current).toBe(Date.UTC(2027, 0, 16, 17));
    vi.setSystemTime(Date.UTC(2027, 0, 16, 17, 5, 10));
    rerender({ key: 'a' });
    expect(result.current).toBe(Date.UTC(2027, 0, 16, 17));
    rerender({ key: 'b' });
    expect(result.current).toBe(Date.UTC(2027, 0, 16, 17, 5));
  });

  it('takes an instant to its minute, and an id only in a Convex id’s shape', () => {
    expect(minuteOf(Date.UTC(2027, 0, 1, 0, 0, 59, 999))).toBe(Date.UTC(2027, 0, 1));
    expect(ID_SHAPE.test('k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(ID_SHAPE.test('k1/7')).toBe(false);
    expect(ID_SHAPE.test('K17AAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });
});
