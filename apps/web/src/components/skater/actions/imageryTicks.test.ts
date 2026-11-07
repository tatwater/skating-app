import type { TimelineStop } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildImageryAxis,
  dayOf,
  edgeUsable,
  type ImageryUrlBand,
  selectedStopFor,
  stepUsable,
  tickTip,
} from './imageryTicks';

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 16, 15, 30); // 16 Nov 2026, a mid-morning pass

function stop(
  dayOffset: number,
  landable: boolean,
  extra: Partial<TimelineStop> = {},
  band = 'visual',
): TimelineStop {
  return {
    frame: {
      granuleId: `g${dayOffset}`,
      capturedAt: new Date(START + dayOffset * DAY).toISOString(),
      cloudCoverPct: landable ? 3 : 94,
      bodies: 1,
      band,
      key: `k${dayOffset}`,
      footprint: { type: 'Polygon', coordinates: [] },
    } as unknown as TimelineStop['frame'],
    landable,
    basis: 'inferred',
    ...(landable ? {} : { blockedBy: 'cloud' as const }),
    ...extra,
  };
}

describe('the axis', () => {
  it('one tick per day with a pass: tall where usable, short where hidden, none between', () => {
    const stops = [stop(0, false), stop(1, true), stop(4, true), stop(9, false)];
    const axis = buildImageryAxis(stops, 'tc');
    expect(axis.start).toBe('2026-11-16');
    expect(axis.days).toBe(10);
    expect(axis.ticks.map((t) => [t.dayIndex, t.tall])).toEqual([
      [0, false],
      [1, true],
      [4, true],
      [9, false],
    ]);
    expect(axis.months).toEqual([{ label: 'NOV', dayIndex: 0 }]);
  });

  it('radar draws no short tick, even for a pass the timeline couldn’t land on', () => {
    const stops = [stop(0, true, {}, 'vh'), stop(6, false, { blockedBy: 'coverage' }, 'vh')];
    const axis = buildImageryAxis(stops, 'vh');
    expect(axis.ticks.map((t) => t.tall)).toEqual([true]);
    // The span still runs to the last pass.
    expect(axis.days).toBe(7);
  });

  it('a day with two passes is tall if either is usable, pointing at the usable one', () => {
    const stops = [
      stop(0, false),
      { ...stop(0, true), frame: { ...stop(0, true).frame, granuleId: 'b' } },
    ];
    const axis = buildImageryAxis(stops, 'tc');
    expect(axis.ticks).toEqual([{ day: '2026-11-16', dayIndex: 0, tall: true, stopIndex: 1 }]);
  });

  it('labels the first of each month, and skips a crowded start', () => {
    const stops = [stop(-10, true), stop(50, true)]; // 6 Nov → 5 Jan
    expect(buildImageryAxis(stops, 'tc').months.map((m) => m.label)).toEqual(['NOV', 'DEC', 'JAN']);
    const late = [stop(12, true), stop(40, true)]; // 28 Nov: DEC is three days on
    expect(buildImageryAxis(late, 'tc').months.map((m) => m.label)).toEqual(['DEC']);
  });

  it('no passes, no axis; an unparseable date is dropped', () => {
    expect(buildImageryAxis([], 'tc')).toEqual({ start: null, days: 0, ticks: [], months: [] });
    const bad = { ...stop(0, true), frame: { ...stop(0, true).frame, capturedAt: 'nope' } };
    expect(buildImageryAxis([bad], 'tc').ticks).toEqual([]);
    expect(dayOf('nope')).toBeNull();
  });
});

describe('selection and stepping', () => {
  const stops = [stop(0, false), stop(1, true), stop(4, true), stop(9, false), stop(12, true)];

  it('opens on the URL’s day, the nearest usable to it, or the latest usable', () => {
    expect(selectedStopFor(stops, '2026-11-20')).toBe(2);
    expect(selectedStopFor(stops, '2026-11-25')).toBe(3 + 1);
    expect(selectedStopFor(stops, undefined)).toBe(4);
    expect(selectedStopFor([stop(0, false)], undefined)).toBeNull();
    expect(selectedStopFor(stops, '2026-13-99')).toBe(4);
  });

  it('steps to the next usable pass, and stays put at the ends', () => {
    expect(stepUsable(stops, 1, 1)).toBe(2);
    expect(stepUsable(stops, 2, 1)).toBe(4);
    expect(stepUsable(stops, 1, -1)).toBe(1);
    expect(stepUsable(stops, 4, 1)).toBe(4);
    expect(edgeUsable(stops, 'first')).toBe(1);
    expect(edgeUsable(stops, 'last')).toBe(4);
  });

  it('steps by day when two usable passes share one — Left leaves the day (the URL keeps only it)', () => {
    // Nov 16 (two usable), Nov 17 hidden, Nov 18 (two usable, the second at 18:00).
    const sameDay = [
      stop(0, true),
      stop(0.1, true),
      stop(1, false),
      stop(2, true),
      stop(2.1, true),
    ];
    expect(stepUsable(sameDay, 4, -1)).toBe(1);
    expect(stepUsable(sameDay, 3, -1)).toBe(1);
    expect(stepUsable(sameDay, 1, 1)).toBe(4);
    expect(stepUsable(sameDay, 0, 1)).toBe(4);
    expect(stepUsable(sameDay, 1, -1)).toBe(1);
    expect(stepUsable(sameDay, 4, 1)).toBe(4);
    expect(edgeUsable(sameDay, 'first')).toBe(1);
    expect(edgeUsable(sameDay, 'last')).toBe(4);
    expect(edgeUsable([stop(0, false)], 'first')).toBeNull();
  });

  it('arrows walk every usable day in order, through the URL, and Home/End reach the ends', () => {
    const DAY_STR = (s: TimelineStop) => dayOf(s.frame.capturedAt) as string;
    fc.assert(
      fc.property(
        // Per day: how many passes, and which are usable. Passes keep time order, as the timeline does.
        fc.array(fc.array(fc.boolean(), { minLength: 0, maxLength: 3 }), { maxLength: 12 }),
        (days) => {
          const stops = days.flatMap((passes, d) =>
            passes.map((landable, k) => stop(d + k * 0.1, landable)),
          );
          const usableDays = [...new Set(stops.filter((s) => s.landable).map(DAY_STR))];
          // What the pane does: the stop the URL's day selects, then the day it writes back.
          const visit = (from: number | null, direction: 1 | -1) => {
            const seen: string[] = [];
            let at = from;
            for (let n = 0; at !== null && n <= stops.length; n++) {
              const day = DAY_STR(stops[at] as TimelineStop);
              seen.push(day);
              const next = stepUsable(stops, at, direction);
              if (next === at) break;
              at = selectedStopFor(stops, DAY_STR(stops[next] as TimelineStop));
              expect(at).toBe(next);
            }
            return seen;
          };
          const last = edgeUsable(stops, 'last');
          const first = edgeUsable(stops, 'first');
          expect(last).toBe(selectedStopFor(stops, undefined));
          expect(visit(last, -1)).toEqual([...usableDays].reverse());
          expect(visit(first, 1)).toEqual(usableDays);
          if (first !== null) {
            expect(selectedStopFor(stops, DAY_STR(stops[first] as TimelineStop))).toBe(first);
          }
        },
      ),
    );
  });

  it('a tick’s tip says the date, and why a hidden day can’t be shown', () => {
    expect(tickTip(stops[1] as TimelineStop)).toBe('Nov 17');
    expect(tickTip(stops[0] as TimelineStop)).toBe(
      'Nov 16 · Too cloudy to show: 94% cloud over the region',
    );
    const clipped = stop(2, false, {
      blockedBy: 'coverage',
      stats: { waterBodyId: 'm', coveragePct: 0.15 } as TimelineStop['stats'],
    });
    expect(tickTip(clipped)).toBe(
      'Nov 18 · Too little of the lake to show: only 15% of the lake in this pass',
    );
    const radar = { ...stop(3, false, { blockedBy: 'coverage' }, 'vh') };
    radar.frame = { ...radar.frame, cloudCoverPct: null };
    expect(tickTip(radar)).toBe('Nov 19 · Too little of the lake to show');
  });
});

describe('property: the tick rule holds for any archive shape', () => {
  const arbStops = fc.array(
    fc.record({
      day: fc.integer({ min: 0, max: 150 }),
      landable: fc.boolean(),
      vhBand: fc.boolean(),
    }),
    { maxLength: 60 },
  );
  const arbBand = fc.constantFrom<ImageryUrlBand>('tc', 'vh');

  it('radar never renders a short tick', () => {
    fc.assert(
      fc.property(arbStops, (raw) => {
        const stops = raw.map((r) => stop(r.day, r.landable, {}, 'vh'));
        const axis = buildImageryAxis(stops, 'vh');
        expect(axis.ticks.every((t) => t.tall)).toBe(true);
      }),
    );
  });

  it('every tick sits on a day that has a pass, once; tall exactly when that day has a usable one', () => {
    fc.assert(
      fc.property(arbStops, arbBand, (raw, band) => {
        const stops = raw.map((r) => stop(r.day, r.landable));
        const axis = buildImageryAxis(stops, band);
        const days = new Set(axis.ticks.map((t) => t.day));
        expect(days.size).toBe(axis.ticks.length);
        for (const tick of axis.ticks) {
          expect(tick.dayIndex).toBeGreaterThanOrEqual(0);
          expect(tick.dayIndex).toBeLessThan(axis.days);
          const onDay = stops.filter((s) => dayOf(s.frame.capturedAt) === tick.day);
          expect(onDay.length).toBeGreaterThan(0);
          expect(tick.tall).toBe(onDay.some((s) => s.landable));
          expect(stops[tick.stopIndex]?.landable).toBe(tick.tall);
        }
        // True color shows every day with a pass; radar drops only the hidden ones.
        const passDays = new Set(stops.map((s) => dayOf(s.frame.capturedAt)));
        const usableDays = new Set(
          stops.filter((s) => s.landable).map((s) => dayOf(s.frame.capturedAt)),
        );
        expect(axis.ticks.length).toBe(band === 'tc' ? passDays.size : usableDays.size);
      }),
    );
  });
});
