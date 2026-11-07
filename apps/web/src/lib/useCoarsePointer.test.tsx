import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCoarsePointer } from './useCoarsePointer';

/** A live `(pointer: coarse)` list: `flip` changes the answer and fires the change listeners. */
function fakeMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: '(pointer: coarse)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  } as unknown as MediaQueryList;
  vi.spyOn(window, 'matchMedia').mockReturnValue(mql);
  return {
    listeners,
    flip(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
  };
}

describe('useCoarsePointer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the primary pointer and follows a docking change', () => {
    const media = fakeMedia(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
    act(() => media.flip(true));
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const media = fakeMedia(true);
    const { result, unmount } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('answers false where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
  });
});
