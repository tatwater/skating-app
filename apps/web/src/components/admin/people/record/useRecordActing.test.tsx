import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRecordActing } from './useRecordActing';

const T = { targetType: 'report' as const, targetId: 'r1' };

describe('a write tied to its attempt', () => {
  it('a second write on the item while its first is out waits, never a landing', async () => {
    let settle: (landed: boolean) => void = () => {};
    const onAct = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = renderHook(() => useRecordActing({ current: T, present: true, onAct }));
    let first: Promise<unknown> = Promise.resolve();
    let second: string | null = null;
    await act(async () => {
      first = result.current.run(T, { kind: 'restore' }, { region: null, inline: false });
      second = await result.current.run(T, { kind: 'restore' }, { region: null, inline: false });
    });
    expect(second).toBe('waiting');
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(result.current.busyOn(T)).toBe('restore');
    await act(async () => {
      settle(true);
      await first;
    });
    expect(result.current.busyOn(T)).toBeNull();
  });

  /**
   * **A refusal is its toast's** (D268, said by the write path naming the person): whether the item
   * is still open, its region drawn or hidden, the caller hears the same "refused" and the item
   * keeps no words of it.
   */
  it.each([
    ['open, its region drawn', true, true],
    ['open, its region hidden', true, false],
    ['no longer open', false, true],
  ])('the item %s: "refused", and nothing said in its place', async (_, open, drawn) => {
    const region = document.body.appendChild(document.createElement('div'));
    const { result, rerender } = renderHook(
      ({ current }) => useRecordActing({ current, present: true, onAct: async () => false }),
      { initialProps: { current: T as typeof T | null } },
    );
    region.hidden = !drawn;
    let answer: string | null = null;
    await act(async () => {
      const sent = result.current.run(T, { kind: 'restore' }, { region, inline: true });
      if (!open) rerender({ current: null });
      answer = await sent;
    });
    region.remove();
    expect(answer).toBe('refused');
    expect(result.current.noteOn(T)).toBeNull();
  });

  it('the sheet’s own note is said only on the item open now', () => {
    const { result } = renderHook(() =>
      useRecordActing({ current: T, present: true, onAct: async () => true }),
    );
    act(() => result.current.say(T, 'This changed while you had it open.'));
    expect(result.current.noteOn(T)).toBe('This changed while you had it open.');
    act(() => result.current.say({ targetType: 'report', targetId: 'r2' }, 'x'));
    expect(result.current.noteOn({ targetType: 'report', targetId: 'r2' })).toBeNull();
  });
});
