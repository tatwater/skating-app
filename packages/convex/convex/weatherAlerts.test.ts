import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { alertFromFeature } from './weatherAlerts';

const modules = import.meta.glob('./**/*.*s');

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  states: string[],
): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      searchText: 'Test Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01),
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44.0, lng: -72.0 },
      states,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

/** One NWS GeoJSON feature, in the shape their `/alerts/active` actually returns. */
function feature(over: Record<string, unknown> = {}) {
  return {
    properties: {
      id: 'urn:oid:2.49.0.1.840.0.abc',
      event: 'Winter Storm Warning',
      headline: 'Winter Storm Warning issued January 15 at 3:00AM EST',
      severity: 'Severe',
      areaDesc: 'Northern Vermont',
      onset: '2026-01-15T08:00:00-05:00',
      ends: '2026-01-16T02:00:00-05:00',
      affectedZones: ['https://api.weather.gov/zones/forecast/VTZ001'],
      geocode: { UGC: ['VTZ001'], SAME: ['050007'] },
      ...over,
    },
  };
}

function alertsResponse(features: unknown[]) {
  return new Response(JSON.stringify({ features }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('alertFromFeature', () => {
  test('collects both id spaces, because some products are issued by county', () => {
    const alert = alertFromFeature(feature(), 'VT');
    expect(alert?.zones).toEqual(expect.arrayContaining(['VTZ001', '050007']));
  });

  test('parses onset and end into epoch ms', () => {
    const alert = alertFromFeature(feature(), 'VT');
    expect(alert?.onsetMs).toBe(Date.parse('2026-01-15T08:00:00-05:00'));
    expect(alert?.endsMs).toBe(Date.parse('2026-01-16T02:00:00-05:00'));
  });

  test('falls back to `expires` when NWS omits `ends`', () => {
    const alert = alertFromFeature(
      feature({ ends: undefined, expires: '2026-01-16T05:00:00-05:00' }),
      'VT',
    );
    expect(alert?.endsMs).toBe(Date.parse('2026-01-16T05:00:00-05:00'));
  });

  test('refuses a feature with no id or no event rather than storing a blank', () => {
    expect(alertFromFeature(feature({ id: undefined }), 'VT')).toBeNull();
    expect(alertFromFeature(feature({ event: undefined }), 'VT')).toBeNull();
  });

  test('defaults an absent severity to Unknown rather than dropping the alert', () => {
    expect(alertFromFeature(feature({ severity: undefined }), 'VT')?.severity).toBe('Unknown');
  });
});

describe('weatherAlerts.refreshAlerts', () => {
  test('polls each covered state once and stores the relevant alerts', async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn(async () => alertsResponse([feature()]));
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.weatherAlerts.refreshAlerts, {});

    expect(fetchMock).toHaveBeenCalledTimes(5); // NY, VT, NH, ME, MA
    const rows = await t.run((ctx) => ctx.db.query('weatherAlerts').collect());
    expect(rows).toHaveLength(5);
    expect(rows[0]?.event).toBe('Winter Storm Warning');
  });

  test('drops alerts a skater has no use for', async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        alertsResponse([
          feature({ event: 'Red Flag Warning' }),
          feature({ event: 'Heat Advisory' }),
        ]),
      ),
    );

    await t.action(internal.weatherAlerts.refreshAlerts, {});

    expect(await t.run((ctx) => ctx.db.query('weatherAlerts').collect())).toHaveLength(0);
  });

  /**
   * The failure direction that matters. If a provider blip cleared a state's rows, every skater in
   * that state would see "no alerts" during exactly the storm the alert was issued for.
   */
  test('a state that fails keeps the alerts it already had', async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => alertsResponse([feature()])),
    );
    await t.action(internal.weatherAlerts.refreshAlerts, {});
    expect(await t.run((ctx) => ctx.db.query('weatherAlerts').collect())).toHaveLength(5);

    // Now every state 500s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await t.action(internal.weatherAlerts.refreshAlerts, {});

    expect(await t.run((ctx) => ctx.db.query('weatherAlerts').collect())).toHaveLength(5);
  });

  test('replaces a state’s set rather than accumulating duplicates across polls', async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => alertsResponse([feature()])),
    );
    await t.action(internal.weatherAlerts.refreshAlerts, {});
    await t.action(internal.weatherAlerts.refreshAlerts, {});

    expect(await t.run((ctx) => ctx.db.query('weatherAlerts').collect())).toHaveLength(5);
  });

  test('identifies itself, because NWS blocks a generic agent', async () => {
    const t = convexTest(schema, modules);
    // Typed with the params it is actually called with, so `mock.calls` is not an empty tuple.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => alertsResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.weatherAlerts.refreshAlerts, {});

    const init = fetchMock.mock.calls[0]?.[1];
    const agent = (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
    expect(agent).toBeTruthy();
    expect(agent).toContain('@');
  });
});

describe('weatherAlerts.listForBody', () => {
  test('serves the alerts for a body’s state, most severe first', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t, ['VT']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        alertsResponse([
          feature({ id: 'minor', event: 'Wind Chill Advisory', severity: 'Minor' }),
          feature({ id: 'severe', event: 'Ice Storm Warning', severity: 'Severe' }),
        ]),
      ),
    );
    await t.action(internal.weatherAlerts.refreshAlerts, {});

    const alerts = await t.query(api.weatherAlerts.listForBody, { waterBodyId });

    expect(alerts.map((a) => a.event)).toEqual(['Ice Storm Warning', 'Wind Chill Advisory']);
  });

  test('a body in a state with no alerts gets an empty list, so the strip renders nothing', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t, ['VT']);
    expect(await t.query(api.weatherAlerts.listForBody, { waterBodyId })).toEqual([]);
  });

  test('a removed body serves nothing', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t, ['VT']);
    await t.run((ctx) => ctx.db.patch(waterBodyId, { removedAt: Date.now() }));
    expect(await t.query(api.weatherAlerts.listForBody, { waterBodyId })).toEqual([]);
  });
});
