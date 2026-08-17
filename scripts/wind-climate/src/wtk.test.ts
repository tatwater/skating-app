import { STRONG_WIND_MIN_MPS } from '@skating/core';
import { describe, expect, it, vi } from 'vitest';
import {
  accumulateCsv,
  climateFromAccumulator,
  emptyAccumulator,
  emptyCounts,
  fetchCellYear,
  gridKey,
  MIN_ROSE_HOURS,
  meanSpeedFromAccumulator,
  pointForGridKey,
  retryAfterMs,
  roseFromCounts,
  WTK_MAX_BACKOFF_MS,
  WTK_RATE_LIMIT_RETRIES,
  WTK_YEARS,
  wtkUrl,
} from './wtk';

/**
 * A WTK CSV: two header lines, then Year,Month,Day,Hour,Minute,direction,speed.
 *
 * The speed column defaults to 4.2 m/s — below `STRONG_WIND_MIN_MPS`, so a row is an ordinary hour
 * unless a test says otherwise. It is the seventh column, `cells[6]`, which every run before N7-3
 * fetched and never read.
 */
function csv(rows: Array<[number, number] | [number, number, number]>): string {
  const head =
    'SiteID,1,Site Timezone,-5,Data Timezone,0,Longitude,-72.05,Latitude,44.75\nYear,Month,Day,Hour,Minute,wind direction at 10m (deg),wind speed at 10m (m/s)';
  const body = rows
    .map(([month, dir, speed]) => `2012,${month},1,0,30,${dir},${speed ?? 4.2}`)
    .join('\n');
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
    const acc = emptyAccumulator();
    // Three winter hours due north, two July hours due south.
    const hours = accumulateCsv(
      csv([
        [1, 0],
        [2, 0],
        [12, 0],
        [7, 180],
        [7, 180],
      ]),
      acc,
    );
    expect(hours).toBe(3);
    expect(acc.counts[0]).toBe(3);
    expect(acc.counts[8]).toBe(0);
  });

  it('bins directions to the nearest of 16 sectors and wraps 350 to north', () => {
    const acc = emptyAccumulator();
    accumulateCsv(
      csv([
        [1, 0],
        [1, 350],
        [1, 90],
        [1, 22.5],
      ]),
      acc,
    );
    expect(acc.counts[0]).toBe(2);
    expect(acc.counts[4]).toBe(1);
    expect(acc.counts[1]).toBe(1);
  });

  it('skips the two header lines and any malformed row', () => {
    const acc = emptyAccumulator();
    expect(accumulateCsv(`${csv([[1, 0]])}garbage\n,,,\n`, acc)).toBe(1);
  });

  it('accumulates across years into one set of counts', () => {
    const acc = emptyAccumulator();
    accumulateCsv(csv([[1, 0]]), acc);
    accumulateCsv(csv([[1, 0]]), acc);
    expect(acc.counts[0]).toBe(2);
    expect(acc.sampledHours).toBe(2);
  });
});

describe('the speed column, which every run before N7-3 discarded', () => {
  it('counts an hour at or above the threshold as strong, in its own sector', () => {
    const acc = emptyAccumulator();
    accumulateCsv(
      csv([
        [1, 0, 12],
        [1, 0, 4],
        [1, 90, 20],
      ]),
      acc,
    );
    expect(acc.counts[0]).toBe(2); // both north hours are in the rose
    expect(acc.strongHours[0]).toBe(1); // only the 12 m/s one is strong
    expect(acc.strongHours[4]).toBe(1);
    expect(acc.sampledHours).toBe(3);
  });

  it('treats the threshold as inclusive', () => {
    const acc = emptyAccumulator(10);
    accumulateCsv(csv([[1, 0, 10]]), acc);
    expect(acc.strongHours[0]).toBe(1);
  });

  it('means the speed per sector — how hard it blows, not how often it blows hard', () => {
    const acc = emptyAccumulator();
    accumulateCsv(
      csv([
        [1, 0, 4],
        [1, 0, 8],
        [1, 90, 10],
      ]),
      acc,
    );
    const mean = meanSpeedFromAccumulator(acc);
    expect(mean[0]).toBe(6); // (4 + 8) / 2
    expect(mean[4]).toBe(10);
    // Neither north hour is strong, so the two statistics genuinely disagree — which is the whole
    // reason both are stored. A sector can blow steadily without ever blowing hard.
    expect(acc.strongHours[0]).toBe(0);
  });

  it('divides by hours with a READABLE speed, not by the rose s hours', () => {
    // ⚠ The subtle one. An hour whose direction parses and whose speed does not still counts toward
    // the rose, deliberately — dropping it would bias the rose toward whatever conditions produce a
    // clean speed field. So `counts` is the wrong divisor: averaging 10 m/s over two hours when only
    // one carried a reading would report 5 m/s and call a gale a breeze.
    const acc = emptyAccumulator();
    accumulateCsv(`${csv([[1, 0, 10]])}2012,1,1,0,30,0,not-a-number\n`, acc);
    expect(acc.counts[0]).toBe(2); // both hours are in the rose
    expect(acc.speedHours[0]).toBe(1); // only one had a speed
    expect(meanSpeedFromAccumulator(acc)[0]).toBe(10); // not 5
  });

  it('reports null, never zero, for a sector with no reading at all', () => {
    // Zero is a real wind speed. A glyph sized on it would draw "dead calm from the east"
    // identically to "we have never measured the east", and only one of those is a measurement.
    const acc = emptyAccumulator();
    accumulateCsv(csv([[1, 0, 6]]), acc);
    const mean = meanSpeedFromAccumulator(acc);
    expect(mean[0]).toBe(6);
    expect(mean[4]).toBeNull();
    expect(mean.filter((v) => v === 0)).toHaveLength(0);
  });

  it('carries the mean through climateFromAccumulator', () => {
    const acc = emptyAccumulator();
    accumulateCsv(csv([[1, 0, 7]]), acc);
    expect(climateFromAccumulator(acc).meanWindMps[0]).toBe(7);
  });

  it('re-derives at a different bar with no re-fetch — the point of the archive', () => {
    const rows: Array<[number, number, number]> = [
      [1, 0, 5],
      [1, 0, 9],
      [1, 0, 15],
    ];
    const lenient = emptyAccumulator(4);
    const strict = emptyAccumulator(12);
    accumulateCsv(csv(rows), lenient);
    accumulateCsv(csv(rows), strict);
    expect(lenient.strongHours[0]).toBe(3);
    expect(strict.strongHours[0]).toBe(1);
    // The rose is identical either way: the threshold is a speed question, not a direction one.
    expect(lenient.counts).toEqual(strict.counts);
  });

  it('keeps an hour in the rose when its SPEED is unreadable', () => {
    // Direction and speed are separate claims. Dropping the hour entirely would bias the rose
    // toward whatever conditions happen to produce a clean speed field.
    const acc = emptyAccumulator();
    const broken = csv([[1, 0]]).replace(',4.2', ',');
    expect(accumulateCsv(broken, acc)).toBe(1);
    expect(acc.counts[0]).toBe(1);
    expect(acc.strongHours[0]).toBe(0);
  });

  it('carries the threshold it was accumulated at, so a row is self-describing', () => {
    expect(emptyAccumulator().strongMinMps).toBe(STRONG_WIND_MIN_MPS);
    expect(climateFromAccumulator(emptyAccumulator(11)).strongWindMinMps).toBe(11);
  });
});

describe('climateFromAccumulator', () => {
  it('suppresses a thin rose but still reports the strong-hour counts', () => {
    // The asymmetry that makes the two fields independent: a rose renders as a percentage and a
    // percentage of 3 hours reads identically to one of 14,000. A count carries its own denominator.
    const acc = emptyAccumulator();
    accumulateCsv(csv([[1, 0, 20]]), acc);
    const climate = climateFromAccumulator(acc);
    expect(climate.rose).toBeNull();
    expect(climate.strongWindHours[0]).toBe(1);
    expect(climate.sampledWindHours).toBe(1);
  });

  it('emits a rose once the sample clears MIN_ROSE_HOURS', () => {
    const acc = emptyAccumulator();
    acc.counts[0] = MIN_ROSE_HOURS;
    acc.sampledHours = MIN_ROSE_HOURS;
    const climate = climateFromAccumulator(acc);
    expect(climate.rose?.[0]).toBe(1);
  });

  it('copies the counts rather than aliasing the accumulator', () => {
    // A stored array that keeps mutating with the accumulator behind it is the kind of bug that
    // only shows up once a second year is read.
    const acc = emptyAccumulator();
    const climate = climateFromAccumulator(acc);
    acc.strongHours[0] = 99;
    expect(climate.strongWindHours[0]).toBe(0);
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

describe('retryAfterMs — the header the 250 m fetch lost 18 requests by ignoring', () => {
  const NOW = Date.UTC(2026, 9, 21, 7, 26, 0);

  it('reads delta-seconds', () => {
    expect(retryAfterMs('120', NOW)).toBe(120_000);
    expect(retryAfterMs('  30  ', NOW)).toBe(30_000);
  });

  it('reads an HTTP-date, which is the form that silently produced NaN', () => {
    // RFC 9110 allows both and services use both. Parsing only delta-seconds returns NaN here, and a
    // NaN wait is an IMMEDIATE retry straight back into the same limit — worse than not reading it.
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', NOW)).toBe(120_000);
  });

  it('treats a date already in the past as "go now"', () => {
    expect(retryAfterMs('Wed, 21 Oct 2026 07:00:00 GMT', NOW)).toBe(0);
  });

  it('returns null when the server said nothing, so the caller falls back to its own backoff', () => {
    expect(retryAfterMs(null, NOW)).toBeNull();
    expect(retryAfterMs(undefined, NOW)).toBeNull();
    expect(retryAfterMs('', NOW)).toBeNull();
    expect(retryAfterMs('soon please', NOW)).toBeNull();
  });

  it('caps a pathological value rather than parking the run', () => {
    expect(retryAfterMs('99999', NOW)).toBe(WTK_MAX_BACKOFF_MS);
    expect(retryAfterMs('Fri, 21 Oct 2050 00:00:00 GMT', NOW)).toBe(WTK_MAX_BACKOFF_MS);
  });
});

describe('fetchCellYear rate-limit budget', () => {
  const ok = (body = 'Year,Month,Day,Hour,Minute,dir,spd\n') =>
    ({ ok: true, status: 200, text: async () => body }) as unknown as Response;
  const tooMany = (retryAfter?: string) =>
    ({
      ok: false,
      status: 429,
      headers: {
        get: (k: string) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null),
      },
    }) as unknown as Response;
  const point = { lat: 44.5, lng: -73.3 };

  it('gives a 429 more attempts than a 5xx, because they are different failures', async () => {
    // Four attempts spanning ~92s was not enough: the 250 m fetch lost 18 cell-years to one burst,
    // every one recoverable by waiting. A 5xx keeps the short budget — a broken service should be
    // reported, not retried for four minutes.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < WTK_RATE_LIMIT_RETRIES ? tooMany('0') : ok();
    }) as unknown as typeof fetch;
    await expect(fetchCellYear(point, 2012, 'k', 'e@x', fetchImpl, 4, () => 0)).resolves.toContain(
      'Year',
    );
    expect(calls).toBe(WTK_RATE_LIMIT_RETRIES);
  });

  it('still gives up on a 5xx at the short budget', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: false, status: 503 } as unknown as Response;
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    await expect(
      fetchCellYear(
        point,
        2012,
        'k',
        'e@x',
        fetchImpl,
        4,
        () => 0,
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toThrow('503');
    expect(calls).toBe(4);
    // Geometric, and it must not be flat — a "backoff" that does not back off just spends the budget.
    expect(waits).toEqual([4400, 17_600, 70_400]);
  });

  it('never retries a 4xx that is not 429', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: false, status: 403 } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      fetchCellYear(
        point,
        2012,
        'k',
        'e@x',
        fetchImpl,
        4,
        () => 0,
        async () => undefined,
      ),
    ).rejects.toThrow('403');
    expect(calls).toBe(1);
  });
});
