import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_POSITION_GIVE_UP_MS, currentPosition } from './currentPosition';

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

  it('gives up on a prompt nobody answers, and a fix after that changes nothing', async () => {
    // Firefox: clicking away from the permission doorhanger leaves the request pending for good, and
    // the browser's own timeout only starts once permission is given.
    const geo = geolocation();
    const position = currentPosition();
    let settled: unknown = 'pending';
    position.then(
      (v) => {
        settled = v;
      },
      (e: unknown) => {
        settled = e;
      },
    );
    await vi.advanceTimersByTimeAsync(CURRENT_POSITION_GIVE_UP_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ message: 'timeout' });
    geo.fix(43.7, -72.29);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toMatchObject({ message: 'timeout' });
  });

  it('rejects at once where there is no geolocation', async () => {
    vi.stubGlobal('navigator', {});
    await expect(currentPosition()).rejects.toThrow('unavailable');
  });
});
