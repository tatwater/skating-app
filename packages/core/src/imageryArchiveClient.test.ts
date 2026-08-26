import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveError,
  loadArchiveSeason,
  loadFrameStats,
  loadSeasonIndex,
  prefetchFrames,
  resetArchiveCache,
  statsLookup,
} from './imageryArchiveClient';

const BASE = 'https://cdn.example/imagery';

/** Serve a fixed body map; every other URL 404s the way a real bucket does. */
function serve(bodies: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const hit = bodies[url];
    if (hit === undefined) return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, json: async () => hit } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

beforeEach(() => {
  resetArchiveCache();
  // Several of these exercise the failure path, which logs by design — see the module note on why a
  // silent null is how a misconfigured base URL hides. Swallow it so a green run reads as green.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadArchiveSeason — D149 read from the archive, not the clock', () => {
  it('returns the season the pointer names', async () => {
    serve({ [`${BASE}/index/latest.json`]: { season: 'winter-2025-26' } });
    await expect(loadArchiveSeason(BASE)).resolves.toBe('winter-2025-26');
  });

  it('returns null rather than throwing when the archive is not there', async () => {
    // A misconfigured base URL must degrade to "no scrubber", because the Tier 1 reveal works
    // without any of this and a thrown error would take the drawer with it.
    serve({});
    await expect(loadArchiveSeason(BASE)).resolves.toBeNull();
    expect(archiveError()).toBe(true);
  });

  it('⚠ distinguishes a broken archive from an empty one', async () => {
    // Both look like `null` at the call site, which is exactly how a bad base URL hides.
    serve({ [`${BASE}/index/latest.json`]: { season: 'winter-2025-26' } });
    await loadArchiveSeason(BASE);
    expect(archiveError()).toBe(false);
  });
});

describe('caching — the archive is immutable, so once per session is the policy', () => {
  it('reads each key exactly once', async () => {
    const calls = serve({ [`${BASE}/index/latest.json`]: { season: 'winter-2025-26' } });
    await loadArchiveSeason(BASE);
    await loadArchiveSeason(BASE);
    await loadArchiveSeason(BASE);
    expect(calls).toHaveLength(1);
  });

  it('caches a miss too, so a 404 is not re-fetched on every render', async () => {
    const calls = serve({});
    await loadFrameStats(BASE, 'winter-2025-26', 'S2C_A');
    await loadFrameStats(BASE, 'winter-2025-26', 'S2C_A');
    expect(calls).toHaveLength(1);
  });

  it('⚠ collapses concurrent requests for the same key into one', async () => {
    // Ten lakes opening at once must not become ten identical requests. The in-flight map is what
    // makes the manifest-per-granule design pay off, since neighbouring lakes share most granules.
    const calls = serve({
      [`${BASE}/frames/winter-2025-26/S2C_A.json`]: { granuleId: 'S2C_A', capturedAt: 'x' },
    });
    await Promise.all([
      loadFrameStats(BASE, 'winter-2025-26', 'S2C_A'),
      loadFrameStats(BASE, 'winter-2025-26', 'S2C_A'),
      loadFrameStats(BASE, 'winter-2025-26', 'S2C_A'),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('keys manifests on the granule, so both bands of a pass share one read', async () => {
    const calls = serve({
      [`${BASE}/frames/winter-2025-26/S2C_A.json`]: { granuleId: 'S2C_A', capturedAt: 'x' },
    });
    await loadFrameStats(BASE, 'winter-2025-26', 'S2C_A');
    expect(calls[0]).toBe(`${BASE}/frames/winter-2025-26/S2C_A.json`);
  });
});

describe('statsLookup — synchronous, so the timeline can render while fetches land', () => {
  it('returns undefined for a manifest not yet loaded', () => {
    serve({});
    expect(statsLookup(BASE, 'winter-2025-26')('S2C_A')).toBeUndefined();
  });

  it('returns a manifest once it has arrived', async () => {
    serve({
      [`${BASE}/frames/winter-2025-26/S2C_A.json`]: { granuleId: 'S2C_A', capturedAt: 'x' },
    });
    await loadFrameStats(BASE, 'winter-2025-26', 'S2C_A');
    expect(statsLookup(BASE, 'winter-2025-26')('S2C_A')?.granuleId).toBe('S2C_A');
  });

  it('⚠ reports a cached miss as undefined, not as an empty manifest', () => {
    // `bodyStatsIn` on an empty manifest would say "this pass did not reach the lake", which is a
    // different and much stronger claim than "we have not looked yet".
    serve({});
    return loadFrameStats(BASE, 'winter-2025-26', 'S2C_A').then(() => {
      expect(statsLookup(BASE, 'winter-2025-26')('S2C_A')).toBeUndefined();
    });
  });
});

describe('loadSeasonIndex', () => {
  it('reads the season the pointer named', async () => {
    serve({
      [`${BASE}/index/winter-2025-26.json`]: {
        season: 'winter-2025-26',
        frames: [],
        firstCapturedAt: null,
        lastCapturedAt: null,
      },
    });
    await expect(loadSeasonIndex(BASE, 'winter-2025-26')).resolves.toMatchObject({
      season: 'winter-2025-26',
    });
  });
});

describe('prefetchFrames — warming, not downloading', () => {
  it('⚠ asks for a header range rather than the whole frame', () => {
    // A frame is ~700 KB and a season is thousands of them. The first range read of any pmtiles is
    // its header and directory, and that read is what a cold tile request waits for — so a few KB
    // per frame buys most of the latency back without pulling hundreds of megabytes.
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
      }),
    );

    return prefetchFrames(BASE, ['frames/w/a.pmtiles']).then(() => {
      expect(calls[0]?.[0]).toBe(`${BASE}/frames/w/a.pmtiles`);
      expect((calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Range).toBe(
        'bytes=0-16383',
      );
    });
  });

  it('stops early when aborted, so it cannot outlive the lake it was for', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await prefetchFrames(BASE, ['a', 'b', 'c', 'd'], controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure, because a warm that did not warm costs nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    await expect(prefetchFrames(BASE, ['a'])).resolves.toBeUndefined();
  });
});
