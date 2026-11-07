import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import {
  GEOCODE_MAX_CHARS,
  GEOCODE_MAX_SUGGESTIONS,
  type GeocoderAdapter,
  orsGeocoder,
  suggestWith,
} from './lib/geocoder';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const ADDRESS = '14 School Street, Hanover';

/** Trimmed from a real ORS answer (2026-11-07), for a public address. */
const PELIAS = {
  type: 'FeatureCollection',
  geocoding: { attribution: 'https://openrouteservice.org/terms-of-service/#attribution-geocode' },
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-72.28973, 43.702264] },
      properties: {
        label: '1 South Main Street, Hanover, NH, USA',
        layer: 'address',
        source: 'openstreetmap',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-79.17113, 42.536833] },
      properties: { label: '121 Main Street, Silver Creek, NY, USA', layer: 'address' },
    },
  ],
};

function stubFetch(status: number, body: unknown = PELIAS) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const warn = vi.spyOn(console, 'warn');

beforeEach(() => {
  vi.stubEnv('ORS_API_KEY', 'test-key');
  warn.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Nothing the module printed may contain any of the address. */
function expectAddressNotLogged() {
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain('School');
  expect(logged).not.toContain('Hanover');
}

describe('geocode.suggest', () => {
  test('refuses a caller who is not signed in', async () => {
    const t = convexTest(schema, modules);
    const fetchMock = stubFetch(200);
    await expect(t.action(api.geocode.suggest, { text: ADDRESS })).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The pin on the open founder call. When a provider is switched on, this is the test to change.
  test('sends no address anywhere until a provider is switched on', async () => {
    const t = convexTest(schema, modules);
    const fetchMock = stubFetch(200);
    const result = await t
      .withIdentity({ subject: 'skater' })
      .action(api.geocode.suggest, { text: ADDRESS });
    expect(result).toEqual({ status: 'unavailable', reason: 'off', suggestions: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('suggestWith the ORS adapter', () => {
  test('returns label and coordinate, latitude and longitude the right way round', async () => {
    stubFetch(200);
    expect(await suggestWith(orsGeocoder, ADDRESS)).toEqual({
      status: 'ok',
      attribution: '© openrouteservice by HeiGIT | Data from OpenStreetMap',
      suggestions: [
        { label: '1 South Main Street, Hanover, NH, USA', lat: 43.702264, lng: -72.28973 },
        { label: '121 Main Street, Silver Creek, NY, USA', lat: 42.536833, lng: -79.17113 },
      ],
    });
  });

  test('asks for US addresses, keeps the key in a header, and sends no home to focus on', async () => {
    const fetchMock = stubFetch(200);
    await suggestWith(orsGeocoder, `  ${ADDRESS}  `);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URL(url);
    expect(`${sent.origin}${sent.pathname}`).toBe(
      'https://api.openrouteservice.org/geocode/autocomplete',
    );
    expect(sent.searchParams.get('text')).toBe(ADDRESS);
    expect(sent.searchParams.get('boundary.country')).toBe('USA');
    expect(sent.searchParams.get('size')).toBe(String(GEOCODE_MAX_SUGGESTIONS));
    expect([...sent.searchParams.keys()].some((key) => key.startsWith('focus'))).toBe(false);
    expect(url).not.toContain('test-key');
    expect(init.headers).toEqual({ Authorization: 'test-key' });
  });

  test('too short a query costs no quota', async () => {
    const fetchMock = stubFetch(200);
    const result = await suggestWith(orsGeocoder, ' 14 ');
    expect(result).toMatchObject({ status: 'ok', suggestions: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a very long query is cut before it is sent', async () => {
    const fetchMock = stubFetch(200);
    await suggestWith(orsGeocoder, 'x'.repeat(GEOCODE_MAX_CHARS + 50));
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('text')).toHaveLength(GEOCODE_MAX_CHARS);
  });

  test('never hands back more than the bound', async () => {
    const feature = PELIAS.features[0];
    stubFetch(200, {
      features: Array.from({ length: GEOCODE_MAX_SUGGESTIONS + 3 }, () => feature),
    });
    const result = await suggestWith(orsGeocoder, ADDRESS);
    expect(result.suggestions).toHaveLength(GEOCODE_MAX_SUGGESTIONS);
  });

  test.each([
    [403, 'quota'],
    [429, 'quota'],
    [500, 'error'],
    [401, 'error'],
  ])(
    'a %i is reported as %s, with no suggestions and no address in the log',
    async (status, reason) => {
      stubFetch(status, { error: 'Quota exceeded' });
      expect(await suggestWith(orsGeocoder, ADDRESS)).toEqual({
        status: 'unavailable',
        reason,
        suggestions: [],
      });
      expect(warn).toHaveBeenCalled();
      expectAddressNotLogged();
    },
  );

  test('a refusal after a good answer is a refusal: nothing is served from before', async () => {
    stubFetch(200);
    expect((await suggestWith(orsGeocoder, ADDRESS)).status).toBe('ok');
    stubFetch(403);
    expect(await suggestWith(orsGeocoder, ADDRESS)).toEqual({
      status: 'unavailable',
      reason: 'quota',
      suggestions: [],
    });
  });

  test('a network failure is an error, and its text is not printed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`fetch failed for ?text=${encodeURIComponent(ADDRESS)}`);
      }),
    );
    expect(await suggestWith(orsGeocoder, ADDRESS)).toEqual({
      status: 'unavailable',
      reason: 'error',
      suggestions: [],
    });
    expectAddressNotLogged();
  });

  test('a body that is not JSON is an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 200 })),
    );
    expect(await suggestWith(orsGeocoder, ADDRESS)).toMatchObject({ reason: 'error' });
  });

  test('with no key it sends nothing and says so', async () => {
    vi.stubEnv('ORS_API_KEY', '');
    const fetchMock = stubFetch(200);
    expect(await suggestWith(orsGeocoder, ADDRESS)).toMatchObject({ reason: 'error' });
    expect(fetchMock).not.toHaveBeenCalled();
    expectAddressNotLogged();
  });

  test('the adapter drops anything it cannot trust, and survives a strange shape', () => {
    const point = (coordinates: unknown, label: unknown = 'Somewhere') => ({
      geometry: { coordinates },
      properties: { label },
    });
    expect(
      orsGeocoder.parse({
        features: [
          point([200, 44]),
          point([-72, 95]),
          point(['-72', 44]),
          point([-72]),
          point('here'),
          point([-72, 44], ''),
          point([-72, 44], 7),
          null,
          {},
          point([-72.5, 44.5]),
        ],
      }),
    ).toEqual([{ label: 'Somewhere', lat: 44.5, lng: -72.5 }]);
    for (const body of [null, 'text', {}, { features: 'none' }]) {
      expect(orsGeocoder.parse(body)).toEqual([]);
    }
  });
});

describe('suggestWith, for any adapter', () => {
  test('the bound holds whatever an adapter returns', async () => {
    stubFetch(200, {});
    const adapter: GeocoderAdapter = {
      attribution: 'x',
      request: () => ({ url: 'https://example.test/', headers: {} }),
      parse: () => Array.from({ length: 9 }, () => ({ label: 'a', lat: 1, lng: 1 })),
    };
    expect((await suggestWith(adapter, ADDRESS)).suggestions).toHaveLength(GEOCODE_MAX_SUGGESTIONS);
  });
});
