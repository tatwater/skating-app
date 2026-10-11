import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchHourlyRows } from './openMeteoHourly';

/** One site's hourly row: 24 UTC hours a day from `start`, each at that day's low. */
function hourlyRow(start: string, lows: number[]) {
  const base = Date.parse(`${start}T00:00:00Z`) / 1000;
  return {
    timezone: 'UTC',
    utc_offset_seconds: 0,
    hourly: {
      time: lows.flatMap((_, d) =>
        Array.from({ length: 24 }, (_, h) => base + (d * 24 + h) * 3600),
      ),
      temperature_2m: lows.flatMap((low) => new Array<number>(24).fill(low)),
    },
  };
}

const answer = (url: string) => {
  const lats = (new URL(url).searchParams.get('latitude') ?? '').split(',');
  return new Response(JSON.stringify(lats.map(() => hourlyRow('2026-10-01', [1]))));
};

afterEach(() => vi.unstubAllGlobals());

describe('fetchHourlyRows', () => {
  test('sizes each request by site-days, and retries an answer cut off once', async () => {
    const sites = Array.from({ length: 7 }, (_, i) => ({ lat: 44 + i / 100, lng: -71.65 }));
    let calls = 0;
    const sizes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls++;
        sizes.push((new URL(url).searchParams.get('latitude') ?? '').split(',').length);
        // The second request's first answer arrives cut off mid-array, as one did from Convex.
        if (calls === 2) return new Response('[{"hourly":{"time":[1,2');
        return answer(url);
      }),
    );
    const metered: number[] = [];
    const out = await fetchHourlyRows(
      'https://api.open-meteo.com/v1/forecast',
      new URLSearchParams({ hourly: 'temperature_2m' }),
      sites,
      93, // three sites a request at 300 site-days
      async (n) => {
        metered.push(n);
      },
    );
    expect(out).toMatchObject({ failed: 0, requests: 3, lastError: null });
    expect(out.rows.every((r) => r?.hourly?.time?.length === 24)).toBe(true);
    // Each attempt is metered by its sites — the retry included.
    expect(metered.reduce((a, b) => a + b, 0)).toBe(10);
    expect(Math.max(...sizes)).toBe(3);
  });

  test('an archive season is one site a request', async () => {
    const sizes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        sizes.push((new URL(url).searchParams.get('latitude') ?? '').split(',').length);
        return answer(url);
      }),
    );
    const sites = [0, 1, 2].map((i) => ({ lat: 44 + i, lng: -71.65 }));
    const out = await fetchHourlyRows(
      'https://x.test',
      new URLSearchParams(),
      sites,
      303,
      async () => {},
    );
    expect(out.requests).toBe(3);
    expect(sizes).toEqual([1, 1, 1]);
  });

  test('a refusal is not retried; a server error and a stall are, once — and the rest still come', async () => {
    const sites = [0, 1, 2].map((i) => ({ lat: 44 + i, lng: -71.65 }));
    const tries = new Map<string, number>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const lat = new URL(url).searchParams.get('latitude') as string;
        tries.set(lat, (tries.get(lat) ?? 0) + 1);
        if (lat === '44.0000') return new Response('', { status: 429, statusText: 'Too Many' });
        if (lat === '45.0000') return new Response('', { status: 502, statusText: 'Bad Gateway' });
        if (lat === '46.0000' && tries.get(lat) === 1) {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }
        return answer(url);
      }),
    );
    const out = await fetchHourlyRows(
      'https://x.test',
      new URLSearchParams(),
      sites,
      303,
      async () => {},
    );
    expect(tries.get('44.0000')).toBe(1);
    expect(tries.get('45.0000')).toBe(2);
    expect(tries.get('46.0000')).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.rows[0]).toBeUndefined();
    expect(out.rows[1]).toBeUndefined();
    expect(out.rows[2]?.hourly?.time?.length).toBe(24);
    expect(out.lastError).toMatch(/Open-Meteo (429|502)/);
  });
});
