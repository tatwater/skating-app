import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import {
  GEOCODE_MAX_CHARS,
  GEOCODE_MAX_SUGGESTIONS,
  type GeocoderAdapter,
  geoapifyGeocoder,
  suggestWith,
} from './lib/geocoder';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const ADDRESS = '14 School Street, Hanover';

/** The shape of Geoapify's `format=json` answer, trimmed to the fields read, for public addresses. */
const GEOAPIFY = {
  results: [
    {
      formatted: '1 South Main Street, Hanover, NH 03755, United States of America',
      lat: 43.702264,
      lon: -72.28973,
      result_type: 'building',
      country_code: 'us',
    },
    {
      formatted: '121 Main Street, Silver Creek, NY 14136, United States of America',
      lat: 42.536833,
      lon: -79.17113,
      result_type: 'building',
      country_code: 'us',
    },
  ],
  query: { text: '1 Main Street' },
};

function stubFetch(status: number, body: unknown = GEOAPIFY) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const warn = vi.spyOn(console, 'warn');

beforeEach(() => {
  vi.stubEnv('GEOAPIFY_API_KEY', 'test-key');
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

  // Geoapify is switched on (founder, 2026-11-07), but no account exists until its key is set.
  test('sends no address anywhere while the provider key is unset', async () => {
    vi.stubEnv('GEOAPIFY_API_KEY', '');
    const t = convexTest(schema, modules);
    const fetchMock = stubFetch(200);
    const skater = t.withIdentity({ subject: 'skater' });
    for (const text of [ADDRESS, '']) {
      expect(await skater.action(api.geocode.suggest, { text })).toEqual({
        status: 'unavailable',
        reason: 'off',
        suggestions: [],
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expectAddressNotLogged();
  });

  test('asks Geoapify once its key is set', async () => {
    const t = convexTest(schema, modules);
    const fetchMock = stubFetch(200);
    const result = await t
      .withIdentity({ subject: 'skater' })
      .action(api.geocode.suggest, { text: ADDRESS });
    expect(result).toMatchObject({ status: 'ok', attribution: geoapifyGeocoder.attribution });
    expect(result.suggestions).toHaveLength(2);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url.startsWith('https://api.geoapify.com/v1/geocode/autocomplete?')).toBe(true);
  });
});

describe('suggestWith the Geoapify adapter', () => {
  test('returns label and coordinate, latitude and longitude the right way round', async () => {
    stubFetch(200);
    expect(await suggestWith(geoapifyGeocoder, ADDRESS)).toEqual({
      status: 'ok',
      attribution: 'Powered by Geoapify | © OpenStreetMap contributors',
      suggestions: [
        {
          label: '1 South Main Street, Hanover, NH 03755, United States of America',
          lat: 43.702264,
          lng: -72.28973,
        },
        {
          label: '121 Main Street, Silver Creek, NY 14136, United States of America',
          lat: 42.536833,
          lng: -79.17113,
        },
      ],
    });
  });

  test('asks for US addresses as JSON and sends no home to bias toward', async () => {
    const fetchMock = stubFetch(200);
    await suggestWith(geoapifyGeocoder, `  ${ADDRESS}  `);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URL(url);
    expect(`${sent.origin}${sent.pathname}`).toBe(
      'https://api.geoapify.com/v1/geocode/autocomplete',
    );
    expect(sent.searchParams.get('text')).toBe(ADDRESS);
    expect(sent.searchParams.get('filter')).toBe('countrycode:us');
    expect(sent.searchParams.get('format')).toBe('json');
    expect(sent.searchParams.get('limit')).toBe(String(GEOCODE_MAX_SUGGESTIONS));
    expect(sent.searchParams.get('apiKey')).toBe('test-key');
    // Nothing that ranks or filters by a place: the only place we know is the skater's home (D11).
    expect([...sent.searchParams.keys()].sort()).toEqual(
      ['apiKey', 'filter', 'format', 'lang', 'limit', 'text'].sort(),
    );
    expect(init.headers).toEqual({});
  });

  test('too short a query costs no quota', async () => {
    const fetchMock = stubFetch(200);
    const result = await suggestWith(geoapifyGeocoder, ' 14 ');
    expect(result).toMatchObject({ status: 'ok', suggestions: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a very long query is cut before it is sent', async () => {
    const fetchMock = stubFetch(200);
    await suggestWith(geoapifyGeocoder, 'x'.repeat(GEOCODE_MAX_CHARS + 50));
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('text')).toHaveLength(GEOCODE_MAX_CHARS);
  });

  test('never hands back more than the bound', async () => {
    const result0 = GEOAPIFY.results[0];
    stubFetch(200, {
      results: Array.from({ length: GEOCODE_MAX_SUGGESTIONS + 3 }, () => result0),
    });
    const result = await suggestWith(geoapifyGeocoder, ADDRESS);
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
      expect(await suggestWith(geoapifyGeocoder, ADDRESS)).toEqual({
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
    expect((await suggestWith(geoapifyGeocoder, ADDRESS)).status).toBe('ok');
    stubFetch(403);
    expect(await suggestWith(geoapifyGeocoder, ADDRESS)).toEqual({
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
    expect(await suggestWith(geoapifyGeocoder, ADDRESS)).toEqual({
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
    expect(await suggestWith(geoapifyGeocoder, ADDRESS)).toMatchObject({ reason: 'error' });
  });

  test('with no key it sends nothing and reads as off', async () => {
    vi.stubEnv('GEOAPIFY_API_KEY', '');
    const fetchMock = stubFetch(200);
    expect(await suggestWith(geoapifyGeocoder, ADDRESS)).toEqual({
      status: 'unavailable',
      reason: 'off',
      suggestions: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expectAddressNotLogged();
  });

  test('the adapter drops anything it cannot trust, and survives a strange shape', () => {
    const result = (lon: unknown, lat: unknown, formatted: unknown = 'Somewhere') => ({
      formatted,
      lat,
      lon,
    });
    expect(
      geoapifyGeocoder.parse({
        results: [
          result(200, 44),
          result(-72, 95),
          result('-72', 44),
          result(-72, undefined),
          result(Number.NaN, 44),
          result(-72, 44, ''),
          result(-72, 44, 7),
          null,
          {},
          result(-72.5, 44.5),
        ],
      }),
    ).toEqual([{ label: 'Somewhere', lat: 44.5, lng: -72.5 }]);
    for (const body of [null, 'text', {}, { results: 'none' }, { features: [] }]) {
      expect(geoapifyGeocoder.parse(body)).toEqual([]);
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
