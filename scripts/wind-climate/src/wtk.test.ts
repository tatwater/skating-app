import { describe, expect, it, vi } from 'vitest';
import {
  accumulateCsv,
  emptyCounts,
  fetchCellYear,
  gridKey,
  MIN_ROSE_HOURS,
  pointForGridKey,
  roseFromCounts,
  WTK_YEARS,
  wtkUrl,
} from './wtk';

/** A WTK CSV: two header lines, then Year,Month,Day,Hour,Minute,direction,speed. */
function csv(rows: Array<[number, number]>): string {
  const head =
    'SiteID,1,Site Timezone,-5,Data Timezone,0,Longitude,-72.05,Latitude,44.75\nYear,Month,Day,Hour,Minute,wind direction at 10m (deg),wind speed at 10m (m/s)';
  const body = rows.map(([month, dir]) => `2012,${month},1,0,30,${dir},4.2`).join('\n');
  return `${head}\n${body}\n`;
}

describe('gridKey', () => {
  it('collapses nearby lakes onto one 2 km cell', () => {
    // The dedupe that makes the pass affordable: requests are the scarce resource (10k/day, one
    // point-year each), and a rose is a property of the cell, not of the lake.
    expect(gridKey({ lat: 44.7501, lng: -72.0525 })).toBe(gridKey({ lat: 44.7509, lng: -72.0531 }));
  });

  it('keeps genuinely different cells apart', () => {
    expect(gridKey({ lat: 44.75, lng: -72.05 })).not.toBe(gridKey({ lat: 44.9, lng: -72.05 }));
  });

  it('round-trips through pointForGridKey', () => {
    const key = gridKey({ lat: 44.7501, lng: -72.0525 });
    expect(gridKey(pointForGridKey(key))).toBe(key);
  });
});

describe('wtkUrl', () => {
  it('sends WKT as POINT(lng lat) — longitude first', () => {
    // The opposite order from every other coordinate pair in this repo, and the easiest thing here
    // to get backwards; a transposed point silently returns a rose for the wrong place.
    const url = new URL(wtkUrl({ lat: 44.75, lng: -72.06 }, 2012, 'KEY', 'a@b.c'));
    expect(url.searchParams.get('wkt')).toBe('POINT(-72.06 44.75)');
    expect(url.searchParams.get('names')).toBe('2012');
    expect(url.searchParams.get('api_key')).toBe('KEY');
    expect(url.searchParams.get('email')).toBe('a@b.c');
    expect(url.searchParams.get('attributes')).toContain('winddirection_10m');
  });
});

describe('accumulateCsv', () => {
  it('counts only the winter months', () => {
    const counts = emptyCounts();
    // Three winter hours due north, two July hours due south.
    const hours = accumulateCsv(
      csv([
        [1, 0],
        [2, 0],
        [12, 0],
        [7, 180],
        [7, 180],
      ]),
      counts,
    );
    expect(hours).toBe(3);
    expect(counts[0]).toBe(3);
    expect(counts[8]).toBe(0);
  });

  it('bins directions to the nearest of 16 sectors and wraps 350 to north', () => {
    const counts = emptyCounts();
    accumulateCsv(
      csv([
        [1, 0],
        [1, 350],
        [1, 90],
        [1, 22.5],
      ]),
      counts,
    );
    expect(counts[0]).toBe(2);
    expect(counts[4]).toBe(1);
    expect(counts[1]).toBe(1);
  });

  it('skips the two header lines and any malformed row', () => {
    const counts = emptyCounts();
    expect(accumulateCsv(`${csv([[1, 0]])}garbage\n,,,\n`, counts)).toBe(1);
  });

  it('accumulates across years into one set of counts', () => {
    const counts = emptyCounts();
    accumulateCsv(csv([[1, 0]]), counts);
    accumulateCsv(csv([[1, 0]]), counts);
    expect(counts[0]).toBe(2);
  });
});

describe('roseFromCounts', () => {
  it('refuses a sample too thin to render as a percentage', () => {
    // A rose is shown as "wind comes from the NW about 19% of the time". That reads identically
    // whether it summarises 300 hours or 14,000 (same discipline as D78 and D86).
    const counts = emptyCounts();
    counts[0] = 100;
    expect(roseFromCounts(counts, 100)).toBeNull();
    expect(roseFromCounts(counts, MIN_ROSE_HOURS)).not.toBeNull();
  });

  it('normalizes to frequencies summing to 1', () => {
    const counts = emptyCounts();
    counts[0] = 3000;
    counts[8] = 1000;
    const rose = roseFromCounts(counts, 4000) as number[];
    expect(rose.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(rose[0]).toBeCloseTo(0.75, 10);
  });

  it('averages five winters, which is what WTK_YEARS is for', () => {
    expect(WTK_YEARS).toHaveLength(5);
    // Five winters is ~14,500 hours, comfortably over the floor.
    expect(WTK_YEARS.length * 2900).toBeGreaterThan(MIN_ROSE_HOURS);
  });
});

describe('fetchCellYear', () => {
  const ok = (text: string) =>
    (async () =>
      ({ ok: true, status: 200, text: async () => text }) as Response) as unknown as typeof fetch;

  it('returns the CSV body', async () => {
    const body = csv([[1, 0]]);
    expect(await fetchCellYear({ lat: 44, lng: -72 }, 2012, 'K', 'a@b.c', ok(body))).toBe(body);
  });

  it('does not retry a 400', async () => {
    const impl = vi.fn(
      (async () => ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch,
    );
    await expect(
      fetchCellYear({ lat: 44, lng: -72 }, 2012, 'K', 'a@b.c', impl as never),
    ).rejects.toThrow(/400/);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('backs off on a 429 rather than failing the run', async () => {
    // Expected in normal operation: the daily and per-second limits are real.
    let calls = 0;
    const impl = (async () => {
      calls++;
      return calls === 1
        ? ({ ok: false, status: 429 } as Response)
        : ({ ok: true, status: 200, text: async () => 'x' } as Response);
    }) as unknown as typeof fetch;
    expect(await fetchCellYear({ lat: 44, lng: -72 }, 2012, 'K', 'a@b.c', impl)).toBe('x');
    expect(calls).toBe(2);
  }, 30_000);
});
