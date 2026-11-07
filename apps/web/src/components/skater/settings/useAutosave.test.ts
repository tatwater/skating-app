import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DELAY_MS, useAutosave } from './useAutosave';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useAutosave', () => {
  it('rests saved, types, then saves once on the pause', async () => {
    const save = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useAutosave('Hanover', save));
    expect(result.current.status).toBe('saved');
    act(() => result.current.setValue('Hanover, N'));
    act(() => result.current.setValue('Hanover, NH'));
    expect(result.current.status).toBe('typing');
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('Hanover, NH');
    expect(result.current.status).toBe('saved');
    expect(result.current.value).toBe('Hanover, NH');
  });

  it('says not saved when the server refuses, and keeps the words', async () => {
    const save = vi.fn().mockRejectedValue(new Error('no'));
    const { result } = renderHook(() => useAutosave('', save));
    act(() => result.current.setValue('Bio'));
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.value).toBe('Bio');
  });

  it('typed back to the saved value saves nothing', async () => {
    const save = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useAutosave('A', save));
    act(() => result.current.setValue('AB'));
    act(() => result.current.setValue('A'));
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe('saved');
  });

  it('typed back to the saved value while a save is out sends it again, so the last word wins', async () => {
    const resolvers: Array<() => void> = [];
    const save = vi.fn(() => new Promise<void>((r) => resolvers.push(r)));
    const { result } = renderHook(() => useAutosave('A', save));
    act(() => result.current.setValue('AB'));
    act(() => result.current.flush());
    expect(save).toHaveBeenLastCalledWith('AB');
    act(() => result.current.setValue('A'));
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('A');
    await act(async () => {
      for (const r of resolvers) r();
    });
    expect(result.current.status).toBe('saved');
  });

  it('a blur saves now; a stale save never marks a newer value saved', async () => {
    let resolve: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { result } = renderHook(() => useAutosave('', save));
    act(() => result.current.setValue('one'));
    act(() => result.current.flush());
    expect(save).toHaveBeenCalledWith('one');
    expect(result.current.status).toBe('saving');
    act(() => result.current.setValue('two'));
    await act(async () => resolve());
    expect(result.current.status).toBe('typing');
    act(() => result.current.flush());
    act(() => result.current.flush()); // nothing pending: a no-op
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a stale failure leaves the newer value alone', async () => {
    let reject: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((_, r) => (reject = () => r(new Error('x')))));
    const { result } = renderHook(() => useAutosave('', save));
    act(() => result.current.setValue('one'));
    act(() => result.current.flush());
    act(() => result.current.setValue('two'));
    await act(async () => reject());
    expect(result.current.status).toBe('typing');
  });

  it('leaving mid-pause still saves what was typed', () => {
    const save = vi.fn().mockResolvedValue(null);
    const { result, unmount } = renderHook(() => useAutosave('', save));
    act(() => result.current.setValue('typed'));
    unmount();
    expect(save).toHaveBeenCalledWith('typed');
  });

  it('leaving at rest saves nothing', () => {
    const save = vi.fn().mockResolvedValue(null);
    const { unmount } = renderHook(() => useAutosave('', save));
    unmount();
    expect(save).not.toHaveBeenCalled();
  });
});
