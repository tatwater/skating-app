import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDays } = vi.hoisted(() => ({ getDays: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getDays }));

// Imported after the mock so its `useAction` is the stub.
const { useSkateWeather } = await import('./useSkateWeather');

const TZ = 'America/New_York';
const END = Date.now() - 3600_000;
/** One stored day holding one hour, as `getWeatherDaysForBody` returns it. */
const ANSWER = {
  hours: [
    {
      dayMs: Date.UTC(2026, 0, 10),
      hours: [{ localHour: 14, temperatureC: -6 }],
    },
  ],
};

describe('useSkateWeather', () => {
  afterEach(() => getDays.mockReset());

  it('a failed read answers with nothing, then asks again when the browser is back online', async () => {
    getDays.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ANSWER);
    const { result } = renderHook(() => useSkateWeather('b1', END, TZ));
    await waitFor(() => expect(result.current).toEqual([]));
    expect(getDays).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(getDays).toHaveBeenCalledTimes(2);
  });

  it('an answer — even an empty one — is final: a reconnect does not ask again', async () => {
    getDays.mockResolvedValue(null);
    const { result } = renderHook(() => useSkateWeather('b1', END, TZ));
    await waitFor(() => expect(result.current).toEqual([]));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(getDays).toHaveBeenCalledTimes(1);
  });

  it('asks nothing without a lake or an end', () => {
    expect(renderHook(() => useSkateWeather(undefined, END, TZ)).result.current).toEqual([]);
    expect(renderHook(() => useSkateWeather('b1', undefined, TZ)).result.current).toEqual([]);
    expect(getDays).not.toHaveBeenCalled();
  });
});
