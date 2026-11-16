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
      useRecordActing({ current: T, present: true, onAct, onLateRefusal: () => {} }),
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

  it.each([
    [true, 'Not allowed', []],
    [false, null, ['Not allowed']],
  ])(
    'its item region drawn when the answer comes %s: said in place, else once, out of the way',
    async (regionDrawn, inPlace, late) => {
      const region = document.body.appendChild(document.createElement('div'));
      const said: string[] = [];
      const { result } = renderHook(() =>
        useRecordActing({
          current: T,
          present: true,
          onAct: async () => 'Not allowed',
          onLateRefusal: (text) => said.push(text),
        }),
      );
      // The item still open and the sheet present, but its region no longer drawn (hidden).
      region.hidden = !regionDrawn;
      let answer: string | null = 'unset';
      await act(async () => {
        answer = await result.current.run(T, { kind: 'restore' }, { region, inline: true });
      });
      region.remove();
      expect(answer).toBe(inPlace);
      expect(result.current.refusalOn(T)).toBe(inPlace);
      expect(said).toEqual(late);
    },
  );
});
