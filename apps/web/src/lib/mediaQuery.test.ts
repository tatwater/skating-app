import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaQueryStore, useMediaQuery } from './mediaQuery';

/** A live list for one query: `flip` changes the answer and fires the change listeners. */
function fakeMedia(initial: boolean, { listeners: withListeners = true } = {}) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const mql = {
    get matches() {
      return matches;
    },
    ...(withListeners
      ? {
          addEventListener: (_: string, fn: () => void) => listeners.add(fn),
          removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        }
      : {}),
  } as unknown as MediaQueryList;
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    queries.push(query);
    return mql;
  });
  return {
    listeners,
    queries,
    flip(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
  };
}

describe('mediaQueryStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('asks the browser its own query, and follows a change', () => {
    const media = fakeMedia(false);
    const store = mediaQueryStore('(max-width: 10rem)');
    const { result } = renderHook(() => useMediaQuery(store));
    expect(result.current).toBe(false);
    expect(media.queries.every((q) => q === '(max-width: 10rem)')).toBe(true);
    act(() => media.flip(true));
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const media = fakeMedia(true);
    const { unmount } = renderHook(() => useMediaQuery(mediaQueryStore('(pointer: coarse)')));
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('reads a list that cannot be listened to, without throwing', () => {
    fakeMedia(true, { listeners: false });
    const store = mediaQueryStore('(pointer: coarse)');
    const unsubscribe = store.subscribe(() => undefined);
    expect(store.getSnapshot()).toBe(true);
    expect(unsubscribe).not.toThrow();
  });

  it('answers false where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useMediaQuery(mediaQueryStore('(pointer: coarse)')));
    expect(result.current).toBe(false);
  });
});
