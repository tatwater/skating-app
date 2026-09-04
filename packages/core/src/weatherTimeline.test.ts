import { describe, expect, it } from 'vitest';
import { dayMsToLocalDate, windSectorOf } from './weatherDay';
import {
  BAND_EDGE_DEEP_COLD_F,
  BAND_EDGE_FREEZING_F,
  BAND_EDGE_THAW_F,
  hourAtX,
  MIN_DAY_LABEL_WIDTH,
  MIN_SCROLL_THUMB_WIDTH,
  MIN_TEMPERATURE_SPAN_F,
  offsetAtTrackX,
  precipitationKind,
  TEMPERATURE_BANDS,
  type TimelineDayInput,
  type TimelineHour,
  temperatureBandOf,
  temperatureGradientStops,
  temperatureWindowF,
  timelineDaysFromArchive,
  timelineScrollbar,
  weatherTimelineModel,
} from './weatherTimeline';

const WIDTH = 336; // 7 days × 48px — a realistic sidebar plot width

function hour(localHour: number, over: Partial<TimelineHour> = {}): TimelineHour {
  return { localDate: '2026-01-15', localHour, temperatureC: -5, ...over };
}

function day(
  localDate: string,
  dayMs: number,
  hours: TimelineHour[] | null,
  over: Partial<TimelineDayInput> = {},
): TimelineDayInput {
  return {
    dayMs,
    localDate,
    ...(hours ? { hours: hours.map((h) => ({ ...h, localDate })) } : {}),
    ...over,
  };
}

const DAY_MS = 86_400_000;
const D0 = Date.UTC(2026, 0, 15);

/** A full 24-hour day at a constant temperature, with optional per-hour overrides. */
function fullDay(
  localDate: string,
  dayMs: number,
  tempC: number,
  over: (h: number) => Partial<TimelineHour> = () => ({}),
): TimelineDayInput {
  return day(
    localDate,
    dayMs,
    Array.from({ length: 24 }, (_, h) => hour(h, { temperatureC: tempC, ...over(h) })),
  );
}

describe('the band scale', () => {
  // The calm and sunlit thresholds are *imported* from `weatherPanel`/`weatherDay` rather than
  // restated, so there is nothing left to pin within this package. The one duplication that remains
  // is the band edges, which cannot be imported because `@skating/design` is not a dependency of
  // core — that half is pinned from the design side, in `packages/design/src/chartWeather.test.ts`.
  it('orders the bands cold to warm, matching the scale the renderers index', () => {
    expect([...TEMPERATURE_BANDS]).toEqual(['deepCold', 'cold', 'thaw', 'warm']);
    expect(BAND_EDGE_DEEP_COLD_F).toBeLessThan(BAND_EDGE_FREEZING_F);
    expect(BAND_EDGE_FREEZING_F).toBeLessThan(BAND_EDGE_THAW_F);
  });
});

describe('temperatureBandOf', () => {
  it('puts each boundary in the colder band', () => {
    expect(temperatureBandOf(19.9)).toBe('deepCold');
    expect(temperatureBandOf(20)).toBe('cold');
    expect(temperatureBandOf(31.9)).toBe('cold');
    expect(temperatureBandOf(32)).toBe('thaw');
    expect(temperatureBandOf(39.9)).toBe('thaw');
    expect(temperatureBandOf(40)).toBe('warm');
  });
});

describe('temperatureWindowF', () => {
  it('always contains freezing, even for a week that never approached it', () => {
    const warm = temperatureWindowF([50, 55, 60]);
    expect(warm.minF).toBeLessThanOrEqual(BAND_EDGE_FREEZING_F);
    const cold = temperatureWindowF([-20, -15, -10]);
    expect(cold.maxF).toBeGreaterThanOrEqual(BAND_EDGE_FREEZING_F);
  });

  it('widens a flat week to the minimum span rather than amplifying noise', () => {
    // Three degrees of real variation must not fill the lane; that would draw a mountain range out
    // of a uniform week, making the chart loudest exactly when the weather was quietest.
    const { minF, maxF } = temperatureWindowF([29, 30, 31]);
    expect(maxF - minF).toBeGreaterThanOrEqual(MIN_TEMPERATURE_SPAN_F);
  });

  it('ignores non-finite values instead of poisoning the range', () => {
    const { minF, maxF } = temperatureWindowF([10, Number.NaN, 40]);
    expect(Number.isFinite(minF)).toBe(true);
    expect(Number.isFinite(maxF)).toBe(true);
    expect(minF).toBe(10);
    expect(maxF).toBe(40);
  });
});

describe('temperatureGradientStops', () => {
  it('puts a hard step at freezing — two stops sharing one offset', () => {
    const stops = temperatureGradientStops(0, 60);
    const shared = stops.filter((s) => s.offset === (60 - BAND_EDGE_FREEZING_F) / 60);
    expect(shared.map((s) => s.band)).toEqual(['thaw', 'cold']);
  });

  it('never paints a band the window did not reach', () => {
    // The bug this exists for: clamping an out-of-range edge to offset 1 painted `deepCold` at the
    // bottom of a lane whose coldest hour was 25°F.
    const stops = temperatureGradientStops(25, 45);
    expect(stops.map((s) => s.band)).not.toContain('deepCold');
  });

  it('collapses to a single band when the whole window sits inside one', () => {
    const stops = temperatureGradientStops(22, 30);
    expect(new Set(stops.map((s) => s.band))).toEqual(new Set(['cold']));
  });

  it('emits offsets in ascending order within [0, 1]', () => {
    const stops = temperatureGradientStops(-10, 55);
    expect(stops[0]?.offset).toBe(0);
    expect(stops[stops.length - 1]?.offset).toBe(1);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]?.offset).toBeGreaterThanOrEqual(stops[i - 1]?.offset as number);
      expect(stops[i]?.offset).toBeLessThanOrEqual(1);
    }
  });

  it('survives a zero-width window without dividing by zero', () => {
    const stops = temperatureGradientStops(32, 32);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.offset).toBe(0);
  });
});

describe('precipitationKind', () => {
  it('names sleet and freezing rain from the weather code', () => {
    expect(precipitationKind(hour(3, { weatherCode: 66, precipitationMm: 1 }))?.label).toBe(
      'Freezing rain',
    );
    expect(precipitationKind(hour(3, { weatherCode: 79, precipitationMm: 1 }))?.hatched).toBe(true);
    expect(precipitationKind(hour(3, { weatherCode: 73, precipitationMm: 1 }))?.fill).toBe('snow');
  });

  it('derives freezing rain without a weather code — the pre-N6h archive rows', () => {
    // Rows written before `weather_code` was requested must still draw the hatch: liquid arriving at
    // or below freezing is the one precipitation fact that changes a skating surface, and it was
    // always derivable.
    const derived = precipitationKind(
      hour(3, { temperatureC: -2, rainMm: 1.2, precipitationMm: 1.2 }),
    );
    expect(derived).toEqual({ fill: 'rain', hatched: true, label: 'Freezing rain' });
  });

  it('calls liquid above freezing plain rain', () => {
    const kind = precipitationKind(hour(3, { temperatureC: 4, rainMm: 2, precipitationMm: 2 }));
    expect(kind).toEqual({ fill: 'rain', hatched: false, label: 'Rain' });
  });

  it('scales snowfall to water-equivalent before applying the threshold', () => {
    // 0.3 cm of snow is ~3 mm of water. Comparing the centimetre figure against a millimetre floor
    // set the bar ten times too high and dropped most light snow.
    expect(precipitationKind(hour(3, { snowfallCm: 0.3 }))).not.toBeNull();
  });

  it('returns null for a dry hour', () => {
    expect(precipitationKind(hour(3))).toBeNull();
    expect(precipitationKind(hour(3, { precipitationMm: 0 }))).toBeNull();
  });

  it('falls through to the derivation for an unrecognised code rather than dropping the hour', () => {
    const kind = precipitationKind(
      hour(3, { weatherCode: 999, snowfallCm: 1, precipitationMm: 10 }),
    );
    expect(kind?.fill).toBe('snow');
  });
});

describe('weatherTimelineModel', () => {
  const week: TimelineDayInput[] = Array.from({ length: 7 }, (_, i) =>
    fullDay(`2026-01-${15 + i}`, D0 + i * DAY_MS, -5),
  );

  it('returns null rather than an empty chart when there is nothing to draw', () => {
    expect(weatherTimelineModel({ days: [], width: WIDTH })).toBeNull();
    expect(weatherTimelineModel({ days: week, width: 0 })).toBeNull();
  });

  it('gives every day an equal column and puts a divider between each pair', () => {
    const model = weatherTimelineModel({ days: week, width: WIDTH });
    expect(model?.days).toHaveLength(7);
    expect(model?.dividers).toHaveLength(6); // interior boundaries only, not the outer edges
    for (const d of model?.days ?? []) expect(d.width).toBeCloseTo(WIDTH / 7);
  });

  it('sorts days by key rather than trusting input order', () => {
    const shuffled = [week[3], week[0], week[6], week[1], week[2], week[5], week[4]].filter(
      (d): d is TimelineDayInput => d !== undefined,
    );
    const model = weatherTimelineModel({ days: shuffled, width: WIDTH });
    const keys = model?.days.map((d) => d.dayMs) ?? [];
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it('breaks the temperature path at a gap instead of drawing through it', () => {
    // The headline failure mode: one path through a hole is a confident straight line across weather
    // nobody observed, and it looks exactly like data.
    const withHole = [
      fullDay('2026-01-15', D0, -5),
      day('2026-01-16', D0 + DAY_MS, null, { missing: true }),
      fullDay('2026-01-17', D0 + 2 * DAY_MS, -5),
    ];
    const model = weatherTimelineModel({ days: withHole, width: WIDTH });
    expect(model?.temperature?.segments.length).toBe(2);
    expect(model?.days[1]?.missing).toBe(true);
  });

  it('keeps a partial day separate from settled days', () => {
    const days = [
      fullDay('2026-01-15', D0, -5),
      day(
        '2026-01-16',
        D0 + DAY_MS,
        Array.from({ length: 10 }, (_, h) => hour(h)),
        { partial: true },
      ),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.days[1]?.partial).toBe(true);
    expect(model?.temperature?.partialSegments.length).toBeGreaterThan(0);
  });

  it('confines a partial day to the left of its own column', () => {
    // Ten elapsed hours must occupy ~10/24 of the column, not stretch across all of it — otherwise
    // today reads as a finished day and its last reading lands under tomorrow's label.
    const days = [
      day(
        '2026-01-15',
        D0,
        Array.from({ length: 10 }, (_, h) => hour(h)),
        { partial: true },
      ),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    const lastX = model?.hours[model.hours.length - 1]?.x ?? 0;
    expect(lastX).toBeLessThan(WIDTH * (10 / 24));
  });

  it('drops the repeated hour on a fall-back DST night', () => {
    // Two 01:00s. The second is dropped so the day still spans exactly its column; positioning by
    // array index instead would make a 25-hour day wider than its neighbours and slide every
    // divider after it.
    const dst = day('2026-11-01', D0, [
      hour(0),
      hour(1, { temperatureC: -3 }),
      hour(1, { temperatureC: -4 }),
      hour(2),
    ]);
    const model = weatherTimelineModel({ days: [dst], width: WIDTH });
    expect(model?.hours).toHaveLength(3);
    expect(model?.hours.map((p) => p.hour.localHour)).toEqual([0, 1, 2]);
  });

  it('interpolates the missing hour on a spring-forward night without breaking the path', () => {
    // 02:00 does not exist on this date, so 01:00 and 03:00 are consecutive *real* hours. Breaking
    // here would draw a confident gap across weather that was fully observed — one night every
    // March, inside the season.
    const dst = day(
      '2026-03-08',
      D0,
      [0, 1, 3, 4, 5].map((h) => hour(h)),
    );
    const model = weatherTimelineModel({ days: [dst], width: WIDTH });
    expect(model?.temperature?.segments).toHaveLength(1);
  });

  it('still breaks on a hole too wide to be the DST hour', () => {
    // The other side of the same tolerance: two absent hours cannot be a clock change, so this is a
    // real absence and must not be smoothed over.
    const gappy = day(
      '2026-01-15',
      D0,
      [0, 1, 4, 5, 6].map((h) => hour(h)),
    );
    const model = weatherTimelineModel({ days: [gappy], width: WIDTH });
    expect(model?.temperature?.segments).toHaveLength(2);
  });

  it('ignores out-of-range hour values instead of positioning them outside the column', () => {
    const bad = day('2026-01-15', D0, [hour(0), hour(24), hour(-1)]);
    const model = weatherTimelineModel({ days: [bad], width: WIDTH });
    expect(model?.hours).toHaveLength(1);
  });

  it('always places the freezing rule inside the temperature lane', () => {
    for (const tempC of [-25, -5, 12]) {
      const model = weatherTimelineModel({
        days: [fullDay('2026-01-15', D0, tempC)],
        width: WIDTH,
      });
      const temp = model?.temperature;
      expect(temp?.freezeY).toBeGreaterThanOrEqual(temp?.box.top as number);
      expect(temp?.freezeY).toBeLessThanOrEqual(temp?.box.bottom as number);
    }
  });

  it('lays lanes out top to bottom without overlapping, inside the given height', () => {
    const model = weatherTimelineModel({ days: week, width: WIDTH, height: 240 });
    const boxes = model?.boxes;
    if (!boxes) throw new Error('expected a model');
    expect(boxes.temperature.top).toBeGreaterThanOrEqual(12);
    expect(boxes.temperature.bottom).toBeLessThanOrEqual(boxes.precipitation.top);
    expect(boxes.precipitation.bottom).toBeLessThanOrEqual(boxes.wind.top);
    expect(boxes.wind.bottom).toBeLessThanOrEqual(boxes.sun.top);
    expect(boxes.sun.bottom).toBeLessThanOrEqual(boxes.snowDepth.top);
    expect(boxes.snowDepth.bottom).toBeLessThanOrEqual(240);
  });

  it('rescales lanes to a shorter viewport rather than overflowing it', () => {
    const model = weatherTimelineModel({ days: week, width: WIDTH, height: 150 });
    expect(model?.boxes.snowDepth.bottom).toBeLessThanOrEqual(150);
    expect(model?.boxes.temperature.height).toBeGreaterThan(0);
  });

  it('emphasises calm freezing hours and nothing else in the wind lane', () => {
    const days = [
      fullDay('2026-01-15', D0, -5, (h) => ({
        // Hours 0–3 calm and freezing; 4–7 calm but mild; the rest windy.
        windSpeedKph: h < 8 ? 3 : 30,
        temperatureC: h < 4 ? -5 : 5,
      })),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.wind?.emphasis).toHaveLength(1);
    const span = model?.wind?.emphasis[0];
    // Four hours wide, drawn edge to edge rather than centre to centre.
    expect(span?.width).toBeCloseTo((WIDTH / 24) * 4);
    expect(span?.x).toBeCloseTo(0);
  });

  it('emphasises sunlit hours above freezing and nothing else in the sun lane', () => {
    const days = [
      fullDay('2026-01-15', D0, 2, (h) => ({
        shortwaveWm2: h >= 10 && h < 14 ? 300 : 10,
        // Sunny but below freezing at 10–11; sunny and above freezing at 12–13.
        temperatureC: h < 12 ? -2 : 3,
      })),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.sun?.emphasis).toHaveLength(1);
    expect(model?.sun?.emphasis[0]?.width).toBeCloseTo((WIDTH / 24) * 2);
  });

  it('returns null for an auxiliary lane nothing was observed for', () => {
    // A lane drawn flat along its baseline asserts a measured dead calm; an absent lane says we do
    // not know, which for `shortwave_radiation` on an older archive row is the truth.
    const model = weatherTimelineModel({ days: week, width: WIDTH });
    expect(model?.sun).toBeNull();
    expect(model?.wind).toBeNull();
    expect(model?.snowDepth).toBeNull();
  });

  it('draws precipitation blocks one hour wide, typed and labelled', () => {
    const days = [
      fullDay('2026-01-15', D0, -2, (h) =>
        h === 5 ? { snowfallCm: 2, precipitationMm: 20, weatherCode: 73 } : {},
      ),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.precipitation.blocks).toHaveLength(1);
    const block = model?.precipitation.blocks[0];
    expect(block?.fill).toBe('snow');
    expect(block?.label).toBe('Snow');
    expect(block?.width).toBeCloseTo(WIDTH / 24);
    expect(block?.snowfallCm).toBe(2);
  });

  it('never emits a bare moveto for a lone observed hour', () => {
    // A single hour would otherwise draw nothing at all, which reads exactly like a gap.
    const model = weatherTimelineModel({
      days: [day('2026-01-15', D0, [hour(12)])],
      width: WIDTH,
    });
    const path = model?.temperature?.segments[0] ?? '';
    expect(path).toMatch(/^M .* L /);
  });
});

describe('hourAtX', () => {
  const model = weatherTimelineModel({
    days: [fullDay('2026-01-15', D0, -5)],
    width: WIDTH,
  });

  it('resolves to the nearest hour', () => {
    if (!model) throw new Error('expected a model');
    const target = model.hours[10];
    expect(hourAtX(model, target?.x ?? 0)?.hour.localHour).toBe(10);
  });

  it('clamps past either end rather than returning null', () => {
    if (!model) throw new Error('expected a model');
    expect(hourAtX(model, -500)?.hour.localHour).toBe(0);
    expect(hourAtX(model, WIDTH + 500)?.hour.localHour).toBe(23);
  });

  it('returns null only when there are no hours at all', () => {
    const empty = weatherTimelineModel({
      days: [day('2026-01-15', D0, null, { missing: true })],
      width: WIDTH,
    });
    if (!empty) throw new Error('expected a model');
    expect(hourAtX(empty, 10)).toBeNull();
  });
});

describe('timelineDaysFromArchive', () => {
  const hourRow = (dayMs: number, localDate: string, count = 24) => ({
    dayMs,
    localDate,
    hours: Array.from({ length: count }, (_, h) => ({ localHour: h, temperatureC: -4 })),
  });

  it('keeps a day that has a summary but no hours as a column, not a collapse', () => {
    // The normal state for cells whose daily rows predate the hourly table. Dropping the day would
    // shrink the axis and silently redate every column after it.
    const days = timelineDaysFromArchive({
      days: [
        { dayMs: D0, localDate: '2026-01-15', hours: 24 },
        { dayMs: D0 + DAY_MS, localDate: '2026-01-16', hours: 24 },
      ],
      hours: [hourRow(D0, '2026-01-15')],
      missingDayMs: [],
    });
    expect(days).toHaveLength(2);
    expect(days[1]?.hours).toBeUndefined();
    expect(days[1]?.missing).toBeUndefined(); // a known day with no hours is not a *missing* day
  });

  it('emits a recorded gap as missing', () => {
    const days = timelineDaysFromArchive({
      days: [{ dayMs: D0, localDate: '2026-01-15', hours: 24 }],
      hours: [hourRow(D0, '2026-01-15')],
      missingDayMs: [D0 + DAY_MS],
    });
    expect(days).toHaveLength(2);
    expect(days[1]?.missing).toBe(true);
    expect(days[1]?.localDate).toBe('2026-01-16'); // named even with nothing to name it from
  });

  it('marks a short day partial but not a 23-hour spring-forward day', () => {
    const days = timelineDaysFromArchive({
      days: [
        { dayMs: D0, localDate: '2026-01-15', hours: 10 },
        { dayMs: D0 + DAY_MS, localDate: '2026-01-16', hours: 23 },
      ],
      hours: [hourRow(D0, '2026-01-15', 10), hourRow(D0 + DAY_MS, '2026-01-16', 23)],
      missingDayMs: [],
    });
    expect(days[0]?.partial).toBe(true);
    // 23 hours is a complete DST day; calling it partial would grey out a settled day once a year.
    expect(days[1]?.partial).toBeUndefined();
  });

  it('sorts and de-duplicates across all three input lists', () => {
    const days = timelineDaysFromArchive({
      days: [{ dayMs: D0 + 2 * DAY_MS, localDate: '2026-01-17', hours: 24 }],
      hours: [hourRow(D0, '2026-01-15')],
      missingDayMs: [D0 + DAY_MS, D0],
    });
    expect(days.map((d) => d.dayMs)).toEqual([D0, D0 + DAY_MS, D0 + 2 * DAY_MS]);
  });

  it('carries the optional measures through to the model', () => {
    const days = timelineDaysFromArchive({
      days: [{ dayMs: D0, localDate: '2026-01-15', hours: 24 }],
      hours: [
        {
          dayMs: D0,
          localDate: '2026-01-15',
          hours: [{ localHour: 4, temperatureC: -1, rainMm: 2, weatherCode: 66, windSpeedKph: 12 }],
        },
      ],
      missingDayMs: [],
    });
    expect(days[0]?.hours?.[0]).toMatchObject({
      localHour: 4,
      rainMm: 2,
      weatherCode: 66,
      windSpeedKph: 12,
    });
  });
});

describe('timelineDaysFromArchive tolerates an incomplete payload', () => {
  // ⚠ The regression this exists for: a payload with no `hours` list threw, the panel's own `.catch`
  // swallowed it, and the *entire* past-weather panel disappeared — sentences included, none of which
  // depend on the chart. A client on a cached bundle is enough to reach that state.
  it('treats a missing hours list as no hours, not as an error', () => {
    const days = timelineDaysFromArchive({
      days: [{ dayMs: D0, localDate: '2026-01-15', hours: 24 }],
      missingDayMs: [],
    });
    expect(days).toHaveLength(1);
    expect(days[0]?.hours).toBeUndefined();
  });

  it('survives an entirely empty object', () => {
    expect(timelineDaysFromArchive({})).toEqual([]);
  });
});

describe('an emphasis span never spreads across a gap', () => {
  // ⚠ Found by rendering the chart, not by reading it. A filled span is a positive claim, so
  // smoothing one over a missing day invents evidence rather than merely hiding its absence — worse
  // than the equivalent bug on the line, where a break is at least visibly absent.
  it('splits calm-freezing hours either side of a missing day into two spans', () => {
    const calmFreezing = (localDate: string, dayMs: number) =>
      day(
        localDate,
        dayMs,
        Array.from({ length: 24 }, (_, h) => hour(h, { temperatureC: -8, windSpeedKph: 2 })),
      );
    const days = [
      calmFreezing('2026-01-15', D0),
      day('2026-01-16', D0 + DAY_MS, null, { missing: true }),
      calmFreezing('2026-01-17', D0 + 2 * DAY_MS),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.wind?.emphasis).toHaveLength(2);
    // And neither span reaches into the empty column.
    const dayWidth = WIDTH / 3;
    expect(model?.wind?.emphasis[0]?.x ?? 0).toBeLessThan(dayWidth);
    expect(
      (model?.wind?.emphasis[0]?.x ?? 0) + (model?.wind?.emphasis[0]?.width ?? 0),
    ).toBeLessThanOrEqual(dayWidth + 1);
    expect(model?.wind?.emphasis[1]?.x ?? 0).toBeGreaterThanOrEqual(2 * dayWidth - 1);
  });

  it('still joins across the spring-forward hour, like the line does', () => {
    const days = [
      day(
        '2026-03-08',
        D0,
        [0, 1, 3, 4].map((h) => hour(h, { temperatureC: -8, windSpeedKph: 2 })),
      ),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.wind?.emphasis).toHaveLength(1);
  });
});

describe('day labels thin out as columns narrow', () => {
  // ⚠ Found by rendering the panned-out view. At thirty days a column is ~12px and thirty labels
  // overprint into a solid unreadable band — the axis stops being an axis.
  const mkDays = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      fullDay(dayMsToLocalDate(D0 + i * DAY_MS), D0 + i * DAY_MS, -5),
    );

  it('labels every day at the seven-day default', () => {
    const model = weatherTimelineModel({ days: mkDays(7), width: WIDTH });
    expect(model?.days.every((d) => d.showLabel)).toBe(true);
  });

  it('labels only some days once columns are too narrow to hold one', () => {
    const model = weatherTimelineModel({ days: mkDays(30), width: WIDTH });
    const labelled = model?.days.filter((d) => d.showLabel) ?? [];
    expect(labelled.length).toBeGreaterThan(1);
    expect(labelled.length).toBeLessThan(30);
    // Whatever survives must have room to be read.
    const dayWidth = WIDTH / 30;
    const spacing = (labelled[1]?.x ?? 0) - (labelled[0]?.x ?? 0);
    expect(spacing).toBeGreaterThanOrEqual(MIN_DAY_LABEL_WIDTH);
    expect(dayWidth).toBeLessThan(MIN_DAY_LABEL_WIDTH); // i.e. the thinning was actually needed
  });

  it('anchors the labelled set on the first column so panning slides rather than reshuffles', () => {
    const model = weatherTimelineModel({ days: mkDays(30), width: WIDTH });
    expect(model?.days[0]?.showLabel).toBe(true);
  });
});

describe('labels stay inside the viewport', () => {
  it('pulls the first and last label in from the edges', () => {
    // A centred label on a 12px column overhangs the left edge by two thirds of its width, and the
    // leftmost label is the one that says where the panned window starts.
    const days = Array.from({ length: 30 }, (_, i) =>
      fullDay(dayMsToLocalDate(D0 + i * DAY_MS), D0 + i * DAY_MS, -5),
    );
    const model = weatherTimelineModel({ days, width: WIDTH });
    for (const d of model?.days ?? []) {
      expect(d.labelX).toBeGreaterThanOrEqual(0);
      expect(d.labelX).toBeLessThanOrEqual(WIDTH);
    }
    expect(model?.days[0]?.labelX).toBeGreaterThan(model?.days[0]?.x ?? 0);
  });

  it('leaves an ordinary wide column centred', () => {
    const model = weatherTimelineModel({
      days: Array.from({ length: 7 }, (_, i) =>
        fullDay(dayMsToLocalDate(D0 + i * DAY_MS), D0 + i * DAY_MS, -5),
      ),
      width: WIDTH,
    });
    const mid = model?.days[3];
    expect(mid?.labelX).toBeCloseTo((mid?.x ?? 0) + (mid?.width ?? 0) / 2);
  });
});

describe('timelineScrollbar', () => {
  const opts = { maxOffset: 23, windowDays: 7, totalDays: 30, trackWidth: 300 };

  it('hides itself when the whole range already fits', () => {
    // A track whose thumb fills it invites a drag that does nothing.
    expect(timelineScrollbar({ ...opts, offset: 0, maxOffset: 0 })).toBeNull();
  });

  it('sits at the right end at the newest window and the left end at the oldest', () => {
    // ⚠ Stated out loud because the direction is the one thing no type catches: `offset` counts
    // backwards (0 = most recent) while the thumb runs forwards. Inverted, the control still works
    // and moves exactly the wrong way.
    const newest = timelineScrollbar({ ...opts, offset: 0 });
    const oldest = timelineScrollbar({ ...opts, offset: 23 });
    expect(newest?.x).toBeCloseTo(300 - (newest?.width ?? 0));
    expect(oldest?.x).toBeCloseTo(0);
  });

  it('sizes the thumb to the share of the range on screen', () => {
    expect(timelineScrollbar({ ...opts, offset: 0 })?.width).toBeCloseTo((7 / 30) * 300);
  });

  it('never shrinks the thumb below a grabbable width', () => {
    const tiny = timelineScrollbar({ ...opts, offset: 0, totalDays: 365, trackWidth: 300 });
    expect(tiny?.width).toBe(MIN_SCROLL_THUMB_WIDTH);
  });

  it('stays inside the track at every offset', () => {
    for (let offset = 0; offset <= 23; offset++) {
      const bar = timelineScrollbar({ ...opts, offset });
      expect(bar?.x).toBeGreaterThanOrEqual(0);
      expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(300.001);
    }
  });

  it('clamps an out-of-range offset rather than running off the end', () => {
    expect(timelineScrollbar({ ...opts, offset: 999 })?.x).toBeCloseTo(0);
    expect(timelineScrollbar({ ...opts, offset: -5 })?.x).toBeCloseTo(
      300 - (timelineScrollbar({ ...opts, offset: 0 })?.width ?? 0),
    );
  });
});

describe('offsetAtTrackX', () => {
  const opts = { maxOffset: 23, windowDays: 7, totalDays: 30, trackWidth: 300 };

  it('round-trips with timelineScrollbar', () => {
    // The property that matters: putting the thumb where the model says it is must select the same
    // offset back. An off-by-half-a-thumb here makes every click jump slightly.
    for (let offset = 0; offset <= 23; offset++) {
      const bar = timelineScrollbar({ ...opts, offset });
      const centre = (bar?.x ?? 0) + (bar?.width ?? 0) / 2;
      expect(offsetAtTrackX(centre, opts)).toBe(offset);
    }
  });

  it('reads the pointer as the thumb centre, so a click lands under the cursor', () => {
    expect(offsetAtTrackX(0, opts)).toBe(23); // hard left = oldest
    expect(offsetAtTrackX(300, opts)).toBe(0); // hard right = newest
  });

  it('clamps a pointer dragged past either end', () => {
    expect(offsetAtTrackX(-400, opts)).toBe(23);
    expect(offsetAtTrackX(9999, opts)).toBe(0);
  });

  it('returns a whole number of days', () => {
    for (const x of [17, 55.5, 123.4, 288.9]) {
      expect(Number.isInteger(offsetAtTrackX(x, opts))).toBe(true);
    }
  });

  it('answers 0 rather than NaN when there is nothing to scroll', () => {
    expect(offsetAtTrackX(50, { ...opts, maxOffset: 0 })).toBe(0);
    expect(offsetAtTrackX(50, { ...opts, trackWidth: 0 })).toBe(0);
  });
});

describe('the sun trace splits where the sun is up', () => {
  const sunnyDay = (localDate: string, dayMs: number) =>
    day(
      localDate,
      dayMs,
      Array.from({ length: 24 }, (_, h) =>
        // Dark until 08:00, sun until 16:00, dark after — one sunrise and one sunset.
        hour(h, { temperatureC: -3, shortwaveWm2: h >= 8 && h < 16 ? 300 : 0 }),
      ),
    );

  it('emits lit and unlit runs rather than one path', () => {
    const model = weatherTimelineModel({ days: [sunnyDay('2026-01-15', D0)], width: WIDTH });
    const segments = model?.sun?.segments ?? [];
    expect(segments.filter((s) => s.active).length).toBe(1);
    expect(segments.filter((s) => !s.active).length).toBe(2); // before dawn and after dusk
  });

  it('leaves no hole at sunrise or sunset', () => {
    // Each run is extended one point into its neighbour, or the trace is visibly dashed at exactly
    // the two moments a reader looks for.
    const model = weatherTimelineModel({ days: [sunnyDay('2026-01-15', D0)], width: WIDTH });
    const xs = (d: string) => [...d.matchAll(/[ML] ([\d.]+)/g)].map((m) => Number(m[1]));
    const segments = model?.sun?.segments ?? [];
    const lit = segments.find((s) => s.active);
    const beforeDawn = segments.find((s) => !s.active);
    if (!lit || !beforeDawn) throw new Error('expected both runs');
    // The dark run reaches the lit run's first point.
    expect(Math.max(...xs(beforeDawn.d))).toBeCloseTo(Math.min(...xs(lit.d)));
  });

  it('gives a lane with no active predicate a single run covering everything', () => {
    // Wind and snow depth must be unaffected — they draw in one colour, so `segments` has to be
    // usable everywhere rather than being a sun-only field the other lanes ignore.
    const days = [
      day(
        '2026-01-15',
        D0,
        Array.from({ length: 24 }, (_, h) => hour(h, { windSpeedKph: 5 + h })),
      ),
    ];
    const model = weatherTimelineModel({ days, width: WIDTH });
    expect(model?.wind?.segments).toHaveLength(1);
    expect(model?.wind?.segments[0]?.active).toBe(true);
  });

  it('splits on a data gap as well as on the sun, not instead of it', () => {
    const model = weatherTimelineModel({
      days: [
        sunnyDay('2026-01-15', D0),
        day('2026-01-16', D0 + DAY_MS, null, { missing: true }),
        sunnyDay('2026-01-17', D0 + 2 * DAY_MS),
      ],
      width: WIDTH,
    });
    // Two days × (dark, lit, dark) — the gap prevents the two days' trailing/leading dark runs from
    // merging into one path across the hole.
    expect(model?.sun?.segments).toHaveLength(6);
  });
});

describe('wind direction survives the round trip', () => {
  it('carries a bearing through the archive adapter to the model', () => {
    const days = timelineDaysFromArchive({
      days: [{ dayMs: D0, localDate: '2026-01-15', hours: 24 }],
      hours: [
        {
          dayMs: D0,
          localDate: '2026-01-15',
          hours: [{ localHour: 6, temperatureC: -5, windSpeedKph: 18, windDirectionDeg: 315 }],
        },
      ],
      missingDayMs: [],
    });
    expect(days[0]?.hours?.[0]?.windDirectionDeg).toBe(315);
    // 315° is NW, and `windSectorOf` centres its sectors on the compass points rather than flooring.
    expect(windSectorOf(315)).toBe(14);
  });
});
