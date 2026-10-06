import { describe, expect, it, vi } from 'vitest';
import { type FetchLike, MAX_STAC_PAGES, searchStac, stacDayRange } from './stacSearch';

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

const search = {
  collection: 'sentinel-2-l2a',
  bbox: [-75, 42, -67, 47] as const,
  datetime: stacDayRange('2026-10-03', '2026-10-06'),
};

describe('searchStac', () => {
  it('follows both shapes of `next` link — a POST body and a bare GET href', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/search') && fetchFn.mock.calls.length === 1) {
        return ok({
          features: [
            {
              id: 'S2C_19TEM_20261005_0_L2A',
              properties: { datetime: '2026-10-05T15:30:00Z', 'eo:cloud_cover': 12 },
              geometry: { type: 'Polygon', coordinates: [] },
            },
          ],
          links: [{ rel: 'next', href: 'https://stac.test/search', body: { token: 'a' } }],
        });
      }
      if (url === 'https://stac.test/search') {
        return ok({
          features: [
            {
              id: 'S1A_IW_GRDH_1SDV_20261006T224512_20261006T224537_05A1B2_06C3D4',
              properties: { datetime: '2026-10-06T22:45:12Z', 'sat:orbit_state': 'ascending' },
            },
          ],
          links: [{ rel: 'next', href: 'https://stac.test/search?token=b' }],
        });
      }
      return ok({ features: [], links: [{ rel: 'self', href: url }] });
    });

    const { items, pages } = await searchStac(fetchFn, search, 'https://stac.test');
    expect(pages).toBe(3);
    expect(items).toEqual([
      {
        id: 'S2C_19TEM_20261005_0_L2A',
        datetime: '2026-10-05T15:30:00Z',
        cloudCoverPct: 12,
        footprint: { type: 'Polygon', coordinates: [] },
      },
      {
        id: 'S1A_IW_GRDH_1SDV_20261006T224512_20261006T224537_05A1B2_06C3D4',
        datetime: '2026-10-06T22:45:12Z',
        orbitDirection: 'ascending',
      },
    ]);
    const [, firstInit] = fetchFn.mock.calls[0] as Parameters<FetchLike>;
    expect(JSON.parse(firstInit?.body as string)).toEqual({
      collections: ['sentinel-2-l2a'],
      bbox: [-75, 42, -67, 47],
      datetime: '2026-10-03T00:00:00Z/2026-10-06T23:59:59Z',
      limit: 250,
    });
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe('POST');
    // The bare href is a GET, not a POST with no body — the truncation this guards against.
    expect(fetchFn.mock.calls[2]?.[1]).toBeUndefined();
  });

  it('throws on a failed page', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 503,
      statusText: 'Busy',
      json: async () => ({}),
    });
    await expect(searchStac(fetchFn, search)).rejects.toThrow('STAC search failed: 503 Busy');
  });

  it('refuses to follow a `next` chain forever', async () => {
    const fetchFn: FetchLike = async () =>
      ok({ features: [], links: [{ rel: 'next', href: 'https://stac.test/again' }] });
    await expect(searchStac(fetchFn, search)).rejects.toThrow(`after ${MAX_STAC_PAGES} pages`);
  });
});
