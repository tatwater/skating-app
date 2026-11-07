import { type PanelDay, weatherTimelineModel } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { forecastPlan, timelineDays } from './weatherFixtures';
import {
  dayOfMonth,
  dayShortName,
  dayTotals,
  hourAmount,
  hourWind,
  monthOf,
  monthSpan,
  SENTENCE_DAYS,
  SENTENCE_DAYS_TIP,
  selectedPlace,
  sentenceRows,
  showWeatherAt,
  TEMPERATURE_TICKS_F,
  temperatureTickY,
  WHOLE_LAKE,
  weatherPlaces,
  weatherSamplesOverlay,
} from './weatherModel';

const bayArb = fc.record({
  _id: fc.string({ minLength: 1, maxLength: 6 }),
  name: fc.string({ maxLength: 12 }),
  removed: fc.option(fc.boolean(), { nil: undefined }),
});

describe('"Weather at" (c-9vdox9)', () => {
  it('appears if and only if the lake has two or more sample points', () => {
    fc.assert(
      fc.property(fc.option(fc.array(bayArb, { maxLength: 6 }), { nil: undefined }), (bays) => {
        const places = weatherPlaces(bays);
        const live = (bays ?? []).filter((b) => b.removed !== true).length;
        // Every place is one sample point: the lake's own, then one per live bay.
        expect(places).toHaveLength(1 + live);
        expect(showWeatherAt(places)).toBe(places.length >= 2);
        expect(showWeatherAt(places)).toBe(live >= 1);
      }),
    );
  });

  it('puts the whole lake first, then the live bays in order', () => {
    expect(
      weatherPlaces([
        { _id: 'a', name: 'North' },
        { _id: 'b', name: 'Gone', removed: true },
        { _id: 'c', name: 'South' },
      ]),
    ).toEqual([WHOLE_LAKE, { id: 'a', name: 'North' }, { id: 'c', name: 'South' }]);
    expect(showWeatherAt(weatherPlaces(undefined))).toBe(false);
  });

  it('reads the bay in view, else the whole lake — never a stale or foreign id', () => {
    const places = weatherPlaces([{ _id: 'a', name: 'North' }]);
    expect(selectedPlace(places, 'a')).toEqual({ id: 'a', name: 'North' });
    expect(selectedPlace(places, 'zzz')).toBe(WHOLE_LAKE);
    expect(selectedPlace(places, undefined)).toBe(WHOLE_LAKE);
  });
});

describe('the sample points on the map (board 1.7)', () => {
  const lake = {
    _id: 'mascoma',
    centroid: { lat: 43.6, lng: -72.2 },
    interiorPoint: { lat: 43.61, lng: -72.14 },
  };
  const bays = [
    { _id: 'n', name: 'Mascoma North', centroid: { lat: 43.63, lng: -72.15 } },
    { _id: 's', name: 'Mascoma South', centroid: { lat: 43.59, lng: -72.13 }, removed: false },
    { _id: 'gone', name: 'Old Bay', centroid: { lat: 0, lng: 0 }, removed: true },
  ];
  const points = (overlay: ReturnType<typeof weatherSamplesOverlay>) =>
    overlay?.data.features.map((f) => ({
      name: f.properties?.name,
      lit: f.properties?.lit,
      at: (f.geometry as GeoJSON.Point).coordinates,
    }));

  it('rings the whole lake at its weather anchor and each live bay at its own point', () => {
    expect(points(weatherSamplesOverlay(lake, bays, undefined))).toEqual([
      { name: 'Whole lake', lit: true, at: [-72.14, 43.61] },
      { name: 'Mascoma North', lit: false, at: [-72.15, 43.63] },
      { name: 'Mascoma South', lit: false, at: [-72.13, 43.59] },
    ]);
  });

  it('lights the bay being read, and keys the overlay on it', () => {
    const lake0 = weatherSamplesOverlay(lake, bays, undefined);
    const north = weatherSamplesOverlay(lake, bays, 'n');
    expect(
      points(north)
        ?.filter((p) => p.lit)
        .map((p) => p.name),
    ).toEqual(['Mascoma North']);
    expect(north?.key).not.toBe(lake0?.key);
  });

  it('draws nothing for a lake with one point, and leaves off a bay with no point', () => {
    expect(weatherSamplesOverlay(lake, [], undefined)).toBeNull();
    expect(weatherSamplesOverlay(lake, undefined, undefined)).toBeNull();
    const partial = weatherSamplesOverlay(lake, [{ _id: 'x', name: 'X' } as never], undefined);
    expect(points(partial)?.map((p) => p.name)).toEqual(['Whole lake']);
  });
});

describe('sentenceRows — the "last 10 days" window', () => {
  const row = (dayMs: number): PanelDay => ({ dayMs, localDate: `d${dayMs}` });

  it('takes the last N days before today, plus today only when the archive holds it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 14 }),
        fc.boolean(),
        (count, days, endsToday) => {
          const today = 1000;
          const rows = Array.from({ length: count }, (_, i) =>
            row(today - (count - 1 - i) - (endsToday ? 0 : 1)),
          );
          const out = sentenceRows(rows, today, days);
          const before = out.filter((r) => r !== null && r.dayMs < today);
          expect(before).toHaveLength(Math.min(days, endsToday ? Math.max(0, count - 1) : count));
          expect(out.some((r) => r?.dayMs === today)).toBe(endsToday && count > 0);
          // Always the newest rows, in order.
          expect(out).toEqual(rows.slice(rows.length - out.length));
        },
      ),
    );
  });

  it('survives a hole (null) at the end', () => {
    expect(sentenceRows([row(1), null], 5, 1)).toEqual([null]);
  });

  it('says what it counts', () => {
    expect(SENTENCE_DAYS).toBe(10);
    expect(SENTENCE_DAYS_TIP).toBe(
      'The 10 full days before today. Today is still in progress and is not counted.',
    );
  });
});

describe('the chart furniture', () => {
  const model = weatherTimelineModel({ days: timelineDays(), width: 344, height: 240 });

  it('puts the 32° rule exactly where core draws freezing', () => {
    const layer = model?.temperature;
    if (!layer) throw new Error('expected a temperature layer');
    expect(temperatureTickY(layer, 32)).toBeCloseTo(layer.freezeY, 6);
    expect(TEMPERATURE_TICKS_F).toEqual([40, 32, 20, 0]);
    // A tick outside the window draws nothing.
    expect(temperatureTickY(layer, layer.maxF + 1)).toBeNull();
    expect(temperatureTickY(layer, layer.minF - 1)).toBeNull();
    // Warmer is higher.
    expect(temperatureTickY(layer, 20)).toBeGreaterThan(temperatureTickY(layer, 32) as number);
  });

  it('reads months and days from the lake-local date string', () => {
    expect(monthOf('2027-01-16')).toBe('January');
    expect(monthOf('2026-12-31')).toBe('December');
    expect(monthOf('nope')).toBe('');
    expect(dayOfMonth('2027-01-06')).toBe('6');
    expect(dayOfMonth('nope')).toBe('nope');
    expect(monthSpan(['2027-01-06', '2027-01-07'])).toBe('January');
    expect(monthSpan(['2026-12-30', '2027-01-02'])).toBe('December – January');
    expect(monthSpan([])).toBe('');
  });
});

describe('the forecast cards', () => {
  const plan = forecastPlan();
  const first = plan.hours[0];
  if (!first) throw new Error('expected hours');

  it('names one amount per hour, snow first', () => {
    expect(hourAmount({ ...first, snowfallIn: 0.4, rainIn: 0.2 })).toEqual({
      text: '0.4″',
      snow: true,
    });
    expect(hourAmount({ ...first, snowfallIn: 0, rainIn: 0.02 })).toEqual({
      text: '0.02″',
      snow: false,
    });
    expect(hourAmount({ ...first, snowfallIn: 0.05, rainIn: 0.005 })).toBeNull();
  });

  it('says where the wind comes from, and how hard', () => {
    expect(hourWind({ ...first, windDirectionDeg: 315, windMph: 9 })).toBe('NW 9');
    const { windDirectionDeg: _, ...noDir } = first;
    expect(hourWind({ ...noDir, windMph: 4 })).toBe('4');
  });

  it("totals a day's snow, rain and wind", () => {
    const day = plan.days[0];
    if (!day) throw new Error('expected a day');
    expect(dayTotals({ ...day, snowfallIn: 3, rainIn: 0.1, maxWindMph: 12 })).toEqual([
      '3″ snow',
      '0.1″ rain',
      'wind 12 mph',
    ]);
    expect(dayTotals({ ...day, snowfallIn: 0, rainIn: 0, maxWindMph: 5 })).toEqual(['wind 5 mph']);
    expect(dayShortName({ ...day, dateLabel: 'Sat 16' })).toBe('Sat');
  });
});
