import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRecordActing } from './useRecordActing';

const T = { targetType: 'report' as const, targetId: 'r1' };

describe('a write tied to its attempt', () => {
  it('a second write on the item while its first is out is refused in words, never a landing', async () => {
    let settle: (r: string | null) => void = () => {};
    const onAct = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useRecordActing({ current: T, onAct, onLateRefusal: () => {} }),
    );
    let first: Promise<string | null> = Promise.resolve(null);
    let second: string | null = null;
    await act(async () => {
      first = result.current.run(T, { kind: 'restore' }, { region: null, inline: false });
      second = await result.current.run(T, { kind: 'restore' }, { region: null, inline: false });
    });
    expect(second).toBe('A change to this is already on its way.');
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(result.current.busyOn(T)).toBe('restore');
    await act(async () => {
      settle(null);
      await first;
    });
    expect(result.current.busyOn(T)).toBeNull();
  });
});
