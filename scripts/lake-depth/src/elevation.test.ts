import { describe, expect, it, vi } from 'vitest';
import {
  batchTargets,
  ELEVATION_BATCH_SIZE,
  ELEVATION_MAX_RETRIES,
  ELEVATION_RATE_LIMIT_BASE_MS,
  ELEVATION_RATE_LIMIT_RETRIES,
  type ElevationTarget,
  elevationUrl,
  fetchElevationBatch,
  retryAfterMs,
  zipElevations,
} from './elevation';

function targets(n: number): ElevationTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    waterBodyId: `body${i}`,
    lat: 44 + i / 1000,
    lng: -73 - i / 1000,
  }));
}

/** A `fetch` stand-in returning one canned JSON body. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

describe('batchTargets', () => {
  it('batches at 100, the verified live cap', () => {
    // Not taken from the docs: 100 returns 200 and 101 returns a 400 naming the limit.
    expect(ELEVATION_BATCH_SIZE).toBe(100);
    const batches = batchTargets(targets(250));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it('handles an empty and an exact-multiple input', () => {
    expect(batchTargets([])).toEqual([]);
    expect(batchTargets(targets(200)).map((b) => b.length)).toEqual([100, 100]);
  });

  it('preserves order, which is the only thing pairing the response back', () => {
    const flat = batchTargets(targets(250)).flat();
    expect(flat.map((t) => t.waterBodyId)).toEqual(targets(250).map((t) => t.waterBodyId));
  });
});

describe('elevationUrl', () => {
  it('sends latitudes and longitudes as parallel comma-separated lists', () => {
    const url = new URL(elevationUrl(targets(3)));
    expect(url.searchParams.get('latitude')).toBe('44,44.001,44.002');
    expect(url.searchParams.get('longitude')).toBe('-73,-73.001,-73.002');
  });
});

describe('zipElevations', () => {
  it('pairs values back onto the batch positionally', () => {
    const { records } = zipElevations(targets(3), [27, 126, 357]);
    expect(records).toEqual([
      { waterBodyId: 'body0', elevationM: 27 },
      { waterBodyId: 'body1', elevationM: 126 },
      { waterBodyId: 'body2', elevationM: 357 },
    ]);
  });

  it('REFUSES a length mismatch rather than zipping what it can', () => {
    // The load-bearing test. The response carries no ids, so a short array means every pairing
    // after the discrepancy is wrong — and every body still gets *an* elevation, just not its own.
    // Populated-looking wrong data is the outcome this throw exists to prevent.
    expect(() => zipElevations(targets(3), [27, 126])).toThrow(/does not match/);
    expect(() => zipElevations(targets(3), [27, 126, 357, 400])).toThrow(/does not match/);
  });

  it('throws when the response carries no elevation array at all', () => {
    expect(() => zipElevations(targets(1), undefined)).toThrow(/no `elevation` array/);
    expect(() => zipElevations(targets(1), { nope: true })).toThrow(/no `elevation` array/);
  });

  it('drops implausible readings per body without disturbing the rest', () => {
    const { records, implausible } = zipElevations(targets(4), [27, -9999, 8848, 357]);
    expect(implausible).toBe(2);
    expect(records).toEqual([
      { waterBodyId: 'body0', elevationM: 27 },
      { waterBodyId: 'body3', elevationM: 357 },
    ]);
  });

  it('drops a null hole, which is how a no-data cell arrives', () => {
    const { records, implausible } = zipElevations(targets(2), [null, 100]);
    expect(implausible).toBe(1);
    expect(records).toEqual([{ waterBodyId: 'body1', elevationM: 100 }]);
  });
});

describe('fetchElevationBatch', () => {
  it('returns the zipped records on a good response', async () => {
    const result = await fetchElevationBatch(targets(2), jsonFetch({ elevation: [27, 126] }));
    expect(result.records).toHaveLength(2);
  });

  it('does not retry a 400 — a malformed request stays malformed', async () => {
    const impl = vi.fn(jsonFetch({}, 400));
    await expect(fetchElevationBatch(targets(1), impl as never)).rejects.toThrow(/400/);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return calls === 1
        ? ({ ok: false, status: 429 } as Response)
        : ({ ok: true, status: 200, json: async () => ({ elevation: [27] }) } as Response);
    }) as unknown as typeof fetch;
    // No real waiting: the backoff is injected, so this asserts the retry happened rather than
    // asserting the clock.
    const waited: number[] = [];
    const result = await fetchElevationBatch(targets(1), impl, async (ms) => {
      waited.push(ms);
    });
    expect(result.records).toEqual([{ waterBodyId: 'body0', elevationM: 27 }]);
    expect(calls).toBe(2);
    // A 429 must buy minutes, not the ~1s a flaky socket gets.
    expect(waited[0]).toBeGreaterThanOrEqual(ELEVATION_RATE_LIMIT_BASE_MS);
  });

  it('surfaces a length mismatch immediately rather than retrying it', async () => {
    const impl = vi.fn(jsonFetch({ elevation: [27] }));
    await expect(fetchElevationBatch(targets(2), impl as never)).rejects.toThrow(/does not match/);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

describe('rate limiting (429)', () => {
  it('honours the server’s Retry-After over our own guess', () => {
    // The only number in the exchange that is not a guess — the server knows when its window resets.
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(' 5 ')).toBe(5_000);
  });

  it('ignores an unusable Retry-After rather than misparsing it', () => {
    // The HTTP-date form is legal but nobody sends it here, and turning a date into a 50-year sleep
    // is a worse failure than ignoring the header.
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(retryAfterMs('0')).toBeUndefined();
    expect(retryAfterMs('-5')).toBeUndefined();
  });

  it('caps a very long Retry-After so a run ends rather than hanging', () => {
    expect(retryAfterMs('86400')).toBe(10 * 60_000);
  });

  it('gives a 429 far more patience than a flaky socket gets', () => {
    // The bug this fixes: 4 attempts of 250ms x 4^n is ~21 seconds total, the right shape for a
    // dropped connection and useless against a quota measured per minute. The real run died at
    // page 3 of ~230.
    expect(ELEVATION_RATE_LIMIT_RETRIES).toBeGreaterThan(ELEVATION_MAX_RETRIES);
    expect(ELEVATION_RATE_LIMIT_BASE_MS).toBeGreaterThanOrEqual(30_000);
  });
});
