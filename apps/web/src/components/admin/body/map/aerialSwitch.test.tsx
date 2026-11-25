import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASCOMA_BOUNDS } from '../frame/bodyFixtures';
import { AERIAL_KEY, readAerial, useAerialSwitch, writeAerial } from './aerialSwitch';
import { forgetAerialDates, useAerialCredit } from './consoleAerial';

beforeEach(() => window.localStorage.removeItem(AERIAL_KEY));
afterEach(() => {
  vi.restoreAllMocks();
  forgetAerialDates();
});

describe('the summer aerial’s switch, per viewer', () => {
  it('is off until this browser turned it on, and remembers each change', () => {
    expect(readAerial()).toBe(false);
    const { result, unmount } = renderHook(() => useAerialSwitch());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(AERIAL_KEY)).toBe('on');
    unmount();
    // The next map, the next visit: on.
    expect(renderHook(() => useAerialSwitch()).result.current[0]).toBe(true);
    writeAerial(false);
    expect(window.localStorage.getItem(AERIAL_KEY)).toBeNull();
  });

  it('reads anything but its own word as off', () => {
    window.localStorage.setItem(AERIAL_KEY, 'true');
    expect(readAerial()).toBe(false);
  });

  it('a blocked store reads as off, and still switches the map', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useAerialSwitch());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe('the live map’s credit', () => {
  const ok = (json: unknown) => ({ ok: true, json: async () => json }) as Response;
  const dated = {
    catalogItems: {
      features: [{ attributes: { acquisition_date: Date.UTC(2023, 5, 22), raster_name: 'm' } }],
    },
  };

  it('asks nothing while off, and says nothing', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useAerialCredit(false, MASCOMA_BOUNDS));
    expect(result.current).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names the program at once, and the month once the service has said', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(dated));
    const { result } = renderHook(() => useAerialCredit(true, MASCOMA_BOUNDS));
    expect(result.current).toBe('Aerial · NAIP');
    await waitFor(() => expect(result.current).toBe('Aerial · NAIP Jun 2023'));
  });

  it('an answer for one body never dates another', async () => {
    let release: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(
      new Promise<Response>((done) => {
        release = done;
      }),
    );
    const { result, rerender } = renderHook(({ box }) => useAerialCredit(true, box), {
      initialProps: { box: MASCOMA_BOUNDS },
    });
    const other = { minLng: -70.3, maxLng: -70.2, minLat: 44.1, maxLat: 44.2 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));
    rerender({ box: other });
    await act(async () => release(ok(dated)));
    expect(result.current).toBe('Aerial · NAIP');
  });
});
