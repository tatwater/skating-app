import { LOCATE_GIVE_UP_MS } from '@skating/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentPosition, useLocateRead } from './currentPosition';

/** A browser whose location answers when the test says (`fix`, `refuse`), or never. */
function geolocation() {
  const asks: Array<{ ok: PositionCallback; fail: PositionErrorCallback | null | undefined }> = [];
  vi.stubGlobal('navigator', {
    geolocation: {
      getCurrentPosition: (ok: PositionCallback, fail?: PositionErrorCallback | null) => {
        asks.push({ ok, fail });
      },
    },
  });
  return {
    fix: (lat: number, lng: number) => {
      for (const a of asks) {
        a.ok({ coords: { latitude: lat, longitude: lng } } as GeolocationPosition);
      }
    },
    refuse: () => {
      for (const a of asks) a.fail?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 24, 15));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('currentPosition', () => {
  it('answers with the fix', async () => {
    const geo = geolocation();
    const position = currentPosition();
    geo.fix(43.7, -72.29);
    await expect(position).resolves.toEqual({ lat: 43.7, lng: -72.29 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a refusal', async () => {
    const geo = geolocation();
    const position = currentPosition();
    geo.refuse();
    await expect(position).rejects.toMatchObject({ code: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never gives up on its own: a prompt answered slowly still answers', async () => {
    // Firefox: clicking away from the permission doorhanger leaves the request pending, and the
    // browser's own timeout only starts once permission is given. The busy state is bounded by
    // `useLocateRead`, never the read: a fix that comes late still comes.
    const geo = geolocation();
    const position = currentPosition();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS * 2);
    geo.fix(43.7, -72.29);
    await expect(position).resolves.toEqual({ lat: 43.7, lng: -72.29 });
  });

  it('rejects at once where there is no geolocation', async () => {
    vi.stubGlobal('navigator', {});
    await expect(currentPosition()).rejects.toThrow('unavailable');
  });
});

describe('useLocateRead', () => {
  it('stops looking busy at the give-up, and still takes a fix nobody superseded', async () => {
    const geo = geolocation();
    const onFix = vi.fn();
    const { result } = renderHook(() => useLocateRead(onFix));
    act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.locate).toBe('locating');
    await act(() => vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS));
    expect(result.current.locate).toBe('idle');
    geo.fix(43.7, -72.29);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onFix).toHaveBeenCalledExactlyOnceWith({ lat: 43.7, lng: -72.29 });
  });

  it('drops a fix the skater superseded, and says a refusal', async () => {
    const geo = geolocation();
    const onFix = vi.fn();
    const { result } = renderHook(() => useLocateRead(onFix));
    act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => result.current.supersede());
    expect(result.current.locate).toBe('idle');
    geo.fix(43.7, -72.29);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onFix).not.toHaveBeenCalled();
    act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(0));
    geo.refuse();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.locate).toBe('failed');
  });

  it('takes nothing once the screen is gone', async () => {
    const geo = geolocation();
    const onFix = vi.fn();
    const { result, unmount } = renderHook(() => useLocateRead(onFix));
    act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    geo.fix(43.7, -72.29);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).not.toHaveBeenCalled();
    // Pressed after the screen went: nothing starts.
    result.current.start();
    result.current.supersede();
    expect(vi.getTimerCount()).toBe(0);
  });
});
