import { afterEach, describe, expect, it, vi } from 'vitest';

import { MASCOMA_BOUNDS } from '../frame/bodyFixtures';
import {
  AERIAL_PAINT,
  aerialCredit,
  aerialDate,
  aerialMasks,
  consoleAerialAnchor,
  creditPoint,
  forgetAerialDates,
} from './consoleAerial';
import { glLayerIds } from './glLayers';

afterEach(() => forgetAerialDates());

describe('where the summer aerial goes', () => {
  const ours = glLayerIds();

  it('at the console’s raster band: over the fills, under the fields and every line', () => {
    const order = ['water', 'roads_minor', ...ours];
    const anchor = consoleAerialAnchor(order) as string;
    const at = order.indexOf(anchor);
    expect(order.slice(0, at)).toEqual(
      expect.arrayContaining(['body-console-fill-body', 'body-console-fill-footprint']),
    );
    expect(anchor).toBe('body-console-field-dots');
    expect(order.slice(at)).toContain('body-console-outline-body');
  });

  it('under a winter pass already up (the newer, more specific picture)', () => {
    const order = [
      'water',
      ...ours.slice(0, 2),
      'freeze-up-frame-raster-companion-0',
      'freeze-up-frame-raster-0',
      ...ours.slice(2),
    ];
    expect(consoleAerialAnchor(order)).toBe('freeze-up-frame-raster-companion-0');
  });

  it('nowhere of its own before the console’s layers are in', () => {
    expect(consoleAerialAnchor(['water', 'roads_minor'])).toBeUndefined();
  });
});

describe('the photograph’s paint', () => {
  it('darkens it in the dark and lifts it in the light, both a step toward gray', () => {
    expect(AERIAL_PAINT.dark['raster-brightness-max']).toBeLessThan(0.5);
    expect(AERIAL_PAINT.dark['raster-brightness-min']).toBeUndefined();
    expect(AERIAL_PAINT.light['raster-brightness-min']).toBeGreaterThan(0.5);
    expect(AERIAL_PAINT.light['raster-brightness-max']).toBeUndefined();
    for (const mode of ['dark', 'light'] as const) {
      expect(AERIAL_PAINT[mode]['raster-saturation']).toBeLessThan(0);
    }
  });
});

describe('the reveal’s one “body”', () => {
  it('is the frame’s box, keyed by it, so another body redraws', () => {
    const [mask] = aerialMasks(MASCOMA_BOUNDS);
    expect(mask?.id).toBe(mask?.key);
    expect(mask?.mask.polygon.type).toBe('Polygon');
    const other = aerialMasks({ ...MASCOMA_BOUNDS, minLat: MASCOMA_BOUNDS.minLat - 0.01 });
    expect(other[0]?.key).not.toBe(mask?.key);
  });
});

describe('the credit', () => {
  it('names the program, and the month and year it was flown, in UTC', () => {
    expect(aerialCredit(null)).toBe('Aerial · NAIP');
    expect(aerialCredit(Date.UTC(2023, 5, 22))).toBe('Aerial · NAIP Jun 2023');
    // The last instant of a month in UTC is that month, whatever the reader's zone.
    expect(aerialCredit(Date.UTC(2023, 6, 31, 23, 59))).toBe('Aerial · NAIP Jul 2023');
    expect(aerialCredit(Number.NaN)).toBe('Aerial · NAIP');
  });

  it('asks one snapped point a frame, so two maps of one body share the answer', () => {
    expect(
      creditPoint({ minLng: -72.2835, maxLng: -72.2814, minLat: 44.2896, maxLat: 44.2913 }),
    ).toEqual({
      lat: 44.29,
      lng: -72.282,
    });
  });
});

describe('when the service says the photograph was taken', () => {
  const answer = {
    catalogItems: {
      features: [
        { attributes: { acquisition_date: null, raster_name: null } },
        {
          attributes: { acquisition_date: Date.UTC(2023, 5, 22), raster_name: 'm_x_030_20230622' },
        },
      ],
    },
  };
  const ok = (json: unknown) => ({ ok: true, json: async () => json }) as Response;

  it('reads the newest dated scene, and asks once a place', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => ok(answer));
    const at = { lat: 44.29, lng: -72.282 };
    await expect(aerialDate(at, fetcher)).resolves.toBe(Date.UTC(2023, 5, 22));
    await expect(aerialDate(at, fetcher)).resolves.toBe(Date.UTC(2023, 5, 22));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/identify?');
  });

  it('nothing dated there, or a refusal, is no date — never a guess', async () => {
    await expect(aerialDate({ lat: 1, lng: 1 }, async () => ok({}))).resolves.toBeNull();
    await expect(
      aerialDate({ lat: 2, lng: 2 }, async () => ({ ok: false }) as Response),
    ).resolves.toBeNull();
  });

  it('a failed ask is not remembered: the next map may ask again', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok(answer));
    const at = { lat: 43.6, lng: -72.1 };
    await expect(aerialDate(at, fetcher)).resolves.toBeNull();
    await expect(aerialDate(at, fetcher)).resolves.toBe(Date.UTC(2023, 5, 22));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
